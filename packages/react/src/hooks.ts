/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Domain-specific hooks built on top of the PassiveIntentProvider context.
 *
 * All subscriptions use `useSyncExternalStore` (React 18+) instead of the
 * legacy `useEffect + setState` pattern. This eliminates tearing in Concurrent
 * Mode: React guarantees every component in the tree sees a consistent snapshot
 * within a single render pass, even when renders are interrupted or retried.
 *
 * All hooks require a <PassiveIntentProvider> ancestor in the component tree
 * and throw a descriptive error if called outside one.
 */

import {
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { BloomFilter, MarkovGraph } from '@passiveintent/core';
import type {
  BloomFilterConfig,
  IntentEventName,
  MarkovGraphConfig,
  SerializedMarkovGraph,
} from '@passiveintent/core';
import { PassiveIntentContext } from './context.js';

// ── Shared ────────────────────────────────────────────────────────────────────

const providerError = (hook: string) =>
  `[PassiveIntent] ${hook}() must be used within a <PassiveIntentProvider>.`;

// ── useExitIntent ─────────────────────────────────────────────────────────────

export interface UseExitIntentReturn {
  /** `true` after an `exit_intent` event fires. Reset via `dismiss()`. */
  triggered: boolean;
  /** Route the user was on when intent to leave was detected. */
  state: string | null;
  /** Highest-probability next state from the Markov graph, or `null`. */
  likelyNext: string | null;
  /** Reset `triggered` to `false` — call after showing/hiding an overlay. */
  dismiss: () => void;
}

type ExitIntentData = Omit<UseExitIntentReturn, 'dismiss'>;
const EXIT_INITIAL: ExitIntentData = { triggered: false, state: null, likelyNext: null };

/**
 * `useExitIntent` — reactive wrapper around the `exit_intent` event.
 *
 * Returns `triggered: true` when the user's pointer exits the viewport from
 * above (toward the address bar) and the Markov graph has a continuation
 * candidate with probability >= 0.4.
 *
 * @example
 * ```tsx
 * const { triggered, likelyNext, dismiss } = useExitIntent();
 *
 * if (triggered) {
 *   return <ExitOverlay suggestedPage={likelyNext} onClose={dismiss} />;
 * }
 * ```
 */
export function useExitIntent(): UseExitIntentReturn {
  const ctx = useContext(PassiveIntentContext);

  const snapshotRef = useRef<ExitIntentData>(EXIT_INITIAL);
  // notifyRef captures React's onStoreChange so dismiss() can imperatively
  // trigger a re-render without waiting for an external event. This is safe
  // because React provides the same stable onStoreChange function per mount.
  const notifyRef = useRef<(() => void) | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      notifyRef.current = onStoreChange;
      if (!ctx)
        return () => {
          notifyRef.current = null;
        };
      const unsub = ctx.on('exit_intent', ({ state, likelyNext }) => {
        snapshotRef.current = { triggered: true, state, likelyNext };
        onStoreChange();
      });
      return () => {
        unsub();
        notifyRef.current = null;
      };
    },
    [ctx],
  );

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  const data = useSyncExternalStore(subscribe, getSnapshot, () => EXIT_INITIAL);

  const dismiss = useCallback(() => {
    snapshotRef.current = EXIT_INITIAL;
    notifyRef.current?.();
  }, []);

  // Throw after all hooks — required by Rules of Hooks.
  if (!ctx) throw new Error(providerError('useExitIntent'));

  // useMemo ensures the returned object is referentially stable between renders
  // when neither data nor dismiss has changed, preventing downstream re-renders
  // in consumers that use this value as a prop or effect dependency.
  return useMemo(() => ({ ...data, dismiss }), [data, dismiss]);
}

// ── useIdle ───────────────────────────────────────────────────────────────────

export interface UseIdleReturn {
  /** `true` while the user is idle (no interaction for >= 2 minutes). */
  isIdle: boolean;
  /** Duration of the current or most recent idle period in milliseconds. */
  idleMs: number;
}

const IDLE_INITIAL: UseIdleReturn = { isIdle: false, idleMs: 0 };

/**
 * `useIdle` — reactive wrapper around the `user_idle` / `user_resumed` events.
 *
 * Returns `isIdle: true` when 2 minutes of inactivity is detected, and resets
 * to `false` on the first user interaction.
 *
 * @example
 * ```tsx
 * const { isIdle, idleMs } = useIdle();
 *
 * if (isIdle) {
 *   return <StillThereModal idleSeconds={Math.round(idleMs / 1000)} />;
 * }
 * ```
 */
