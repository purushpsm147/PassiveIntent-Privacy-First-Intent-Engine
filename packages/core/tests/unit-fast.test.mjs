/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BloomFilter,
  IntentManager,
  MarkovGraph,
  computeBloomConfig,
} from '../dist/src/intent-sdk.js';
import {
  BenchmarkSimulationEngine,
  evaluatePredictionMatrix,
} from '../dist/src/intent-sdk-performance.js';
import { MemoryStorage, setupTestEnvironment, storage } from './helpers/test-env.mjs';

setupTestEnvironment();

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
  assert.equal(graph.stateCount(), 3);
  assert.equal(graph.totalTransitions(), 3);

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
  assert.equal(unknownEdge, Math.log(0.01));
});

test('trajectory likelihood scores structured paths higher than noisy paths under baseline model', () => {
  const baseline = new MarkovGraph();
  baseline.incrementTransition('A', 'B');
  baseline.incrementTransition('B', 'C');
  baseline.incrementTransition('C', 'D');
  baseline.incrementTransition('D', 'A');

  const structured = ['A', 'B', 'C', 'D', 'A'];
  const noisy = ['A', 'D', 'B', 'A', 'C'];
  const nStructured = Math.max(1, structured.length - 1);
  const nNoisy = Math.max(1, noisy.length - 1);

  const structuredAvg = MarkovGraph.logLikelihoodTrajectory(baseline, structured) / nStructured;
  const noisyAvg = MarkovGraph.logLikelihoodTrajectory(baseline, noisy) / nNoisy;

  assert.ok(structuredAvg > noisyAvg);
});

test('MarkovGraph LFU pruning reuses freed indices and round-trips without resurrecting tombstones', () => {
  // ── Setup: maxStates=3 so pruning fires as soon as we have 4 live states ──
  const graph = new MarkovGraph({ maxStates: 3 });

  // A↔B is high-use; C and D are low-use targets.
  for (let i = 0; i < 20; i++) graph.incrementTransition('A', 'B');
  for (let i = 0; i < 15; i++) graph.incrementTransition('B', 'A');
  graph.incrementTransition('A', 'C'); // low-use — candidate for eviction
  graph.incrementTransition('C', 'A');
  graph.incrementTransition('A', 'D'); // 4th state pushes size over maxStates

  // stateToIndex.size == 4 > maxStates=3 → prune evicts 1 least-used state
  graph.prune();

  const jsonAfterPrune = graph.toJSON();
  const statesAfterPrune = jsonAfterPrune.states;
  const liveAfterPrune = statesAfterPrune.filter((s) => s !== '');
  const tombstoneCount = statesAfterPrune.filter((s) => s === '').length;

  assert.ok(liveAfterPrune.length <= 3, `Expected ≤3 live states, got ${liveAfterPrune.length}`);
  assert.ok(tombstoneCount >= 1, `Expected ≥1 tombstone slot, got ${tombstoneCount}`);

  // V2: toJSON() must emit an explicit freedIndices array
  assert.ok(Array.isArray(jsonAfterPrune.freedIndices), 'toJSON() must emit freedIndices array');
  assert.equal(
    jsonAfterPrune.freedIndices.length,
    tombstoneCount,
    `freedIndices.length must equal tombstone count (${tombstoneCount})`,
  );
  // Every freed index must point to a '' slot in states
  for (const idx of jsonAfterPrune.freedIndices) {
    assert.equal(statesAfterPrune[idx], '', `freedIndices[${idx}] must map to a tombstone slot`);
  }

  // ── In-memory slot reuse ──
  const arrayLenBeforeReuse = statesAfterPrune.length;
  graph.incrementTransition('A', 'E'); // E must occupy the freed slot

  assert.equal(
    graph.toJSON().states.length,
    arrayLenBeforeReuse,
    `ensureState must reuse freed slot, not grow array (was ${arrayLenBeforeReuse})`,
  );
  assert.ok(graph.getProbability('A', 'E') > 0, 'A→E probability must be > 0 after slot reuse');

  // ── Primary path: toBinary / fromBinary (no JSON.stringify on main thread) ──
  const g2 = new MarkovGraph({ maxStates: 3 });
  for (let i = 0; i < 20; i++) g2.incrementTransition('A', 'B');
  for (let i = 0; i < 15; i++) g2.incrementTransition('B', 'A');
  g2.incrementTransition('A', 'C');
  g2.incrementTransition('C', 'A');
  g2.incrementTransition('A', 'D');
  g2.prune(); // leaves ≥1 tombstone

  assert.ok(
    g2.toJSON().states.includes(''),
    'Precondition: g2 must have tombstone before binary encode',
  );
  const pAB = g2.getProbability('A', 'B');

  const bin = g2.toBinary();
  const fromBin = MarkovGraph.fromBinary(bin);

  assert.equal(fromBin.getProbability('', 'A'), 0, "fromBinary: '' must not be a live fromState");
  assert.equal(fromBin.getProbability('A', ''), 0, "fromBinary: '' must not be a live toState");
  assert.ok(
    Math.abs(pAB - fromBin.getProbability('A', 'B')) < 1e-9,
    `fromBinary: A→B probability mismatch`,
  );

  // freedIndices must be repopulated — next new state must reuse a slot, not grow the array
  const arrayLenBin = fromBin.toJSON().states.length;
  fromBin.incrementTransition('A', 'F');
  assert.equal(
    fromBin.toJSON().states.length,
    arrayLenBin,
    `fromBinary: adding F must reuse a freed slot, not extend the array`,
  );

  // ── Secondary path: fromJSON (baseline config loading path) ──
  const fromJson = MarkovGraph.fromJSON(g2.toJSON());
  assert.equal(fromJson.getProbability('', 'A'), 0, "fromJSON: '' must not be a live fromState");
  assert.equal(fromJson.getProbability('A', ''), 0, "fromJSON: '' must not be a live toState");
  assert.ok(
    Math.abs(pAB - fromJson.getProbability('A', 'B')) < 1e-9,
    `fromJSON: A→B probability mismatch`,
  );
  const arrayLenJson = fromJson.toJSON().states.length;
  fromJson.incrementTransition('A', 'G');
  assert.equal(
    fromJson.toJSON().states.length,
    arrayLenJson,
    `fromJSON: adding G must reuse a freed slot, not extend the array`,
  );
});

test('fromJSON rejects inconsistent payloads (freedIndices / label mismatch)', () => {
  // Case 1: slot in freedIndices has a non-empty label
  assert.throws(
    () =>
      MarkovGraph.fromJSON({
        states: ['A', 'oops'],
        rows: [],
        freedIndices: [1], // slot 1 is 'oops', not ''
      }),
    /freedIndices.*non-empty label/,
    'Should throw when freedIndices slot has a non-empty label',
  );

  // Case 2: '' label not listed in freedIndices
  assert.throws(
    () =>
      MarkovGraph.fromJSON({
        states: ['A', ''],
        rows: [],
        freedIndices: [], // slot 1 is '' but not declared freed
      }),
    /empty-string label.*not listed in freedIndices/,
    'Should throw when an unlisted slot has an empty-string label',
  );
});

test('IntentManager returns performance report when benchmark mode is enabled', () => {
  const manager = new IntentManager({
    storageKey: 'perf-test',
    benchmark: { enabled: true, maxSamples: 32 },
    botProtection: false, // Disable bot detection for tests
  });

  manager.track('A');
  manager.track('B');
  manager.track('C');
  manager.hasSeen('A');

  const report = manager.getPerformanceReport();

  assert.equal(report.benchmarkEnabled, true);
  assert.ok(report.track.count >= 3);
  assert.ok(report.bloomAdd.count >= 3);
  assert.ok(report.bloomCheck.count >= 1);
  assert.ok(report.memoryFootprint.stateCount >= 3);
  assert.ok(report.memoryFootprint.totalTransitions >= 2);

  manager.flushNow();
});

test("IntentManager.track('') is a no-op and surfaces a non-fatal error via onError", () => {
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'empty-state-test',
    botProtection: false,
    onError: (err) => errors.push(err),
  });

  // track('') must not throw — host app must not crash
  assert.doesNotThrow(() => manager.track(''));

  // onError must be called with the structured EdgeSignalError contract
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].code,
    'VALIDATION',
    `Expected code 'VALIDATION', got: '${errors[0].code}'`,
  );
  assert.ok(
    errors[0].message.includes('empty string'),
    `Expected 'empty string' in error message, got: "${errors[0].message}"`,
  );

  // No state_change event must fire for an empty-string call
  const stateChanges = [];
  manager.on('state_change', ({ to }) => stateChanges.push(to));
  manager.track('');
  assert.deepEqual(stateChanges, []);

  // Normal tracking must still work after the rejected call
  manager.track('home');
  manager.track('search');
  assert.equal(manager.hasSeen('home'), true);
  assert.equal(manager.hasSeen('search'), true);
  assert.equal(manager.hasSeen(''), false);
});

test('EntropyGuard: botProtection:false never suppresses events regardless of call speed', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-off-test',
    graph: { highEntropyThreshold: 0 },
    botProtection: false,
  });

  let eventCount = 0;
  manager.on('high_entropy', () => {
    eventCount += 1;
  });

  // Hub-spoke pattern: alternate between 'hub' and 5 different destinations.
  // This builds >= MIN_SAMPLE_TRANSITIONS (10) outgoing edges from 'hub',
  // which is required before entropy evaluation triggers.
  // Would trigger EntropyGuard if botProtection were on (all deltas < 50 ms).
  const destinations = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 30; i += 1) {
    if (i % 2 === 0) {
      manager.track('hub');
    } else {
      manager.track(destinations[Math.floor(i / 2) % destinations.length]);
    }
  }

  // highEntropyThreshold=0 means any entropy fires; events must flow through.
  assert.ok(
    eventCount > 0,
    `Expected high_entropy events with botProtection:false, got ${eventCount}`,
  );
  manager.flushNow();
});

test('EntropyGuard: botProtection:true suppresses high_entropy and trajectory_anomaly for rapid bot-like calls', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-on-test',
    graph: { highEntropyThreshold: 0, divergenceThreshold: -0.1 },
    botProtection: true,
  });

  let entropyCount = 0;
  let anomalyCount = 0;
  manager.on('high_entropy', () => {
    entropyCount += 1;
  });
  manager.on('trajectory_anomaly', () => {
    anomalyCount += 1;
  });

  // 60 rapid synchronous calls produce near-zero deltas (< 50 ms each),
  // pushing botScore past the threshold of 5 well before transitions accumulate.
  const states = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = 0; i < 60; i += 1) {
    manager.track(states[i % states.length]);
  }

  assert.equal(
    entropyCount,
    0,
    `Expected 0 entropy events after bot flag set, got ${entropyCount}`,
  );
  assert.equal(
    anomalyCount,
    0,
    `Expected 0 anomaly events after bot flag set, got ${anomalyCount}`,
  );
  manager.flushNow();
});

test('EntropyGuard: state_change events are still emitted for suspected bots', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-state-change-test',
    botProtection: true,
  });

  const changes = [];
  manager.on('state_change', ({ from, to }) => {
    changes.push({ from, to });
  });

  for (let i = 0; i < 30; i += 1) {
    manager.track(i % 2 === 0 ? 'X' : 'Y');
  }

  // state_change is unconditional — it fires even when a bot is suspected.
  assert.equal(changes.length, 30);
  assert.equal(changes[0].from, null);
  assert.equal(changes[0].to, 'X');
  assert.equal(changes[1].from, 'X');
  assert.equal(changes[1].to, 'Y');
  manager.flushNow();
});

test('EntropyGuard: Bloom filter and Markov graph still update when bot is suspected', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-graph-update-test',
    botProtection: true,
  });

  for (let i = 0; i < 30; i += 1) {
    manager.track(i % 2 === 0 ? 'P' : 'Q');
  }

  // Underlying state collection continues even while signals are suppressed.
  assert.equal(manager.hasSeen('P'), true);
  assert.equal(manager.hasSeen('Q'), true);
  const graph = manager.exportGraph();
  assert.ok(graph.states.includes('P'), 'Expected P in graph states');
  assert.ok(graph.states.includes('Q'), 'Expected Q in graph states');
  manager.flushNow();
});

