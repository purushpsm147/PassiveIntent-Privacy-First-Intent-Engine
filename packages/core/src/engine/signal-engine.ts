/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { BenchmarkRecorder } from '../performance-instrumentation.js';
import type { TimerAdapter } from '../adapters.js';
import { MarkovGraph } from '../core/markov.js';
import { EntropyGuard } from './entropy-guard.js';
import { dwellStd, updateDwellStats } from './dwell.js';
import type { DwellStats } from './dwell.js';
import { EventEmitter } from './event-emitter.js';
import type { IntentEventMap } from '../types/events.js';
import { MIN_SAMPLE_TRANSITIONS, MIN_WINDOW_LENGTH, MAX_WINDOW_LENGTH } from './constants.js';
import type { PassiveIntentTelemetry } from '../types/events.js';
import type { DriftProtectionPolicy } from './policies/drift-protection-policy.js';

/**
 * Configuration surface for SignalEngine.
 * All values are resolved and defaulted by IntentManager before being passed in.
 */
export interface SignalEngineConfig {
  graph: MarkovGraph;
  baseline: MarkovGraph | null;
  timer: TimerAdapter;
  benchmark: BenchmarkRecorder;
  emitter: EventEmitter<IntentEventMap>;
  assignmentGroup: 'treatment' | 'control';
  eventCooldownMs: number;
  dwellTimeMinSamples: number;
  dwellTimeZScoreThreshold: number;
  hesitationCorrelationWindowMs: number;
  trajectorySmoothingEpsilon: number;
  /** Drift protection policy — owns the rolling evaluation window and drifted flag. */
  driftPolicy: DriftProtectionPolicy;
}

/**
 * SignalEngine — isolated computation kernel for all anomaly signals.
 *
 * Owns:
 *   - EntropyGuard (bot detection state)
 *   - Per-state Welford accumulators for dwell-time anomaly detection
 *   - Cooldown timestamps for all three gated event types
 *   - Hesitation correlation timestamps
 *   - Drift-protection rolling window counters
 *   - Session-scoped telemetry counters (transitionsEvaluated, anomaliesFired)
 *
 * IntentManager passes already-resolved config values and read-only trajectory
 * slices into each evaluation method; no I/O, no side-effects beyond emitting
 * events through the shared EventEmitter.
 */
export class SignalEngine {
  private readonly graph: MarkovGraph;
  private readonly baseline: MarkovGraph | null;
  private readonly timer: TimerAdapter;
  private readonly benchmark: BenchmarkRecorder;
  private readonly emitter: EventEmitter<IntentEventMap>;
  private readonly assignmentGroup: 'treatment' | 'control';
  private readonly eventCooldownMs: number;
  private readonly dwellTimeMinSamples: number;
  private readonly dwellTimeZScoreThreshold: number;
  private readonly hesitationCorrelationWindowMs: number;
  private readonly trajectorySmoothingEpsilon: number;
  private readonly driftPolicy: DriftProtectionPolicy;

  /* Bot detection */
  private readonly entropyGuard = new EntropyGuard();

  /* Dwell-time Welford accumulators — session-scoped, never persisted */
  private readonly dwellStats = new Map<string, DwellStats>();

  /* Cooldown gating per event type */
  private lastEmittedAt: Record<
    'high_entropy' | 'trajectory_anomaly' | 'dwell_time_anomaly',
    number
  > = {
    high_entropy: -Infinity,
    trajectory_anomaly: -Infinity,
    dwell_time_anomaly: -Infinity,
  };

  /* Hesitation correlation state */
  private lastTrajectoryAnomalyAt = -Infinity;
  private lastTrajectoryAnomalyZScore = 0;
  private lastDwellAnomalyAt = -Infinity;
  private lastDwellAnomalyZScore = 0;
  private lastDwellAnomalyState = '';

  /* Session-scoped telemetry counters */
  private transitionsEvaluatedInternal = 0;
  private anomaliesFiredInternal = 0;