export function useIdle(): UseIdleReturn {
  const ctx = useContext(PassiveIntentContext);

  const snapshotRef = useRef<UseIdleReturn>(IDLE_INITIAL);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ctx) return () => {};
      const unsubIdle = ctx.on('user_idle', ({ idleMs }) => {
        snapshotRef.current = { isIdle: true, idleMs };
        onStoreChange();
      });
      const unsubResumed = ctx.on('user_resumed', ({ idleMs }) => {
        snapshotRef.current = { isIdle: false, idleMs };
        onStoreChange();
      });
      return () => {
        unsubIdle();
        unsubResumed();
      };
    },
    [ctx],
  );

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  // useSyncExternalStore is the last hook — throw comes after all hooks.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_INITIAL);

  if (!ctx) throw new Error(providerError('useIdle'));

  // Return the snapshot directly — no spread, no added functions, so the ref
  // value IS the return value and is already referentially stable between events.
  return snapshot;
}

// ── useAttentionReturn ────────────────────────────────────────────────────────

export interface UseAttentionReturnReturn {
  /** `true` after the user returns from a tab switch of >= 15 seconds. */
  returned: boolean;
  /** How long the tab was hidden, in milliseconds. */
  hiddenDuration: number;
  /** Reset `returned` to `false` — call after showing a "Welcome Back" modal. */
  dismiss: () => void;
}

type AttentionData = Omit<UseAttentionReturnReturn, 'dismiss'>;
const ATTENTION_INITIAL: AttentionData = { returned: false, hiddenDuration: 0 };

/**
 * `useAttentionReturn` — reactive wrapper around the `attention_return` event.
 *
 * Returns `returned: true` when the user comes back to the tab after being
 * away for >= 15 seconds (the comparison-shopping threshold).
 *
 * @example
 * ```tsx
 * const { returned, hiddenDuration, dismiss } = useAttentionReturn();
 *
 * if (returned && hiddenDuration > 30_000) {
 *   return <WelcomeBackOffer onClose={dismiss} />;
 * }
 * ```
 */
export function useAttentionReturn(): UseAttentionReturnReturn {
  const ctx = useContext(PassiveIntentContext);

  const snapshotRef = useRef<AttentionData>(ATTENTION_INITIAL);
  const notifyRef = useRef<(() => void) | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      notifyRef.current = onStoreChange;
      if (!ctx)
        return () => {
          notifyRef.current = null;
        };
      const unsub = ctx.on('attention_return', ({ hiddenDuration }) => {
        snapshotRef.current = { returned: true, hiddenDuration };
        onStoreChange();
      });
      return () => {
        unsub();
        notifyRef.current = null;
      };
    },
    [ctx],
  );

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  const data = useSyncExternalStore(subscribe, getSnapshot, () => ATTENTION_INITIAL);

  const dismiss = useCallback(() => {
    snapshotRef.current = ATTENTION_INITIAL;
    notifyRef.current?.();
  }, []);

  // Throw after all hooks — required by Rules of Hooks.
  if (!ctx) throw new Error(providerError('useAttentionReturn'));

  return useMemo(() => ({ ...data, dismiss }), [data, dismiss]);
}

// ── useSignals ────────────────────────────────────────────────────────────────

export interface UseSignalsReturn {
  /** Reactive exit-intent state — `triggered`, `state`, `likelyNext`, `dismiss`. */
  exitIntent: UseExitIntentReturn;
  /** Reactive idle state — `isIdle`, `idleMs`. */
  idle: UseIdleReturn;
  /** Reactive attention-return state — `returned`, `hiddenDuration`, `dismiss`. */
  attentionReturn: UseAttentionReturnReturn;
}

/**
 * `useSignals` — composite hook that co-subscribes to exit intent, idle, and
 * attention-return signals in a single call.
 *
 * This is a pure **composition** hook — it delegates entirely to
 * `useExitIntent()`, `useIdle()`, and `useAttentionReturn()`. No new
 * subscription logic is introduced here.
 *
 * The returned object is wrapped in `useMemo` so it is referentially stable
 * between renders when none of the three underlying snapshots have changed,
 * preventing unnecessary downstream re-renders in consumers that use the
 * object as a prop or effect dependency.
 *
 * Each sub-hook already memoizes its own return value, so `useMemo` here only
 * fires when at least one signal actually changes.
 *
 * @example
 * ```tsx
 * const { exitIntent, idle, attentionReturn } = useSignals();
 *
 * if (exitIntent.triggered) {
 *   return <ExitOverlay suggestedPage={exitIntent.likelyNext} onClose={exitIntent.dismiss} />;
 * }
 * if (idle.isIdle) {
 *   return <StillThereModal idleSeconds={Math.round(idle.idleMs / 1000)} />;
 * }
 * if (attentionReturn.returned && attentionReturn.hiddenDuration > 30_000) {
 *   return <WelcomeBackOffer onClose={attentionReturn.dismiss} />;
 * }
 * ```
 */
