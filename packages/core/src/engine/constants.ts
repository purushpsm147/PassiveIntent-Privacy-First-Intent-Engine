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

/**
 * Minimum tab-hidden duration before the engine considers the user a
 * "comparison shopper" and emits an `attention_return` event on resume.
 *
 * 15 seconds is long enough to filter out quick alt-tab / notification
 * glances while capturing users who navigated to a competitor tab.
 */
export const ATTENTION_RETURN_THRESHOLD_MS = 15_000; // 15 seconds

/**
 * Duration of user inactivity (no mouse, keyboard, scroll, or touch events)
 * before the engine considers the user idle and emits a `user_idle` event.
 *
 * 2 minutes is a conservative default that avoids false positives from short
 * pauses (reading long content, watching embedded video) while still catching
 * users who genuinely walked away from their device.
 */
export const USER_IDLE_THRESHOLD_MS = 120_000; // 2 minutes

/**
 * Interval between successive idle-state checks inside the LifecycleCoordinator.
 *
 * A 5-second polling cadence keeps CPU overhead negligible while ensuring the
 * `user_idle` event fires within 5 seconds of the actual threshold crossing.
 */
export const IDLE_CHECK_INTERVAL_MS = 5_000; // 5 seconds
