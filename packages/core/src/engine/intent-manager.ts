/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BenchmarkRecorder } from '../performance-instrumentation.js';
import type { PerformanceReport } from '../performance-instrumentation.js';
import { BrowserStorageAdapter, BrowserTimerAdapter } from '../adapters.js';
import type { AsyncStorageAdapter, StorageAdapter, TimerAdapter } from '../adapters.js';
import { BloomFilter } from '../core/bloom.js';
import { MarkovGraph } from '../core/markov.js';
import { normalizeRouteState } from '../utils/route-normalizer.js';
import type { SerializedMarkovGraph } from '../core/markov.js';
import type {
  ConversionPayload,
  PassiveIntentError,
  PassiveIntentTelemetry,
  IntentEventMap,
  IntentManagerConfig,
} from '../types/events.js';
import { MAX_WINDOW_LENGTH } from './constants.js';
import { buildIntentManagerOptions } from './config-normalizer.js';
import { EventEmitter } from './event-emitter.js';
import { SignalEngine } from './signal-engine.js';
import { PersistenceCoordinator } from './persistence-coordinator.js';
import { LifecycleCoordinator } from './lifecycle-coordinator.js';
import type { EnginePolicy } from './policies/engine-policy.js';
import { DwellTimePolicy } from './policies/dwell-time-policy.js';
import { BigramPolicy } from './policies/bigram-policy.js';
import { DriftProtectionPolicy } from './policies/drift-protection-policy.js';
import { CrossTabSyncPolicy } from './policies/cross-tab-sync-policy.js';

/**
 * Shared mutable context passed through each `trackStages` pipeline function.
 */
interface TrackContext {
  state: string;
  now: number;
  trackStart: number;
  from: string | null;
  isNewToBloom: boolean;
}

/**
 * Intent manager orchestrates collection + modeling + interventions.
 */
export class IntentManager {
  private readonly bloom: BloomFilter;
  private readonly graph: MarkovGraph;
  private readonly baseline: MarkovGraph | null;
  private readonly emitter = new EventEmitter<IntentEventMap>();
  private readonly benchmark: BenchmarkRecorder;
  private readonly timer: TimerAdapter;
  private readonly onError?: (error: PassiveIntentError) => void;
  private readonly botProtection: boolean;

  /* Pluggable feature policies (deterministic order) */
  private readonly policies: EnginePolicy[];

  /* Collaborators */
  private readonly signalEngine: SignalEngine;
  private readonly persistenceCoordinator: PersistenceCoordinator;
  private readonly lifecycleCoordinator: LifecycleCoordinator;

  /* Pipeline state */
  private previousState: string | null = null;
  private previousStateEnteredAt: number = 0;
  private recentTrajectory: string[] = [];

  /* Deterministic named counters — session-scoped, never persisted */
  private counters = new Map<string, number>();

  /* GDPR-compliant telemetry */
  private readonly sessionId: string;
  private readonly assignmentGroup: 'treatment' | 'control';

  private readonly trackStages: Array<(ctx: TrackContext) => void>;

