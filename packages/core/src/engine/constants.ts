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