  constructor(config: SignalEngineConfig) {
    this.graph = config.graph;
    this.baseline = config.baseline;
    this.timer = config.timer;
    this.benchmark = config.benchmark;
    this.emitter = config.emitter;
    this.assignmentGroup = config.assignmentGroup;
    this.eventCooldownMs = config.eventCooldownMs;
    this.dwellTimeMinSamples = config.dwellTimeMinSamples;
    this.dwellTimeZScoreThreshold = config.dwellTimeZScoreThreshold;
    this.hesitationCorrelationWindowMs = config.hesitationCorrelationWindowMs;
    this.trajectorySmoothingEpsilon = config.trajectorySmoothingEpsilon;
    this.driftPolicy = config.driftPolicy;
  }

  /* ================================================================== */
  /*  Telemetry Getters                                                  */
  /* ================================================================== */

  get suspected(): boolean {
    return this.entropyGuard.suspected;
  }

  get transitionsEvaluated(): number {
    return this.transitionsEvaluatedInternal;
  }

  get anomaliesFired(): number {
    return this.anomaliesFiredInternal;
  }

  get isBaselineDrifted(): boolean {
    return this.driftPolicy.isDrifted;
  }

  get baselineStatus(): PassiveIntentTelemetry['baselineStatus'] {
    return this.driftPolicy.baselineStatus;
  }

  /* ================================================================== */
  /*  Bot Protection                                                      */
  /* ================================================================== */

  /**
   * Record a `track()` timestamp into the EntropyGuard and return bot state.
   * If the guard transitions to suspected-bot, IntentManager emits `bot_detected`.
   */
  recordBotCheck(now: number): { suspected: boolean; transitionedToBot: boolean } {
    return this.entropyGuard.record(now);
  }

  /* ================================================================== */
  /*  Transition Accounting                                               */
  /* ================================================================== */

  /**
   * Increment the session-scoped transition counter and optionally record
   * a bigram edge in the graph.
   *
   * @param from           Departing state.
   * @param to             Arriving state.
   * @param trajectory     Snapshot of `recentTrajectory` at time of call.
   */
  recordTransition(_from: string, _to: string, _trajectory: readonly string[]): void {
    this.transitionsEvaluatedInternal += 1;
    // Bigram accounting is now handled by BigramPolicy.onTransition().
  }

  /* ================================================================== */
  /*  Entropy Evaluation                                                  */
  /* ================================================================== */

  evaluateEntropy(state: string): void {
    const start = this.benchmark.now();

    if (this.entropyGuard.suspected) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);

    if (normalizedEntropy >= this.graph.highEntropyThreshold) {
      const now = this.timer.now();
      if (
        this.eventCooldownMs <= 0 ||
        now - this.lastEmittedAt.high_entropy >= this.eventCooldownMs
      ) {
        this.lastEmittedAt.high_entropy = now;
        this.anomaliesFiredInternal += 1;
        if (this.assignmentGroup !== 'control') {
          this.emitter.emit('high_entropy', { state, entropy, normalizedEntropy });
        }
      }
    }

