/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Microkernel plugin interfaces — Layer 2 contracts.
 * --------------------------------------------------------
 * These four interfaces are the only extension points the raw IntentEngine
 * understands.  Every platform-specific concern (DOM, localStorage, React
 * Native, Electron, …) must be expressed through one of them.
 *
 * The IntentEngine itself has zero references to `window`, `document`, or
 * `localStorage`.  All I/O flows through these injected adapters.
 */

/* ------------------------------------------------------------------ */
/*  IInputAdapter                                                      */
/* ------------------------------------------------------------------ */

/**
 * Push-based bridge for domain-specific navigation input.
 *
 * Implementations subscribe to the host environment's navigation events
 * (React Router history, React Native navigation, URL hash changes, custom
 * app events, …) and push canonical state strings into the engine via the
 * registered callback.
 *
 * The engine calls `subscribe()` exactly once during construction and stores
 * the returned unsubscribe function for use during `destroy()`.
 *
 * @example Browser history adapter
 * ```ts
 * class HistoryInputAdapter implements IInputAdapter {
 *   private off: (() => void) | null = null;
 *   subscribe(onState: (state: string) => void): () => void {
 *     const handler = () => onState(location.pathname);
 *     window.addEventListener('popstate', handler);
 *     this.off = () => window.removeEventListener('popstate', handler);
 *     return this.off;
 *   }
 *   destroy(): void { this.off?.(); }
 * }
 * ```
 */
export interface IInputAdapter {
  /**
   * Register the engine's state-change handler.
   * Called once at engine construction time.
   * @returns An unsubscribe function that removes the handler.
   */
  subscribe(onState: (state: string) => void): () => void;
  /** Release any resources held by this adapter. */
  destroy(): void;
}

/* ------------------------------------------------------------------ */
/*  ILifecycleAdapter                                                  */
/* ------------------------------------------------------------------ */

/**
 * Platform lifecycle bridge.
 *
 * Abstracts visibility / foreground transitions so the engine can be used
 * safely in React Native, Electron, and SSR environments where `document`
 * is absent.
 *
 * The method signatures are intentionally identical to the existing
 * `LifecycleAdapter` interface in `adapters.ts` so that the concrete
 * `BrowserLifecycleAdapter` satisfies this interface structurally — no
 * changes to existing adapters are required.
 */
export interface ILifecycleAdapter {
  /**
   * Register a callback invoked when the environment becomes inactive
   * (tab hidden, app backgrounded, etc.).
   * @returns Unsubscribe function that removes only this callback.
   */
  onPause(callback: () => void): () => void;
  /**
   * Register a callback invoked when the environment becomes active again.
   * @returns Unsubscribe function that removes only this callback.
   */
  onResume(callback: () => void): () => void;
  /**
   * Optional: register a callback for any user interaction (mouse, keyboard,
   * scroll, touch).  Used by higher layers for idle detection.
   *
   * Implementations should throttle internally (≤ once per 1 000 ms).
   * Return `null` when the environment cannot deliver interaction events.
   */
  onInteraction?(callback: () => void): (() => void) | null;
  /**
   * Optional: register a callback for exit intent (e.g. pointer leaving the
   * viewport toward the browser chrome).
   * @returns Unsubscribe function.
   */
  onExitIntent?(callback: () => void): () => void;
  /** Remove all event listeners and release resources. */
  destroy(): void;
}

/* ------------------------------------------------------------------ */
/*  IStateModel                                                        */
/* ------------------------------------------------------------------ */

/**
 * Result returned by {@link IStateModel.evaluateEntropy}.
 */
export interface EntropyResult {
  /** Raw Shannon entropy of outgoing transitions from this state. */
  entropy: number;
  /** Entropy normalized to [0, 1] against the maximum possible value. */
  normalizedEntropy: number;
  /** `true` when `normalizedEntropy` exceeds the configured threshold. */
  isHigh: boolean;
}

/**
 * Result returned by {@link IStateModel.evaluateTrajectory}.
 * `null` when there is insufficient baseline data to compute a z-score.
 */
export interface TrajectoryResult {
  /** Z-score of the observed transition relative to the baseline distribution. */
  zScore: number;
  /** `true` when `zScore <= -divergenceThreshold` (lower-tail check for anomalously low likelihood). */
  isAnomalous: boolean;
  /** Log-likelihood of the observed transition under the live graph. */
  logLikelihood: number;
  /** Expected log-likelihood under the pre-trained baseline graph. */
  baselineLogLikelihood: number;
  /** Number of outgoing transitions observed from the departing state. */
  sampleSize: number;
}

