/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Laplace smoothing epsilon used for log-likelihood calculations.
 * Must be identical between calibration (intent-sdk-performance) and runtime (IntentManager).
 */
export const SMOOTHING_EPSILON = 0.01;

/**
 * Minimum sliding window length before evaluating trajectory.
 * This "warm-up" allows the average log-likelihood to stabilize.
 * Must match the warm-up gate in IntentManager.evaluateTrajectory and
 * the calibration sampler in intent-sdk-performance.
 */
export const MIN_WINDOW_LENGTH = 16;

/**
 * Maximum sliding window length (recentTrajectory cap).
 * Used as reference for variance scaling.
 * Must match the recentTrajectory cap in IntentManager and the calibration
 * sampler in intent-sdk-performance.
 */
export const MAX_WINDOW_LENGTH = 32;

/**
 * Minimum number of outgoing transitions a state must have before entropy
 * evaluation is considered statistically meaningful.
 * Higher values prevent spurious entropy triggers on small samples.
 */
export const MIN_SAMPLE_TRANSITIONS = 10;

/**
 * Upper bound on any single dwell-time or hidden-duration measurement (30 minutes).
 *
 * CPU suspend, laptop sleep, and OS hibernation cause the monotonic clock to
 * jump by hours while the Page Visibility API reports the tab as hidden.  Any
 * raw delta that exceeds this threshold is almost certainly caused by the host
 * machine being suspended rather than genuine user behaviour and must never be
 * fed into the Welford variance accumulator or used to offset previousStateEnteredAt.
 *
 * When the threshold is breached the engine:
 *   1. Discards the inflated measurement — does NOT update Welford stats.
 *   2. Resets the dwell baseline to the current timestamp so the next
 *      measurement starts from a clean epoch.
 *   3. Emits a `session_stale` diagnostic event for host-app observability.
 */
export const MAX_PLAUSIBLE_DWELL_MS = 1_800_000; // 30 minutes