  constructor(config: IntentManagerConfig = {}) {
    // ── Normalize all config precedence, defaults, and clamping ────────────
    const opts = buildIntentManagerOptions(config);

    this.benchmark = new BenchmarkRecorder(config.benchmark);
    this.timer = config.timer ?? new BrowserTimerAdapter();
    this.onError = config.onError;
    this.botProtection = opts.botProtection;

    // Session ID — local-only, never transmitted.
    this.sessionId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    // A/B holdout assignment: randomly place the session in 'control' or 'treatment'.
    this.assignmentGroup = Math.random() * 100 < opts.holdoutPercent ? 'control' : 'treatment';

    // ── PersistenceCoordinator (restore on construction) ──────────────────────
    const persistenceCoordinator = new PersistenceCoordinator({
      storageKey: opts.storageKey,
      persistDebounceMs: opts.persistDebounceMs,
      persistThrottleMs: opts.persistThrottleMs,
      storage: config.storage ?? new BrowserStorageAdapter(),
      asyncStorage: config.asyncStorage ?? null,
      timer: this.timer,
      onError: config.onError,
    });
    this.persistenceCoordinator = persistenceCoordinator;

    const restored = persistenceCoordinator.restore(opts.graphConfig);

    this.bloom = restored?.bloom ?? new BloomFilter(config.bloom);
    this.graph = restored?.graph ?? new MarkovGraph(opts.graphConfig);
    this.baseline = config.baseline
      ? MarkovGraph.fromJSON(config.baseline, opts.graphConfig)
      : null;

    // Attach the live graph + bloom so the coordinator can serialise them.
    persistenceCoordinator.attach(this.graph, this.bloom);

    // ── Policies (deterministic order) ─────────────────────────────────────────
    // Each policy is only instantiated when its feature flag is enabled.
    // Policies are called in array order at each hook point.
    const driftPolicy = new DriftProtectionPolicy(
      opts.driftMaxAnomalyRate,
      opts.driftEvaluationWindowMs,
    );
    const policies: EnginePolicy[] = [driftPolicy];

    // ── SignalEngine ──────────────────────────────────────────────────────────
    this.signalEngine = new SignalEngine({
      graph: this.graph,
      baseline: this.baseline,
      timer: this.timer,
      benchmark: this.benchmark,
      emitter: this.emitter,
      assignmentGroup: this.assignmentGroup,
      eventCooldownMs: opts.eventCooldownMs,
      dwellTimeMinSamples: opts.dwellTimeMinSamples,
      dwellTimeZScoreThreshold: opts.dwellTimeZScoreThreshold,
      hesitationCorrelationWindowMs: opts.hesitationCorrelationWindowMs,
      trajectorySmoothingEpsilon: opts.trajectorySmoothingEpsilon,
      driftPolicy,
    });

    // DwellTimePolicy — only when dwell detection is enabled.
    if (opts.dwellTimeEnabled) {
      policies.push(
        new DwellTimePolicy({
          isSuspected: () => this.signalEngine.suspected,
          evaluateDwellTime: (state, dwellMs) =>
            this.signalEngine.evaluateDwellTime(state, dwellMs),
          getPreviousStateEnteredAt: () => this.previousStateEnteredAt,
          emitter: this.emitter,
        }),
      );
    }

    // BigramPolicy — only when second-order transitions are enabled.
    if (opts.enableBigrams) {
      policies.push(new BigramPolicy(this.graph, opts.bigramFrequencyThreshold));
    }

    // CrossTabSyncPolicy — only when cross-tab sync is enabled.
    if (opts.crossTabSync) {
      policies.push(
        new CrossTabSyncPolicy({
          channelName: `passiveintent-sync:${opts.storageKey}`,
          graph: this.graph,
          bloom: this.bloom,
          counters: this.counters,
          isSuspected: () => this.signalEngine.suspected,
        }),
      );
    }

    this.policies = policies;

    // ── LifecycleCoordinator ──────────────────────────────────────────────────
    this.lifecycleCoordinator = new LifecycleCoordinator({
      lifecycleAdapter: config.lifecycleAdapter,
      timer: this.timer,
      dwellTimeEnabled: opts.dwellTimeEnabled,
      emitter: this.emitter,
      onAdjustBaseline: (delta: number) => {
        this.previousStateEnteredAt += delta;
      },
      onResetBaseline: () => {
        this.previousStateEnteredAt = this.timer.now();
      },
      hasPreviousState: () => this.previousState !== null,
    });

    // ── Pipeline stages ───────────────────────────────────────────────────────
    // Stages are bound arrow functions so future versions can insert, replace, or
    // reorder steps without touching the core track() loop.
    this.trackStages = [
      this.runBotProtectionStage,
      this.runBloomStage,
      this.runTransitionContextStage,
      this.runGraphAndSignalStage,
      this.runEmitAndPersistStage,
    ];
  }