export function useSignals(): UseSignalsReturn {
  const exitIntent = useExitIntent();
  const idle = useIdle();
  const attentionReturn = useAttentionReturn();

  // Outer memo ensures the container object is stable when no signal has fired.
  // Each inner hook memoizes its own value, so this only allocates a new object
  // when at least one of the three sub-snapshots actually changes.
  return useMemo(
    () => ({ exitIntent, idle, attentionReturn }),
    [exitIntent, idle, attentionReturn],
  );
}

// ── usePropensity ─────────────────────────────────────────────────────────────

export interface UsePropensityOptions {
  /**
   * Friction sensitivity — controls how aggressively dwell-time anomalies
   * decay the score. At z = 3.5, the default `0.2` halves the score.
   * Increase for short high-intent funnels; decrease for long noisier sessions.
   * @default 0.2
   */
  alpha?: number;
}

/**
 * `usePropensity` — real-time conversion score for a target state.
 *
 * Returns a number in `[0, 1]` representing how likely the current session is
 * to reach `targetState`. Combines two factors:
 *
 * 1. **Direct transition probability** from `predictNextStates()` — how often
 *    users navigate from the current state to the target.
 * 2. **Dwell-time friction** — an exponential penalty applied when the user's
 *    dwell time on the current page is anomalously high (z-score > 0),
 *    signaling hesitation or distraction.
 *
 * Formula: `score = P(target | current) × exp(−α × max(0, z))`
 *
 * For multi-hop path-based propensity (BFS over the full Markov graph), use
 * `PropensityCalculator` directly with `IntentEngine`.
 *
 * @example
 * ```tsx
 * const score = usePropensity('/checkout');
 *
 * if (score > 0.7) {
 *   showUpsellBanner();
 * }
 * ```
 */
export function usePropensity(targetState: string, options?: UsePropensityOptions): number {
  const ctx = useContext(PassiveIntentContext);

  const snapshotRef = useRef(0);
  const alphaRef = useRef(options?.alpha ?? 0.2);
  const zScoreRef = useRef(0);
  const targetStateRef = useRef(targetState);

  // Mutate refs during render to always reflect the latest props without
  // changing subscribe's identity. Safe under Concurrent Mode: reads from
  // these refs only happen inside event handlers (post-commit), never during
  // the render itself, so concurrent re-renders see a consistent picture.
  alphaRef.current = options?.alpha ?? 0.2;
  targetStateRef.current = targetState;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ctx) return () => {};

      const recompute = () => {
        const predictions = ctx.predictNextStates(0);
        const target = predictions.find((p) => p.state === targetStateRef.current);
        const base = target?.probability ?? 0;
        const z = Math.max(0, zScoreRef.current);
        snapshotRef.current = base * Math.exp(-alphaRef.current * z);
        onStoreChange();
      };

      // dwell_time_anomaly updates the z-score AND immediately recomputes so
      // the score reflects the new friction level without waiting for the next
      // state_change. state_change also recomputes with the latest z-score.
      const unsubDwell = ctx.on('dwell_time_anomaly', ({ zScore }) => {
        zScoreRef.current = zScore;
        recompute();
      });
      const unsubState = ctx.on('state_change', recompute);

      return () => {
        unsubDwell();
        unsubState();
      };
    },
    [ctx],
  );

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  // Number snapshots: React uses Object.is for comparison, so equal numbers
  // never trigger re-renders — no useMemo wrapper needed for the return value.
  const score = useSyncExternalStore(subscribe, getSnapshot, () => 0);

  // Throw after all hooks — required by Rules of Hooks.
  if (!ctx) throw new Error(providerError('usePropensity'));

  return score;
}

// ── usePropensityScore ────────────────────────────────────────────────────────

export interface UsePropensityScoreOptions {
  /**
   * Friction sensitivity — controls how aggressively dwell-time anomalies
   * decay the score. At z = 3.5, the default `0.2` halves the score.
   * Increase for short, high-intent funnels; decrease for longer, noisier sessions.
   * @default 0.2
   */
  alpha?: number;
}