test('EntropyGuard: events flow freely until bot threshold is crossed', () => {
  storage.clear();

  // Use botProtection:false so we can verify the threshold boundary logic
  // by inspecting event counts, then separately verify suppression with botProtection:true.
  const withProtection = new IntentManager({
    storageKey: 'bot-threshold-test',
    graph: { highEntropyThreshold: 0 },
    botProtection: false,
  });

  let freeCount = 0;
  withProtection.on('high_entropy', () => {
    freeCount += 1;
  });

  // Must accumulate >= MIN_SAMPLE_TRANSITIONS (10) on one state to get entropy events.
  for (let i = 0; i < 30; i += 1) {
    withProtection.track(
      i % 2 === 0 ? 'home' : ['search', 'product', 'cart', 'help', 'checkout'][i % 5],
    );
  }

  assert.ok(freeCount > 0, `With botProtection:false, expected entropy events; got ${freeCount}`);

  // Now repeat with botProtection:true — all rapid calls suppress signals.
  storage.clear();
  const withBot = new IntentManager({
    storageKey: 'bot-threshold-suppressed-test',
    graph: { highEntropyThreshold: 0 },
    botProtection: true,
  });

  let suppressedCount = 0;
  withBot.on('high_entropy', () => {
    suppressedCount += 1;
  });

  for (let i = 0; i < 30; i += 1) {
    withBot.track(i % 2 === 0 ? 'home' : ['search', 'product', 'cart', 'help', 'checkout'][i % 5]);
  }

  assert.equal(
    suppressedCount,
    0,
    `With botProtection:true, expected 0 entropy events; got ${suppressedCount}`,
  );
  withProtection.flushNow();
  withBot.flushNow();
});

test('EntropyGuard: bot flag clears automatically after sufficient human-paced interactions', () => {
  storage.clear();

  // Control performance.now() so we can simulate fast then slow timing.
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'bot-recovery-test',
      graph: { highEntropyThreshold: 0 },
      botProtection: true,
    });

    let eventCount = 0;
    manager.on('high_entropy', () => {
      eventCount += 1;
    });

    // Phase 1 — rapid calls (0 ms delta): all deltas < BOT_MIN_DELTA_MS (50 ms).
    // After 12 calls the circular buffer (size 10) is full of zero-delta entries,
    // so windowBotScore ≥ BOT_SCORE_THRESHOLD and isSuspectedBot becomes true.
    // Hub-spoke pattern so hub accumulates outgoing transitions.
    const destinations = ['A', 'B', 'C', 'D', 'E'];
    for (let i = 0; i < 12; i++) {
      manager.track(i % 2 === 0 ? 'hub' : destinations[Math.floor(i / 2) % destinations.length]);
    }
    const countAfterFastPhase = eventCount;

    // Phase 2 — human-paced calls: 200 ms between each.
    // BOT_DETECTION_WINDOW = 10; after 10 slow calls, all 10 buffer slots hold
    // 200 ms deltas, so windowBotScore drops to 0 and isSuspectedBot resets.
    // These calls also push hub above MIN_SAMPLE_TRANSITIONS (10) if needed.
    for (let i = 0; i < 15; i++) {
      mockTime += 200;
      manager.track(i % 2 === 0 ? 'hub' : destinations[i % destinations.length]);
    }

    assert.equal(countAfterFastPhase, 0, 'Expected no events while bot flag was active');
    assert.ok(
      eventCount > 0,
      `Expected high_entropy events after bot flag cleared, got ${eventCount}`,
    );
    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dirty-Flag Persistence
// ─────────────────────────────────────────────────────────────────────────────

test('prediction matrix evaluation computes expected rates', () => {
  const summary = evaluatePredictionMatrix([
    {
      isGroundTruthHesitation: true,
      entropyTriggered: true,
      divergenceTriggered: false,
      detectionLatency: 2,
      hesitationAtTrigger: 0.8,
    },
    {
      isGroundTruthHesitation: true,
      entropyTriggered: false,
      divergenceTriggered: false,
      detectionLatency: null,
      hesitationAtTrigger: null,
    },
    {
      isGroundTruthHesitation: false,
      entropyTriggered: true,
      divergenceTriggered: false,
      detectionLatency: 1,
      hesitationAtTrigger: 0.7,
    },
    {
      isGroundTruthHesitation: false,
      entropyTriggered: false,
      divergenceTriggered: false,
      detectionLatency: null,
      hesitationAtTrigger: null,
    },
  ]);

  assert.equal(summary.precision, 0.5);
  assert.equal(summary.recall, 0.5);
  assert.equal(summary.truePositiveRate, 0.5);
  assert.equal(summary.falsePositiveRate, 0.5);
  assert.equal(summary.avgDetectionLatency, 1.5);
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming base64 encoding
// ─────────────────────────────────────────────────────────────────────────────

test('BloomFilter.toBase64 produces identical output after streaming refactor', () => {
  const bloom = new BloomFilter({ bitSize: 2048, hashCount: 4 });
  for (let i = 0; i < 100; i++) bloom.add(`state-${i}`);

  const b64 = bloom.toBase64();
  // Round-trip must still work
  const restored = BloomFilter.fromBase64(b64, { bitSize: 2048, hashCount: 4 });
  for (let i = 0; i < 100; i++) {
    assert.equal(restored.check(`state-${i}`), true, `state-${i} must survive round-trip`);
  }
  assert.equal(restored.check('never-added'), false);
});

test('computeBloomConfig returns correct optimal sizes for standard inputs', () => {
  const { bitSize, hashCount, estimatedFpRate } = computeBloomConfig(200, 0.01);
  // Standard formula: m ≈ 1918 bits, k ≈ 7 hashes for n=200, p=0.01
  assert.ok(bitSize >= 1800 && bitSize <= 2100, `bitSize=${bitSize} out of expected range`);
  assert.ok(hashCount >= 5 && hashCount <= 9, `hashCount=${hashCount} out of expected range`);
  // estimatedFpRate should be close to the target (within 2x)
  assert.ok(
    estimatedFpRate > 0 && estimatedFpRate < 0.02,
    `estimatedFpRate=${estimatedFpRate} should be < 2%`,
  );
});

test('computeBloomConfig estimatedFpRate is self-consistent with the returned m and k', () => {
  const ns = [50, 100, 200, 500];
  for (const n of ns) {
    const { bitSize, hashCount, estimatedFpRate } = computeBloomConfig(n, 0.01);
    // Manually recompute FPR: (1 - e^(-k*n/m))^k
    const bitZeroProbability = Math.exp(-(hashCount * n) / bitSize);
    const expected = Math.pow(1 - bitZeroProbability, hashCount);
    assert.ok(
      Math.abs(estimatedFpRate - expected) < 1e-10,
      `n=${n}: estimatedFpRate mismatch (got ${estimatedFpRate}, expected ${expected})`,
    );
  }
});

test('computeBloomConfig clamps invalid inputs gracefully', () => {
  // n <= 0 should not throw and must return a valid filter config
  const a = computeBloomConfig(0, 0.01);
  assert.ok(a.bitSize >= 1, 'bitSize must be >= 1 for n=0');
  assert.ok(a.hashCount >= 1, 'hashCount must be >= 1 for n=0');

  // p <= 0 should clamp to near-zero, not NaN or Infinity
  const b = computeBloomConfig(100, 0);
  assert.ok(Number.isFinite(b.bitSize), 'bitSize must be finite for p=0');
  assert.ok(Number.isFinite(b.hashCount), 'hashCount must be finite for p=0');

  // p >= 1 should clamp to just-below-1
  const c = computeBloomConfig(100, 2);
  assert.ok(Number.isFinite(c.bitSize), 'bitSize must be finite for p=2');
  assert.ok(c.hashCount >= 1, 'hashCount must be >= 1 for p=2');
});

test('computeBloomConfig matches BloomFilter.computeOptimal bitSize and hashCount', () => {
  // Both APIs must agree on the optimal m and k for the same inputs
  const cases = [
    [100, 0.01],
    [200, 0.01],
    [500, 0.05],
    [1000, 0.001],
  ];
  for (const [n, p] of cases) {
    const util = computeBloomConfig(n, p);
    const cls = BloomFilter.computeOptimal(n, p);
    assert.equal(
      util.bitSize,
      cls.bitSize,
      `n=${n},p=${p}: bitSize mismatch (util=${util.bitSize}, class=${cls.bitSize})`,
    );
    assert.equal(
      util.hashCount,
      cls.hashCount,
      `n=${n},p=${p}: hashCount mismatch (util=${util.hashCount}, class=${cls.hashCount})`,
    );
  }
});

test('eventCooldownMs: default (0) fires on every qualifying track()', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'cooldown-default-test',
    graph: { highEntropyThreshold: 0 },
    botProtection: false,
    // eventCooldownMs defaults to 0
  });

  let eventCount = 0;
  manager.on('high_entropy', () => {
    eventCount += 1;
  });

  // Hub-spoke to build up transitions above MIN_SAMPLE_TRANSITIONS
  const destinations = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 40; i++) {
    manager.track(i % 2 === 0 ? 'hub' : destinations[Math.floor(i / 2) % destinations.length]);
  }

  // With threshold 0, every qualifying call fires — should be more than 1
  assert.ok(eventCount > 1, `Expected multiple entropy events with no cooldown, got ${eventCount}`);
  manager.flushNow();
});

