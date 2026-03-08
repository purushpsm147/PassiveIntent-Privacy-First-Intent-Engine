/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Anomaly decision objects — pure domain values returned by the three
 * evaluator methods in SignalEngine.
 *
 * Each decision carries every field that the downstream dispatcher needs to:
 *   - Apply cooldown policy
 *   - Apply holdout suppression
 *   - Increment telemetry counters
 *   - Emit the corresponding IntentEventMap event
 *   - Update hesitation-correlation bookkeeping
 *
 * Decisions are plain value objects; they have no behaviour and perform no
 * side-effects.  The AnomalyDispatcher is the *only* component allowed to act
 * on them.
 */

import type {
  HighEntropyPayload,
  TrajectoryAnomalyPayload,
  DwellTimeAnomalyPayload,
} from '../types/events.js';

/** Decision produced when the entropy evaluator detects a high-entropy state. */
export interface EntropyDecision {
  readonly kind: 'high_entropy';
  /** Full event payload — identical to what is forwarded to the emitter. */
  readonly payload: HighEntropyPayload;
}

/**
 * Decision produced when the trajectory evaluator detects a trajectory anomaly.
 *
 * Note: drift-protection accounting (`driftPolicy.recordAnomaly()`) must occur
 * for every `TrajectoryDecision` that reaches the dispatcher, *before* the
 * cooldown check.  The dispatcher is responsible for this call.
 */
export interface TrajectoryDecision {
  readonly kind: 'trajectory_anomaly';
  /** Full event payload — identical to what is forwarded to the emitter. */
  readonly payload: TrajectoryAnomalyPayload;
}

/**
 * Decision produced when the dwell-time evaluator detects an anomalous dwell.
 *
 * `isPositiveZScore` is a pre-computed flag that saves the dispatcher from
 * inspecting `payload.zScore` directly; it is `true` when `zScore > 0`
 * (above-average dwell), which is the condition that drives hesitation
 * correlation bookkeeping.
 */
export interface DwellDecision {
  readonly kind: 'dwell_time_anomaly';
  /** Full event payload — identical to what is forwarded to the emitter. */
  readonly payload: DwellTimeAnomalyPayload;
  /**
   * Set to `true` when `payload.zScore > 0`.
   * The dispatcher uses this flag to update hesitation-correlation state
   * without re-inspecting the z-score itself.
   */
  readonly isPositiveZScore: boolean;
}

/** Discriminated union of all three anomaly evaluator decisions. */
export type AnomalyDecision = EntropyDecision | TrajectoryDecision | DwellDecision;
