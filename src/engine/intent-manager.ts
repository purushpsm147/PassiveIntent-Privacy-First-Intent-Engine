/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BenchmarkRecorder } from '../performance-instrumentation.js';
import type { BenchmarkConfig, PerformanceReport } from '../performance-instrumentation.js';
import { BrowserStorageAdapter, BrowserTimerAdapter } from '../adapters.js';
import type { StorageAdapter, TimerAdapter, TimerHandle } from '../adapters.js';
import { base64ToUint8, uint8ToBase64 } from '../persistence/codec.js';
import { BloomFilter } from '../core/bloom.js';
import { MarkovGraph } from '../core/markov.js';
import { EntropyGuard } from './entropy-guard.js';
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
  private readonly timer: TimerAdapter;
  private readonly onError?: (err: Error) => void;
  private readonly botProtection: boolean;
  private readonly eventCooldownMs: number;

  /* Dwell-time anomaly detection */
  private readonly dwellTimeEnabled: boolean;
  private readonly dwellTimeMinSamples: number;
  private readonly dwellTimeZScoreThreshold: number;
  /**
   * Per-state Welford accumulators: [count, mean, m2].
   *
   * **Session-scoped — intentionally not persisted.**
   * Persisting per-state timing distributions across page reloads would
   * meaningfully increase the cross-session fingerprinting surface area,
   * which conflicts with the library's privacy-first design goal.
   * As a result, the learning phase (governed by `minSamples`) restarts
   * on every new `IntentManager` instance.  Increase `minSamples` if
   * short sessions cause excessive false positives.
   */
  private readonly dwellStats = new Map<string, [number, number, number]>();

  /* Selective bigram (2nd-order) Markov */
  private readonly enableBigrams: boolean;
  private readonly bigramFrequencyThreshold: number;

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

  /* EntropyGuard: bot detection state */
  private readonly entropyGuard = new EntropyGuard();

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

  constructor(config: IntentManagerConfig = {}) {
    this.storageKey = config.storageKey ?? 'edge-signal';
    this.persistDebounceMs = config.persistDebounceMs ?? 2000;
    this.benchmark = new BenchmarkRecorder(config.benchmark);
    this.storage = config.storage ?? new BrowserStorageAdapter();
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

    // Telemetry: generate a short-lived, local-only session ID.
    // globalThis.crypto.randomUUID() is available in all modern browsers and
    // Node ≥ 19 (unflagged). Node 14.17–18 exposed randomUUID() only via the
    // built-in 'crypto' module (require('crypto')), NOT as a global, so those
    // runtimes will correctly fall back to the Math.random path below.
    this.sessionId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    const graphConfig: MarkovGraphConfig = {
      ...config.graph,
      baselineMeanLL: config.baselineMeanLL ?? config.graph?.baselineMeanLL,
      baselineStdLL: config.baselineStdLL ?? config.graph?.baselineStdLL,
    };

    const restored = this.restore(graphConfig);

    this.bloom = restored?.bloom ?? new BloomFilter(config.bloom);
    this.graph = restored?.graph ?? new MarkovGraph(graphConfig);
    this.baseline = config.baseline ? MarkovGraph.fromJSON(config.baseline, graphConfig) : null;

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
   * Track a page view or custom state transition.
   */
  track(state: string): void {
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
        if (this.graph.rowTotal(ctx.from) >= this.bigramFrequencyThreshold) {
          this.graph.incrementTransition(bigramFrom, bigramTo);
        }
      }

      this.isDirty = true;
      this.evaluateEntropy(ctx.state);
      this.evaluateTrajectory(ctx.from, ctx.state);
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
        this.emitter.emit('high_entropy', {
          state,
          entropy,
          normalizedEntropy,
        });
      }
    }

    this.benchmark.record('entropyComputation', start);
  }

  private evaluateTrajectory(from: string, to: string): void {
    const start = this.benchmark.now();

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
        this.emitter.emit('trajectory_anomaly', {
          stateFrom: from,
          stateTo: to,
          realLogLikelihood: real,
          expectedBaselineLogLikelihood: expected,
          zScore,
        });
        this.lastTrajectoryAnomalyAt = now;
        this.lastTrajectoryAnomalyZScore = zScore;
        this.maybeEmitHesitation();
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

    // Retrieve or initialise the Welford accumulator: [count, mean, m2]
    let stats = this.dwellStats.get(state);
    if (!stats) {
      stats = [0, 0, 0];
      this.dwellStats.set(state, stats);
    }

    // Welford online update
    stats[0] += 1;                            // count
    const delta = dwellMs - stats[1];
    stats[1] += delta / stats[0];             // mean
    const delta2 = dwellMs - stats[1];
    stats[2] += delta * delta2;               // m2

    // Need enough samples for a meaningful standard deviation
    if (stats[0] < this.dwellTimeMinSamples) return;

    const variance = stats[2] / stats[0];     // population variance
    const std = Math.sqrt(variance);

    // Guard: if std is zero (all identical dwell times) skip
    if (std <= 0) return;

    const zScore = (dwellMs - stats[1]) / std;

    if (Math.abs(zScore) >= this.dwellTimeZScoreThreshold) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.dwell_time_anomaly >= this.eventCooldownMs) {
        this.lastEmittedAt.dwell_time_anomaly = now;
        this.anomaliesFired += 1;
        this.emitter.emit('dwell_time_anomaly', {
          state,
          dwellMs,
          meanMs: stats[1],
          stdMs: std,
          zScore,
        });
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

    this.emitter.emit('hesitation_detected', {
      state: this.lastDwellAnomalyState,
      trajectoryZScore: this.lastTrajectoryAnomalyZScore,
      dwellZScore: this.lastDwellAnomalyZScore,
    });
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

  private restore(graphConfig: MarkovGraphConfig): { bloom: BloomFilter; graph: MarkovGraph } | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as PersistedPayload;
      if (!parsed.graphBinary) return null;

      const bloom = BloomFilter.fromBase64(parsed.bloomBase64);
      const binaryStr = atob(parsed.graphBinary);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i += 1) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const graph = MarkovGraph.fromBinary(bytes, graphConfig);

      return { bloom, graph };
    } catch {
      return null;
    }
  }
}
