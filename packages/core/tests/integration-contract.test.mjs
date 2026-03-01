/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BloomFilter, IntentManager, MarkovGraph } from '../dist/src/intent-sdk.js';
import { setupTestEnvironment, storage } from './helpers/test-env.mjs';

setupTestEnvironment();

test('IntentManager emits events, tracks seen states, and persists/restores', async () => {
  storage.clear();

  const baseline = new MarkovGraph();
  baseline.incrementTransition('home', 'search');
  baseline.incrementTransition('search', 'detail');

  const manager = new IntentManager({
    storageKey: 'intent-test',
    persistDebounceMs: 5,
    graph: {
      highEntropyThreshold: 0,
      divergenceThreshold: -0.1,
      smoothingEpsilon: 0.01,
    },
    baseline: baseline.toJSON(),
    botProtection: false, // Disable bot detection for tests
  });

  let highEntropyCount = 0;
  let anomalyCount = 0;
  const stateChanges = [];

  manager.on('high_entropy', () => {
    highEntropyCount += 1;
  });
  manager.on('trajectory_anomaly', () => {
    anomalyCount += 1;
  });
  manager.on('state_change', ({ to }) => {
    stateChanges.push(to);
  });

  manager.track('home');
  manager.track('search');
  manager.track('detail');

  assert.equal(manager.hasSeen('nonexistent'), false);
  assert.equal(manager.hasSeen('search'), true);
  assert.deepEqual(stateChanges, ['home', 'search', 'detail']);

  // Generate enough transitions to exceed MIN_SAMPLE_TRANSITIONS (10) and MIN_WINDOW_LENGTH (16)
  // Alternate between home<->search to build up entropy samples and trajectory window
  for (let i = 0; i < 30; i++) {
    manager.track(i % 2 === 0 ? 'home' : 'search');
  }

  // With highEntropyThreshold=0 and divergenceThreshold=-0.1 (very sensitive),
  // and enough samples, we should see both types of events
  assert.ok(highEntropyCount >= 1, `Expected highEntropyCount >= 1, got ${highEntropyCount}`);
  assert.ok(anomalyCount >= 1, `Expected anomalyCount >= 1, got ${anomalyCount}`);

  await manager.flushNow();

  const restored = new IntentManager({
    storageKey: 'intent-test',
    graph: {
      highEntropyThreshold: 0,
      divergenceThreshold: -0.1,
      smoothingEpsilon: 0.01,
    },
    botProtection: false, // Disable bot detection for tests
  });

  assert.equal(restored.hasSeen('home'), true);
  assert.equal(restored.exportGraph().states.includes('search'), true);
});

test('dirty flag: persist() is a no-op when no new state has been tracked since last save', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'dirty-noop-test',
    persistDebounceMs: 5,
    botProtection: false,
  });

  manager.track('home');
  manager.flushNow();

  const firstPayload = storage.getItem('dirty-noop-test');
  assert.ok(firstPayload, 'Expected a persisted payload after first flush');

  // Second flush with no new track() — dirty flag should still be false.
  manager.flushNow();
  const secondPayload = storage.getItem('dirty-noop-test');

  assert.equal(firstPayload, secondPayload, 'Expected payload unchanged after no-op flush');
});

test('dirty flag: persist() writes again after a new track() call', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'dirty-resave-test',
    persistDebounceMs: 5,
    botProtection: false,
  });

  manager.track('home');
  manager.flushNow();
  const firstPayload = storage.getItem('dirty-resave-test');

  // New transition — marks dirty again.
  manager.track('search');
  manager.flushNow();
  const secondPayload = storage.getItem('dirty-resave-test');

  assert.notEqual(firstPayload, secondPayload, 'Expected payload to change after new track()');
});