/**
 * `usePropensityScore` — real-time, single-hop conversion score driven by
 * `useSyncExternalStore`.
 *
 * Returns a number in `[0, 1]`:
 * ```
 * score = P(targetState | current) × exp(−α × max(0, z))
 * ```
 * where `z` is the latest dwell-time z-score (friction signal) and `α`
 * is `options.alpha` (default `0.2`).
 *
 * **Architecture — computation lives in `getSnapshot`:**
 * Event handlers are intentionally side-effect-free: `state_change` and
 * `dwell_time_anomaly` only write to refs and call `onStoreChange()`. The
 * entire score formula is evaluated inside `getSnapshot()`, which React calls
 * synchronously after each `onStoreChange`. This means:
 *
 * - The computed value is always consistent with the ref state at the moment
 *   React reads the snapshot — no intermediate stale-score window.
 * - React's tearing detection works correctly: repeated `getSnapshot()` calls
 *   during the same render return the same `number` (refs don't change
 *   mid-render; `Object.is` comparisons on scalars are exact).
 * - The computation is **pure and cheap** — a single `predictNextStates(0)`
 *   lookup (O(transitions from current state)), not a full graph traversal.
 *
 * **Multi-hop / BFS propensity:** For path-based propensity that traverses
 * multiple edges in the Markov graph (e.g. P(/home → /product → /checkout)),
 * use `PropensityCalculator` from `@passiveintent/core` directly with an
 * `IntentManager` instance. This hook deliberately stays single-hop to keep
 * rendering-path computation O(1) per snapshot.
 *
 * @example
 * ```tsx
 * const score = usePropensityScore('/checkout');
 *
 * return (
 *   <div>
 *     Conversion likelihood: {(score * 100).toFixed(0)}%
 *     {score > 0.7 && <UpsellBanner />}
 *   </div>
 * );
 * ```
 *
 * @example Custom friction sensitivity
 * ```tsx
 * // Tighter funnel — penalise hesitation more aggressively
 * const score = usePropensityScore('/checkout', { alpha: 0.5 });
 * ```
 */
export function usePropensityScore(
  targetState: string,
  options?: UsePropensityScoreOptions,
): number {
  const ctx = useContext(PassiveIntentContext);

  // Latest dwell-time friction z-score — updated by the dwell_time_anomaly
  // handler and read inside getSnapshot. Mutated only in post-commit event
  // handlers, never during render, so reads in getSnapshot are consistent.
  const zScoreRef = useRef(0);

  // Prop refs — mutated during render so getSnapshot always sees the latest
  // targetState and alpha without recreating the subscribe/getSnapshot closures.
  // Safe under Concurrent Mode: these refs are written before useSyncExternalStore
  // is called, so every getSnapshot invocation within a single render pass
  // reads the same values.
  const targetStateRef = useRef(targetState);
  const alphaRef = useRef(options?.alpha ?? 0.2);
  targetStateRef.current = targetState;
  alphaRef.current = options?.alpha ?? 0.2;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ctx) return () => {};

      // Capture the latest z-score then signal React. getSnapshot will pick
      // it up and blend it into the formula on the very next snapshot read.
      const unsubDwell = ctx.on('dwell_time_anomaly', ({ zScore }) => {
        zScoreRef.current = zScore;
        onStoreChange();
      });

      // The Markov graph's transition distribution has shifted — signal React
      // so getSnapshot re-runs predictNextStates with the new current state.
      const unsubState = ctx.on('state_change', onStoreChange);

      return () => {
        unsubDwell();
        unsubState();
      };
    },
    [ctx],
  );

  // Computation lives here — not in the event handlers. React calls this
  // synchronously after onStoreChange(); the number it returns is compared
  // via Object.is, so equal scores never schedule a re-render.
  const getSnapshot = useCallback((): number => {
    if (!ctx) return 0;
    const predictions = ctx.predictNextStates(0);
    const target = predictions.find((p) => p.state === targetStateRef.current);
    const base = target?.probability ?? 0;
    const z = Math.max(0, zScoreRef.current);
    return base * Math.exp(-alphaRef.current * z);
  }, [ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Number snapshots: Object.is on equal floats is always true — no useMemo
  // wrapper needed; equal scores never trigger re-renders.
  const score = useSyncExternalStore(subscribe, getSnapshot, () => 0);

  // Throw after all hooks — required by Rules of Hooks.
  if (!ctx) throw new Error(providerError('usePropensityScore'));

  return score;
}

// ── usePredictiveLink ─────────────────────────────────────────────────────────

export interface UsePredictiveLinkOptions {
  /**
   * Minimum transition probability to include in predictions.
   * @default 0.3
   */
  threshold?: number;
  /** Filter predicate to exclude sensitive routes from prefetching. */
  sanitize?: (state: string) => boolean;
  /**
   * Automatically inject `<link rel="prefetch">` into `document.head` for
   * each predicted next state. Links are cleaned up when predictions change
   * or the component unmounts.
   * @default true
   */
  prefetch?: boolean;
}

export interface UsePredictiveLinkReturn {
  /** Predicted next states sorted descending by probability. */
  predictions: { state: string; probability: number }[];
}

/**
 * `usePredictiveLink` — behavioral prefetching driven by the Markov graph.
 *
 * After each navigation, queries `predictNextStates()` and optionally injects
 * `<link rel="prefetch">` tags into the document head for the highest-
 * probability next pages. When the user navigates, the browser already has
 * those resources cached — resulting in near-instant perceived page loads.
 *
 * @example
 * ```tsx
 * // Auto-prefetch with defaults (threshold 0.3, prefetch enabled)
 * const { predictions } = usePredictiveLink();
 *
 * // Display predictions + exclude admin routes from prefetching
 * const { predictions } = usePredictiveLink({
 *   threshold: 0.4,
 *   sanitize: (s) => !s.startsWith('/admin'),
 * });
 * ```
 */
export function usePredictiveLink(options?: UsePredictiveLinkOptions): UsePredictiveLinkReturn {
  const ctx = useContext(PassiveIntentContext);

  const snapshotRef = useRef<{ state: string; probability: number }[]>([]);
  const thresholdRef = useRef(options?.threshold ?? 0.3);
  const sanitizeRef = useRef(options?.sanitize);
  const prefetch = options?.prefetch ?? true;

  // Update option refs during render — idempotent, safe under Concurrent Mode.
  thresholdRef.current = options?.threshold ?? 0.3;
  sanitizeRef.current = options?.sanitize;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ctx) return () => {};
      return ctx.on('state_change', () => {
        snapshotRef.current = ctx.predictNextStates(thresholdRef.current, sanitizeRef.current);
        onStoreChange();
      });
    },
    [ctx],
  );

  const getSnapshot = useCallback(() => snapshotRef.current, []);

  const predictions = useSyncExternalStore(subscribe, getSnapshot, () => []);

  // DOM side effects: inject <link rel="prefetch"> tags. This is inherently a
  // commit-phase operation (DOM mutation) and must remain in a useEffect —
  // it cannot be moved into useSyncExternalStore's subscribe.
  useEffect(() => {
    if (!prefetch || typeof document === 'undefined' || predictions.length === 0) return;

    const links: HTMLLinkElement[] = [];
    const seen = new Set<string>();

    for (const { state } of predictions) {
      if (seen.has(state)) continue;
      seen.add(state);
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = state;
      document.head.appendChild(link);
      links.push(link);
    }

    return () => {
      for (const link of links) link.remove();
    };
  }, [predictions, prefetch]);

  // Throw after all hooks — required by Rules of Hooks.
  if (!ctx) throw new Error(providerError('usePredictiveLink'));

  // Wrap in useMemo so the returned object is referentially stable between
  // renders when predictions hasn't changed, preventing unnecessary re-renders
  // in consumers that use this value as a prop or dependency.
  return useMemo(() => ({ predictions }), [predictions]);
}

