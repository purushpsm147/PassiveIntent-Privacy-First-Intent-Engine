/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Heuristic bot detector based on inter-event timing statistics.
 *
 * Two scoring criteria are evaluated over a sliding window of the last
 * `BOT_DETECTION_WINDOW` (10) `track()` call timestamps:
 *
 *   1. **Speed criterion** — each consecutive delta < `BOT_MIN_DELTA_MS` (50 ms)
 *      increments the score.  Real users rarely navigate faster than 50 ms
 *      per page; automation tools do it consistently.
 *
 *   2. **Variance criterion** — if the variance of all deltas in the window
 *      falls below `BOT_MAX_VARIANCE` (100 ms²), the score gains 1 extra point.
 *      Human timing has natural jitter; bots that pace calls with `setInterval`
 *      produce near-zero variance even if each individual call is plausible.
 *
 * The `isSuspectedBot` flag flips to `true` when the combined score ≥
 * `BOT_SCORE_THRESHOLD` (5) and stays `true` until enough slow, high-
 * variance calls push the score back below the threshold.
 *
 * **No false negatives by design:** if bot protection is disabled at the
 * `IntentManager` level, this class is never called.  When enabled, the
 * tradeoff is a small false-positive risk for users on very fast connections
 * or programmatic navigation (e.g. router `push()` in rapid succession).
 */

const BOT_DETECTION_WINDOW = 10;
/** Minimum realistic human inter-navigation delta in milliseconds. */
const BOT_MIN_DELTA_MS = 50;
/** Maximum variance (ms²) for the timing-uniformity criterion. */
const BOT_MAX_VARIANCE = 100;
/** Combined score threshold above which the session is classified as a bot. */
const BOT_SCORE_THRESHOLD = 5;

export class EntropyGuard {
  private isSuspectedBot = false;
  private readonly trackTimestamps: number[] = new Array(BOT_DETECTION_WINDOW).fill(0);
  private trackTimestampIndex = 0;
  private trackTimestampCount = 0;

  record(timestamp: number): { suspected: boolean; transitionedToBot: boolean } {
    this.trackTimestamps[this.trackTimestampIndex] = timestamp;
    this.trackTimestampIndex = (this.trackTimestampIndex + 1) % BOT_DETECTION_WINDOW;
    if (this.trackTimestampCount < BOT_DETECTION_WINDOW) {
      this.trackTimestampCount += 1;
    }

    const previous = this.isSuspectedBot;
    this.evaluate();
    return {
      suspected: this.isSuspectedBot,
      transitionedToBot: this.isSuspectedBot && !previous,
    };
  }

  get suspected(): boolean {
    return this.isSuspectedBot;
  }

  private evaluate(): void {
    const count = this.trackTimestampCount;
    if (count < 3) return;

    let windowBotScore = 0;
    const deltas: number[] = [];

    // Ring-buffer oldest entry: if the window is not yet full, oldest is index 0;
    // otherwise it's the slot that was written next (trackTimestampIndex wraps around).
    const oldestIndex = count < BOT_DETECTION_WINDOW
      ? 0
      : this.trackTimestampIndex;

    for (let i = 0; i < count - 1; i += 1) {
      const currIdx = (oldestIndex + i) % BOT_DETECTION_WINDOW;
      const nextIdx = (oldestIndex + i + 1) % BOT_DETECTION_WINDOW;
      const delta = this.trackTimestamps[nextIdx] - this.trackTimestamps[currIdx];
      deltas.push(delta);
      if (delta >= 0 && delta < BOT_MIN_DELTA_MS) {
        windowBotScore += 1;
      }
    }

    if (deltas.length >= 2) {
      let mean = 0;
      for (let i = 0; i < deltas.length; i += 1) {
        mean += deltas[i];
      }
      mean /= deltas.length;

      let variance = 0;
      for (let i = 0; i < deltas.length; i += 1) {
        const d = deltas[i] - mean;
        variance += d * d;
      }
      variance /= deltas.length;

      // variance is always ≥ 0 (sum of squares / count), so only the upper
      // bound matters: low variance means unnaturally regular timing.
      if (variance < BOT_MAX_VARIANCE) {
        windowBotScore += 1;
      }
    }

    this.isSuspectedBot = windowBotScore >= BOT_SCORE_THRESHOLD;
  }
}