    this.benchmark.record('entropyComputation', start);
  }

  /* ================================================================== */
  /*  Trajectory Anomaly Detection                                        */
  /* ================================================================== */

  /**
   * Evaluate the current trajectory against the baseline graph and emit
   * `trajectory_anomaly` when the z-score (or raw LL) crosses the threshold.
   *
   * @param from       Departing state of the most recent transition.
   * @param to         Arriving state of the most recent transition.
   * @param trajectory Read-only snapshot of the sliding trajectory window.
   */
  evaluateTrajectory(from: string, to: string, trajectory: readonly string[]): void {
    const start = this.benchmark.now();

    if (this.driftPolicy.isDrifted) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    if (this.entropyGuard.suspected) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    if (trajectory.length < MIN_WINDOW_LENGTH) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    if (!this.baseline) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    const real = MarkovGraph.logLikelihoodTrajectory(
      this.graph,
      trajectory,
      this.trajectorySmoothingEpsilon,
    );
    const expected = MarkovGraph.logLikelihoodTrajectory(
      this.baseline,
      trajectory,
      this.trajectorySmoothingEpsilon,
    );

    const N = Math.max(1, trajectory.length - 1);
    const expectedAvg = expected / N;
    const threshold = -Math.abs(this.graph.divergenceThreshold);

    const hasCalibratedBaseline =
      typeof this.graph.baselineMeanLL === 'number' &&
      typeof this.graph.baselineStdLL === 'number' &&
      Number.isFinite(this.graph.baselineMeanLL) &&
      Number.isFinite(this.graph.baselineStdLL) &&
      this.graph.baselineStdLL > 0;

    const adjustedStd = hasCalibratedBaseline
      ? this.graph.baselineStdLL * Math.sqrt(MAX_WINDOW_LENGTH / N)
      : 0;

    const zScore = hasCalibratedBaseline
      ? (expectedAvg - this.graph.baselineMeanLL) / adjustedStd
      : expectedAvg;

    const shouldEmit = hasCalibratedBaseline ? zScore <= threshold : expectedAvg <= threshold;

    if (shouldEmit) {
      // Count every anomaly toward drift protection, regardless of cooldown.
      // Drift is a property of the underlying signal, not of how often we emit.
      this.driftPolicy.recordAnomaly();

      const now = this.timer.now();
      if (
        this.eventCooldownMs <= 0 ||
        now - this.lastEmittedAt.trajectory_anomaly >= this.eventCooldownMs
      ) {
        this.lastEmittedAt.trajectory_anomaly = now;
        this.anomaliesFiredInternal += 1;
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
      }
    }

    this.benchmark.record('divergenceComputation', start);
  }

  /* ================================================================== */
  /*  Dwell-Time Anomaly Detection                                        */
  /* ================================================================== */

  /**
   * Evaluate dwell time on the *previous* state via Welford's online algorithm.
   * Fires `dwell_time_anomaly` when the z-score exceeds the configured threshold.
   */
  evaluateDwellTime(state: string, dwellMs: number): void {
    // Gating (dwellTimeEnabled) is handled by DwellTimePolicy; this method
    // is only called when the policy exists and has decided dwell should be
    // evaluated for this transition.
    if (dwellMs <= 0) return;

    const updated = updateDwellStats(this.dwellStats.get(state), dwellMs);
    this.dwellStats.set(state, updated);

    if (updated.count < this.dwellTimeMinSamples) return;

    const std = dwellStd(updated);
    if (std <= 0) return;

    const zScore = (dwellMs - updated.meanMs) / std;

    if (Math.abs(zScore) >= this.dwellTimeZScoreThreshold) {
      const now = this.timer.now();
      if (
        this.eventCooldownMs <= 0 ||
        now - this.lastEmittedAt.dwell_time_anomaly >= this.eventCooldownMs
      ) {
        this.lastEmittedAt.dwell_time_anomaly = now;
        this.anomaliesFiredInternal += 1;
        if (this.assignmentGroup !== 'control') {
          this.emitter.emit('dwell_time_anomaly', {
            state,
            dwellMs,
            meanMs: updated.meanMs,
            stdMs: std,
            zScore,
          });
        }
        if (zScore > 0) {
          this.lastDwellAnomalyAt = now;
          this.lastDwellAnomalyZScore = zScore;
          this.lastDwellAnomalyState = state;
          this.maybeEmitHesitation();
        }
      }
    }
  }

  /* ================================================================== */
  /*  Hesitation                                                          */
  /* ================================================================== */

  private maybeEmitHesitation(): void {
    const now = this.timer.now();
    const correlated =
      now - this.lastTrajectoryAnomalyAt < this.hesitationCorrelationWindowMs &&
      now - this.lastDwellAnomalyAt < this.hesitationCorrelationWindowMs;

    if (!correlated) return;

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
}
