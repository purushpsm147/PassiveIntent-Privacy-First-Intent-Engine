/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Lightweight base64 codec for Uint8Array payloads.
 *
 * Browser `btoa()` only accepts binary strings, not typed arrays directly.
 * The standard pattern `btoa(String.fromCharCode(...bytes))` uses spread +
 * Function.prototype.apply which throws a RangeError ("Maximum call stack
 * size exceeded") for arrays larger than ~65k bytes – a realistic size for
 * a large MarkovGraph binary payload.  This module uses a chunked approach
 * to avoid that limit while remaining dependency-free.
 */

/**
 * Convert a Uint8Array to a base64 string using chunked
 * String.fromCharCode to avoid O(n) string concatenation.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  /**
   * 0x8000 (32 768) bytes per chunk is safely below the JavaScript engine’s
   * maximum function argument count (~65k arguments in V8 / SpiderMonkey),
   * ensuring `String.fromCharCode.apply` never overflows the call stack.
   */
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return btoa(parts.join(''));
}

/** Convert base64 payload back to Uint8Array. */
export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}
