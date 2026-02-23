/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Welford's online algorithm state for a single numeric stream.
 *
 * Maintains mean and variance in a single pass without storing the raw
 * samples, making it O(1) per update and O(1) in memory regardless of
 * session length.  All three fields are required to resume a running
 * computation (e.g. across persisted checkpoints).
 *
 * Reference: Welford, B.P. (1962), "Note on a method for calculating
 * corrected sums of squares and products", Technometrics 4(3):419–420.
 */
export interface DwellStats {
  /** Number of observations recorded so far. */
  count: number;
  /** Running arithmetic mean of dwell times in milliseconds. */
  meanMs: number;
  /**
   * Welford’s running sum of squared deviations from the mean.
   * Divide by `count` (biased) or `count - 1` (unbiased Bessel-corrected)
   * to obtain variance.  `dwellStd()` uses the biased estimator intentionally
   * because we care about the current session’s distribution, not an
   * unbiased population estimate.
   */
  m2: number;
}

/**
 * Update a `DwellStats` accumulator with a new observation using
 * Welford’s algorithm.  Creates a fresh accumulator if `current` is
 * undefined (i.e. first observation for a state).
 */
export function updateDwellStats(current: DwellStats | undefined, dwellMs: number): DwellStats {
  const previousCount = current?.count ?? 0;
  const previousMean = current?.meanMs ?? 0;
  const previousM2 = current?.m2 ?? 0;
  const count = previousCount + 1;
  const delta = dwellMs - previousMean;
  const meanMs = previousMean + delta / count;
  const delta2 = dwellMs - meanMs;
  const m2 = previousM2 + delta * delta2;
  return { count, meanMs, m2 };
}

/**
 * Biased population standard deviation derived from Welford state.
 * Returns 0 when fewer than 2 samples have been recorded (no meaningful
 * spread can be computed from a single data point).
 */
export function dwellStd(stats: DwellStats): number {
  if (stats.count < 2) return 0;
  return Math.sqrt(stats.m2 / stats.count);
}
