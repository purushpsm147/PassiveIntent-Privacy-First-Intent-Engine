import test from 'node:test';
import assert from 'node:assert/strict';

import { BloomFilter, IntentManager, MarkovGraph } from '../dist/src/intent-sdk.js';

class MemoryStorage {
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

const storage = new MemoryStorage();

globalThis.localStorage = storage;
globalThis.window = {
  setTimeout,
  clearTimeout,
};

test('BloomFilter supports add/check and base64 round-trip', () => {
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  bloom.add('home');
  bloom.add('settings');

  assert.equal(bloom.check('home'), true);
  assert.equal(bloom.check('settings'), true);
  assert.equal(bloom.check('notadded'), false);

  const restored = BloomFilter.fromBase64(bloom.toBase64(), { bitSize: 256, hashCount: 3 });
  assert.equal(restored.check('home'), true);
  assert.equal(restored.check('settings'), true);
  assert.equal(restored.check('notadded'), false);
});

test('MarkovGraph calculates probabilities, entropy, and serialization', () => {
  const graph = new MarkovGraph();
  graph.incrementTransition('A', 'B');
  graph.incrementTransition('A', 'C');
  graph.incrementTransition('A', 'B');

  assert.equal(graph.getProbability('A', 'B'), 2 / 3);
  assert.equal(graph.getProbability('A', 'C'), 1 / 3);

  const entropy = graph.entropyForState('A');
  assert.ok(entropy > 0);
  const normalized = graph.normalizedEntropyForState('A');
  assert.ok(normalized > 0 && normalized <= 1);

  const quantized = graph.getQuantizedProbability('A', 'B');
  assert.ok(Math.abs(quantized - 2 / 3) < 0.01);

  const roundTripped = MarkovGraph.fromJSON(graph.toJSON());
  assert.equal(roundTripped.getProbability('A', 'B'), 2 / 3);
});

test('MarkovGraph computes trajectory likelihood with smoothing for unknown transitions', () => {
  const baseline = new MarkovGraph();
  baseline.incrementTransition('A', 'B');

  const knownOnly = MarkovGraph.logLikelihoodTrajectory(baseline, ['A', 'B']);
  assert.equal(knownOnly, Math.log(1));

  const unknownEdge = MarkovGraph.logLikelihoodTrajectory(baseline, ['A', 'C']);
  assert.equal(unknownEdge, Math.log(1e-6));
});

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
      divergenceThreshold: 0,
    },
    baseline: baseline.toJSON(),
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

  // Add more transitions so row.total reaches the minimum sample threshold (3)
  // before checking that entropy and anomaly events fire.
  manager.track('home');
  manager.track('search');
  manager.track('home');
  manager.track('search');
  manager.track('home');

  assert.ok(highEntropyCount >= 1);
  assert.ok(anomalyCount >= 1);

  await manager.flushNow();

  const restored = new IntentManager({
    storageKey: 'intent-test',
    graph: {
      highEntropyThreshold: 0,
      divergenceThreshold: 0,
    },
  });

  assert.equal(restored.hasSeen('home'), true);
  assert.equal(restored.exportGraph().states.includes('search'), true);
});
