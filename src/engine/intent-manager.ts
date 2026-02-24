/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BenchmarkRecorder } from '../performance-instrumentation.js';
import type { BenchmarkConfig, PerformanceReport } from '../performance-instrumentation.js';
import { BrowserStorageAdapter, BrowserTimerAdapter } from '../adapters.js';
import type { AsyncStorageAdapter, StorageAdapter, TimerAdapter, TimerHandle } from '../adapters.js';
import { base64ToUint8, uint8ToBase64 } from '../persistence/codec.js';
import { BloomFilter } from '../core/bloom.js';
import { MarkovGraph } from '../core/markov.js';
import { EntropyGuard } from './entropy-guard.js';
import { dwellStd, updateDwellStats } from './dwell.js';
import { normalizeRouteState } from '../utils/route-normalizer.js';
import { BroadcastSync } from '../sync/broadcast-sync.js';
import type { SerializedMarkovGraph } from '../core/markov.js';
import type {
  BotDetectedPayload,
  ConversionPayload,
  DwellTimeAnomalyPayload,
  EdgeSignalTelemetry,
  HesitationDetectedPayload,
  HighEntropyPayload,
  IntentEventMap,
  IntentEventName,
  IntentManagerConfig,
  MarkovGraphConfig,
  StateChangePayload,
  TrajectoryAnomalyPayload,
} from '../types/events.js';

const SMOOTHING_EPSILON = 0.01;

/**
 * Minimum sliding window length before evaluating trajectory.
 * This "warm-up" allows the average log-likelihood to stabilize.
 */
const MIN_WINDOW_LENGTH = 16;

/**
 * Maximum sliding window length (recentTrajectory cap).
 * Used as reference for variance scaling.
 */
const MAX_WINDOW_LENGTH = 32;

/**
 * Minimum number of outgoing transitions a state must have before entropy
 * evaluation is considered statistically meaningful.
 * Higher values prevent spurious entropy triggers on small samples.
 */
const MIN_SAMPLE_TRANSITIONS = 10;

type Listener<T> = (payload: T) => void;

/**
 * Tiny event emitter.
 */
class EventEmitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener<Events[K]>>();
    set.add(listener);
    this.listeners.set(event, set as Set<Listener<any>>);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach((listener) => listener(payload));
  }

  removeAll(): void {
    this.listeners.clear();
  }
}

/**
 * Persisted payload format.
 *
 * `graphBinary` is a base64-encoded Uint8Array produced by MarkovGraph.toBinary().
 * The `graph` field (JSON-serialized) is kept for the baseline config path only;
 * the persistence hot-path always uses the binary format.
 */
interface PersistedPayload {
  /** Always present. */
  bloomBase64: string;
  /** Base64-encoded binary graph (preferred for restore). */
  graphBinary?: string;
  /** JSON-serialized graph — used only for the baseline config path. */
  graph?: SerializedMarkovGraph;
}