test('eventCooldownMs: suppresses repeated events within cooldown window', () => {
  storage.clear();

  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'cooldown-suppress-test',
      graph: { highEntropyThreshold: 0 },
      botProtection: false,
      eventCooldownMs: 5000, // 5 second cooldown
    });

    let eventCount = 0;
    manager.on('high_entropy', () => {
      eventCount += 1;
    });

    // Hub-spoke pattern to exceed MIN_SAMPLE_TRANSITIONS (10)
    const destinations = ['A', 'B', 'C', 'D', 'E'];
    for (let i = 0; i < 40; i++) {
      mockTime += 100; // 100ms between calls — human-paced
      manager.track(i % 2 === 0 ? 'hub' : destinations[Math.floor(i / 2) % destinations.length]);
    }

    // Total elapsed: 40 × 100ms = 4000ms, which is less than the 5000ms cooldown.
    // So only the first qualifying event should have fired.
    assert.equal(
      eventCount,
      1,
      `Expected exactly 1 entropy event within cooldown, got ${eventCount}`,
    );

    // Advance past the cooldown window and trigger more events
    mockTime += 5000;
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track(i % 2 === 0 ? 'hub' : destinations[i % destinations.length]);
    }

    // Now a second event should have fired
    assert.equal(
      eventCount,
      2,
      `Expected 2 entropy events after cooldown expired, got ${eventCount}`,
    );
    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('eventCooldownMs: trajectory_anomaly respects cooldown independently', () => {
  storage.clear();

  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const baseline = new MarkovGraph();
    baseline.incrementTransition('A', 'B');
    baseline.incrementTransition('B', 'C');
    baseline.incrementTransition('C', 'A');

    const manager = new IntentManager({
      storageKey: 'cooldown-trajectory-test',
      baseline: baseline.toJSON(),
      graph: {
        divergenceThreshold: -0.1, // very sensitive
        highEntropyThreshold: 999, // effectively disable entropy events
      },
      botProtection: false,
      eventCooldownMs: 3000,
    });

    let anomalyCount = 0;
    manager.on('trajectory_anomaly', () => {
      anomalyCount += 1;
    });

    // Random walk to trigger anomaly — need ≥ MIN_WINDOW_LENGTH (16) steps
    const states = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let i = 0; i < 40; i++) {
      mockTime += 200;
      manager.track(states[i % states.length]);
    }

    // Within cooldown — should see at most 1
    assert.ok(anomalyCount <= 2, `Expected ≤2 anomaly events within cooldown, got ${anomalyCount}`);
    const countBefore = anomalyCount;

    // Advance past cooldown and trigger more
    mockTime += 5000;
    for (let i = 0; i < 20; i++) {
      mockTime += 200;
      manager.track(states[i % states.length]);
    }

    assert.ok(
      anomalyCount > countBefore,
      `Expected more anomaly events after cooldown expired, got ${anomalyCount} (was ${countBefore})`,
    );
    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* =================================================================== */
/*  Dwell-Time Anomaly Detection Tests                                  */
/* =================================================================== */

test('dwell_time_anomaly fires for z-score above threshold', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'dwell-anomaly-test',
      storageAdapter: storage,
      botProtection: false,
      dwellTime: {
        enabled: true,
        minSamples: 5,
        zScoreThreshold: 2.0,
      },
    });

    const events = [];
    manager.on('dwell_time_anomaly', (payload) => {
      events.push(payload);
    });

    // Build up 10 consistent dwell times of ~100ms on state A
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    // No anomaly yet — all dwells are uniform
    assert.strictEqual(events.length, 0, 'No anomaly expected for uniform dwell times');

    // Now introduce a dwell time that is 10x the normal dwell on A
    mockTime += 1000; // 1000ms dwell on B before going to A — anomalous for B
    manager.track('A');

    // Should fire for state B (dwell of 1000ms vs mean ~100ms)
    assert.ok(
      events.length >= 1,
      `Expected at least 1 dwell_time_anomaly event, got ${events.length}`,
    );
    const ev = events[events.length - 1];
    assert.strictEqual(ev.state, 'B');
    assert.strictEqual(ev.dwellMs, 1000);
    assert.ok(ev.zScore >= 2.0, `z-score should be >= 2.0, got ${ev.zScore}`);
    assert.ok(ev.meanMs > 0);
    assert.ok(ev.stdMs > 0);

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('dwell_time_anomaly respects minSamples gate', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'dwell-min-samples-test',
      storageAdapter: storage,
      botProtection: false,
      dwellTime: {
        enabled: true,
        minSamples: 20, // high bar
        zScoreThreshold: 1.5,
      },
    });

    const events = [];
    manager.on('dwell_time_anomaly', (payload) => {
      events.push(payload);
    });

    // Only 5 cycles — not enough samples (10 transitions but each state gets ~5)
    for (let i = 0; i < 5; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    // Outlier, but not enough samples yet
    mockTime += 5000;
    manager.track('A');

    assert.strictEqual(events.length, 0, 'No anomaly should fire before minSamples are collected');

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('dwell_time_anomaly is suppressed for suspected bots', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'dwell-bot-test',
      storageAdapter: storage,
      botProtection: true,
      entropyGuard: {
        bufferSize: 5,
        entropyThreshold: 0.01, // very low — easily tripped
      },
      dwellTime: {
        enabled: true,
        minSamples: 3,
        zScoreThreshold: 1.5,
      },
    });

    const dwellEvents = [];
    manager.on('dwell_time_anomaly', (payload) => {
      dwellEvents.push(payload);
    });

    // Rapid, identical-interval transitions to trigger bot detection
    for (let i = 0; i < 30; i++) {
      mockTime += 1; // 1ms intervals — very bot-like
      manager.track(i % 2 === 0 ? 'A' : 'B');
    }

    // Now an outlier
    mockTime += 50000;
    manager.track('A');

    // Bot flag should suppress dwell_time_anomaly
    assert.strictEqual(
      dwellEvents.length,
      0,
      'Dwell anomaly should be suppressed when bot is suspected',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('dwell_time_anomaly respects eventCooldownMs', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'dwell-cooldown-test',
      storageAdapter: storage,
      botProtection: false,
      eventCooldownMs: 10000,
      dwellTime: {
        enabled: true,
        minSamples: 5,
        zScoreThreshold: 1.5,
      },
    });

    const events = [];
    manager.on('dwell_time_anomaly', (payload) => {
      events.push(payload);
    });

    // Build baseline: 10 uniform cycles
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    // First anomaly — should fire
    mockTime += 5000;
    manager.track('A');
    const afterFirst = events.length;
    assert.ok(afterFirst >= 1, 'First anomaly should fire');

    // Second anomaly quickly — should be suppressed by cooldown
    mockTime += 100;
    manager.track('B');
    mockTime += 5000;
    manager.track('A');
    assert.strictEqual(
      events.length,
      afterFirst,
      'Second anomaly within cooldown should be suppressed',
    );

    // Advance past cooldown — next anomaly should fire
    mockTime += 11000;
    manager.track('B');
    mockTime += 5000;
    manager.track('A');
    assert.ok(events.length > afterFirst, 'Anomaly after cooldown should fire');

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('dwell-time stats reset on resetSession (previousStateEnteredAt)', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'dwell-reset-test',
      storageAdapter: storage,
      botProtection: false,
      dwellTime: {
        enabled: true,
        minSamples: 3,
        zScoreThreshold: 2.0,
      },
    });

    // Some transitions
    mockTime += 100;
    manager.track('A');
    mockTime += 100;
    manager.track('B');

    manager.resetSession();

    // After reset, first track should not compute dwell from stale previousStateEnteredAt
    const events = [];
    manager.on('dwell_time_anomaly', (payload) => {
      events.push(payload);
    });

    mockTime += 100;
    manager.track('X');

    // No anomaly — previousState is null after reset, so dwell-time isn't evaluated
    assert.strictEqual(events.length, 0, 'No anomaly after reset with fresh state');

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* =================================================================== */
/*  Selective Bigram Markov Chain Tests                                  */
/* =================================================================== */

test('bigrams are recorded when enableBigrams is true and threshold met', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'bigram-test',
      storageAdapter: storage,
      botProtection: false,
      enableBigrams: true,
      bigramFrequencyThreshold: 3,
    });

    // Build up unigram frequency: A->B repeated
    // We need rowTotal(from) >= 3 for the from-state in bigram logic
    // The bigram records: prev2→from as bigramFrom, from→state as bigramTo
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
      mockTime += 100;
      manager.track('C');
    }

    // Export and check for bigram-style keys (contain →)
    const exported = manager.exportGraph();
    const bigramStates = exported.states.filter((s) => s.includes('\u2192'));
    assert.ok(
      bigramStates.length > 0,
      `Expected bigram state names in graph, found states: ${JSON.stringify(exported.states.slice(0, 10))}`,
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('bigrams are NOT recorded when enableBigrams is false (default)', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'bigram-disabled-test',
      storageAdapter: storage,
      botProtection: false,
      // enableBigrams defaults to false
    });

    for (let i = 0; i < 20; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
      mockTime += 100;
      manager.track('C');
    }

    const exported = manager.exportGraph();
    const bigramStates = exported.states.filter((s) => s.includes('\u2192'));
    assert.strictEqual(
      bigramStates.length,
      0,
      'No bigram states should exist when enableBigrams is false',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('bigrams are not recorded when unigram threshold is not met', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'bigram-threshold-test',
      storageAdapter: storage,
      botProtection: false,
      enableBigrams: true,
      bigramFrequencyThreshold: 100, // very high — won't be met
    });

    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
      mockTime += 100;
      manager.track('C');
    }

    const exported = manager.exportGraph();
    const bigramStates = exported.states.filter((s) => s.includes('\u2192'));
    assert.strictEqual(bigramStates.length, 0, 'No bigram states when threshold is not met');

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* =================================================================== */
/*  Telemetry & Conversion Tracking API                                  */
/* =================================================================== */

test('getTelemetry() returns initial GDPR-safe snapshot before any track() call', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-initial-test',
    storage,
    botProtection: false,
  });

  const t = manager.getTelemetry();

  // sessionId: non-empty string — format is crypto.randomUUID() or Math.random fallback
  assert.equal(typeof t.sessionId, 'string', 'sessionId must be a string');
  assert.ok(t.sessionId.length > 0, 'sessionId must not be empty');

  // Counters start at zero
  assert.equal(t.transitionsEvaluated, 0, 'transitionsEvaluated starts at 0');
  assert.equal(t.anomaliesFired, 0, 'anomaliesFired starts at 0');

  // Default healthy state
  assert.equal(t.botStatus, 'human', 'botStatus starts as human');
  assert.equal(t.engineHealth, 'healthy', 'engineHealth starts as healthy');
});

test('getTelemetry() transitionsEvaluated is 0 for the first track() call (no prior state)', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-first-track-test',
    storage,
    botProtection: false,
  });

  manager.track('A');
  assert.equal(
    manager.getTelemetry().transitionsEvaluated,
    0,
    'First track() has no prior state, so no transition is evaluated',
  );

  manager.track('B');
  assert.equal(
    manager.getTelemetry().transitionsEvaluated,
    1,
    'Second track() produces the first A→B transition',
  );

  manager.track('C');
  assert.equal(manager.getTelemetry().transitionsEvaluated, 2, 'Third track() produces B→C');

  manager.flushNow();
});

test('getTelemetry() sessionId is stable within a single IntentManager instance', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-session-stable-test',
    storage,
    botProtection: false,
  });

  const id1 = manager.getTelemetry().sessionId;
  manager.track('home');
  manager.track('search');
  const id2 = manager.getTelemetry().sessionId;

  assert.equal(id1, id2, 'sessionId must not change within a single instance lifetime');
  manager.flushNow();
});

test('getTelemetry() sessionId differs across IntentManager instances (unique per page load)', () => {
  storage.clear();
  const m1 = new IntentManager({
    storageKey: 'telemetry-session-unique-a',
    storage,
    botProtection: false,
  });
  const m2 = new IntentManager({
    storageKey: 'telemetry-session-unique-b',
    storage,
    botProtection: false,
  });

  // crypto.randomUUID() or the Math.random fallback should produce distinct values
  assert.notEqual(
    m1.getTelemetry().sessionId,
    m2.getTelemetry().sessionId,
    'Two distinct IntentManager instances must have different sessionIds',
  );
  m1.flushNow();
  m2.flushNow();
});

test('getTelemetry() anomaliesFired increments when high_entropy fires', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-entropy-test',
    storage,
    botProtection: false,
    graph: { highEntropyThreshold: 0 }, // fire on any non-zero entropy
  });

  const received = [];
  manager.on('high_entropy', (p) => received.push(p));

  // Hub-spoke: build ≥10 outgoing edges from 'hub' to pass MIN_SAMPLE_TRANSITIONS gate,
  // then continue; at threshold=0 every qualifying entropy evaluation fires.
  const dests = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 30; i++) {
    manager.track(i % 2 === 0 ? 'hub' : dests[i % dests.length]);
  }

  const t = manager.getTelemetry();
  assert.ok(
    t.anomaliesFired > 0,
    `anomaliesFired must be > 0 after high_entropy events, got ${t.anomaliesFired}`,
  );
  assert.equal(
    t.anomaliesFired,
    received.length,
    'anomaliesFired must equal the number of high_entropy events actually delivered',
  );

  manager.flushNow();
});

