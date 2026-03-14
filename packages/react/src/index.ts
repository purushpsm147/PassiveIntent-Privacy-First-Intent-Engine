/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { IntentManager } from '@passiveintent/core';
import type {
  ConversionPayload,
  IntentEventMap,
  IntentEventName,
  IntentManagerConfig,
  PassiveIntentTelemetry,
} from '@passiveintent/core';
import { PassiveIntentContext } from './context.js';
import type { UsePassiveIntentReturn } from './types.js';

// ── Re-exports for consumer convenience ──────────────────────────────────────

export type { UsePassiveIntentReturn } from './types.js';
export { PassiveIntentProvider } from './provider.js';
export type { PassiveIntentProviderProps } from './provider.js';

export type {
  // Config & telemetry
  IntentManagerConfig,
  PassiveIntentTelemetry,
  // Event names & map
  IntentEventName,
  IntentEventMap,
  // Payload event types
  ExitIntentPayload,
  AttentionReturnPayload,
  UserIdlePayload,
  UserResumedPayload,
  SessionStalePayload,
  HighEntropyPayload,
  DwellTimeAnomalyPayload,
  BotDetectedPayload,
  TrajectoryAnomalyPayload,
  HesitationDetectedPayload,
  ConversionPayload,
  // Data structure configs
  BloomFilterConfig,
  MarkovGraphConfig,
  // State model
  SerializedMarkovGraph,
  // Adapter interfaces
  TimerAdapter,
  LifecycleAdapter,
  StorageAdapter,
} from '@passiveintent/core';

export {
  PropensityCalculator,
  IntentManager,
  MarkovGraph,
  BloomFilter,
  computeBloomConfig,
  MemoryStorageAdapter,
} from '@passiveintent/core';

// ── Domain hooks ──────────────────────────────────────────────────────────────

export {
  useExitIntent,
  useIdle,
  useAttentionReturn,
  useSignals,
  usePropensity,
  usePropensityScore,
  usePredictiveLink,
  useEventLog,
  useBloomFilter,
  useMarkovGraph,
} from './hooks.js';
export type {
  UseExitIntentReturn,
  UseIdleReturn,
  UseAttentionReturnReturn,
  UseSignalsReturn,
  UsePropensityOptions,
  UsePropensityScoreOptions,
  UsePredictiveLinkOptions,
  UsePredictiveLinkReturn,
  LogEntry,
  UseEventLogOptions,
  UseEventLogReturn,
  UseBloomFilterReturn,
  UseMarkovGraphReturn,
} from './hooks.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** `true` in browser environments, `false` during SSR. */
const IS_BROWSER = typeof window !== 'undefined';

/** Stable no-op returned by `on()` during SSR so callers can always call the
 *  unsubscribe without guarding for undefined. */
const NOOP_UNSUBSCRIBE: () => void = () => {};

/** Typed zero-value for `getTelemetry()` when the engine is not yet mounted
 *  (standalone SSR, or before the render-phase init guard runs). Returning a
 *  properly shaped object avoids the `{} as PassiveIntentTelemetry` type lie
 *  that would cause runtime errors on any destructured field access. */
const TELEMETRY_DEFAULT: PassiveIntentTelemetry = {
  sessionId: '',
  transitionsEvaluated: 0,
  botStatus: 'human',
  anomaliesFired: 0,
  engineHealth: 'healthy',
  baselineStatus: 'active',
  assignmentGroup: 'control',
};

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * `usePassiveIntent` — two usage modes:
 *
 * **Context mode (recommended)** — call without arguments inside a
 * `<PassiveIntentProvider>` to access the shared engine instance:
 *
 * ```tsx
 * const { track, on } = usePassiveIntent();
 * ```
 *
 * Throws a descriptive error if called outside a `<PassiveIntentProvider>`.
 *
 * **Standalone mode** — pass a config to create a component-scoped engine
 * instance. Useful for isolated tracking sub-trees (e.g. embeddable widgets)
 * or apps that prefer not to use a Provider. The instance is destroyed when
 * the component unmounts.
 *
 * ```tsx
 * const { track, on } = usePassiveIntent({ storageKey: 'widget' });
 * ```
 *
 * - **React Strict Mode safe** — double mount/destroy is handled correctly.
 * - **SSR safe** — all returned functions are no-ops when
 *   `typeof window === 'undefined'`.
 * - **Config stability** — the config is captured at first render; an inline
 *   object literal will not recreate the engine on every render. To apply a
 *   new config, remount the component (e.g. change its `key` prop).
 *
 * @example
 * ```tsx
 * import { usePassiveIntent } from '@passiveintent/react';
 * import { useEffect } from 'react';
 * import { useLocation } from 'react-router-dom';
 *
 * export function PassiveIntentTracker() {
 *   const location = useLocation();
 *   const { track, on } = usePassiveIntent();
 *
 *   useEffect(() => {
 *     track(location.pathname);
 *   }, [location.pathname, track]);
 *
 *   useEffect(() => {
 *     return on('exit_intent', ({ likelyNext }) => prefetch(likelyNext));
 *   }, [on]);
 *
 *   return null;
 * }
 * ```
 */
