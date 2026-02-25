/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { base64ToUint8, uint8ToBase64 } from '../persistence/codec.js';
import type { BloomFilterConfig } from '../types/events.js';

/**
 * FNV-1a hash with a configurable seed.
 *
 * Used in a Kirsch-Mitzenmacher double-hashing scheme:
 *   h_i(x) = (h1(x) + i * h2(x)) mod m
 *
 * Two independent hashes (h1 via seed 0x811c9dc5, h2 via seed 0x01000193)
 * are combined to derive `hashCount` virtual hash functions with a single
 * pair of underlying hash calls.  This avoids computing k distinct hash
 * functions while preserving near-optimal false-positive rates.
 * Reference: Kirsch & Mitzenmacher (2006), "Less Hashing, Same Performance".
 */
function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

/**
 * Space-efficient probabilistic set membership test.
 *
 * Guarantees no false negatives (anything added will always be found).
 * Allows tunable false positives — use `computeOptimal` to size the filter
 * for a target FPR given an expected item count.
 *
 * The bit array can be serialized to base64 via `toBase64()` and restored
 * via `fromBase64()`, enabling persistence across sessions without storing
 * the raw state strings (privacy-preserving by design).
 */
export class BloomFilter {
  readonly bitSize: number;
  readonly hashCount: number;
  private readonly bits: Uint8Array;

  /**
   * @param config    Optional sizing parameters (bitSize, hashCount).
   * @param existingBits  Pre-populated bit array from a prior `toBase64()` round-trip.
   *                      Must match the expected `byteSize` derived from `bitSize` or
   *                      it will be silently discarded and a fresh array allocated.
   */
  constructor(config: BloomFilterConfig = {}, existingBits?: Uint8Array) {
    this.bitSize = config.bitSize ?? 2048;
    this.hashCount = config.hashCount ?? 4;

    const byteSize = Math.ceil(this.bitSize / 8);
    this.bits =
      existingBits && existingBits.length === byteSize ? existingBits : new Uint8Array(byteSize);
  }

  add(item: string): void {
    const h1 = fnv1a(item, 0x811c9dc5);
    const h2 = fnv1a(item, 0x01000193);
    for (let i = 0; i < this.hashCount; i += 1) {
      const index = ((h1 + i * h2) >>> 0) % this.bitSize;
      this.setBit(index);
    }
  }

  check(item: string): boolean {
    const h1 = fnv1a(item, 0x811c9dc5);
    const h2 = fnv1a(item, 0x01000193);
    for (let i = 0; i < this.hashCount; i += 1) {
      const index = ((h1 + i * h2) >>> 0) % this.bitSize;
      if (!this.getBit(index)) return false;
    }
    return true;
  }

  /**
   * Compute the optimal filter size for a given load and false-positive rate.
   *
   * Formulas (standard Bloom filter theory):
   *   m = ceil( -n * ln(p) / ln(2)^2 )   — optimal bit count
   *   k = max(1, round( (m/n) * ln(2) ))  — optimal hash function count
   *
   * where n = expectedItems, p = targetFPR.
   */
  static computeOptimal(
    expectedItems: number,
    targetFPR: number,
  ): { bitSize: number; hashCount: number } {
    if (expectedItems <= 0) return { bitSize: 8, hashCount: 1 };
    if (targetFPR <= 0) targetFPR = 1e-10;
    if (targetFPR >= 1) targetFPR = 0.99;

    const ln2 = Math.LN2;
    const ln2Sq = ln2 * ln2;

    const m = Math.ceil(-(expectedItems * Math.log(targetFPR)) / ln2Sq);
    const k = Math.max(1, Math.round((m / expectedItems) * ln2));

    return { bitSize: m, hashCount: k };
  }

  estimateCurrentFPR(insertedItemsCount: number): number {
    if (insertedItemsCount <= 0) return 0;
    const exponent = -(this.hashCount * insertedItemsCount) / this.bitSize;
    const bitZeroProbability = Math.exp(exponent);
    return Math.pow(1 - bitZeroProbability, this.hashCount);
  }

  getBitsetByteSize(): number {
    return this.bits.byteLength;
  }

  toBase64(): string {
    return uint8ToBase64(this.bits);
  }

  static fromBase64(base64: string, config: BloomFilterConfig = {}): BloomFilter {
    return new BloomFilter(config, base64ToUint8(base64));
  }

  private setBit(bitIndex: number): void {
    const byteIndex = bitIndex >> 3;
    const mask = 1 << (bitIndex & 7);
    this.bits[byteIndex] |= mask;
  }

  private getBit(bitIndex: number): boolean {
    const byteIndex = bitIndex >> 3;
    const mask = 1 << (bitIndex & 7);
    return (this.bits[byteIndex] & mask) !== 0;
  }
}

/**
 * Compute the optimal Bloom filter bit size and hash function count for a
 * given workload, and return the estimated false-positive rate that results
 * from those rounded parameters.
 *
 * Use this as a tree-shakeable, class-free alternative to
 * `BloomFilter.computeOptimal` when you only need the sizing math without
 * importing the full filter implementation.
 *
 * @param expectedItems     The number of unique routes or states the
 *                          application is expected to track (e.g. 200 if your
 *                          SPA has ~200 distinct URL patterns).  Must be > 0.
 * @param falsePositiveRate Target false-positive probability expressed as a
 *                          float in the range (0, 1).  For example, pass
 *                          `0.01` for a 1 % false-positive rate.
 * @returns `{ bitSize, hashCount, estimatedFpRate }` where `estimatedFpRate`
 *          is the actual FPR achieved after rounding `m` and `k` to integers.
 *
 * @example
 * const { bitSize, hashCount, estimatedFpRate } = computeBloomConfig(200, 0.01);
 * // → { bitSize: 1918, hashCount: 7, estimatedFpRate: ~0.009 }
 * const intent = new IntentManager({ bloom: { bitSize, hashCount } });
 */
export function computeBloomConfig(
  expectedItems: number,
  falsePositiveRate: number,
): { bitSize: number; hashCount: number; estimatedFpRate: number } {
  if (expectedItems <= 0) expectedItems = 1;
  if (falsePositiveRate <= 0) falsePositiveRate = 1e-10;
  if (falsePositiveRate >= 1) falsePositiveRate = 0.99;

  // Standard optimal Bloom filter formulas:
  //   m = ceil( -(n * ln(p)) / ln(2)^2 )
  //   k = round( (m / n) * ln(2) )
  const m = Math.ceil(-(expectedItems * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2));
  const k = Math.max(1, Math.round((m / expectedItems) * Math.log(2)));

  // Recalculate the actual FPR achieved with the rounded (integer) m and k.
  // Formula: p_actual = (1 - e^(-k*n/m))^k
  const bitZeroProbability = Math.exp(-(k * expectedItems) / m);
  const estimatedFpRate = Math.pow(1 - bitZeroProbability, k);

  return { bitSize: m, hashCount: k, estimatedFpRate };
}