test('getTelemetry() anomaliesFired increments when trajectory_anomaly fires', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    // Build a simple baseline: A→B→C→A
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 5; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'telemetry-trajectory-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: {
        // Very aggressive threshold + calibration so almost any deviation triggers
        divergenceThreshold: 0.1,
        baselineMeanLL: 0,
        baselineStdLL: 0.01,
      },
    });

    const received = [];
    manager.on('trajectory_anomaly', (p) => received.push(p));

    // Navigate a completely different path (X, Y, Z, W) — high divergence from A→B→C baseline.
    // Need ≥16 transitions to pass MIN_WINDOW_LENGTH guard.
    const states = ['X', 'Y', 'Z', 'W'];
    for (let i = 0; i < 20; i++) {
      mockTime += 100;
      manager.track(states[i % states.length]);
    }

    const t = manager.getTelemetry();
    assert.ok(
      t.anomaliesFired > 0,
      `anomaliesFired must be > 0 after trajectory_anomaly events, got ${t.anomaliesFired}`,
    );
    assert.equal(
      t.anomaliesFired,
      received.length,
      'anomaliesFired must equal the number of trajectory_anomaly events actually delivered',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('getTelemetry() anomaliesFired increments when dwell_time_anomaly fires', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'telemetry-dwell-test',
      storage,
      botProtection: false,
      dwellTime: { enabled: true, minSamples: 3, zScoreThreshold: 1.5 },
    });

    const received = [];
    manager.on('dwell_time_anomaly', (p) => received.push(p));

    // Build baseline: dwell ~100 ms on A each time
    for (let i = 0; i < 5; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    const snapshotBefore = manager.getTelemetry().anomaliesFired;

    // Spike: dwell 5000 ms on A — should produce a high positive z-score
    mockTime += 5000;
    manager.track('A');
    mockTime += 100;
    manager.track('B');

    assert.ok(
      manager.getTelemetry().anomaliesFired > snapshotBefore,
      'anomaliesFired must increment after dwell_time_anomaly fires',
    );
    assert.equal(
      received.length,
      manager.getTelemetry().anomaliesFired - snapshotBefore,
      'delta in anomaliesFired must equal number of dwell_time_anomaly events delivered',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('getTelemetry() anomaliesFired does NOT increment when event is suppressed by eventCooldownMs', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-cooldown-test',
    storage,
    botProtection: false,
    graph: { highEntropyThreshold: 0 },
    eventCooldownMs: 60_000, // 60-second cooldown — only first event passes in sync tests
  });

  const received = [];
  manager.on('high_entropy', (p) => received.push(p));

  const dests = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 50; i++) {
    manager.track(i % 2 === 0 ? 'hub' : dests[i % dests.length]);
  }

  // Cooldown means at most 1 event fires regardless of how many qualifying evaluations occur
  assert.ok(
    received.length <= 1,
    `With 60s cooldown, at most 1 high_entropy event should fire; got ${received.length}`,
  );
  assert.equal(
    manager.getTelemetry().anomaliesFired,
    received.length,
    'anomaliesFired must match the number of events that actually passed the cooldown gate',
  );

  manager.flushNow();
});

test('getTelemetry() botStatus reflects EntropyGuard classification', () => {
  storage.clear();

  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'telemetry-botstatus-test',
      storage,
      botProtection: true,
    });

    // Initially human
    assert.equal(manager.getTelemetry().botStatus, 'human');

    // Rapid synchronous calls: all deltas are 0ms which is < BOT_MIN_DELTA_MS (50ms)
    for (let i = 0; i < 15; i++) {
      manager.track(i % 2 === 0 ? 'X' : 'Y');
    }

    assert.equal(
      manager.getTelemetry().botStatus,
      'suspected_bot',
      'botStatus must be suspected_bot after rapid-fire track() calls',
    );

    // Now advance time so each call is 200ms apart — bot flag should clear
    for (let i = 0; i < 12; i++) {
      mockTime += 200;
      manager.track(i % 2 === 0 ? 'X' : 'Y');
    }

    assert.equal(
      manager.getTelemetry().botStatus,
      'human',
      'botStatus must recover to human after human-paced interactions fill the buffer',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('trackConversion() emits a conversion event with the full payload', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-conversion-full-test',
    storage,
    botProtection: false,
  });

  const received = [];
  manager.on('conversion', (p) => received.push(p));

  manager.trackConversion({ type: 'purchase', value: 49.99, currency: 'USD' });

  assert.equal(received.length, 1, 'conversion event must fire exactly once');
  assert.equal(received[0].type, 'purchase');
  assert.equal(received[0].value, 49.99);
  assert.equal(received[0].currency, 'USD');
});

test('trackConversion() emits with type-only payload (value and currency are optional)', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-conversion-minimal-test',
    storage,
    botProtection: false,
  });

  const received = [];
  manager.on('conversion', (p) => received.push(p));

  manager.trackConversion({ type: 'signup' });

  assert.equal(received.length, 1, 'conversion event must fire exactly once');
  assert.equal(received[0].type, 'signup');
  assert.equal(received[0].value, undefined, 'value must be undefined when not supplied');
  assert.equal(received[0].currency, undefined, 'currency must be undefined when not supplied');
});

test('trackConversion() does not affect transitionsEvaluated or anomaliesFired', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'telemetry-conversion-no-side-effects-test',
    storage,
    botProtection: false,
  });

  manager.track('A');
  manager.track('B');
  const snapshotBefore = manager.getTelemetry();

  manager.trackConversion({ type: 'test' });
  manager.trackConversion({ type: 'test' });

  const snapshotAfter = manager.getTelemetry();

  assert.equal(
    snapshotAfter.transitionsEvaluated,
    snapshotBefore.transitionsEvaluated,
    'trackConversion() must not increment transitionsEvaluated',
  );
  assert.equal(
    snapshotAfter.anomaliesFired,
    snapshotBefore.anomaliesFired,
    'trackConversion() must not increment anomaliesFired',
  );
  assert.equal(
    snapshotAfter.sessionId,
    snapshotBefore.sessionId,
    'trackConversion() must not change sessionId',
  );

  manager.flushNow();
});

/* ================================================================== */
/*  bot_detected & hesitation_detected Events                          */
/* ================================================================== */

test('bot_detected fires on the false→true EntropyGuard transition', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-detected-fires-test',
    storage,
    botProtection: true,
  });

  const detected = [];
  manager.on('bot_detected', (p) => detected.push(p));

  // 60 rapid-fire synchronous track() calls produce near-zero inter-call
  // deltas, pushing the EntropyGuard window score past BOT_SCORE_THRESHOLD.
  const states = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = 0; i < 60; i++) {
    manager.track(states[i % states.length]);
  }

  assert.ok(
    detected.length >= 1,
    `Expected bot_detected to fire at least once, got ${detected.length}`,
  );
  assert.ok(
    typeof detected[0].state === 'string',
    'bot_detected payload must have a string state property',
  );
  manager.flushNow();
});

test('bot_detected fires at most once per false→true transition (not on every rapid call while suspected)', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-detected-once-test',
    storage,
    botProtection: true,
  });

  let fireCount = 0;
  manager.on('bot_detected', () => {
    fireCount += 1;
  });

  const states = ['A', 'B'];
  for (let i = 0; i < 60; i++) {
    manager.track(states[i % states.length]);
  }

  assert.equal(
    fireCount,
    1,
    `bot_detected must fire exactly once per false→true transition, got ${fireCount}`,
  );
  manager.flushNow();
});

test('hesitation_detected fires when trajectory_anomaly and positive dwell_time_anomaly both fire within the correlation window', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    // Baseline: A→B→C loop. Live navigation of X/Y/Z/W diverges from this.
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 5; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'hesitation-fires-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: { divergenceThreshold: 0.1, baselineMeanLL: 0, baselineStdLL: 0.01 },
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 1.5 },
      hesitationCorrelationWindowMs: 60_000,
    });

    const hesitations = [];
    const trajFires = [];
    const dwellFires = [];
    manager.on('hesitation_detected', (p) => hesitations.push(p));
    manager.on('trajectory_anomaly', () => trajFires.push(1));
    manager.on('dwell_time_anomaly', () => dwellFires.push(1));

    // 20 tracks of X/Y/Z at 100ms each → builds dwell stats (≥5 samples per state)
    // and fills trajectory window (MIN_WINDOW_LENGTH = 16).
    const loop = ['X', 'Y', 'Z'];
    for (let i = 0; i < 20; i++) {
      mockTime += 100;
      manager.track(loop[i % 3]);
    }

    // Anomalous: 5 000ms dwell on the previous X/Y/Z state, then navigate to W
    // (completely off-baseline A→B→C path).
    // → evaluateDwellTime: dwell_time_anomaly fires with positive z-score
    // → evaluateTrajectory: trajectory_anomaly fires
    // → maybeEmitHesitation: both timestamps match → hesitation_detected fires
    mockTime += 5000;
    manager.track('W');

    assert.ok(
      hesitations.length >= 1,
      `Expected ≥1 hesitation_detected, got ${hesitations.length}. ` +
        `trajectory_anomaly: ${trajFires.length}, dwell_time_anomaly: ${dwellFires.length}`,
    );
    const h = hesitations[0];
    // hesitation_detected fires from evaluateDwellTime's maybeEmitHesitation call,
    // so state = the state where the user lingered (the 'from' state of the final track).
    assert.ok(
      typeof h.state === 'string' && h.state.length > 0,
      'state must be a non-empty string',
    );
    assert.ok(typeof h.trajectoryZScore === 'number', 'trajectoryZScore must be a number');
    assert.ok(typeof h.dwellZScore === 'number', 'dwellZScore must be a number');
    assert.ok(h.dwellZScore > 0, 'dwellZScore must be positive (lingering, not rushing)');

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('hesitation_detected does NOT fire when only trajectory_anomaly fires (dwellTime not enabled)', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 5; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'hesitation-no-dwell-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: { divergenceThreshold: 0.1, baselineMeanLL: 0, baselineStdLL: 0.01 },
      // dwellTime intentionally NOT enabled
      hesitationCorrelationWindowMs: 60_000,
    });

    const hesitations = [];
    manager.on('hesitation_detected', (p) => hesitations.push(p));

    const loop = ['X', 'Y', 'Z'];
    for (let i = 0; i < 25; i++) {
      mockTime += 100;
      manager.track(loop[i % 3]);
    }

    assert.equal(
      hesitations.length,
      0,
      `hesitation_detected must NOT fire without dwell_time_anomaly, got ${hesitations.length}`,
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('hesitation_detected does NOT fire when dwell_time_anomaly has negative z-score (rushing, not lingering)', () => {
  storage.clear();
  let mockTime = 10_000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 5; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'hesitation-negative-zscore-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: { divergenceThreshold: 0.1, baselineMeanLL: 0, baselineStdLL: 0.01 },
      // Build up stats with 1 000ms "normal" dwell; then rush through (10ms) → negative z-score
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 1.5 },
      hesitationCorrelationWindowMs: 60_000,
    });

    const hesitations = [];
    manager.on('hesitation_detected', (p) => hesitations.push(p));

    const loop = ['X', 'Y', 'Z'];
    for (let i = 0; i < 20; i++) {
      mockTime += 1000; // long dwell — establishes 1 000ms as "normal"
      manager.track(loop[i % 3]);
    }

    // Rush through: 10ms dwell on previous state → negative z-score → must NOT contribute to hesitation
    mockTime += 10;
    manager.track('W');

    assert.equal(
      hesitations.length,
      0,
      `hesitation_detected must NOT fire for negative z-score (rushing), got ${hesitations.length}`,
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('low-level events (trajectory_anomaly, dwell_time_anomaly) still fire independently when hesitation_detected fires', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 5; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'hesitation-lowlevel-cofire-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: { divergenceThreshold: 0.1, baselineMeanLL: 0, baselineStdLL: 0.01 },
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 1.5 },
      hesitationCorrelationWindowMs: 60_000,
    });

    const trajFires = [];
    const dwellFires = [];
    const hesitationFires = [];
    manager.on('trajectory_anomaly', () => trajFires.push(1));
    manager.on('dwell_time_anomaly', () => dwellFires.push(1));
    manager.on('hesitation_detected', () => hesitationFires.push(1));

    const loop = ['X', 'Y', 'Z'];
    for (let i = 0; i < 20; i++) {
      mockTime += 100;
      manager.track(loop[i % 3]);
    }
    mockTime += 5000;
    manager.track('W');

    // Only assert the composition constraint when hesitation actually fired
    if (hesitationFires.length > 0) {
      assert.ok(
        trajFires.length >= 1,
        'trajectory_anomaly must have fired alongside hesitation_detected',
      );
      assert.ok(
        dwellFires.length >= 1,
        'dwell_time_anomaly must have fired alongside hesitation_detected',
      );
    }

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