// ── useEventLog ───────────────────────────────────────────────────────────────

/** A single entry in the event log. */
export interface LogEntry {
  /** The IntentManager event name that fired. */
  event: IntentEventName;
  /** Raw payload delivered by the event — typed as `unknown` for heterogeneous logs. */
  payload: unknown;
  /** `Date.now()` timestamp recorded immediately when the event was received. */
  timestamp: number;
}

export interface UseEventLogOptions {
  /**
   * Maximum number of entries to retain. When the limit is reached, the oldest
   * entry (tail of the array) is dropped on each new event.
   * @default 100
   */
  maxEntries?: number;
}

export interface UseEventLogReturn {
  /** Accumulated log entries in reverse-chronological order (newest first). */
  log: LogEntry[];
  /** Stable callback that clears all entries from the log. */
  clear: () => void;
}

// ── Reducer ──────────────────────────────────────────────────────────────────
// Defined at module level so its identity is always stable — no useMemo needed.

type LogAction = { type: 'ADD'; entry: LogEntry; maxEntries: number } | { type: 'CLEAR' };

const EMPTY_LOG: LogEntry[] = [];

function logReducer(state: LogEntry[], action: LogAction): LogEntry[] {
  if (action.type === 'ADD') {
    // Prepend is O(1) amortized; slice drops the oldest tail entry when full.
    return [action.entry, ...state].slice(0, action.maxEntries);
  }
  if (action.type === 'CLEAR') {
    return EMPTY_LOG;
  }
  return state;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * `useEventLog` — accumulates a bounded, reverse-chronological log of
 * IntentManager events from a given set of event names.
 *
 * **Subscription model:** `useSyncExternalStore` manages the subscription
 * lifecycle (setup and cleanup), giving Concurrent Mode safety: even when
 * React retries renders, subscriptions are never duplicated or orphaned.
 * Dispatching to the `useReducer` is the "onStoreChange" — it updates the
 * log state and schedules the React re-render in a single batched pass.
 *
 * **Prepend vs. sort:** new entries are prepended (`O(1)`) rather than
 * appended-then-sorted; the oldest entry is dropped via `slice` when the
 * log reaches `maxEntries`.
 *
 * @example
 * ```tsx
 * const { log, clear } = useEventLog(
 *   ['high_entropy', 'exit_intent', 'bot_detected'],
 *   { maxEntries: 50 },
 * );
 *
 * return (
 *   <>
 *     <button onClick={clear}>Clear</button>
 *     <ul>
 *       {log.map((e, i) => (
 *         <li key={i}>[{e.event}] {new Date(e.timestamp).toISOString()}</li>
 *       ))}
 *     </ul>
 *   </>
 * );
 * ```
 */
export function useEventLog(
  events: IntentEventName[],
  options?: UseEventLogOptions,
): UseEventLogReturn {
  const ctx = useContext(PassiveIntentContext);
  const maxEntries = options?.maxEntries ?? 100;

  // Keep maxEntries readable inside subscribe without capturing a stale value.
  const maxEntriesRef = useRef(maxEntries);
  maxEntriesRef.current = maxEntries;

  // ── Log state (useReducer) ───────────────────────────────────────────────────
  const [log, dispatch] = useReducer(logReducer, EMPTY_LOG);

  // Mirror log into a ref so getSnapshot can return a synchronously-consistent
  // value during useSyncExternalStore's tearing checks in Concurrent Mode.
  const logRef = useRef<LogEntry[]>(EMPTY_LOG);
  logRef.current = log;

  // ── Subscription (useSyncExternalStore) ─────────────────────────────────────
  // Serialize the events array into a stable primitive dep. subscribe only
  // re-runs (and re-wires listeners) when the actual set of names changes —
  // not on every render due to a new array reference.
  const eventsKey = events.join('\0');

  // eventsRef lets subscribe read the current names without capturing them in
  // its closure — required because subscribe re-runs only when eventsKey or ctx
  // changes, but eventsRef.current is always up-to-date.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ctx) return () => {};

      // Single "effect" body: map over the events array and wire one listener
      // per event name. All are torn down together in the returned cleanup.
      const unsubs = eventsRef.current.map((event) =>
        ctx.on(event, (payload) => {
          // dispatch IS the primary onStoreChange: it applies the reducer and
          // schedules a React re-render. Calling onStoreChange() alongside it
          // keeps useSyncExternalStore's snapshot consistent in Concurrent Mode.
          dispatch({
            type: 'ADD',
            entry: { event, payload, timestamp: Date.now() },
            maxEntries: maxEntriesRef.current,
          });
          onStoreChange();
        }),
      );

      return () => unsubs.forEach((u) => u());
    },
    // eventsKey is the stable primitive that encodes which events to subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, eventsKey],
  );

  const getSnapshot = useCallback(() => logRef.current, []);

  // useSyncExternalStore drives subscription lifecycle (Concurrent Mode safe)
  // and provides the snapshot for tearing detection. The authoritative log
  // state comes from useReducer; both are consistent by the time consumers see them.
  useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_LOG);

  // ── Stable clear callback ────────────────────────────────────────────────────
  const clear = useCallback(() => dispatch({ type: 'CLEAR' }), []);

  // Expose entry count in React DevTools.
  useDebugValue(log.length, (count) => `${count} entries`);

  // Throw after all hooks — required by Rules of Hooks.
  if (!ctx) throw new Error(providerError('useEventLog'));

  return useMemo(() => ({ log, clear }), [log, clear]);
}