  on<K extends keyof IntentEventMap>(
    event: K,
    listener: (payload: IntentEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /**
   * Async factory for environments with asynchronous storage backends
   * (React Native AsyncStorage, Capacitor Preferences, IndexedDB wrappers, etc.).
   *
   * `createAsync` awaits the initial `getItem` call to pre-load any persisted
   * Bloom filter + Markov graph **before** constructing the engine, so that
   * the synchronous `track()` hot-path is never blocked by I/O.  Once the
   * initial read completes, the engine is instantiated synchronously using
   * a lightweight bridge adapter that vends the pre-read payload to
   * `restore()` — no further synchronous storage access is performed.
   *
   * Subsequent `persist()` calls use `config.asyncStorage.setItem()` in a
   * fire-and-forget manner, guarded by an in-flight write flag to prevent
   * overlapping writes.
   *
   * ```ts
   * const adapter: AsyncStorageAdapter = {
   *   getItem: (key) => AsyncStorage.getItem(key),
   *   setItem: (key, value) => AsyncStorage.setItem(key, value),
   * };
   * const intent = await IntentManager.createAsync({ asyncStorage: adapter });
   * ```
   *
   * @throws {Error} When `config.asyncStorage` is not provided.
   */
  static async createAsync(config: IntentManagerConfig): Promise<IntentManager> {
    if (!config.asyncStorage) {
      throw new Error('IntentManager.createAsync() requires config.asyncStorage');
    }
    // Use the same default storage key as the config normalizer without
    // incurring a second full normalization pass.
    const storageKey = config.storageKey ?? 'passive-intent';
    // Await the single I/O call up-front so the constructor stays synchronous.
    const raw = await config.asyncStorage.getItem(storageKey);

    // Build a minimal sync bridge that serves the pre-read payload to restore()
    // and is otherwise a no-op for setItem (async writes go through asyncStorage
    // inside persist()).
    // Note: `storage` is explicitly omitted from the spread so that if the
    // caller also set `config.storage`, we don't inadvertently trigger the
    // "both adapters provided" warning in the constructor.
    const preloadBridge: StorageAdapter = {
      // getItem is invoked exactly once — by restore() in the constructor.
      getItem: () => raw,
      setItem: () => {
        /* writes handled async in persist() */
      },
    };
    const { storage: _omit, ...restConfig } = config;
    return new IntentManager({ ...restConfig, storage: preloadBridge });
  }

  /**
   * Track a page view or custom state transition.
   *
   * The `state` argument is automatically normalized via `normalizeRouteState()`
   * before any processing.  This means you can pass raw URL strings directly —
   * query strings, hash fragments, trailing slashes, UUIDs, and MongoDB
   * ObjectIDs are all stripped or replaced so the engine always receives a
   * stable, canonical state label.
   *
   * ```ts
   * intent.track('/users/550e8400-e29b-41d4-a716-446655440000/profile?tab=bio');
   * // internally treated as: '/users/:id/profile'
   * ```
   */
  track(state: string): void {
    // Normalise first: strip query strings, hash fragments, trailing slashes,
    // and replace dynamic ID segments (UUIDs, MongoDB ObjectIDs) with ':id'.
    state = normalizeRouteState(state);

    // Guard: '' is reserved internally as a tombstone marker.
    // Silently drop and surface a non-fatal error rather than crashing the host.
    if (state === '') {
      if (this.onError) {
        this.onError({
          code: 'VALIDATION',
          message: 'IntentManager.track(): state label must not be an empty string',
        });
      }
      return;
    }

    const now = this.timer.now();
    const trackStart = this.benchmark.now();

    // Advance drift-protection rolling window via policy hooks (O(1), no allocations)
    for (let i = 0; i < this.policies.length; i += 1) this.policies[i].onTrackStart?.(now);

    const ctx: TrackContext = {
      state,
      now,
      trackStart,
      from: null,
      isNewToBloom: false,
    };

    for (let i = 0; i < this.trackStages.length; i += 1) {
      this.trackStages[i](ctx);
    }

    this.benchmark.record('track', trackStart);
  }

  private runBotProtectionStage = (ctx: TrackContext): void => {
    if (!this.botProtection) return;
    const botResult = this.signalEngine.recordBotCheck(ctx.now);
    if (botResult.transitionedToBot) {
      this.emitter.emit('bot_detected', { state: ctx.state });
    }
  };

  private runBloomStage = (ctx: TrackContext): void => {
    ctx.isNewToBloom = !this.bloom.check(ctx.state);
    const bloomAddStart = this.benchmark.now();
    this.bloom.add(ctx.state);
    this.benchmark.record('bloomAdd', bloomAddStart);
  };

  private runTransitionContextStage = (ctx: TrackContext): void => {
    ctx.from = this.previousState;
    this.previousState = ctx.state;

    // Dwell-time measurement — delegated to DwellTimePolicy when enabled.
    for (let i = 0; i < this.policies.length; i += 1) this.policies[i].onTrackContext?.(ctx);

    // CONTRACT: this reset MUST remain unconditional and MUST happen after all
    // onTrackContext hooks.  DwellTimePolicy reads previousStateEnteredAt inside
    // its hook and relies on this line to clear any stale baseline afterwards —
    // including the session_stale (dwell_exceeded) code path.
    this.previousStateEnteredAt = ctx.now;

    this.recentTrajectory.push(ctx.state);
    if (this.recentTrajectory.length > MAX_WINDOW_LENGTH) this.recentTrajectory.shift();
  };

  private runGraphAndSignalStage = (ctx: TrackContext): void => {
    if (ctx.from) {
      const incrementStart = this.benchmark.now();
      this.graph.incrementTransition(ctx.from, ctx.state);
      this.benchmark.record('incrementTransition', incrementStart);

      // Increment transition counter in SignalEngine
      this.signalEngine.recordTransition(ctx.from, ctx.state, this.recentTrajectory);

      // Bigram accounting — delegated to BigramPolicy when enabled.
      for (let i = 0; i < this.policies.length; i += 1)
        this.policies[i].onTransition?.(ctx.from, ctx.state, this.recentTrajectory);

      this.persistenceCoordinator.markDirty();
      this.signalEngine.evaluateEntropy(ctx.state);
      this.signalEngine.evaluateTrajectory(ctx.from, ctx.state, this.recentTrajectory);

      // Cross-tab broadcast — delegated to CrossTabSyncPolicy when enabled.
      for (let i = 0; i < this.policies.length; i += 1)
        this.policies[i].onAfterEvaluation?.(ctx.from, ctx.state);

      return;
    }

    if (ctx.isNewToBloom) {
      this.persistenceCoordinator.markDirty();
    }
  };

  private runEmitAndPersistStage = (ctx: TrackContext): void => {
    this.emitter.emit('state_change', { from: ctx.from, to: ctx.state });
    // Synchronous persist on every transition — crash-safe against sudden OS
    // process kills where lifecycle events never fire.
    // The dirty-flag short-circuit keeps this a no-op when nothing changed.
    this.persistenceCoordinator.persist();
  };

  hasSeen(state: string): boolean {
    const start = this.benchmark.now();
    const seen = this.bloom.check(state);
    this.benchmark.record('bloomCheck', start);
    return seen;
  }

  /**
   * Reset session-specific state for clean evaluation boundaries.
   * Clears the recent trajectory and previous state, but preserves
   * the learned Markov graph and Bloom filter.
   */
  resetSession(): void {
    this.recentTrajectory = [];
    this.previousState = null;
    this.previousStateEnteredAt = 0;
  }

  exportGraph(): SerializedMarkovGraph {
    return this.graph.toJSON();
  }

  /**
   * Returns the most likely next states from the current (or previous) state,
   * filtered by a minimum probability threshold and an optional sanitize predicate.
   *
   * Designed for **read-only** UI prefetching hints only.  This method exposes
   * predictive data from the Markov graph to the host application so it can
   * preload assets or warm caches for the most probable next routes.
   *
   * ⚠ **Security constraint — you MUST provide a `sanitize` function.**
   * Without a sanitize predicate, the returned list may include state-mutating
   * or privacy-sensitive routes such as `/logout`, `/checkout/pay`, or routes
   * that embed PII (e.g. `/users/john.doe/settings`).  The sanitize function
   * must return `false` for any such route.  Prefetching must **never** trigger
   * state-mutating side effects — treat the results as navigation hints only.
   *
   * ```ts
   * // ✅ Safe usage with a sanitize guard
   * const hints = intent.predictNextStates(0.3, (state) => {
   *   const blocked = ['/logout', '/checkout/pay', '/delete-account'];
   *   return !blocked.some((b) => state.startsWith(b)) &&
   *          !/\/users\/[^/]+\/pii/.test(state);
   * });
   * hints.forEach(({ state, probability }) => prefetch(state));
   * ```
   *
   * @param threshold  Minimum probability in [0, 1] for a state to be included.
   *                   Defaults to `0.3`.
   * @param sanitize   Optional predicate that receives each candidate state label
   *                   and returns `true` to **include** it or `false` to **exclude**
   *                   it.  When omitted all states above the threshold are returned,
   *                   which is **unsafe** for production use — always supply this.
   * @returns Filtered and sorted `{ state, probability }[]`, descending by
   *          probability.  Returns an empty array when no previous state is known
   *          or no transitions meet the threshold.
   */
  predictNextStates(
    threshold = 0.3,
    sanitize?: (state: string) => boolean,
  ): { state: string; probability: number }[] {
    if (this.previousState === null) return [];
    const candidates = this.graph.getLikelyNextStates(this.previousState, threshold);
    if (!sanitize) return candidates;
    return candidates.filter(({ state }) => sanitize(state));
  }

  flushNow(): void {
    this.persistenceCoordinator.flushNow();
  }

  /**
   * Tear down the manager: flush any pending state to storage,
   * cancel the debounce timer, and remove all event listeners.
   *
   * Call this in SPA cleanup paths (React `useEffect` teardown,
   * Vue `onUnmounted`, Angular `ngOnDestroy`) to prevent memory
   * leaks from retained listener references.
   *
   * After `destroy()` the instance should be discarded.
   */
  destroy(): void {
    this.persistenceCoordinator.flushNow(); // best-effort final write (may be async)
    this.persistenceCoordinator.close(); // prevent post-destroy timer re-arm
    this.emitter.removeAll();
    this.lifecycleCoordinator.destroy();
    for (let i = 0; i < this.policies.length; i += 1) this.policies[i].destroy?.();
  }

  /**
   * Returns a GDPR-compliant telemetry snapshot for the current session.
   *
   * All fields are aggregate counters or derived status flags.
   * No raw behavioral data, no state labels, and no user-identifying
   * information is included. Safe to send to your own analytics endpoint
   * without triggering GDPR personal-data obligations.
   *
   * ```ts
   * const t = intent.getTelemetry();
   * // { sessionId: 'a1b2...', transitionsEvaluated: 42, botStatus: 'human',
   * //   anomaliesFired: 3, engineHealth: 'healthy' }
   * ```
   */
  getTelemetry(): PassiveIntentTelemetry {
    return {
      sessionId: this.sessionId,
      transitionsEvaluated: this.signalEngine.transitionsEvaluated,
      botStatus: this.signalEngine.suspected ? 'suspected_bot' : 'human',
      anomaliesFired: this.signalEngine.anomaliesFired,
      engineHealth: this.persistenceCoordinator.engineHealth,
      baselineStatus: this.signalEngine.baselineStatus,
      assignmentGroup: this.assignmentGroup,
    };
  }

  /**
   * Record a conversion event and emit it through the event bus.
   *
   * Use this to measure the ROI of intent-driven interventions (e.g.
   * whether a hesitation discount actually led to a purchase).
   *
   * ```ts
   * intent.on('conversion', ({ type, value, currency }) => {
   *   // All local — log to your own backend if needed
   *   console.log(`Conversion: ${type} ${value} ${currency}`);
   * });
   *
   * // After a purchase completes:
   * intent.trackConversion({ type: 'purchase', value: 49.99, currency: 'USD' });
   * ```
   *
   * **Privacy note:** `type` must not contain user identifiers.
   * This event never leaves the device unless your `conversion` listener
   * explicitly sends it — which remains entirely under your control.
   */
  trackConversion(payload: ConversionPayload): void {
    this.emitter.emit('conversion', payload);
  }

  /**
   * Increment a named counter by `by` (default 1) and return the new value.
   *
   * Counters are deterministic: unlike the probabilistic Bloom filter, they
   * track exact counts with no false positives.  Use them for business
   * metrics such as "articles read", "items added to cart", or any case
   * where an exact integer matters.
   *
   * Counters are session-scoped and never persisted to storage.
   *
   * ```ts
   * intent.incrementCounter('articles_read');        // 1
   * intent.incrementCounter('articles_read');        // 2
   * intent.incrementCounter('articles_read', 3);     // 5
   * ```
   *
   * @param key - Identifier for the counter. Must not be an empty string.
   * @param by  - Amount to add. Defaults to 1. Must be a finite number.
   * @returns   The new counter value after incrementing.
   */
  incrementCounter(key: string, by = 1): number {
    if (key === '') {
      if (this.onError) {
        this.onError({
          code: 'VALIDATION',
          message: 'IntentManager.incrementCounter(): key must not be an empty string',
        });
      }
      return 0;
    }
    if (!Number.isFinite(by)) {
      if (this.onError) {
        this.onError({
          code: 'VALIDATION',
          message: `IntentManager.incrementCounter(): 'by' must be a finite number, got ${by}`,
        });
      }
      return this.counters.get(key) ?? 0;
    }
    const next = (this.counters.get(key) ?? 0) + by;
    this.counters.set(key, next);
    // Broadcast the increment to other tabs via CrossTabSyncPolicy.
    for (let i = 0; i < this.policies.length; i += 1)
      this.policies[i].onCounterIncrement?.(key, by);
    return next;
  }

  /**
   * Return the current value of a named counter, or 0 if it has never been
   * incremented.
   *
   * ```ts
   * intent.getCounter('articles_read'); // 0 before any increments
   * ```
   *
   * @param key - Identifier for the counter.
   */
  getCounter(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /**
   * Reset a named counter to 0.
   *
   * After this call `getCounter(key)` returns 0.  The counter entry is
   * removed from internal storage rather than being set to 0, keeping the
   * map compact.
   *
   * ```ts
   * intent.incrementCounter('articles_read', 5);
   * intent.resetCounter('articles_read');
   * intent.getCounter('articles_read'); // 0
   * ```
   *
   * @param key - Identifier for the counter to reset.
   */
  resetCounter(key: string): void {
    this.counters.delete(key);
  }

  getPerformanceReport(): PerformanceReport {
    const serialized = this.graph.toJSON();
    return this.benchmark.report({
      stateCount: this.graph.stateCount(),
      totalTransitions: this.graph.totalTransitions(),
      bloomBitsetBytes: this.bloom.getBitsetByteSize(),
      serializedGraphBytes: this.benchmark.serializedSizeBytes(serialized),
    });
  }
}
