/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { EnginePolicy } from './engine-policy.js';
import type { PassiveIntentTelemetry } from '../../types/events.js';

/**
 * DriftProtectionPolicy — failsafe killswitch that silences trajectory
 * evaluation when the anomaly rate exceeds a configurable threshold.
 *
 * Replaces the following state that was previously scattered across
 * `SignalEngine`:
 *   - `isBaselineDriftedInternal` flag
 *   - `driftWindowStart`, `driftWindowTrackCount`, `driftWindowAnomalyCount`
 *   - `advanceDriftWindow(now)` method
 *   - Drift anomaly counting inside `evaluateTrajectory()`
 *   - `baselineStatus` / `isBaselineDrifted` getters
 *
 * Lifecycle:
 *   1. `onTrackStart(now)` is called once per `track()` to advance the
 *      rolling evaluation window.
 *   2. `SignalEngine.evaluateTrajectory()` checks `isDrifted` to decide
 *      whether to skip evaluation, and calls `recordAnomaly()` when a
 *      trajectory anomaly is detected.
 */
export class DriftProtectionPolicy implements EnginePolicy {
  private readonly maxAnomalyRate: number;
  private readonly evaluationWindowMs: number;

  private drifted = false;
  private windowStart = 0;
  private windowTrackCount = 0;
  private windowAnomalyCount = 0;

  constructor(maxAnomalyRate: number, evaluationWindowMs: number) {
    this.maxAnomalyRate = maxAnomalyRate;
    this.evaluationWindowMs = evaluationWindowMs;
  }

  /* ── EnginePolicy hook ──────────────────────────────────────────────── */

  /**
   * Advance the rolling evaluation window.  Resets counters when the window
   * elapses.  O(1), no allocations.
   */
  onTrackStart(now: number): void {
    if (now - this.windowStart >= this.evaluationWindowMs) {
      this.windowStart = now;
      this.windowTrackCount = 0;
      this.windowAnomalyCount = 0;
    }
    this.windowTrackCount += 1;
  }

  /* ── Queried by SignalEngine ────────────────────────────────────────── */

  /** `true` once the anomaly rate has breached the threshold in any window. */
  get isDrifted(): boolean {
    return this.drifted;
  }

  /** Telemetry-friendly status label. */
  get baselineStatus(): PassiveIntentTelemetry['baselineStatus'] {
    return this.drifted ? 'drifted' : 'active';
  }

  /**
   * Called by `SignalEngine.evaluateTrajectory()` each time a trajectory
   * anomaly is detected (regardless of cooldown gating).  Increments the
   * window anomaly counter and flips the `drifted` flag when the rate
   * exceeds `maxAnomalyRate`.
   */
  recordAnomaly(): void {
    this.windowAnomalyCount += 1;
    if (
      this.windowTrackCount > 0 &&
      this.windowAnomalyCount / this.windowTrackCount > this.maxAnomalyRate
    ) {
      this.drifted = true;
    }
  }
}
