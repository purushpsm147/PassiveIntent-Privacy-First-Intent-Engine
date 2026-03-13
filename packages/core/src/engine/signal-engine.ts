/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
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
import type { AnomalyEventEmitter, DriftProtectionPolicyLike } from './anomaly-dispatcher.js';
import { MIN_SAMPLE_TRANSITIONS, MIN_WINDOW_LENGTH, MAX_WINDOW_LENGTH } from './constants.js';
import type { PassiveIntentTelemetry } from '../types/events.js';
import { AnomalyDispatcher } from './anomaly-dispatcher.js';
import type {
  AnomalyDecision,
  EntropyDecision,
  TrajectoryDecision,
  DwellDecision,
} from './anomaly-decisions.js';

export { EventEmitter };

function getConfidence(sampleSize: number): 'low' | 'medium' | 'high' {
  if (sampleSize < 10) return 'low';
  if (sampleSize < 30) return 'medium';
  return 'high';
}
/**
 * Configuration surface for SignalEngine.
 * All values are resolved and defaulted by IntentManager before being passed in.
 */
export interface SignalEngineConfig {
  graph: MarkovGraph;
  baseline: MarkovGraph | null;
  timer: TimerAdapter;
  benchmark: BenchmarkRecorder;
  emitter: AnomalyEventEmitter;
  assignmentGroup: 'treatment' | 'control';
  eventCooldownMs: number;
  dwellTimeMinSamples: number;
  dwellTimeZScoreThreshold: number;
  hesitationCorrelationWindowMs: number;
  trajectorySmoothingEpsilon: number;
  /** Drift protection policy — owns the rolling evaluation window and drifted flag. */
  driftPolicy: DriftProtectionPolicyLike;
}

/**
 * SignalEngine — pure computation kernel for all anomaly signals.
 *
 * ## Responsibilities
 * Each public `evaluate*` method is a **pure evaluator**: it reads engine state
 * and returns a typed decision object (or `null`), but never emits events,
 * mutates cooldown timestamps, or touches telemetry counters.
 *
 * Owns:
 *   - `EntropyGuard` — bot-detection sliding window
 *   - Per-state Welford accumulators for dwell-time statistics
 *   - Session-scoped `transitionsEvaluated` counter
 *
 * ## What it does NOT own
 * All side-effects have been moved to `AnomalyDispatcher`, which is composed
 * internally and exposed through `dispatch()`:
 *   - Cooldown gating per event type
 *   - Holdout (control-group) suppression
 *   - `anomaliesFired` telemetry increment
 *   - Drift-protection `recordAnomaly()` calls
 *   - Emitter calls for `high_entropy`, `trajectory_anomaly`, `dwell_time_anomaly`
 *   - Hesitation correlation and `hesitation_detected` emission
 *
 * ## Usage pattern
 * ```ts
 * signalEngine.dispatch(signalEngine.evaluateEntropy(state));
 * signalEngine.dispatch(signalEngine.evaluateTrajectory(from, to, trajectory));
 * signalEngine.dispatch(signalEngine.evaluateDwellTime(state, dwellMs));
 * ```
 *
 * **Do not add side-effects to evaluator methods.**  If a new signal type
 * requires emission or shared-state mutation, add a new `evaluate*` that
 * returns a decision type and handle it inside `AnomalyDispatcher.dispatch()`.
 *
 * IntentManager passes already-resolved config values and read-only trajectory
 * slices into each evaluation method; no I/O occurs here.
 */
export class SignalEngine {
  private readonly graph: MarkovGraph;
  private readonly baseline: MarkovGraph | null;
  private readonly benchmark: BenchmarkRecorder;
  private readonly dwellTimeMinSamples: number;
  private readonly dwellTimeZScoreThreshold: number;
  private readonly trajectorySmoothingEpsilon: number;
  private readonly driftPolicy: DriftProtectionPolicyLike;

  /* Bot detection */
  private readonly entropyGuard = new EntropyGuard();

  /* Dwell-time Welford accumulators — session-scoped, never persisted */
  private readonly dwellStats = new Map<string, DwellStats>();

  /* Dispatcher — owns cooldown, hesitation, telemetry, and emitter side-effects */
  private readonly dispatcher: AnomalyDispatcher;

  /* Session-scoped transition counter */
  private transitionsEvaluatedInternal = 0;