// ── Shared helpers for standalone data-structure hooks ────────────────────────

/**
 * Stable reducer used by both useBloomFilter and useMarkovGraph version counters.
 * Defined at module level so its identity never changes — no useMemo needed.
 */
const VERSION_BUMP = (v: number): number => v + 1;

/**
 * Decode a BloomFilter's internal bit array into a `boolean[]` for visualization.
 * Uses `atob` (available in browsers and Node ≥ 16). Returns an empty array in
 * environments where `atob` is not defined (e.g. some SSR runtimes).
 */
function decodeBits(bf: BloomFilter): boolean[] {
  if (typeof atob === 'undefined') return [];
  const bytes = atob(bf.toBase64());
  const result: boolean[] = new Array(bf.bitSize);
  for (let byteIdx = 0; byteIdx < bytes.length; byteIdx++) {
    const byte = bytes.charCodeAt(byteIdx);
    for (let bit = 0; bit < 8; bit++) {
      const pos = byteIdx * 8 + bit;
      if (pos < bf.bitSize) result[pos] = Boolean((byte >> bit) & 1);
    }
  }
  return result;
}

// ── useBloomFilter ────────────────────────────────────────────────────────────

export interface UseBloomFilterReturn {
  /** Add an item to the filter. Stable callback — never changes identity. */
  add: (item: string) => void;
  /** Probabilistic set-membership test. Stable callback — reads from the instance ref. */
  check: (item: string) => boolean;
  /** Exact number of items added since mount (tracked alongside the filter). */
  itemCount: number;
  /** Estimated false-positive rate given the current `itemCount` and filter config. */
  estimatedFPR: number;
  /**
   * Decoded bit array for visualization — updated via `startTransition` so it
   * never blocks urgent input events. Length equals `BloomFilter.bitSize`.
   */
  bits: boolean[];
  /** Serialize the current filter state to base64. Stable callback. */
  toBase64: () => string;
}

