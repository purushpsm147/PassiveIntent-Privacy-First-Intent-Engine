/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { useCallback, useEffect, useRef } from 'react';
import { IntentManager } from '@passiveintent/core';
import type {
  PassiveIntentTelemetry,
  IntentEventMap,
  IntentEventName,
  IntentManagerConfig,
} from '@passiveintent/core';

// ── Re-exports for consumer convenience ──────────────────────────────────────

export type { IntentManagerConfig, PassiveIntentTelemetry } from '@passiveintent/core';

// ── Return type ───────────────────────────────────────────────────────────────

export interface UsePassiveIntentReturn {
  /**
   * Track a page view or custom state transition.
   *
   * State labels are automatically normalized (query strings, hash fragments,
   * trailing slashes, UUIDs, and MongoDB ObjectIDs are stripped), so passing
   * `window.location.href` or `location.pathname` directly is safe.
   *
   * No-op during SSR and before the instance is mounted.
   */
  track: (state: string) => void;

  /**
   * Subscribe to an IntentManager event.
   *
   * Returns an unsubscribe function — pass it as the return value of a
   * `useEffect` cleanup to avoid listener leaks:
   *
   * ```tsx
   * useEffect(() => on('high_entropy', handler), [on]);
   * ```
   *
   * Returns a no-op unsubscribe during SSR.
   */
  on: <K extends IntentEventName>(
    event: K,
    listener: (payload: IntentEventMap[K]) => void,
  ) => () => void;

  /**
   * Returns the current telemetry snapshot (session-scoped aggregate counters
   * only — no raw behavioral data). Returns an empty object cast during SSR.
   */
  getTelemetry: () => PassiveIntentTelemetry;

  /**
   * Returns `{ state, probability }[]` sorted descending by probability for
   * all next states whose transition probability exceeds `threshold` (default
   * `0.3`). Pass a `sanitize` predicate to exclude sensitive or state-mutating
   * routes before using results for prefetching — see architecture docs.
   *
   * Returns an empty array during SSR or before the first `track()` call.
   */
  predictNextStates: (
    threshold?: number,
    sanitize?: (state: string) => boolean,
  ) => { state: string; probability: number }[];

  /**
   * O(1) Bloom filter membership test — has the user ever visited this state
   * (across sessions, via `localStorage`)? Returns `false` during SSR.
   */
  hasSeen: (state: string) => boolean;

  /**
   * Increment a named deterministic counter by `by` (default `1`).
   * Exact integer arithmetic — zero false positives. No-op during SSR.
   */
  incrementCounter: (key: string, by?: number) => void;

  /**
   * Read the current value of a named deterministic counter.
   * Returns `0` during SSR.
   */
  getCounter: (key: string) => number;

