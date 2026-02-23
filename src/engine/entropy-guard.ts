/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

const BOT_DETECTION_WINDOW = 10;
const BOT_MIN_DELTA_MS = 50;
const BOT_MAX_VARIANCE = 100;
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

      if (variance >= 0 && variance < BOT_MAX_VARIANCE) {
        windowBotScore += 1;
      }
    }

    this.isSuspectedBot = windowBotScore >= BOT_SCORE_THRESHOLD;
  }
}