  constructor(config: SignalEngineConfig) {
    this.graph = config.graph;
    this.baseline = config.baseline;
    this.benchmark = config.benchmark;
    this.dwellTimeMinSamples = config.dwellTimeMinSamples;
    this.dwellTimeZScoreThreshold = config.dwellTimeZScoreThreshold;
    this.trajectorySmoothingEpsilon = config.trajectorySmoothingEpsilon;
    this.driftPolicy = config.driftPolicy;

    this.dispatcher = new AnomalyDispatcher({
      emitter: config.emitter,
      timer: config.timer,
      assignmentGroup: config.assignmentGroup,
      eventCooldownMs: config.eventCooldownMs,
      hesitationCorrelationWindowMs: config.hesitationCorrelationWindowMs,
      driftPolicy: config.driftPolicy,
    });
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
    return this.dispatcher.anomaliesFired;
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
   * Increment the session-scoped transition counter.
   *
   * Bigram accounting was moved to `BigramPolicy.onTransition()` as part of
   * the policy refactor; this method's sole responsibility is updating the
   * `transitionsEvaluated` telemetry counter.
   */
  recordTransition(_from: string, _to: string, _trajectory: readonly string[]): void {
    this.transitionsEvaluatedInternal += 1;
    // Bigram accounting is now handled by BigramPolicy.onTransition().
  }

  /* ================================================================== */
  /*  Dispatch delegation                                               */
  /* ================================================================== */

  /**
   * Forward a decision produced by any evaluator to the AnomalyDispatcher.
   * Passing `null` is a safe no-op and is the common case when no anomaly
   * was detected.
   */
  dispatch(decision: AnomalyDecision | null): void {
    this.dispatcher.dispatch(decision);
  }

  /* ================================================================== */
  /*  Entropy Evaluation                                                  */
  /* ================================================================== */

  /**
   * Evaluate the entropy of the current state and return a decision when an
   * anomaly is detected, or `null` when the state is normal or below the
   * minimum-sample threshold.
   *
   * This method is a **pure evaluator**: it reads state but performs no
   * side-effects.  Call `dispatch(evaluateEntropy(state))` to apply
   * cooldown, holdout suppression, and emission.
   */
  evaluateEntropy(state: string): EntropyDecision | null {
    const start = this.benchmark.now();

    if (this.entropyGuard.suspected) {
      this.benchmark.record('entropyComputation', start);
      return null;
    }

    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) {
      this.benchmark.record('entropyComputation', start);
      return null;
    }

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);

    this.benchmark.record('entropyComputation', start);

    if (normalizedEntropy >= this.graph.highEntropyThreshold) {
      return { kind: 'high_entropy', payload: { state, entropy, normalizedEntropy } };
    }

    return null;
  }

  /* ================================================================== */
  /*  Trajectory Anomaly Detection                                        */
  /* ================================================================== */

  /**
   * Evaluate the current trajectory against the baseline graph and return a
   * `TrajectoryDecision` when a z-score (or raw LL) anomaly is detected, or
   * `null` when the trajectory is normal or any precondition is unmet.
   *
   * This method is a **pure evaluator**: it reads state but performs no
   * side-effects.  Drift accounting (`driftPolicy.recordAnomaly()`) is
   * intentionally deferred to `AnomalyDispatcher.dispatch()` where it is
   * applied *before* the cooldown check, preserving the original semantics.
   *
   * @param from       Departing state of the most recent transition.
   * @param to         Arriving state of the most recent transition.
   * @param trajectory Read-only snapshot of the sliding trajectory window.
   */
  evaluateTrajectory(
    from: string,
    to: string,
    trajectory: readonly string[],
  ): TrajectoryDecision | null {
    const start = this.benchmark.now();

    if (this.driftPolicy.isDrifted) {
      this.benchmark.record('divergenceComputation', start);
      return null;
    }

    if (this.entropyGuard.suspected) {
      this.benchmark.record('divergenceComputation', start);
      return null;
    }

    if (trajectory.length < MIN_WINDOW_LENGTH) {
      this.benchmark.record('divergenceComputation', start);
      return null;
    }

    if (!this.baseline) {
      this.benchmark.record('divergenceComputation', start);
      return null;
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

    this.benchmark.record('divergenceComputation', start);

    if (shouldEmit) {
      const sampleSize = this.graph.rowTotal(from);
      return {
        kind: 'trajectory_anomaly',
        payload: {
          stateFrom: from,
          stateTo: to,
          realLogLikelihood: real,
          expectedBaselineLogLikelihood: expected,
          zScore,
          sampleSize,
          confidence: getConfidence(sampleSize),
        },
      };
    }

    return null;
  }

  /* ================================================================== */
  /*  Dwell-Time Anomaly Detection                                        */
  /* ================================================================== */

  /**
   * Evaluate dwell time on the *previous* state via Welford's online algorithm
   * and return a `DwellDecision` when the z-score exceeds the configured
   * threshold, or `null` otherwise.
   *
   * The Welford accumulator is always updated regardless of whether a decision
   * is produced — this ensures the running mean/std improves with every sample.
   *
   * This method is a **pure evaluator** with one intentional statistical
   * side-effect: the per-state `dwellStats` accumulator is mutated so that
   * successive calls converge on accurate mean and standard-deviation estimates.
   * No events are emitted here.
   */
  evaluateDwellTime(state: string, dwellMs: number): DwellDecision | null {
    // Gating (dwellTimeEnabled) is handled by DwellTimePolicy; this method
    // is only called when the policy exists and has decided dwell should be
    // evaluated for this transition.
    if (dwellMs <= 0) return null;

    const updated = updateDwellStats(this.dwellStats.get(state), dwellMs);
    this.dwellStats.set(state, updated);

    if (updated.count < this.dwellTimeMinSamples) return null;

    const std = dwellStd(updated);
    if (std <= 0) return null;

    const zScore = (dwellMs - updated.meanMs) / std;

    if (Math.abs(zScore) >= this.dwellTimeZScoreThreshold) {
      const sampleSize = updated.count;
      return {
        kind: 'dwell_time_anomaly',
        payload: {
          state,
          dwellMs,
          meanMs: updated.meanMs,
          stdMs: std,
          zScore,
          sampleSize,
          confidence: getConfidence(sampleSize),
        },
        isPositiveZScore: zScore > 0,
      };
    }

    return null;
  }
}