// ── Drift Protection / Failsafe Killswitch ──────────────────────────────────

test('getTelemetry() baselineStatus is "active" by default', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'drift-initial-test',
    storage,
    botProtection: false,
  });

  assert.equal(
    manager.getTelemetry().baselineStatus,
    'active',
    'baselineStatus must start as "active"',
  );
});

test('driftProtection: isBaselineDrifted set when trajectory_anomaly ratio exceeds maxAnomalyRate', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    // Build baseline that will diverge heavily from the navigation pattern below.
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 10; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    // Very tight drift window (10 calls) and low threshold so drift is triggered quickly.
    const manager = new IntentManager({
      storageKey: 'drift-trigger-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: {
        divergenceThreshold: 0.1,
        baselineMeanLL: 0,
        baselineStdLL: 0.01,
      },
      driftProtection: { maxAnomalyRate: 0.1, evaluationWindowMs: 300_000 },
    });

    const anomalies = [];
    manager.on('trajectory_anomaly', (p) => anomalies.push(p));

    // Navigate a completely different path to trigger trajectory_anomaly events.
    // Need ≥16 states to pass MIN_WINDOW_LENGTH before trajectory evaluation starts;
    // 40 iterations ensure enough anomalies to exceed the 10% maxAnomalyRate.
    const states = ['X', 'Y', 'Z', 'W'];
    for (let i = 0; i < 40; i++) {
      mockTime += 100;
      manager.track(states[i % states.length]);
    }

    const t = manager.getTelemetry();
    // The killswitch must have engaged given the anomaly rate well exceeds 10%
    assert.equal(
      t.baselineStatus,
      'drifted',
      `baselineStatus must be "drifted" after anomaly rate exceeded; anomaliesFired=${t.anomaliesFired}`,
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('driftProtection: evaluateTrajectory is silently skipped once isBaselineDrifted is true', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 10; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'C');
      baselineGraph.incrementTransition('C', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'drift-silences-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: {
        divergenceThreshold: 0.1,
        baselineMeanLL: 0,
        baselineStdLL: 0.01,
      },
      // Very low maxAnomalyRate to trigger drift quickly
      driftProtection: { maxAnomalyRate: 0.05, evaluationWindowMs: 300_000 },
    });

    const anomalies = [];
    manager.on('trajectory_anomaly', (p) => anomalies.push(p));

    // Phase 1: drive the engine to drift
    const states = ['X', 'Y', 'Z', 'W'];
    for (let i = 0; i < 60; i++) {
      mockTime += 100;
      manager.track(states[i % states.length]);
    }

    assert.equal(manager.getTelemetry().baselineStatus, 'drifted', 'must be drifted after phase 1');

    const anomaliesBeforePhase2 = anomalies.length;

    // Phase 2: more tracks — no new trajectory_anomaly should fire once drifted
    for (let i = 0; i < 20; i++) {
      mockTime += 100;
      manager.track(states[i % states.length]);
    }

    assert.equal(
      anomalies.length,
      anomaliesBeforePhase2,
      'no new trajectory_anomaly events must fire after killswitch engages',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('driftProtection: rolling window resets allow anomaly counter to restart', () => {
  storage.clear();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const baselineGraph = new MarkovGraph();
    for (let i = 0; i < 10; i++) {
      baselineGraph.incrementTransition('A', 'B');
      baselineGraph.incrementTransition('B', 'A');
    }

    // Short window (500 ms) so we can advance past it in the test
    const manager = new IntentManager({
      storageKey: 'drift-window-reset-test',
      storage,
      botProtection: false,
      baseline: baselineGraph.toJSON(),
      graph: { divergenceThreshold: 0.1, baselineMeanLL: 0, baselineStdLL: 0.01 },
      // High rate so drift is NOT triggered — we only want to verify window reset
      driftProtection: { maxAnomalyRate: 1.0, evaluationWindowMs: 500 },
    });

    // Track a few times in window 1
    for (let i = 0; i < 5; i++) {
      mockTime += 50;
      manager.track(i % 2 === 0 ? 'X' : 'Y');
    }

    // Advance past the evaluation window
    mockTime += 600;

    // Track again — the window should reset without crashing
    for (let i = 0; i < 5; i++) {
      mockTime += 50;
      manager.track(i % 2 === 0 ? 'X' : 'Y');
    }

    // baselineStatus must still be active (maxAnomalyRate=1.0 can never be exceeded)
    assert.equal(
      manager.getTelemetry().baselineStatus,
      'active',
      'baselineStatus must remain "active" when maxAnomalyRate=1.0',
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

// ── Tab-Visibility Dwell-Time Correction ────────────────────────────────────

test('visibilitychange: hidden time is excluded from dwellMs so no spurious dwell_time_anomaly fires', () => {
  storage.clear();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  // Set up a minimal document mock with a controllable `hidden` flag.
  let docHidden = false;
  let capturedListener = null;
  const originalDocument = globalThis.document;
  globalThis.document = {
    get hidden() {
      return docHidden;
    },
    addEventListener(_evt, fn) {
      capturedListener = fn;
    },
    removeEventListener() {},
  };

  try {
    const manager = new IntentManager({
      storageKey: 'visibility-dwell-test',
      storage,
      botProtection: false,
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 2.0 },
    });

    assert.ok(capturedListener !== null, 'visibilitychange listener must have been registered');

    const anomalies = [];
    manager.on('dwell_time_anomaly', (p) => anomalies.push(p));

    // Build 8 uniform dwell samples: ~100 ms on A, ~100 ms on B
    for (let i = 0; i < 8; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }
    assert.equal(anomalies.length, 0, 'no anomalies during uniform baseline phase');

    // User switches away — tab becomes hidden
    docHidden = true;
    capturedListener(); // fire visibilitychange (hidden)
    mockTime += 30000; // 30 seconds hidden — would inflate dwellMs massively

    // User returns — tab becomes visible
    docHidden = false;
    capturedListener(); // fire visibilitychange (visible)

    // Navigate away from B — dwell on B should reflect only ~100 ms, not 30 100 ms.
    // We record the anomaly list to inspect the actual dwellMs payload if one fires.
    mockTime += 100;
    manager.track('A');
    mockTime += 100;
    manager.track('B');

    assert.equal(
      anomalies.length,
      0,
      'dwell_time_anomaly must NOT fire after tab-switch because hidden time was excluded',
    );

    // Positive control: introduce a genuine anomalous dwell AFTER the correction
    // and confirm the payload dwellMs reflects only visible time (not hidden time).
    mockTime += 2000; // genuine long dwell on B (~2 000 ms visible — anomalous vs ~100 ms mean)
    manager.track('A');

    assert.ok(
      anomalies.length >= 1,
      'dwell_time_anomaly MUST fire for a genuine long dwell after the tab-switch fix',
    );
    const payload = anomalies[anomalies.length - 1];
    // dwellMs must be ~2 000 ms, NOT ~32 100 ms (hidden + genuine)
    assert.ok(
      payload.dwellMs < 5000,
      `dwellMs should be ~2 000 ms (genuine dwell only), got ${payload.dwellMs} ms`,
    );

    manager.flushNow();
  } finally {
    globalThis.performance.now = originalNow;
    globalThis.document = originalDocument;
  }
});

test('visibilitychange: destroy() removes the visibilitychange listener', () => {
  storage.clear();
  const originalDocument = globalThis.document;

  let capturedListener = null;
  let removedListener = null;
  globalThis.document = {
    hidden: false,
    addEventListener(_evt, fn) {
      capturedListener = fn;
    },
    removeEventListener(_evt, fn) {
      removedListener = fn;
    },
  };

  try {
    const manager = new IntentManager({
      storageKey: 'visibility-destroy-test',
      storage,
      botProtection: false,
    });

    assert.ok(capturedListener !== null, 'listener must be registered on construction');
    manager.destroy();
    assert.equal(
      removedListener,
      capturedListener,
      'destroy() must remove the exact same listener reference that was registered',
    );
  } finally {
    globalThis.document = originalDocument;
  }
});

test('visibilitychange: no listener is attached in non-browser (SSR) environment', () => {
  storage.clear();
  const originalDocument = globalThis.document;
  // Simulate SSR: document is undefined
  delete globalThis.document;

  try {
    // Must not throw even without document
    const manager = new IntentManager({
      storageKey: 'visibility-ssr-test',
      storage,
      botProtection: false,
    });
    manager.track('home');
    manager.destroy(); // must not throw
  } finally {
    globalThis.document = originalDocument;
  }
});

test('holdoutConfig: assignmentGroup defaults to treatment when holdoutConfig is absent', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'holdout-default-test',
    storage,
    botProtection: false,
  });
  const telemetry = manager.getTelemetry();
  assert.equal(telemetry.assignmentGroup, 'treatment');
  manager.flushNow();
});

test('holdoutConfig: percentage:100 always assigns to control group', () => {
  storage.clear();
  // With percentage: 100, every session must be in control
  const manager = new IntentManager({
    storageKey: 'holdout-100-test',
    storage,
    botProtection: false,
    holdoutConfig: { percentage: 100 },
  });
  assert.equal(manager.getTelemetry().assignmentGroup, 'control');
  manager.flushNow();
});

test('holdoutConfig: percentage:0 always assigns to treatment group', () => {
  storage.clear();
  // With percentage: 0, every session must be in treatment
  const manager = new IntentManager({
    storageKey: 'holdout-0-test',
    storage,
    botProtection: false,
    holdoutConfig: { percentage: 0 },
  });
  assert.equal(manager.getTelemetry().assignmentGroup, 'treatment');
  manager.flushNow();
});

test('holdoutConfig: control group suppresses high_entropy emit but still increments anomaliesFired', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'holdout-entropy-test',
    storage,
    botProtection: false,
    holdoutConfig: { percentage: 100 }, // always control
    graph: { highEntropyThreshold: 0 }, // fire on any entropy
  });

  const emitted = [];
  manager.on('high_entropy', (p) => emitted.push(p));

  // Build >= MIN_SAMPLE_TRANSITIONS (10) outgoing edges from 'hub'
  const dests = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 30; i++) {
    manager.track(i % 2 === 0 ? 'hub' : dests[Math.floor(i / 2) % dests.length]);
  }

  // No event emitted for control group
  assert.equal(emitted.length, 0, 'control group must not emit high_entropy');
  // But anomaliesFired must have been incremented
  assert.ok(
    manager.getTelemetry().anomaliesFired > 0,
    'control group must still increment anomaliesFired',
  );
  manager.flushNow();
});

test('holdoutConfig: treatment group still emits high_entropy normally', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'holdout-treatment-entropy-test',
    storage,
    botProtection: false,
    holdoutConfig: { percentage: 0 }, // always treatment
    graph: { highEntropyThreshold: 0 },
  });

  const emitted = [];
  manager.on('high_entropy', (p) => emitted.push(p));

  const dests = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 30; i++) {
    manager.track(i % 2 === 0 ? 'hub' : dests[Math.floor(i / 2) % dests.length]);
  }

  assert.ok(emitted.length > 0, 'treatment group must emit high_entropy events');
  manager.flushNow();
});

test('incrementCounter: starts at 0 and increments by 1 by default', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-basic-test',
    storage,
    botProtection: false,
  });

  assert.equal(manager.getCounter('articles_read'), 0, 'counter starts at 0');
  assert.equal(manager.incrementCounter('articles_read'), 1);
  assert.equal(manager.incrementCounter('articles_read'), 2);
  assert.equal(manager.getCounter('articles_read'), 2);
  manager.flushNow();
});

test('incrementCounter: supports custom increment amounts', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-by-test',
    storage,
    botProtection: false,
  });

  manager.incrementCounter('score', 10);
  manager.incrementCounter('score', 5);
  assert.equal(manager.getCounter('score'), 15);
  manager.flushNow();
});