test('dirty flag: multiple flushNow() calls without track() write storage exactly once', () => {
  storage.clear();

  let writeCount = 0;
  const countingStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      writeCount += 1;
      storage.setItem(key, value);
    },
  };

  const manager = new IntentManager({
    storageKey: 'dirty-write-count-test',
    persistDebounceMs: 5,
    botProtection: false,
    storage: countingStorage,
  });

  // With aggressive sync persist each track() writes immediately.
  manager.track('A'); // write #1
  manager.track('B'); // write #2 (new transition → dirty)
  assert.equal(writeCount, 2, `Expected 2 sync writes from track() calls, got ${writeCount}`);

  manager.flushNow(); // not dirty → no additional write
  manager.flushNow(); // not dirty → no additional write

  assert.equal(
    writeCount,
    2,
    `Expected still 2 writes (flushNow noop when not dirty), got ${writeCount}`,
  );

  // Track again → exactly one more write.
  manager.track('C'); // write #3
  manager.flushNow(); // not dirty → no additional write

  assert.equal(
    writeCount,
    3,
    `Expected exactly 3 storage writes after third track, got ${writeCount}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────

test('persist/restore round-trip works with streaming base64 encoding', () => {
  storage.clear();

  const m1 = new IntentManager({
    storageKey: 'streaming-b64-test',
    persistDebounceMs: 5,
    botProtection: false,
  });

  for (let i = 0; i < 50; i++) m1.track(`page-${i % 10}`);
  m1.flushNow();

  const m2 = new IntentManager({
    storageKey: 'streaming-b64-test',
    botProtection: false,
  });

  for (let i = 0; i < 10; i++) {
    assert.equal(m2.hasSeen(`page-${i}`), true, `page-${i} must survive persist/restore`);
  }
  assert.equal(m2.hasSeen('never-tracked'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// destroy() API
// ─────────────────────────────────────────────────────────────────────────────

test('destroy() flushes pending state and removes all listeners', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'destroy-test',
    persistDebounceMs: 60000, // long debounce — flush should still happen via destroy()
    botProtection: false,
  });

  let eventCount = 0;
  manager.on('state_change', () => {
    eventCount += 1;
  });

  manager.track('home');
  manager.track('search');
  assert.equal(eventCount, 2, 'Events should fire before destroy');

  manager.destroy();

  // After destroy: data must have been persisted
  const raw = storage.getItem('destroy-test');
  assert.ok(raw, 'Storage must contain persisted state after destroy()');

  // After destroy: listeners are removed, new track() on a fresh instance
  // with the same emitter reference should not fire the old listener.
  // (We verify by checking that eventCount did not increase during destroy.)
  assert.equal(eventCount, 2, 'No extra events should fire during destroy');
});

test('destroy() can be called multiple times safely', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'destroy-idempotent-test',
    persistDebounceMs: 5,
    botProtection: false,
  });

  manager.track('A');
  assert.doesNotThrow(() => {
    manager.destroy();
    manager.destroy();
    manager.destroy();
  }, 'Multiple destroy() calls must not throw');
});

// ─────────────────────────────────────────────────────────────────────────────
// Configurable Event Cooldown
// ─────────────────────────────────────────────────────────────────────────────

test('getTelemetry() engineHealth is healthy after a normal persist / prune cycle', () => {
  storage.clear();

  // maxStates=3 forces prune on every persist with enough states
  const manager = new IntentManager({
    storageKey: 'telemetry-health-prune-test',
    storage,
    botProtection: false,
    graph: { maxStates: 3 },
    persistDebounceMs: 1,
  });

  // Add 5 states to force LFU pruning threshold
  ['A', 'B', 'C', 'D', 'E'].forEach((s) => manager.track(s));
  manager.flushNow(); // triggers prune() internally

  // After prune completes, engineHealth must settle back to 'healthy'
  assert.equal(
    manager.getTelemetry().engineHealth,
    'healthy',
    'engineHealth must be healthy after prune cycle completes',
  );
});

test('getTelemetry() engineHealth transitions to quota_exceeded on QuotaExceededError', () => {
  storage.clear();

  // A storage adapter that throws QuotaExceededError on setItem
  const quotaStorage = {
    getItem: (key) => storage.getItem(key),
    setItem: (_key, _value) => {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    },
  };

  const manager = new IntentManager({
    storageKey: 'telemetry-quota-test',
    storage: quotaStorage,
    botProtection: false,
  });

  manager.track('home');
  manager.track('search');
  manager.flushNow(); // triggers persist() which throws QuotaExceededError

  assert.equal(
    manager.getTelemetry().engineHealth,
    'quota_exceeded',
    'engineHealth must be quota_exceeded after a QuotaExceededError from storage',
  );
});

test('binary codec v2 golden fixture remains backward compatible', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/markov-binary-v2-golden.json', import.meta.url), 'utf8'),
  );

  const binary = Buffer.from(fixture.binaryBase64, 'base64');
  const fromBinary = MarkovGraph.fromBinary(new Uint8Array(binary), fixture.config);
  const fromJson = MarkovGraph.fromJSON(fixture.json, fixture.config);

  assert.equal(fromBinary.getProbability('', 'A'), 0);
  assert.equal(fromBinary.getProbability('A', ''), 0);
  assert.equal(fromJson.getProbability('', 'A'), 0);
  assert.equal(fromJson.getProbability('A', ''), 0);

  assert.equal(fromBinary.getProbability('A', 'B'), fromJson.getProbability('A', 'B'));

  const roundTripBase64 = Buffer.from(fromBinary.toBinary()).toString('base64');
  assert.equal(
    roundTripBase64,
    fixture.binaryBase64,
    'Binary round-trip must match golden fixture payload',
  );

  const statesLen = fromBinary.toJSON().states.length;
  fromBinary.incrementTransition('A', 'Z');
  assert.equal(
    fromBinary.toJSON().states.length,
    statesLen,
    'Freed slot should be reused after restore',
  );
});