/**
 * Abstraction over the state transition model (Markov graph + Bloom filter).
 *
 * The engine never touches raw data structures — it only asks the model
 * questions and receives typed decision objects in return.
 *
 * Implementations are expected to wrap the existing `MarkovGraph` and
 * `BloomFilter` classes, delegating signal evaluation internally.
 *
 * @example Minimal in-memory stub (for tests)
 * ```ts
 * const noopModel: IStateModel = {
 *   markSeen: () => {},
 *   hasSeen: () => false,
 *   recordTransition: () => {},
 *   getLikelyNext: () => [],
 *   evaluateEntropy: () => ({ entropy: 0, normalizedEntropy: 0, isHigh: false }),
 *   evaluateTrajectory: () => null,
 *   serialize: () => '',
 *   restore: () => {},
 * };
 * ```
 */
export interface IStateModel {
  /** Mark a state as observed (Bloom filter insert). */
  markSeen(state: string): void;
  /** Return `true` if the state has been observed before (Bloom filter query). */
  hasSeen(state: string): boolean;
  /** Record a `from → to` transition in the Markov graph. */
  recordTransition(from: string, to: string): void;
  /**
   * Return the most likely next states from `state`, filtered by `threshold`.
   * Results are sorted descending by probability.
   */
  getLikelyNext(state: string, threshold: number): { state: string; probability: number }[];
  /** Evaluate whether the current state's outgoing entropy is anomalously high. */
  evaluateEntropy(state: string): EntropyResult;
  /**
   * Evaluate whether the `from → to` transition is anomalous relative to the
   * baseline distribution.  Returns `null` when no baseline is available or
   * when there is insufficient trajectory data for a z-score comparison.
   */
  evaluateTrajectory(
    from: string,
    to: string,
    trajectory: readonly string[],
  ): TrajectoryResult | null;
  /**
   * Serialize the full model state (Markov graph + Bloom filter) to an opaque
   * string suitable for storage via {@link IPersistenceAdapter}.
   */
  serialize(): string;
  /**
   * Restore model state from a previously serialized string.
   * Implementations should throw on parse failure so the engine can catch and
   * surface it through the `onError` callback.
   */
  restore(serialized: string): void;
}

/* ------------------------------------------------------------------ */
/*  IPersistenceAdapter                                                */
/* ------------------------------------------------------------------ */

/**
 * Synchronous key-value storage contract.
 *
 * Intentionally synchronous at the microkernel level — async persistence is a
 * higher-layer concern handled by `IntentManager.createAsync()`.
 *
 * @example In-memory adapter (tests / SSR)
 * ```ts
 * class MemoryPersistenceAdapter implements IPersistenceAdapter {
 *   private store = new Map<string, string>();
 *   load(key: string): string | null { return this.store.get(key) ?? null; }
 *   save(key: string, value: string): void { this.store.set(key, value); }
 * }
 * ```
 */
export interface IPersistenceAdapter {
  /** Load a previously saved value, or `null` if none exists. */
  load(key: string): string | null;
  /** Persist `value` under `key`. May throw on quota exhaustion. */
  save(key: string, value: string): void;
}

/* ------------------------------------------------------------------ */
/*  IntentEngineConfig                                                 */
/* ------------------------------------------------------------------ */

/**
 * Strict configuration object for {@link IntentEngine}.
 *
 * All four adapter interfaces must be provided.  The `input` adapter is
 * optional — callers may instead drive the engine manually via `track()`.
 */
export interface IntentEngineConfig {
  /** State transition model (Markov graph + Bloom filter). Required. */
  stateModel: IStateModel;
  /** Storage backend for serialized model state. Required. */
  persistence: IPersistenceAdapter;
  /** Platform lifecycle bridge. Required. */
  lifecycle: ILifecycleAdapter;
  /**
   * Optional push-based navigation input adapter.
   * When provided, the engine subscribes to navigation events automatically.
   * When omitted, callers drive the engine via `IntentEngine.track()`.
   */
  input?: IInputAdapter;
  /**
   * Storage key used by `IPersistenceAdapter`.
   * Default: `'passive-intent-engine'`.
   */
  storageKey?: string;
  /**
   * Optional custom state normalizer applied **after** the built-in
   * `normalizeRouteState()`.  Returning an empty string silently drops
   * the `track()` call.
   */
  stateNormalizer?: (state: string) => string;
  /**
   * Non-fatal error callback.  The engine never throws — all errors are
   * forwarded here so the host can log, alert, or recover.
   */
  onError?: (error: { code: string; message: string }) => void;
}
