/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { base64ToUint8, uint8ToBase64 } from '../persistence/codec.js';
import type { BloomFilterConfig } from '../types/events.js';

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return hash >>> 0;
}

export class BloomFilter {
  readonly bitSize: number;
  readonly hashCount: number;
  private readonly bits: Uint8Array;

  constructor(config: BloomFilterConfig = {}, existingBits?: Uint8Array) {
    this.bitSize = config.bitSize ?? 2048;
    this.hashCount = config.hashCount ?? 4;

    const byteSize = Math.ceil(this.bitSize / 8);
    this.bits = existingBits && existingBits.length === byteSize
      ? existingBits
      : new Uint8Array(byteSize);
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
