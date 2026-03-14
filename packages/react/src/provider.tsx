/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React, { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { IntentManager } from '@passiveintent/core';
import type {
  IntentEventMap,
  IntentEventName,
  IntentManagerConfig,
  PassiveIntentTelemetry,
  StorageAdapter,
  TimerAdapter,
  LifecycleAdapter,
} from '@passiveintent/core';
import { PassiveIntentContext } from './context.js';
import type { UsePassiveIntentReturn } from './types.js';

/** `true` in browser environments, `false` during SSR. */
const IS_BROWSER = typeof window !== 'undefined';

/** Stable no-op returned by `on()` during SSR so callers can always call the
 *  unsubscribe without guarding for undefined. */
const NOOP_UNSUBSCRIBE: () => void = () => {};

/** Typed zero-value for `getTelemetry()` before the engine is mounted (SSR).
 *  Avoids the `{} as PassiveIntentTelemetry` type lie that would cause runtime
 *  errors on any destructured field access. */
const TELEMETRY_DEFAULT: PassiveIntentTelemetry = {
  sessionId: '',
  transitionsEvaluated: 0,
  botStatus: 'human',
  anomaliesFired: 0,
  engineHealth: 'healthy',
  baselineStatus: 'active',
  assignmentGroup: 'control',
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PassiveIntentProviderProps {
  /**
   * IntentManagerConfig forwarded to the underlying IntentManager instance.
   * Captured at first render — changes after mount are ignored (same contract
   * as standalone `usePassiveIntent`). To apply a new config, remount the
   * Provider (e.g. change its `key` prop).
   */
  config: IntentManagerConfig;
  /**
   * Optional adapter overrides merged into the config before the engine is
   * created. Captured at first render — changes after mount are ignored (same
   * contract as `config`). To apply new adapters, remount the Provider (e.g.
   * change its `key` prop).
   *
   * - `storage` overrides `config.storage`
   * - `timer` overrides `config.timer`
   * - `lifecycle` overrides `config.lifecycleAdapter`
   */
  adapters?: Partial<{ storage: StorageAdapter; timer: TimerAdapter; lifecycle: LifecycleAdapter }>;
  children: ReactNode;
}

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * `PassiveIntentProvider` — place once near the root of your React app to share
 * a single `IntentManager` instance across the entire component tree.
 *
 * Any component in the tree can then call `usePassiveIntent()` (no arguments)
 * to access the shared engine without prop-drilling.
 *
 * - **Mount:** creates a new `IntentManager` with the config supplied at first render.
 * - **Unmount:** calls `instance.destroy()` for leak-free SPA teardown.
 * - **React Strict Mode safe:** double mount/destroy is handled correctly.
 * - **SSR safe:** the engine is never created server-side.
 * - **Config stability:** the config is captured at first render. To apply a new
 *   config, remount the Provider (e.g. change its `key` prop).
 *
 * @example
 * ```tsx
 * // App root
 * <PassiveIntentProvider config={{ storageKey: 'my-app', botProtection: true }}>
 *   <Router>
 *     <App />
 *   </Router>
 * </PassiveIntentProvider>
 *
 * // Any component in the tree — no config needed
 * const { track, on } = usePassiveIntent();
 * ```
 */
export function PassiveIntentProvider({
  config,
  adapters,
  children,
}: PassiveIntentProviderProps): React.JSX.Element {
  const instanceRef = useRef<IntentManager | null>(null);
  const configRef = useRef<IntentManagerConfig>(config);
  const adaptersRef = useRef(adapters);

  // Synchronous lazy initialization — the engine must exist before child
  // effects run (React runs child effects before parent effects). Without
  // this, domain hooks like useExitIntent() would call ctx.on() while
  // instanceRef is still null, silently dropping subscriptions.
  if (instanceRef.current === null && IS_BROWSER) {
    const mergedConfig: IntentManagerConfig = {
      ...configRef.current,
      ...(adaptersRef.current?.storage !== undefined && { storage: adaptersRef.current.storage }),
      ...(adaptersRef.current?.timer !== undefined && { timer: adaptersRef.current.timer }),
      ...(adaptersRef.current?.lifecycle !== undefined && {
        lifecycleAdapter: adaptersRef.current.lifecycle,
      }),
    };
    instanceRef.current = new IntentManager(mergedConfig);
  }

  // Cleanup only — creation is synchronous above. In React Strict Mode the
  // cleanup runs between the double-invoke, setting ref to null so the lazy
  // init re-creates a fresh instance on the second render.
  useEffect(() => {
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, []);

  // ── Stable callbacks ───────────────────────────────────────────────────────

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

  // ── Context value ─────────────────────────────────────────────────────────
  // useMemo ensures the context value object is referentially stable across
  // re-renders of the Provider. All callback deps are useCallback([]) refs
  // that never change after mount, so this memo fires exactly once per mount.
  const value = useMemo<UsePassiveIntentReturn>(
    () => ({
      track,
      on,
      getTelemetry,
      predictNextStates,
      hasSeen,
      incrementCounter,
      getCounter,
      resetCounter,
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
    ],
  );

  return <PassiveIntentContext.Provider value={value}>{children}</PassiveIntentContext.Provider>;
}
