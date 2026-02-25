/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

export class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, value);
  }

  clear() {
    this.map.clear();
  }
}

export const storage = new MemoryStorage();

export function setupTestEnvironment() {
  globalThis.localStorage = storage;
  globalThis.window = {
    setTimeout,
    clearTimeout,
    localStorage: storage,
  };

  if (!globalThis.performance) {
    globalThis.performance = { now: () => Date.now() };
  }
  if (!globalThis.TextEncoder) {
    globalThis.TextEncoder = class {
      encode(value) {
        return Buffer.from(value, 'utf-8');
      }
    };
  }
  if (!globalThis.btoa) {
    globalThis.btoa = (v) => Buffer.from(v, 'binary').toString('base64');
  }
  if (!globalThis.atob) {
    globalThis.atob = (v) => Buffer.from(v, 'base64').toString('binary');
  }
}