/**
 * Shared mutable context passed through each `trackStages` pipeline function.
 *
 * Fields are populated incrementally — `from` and `isNewToBloom` start as
 * sentinel values and are set by the Bloom and transition-context stages
 * before the graph/signal stage reads them.
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
  private readonly storageKey: string;
  private readonly persistDebounceMs: number;
  private readonly benchmark: BenchmarkRecorder;
  private readonly storage: StorageAdapter;
  /** Async storage backend — present only when created via `createAsync`. */
  private readonly asyncStorage: AsyncStorageAdapter | null;
  /**
   * Guards against overlapping async `setItem` calls.
   * When `true`, a promise-based write is already in flight;
   * subsequent `persist()` calls return early and rely on `isDirty` to
   * ensure the accumulated state is saved once the in-flight write completes.
   */
  private isAsyncWriting = false;
  private readonly timer: TimerAdapter;
  private readonly onError?: (err: Error) => void;
  private readonly botProtection: boolean;
  private readonly eventCooldownMs: number;

  /* Dwell-time anomaly detection */
  private readonly dwellTimeEnabled: boolean;
  private readonly dwellTimeMinSamples: number;
  private readonly dwellTimeZScoreThreshold: number;
  /**
   * Per-state Welford accumulators: { count, meanMs, m2 }.
   *
   * **Session-scoped — intentionally not persisted.**
   * Persisting per-state timing distributions across page reloads would
   * meaningfully increase the cross-session fingerprinting surface area,
   * which conflicts with the library's privacy-first design goal.
   * As a result, the learning phase (governed by `minSamples`) restarts
   * on every new `IntentManager` instance.  Increase `minSamples` if
   * short sessions cause excessive false positives.
   */
  private readonly dwellStats = new Map<string, { count: number; meanMs: number; m2: number }>();

  /* Selective bigram (2nd-order) Markov */
  private readonly enableBigrams: boolean;
  private readonly bigramFrequencyThreshold: number;

  /* ================================================================== */
  /*  Tab-Visibility Dwell-Time Correction                               */
  /* ================================================================== */

  /**
   * Timestamp (ms, from timer.now()) when the tab last became hidden.
   * `null` while the tab is visible or before the first hide event.
   */
  private tabHiddenAt: number | null = null;
  /**
   * Bound `visibilitychange` handler — stored so `destroy()` can call
   * `removeEventListener` with the exact same function reference and fully
   * clean up in SPA teardown paths.  `null` in non-browser environments.
   */
  private readonly visibilityChangeListener: (() => void) | null;

  /* ================================================================== */
  /*  Failsafe Killswitch — Baseline Drift Protection                   */
  /* ================================================================== */

  /** When true, evaluateTrajectory is silently disabled. */
  private isBaselineDrifted = false;
  /** Upper bound on trajectory_anomaly / track() ratio before drift is declared. */
  private readonly driftMaxAnomalyRate: number;
  /** Rolling evaluation window length in ms. */
  private readonly driftEvaluationWindowMs: number;
  /** Timestamp (ms) when the current rolling window started. */
  private driftWindowStart = 0;
  /** Number of track() calls in the current rolling window. */
  private driftWindowTrackCount = 0;
  /** Number of trajectory_anomaly emissions in the current rolling window. */
  private driftWindowAnomalyCount = 0;

  /** Timestamp of the last emission per cooldown-gated event type */
  private lastEmittedAt: Record<'high_entropy' | 'trajectory_anomaly' | 'dwell_time_anomaly', number> = {
    high_entropy: -Infinity,
    trajectory_anomaly: -Infinity,
    dwell_time_anomaly: -Infinity,
  };

  private persistTimer: TimerHandle | null = null;
  private previousState: string | null = null;
  /** Timestamp (ms, from timer.now()) when previousState was entered */
  private previousStateEnteredAt: number = 0;
  private recentTrajectory: string[] = [];

  /* Dirty-flag persistence: only persist when state actually changed */
  private isDirty = false;

  /* ================================================================== */
  /*  Deterministic Counters                                             */
  /* ================================================================== */

  /**
   * Exact named counters — session-scoped, never persisted.
   *
   * Unlike the probabilistic Bloom filter, these counters are fully
   * deterministic: `getCounter()` always returns the precise count.
   * Use them for exact business metrics such as "articles read" or
   * "items added to cart" where false positives are unacceptable.
   */
  private counters = new Map<string, number>();

  /* EntropyGuard: bot detection state */
  private readonly entropyGuard = new EntropyGuard();

  /* Cross-tab synchronization via BroadcastChannel */
  private readonly broadcastSync: BroadcastSync | null;

  /* ================================================================== */
  /*  GDPR-Compliant Telemetry                                           */
  /* ================================================================== */

  /**
   * Short-lived session identifier. Generated once at construction.
   * Never persisted to storage and never transmitted.
   */
  private readonly sessionId: string;
  /** Aggregate count of state transitions evaluated this session. */
  private transitionsEvaluated = 0;
  /** Aggregate count of anomaly events emitted this session. */
  private anomaliesFired = 0;
  /** Operational health flag — mutated by persist() and the quota error handler. */
  private engineHealth: EdgeSignalTelemetry['engineHealth'] = 'healthy';

  /* Hesitation detection: timestamps and z-scores from the last contributing signals */
  private lastTrajectoryAnomalyAt = -Infinity;
  private lastTrajectoryAnomalyZScore = 0;
  private lastDwellAnomalyAt = -Infinity;
  private lastDwellAnomalyZScore = 0;
  /** The state where the user dwelled anomalously — anchors hesitation_detected.state. */
  private lastDwellAnomalyState = '';
  private readonly hesitationCorrelationWindowMs: number;
  private readonly trackStages: Array<(ctx: TrackContext) => void>;
  /** A/B holdout group for this session. */
  private readonly assignmentGroup: 'treatment' | 'control';

  constructor(config: IntentManagerConfig = {}) {
    this.storageKey = config.storageKey ?? 'edge-signal';
    this.persistDebounceMs = config.persistDebounceMs ?? 2000;
    this.benchmark = new BenchmarkRecorder(config.benchmark);
    this.storage = config.storage ?? new BrowserStorageAdapter();
    this.asyncStorage = config.asyncStorage ?? null;
    // When asyncStorage is set, it is used for all writes (in persist()).
    // The sync storage adapter is only consulted by restore() to read the
    // pre-loaded payload (injected by createAsync); its setItem is never called.
    this.timer = config.timer ?? new BrowserTimerAdapter();
    this.onError = config.onError;
    this.botProtection = config.botProtection ?? true;
    this.eventCooldownMs = config.eventCooldownMs ?? 0;
    this.hesitationCorrelationWindowMs = config.hesitationCorrelationWindowMs ?? 30_000;

    // Dwell-time config
    this.dwellTimeEnabled = config.dwellTime?.enabled ?? false;
    this.dwellTimeMinSamples = config.dwellTime?.minSamples ?? 10;
    this.dwellTimeZScoreThreshold = config.dwellTime?.zScoreThreshold ?? 2.5;

    // Bigram config
    this.enableBigrams = config.enableBigrams ?? false;
    this.bigramFrequencyThreshold = config.bigramFrequencyThreshold ?? 5;

    // Drift protection config (defaults: 40 % anomaly rate over 5 minutes)
    this.driftMaxAnomalyRate = config.driftProtection?.maxAnomalyRate ?? 0.4;
    this.driftEvaluationWindowMs = config.driftProtection?.evaluationWindowMs ?? 300_000;

    // Telemetry: generate a short-lived, local-only session ID.
    // globalThis.crypto.randomUUID() is available in all modern browsers and
    // Node ≥ 19 (unflagged). Node 14.17–18 exposed randomUUID() only via the
    // built-in 'crypto' module (require('crypto')), NOT as a global, so those
    // runtimes will correctly fall back to the Math.random path below.
    this.sessionId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    // A/B holdout assignment: randomly place the session in 'control' or 'treatment'
    // based on holdoutConfig.percentage (0–100 chance of being control).
    // The percentage is clamped to [0, 100] to guard against invalid config values.
    const holdoutPct = Math.min(100, Math.max(0, config.holdoutConfig?.percentage ?? 0));
    this.assignmentGroup = Math.random() * 100 < holdoutPct ? 'control' : 'treatment';

    // Merge baseline statistics: the top-level convenience aliases
    // (config.baselineMeanLL / config.baselineStdLL) take precedence over the
    // nested graph config equivalents.  Both paths are supported for backward
    // compatibility — see IntentManagerConfig in types/events.ts for the full
    // rationale and precedence documentation.
    const graphConfig: MarkovGraphConfig = {
      ...config.graph,
      baselineMeanLL: config.baselineMeanLL ?? config.graph?.baselineMeanLL,
      baselineStdLL: config.baselineStdLL ?? config.graph?.baselineStdLL,
    };

    const restored = this.restore(graphConfig);

    this.bloom = restored?.bloom ?? new BloomFilter(config.bloom);
    this.graph = restored?.graph ?? new MarkovGraph(graphConfig);
    this.baseline = config.baseline ? MarkovGraph.fromJSON(config.baseline, graphConfig) : null;

    // Cross-tab synchronization — only initialized when explicitly opted in.
    // The channel name is derived from storageKey so that multiple independent
    // IntentManager instances (different storageKeys) never share messages.
    this.broadcastSync = (config.crossTabSync === true)
      ? new BroadcastSync(`edgesignal-sync:${this.storageKey}`, this.graph, this.bloom, this.counters)
      : null;

    this.trackStages = [
      this.runBotProtectionStage,
      this.runBloomStage,
      this.runTransitionContextStage,
      this.runGraphAndSignalStage,
      this.runEmitAndPersistStage,
    ];
    // Pipeline design: stages are an array of bound arrow functions rather
    // than a monolithic method so that future versions can insert, replace, or
    // reorder steps (e.g. add a rate-limit stage or an A/B experiment hook)
    // without touching the core track() loop.  Each stage mutates `ctx` in
    // place so no intermediate allocations are required.

    // Tab-visibility correction for dwell-time anomaly detection.
    // When the user switches tabs the monotonic timer keeps ticking, which
    // would inflate dwellMs and fire spurious dwell_time_anomaly events.
    // The fix: when the tab becomes hidden we snapshot tabHiddenAt; when it
    // becomes visible again we add the hidden duration to previousStateEnteredAt
    // so the dwell calculation automatically ignores the off-screen gap.
    // Only wired in browser environments that expose the Page Visibility API.
    if (typeof document !== 'undefined') {
      this.visibilityChangeListener = () => {
        if (document.hidden) {
          this.tabHiddenAt = this.timer.now();
        } else if (this.tabHiddenAt !== null) {
          const hiddenDuration = this.timer.now() - this.tabHiddenAt;
          // Only offset the dwell baseline when we are actively tracking a state.
          // If no state has been entered yet (previousState === null) there is no
          // dwell accumulation in progress, so no adjustment is needed.
          if (this.previousState !== null) {
            this.previousStateEnteredAt += hiddenDuration;
          }
          this.tabHiddenAt = null;
        }
      };
      document.addEventListener('visibilitychange', this.visibilityChangeListener);
    } else {
      this.visibilityChangeListener = null;
    }
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
    const storageKey = config.storageKey ?? 'edge-signal';
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
      setItem: () => { /* writes handled async in persist() */ },
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
    // Normalize first: strip query strings, hash fragments, trailing slashes,
    // and replace dynamic ID segments (UUIDs, MongoDB ObjectIDs) with ':id'.
    // This allows callers to pass raw window.location.href / pathname values.
    state = normalizeRouteState(state);

    // Guard: '' is reserved internally as a tombstone marker.
    // Silently drop the call and surface a non-fatal error rather than letting
    // MarkovGraph.ensureState() throw and potentially crash the host app.
    if (state === '') {
      if (this.onError) {
        this.onError(new Error('IntentManager.track(): state label must not be an empty string'));
      }
      return;
    }

    // Use timer.now() for bot detection to ensure it works even when benchmark is disabled
    const now = this.timer.now();
    const trackStart = this.benchmark.enabled ? now : 0;

    // Drift protection: advance the rolling window and count this call.
    // O(1) — only two scalar comparisons and integer increments; no allocations.
    if (now - this.driftWindowStart >= this.driftEvaluationWindowMs) {
      this.driftWindowStart = now;
      this.driftWindowTrackCount = 0;
      this.driftWindowAnomalyCount = 0;
    }
    this.driftWindowTrackCount += 1;

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
    const botResult = this.entropyGuard.record(ctx.now);
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

    if (this.dwellTimeEnabled && ctx.from && !this.entropyGuard.suspected) {
      const dwellMs = ctx.now - this.previousStateEnteredAt;
      this.evaluateDwellTime(ctx.from, dwellMs);
    }
    this.previousStateEnteredAt = ctx.now;

    this.recentTrajectory.push(ctx.state);
    if (this.recentTrajectory.length > MAX_WINDOW_LENGTH) this.recentTrajectory.shift();
  };

  private runGraphAndSignalStage = (ctx: TrackContext): void => {
    if (ctx.from) {
      this.transitionsEvaluated += 1;

      const incrementStart = this.benchmark.now();
      this.graph.incrementTransition(ctx.from, ctx.state);
      this.benchmark.record('incrementTransition', incrementStart);

      if (this.enableBigrams && this.recentTrajectory.length >= 3) {
        const prev2 = this.recentTrajectory[this.recentTrajectory.length - 3];
        const bigramFrom = `${prev2}\u2192${ctx.from}`;
        const bigramTo = `${ctx.from}\u2192${ctx.state}`;
        // U+2192 (→) separates bigram tokens.  The arrow character is chosen
        // deliberately: it is unlikely to appear in real state labels (which
        // are typically URL paths or semantic page names) so it acts as a
        // collision-resistant join key without requiring a separate namespace.
        if (this.graph.rowTotal(ctx.from) >= this.bigramFrequencyThreshold) {
          this.graph.incrementTransition(bigramFrom, bigramTo);
        }
      }

      this.isDirty = true;
      this.evaluateEntropy(ctx.state);
      this.evaluateTrajectory(ctx.from, ctx.state);

      // Broadcast this transition to other tabs only when the local EntropyGuard
      // has NOT flagged the session as a bot.  This prevents a local bot script
      // from amplifying noisy transitions into every other open tab.
      if (this.broadcastSync && !this.entropyGuard.suspected) {
        this.broadcastSync.broadcast(ctx.from, ctx.state);
      }

      return;
    }

    if (ctx.isNewToBloom) {
      this.isDirty = true;
    }
  };

  private runEmitAndPersistStage = (ctx: TrackContext): void => {
    this.emitter.emit('state_change', { from: ctx.from, to: ctx.state });
    this.schedulePersist();
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
    if (this.persistTimer !== null) {
      this.timer.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
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
    this.flushNow();
    this.emitter.removeAll();
    if (this.visibilityChangeListener !== null) {
      document.removeEventListener('visibilitychange', this.visibilityChangeListener);
    }
    this.broadcastSync?.close();
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
  getTelemetry(): EdgeSignalTelemetry {
    return {
      sessionId: this.sessionId,
      transitionsEvaluated: this.transitionsEvaluated,
      botStatus: this.entropyGuard.suspected ? 'suspected_bot' : 'human',
      anomaliesFired: this.anomaliesFired,
      engineHealth: this.engineHealth,
      baselineStatus: this.isBaselineDrifted ? 'drifted' : 'active',
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
        this.onError(new Error('IntentManager.incrementCounter(): key must not be an empty string'));
      }
      return 0;
    }
    const next = (this.counters.get(key) ?? 0) + by;
    this.counters.set(key, next);
    // Broadcast the increment to other tabs when cross-tab sync is enabled,
    // applying the same bot-containment guard used for Markov transitions.
    if (this.broadcastSync && !this.entropyGuard.suspected) {
      this.broadcastSync.broadcastCounter(key, by);
    }
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

  private evaluateEntropy(state: string): void {
    const start = this.benchmark.now();

    // EntropyGuard: silently skip for suspected bots
    if (this.entropyGuard.suspected) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    // Skip if there are fewer than MIN_SAMPLE_TRANSITIONS outgoing transitions (too small a sample).
    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);

    if (normalizedEntropy >= this.graph.highEntropyThreshold) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.high_entropy >= this.eventCooldownMs) {
        this.lastEmittedAt.high_entropy = now;
        this.anomaliesFired += 1;
        if (this.assignmentGroup !== 'control') {
          this.emitter.emit('high_entropy', {
            state,
            entropy,
            normalizedEntropy,
          });
        }
      }
    }

    this.benchmark.record('entropyComputation', start);
  }

  private evaluateTrajectory(from: string, to: string): void {
    const start = this.benchmark.now();

    // Failsafe killswitch: if baseline has drifted, silently skip all evaluation.
    if (this.isBaselineDrifted) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    // EntropyGuard: silently skip for suspected bots
    if (this.entropyGuard.suspected) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    // Stabilization gate: wait until window reaches minimum size for statistical stability.
    if (this.recentTrajectory.length < MIN_WINDOW_LENGTH) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    if (!this.baseline) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    // Use explicit SMOOTHING_EPSILON for parity with calibration phase.
    // "real"     = how likely this sequence is under the *live* (learned) graph.
    // "expected" = how likely it would be under the *baseline* reference graph.
    // These two values are the meaningful comparison exposed in the event payload.
    const real = MarkovGraph.logLikelihoodTrajectory(
      this.graph,
      this.recentTrajectory,
      SMOOTHING_EPSILON,
    );
    const expected = MarkovGraph.logLikelihoodTrajectory(
      this.baseline,
      this.recentTrajectory,
      SMOOTHING_EPSILON,
    );

    const N = Math.max(1, this.recentTrajectory.length - 1);
    const expectedAvg = expected / N;
    const threshold = -Math.abs(this.graph.divergenceThreshold);

    const hasCalibratedBaseline =
      typeof this.graph.baselineMeanLL === 'number'
      && typeof this.graph.baselineStdLL === 'number'
      && Number.isFinite(this.graph.baselineMeanLL)
      && Number.isFinite(this.graph.baselineStdLL)
      && this.graph.baselineStdLL > 0;

    // Dynamic variance scaling: std of an average scales by 1/sqrt(N).
    // Scale baselineStdLL by sqrt(CALIBRATION_LENGTH / N) where CALIBRATION_LENGTH = MAX_WINDOW_LENGTH.
    const adjustedStd = hasCalibratedBaseline
      ? this.graph.baselineStdLL * Math.sqrt(MAX_WINDOW_LENGTH / N)
      : 0;

    const zScore = hasCalibratedBaseline
      ? (expectedAvg - this.graph.baselineMeanLL) / adjustedStd
      : expectedAvg;

    const shouldEmit = hasCalibratedBaseline
      ? zScore <= threshold
      : expectedAvg <= threshold;

    // ⚠  KNOWN LIMITATION (v1 — accepted for initial release):
    //    At very low noise deltas (Δε ≤ 0.05, entropy difference < 0.05 nats)
    //    the z-score distributions of normal and anomalous sessions overlap
    //    substantially, yielding AUC ≈ 0.74 at the best operating point.
    //    This is a *fundamental signal constraint*, not a tuning problem:
    //    no post-processing layer (CUSUM, EWMA, confirmation counter) on top
    //    of a 32-step single-window average log-likelihood can fully separate
    //    distributions that close without either:
    //      a) a significantly longer observation horizon (> 32 steps), or
    //      b) richer feature space beyond marginal transition probabilities
    //         (e.g. dwell-time, click-velocity, inter-event interval entropy).
    //    Revisit when:  longer trajectory windows are viable, or when timing
    //    side-channels (EntropyGuard deltas) can be folded into the score.

    if (shouldEmit) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.trajectory_anomaly >= this.eventCooldownMs) {
        this.lastEmittedAt.trajectory_anomaly = now;
        this.anomaliesFired += 1;
        if (this.assignmentGroup !== 'control') {
          this.emitter.emit('trajectory_anomaly', {
            stateFrom: from,
            stateTo: to,
            realLogLikelihood: real,
            expectedBaselineLogLikelihood: expected,
            zScore,
          });
        }
        this.lastTrajectoryAnomalyAt = now;
        this.lastTrajectoryAnomalyZScore = zScore;
        this.maybeEmitHesitation();

        // Drift protection: count this anomaly emission and check the ratio.
        this.driftWindowAnomalyCount += 1;
        if (
          this.driftWindowTrackCount > 0 &&
          this.driftWindowAnomalyCount / this.driftWindowTrackCount > this.driftMaxAnomalyRate
        ) {
          this.isBaselineDrifted = true;
        }
      }
    }

    this.benchmark.record('divergenceComputation', start);
  }

  /* ================================================================== */
  /*  Dwell-Time Anomaly Detection                                       */
  /* ================================================================== */

  /**
   * Evaluate dwell time on the *previous* state using Welford's online
   * algorithm to maintain running mean and variance.  Fires a
   * `dwell_time_anomaly` event when the z-score exceeds the configured
   * threshold and enough samples have been collected.
   *
   * All computation is O(1) per call — no arrays or sorting.
   */
  private evaluateDwellTime(state: string, dwellMs: number): void {
    // Ignore non-positive dwell times (first track, or clock issues)
    if (dwellMs <= 0) return;

    const updated = updateDwellStats(this.dwellStats.get(state), dwellMs);
    this.dwellStats.set(state, updated);

    // Need enough samples for a meaningful standard deviation
    if (updated.count < this.dwellTimeMinSamples) return;

    const std = dwellStd(updated);

    // Guard: if std is zero (all identical dwell times) skip
    if (std <= 0) return;

    const zScore = (dwellMs - updated.meanMs) / std;

    if (Math.abs(zScore) >= this.dwellTimeZScoreThreshold) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.dwell_time_anomaly >= this.eventCooldownMs) {
        this.lastEmittedAt.dwell_time_anomaly = now;
        this.anomaliesFired += 1;
        if (this.assignmentGroup !== 'control') {
          this.emitter.emit('dwell_time_anomaly', {
            state,
            dwellMs,
            meanMs: updated.meanMs,
            stdMs: std,
            zScore,
          });
        }
        // Only lingering (positive z-score) contributes to hesitation.
        if (zScore > 0) {
          this.lastDwellAnomalyAt = now;
          this.lastDwellAnomalyZScore = zScore;
          this.lastDwellAnomalyState = state;
          this.maybeEmitHesitation();
        }
      }
    }
  }

  /**
   * Emit `hesitation_detected` when a `trajectory_anomaly` and a positive
   * `dwell_time_anomaly` have both fired within `hesitationCorrelationWindowMs`.
   * Called from both evaluateTrajectory and evaluateDwellTime after they update
   * their respective timestamps.
   *
   * `hesitation_detected.state` is always the dwell-anomaly state (where the user
   * lingered), regardless of which signal fires second.  This is consistent with
   * the interface docs and avoids the caller-provided value varying between the
   * two call sites.
   */
  private maybeEmitHesitation(): void {
    const now = this.timer.now();
    const correlated =
      now - this.lastTrajectoryAnomalyAt < this.hesitationCorrelationWindowMs &&
      now - this.lastDwellAnomalyAt < this.hesitationCorrelationWindowMs;

    if (!correlated) return;

    // Reset timestamps to prevent re-triggering until both signals fire again.
    this.lastTrajectoryAnomalyAt = -Infinity;
    this.lastDwellAnomalyAt = -Infinity;

    if (this.assignmentGroup !== 'control') {
      this.emitter.emit('hesitation_detected', {
        state: this.lastDwellAnomalyState,
        trajectoryZScore: this.lastTrajectoryAnomalyZScore,
        dwellZScore: this.lastDwellAnomalyZScore,
      });
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      this.timer.clearTimeout(this.persistTimer);
    }

    this.persistTimer = this.timer.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, this.persistDebounceMs);
  }

  private persist(): void {
    // Dirty-flag optimization: skip persistence if nothing changed
    if (!this.isDirty) {
      return;
    }

    // LFU prune before serializing — keeps storage bounded.
    // Wrap in try-finally so engineHealth is always restored even if prune() throws.
    this.engineHealth = 'pruning_active';
    try {
      this.graph.prune();
    } finally {
      this.engineHealth = 'healthy';
    }

    // Binary-encode the graph: avoids JSON.stringify on potentially
    // large objects, keeping the main thread free of heavy work.
    const graphBytes = this.graph.toBinary();

    // Convert Uint8Array → base64 string for localStorage compatibility.
    // Uses chunked String.fromCharCode to avoid O(n) string concatenation.
    const graphBinary = uint8ToBase64(graphBytes);

    // Build the minimal JSON envelope (two short strings, no deep trees).
    const payload: PersistedPayload = {
      bloomBase64: this.bloom.toBase64(),
      graphBinary,
    };

    if (this.asyncStorage) {
      // ── Async path ────────────────────────────────────────────────────────
      // Guard: if a write is already in flight, return early.  isDirty remains
      // true, so when the in-flight promise settles and the next schedulePersist
      // fires, the accumulated state will be saved.
      if (this.isAsyncWriting) return;

      this.isAsyncWriting = true;
      // Optimistically clear isDirty now that we've captured the current state
      // into `payload`.  If the write fails we restore the flag.
      this.isDirty = false;

      this.asyncStorage.setItem(this.storageKey, JSON.stringify(payload))
        .then(() => {
          this.isAsyncWriting = false;
        })
        .catch((err: unknown) => {
          this.isAsyncWriting = false;
          // Restore dirty flag so the data is retried on the next persist cycle.
          this.isDirty = true;
          if (err instanceof Error) {
            if (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota')) {
              this.engineHealth = 'quota_exceeded';
            }
            if (this.onError) {
              this.onError(err);
            }
          }
        });
    } else {
      // ── Sync path (existing behaviour, unchanged) ─────────────────────────
      try {
        this.storage.setItem(this.storageKey, JSON.stringify(payload));
        // Reset dirty flag after successful save
        this.isDirty = false;
      } catch (err) {
        // QuotaExceededError, SecurityError, or Private Browsing restrictions.
        // Surface through the optional error callback; never crash the main thread.
        if (err instanceof Error) {
          if (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota')) {
            this.engineHealth = 'quota_exceeded';
          }
          if (this.onError) {
            this.onError(err);
          }
        }
      }
    }
  }

  private restore(graphConfig: MarkovGraphConfig): { bloom: BloomFilter; graph: MarkovGraph } | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as PersistedPayload;
      if (!parsed.graphBinary) return null;

      const bloom = BloomFilter.fromBase64(parsed.bloomBase64);
      const bytes = base64ToUint8(parsed.graphBinary);
      const graph = MarkovGraph.fromBinary(bytes, graphConfig);

      return { bloom, graph };
    } catch {
      return null;
    }
  }
}