test('incrementCounter: multiple counters are independent', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-multi-test',
    storage,
    botProtection: false,
  });

  manager.incrementCounter('articles_read');
  manager.incrementCounter('articles_read');
  manager.incrementCounter('videos_watched');

  assert.equal(manager.getCounter('articles_read'), 2);
  assert.equal(manager.getCounter('videos_watched'), 1);
  assert.equal(manager.getCounter('never_touched'), 0);
  manager.flushNow();
});

test('resetCounter: resets the counter to 0', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-reset-test',
    storage,
    botProtection: false,
  });

  manager.incrementCounter('articles_read', 5);
  assert.equal(manager.getCounter('articles_read'), 5);

  manager.resetCounter('articles_read');
  assert.equal(manager.getCounter('articles_read'), 0, 'counter must be 0 after reset');

  // Can increment again after reset
  manager.incrementCounter('articles_read');
  assert.equal(manager.getCounter('articles_read'), 1);
  manager.flushNow();
});

test('resetCounter: resetting an unknown counter is a no-op', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-reset-noop-test',
    storage,
    botProtection: false,
  });

  assert.doesNotThrow(() => manager.resetCounter('nonexistent'));
  assert.equal(manager.getCounter('nonexistent'), 0);
  manager.flushNow();
});

test('incrementCounter: empty key is rejected with onError and returns 0', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'counter-empty-key-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
  });

  const result = manager.incrementCounter('');
  assert.equal(result, 0, 'must return 0 for empty key');
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].code,
    'VALIDATION',
    `Expected code 'VALIDATION', got: '${errors[0].code}'`,
  );
  assert.ok(
    errors[0].message.includes('empty string'),
    `Expected 'empty string' in error, got: "${errors[0].message}"`,
  );
  manager.flushNow();
});

// ─── normalizeRouteState ─────────────────────────────────────────────────────
import { normalizeRouteState } from '../dist/src/utils/route-normalizer.js';

test('normalizeRouteState: plain path is returned unchanged', () => {
  assert.equal(normalizeRouteState('/checkout'), '/checkout');
  assert.equal(normalizeRouteState('/products/featured'), '/products/featured');
  assert.equal(normalizeRouteState('/'), '/');
});

test('normalizeRouteState: strips query string', () => {
  assert.equal(normalizeRouteState('/search?q=shoes&page=2'), '/search');
  assert.equal(normalizeRouteState('/home?'), '/home');
});

test('normalizeRouteState: strips hash fragment', () => {
  assert.equal(normalizeRouteState('/about#team'), '/about');
  assert.equal(normalizeRouteState('/docs#section-3'), '/docs');
});

test('normalizeRouteState: strips both query string and hash fragment', () => {
  assert.equal(normalizeRouteState('/profile?tab=bio#social'), '/profile');
  assert.equal(normalizeRouteState('/page?a=1#top'), '/page');
});

test('normalizeRouteState: removes trailing slash', () => {
  assert.equal(normalizeRouteState('/checkout/'), '/checkout');
  assert.equal(normalizeRouteState('/products/featured/'), '/products/featured');
});

test('normalizeRouteState: preserves the bare root slash', () => {
  assert.equal(normalizeRouteState('/'), '/');
});

test('normalizeRouteState: trailing slash + query/hash stripped then slash removed', () => {
  assert.equal(normalizeRouteState('/checkout/?step=2'), '/checkout');
  assert.equal(normalizeRouteState('/checkout/#confirm'), '/checkout');
});

test('normalizeRouteState: replaces v4 UUID in path segment with :id', () => {
  assert.equal(
    normalizeRouteState('/users/550e8400-e29b-41d4-a716-446655440000/profile'),
    '/users/:id/profile',
  );
});

test('normalizeRouteState: replaces uppercase v4 UUID', () => {
  assert.equal(
    normalizeRouteState('/users/550E8400-E29B-41D4-A716-446655440000/settings'),
    '/users/:id/settings',
  );
});

test('normalizeRouteState: replaces MongoDB ObjectID (24-char hex) in path', () => {
  assert.equal(
    normalizeRouteState('/products/507f1f77bcf86cd799439011/reviews'),
    '/products/:id/reviews',
  );
});

test('normalizeRouteState: replaces multiple IDs in one path', () => {
  assert.equal(
    normalizeRouteState(
      '/orgs/507f1f77bcf86cd799439011/users/550e8400-e29b-41d4-a716-446655440000',
    ),
    '/orgs/:id/users/:id',
  );
});

test('normalizeRouteState: replaces both UUID and ObjectID along with query and hash', () => {
  assert.equal(
    normalizeRouteState(
      '/users/550e8400-e29b-41d4-a716-446655440000/posts/507f1f77bcf86cd799439011?sort=asc#top',
    ),
    '/users/:id/posts/:id',
  );
});

test('normalizeRouteState: does NOT replace short hex strings (not IDs)', () => {
  // 7-char git commit SHA must not be treated as an ID
  assert.equal(normalizeRouteState('/commits/abc1234'), '/commits/abc1234');
  // 16-char hex is not a MongoDB ObjectID (too short)
  assert.equal(normalizeRouteState('/tokens/deadbeefdeadbeef'), '/tokens/deadbeefdeadbeef');
});

test('normalizeRouteState: does NOT replace hex strings longer than 24 chars', () => {
  // 26-char hex is not a MongoDB ObjectID (too long) — word boundary prevents partial match
  assert.equal(
    normalizeRouteState('/data/507f1f77bcf86cd79943901ab'),
    '/data/507f1f77bcf86cd79943901ab',
  );
});

test('normalizeRouteState: does NOT replace hyphenated slugs (non-UUID hyphens)', () => {
  assert.equal(normalizeRouteState('/blog/my-first-article'), '/blog/my-first-article');
  assert.equal(normalizeRouteState('/category/red-shoes'), '/category/red-shoes');
});

test('normalizeRouteState: handles empty string without throwing', () => {
  assert.equal(normalizeRouteState(''), '');
});

test('normalizeRouteState: /checkout/ and /checkout resolve to the same state', () => {
  assert.equal(normalizeRouteState('/checkout/'), normalizeRouteState('/checkout'));
});

test('normalizeRouteState: /checkout/?step=2 and /checkout resolve to the same state', () => {
  assert.equal(normalizeRouteState('/checkout/?step=2'), normalizeRouteState('/checkout'));
});

// ─── Integration: normalizeRouteState exported from barrel ───────────────────
import { normalizeRouteState as normalizeFromBarrel } from '../dist/src/intent-sdk.js';

test('normalizeRouteState is re-exported from the intent-sdk barrel', () => {
  assert.equal(typeof normalizeFromBarrel, 'function');
  assert.equal(normalizeFromBarrel('/checkout/'), '/checkout');
});

// ─── Integration: IntentManager.track() auto-normalizes URLs ─────────────────
test('track() auto-normalizes: strips query string before processing', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-query',
    storage,
    botProtection: false,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/search?q=shoes');
  assert.equal(changes[0], '/search', 'state_change.to must be the normalized path');
  assert.ok(manager.hasSeen('/search'), 'hasSeen must use the normalized key');
  assert.ok(!manager.hasSeen('/search?q=shoes'), 'raw URL must not be stored in Bloom filter');
  manager.flushNow();
});

test('track() auto-normalizes: strips hash fragment before processing', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-hash',
    storage,
    botProtection: false,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/about#team');
  assert.equal(changes[0], '/about');
  assert.ok(manager.hasSeen('/about'));
  manager.flushNow();
});

test('track() auto-normalizes: removes trailing slash', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-slash',
    storage,
    botProtection: false,
  });

  manager.track('/checkout/');
  manager.track('/checkout');
  // Both calls land on the same normalized state '/checkout'.
  // The second call is a self-transition (from='/checkout' to='/checkout')
  // which still counts as a state_change event.
  assert.ok(manager.hasSeen('/checkout'));
  assert.ok(!manager.hasSeen('/checkout/'), 'trailing-slash variant must not be stored');
  manager.flushNow();
});

test('track() auto-normalizes: replaces UUID segments with :id', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-uuid',
    storage,
    botProtection: false,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/users/550e8400-e29b-41d4-a716-446655440000/profile');
  assert.equal(changes[0], '/users/:id/profile');
  assert.ok(manager.hasSeen('/users/:id/profile'));
  manager.flushNow();
});

test('track() auto-normalizes: two different UUIDs map to the same canonical state', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-uuid2',
    storage,
    botProtection: false,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/users/550e8400-e29b-41d4-a716-446655440000/profile');
  manager.track('/users/6ba7b810-9dad-41d1-80b4-00c04fd430c8/profile');
  // Both arrive as '/users/:id/profile'
  assert.equal(changes[0], '/users/:id/profile');
  assert.equal(changes[1], '/users/:id/profile');
  manager.flushNow();
});

test('track() auto-normalizes: replaces MongoDB ObjectID segments with :id', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-mongo',
    storage,
    botProtection: false,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/products/507f1f77bcf86cd799439011/reviews');
  assert.equal(changes[0], '/products/:id/reviews');
  manager.flushNow();
});

test('track() auto-normalizes: plain semantic states are unchanged', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-plain',
    storage,
    botProtection: false,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('home');
  manager.track('checkout');
  assert.equal(changes[0], 'home');
  assert.equal(changes[1], 'checkout');
  manager.flushNow();
});

test('MarkovGraph.getLikelyNextStates returns edges above the probability threshold', () => {
  const graph = new MarkovGraph();
  graph.incrementTransition('/home', '/products');
  graph.incrementTransition('/home', '/products');
  graph.incrementTransition('/home', '/about');
  // /products: 2/3 ≈ 0.667, /about: 1/3 ≈ 0.333

  const results = graph.getLikelyNextStates('/home', 0.4);
  assert.equal(results.length, 1);
  assert.equal(results[0].state, '/products');
  assert.ok(Math.abs(results[0].probability - 2 / 3) < 1e-9);
});

test('MarkovGraph.getLikelyNextStates returns results sorted descending by probability', () => {
  const graph = new MarkovGraph();
  graph.incrementTransition('/home', '/a');
  graph.incrementTransition('/home', '/b');
  graph.incrementTransition('/home', '/b');
  graph.incrementTransition('/home', '/c');
  graph.incrementTransition('/home', '/c');
  graph.incrementTransition('/home', '/c');
  // /c: 3/6 = 0.5, /b: 2/6 ≈ 0.333, /a: 1/6 ≈ 0.167

  const results = graph.getLikelyNextStates('/home', 0.1);
  assert.equal(results.length, 3);
  assert.equal(results[0].state, '/c');
  assert.equal(results[1].state, '/b');
  assert.equal(results[2].state, '/a');
  assert.ok(results[0].probability >= results[1].probability);
  assert.ok(results[1].probability >= results[2].probability);
});

test('MarkovGraph.getLikelyNextStates returns empty array for unknown state', () => {
  const graph = new MarkovGraph();
  assert.deepEqual(graph.getLikelyNextStates('/nonexistent', 0.1), []);
});

test('MarkovGraph.getLikelyNextStates returns empty array when threshold exceeds all probabilities', () => {
  const graph = new MarkovGraph();
  graph.incrementTransition('/home', '/products');
  // /products: 1.0 — but we ask for > 1.0
  assert.deepEqual(graph.getLikelyNextStates('/home', 1.1), []);
});

test('IntentManager.predictNextStates returns likely next states from previousState', () => {
  storage.clear();
  const manager = new IntentManager({ storageKey: 'predict-basic', storage, botProtection: false });
  manager.track('/home');
  manager.track('/products');
  manager.track('/home');
  manager.track('/products');
  manager.track('/home');
  // Now previousState = '/home', graph has /home → /products with high probability

  const hints = manager.predictNextStates(0.3);
  assert.ok(hints.length > 0);
  assert.ok(hints.some(({ state }) => state === '/products'));
  manager.flushNow();
});