/**
 * `useBloomFilter` — standalone React wrapper for `BloomFilter`.
 *
 * Creates a `BloomFilter` instance synchronously on first render using the
 * same idempotent guard as `PassiveIntentProvider` — safe under Concurrent
 * Mode re-renders and React Strict Mode double-invocation.
 *
 * **Reactivity model:**
 * - `add()` bumps a `useReducer` version counter; `useMemo` keyed on that
 *   version recomputes `itemCount` and `estimatedFPR` in the same commit.
 * - The decoded bit array (`bits`) is updated inside `startTransition` so
 *   the potentially CPU-intensive decode never blocks high-priority renders.
 *
 * **Config stability:** captured at first render. To apply a new config,
 * remount the component (change its `key` prop).
 *
 * @example
 * ```tsx
 * const { add, check, itemCount, estimatedFPR, bits } = useBloomFilter({
 *   bitSize: 1024,
 *   hashCount: 4,
 * });
 *
 * return (
 *   <>
 *     <button onClick={() => add(location.pathname)}>Track page</button>
 *     <p>{itemCount} tracked · ~{(estimatedFPR * 100).toFixed(2)} % FPR</p>
 *   </>
 * );
 * ```
 */
export function useBloomFilter(config?: BloomFilterConfig): UseBloomFilterReturn {
  const configRef = useRef(config);

  // ── Synchronous instance init (idempotent guard) ────────────────────────────
  // Runs during render so the instance exists before any child effects fire.
  // The null check makes this safe under Concurrent Mode re-renders: the
  // instance is created exactly once per component lifetime.
  const instanceRef = useRef<BloomFilter | null>(null);
  if (instanceRef.current === null) {
    instanceRef.current = new BloomFilter(configRef.current);
  }

  // BloomFilter doesn't expose an item count — track it alongside the instance.
  const itemCountRef = useRef(0);

  // ── Version counter ──────────────────────────────────────────────────────────
  // Every mutation dispatches VERSION_BUMP; useMemo re-runs keyed on `version`.
  const [version, bumpVersion] = useReducer(VERSION_BUMP, 0);

  // ── Visualization state (deferred) ─────────────────────────────────────────
  // Lazy-initialized from the instance (which is non-null by this point).
  // Updated inside startTransition on each add() so bit-decode CPU work stays
  // off the critical path of any concurrent user input.
  const [bits, setBits] = useState<boolean[]>(() => decodeBits(instanceRef.current!));

  // ── Stable mutation callback ────────────────────────────────────────────────
  // bumpVersion (dispatch from useReducer) is stable — empty deps is correct.
  const add = useCallback((item: string) => {
    instanceRef.current!.add(item);
    itemCountRef.current++;
    bumpVersion();
    startTransition(() => {
      setBits(decodeBits(instanceRef.current!));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stable read-only callbacks ──────────────────────────────────────────────
  const check = useCallback((item: string) => instanceRef.current!.check(item), []);
  const toBase64 = useCallback(() => instanceRef.current!.toBase64(), []);

  // ── Derived values (version-keyed) ─────────────────────────────────────────
  // useMemo re-runs on each version bump; reads from refs (no stale-closure risk).
  const itemCount = useMemo(() => itemCountRef.current, [version]);
  const estimatedFPR = useMemo(
    () => instanceRef.current!.estimateCurrentFPR(itemCountRef.current),
    [version],
  );

  useDebugValue(itemCount, (n) => `BloomFilter — ${n} items`);

  return useMemo(
    () => ({ add, check, itemCount, estimatedFPR, bits, toBase64 }),
    [add, check, itemCount, estimatedFPR, bits, toBase64],
  );
}

// ── useMarkovGraph ────────────────────────────────────────────────────────────

export interface UseMarkovGraphReturn {
  /**
   * Record a state transition from → to (wraps `incrementTransition`).
   * Stable callback — never changes identity.
   */
  record: (from: string, to: string) => void;
  /** P(to | from) with optional Bayesian smoothing. Stable callback. */
  getProbability: (from: string, to: string) => number;
  /**
   * Outgoing edges from `from` whose probability ≥ `minProbability` (default
   * `0.1`), sorted descending. Stable callback.
   */
  getLikelyNextStates: (
    from: string,
    minProbability?: number,
  ) => { state: string; probability: number }[];
  /**
   * Normalized entropy H(state) ∈ [0, 1] — local decision-space randomness.
   * Stable callback.
   */
  entropyForState: (state: string) => number;
  /** Number of live states in the graph (version-keyed, recomputed after each `record()`). */
  stateCount: number;
  /** Total recorded transition observations across all edges (version-keyed). */
  edgeCount: number;
  /**
   * Full JSON snapshot of the graph for visualization — updated via
   * `startTransition` so serialization never blocks urgent re-renders.
   * `null` until the first `record()` call.
   */
  snapshot: SerializedMarkovGraph | null;
  /** Serialize the current graph to a plain-object snapshot. Stable callback. */
  toJSON: () => SerializedMarkovGraph;
}

/**
 * `useMarkovGraph` — standalone React wrapper for `MarkovGraph`.
 *
 * Creates a `MarkovGraph` instance synchronously on first render (same
 * idempotent guard pattern as `useBloomFilter` and `PassiveIntentProvider`).
 *
 * **Reactivity model:**
 * - `record()` bumps a `useReducer` version counter; `useMemo` keyed on that
 *   version recomputes `stateCount` and `edgeCount` in the same commit.
 * - The full JSON snapshot (`snapshot`) is serialized inside `startTransition`
 *   so `toJSON()` never competes with urgent input events.
 *
 * **Config stability:** captured at first render. To apply a new config,
 * remount the component (change its `key` prop).
 *
 * @example
 * ```tsx
 * const { record, stateCount, edgeCount, snapshot } = useMarkovGraph();
 *
 * useEffect(() => {
 *   record(prevRoute, currentRoute);
 * }, [currentRoute, record]);
 *
 * return <p>{stateCount} states · {edgeCount} transitions</p>;
 * ```
 */
export function useMarkovGraph(config?: MarkovGraphConfig): UseMarkovGraphReturn {
  const configRef = useRef(config);

  // ── Synchronous instance init (idempotent guard) ────────────────────────────
  const instanceRef = useRef<MarkovGraph | null>(null);
  if (instanceRef.current === null) {
    instanceRef.current = new MarkovGraph(configRef.current);
  }

  // ── Version counter ──────────────────────────────────────────────────────────
  const [version, bumpVersion] = useReducer(VERSION_BUMP, 0);

  // ── Visualization snapshot (deferred) ──────────────────────────────────────
  // Null until the first record() — avoids a toJSON() call on an empty graph.
  // Updated inside startTransition: toJSON() traverses the full Map structure,
  // which can be non-trivial on large graphs; deferring it keeps interactions snappy.
  const [snapshot, setSnapshot] = useState<SerializedMarkovGraph | null>(null);

  // ── Stable mutation callback ────────────────────────────────────────────────
  // bumpVersion (dispatch) and instanceRef are both stable — empty deps correct.
  const record = useCallback((from: string, to: string) => {
    instanceRef.current!.incrementTransition(from, to);
    bumpVersion();
    startTransition(() => {
      setSnapshot(instanceRef.current!.toJSON());
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stable read-only callbacks ──────────────────────────────────────────────
  const getProbability = useCallback(
    (from: string, to: string) => instanceRef.current!.getProbability(from, to),
    [],
  );

  const getLikelyNextStates = useCallback(
    (from: string, minProbability = 0.1) =>
      instanceRef.current!.getLikelyNextStates(from, minProbability),
    [],
  );

  // Uses normalizedEntropyForState (local fan-out denominator, [0,1] range)
  // rather than the raw entropyForState (nats, unbounded) for UI-friendly values.
  const entropyForState = useCallback(
    (state: string) => instanceRef.current!.normalizedEntropyForState(state),
    [],
  );

  const toJSON = useCallback(() => instanceRef.current!.toJSON(), []);

  // ── Derived values (version-keyed) ─────────────────────────────────────────
  const stateCount = useMemo(() => instanceRef.current!.stateCount(), [version]);
  const edgeCount = useMemo(() => instanceRef.current!.totalTransitions(), [version]);

  useDebugValue(stateCount, (n) => `MarkovGraph — ${n} states`);

  return useMemo(
    () => ({
      record,
      getProbability,
      getLikelyNextStates,
      entropyForState,
      stateCount,
      edgeCount,
      snapshot,
      toJSON,
    }),
    [
      record,
      getProbability,
      getLikelyNextStates,
      entropyForState,
      stateCount,
      edgeCount,
      snapshot,
      toJSON,
    ],
  );
}