export function usePassiveIntent(config: IntentManagerConfig): UsePassiveIntentReturn;
export function usePassiveIntent(): UsePassiveIntentReturn;
export function usePassiveIntent(config?: IntentManagerConfig): UsePassiveIntentReturn {
  // ── All hooks called unconditionally (Rules of Hooks) ──────────────────────

  const ctx = useContext(PassiveIntentContext);

  // Standalone instance refs. In context mode (config === undefined) these
  // refs are created but never used — instanceRef stays null and the effect
  // short-circuits. The overhead is one ref and a no-op effect: negligible.
  const instanceRef = useRef<IntentManager | null>(null);
  const configRef = useRef<IntentManagerConfig | undefined>(config);

  // Synchronous render-phase init — mirrors PassiveIntentProvider's approach.
  // Engine must exist before child effects run; React executes child effects
  // before parent effects, so a useEffect-based init would give any child
  // on() calls a null instance, silently returning NOOP_UNSUBSCRIBE.
  // The idempotent guard (instanceRef.current === null) makes this safe under
  // Concurrent Mode re-renders: the instance is created exactly once per
  // component lifetime regardless of how many times React invokes the render.
  if (configRef.current !== undefined && instanceRef.current === null && IS_BROWSER) {
    instanceRef.current = new IntentManager(configRef.current);
  }

  // Cleanup only — creation is synchronous above. In React Strict Mode the
  // cleanup runs between the double-invoke, setting ref to null so the lazy
  // init block re-creates a fresh instance on the second render.
  useEffect(() => {
    if (configRef.current === undefined) return; // context mode — no cleanup needed
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, []);

  // Stable callbacks — always created to satisfy Rules of Hooks.
  // In context mode these are never returned; the Provider's callbacks are.

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
    return instanceRef.current?.getTelemetry() ?? TELEMETRY_DEFAULT;
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

  const incrementCounter = useCallback((key: string, by?: number): number => {
    return instanceRef.current?.incrementCounter(key, by) ?? 0;
  }, []);

  const getCounter = useCallback((key: string): number => {
    return instanceRef.current?.getCounter(key) ?? 0;
  }, []);

  const resetCounter = useCallback((key: string): void => {
    instanceRef.current?.resetCounter(key);
  }, []);

  const trackConversion = useCallback((payload: ConversionPayload): void => {
    instanceRef.current?.trackConversion(payload);
  }, []);

  // Standalone mode returns this object. useMemo guarantees referential
  // stability across re-renders — all 9 callbacks have [] deps so the memo
  // fires exactly once per mount, matching PassiveIntentProvider's strategy.
  // In context mode this value is computed but never returned (negligible cost).
  const standaloneValue = useMemo<UsePassiveIntentReturn>(
    () => ({
      track,
      on,
      getTelemetry,
      predictNextStates,
      hasSeen,
      incrementCounter,
      getCounter,
      resetCounter,
      trackConversion,
    }),
    [
      track,
      on,
      getTelemetry,
      predictNextStates,
      hasSeen,
      incrementCounter,
      getCounter,
      resetCounter,
      trackConversion,
    ],
  );

  // ── Conditional return — after all hooks ──────────────────────────────────

  // Context mode: no config provided → delegate to the nearest Provider.
  if (configRef.current === undefined) {
    if (ctx === null) {
      throw new Error(
        '[PassiveIntent] usePassiveIntent() was called without a config argument ' +
          'outside a <PassiveIntentProvider>. Either wrap your component tree in ' +
          '<PassiveIntentProvider config={...}> or pass a config directly: ' +
          'usePassiveIntent({ storageKey: "my-app" }).',
      );
    }
    return ctx;
  }

  // Standalone mode: config provided → return local callbacks.
  return standaloneValue;
}