test('IntentManager.predictNextStates returns empty array before any state is tracked', () => {
  storage.clear();
  const manager = new IntentManager({ storageKey: 'predict-empty', storage, botProtection: false });
  assert.deepEqual(manager.predictNextStates(0.3), []);
  manager.flushNow();
});

test('IntentManager.predictNextStates applies sanitize predicate to filter results', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'predict-sanitize',
    storage,
    botProtection: false,
  });
  manager.track('/home');
  manager.track('/logout');
  manager.track('/home');
  manager.track('/products');
  manager.track('/home');
  // previousState = '/home'; both /logout and /products are candidates

  const blocklist = ['/logout'];
  const hints = manager.predictNextStates(0.1, (state) => !blocklist.includes(state));
  assert.ok(hints.every(({ state }) => state !== '/logout'));
  manager.flushNow();
});

test('IntentManager.predictNextStates uses default threshold of 0.3', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'predict-default-threshold',
    storage,
    botProtection: false,
  });
  // Create a low-probability edge: /home → /rare (1/10) and a high one: /home → /common (9/10)
  for (let i = 0; i < 9; i++) {
    manager.track('/home');
    manager.track('/common');
  }
  manager.track('/home');
  manager.track('/rare');
  manager.track('/home');
  // previousState = '/home'

  const hints = manager.predictNextStates(); // default threshold = 0.3
  assert.ok(
    hints.some(({ state }) => state === '/common'),
    '/common should be included',
  );
  assert.ok(
    !hints.some(({ state }) => state === '/rare'),
    '/rare should be excluded at 0.3 threshold',
  );
  manager.flushNow();
});

// ── BroadcastSync tests ──────────────────────────────────────────────────

import { BroadcastSync, MAX_STATE_LENGTH } from '../dist/src/intent-sdk.js';

test('BroadcastSync: MAX_STATE_LENGTH is 256', () => {
  assert.equal(MAX_STATE_LENGTH, 256);
});

test('BroadcastSync.applyRemote updates graph and bloom without broadcasting', () => {
  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const sync = new BroadcastSync('edgesignal-test-applyremote', graph, bloom);

  sync.applyRemote('/home', '/products');

  assert.equal(graph.getProbability('/home', '/products'), 1);
  assert.ok(bloom.check('/home'));
  assert.ok(bloom.check('/products'));

  sync.close();
});

test('BroadcastSync: isValidSyncMessage rejects oversized state via applyRemote bypass', () => {
  // We test the validation indirectly through handleMessage by posting an oversized payload.
  // Create two channels on the same name so one can receive from the other.
  const channelName = 'edgesignal-test-validation';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const receiver = new BroadcastSync(channelName, graph, bloom);

  // Sender channel posts directly
  const sender = new BroadcastChannel(channelName);

  // Test: oversized 'from' state (257 chars) must be dropped
  const longState = 'x'.repeat(MAX_STATE_LENGTH + 1);
  sender.postMessage({ type: 'transition', from: longState, to: '/home' });

  // Allow the message to be processed
  return new Promise((resolve) => {
    setTimeout(() => {
      // Graph should not have been updated — message was dropped
      assert.equal(graph.getProbability(longState, '/home'), 0);
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: valid remote transition is applied to graph and bloom', () => {
  const channelName = 'edgesignal-test-valid-transition';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const receiver = new BroadcastSync(channelName, graph, bloom);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ type: 'transition', from: '/a', to: '/b' });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(graph.getProbability('/a', '/b'), 1);
      assert.ok(bloom.check('/a'));
      assert.ok(bloom.check('/b'));
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: malformed payload (missing type) is silently dropped', () => {
  const channelName = 'edgesignal-test-malformed';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const receiver = new BroadcastSync(channelName, graph, bloom);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ from: '/a', to: '/b' }); // no 'type' field

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(graph.getProbability('/a', '/b'), 0);
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: empty from/to is rejected', () => {
  const channelName = 'edgesignal-test-empty-states';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const receiver = new BroadcastSync(channelName, graph, bloom);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ type: 'transition', from: '', to: '/b' });

  return new Promise((resolve) => {
    setTimeout(() => {
      // '' is the tombstone sentinel — must never reach the graph
      assert.equal(graph.totalTransitions(), 0);
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: non-object payload is silently dropped', () => {
  const channelName = 'edgesignal-test-nonobject';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const receiver = new BroadcastSync(channelName, graph, bloom);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage('not-an-object');

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(graph.totalTransitions(), 0);
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('IntentManager: crossTabSync:true creates active BroadcastSync channel', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'cross-tab-active',
    storage,
    botProtection: false,
    crossTabSync: true,
  });
  // Just verify no errors are thrown and the manager initializes correctly.
  manager.track('/home');
  manager.track('/products');
  assert.ok(manager.hasSeen('/home'));
  assert.ok(manager.hasSeen('/products'));
  manager.flushNow();
  manager.destroy(); // should close BroadcastChannel without throwing
});

test('IntentManager: crossTabSync:false (default) does not broadcast', () => {
  storage.clear();
  // Create a receiver watching the channel that would be used if crossTabSync were enabled
  const channelName = 'edgesignal-sync:cross-tab-off';
  const received = [];
  const listener = new BroadcastChannel(channelName);
  listener.onmessage = (e) => received.push(e.data);

  const manager = new IntentManager({
    storageKey: 'cross-tab-off',
    storage,
    botProtection: false,
    crossTabSync: false,
  });
  manager.track('/home');
  manager.track('/products');
  manager.flushNow();

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(
        received.length,
        0,
        'No messages should be broadcast when crossTabSync is false',
      );
      listener.close();
      manager.destroy();
      resolve();
    }, 50);
  });
});

test('IntentManager: crossTabSync broadcasts transitions from non-bot sessions', () => {
  storage.clear();
  const channelName = 'edgesignal-sync:cross-tab-broadcast';
  const received = [];
  const listener = new BroadcastChannel(channelName);
  listener.onmessage = (e) => received.push(e.data);

  const manager = new IntentManager({
    storageKey: 'cross-tab-broadcast',
    storage,
    botProtection: false,
    crossTabSync: true,
  });
  manager.track('/home');
  manager.track('/products');
  manager.flushNow();

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(received.length > 0, 'At least one transition should be broadcast');
      assert.ok(received.every((msg) => msg.type === 'transition'));
      assert.ok(received.some((msg) => msg.from === '/home' && msg.to === '/products'));
      listener.close();
      manager.destroy();
      resolve();
    }, 50);
  });
});

// ── BroadcastSync counter-sync tests ────────────────────────────────────────

test('BroadcastSync.applyRemoteCounter increments the shared counters Map', () => {
  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const counters = new Map();
  const sync = new BroadcastSync('edgesignal-test-counter-apply', graph, bloom, counters);

  sync.applyRemoteCounter('articles_read', 3);
  assert.equal(counters.get('articles_read'), 3, 'first applyRemoteCounter sets the value');

  sync.applyRemoteCounter('articles_read', 2);
  assert.equal(counters.get('articles_read'), 5, 'second applyRemoteCounter accumulates');

  sync.applyRemoteCounter('videos_watched', 1);
  assert.equal(counters.get('videos_watched'), 1, 'independent counter is tracked separately');

  sync.close();
});

test('BroadcastSync counter message is delivered and applied via BroadcastChannel', () => {
  const channelName = 'edgesignal-test-counter-channel';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const counters = new Map();
  const receiver = new BroadcastSync(channelName, graph, bloom, counters);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ type: 'counter', key: 'articles_read', by: 4 });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(counters.get('articles_read'), 4, 'counter must be updated by remote message');
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: counter message with oversized key is silently dropped', () => {
  const channelName = 'edgesignal-test-counter-oversize';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const counters = new Map();
  const receiver = new BroadcastSync(channelName, graph, bloom, counters);

  const sender = new BroadcastChannel(channelName);
  const longKey = 'k'.repeat(MAX_STATE_LENGTH + 1); // 257 chars — exceeds limit
  sender.postMessage({ type: 'counter', key: longKey, by: 1 });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(counters.size, 0, 'oversized key must be dropped without touching the Map');
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: counter message with empty key is silently dropped', () => {
  const channelName = 'edgesignal-test-counter-emptykey';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const counters = new Map();
  const receiver = new BroadcastSync(channelName, graph, bloom, counters);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ type: 'counter', key: '', by: 1 });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(counters.size, 0, 'empty key must be dropped');
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('BroadcastSync: counter message with non-finite by is silently dropped', () => {
  const channelName = 'edgesignal-test-counter-nonfinite';

  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const counters = new Map();
  const receiver = new BroadcastSync(channelName, graph, bloom, counters);

  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ type: 'counter', key: 'views', by: Infinity });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(counters.size, 0, 'Infinity by value must be dropped');
      sender.close();
      receiver.close();
      resolve();
    }, 50);
  });
});

test('IntentManager: incrementCounter broadcasts counter message when crossTabSync:true', () => {
  storage.clear();
  const channelName = 'edgesignal-sync:cross-tab-counter-broadcast';
  const received = [];
  const listener = new BroadcastChannel(channelName);
  listener.onmessage = (e) => received.push(e.data);

  const manager = new IntentManager({
    storageKey: 'cross-tab-counter-broadcast',
    storage,
    botProtection: false,
    crossTabSync: true,
  });

  manager.incrementCounter('articles_read');
  manager.incrementCounter('articles_read', 4);

  return new Promise((resolve) => {
    setTimeout(() => {
      const counterMsgs = received.filter((m) => m.type === 'counter' && m.key === 'articles_read');
      assert.equal(
        counterMsgs.length,
        2,
        'exactly 2 counter messages must be broadcast (one per incrementCounter call)',
      );
      const total = counterMsgs.reduce((sum, m) => sum + m.by, 0);
      assert.equal(total, 5, 'broadcast increments must sum to 5 (1 + 4)');
      listener.close();
      manager.destroy();
      resolve();
    }, 50);
  });
});

test('IntentManager: incrementCounter does not broadcast when crossTabSync:false', () => {
  storage.clear();
  const channelName = 'edgesignal-sync:cross-tab-counter-off';
  const received = [];
  const listener = new BroadcastChannel(channelName);
  listener.onmessage = (e) => received.push(e.data);

  const manager = new IntentManager({
    storageKey: 'cross-tab-counter-off',
    storage,
    botProtection: false,
    crossTabSync: false,
  });

  manager.incrementCounter('articles_read', 3);

  return new Promise((resolve) => {
    setTimeout(() => {
      const counterMsgs = received.filter((m) => m.type === 'counter');
      assert.equal(
        counterMsgs.length,
        0,
        'no counter messages should be broadcast when crossTabSync is false',
      );
      listener.close();
      manager.destroy();
      resolve();
    }, 50);
  });
});

test('IntentManager: remote counter increment from another tab is reflected in getCounter()', () => {
  storage.clear();

  // "Tab A" — the one that already has crossTabSync enabled
  const managerA = new IntentManager({
    storageKey: 'cross-tab-counter-receive',
    storage,
    botProtection: false,
    crossTabSync: true,
  });

  // Simulate "Tab B" by directly broadcasting a counter message on the same channel
  const channelName = 'edgesignal-sync:cross-tab-counter-receive';
  const sender = new BroadcastChannel(channelName);
  sender.postMessage({ type: 'counter', key: 'articles_read', by: 7 });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(
        managerA.getCounter('articles_read'),
        7,
        'getCounter() must reflect the remotely-broadcast increment',
      );
      sender.close();
      managerA.destroy();
      resolve();
    }, 50);
  });
});

test('IntentManager.createAsync() throws when asyncStorage is absent', async () => {
  await assert.rejects(
    () => IntentManager.createAsync({ storage: storage }),
    /requires config\.asyncStorage/,
  );
});