  /**
   * Reset a named deterministic counter to zero. No-op during SSR.
   */
  resetCounter: (key: string) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** `true` in browser environments, `false` during SSR. */
const IS_BROWSER = typeof window !== 'undefined';

/** Stable no-op returned by `on()` during SSR so callers can always call the
 *  unsubscribe without guarding for undefined. */
const NOOP_UNSUBSCRIBE: () => void = () => {};

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * `usePassiveIntent` — React hook that manages an {@link IntentManager} singleton
 * lifecycle for you.
 *
 * - **Mount:** creates a new `IntentManager` with the config supplied at first
 *   render.
 * - **Unmount:** calls `instance.destroy()` for leak-free SPA teardown
 *   (cancels timers, removes `visibilitychange` listeners, flushes state).
 * - **React Strict Mode safe:** the instance is held in a `useRef` and
 *   created/destroyed inside `useEffect`. Strict Mode's double-invocation in
 *   development correctly triggers mount → destroy → remount, ensuring the
 *   engine always starts with a clean slate in production.
 * - **SSR safe:** `useEffect` never runs server-side. All returned functions
 *   are no-ops when `typeof window === 'undefined'`, so the hook is safe to
 *   call in Next.js Server Components and SSR frameworks without a
 *   `typeof window` guard at the call site.
 * - **Config stability:** the config object is captured in a ref on first
 *   render. An unstable inline config object (e.g.
 *   `usePassiveIntent({ storageKey: 'x' })`) will not recreate the engine on
 *   every render — only the config present at initial mount is used. To apply
 *   a new config, remount the component (e.g. change its `key` prop).
 *
 * @param config — `IntentManagerConfig` forwarded directly to `IntentManager`.
 *
 * @example
 * ```tsx
 * import { usePassiveIntent } from '@passiveintent/react';
 * import { useEffect } from 'react';
 * import { useLocation } from 'react-router-dom';
 *
 * export function PassiveIntentProvider() {
 *   const location = useLocation();
 *   const { track, on } = usePassiveIntent({
 *     storageKey: 'my-app-intent',
 *     graph: { highEntropyThreshold: 0.8 },
 *     botProtection: true,
 *     eventCooldownMs: 60_000,
 *   });
 *
 *   // Track every route change
 *   useEffect(() => {
 *     track(location.pathname);
 *   }, [location.pathname, track]);
 *
 *   // Subscribe to high-entropy events — unsubscribe on cleanup
 *   useEffect(() => {
 *     return on('high_entropy', ({ state, normalizedEntropy }) => {
 *       if (normalizedEntropy > 0.9) openSupportChat({ context: state });
 *     });
 *   }, [on]);
 *
 *   return null;
 * }
 * ```
 */
export function usePassiveIntent(config: IntentManagerConfig): UsePassiveIntentReturn {
  // Hold the instance across renders. A ref (not state) ensures that
  // replacing the instance does not schedule an extra render cycle.
  const instanceRef = useRef<IntentManager | null>(null);

  // Capture config at first render so that inline object literals (which are
  // recreated on every render) don't retrigger the effect and destroy the
  // learned Markov graph prematurely.
  const configRef = useRef<IntentManagerConfig>(config);

  useEffect(() => {
    // Belt-and-suspenders: useEffect never runs on the server, but this guard
    // makes the SSR contract explicit and keeps the linter happy.
    if (!IS_BROWSER) return;

    const instance = new IntentManager(configRef.current);
    instanceRef.current = instance;

    return () => {
      // Flush pending localStorage writes, cancel debounce timers, and remove
      // visibilitychange listeners before React discards the component.
      instance.destroy();
      instanceRef.current = null;
    };
  }, []); // empty: create once per mount, destroy once per unmount

  // ── Stable callbacks ───────────────────────────────────────────────────────
  //
  // All functions delegate to `instanceRef.current` at call time rather than
  // closing over the instance at creation time. This means:
  //   1. The dep array is safely empty — callbacks never go stale.
  //   2. Calls that happen before the effect runs (e.g. during SSR hydration
  //      or before the first paint) silently no-op instead of throwing.

  const track = useCallback((state: string): void => {
    instanceRef.current?.track(state);
  }, []);

  const on = useCallback(
    <K extends IntentEventName>(
      event: K,
      listener: (payload: IntentEventMap[K]) => void,
    ): (() => void) => {
      return instanceRef.current?.on(event, listener) ?? NOOP_UNSUBSCRIBE;
    },
    [],
  );

  const getTelemetry = useCallback((): PassiveIntentTelemetry => {
    // Cast via unknown: before mount instanceRef is null, so we return a
    // partial object. Callers should only read telemetry after the first
    // track() call anyway.
    return instanceRef.current?.getTelemetry() ?? ({} as PassiveIntentTelemetry);
  }, []);

  const predictNextStates = useCallback(
    (
      threshold?: number,
      sanitize?: (state: string) => boolean,
    ): { state: string; probability: number }[] => {
      return instanceRef.current?.predictNextStates(threshold, sanitize) ?? [];
    },
    [],
  );

  const hasSeen = useCallback((state: string): boolean => {
    return instanceRef.current?.hasSeen(state) ?? false;
  }, []);

  const incrementCounter = useCallback((key: string, by?: number): void => {
    instanceRef.current?.incrementCounter(key, by);
  }, []);

  const getCounter = useCallback((key: string): number => {
    return instanceRef.current?.getCounter(key) ?? 0;
  }, []);

  const resetCounter = useCallback((key: string): void => {
    instanceRef.current?.resetCounter(key);
  }, []);

  return {
    track,
    on,
    getTelemetry,
    predictNextStates,
    hasSeen,
    incrementCounter,
    getCounter,
    resetCounter,
  };
}
