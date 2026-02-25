/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserStorageAdapter,
  BrowserTimerAdapter,
  IntentManager,
  MemoryStorageAdapter,
} from '../dist/src/index.js';

class ManualTimerAdapter {
  constructor() {
    this.time = 0;
    this.tasks = [];
    this.nextId = 1;
  }

  now() {
    return this.time;
  }

  setTimeout(fn, delay) {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.time + delay, fn });
    return id;
  }

  clearTimeout(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }

  advance(ms) {
    this.time += ms;
    const due = this.tasks.filter((t) => t.at <= this.time);
    this.tasks = this.tasks.filter((t) => t.at > this.time);
    due.forEach((t) => t.fn());
  }
}

test('BrowserStorageAdapter gracefully degrades when window/localStorage are unavailable', () => {
  const originalWindow = globalThis.window;
  try {
    // Simulate SSR/non-browser runtime.
    delete globalThis.window;

    const adapter = new BrowserStorageAdapter();
    assert.equal(adapter.getItem('missing'), null);
    assert.doesNotThrow(() => adapter.setItem('k', 'v'));
  } finally {
    if (originalWindow !== undefined) {
      globalThis.window = originalWindow;
    }
  }
});

test('BrowserTimerAdapter works with platform timers and monotonic fallback', () => {
  const timer = new BrowserTimerAdapter();
  let fired = false;
  const id = timer.setTimeout(() => {
    fired = true;
  }, 1);

  assert.ok(id !== undefined);
  assert.equal(typeof timer.now(), 'number');
  timer.clearTimeout(id);
  assert.equal(fired, false);
});

test('IntentManager runs with custom storage+manual timer adapters (runtime matrix compatibility)', () => {
  const timer = new ManualTimerAdapter();
  const storage = new MemoryStorageAdapter();

  const manager = new IntentManager({
    storageKey: 'compat-matrix',
    storage,
    timer,
    persistDebounceMs: 10,
    botProtection: false,
  });

  manager.track('home');
  manager.track('search');

  // Debounced persistence should not run until time advances.
  assert.equal(storage.getItem('compat-matrix'), null);
  timer.advance(11);
  assert.ok(storage.getItem('compat-matrix'));
});