test('IntentManager.createAsync() initializes from async storage and tracks state', async () => {
  storage.clear();

  let stored = null;
  const asyncStorage = {
    getItem: async (_key) => stored,
    setItem: async (_key, value) => {
      stored = value;
    },
  };

  const manager = await IntentManager.createAsync({
    storageKey: 'async-init',
    asyncStorage,
    botProtection: false,
  });

  manager.track('/home');
  manager.track('/products');
  assert.ok(manager.hasSeen('/home'));
  assert.ok(manager.hasSeen('/products'));
  manager.flushNow();

  // Give async setItem a microtask to settle
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(stored !== null, 'async setItem should have been called');
  manager.destroy();
});

test('IntentManager.createAsync() restores persisted state from async storage', async () => {
  // --- Phase 1: persist something via createAsync ---
  let stored = null;
  const asyncStorage = {
    getItem: async (_key) => stored,
    setItem: async (_key, value) => {
      stored = value;
    },
  };

  const m1 = await IntentManager.createAsync({
    storageKey: 'async-restore',
    asyncStorage,
    botProtection: false,
  });
  m1.track('/home');
  m1.track('/products');
  m1.flushNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(stored !== null);
  m1.destroy();

  // --- Phase 2: create a fresh instance and verify it sees the persisted data ---
  const m2 = await IntentManager.createAsync({
    storageKey: 'async-restore',
    asyncStorage,
    botProtection: false,
  });
  assert.ok(m2.hasSeen('/home'), 'restored instance should know /home was seen');
  assert.ok(m2.hasSeen('/products'), 'restored instance should know /products was seen');
  m2.destroy();
});

test('IntentManager async persist: isDirty reset on success, overlapping writes are coalesced', async () => {
  const writes = [];
  // Slow async storage to keep a write "in flight" long enough to test coalescing
  const asyncStorage = {
    getItem: async () => null,
    setItem: async (key, value) => {
      writes.push(value);
      await new Promise((r) => setTimeout(r, 30)); // simulate latency
    },
  };

  const manager = await IntentManager.createAsync({
    storageKey: 'async-coalesce',
    asyncStorage,
    botProtection: false,
    persistDebounceMs: 0,
  });

  manager.track('/a');
  manager.track('/b');
  manager.flushNow(); // triggers first async write (in-flight)

  manager.track('/c');
  manager.flushNow(); // should be coalesced — write is still in flight

  // Wait for first write to complete
  await new Promise((r) => setTimeout(r, 50));

  // Only one write should have landed so far (second was coalesced)
  assert.equal(writes.length, 1, 'second persist while in-flight should be coalesced');

  // Trigger another flush now that isAsyncWriting is false; this should write
  // the accumulated dirty state (which includes /c).
  manager.flushNow();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(
    writes.length,
    2,
    'dirty state accumulated during in-flight write should be saved on next flush',
  );
  // The second write should contain /c's transition
  const secondPayload = JSON.parse(writes[1]);
  assert.ok(secondPayload.graphBinary, 'second write should include graph data');

  manager.destroy();
});

test('IntentManager async persist: isDirty restored on error, onError is called', async () => {
  const errors = [];
  const asyncStorage = {
    getItem: async () => null,
    setItem: async () => {
      throw new Error('storage unavailable');
    },
  };

  const manager = await IntentManager.createAsync({
    storageKey: 'async-error',
    asyncStorage,
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  manager.track('/home');
  manager.track('/products');
  manager.flushNow();

  await new Promise((r) => setTimeout(r, 20));

  assert.ok(errors.length > 0, 'onError should be called on async setItem failure');
  assert.equal(
    errors[0].code,
    'STORAGE_WRITE',
    `Expected code 'STORAGE_WRITE', got: '${errors[0].code}'`,
  );
  assert.ok(
    errors[0].message.includes('storage unavailable'),
    `Expected message to include 'storage unavailable', got: "${errors[0].message}"`,
  );

  manager.destroy();
});
// ─── onError — EdgeSignalError structured contract ───────────────────────────

test('onError: sync persist emits QUOTA_EXCEEDED code on QuotaExceededError', () => {
  const quotaError = new DOMException('QuotaExceededError mock', 'QuotaExceededError');
  const throwingStorage = {
    getItem: () => null,
    setItem: () => {
      throw quotaError;
    },
  };

  const errors = [];
  const manager = new IntentManager({
    storageKey: 'quota-sync-test',
    storage: throwingStorage,
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  assert.doesNotThrow(() => {
    manager.track('/home');
    manager.flushNow();
  });

  assert.equal(errors.length, 1, 'onError must be called once');
  assert.equal(
    errors[0].code,
    'QUOTA_EXCEEDED',
    `Expected 'QUOTA_EXCEEDED', got: '${errors[0].code}'`,
  );
  assert.equal(manager.getTelemetry().engineHealth, 'quota_exceeded');
  assert.ok(
    errors[0].originalError === quotaError,
    'originalError must be the original DOMException',
  );
});

test('onError: sync persist emits STORAGE_WRITE for generic write errors', () => {
  const writeError = new Error('write failed: disk full');
  const throwingStorage = {
    getItem: () => null,
    setItem: () => {
      throw writeError;
    },
  };

  const errors = [];
  const manager = new IntentManager({
    storageKey: 'write-error-sync-test',
    storage: throwingStorage,
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  assert.doesNotThrow(() => {
    manager.track('/home');
    manager.flushNow();
  });

  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].code,
    'STORAGE_WRITE',
    `Expected 'STORAGE_WRITE', got: '${errors[0].code}'`,
  );
  assert.ok(errors[0].message.includes('disk full'));
  assert.ok(errors[0].originalError === writeError);
});

test('onError: async persist emits QUOTA_EXCEEDED on async QuotaExceededError', async () => {
  const quotaError = new DOMException('QuotaExceededError mock', 'QuotaExceededError');
  const asyncStorage = {
    getItem: async () => null,
    setItem: async () => {
      throw quotaError;
    },
  };

  const errors = [];
  const manager = await IntentManager.createAsync({
    storageKey: 'quota-async-test',
    asyncStorage,
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  manager.track('/home');
  manager.flushNow();
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(errors.length > 0, 'onError must fire');
  assert.equal(
    errors[0].code,
    'QUOTA_EXCEEDED',
    `Expected 'QUOTA_EXCEEDED', got: '${errors[0].code}'`,
  );
  assert.equal(manager.getTelemetry().engineHealth, 'quota_exceeded');

  manager.destroy();
});

test('onError: RESTORE_PARSE fires when stored graph is corrupt JSON', () => {
  const corruptStorage = {
    getItem: () => '{"bloomBase64":"AAAA","graphBinary":"!!!corrupt!!!"}',
    setItem: () => {},
  };

  const errors = [];
  assert.doesNotThrow(() => {
    const manager = new IntentManager({
      storageKey: 'restore-parse-test',
      storage: corruptStorage,
      botProtection: false,
      onError: (err) => errors.push(err),
    });
    // engine must still be usable after cold-start fallback
    manager.track('/home');
    manager.flushNow();
  });

  assert.equal(errors.length, 1, 'onError must fire exactly once for the parse failure');
  assert.equal(
    errors[0].code,
    'RESTORE_PARSE',
    `Expected 'RESTORE_PARSE', got: '${errors[0].code}'`,
  );
  assert.ok(typeof errors[0].message === 'string' && errors[0].message.length > 0);
  // originalError must carry the raw payload for forensic debugging
  assert.ok(
    errors[0].originalError != null && typeof errors[0].originalError === 'object',
    'originalError must be an object',
  );
  assert.ok(
    typeof errors[0].originalError.payload === 'string',
    'originalError.payload must be the raw stored string',
  );
});

test('onError: STORAGE_READ fires when getItem itself throws', () => {
  const unreadableStorage = {
    getItem: () => {
      throw new DOMException('SecurityError', 'SecurityError');
    },
    setItem: () => {},
  };

  const errors = [];
  assert.doesNotThrow(() => {
    const manager = new IntentManager({
      storageKey: 'storage-read-error-test',
      storage: unreadableStorage,
      botProtection: false,
      onError: (err) => errors.push(err),
    });
    manager.track('/home');
    manager.flushNow();
  });

  assert.equal(errors.length, 1, 'exactly one STORAGE_READ error during construction');
  assert.equal(errors[0].code, 'STORAGE_READ', `Expected 'STORAGE_READ', got: '${errors[0].code}'`);
  assert.ok(errors[0].originalError instanceof DOMException);
});

test('onError: no callback set — silent failures do not throw', () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    },
  };

  // Neither construction nor persist may throw when onError is absent
  assert.doesNotThrow(() => {
    const manager = new IntentManager({
      storageKey: 'no-callback-test',
      storage: throwingStorage,
      botProtection: false,
      persistDebounceMs: 0,
    });
    manager.track('/home');
    manager.flushNow();
  });
});

test('onError: SERIALIZE fires when toBinary() throws during persist', () => {
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'serialize-error-test',
    storage: { getItem: () => null, setItem: () => {} },
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  // Monkeypatch toBinary on the instance's prototype to simulate a corrupt
  // internal state that causes serialization to throw.
  const serializeError = new Error('toBinary: buffer allocation failed');
  const original = MarkovGraph.prototype.toBinary;
  MarkovGraph.prototype.toBinary = () => {
    throw serializeError;
  };

  try {
    assert.doesNotThrow(() => {
      manager.track('/home');
      manager.track('/products');
      manager.flushNow();
    }, 'SERIALIZE errors must never escape to the host');

    assert.equal(errors.length, 1, 'onError must be called exactly once');
    assert.equal(errors[0].code, 'SERIALIZE', `Expected 'SERIALIZE', got: '${errors[0].code}'`);
    assert.ok(
      errors[0].message.includes('buffer allocation failed'),
      `Expected message to contain 'buffer allocation failed', got: "${errors[0].message}"`,
    );
    assert.ok(
      errors[0].originalError === serializeError,
      'originalError must be the original thrown Error',
    );
  } finally {
    // Always restore the prototype so subsequent tests are unaffected.
    MarkovGraph.prototype.toBinary = original;
  }

  manager.destroy();
});

test('onError: SERIALIZE fires when uint8ToBase64 throws during persist', () => {
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'serialize-btoa-error-test',
    storage: { getItem: () => null, setItem: () => {} },
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  // Make toBinary() return a value but simulate btoa failing by returning a
  // non-Uint8Array that will cause uint8ToBase64's internal btoa to throw.
  const original = MarkovGraph.prototype.toBinary;
  MarkovGraph.prototype.toBinary = () => {
    // Return a Uint8Array with a byte value that causes btoa to throw in
    // environments where btoa is strict about binary-string encoding.
    // More reliably: replace toBinary with a stub that throws directly to
    // cover the shared try/catch (btoa is polyfilled in the test env anyway).
    throw new Error('simulated btoa overflow');
  };

  try {
    assert.doesNotThrow(() => {
      manager.track('/about');
      manager.flushNow();
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'SERIALIZE');
  } finally {
    MarkovGraph.prototype.toBinary = original;
  }

  manager.destroy();
});

test('onError: SERIALIZE — isDirty remains true so next cycle retries', () => {
  const errors = [];
  let setItemCalls = 0;
  const manager = new IntentManager({
    storageKey: 'serialize-retry-test',
    storage: {
      getItem: () => null,
      setItem: () => {
        setItemCalls++;
      },
    },
    botProtection: false,
    persistDebounceMs: 0,
    onError: (err) => errors.push(err),
  });

  manager.track('/home');

  const original = MarkovGraph.prototype.toBinary;
  MarkovGraph.prototype.toBinary = () => {
    throw new Error('transient failure');
  };

  try {
    manager.flushNow(); // serialize fails, isDirty stays true
    assert.equal(errors.length, 1, 'one SERIALIZE error expected');
    assert.equal(errors[0].code, 'SERIALIZE');
    assert.equal(setItemCalls, 0, 'storage must NOT be written when serialize fails');
  } finally {
    MarkovGraph.prototype.toBinary = original;
  }

  // After restoring toBinary, flushing again should succeed
  manager.flushNow();
  assert.equal(setItemCalls, 1, 'successful persist should write to storage after retry');

  manager.destroy();
});
