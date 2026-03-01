/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AnomalyDispatcher — the single point that converts evaluator decisions
 * into observable side-effects.
 *
 * Responsibilities:
 *   1. **Cooldown policy** — suppresses events that fire more frequently than
 *      `eventCooldownMs` per event type.
 *   2. **Holdout suppression** — events are never forwarded to the emitter
 *      when `assignmentGroup === 'control'`.
 *   3. **Telemetry accounting** — `anomaliesFired` is incremented once per
 *      dispatched decision that passes the cooldown gate.
 *   4. **Drift protection** — `driftPolicy.recordAnomaly()` is called for
 *      every `TrajectoryDecision` *before* the cooldown check, preserving the
 *      original semantics: drift accounting is done on the raw signal, not on
 *      the rate-limited emission.
 *   5. **Hesitation correlation** — bookkeeping timestamps are updated after a
 *      successful dispatch, and `hesitation_detected` is emitted whenever
 *      both a trajectory anomaly and a positive-z-score dwell anomaly fall
 *      within `hesitationCorrelationWindowMs`.
 *
 * All of the above were previously scattered across `SignalEngine`.  Moving
 * them here lets the evaluator methods return pure decision values and keeps
 * the dispatcher as the only component that touches the emitter or mutates
 * any session state.
 */

import type { EventEmitter } from './event-emitter.js';
import type { IntentEventMap } from '../types/events.js';
import type { TimerAdapter } from '../adapters.js';
import type { DriftProtectionPolicy } from './policies/drift-protection-policy.js';
import type { AnomalyDecision } from './anomaly-decisions.js';

/**
 * Structural view of the event emitter used by the dispatcher.
 *
 * This is intentionally minimal so that external consumers do not need access
 * to the concrete EventEmitter class, only to an object with the required
 * methods.
 */
export interface AnomalyEventEmitter {
  emit: EventEmitter<IntentEventMap>['emit'];
  on: EventEmitter<IntentEventMap>['on'];
  removeAll: EventEmitter<IntentEventMap>['removeAll'];
}

/**
 * Structural view of the drift-protection policy required by the dispatcher.
 */
export interface DriftProtectionPolicyLike {
  recordAnomaly: DriftProtectionPolicy['recordAnomaly'];
  readonly isDrifted: DriftProtectionPolicy['isDrifted'];
  readonly baselineStatus: DriftProtectionPolicy['baselineStatus'];
}

export interface AnomalyDispatcherConfig {
  emitter: AnomalyEventEmitter;
  timer: TimerAdapter;
  assignmentGroup: 'treatment' | 'control';
  eventCooldownMs: number;
  hesitationCorrelationWindowMs: number;
  driftPolicy: DriftProtectionPolicyLike;
}

export class AnomalyDispatcher {
  private readonly emitter: AnomalyEventEmitter;
  private readonly timer: TimerAdapter;
  private readonly assignmentGroup: 'treatment' | 'control';
  private readonly eventCooldownMs: number;
  private readonly hesitationCorrelationWindowMs: number;
  private readonly driftPolicy: DriftProtectionPolicyLike;

  /* Cooldown gating per event type */
  private readonly lastEmittedAt: Record<
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

  /* Session-scoped anomaly counter */
  private anomaliesFiredInternal = 0;

  constructor(config: AnomalyDispatcherConfig) {
    this.emitter = config.emitter;
    this.timer = config.timer;
    this.assignmentGroup = config.assignmentGroup;
    this.eventCooldownMs = config.eventCooldownMs;
    this.hesitationCorrelationWindowMs = config.hesitationCorrelationWindowMs;
    this.driftPolicy = config.driftPolicy;
  }

  /* ================================================================== */
  /*  Telemetry getter                                                   */
  /* ================================================================== */

  get anomaliesFired(): number {
    return this.anomaliesFiredInternal;
  }

  /* ================================================================== */
  /*  Dispatch                                                           */
  /* ================================================================== */

  /**
   * Apply cooldown policy, holdout suppression, telemetry increment, and all
   * emitter side-effects for a single evaluator decision.
   *
   * Passing `null` is a no-op and is the normal case when no anomaly was
   * detected on the current transition.
   *
   * @param decision - The decision returned by an evaluator, or `null`.
   */
  dispatch(decision: AnomalyDecision | null): void {
    if (decision === null) return;

    // ── Drift accounting (trajectory only, before cooldown) ─────────────────
    // Must mirror the original semantics: every detected trajectory anomaly
    // counts against the drift-protection window, regardless of whether the
    // event is actually emitted.
    if (decision.kind === 'trajectory_anomaly') {
      this.driftPolicy.recordAnomaly();
    }

    // ── Cooldown gate ─────────────────────────────────────────────────────────
    const now = this.timer.now();
    if (
      this.eventCooldownMs > 0 &&
      now - this.lastEmittedAt[decision.kind] < this.eventCooldownMs
    ) {
      return;
    }

    // ── Update cooldown timestamp ─────────────────────────────────────────────
    this.lastEmittedAt[decision.kind] = now;

    // ── Telemetry increment ───────────────────────────────────────────────────
    this.anomaliesFiredInternal += 1;

    // ── Holdout suppression + emission ───────────────────────────────────────
    if (this.assignmentGroup !== 'control') {
      if (decision.kind === 'high_entropy') {
        this.emitter.emit('high_entropy', decision.payload);
      } else if (decision.kind === 'trajectory_anomaly') {
        this.emitter.emit('trajectory_anomaly', decision.payload);
      } else {
        this.emitter.emit('dwell_time_anomaly', decision.payload);
      }
    }

    // ── Hesitation correlation bookkeeping ────────────────────────────────────
    if (decision.kind === 'trajectory_anomaly') {
      this.lastTrajectoryAnomalyAt = now;
      this.lastTrajectoryAnomalyZScore = decision.payload.zScore;
      this.maybeEmitHesitation();
    } else if (decision.kind === 'dwell_time_anomaly' && decision.isPositiveZScore) {
      this.lastDwellAnomalyAt = now;
      this.lastDwellAnomalyZScore = decision.payload.zScore;
      this.lastDwellAnomalyState = decision.payload.state;
      this.maybeEmitHesitation();
    }
  }

  /* ================================================================== */
  /*  Hesitation Correlation (private)                                  */
  /* ================================================================== */

  private maybeEmitHesitation(): void {
    const now = this.timer.now();
    const correlated =
      now - this.lastTrajectoryAnomalyAt < this.hesitationCorrelationWindowMs &&
      now - this.lastDwellAnomalyAt < this.hesitationCorrelationWindowMs;

    if (!correlated) return;

    // Consume both timestamps so the same pair cannot trigger twice.
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
