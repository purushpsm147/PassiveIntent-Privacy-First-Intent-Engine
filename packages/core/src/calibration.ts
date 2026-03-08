/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Result returned by {@link runCalibration}.
 */
export interface CalibrationResult {
  /** Mean log-likelihood across all sampled sessions. Pass as `baselineMeanLL`. */
  baselineMeanLL: number;
  /** Standard deviation of log-likelihood across all sampled sessions. Pass as `baselineStdLL`. */
  baselineStdLL: number;
  /** Number of sessions included in the calibration run. */
  sampleSize: number;
  /** 5th-percentile log-likelihood — useful as a hard anomaly floor. */
  p5: number;
  /** 95th-percentile log-likelihood — confirms the upper bound of normal sessions. */
  p95: number;
}

/**
 * Compute calibration parameters from a representative sample of per-session
 * log-likelihood scores.
 *
 * Feed the raw log-likelihood values collected from at least 500 production
 * sessions into this function and pass the output directly to `IntentManager`
 * (or `usePassiveIntent`) as `baselineMeanLL` and `baselineStdLL`.
 *
 * @example
 * ```ts
 * import { runCalibration } from '@passiveintent/core/calibration';
 *
 * const result = runCalibration(sessionLogs);
 * // { baselineMeanLL: -3.47, baselineStdLL: 0.91, sampleSize: 1243, p5: -5.12, p95: -1.83 }
 *
 * const intent = new IntentManager({
 *   storageKey: 'my-app',
 *   baselineMeanLL: result.baselineMeanLL,
 *   baselineStdLL:  result.baselineStdLL,
 * });
 * ```
 *
 * @param sessionLogs - Array of per-session log-likelihood scores (negative numbers).
 *                      Must contain at least 1 value.
 * @throws {RangeError} When `sessionLogs` is empty.
 */
export function runCalibration(sessionLogs: number[]): CalibrationResult {
  if (sessionLogs.length === 0) {
    throw new RangeError('runCalibration: sessionLogs must contain at least one value.');
  }

  const sampleSize = sessionLogs.length;

  // Mean (single pass)
  let sum = 0;
  for (const v of sessionLogs) sum += v;
  const baselineMeanLL = sum / sampleSize;

  // Population standard deviation (second pass for numerical stability)
  let sumSq = 0;
  for (const v of sessionLogs) {
    const diff = v - baselineMeanLL;
    sumSq += diff * diff;
  }
  const baselineStdLL = Math.sqrt(sumSq / sampleSize);

  // Percentiles via sorted copy
  const sorted = sessionLogs.slice().sort((a, b) => a - b);

  function percentile(p: number): number {
    const idx = (p / 100) * (sampleSize - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const frac = idx - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  }

  return {
    baselineMeanLL,
    baselineStdLL,
    sampleSize,
    p5: percentile(5),
    p95: percentile(95),
  };
}
