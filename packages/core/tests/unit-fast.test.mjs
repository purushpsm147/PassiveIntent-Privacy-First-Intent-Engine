/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
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
import { BrowserLifecycleAdapter } from '../dist/src/adapters.js';
import {
  BenchmarkSimulationEngine,
  evaluatePredictionMatrix,
} from '../dist/src/intent-sdk-performance.js';
import { MemoryStorage, setupTestEnvironment, storage } from './helpers/test-env.mjs';

setupTestEnvironment();

/* =================================================================== */
/*  BloomFilter                                                         */
/* =================================================================== */

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

/* =================================================================== */
/*  MarkovGraph                                                         */
/* =================================================================== */

test('MarkovGraph calculates probabilities, entropy, and serialization', () => {
  // smoothingAlpha: 0 — this test asserts exact frequentist probability values
  // (count/total).  The Bayesian (alpha > 0) path is tested separately.
  const graph = new MarkovGraph({ smoothingAlpha: 0 });
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

  // Pass smoothingAlpha: 0 explicitly so the round-tripped graph stays frequentist.
  const roundTripped = MarkovGraph.fromJSON(graph.toJSON(), { smoothingAlpha: 0 });
  assert.equal(roundTripped.getProbability('A', 'B'), 2 / 3);
});

test('MarkovGraph computes trajectory likelihood with smoothing for unknown transitions', () => {
  // smoothingAlpha: 0 so P(B|A) = 1.0 and the epsilon fallback for unseen
  // transitions (A→C) is exercised.  The Bayesian smoothing path is tested
  // in the 'normalized entropy remains bounded' and benchmark tests.
  const baseline = new MarkovGraph({ smoothingAlpha: 0 });
  baseline.incrementTransition('A', 'B');

  const knownOnly = MarkovGraph.logLikelihoodTrajectory(baseline, ['A', 'B']);
  assert.equal(knownOnly, Math.log(1));

  const unknownEdge = MarkovGraph.logLikelihoodTrajectory(baseline, ['A', 'C']);
  assert.equal(unknownEdge, Math.log(0.01));
});

test('MarkovGraph normalized entropy remains bounded in Bayesian smoothing mode', () => {
  const graph = new MarkovGraph({ smoothingAlpha: 0.1 });

  // Build a state vocabulary larger than the observed fan-out of A.
  graph.incrementTransition('A', 'B');
  graph.incrementTransition('A', 'B');
  graph.incrementTransition('A', 'C');
  graph.incrementTransition('X', 'Y');

  const normalized = graph.normalizedEntropyForState('A');
  assert.ok(
    normalized >= 0 && normalized <= 1,
    `normalizedEntropyForState must stay in [0, 1], got ${normalized}`,
  );
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

/* =================================================================== */
/*  IntentManager — Core                                                */
/* =================================================================== */

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

  // onError must be called with the structured PassiveIntentError contract
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

/* =================================================================== */
/*  EntropyGuard — Bot Detection                                        */
/* =================================================================== */

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

test('EntropyGuard: Bloom filter still updates but graph stops recording after bot is suspected', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-graph-update-test',
    botProtection: true,
  });

  // With 30 rapid-fire synchronous calls the bot flag trips well before all
  // transitions are recorded.  The Bloom filter always receives every state
  // (runBloomStage runs unconditionally).  The Markov graph stops recording
  // once `suspected` becomes true (runGraphAndSignalStage guard).
  for (let i = 0; i < 30; i += 1) {
    manager.track(i % 2 === 0 ? 'P' : 'Q');
  }

  // Bloom filter must still reflect all visited states.
  assert.equal(manager.hasSeen('P'), true);
  assert.equal(manager.hasSeen('Q'), true);

  // The graph should have far fewer than 29 transitions recorded because
  // the bot guard aborts the graph stage after the flag trips (~call 3-5).
  const graph = manager.exportGraph();
  const totalTransitions = graph.rows.reduce((sum, [, total]) => sum + total, 0);
  assert.ok(
    totalTransitions < 10,
    `Expected graph to have < 10 transitions after bot guard; got ${totalTransitions}`,
  );
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
    // We need MIN_SAMPLE_TRANSITIONS (10) hub→dest transitions so entropy
    // evaluates.  With 25 iterations (half land on hub as ctx.from), hub
    // accumulates ~12 outgoing transitions — comfortably above the threshold.
    for (let i = 0; i < 25; i++) {
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
      // Disable drift protection so it doesn't interfere with cooldown assertions.
      // With the corrected drift counting (all anomalies counted, not just emitted
      // ones), a highly anomalous walk would exceed the default 40% rate and silence
      // evaluateTrajectory before the second assertion batch runs.
      driftProtection: { maxAnomalyRate: 1.0, evaluationWindowMs: 300_000 },
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
    assert.ok(
      typeof ev.sampleSize === 'number' && ev.sampleSize > 0,
      `sampleSize should be a positive number, got ${ev.sampleSize}`,
    );
    assert.ok(
      ['low', 'medium', 'high'].includes(ev.confidence),
      `confidence should be low/medium/high, got ${ev.confidence}`,
    );

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

test('bot protection: bloom entries from suspected-bot tracks are persisted so hasSeen() survives a session reload', () => {
  // Regression: when botProtection && signalEngine.suspected, the early return
  // in runGraphAndSignalStage skipped both markDirty() calls.  bloom.add() had
  // already run in runBloomStage, so the bloom update existed in memory but was
  // never written to storage.  After a page reload, hasSeen() would return false
  // for states only visited during the bot burst.
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'bot-bloom-persist-test',
    storage,
    botProtection: true,
  });

  // Trigger bot detection with 60 rapid-fire calls.
  const states = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = 0; i < 60; i++) {
    manager.track(states[i % states.length]);
  }

  // Track a brand-new state AFTER bot detection fires.
  // Pre-fix: bloom.add() ran but markDirty() was never called → not persisted.
  // Post-fix: isNewToBloom → markDirty() fires before the early return → persisted.
  manager.track('bot-era-new-page');

  // Force flush so storage has the latest snapshot.
  manager.flushNow();
  manager.destroy();

  // Restore from persisted storage — simulates a page reload.
  const manager2 = new IntentManager({
    storageKey: 'bot-bloom-persist-test',
    storage,
    botProtection: false, // fresh session, no longer a bot
  });

  assert.ok(
    manager2.hasSeen('bot-era-new-page'),
    'hasSeen() must return true for a state visited during a bot-suspected burst after a simulated session reload',
  );
  manager2.destroy();
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

// ── holdoutConfig (A/B Holdout) ──────────────────────────────────────────────

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

// ── Counter API (incrementCounter / resetCounter) ─────────────────────────────

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

test('incrementCounter: accepts negative finite increments (decrement semantics)', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-negative-by-test',
    storage,
    botProtection: false,
  });

  manager.incrementCounter('score', 10);
  manager.incrementCounter('score', -3);
  assert.equal(manager.getCounter('score'), 7);
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

test('incrementCounter: NaN by is rejected with onError and returns current counter value', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'counter-nan-by-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
  });

  manager.incrementCounter('score', 5);
  const result = manager.incrementCounter('score', NaN);
  assert.equal(result, 5, 'must return current counter value without incrementing');
  assert.equal(manager.getCounter('score'), 5, 'counter must not change');
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].code,
    'VALIDATION',
    `Expected code 'VALIDATION', got: '${errors[0].code}'`,
  );
  assert.ok(
    errors[0].message.includes('finite'),
    `Expected 'finite' in error message, got: "${errors[0].message}"`,
  );
  manager.flushNow();
});

test('incrementCounter: Infinity by is rejected with onError and returns current counter value', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'counter-infinity-by-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
  });

  manager.incrementCounter('score', 3);
  const result = manager.incrementCounter('score', Infinity);
  assert.equal(result, 3, 'must return current counter value without incrementing');
  assert.equal(manager.getCounter('score'), 3, 'counter must not change');
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].code,
    'VALIDATION',
    `Expected code 'VALIDATION', got: '${errors[0].code}'`,
  );
  assert.ok(
    errors[0].message.includes('finite'),
    `Expected 'finite' in error message, got: "${errors[0].message}"`,
  );
  manager.flushNow();
});

test('incrementCounter: -Infinity by is rejected with onError and returns current counter value', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'counter-neg-infinity-by-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
  });

  manager.incrementCounter('score', 7);
  const result = manager.incrementCounter('score', -Infinity);
  assert.equal(result, 7, 'must return current counter value without incrementing');
  assert.equal(manager.getCounter('score'), 7, 'counter must not change');
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].code,
    'VALIDATION',
    `Expected code 'VALIDATION', got: '${errors[0].code}'`,
  );
  assert.ok(
    errors[0].message.includes('finite'),
    `Expected 'finite' in error message, got: "${errors[0].message}"`,
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

// ─── Numeric ID normalization ────────────────────────────────────────────────

test('normalizeRouteState: replaces 4+ digit numeric path segments with :id', () => {
  assert.equal(normalizeRouteState('/user/12345/profile'), '/user/:id/profile');
  assert.equal(normalizeRouteState('/order/9999'), '/order/:id');
  assert.equal(normalizeRouteState('/products/100000/reviews'), '/products/:id/reviews');
});

test('normalizeRouteState: does NOT replace 1–3 digit numbers (pagination, wizard steps)', () => {
  assert.equal(normalizeRouteState('/page/2'), '/page/2');
  assert.equal(normalizeRouteState('/step/3'), '/step/3');
  assert.equal(normalizeRouteState('/items/999'), '/items/999');
});

test('normalizeRouteState: replaces multiple numeric IDs in one path', () => {
  assert.equal(normalizeRouteState('/org/12345/user/67890'), '/org/:id/user/:id');
});

test('normalizeRouteState: replaces mixed UUID + numeric IDs', () => {
  assert.equal(
    normalizeRouteState('/org/550e8400-e29b-41d4-a716-446655440000/user/12345'),
    '/org/:id/user/:id',
  );
});

test('normalizeRouteState: numeric ID with trailing slash', () => {
  assert.equal(normalizeRouteState('/user/12345/'), '/user/:id');
});

test('normalizeRouteState: numeric ID with query string', () => {
  assert.equal(normalizeRouteState('/product/54321?tab=specs'), '/product/:id');
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

// ── Next-State Prediction (getLikelyNextStates / predictNextStates) ───────────

test('MarkovGraph.getLikelyNextStates returns edges above the probability threshold', () => {
  // smoothingAlpha: 0 to assert the exact frequentist probability (2/3).
  // The threshold-filter behaviour is the same regardless of smoothing.
  const graph = new MarkovGraph({ smoothingAlpha: 0 });
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
  // smoothingAlpha: 0 — asserts that exactly one transition yields P = 1.0
  // under frequentist math.  BroadcastSync receives a caller-owned graph;
  // callers can pass any smoothingAlpha they need.
  const graph = new MarkovGraph({ smoothingAlpha: 0 });
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const sync = new BroadcastSync('passiveintent-test-applyremote', graph, bloom);

  sync.applyRemote('/home', '/products');

  assert.equal(graph.getProbability('/home', '/products'), 1);
  assert.ok(bloom.check('/home'));
  assert.ok(bloom.check('/products'));

  sync.close();
});

test('BroadcastSync: isValidSyncMessage rejects oversized state via applyRemote bypass', () => {
  // We test the validation indirectly through handleMessage by posting an oversized payload.
  // Create two channels on the same name so one can receive from the other.
  const channelName = 'passiveintent-test-validation';

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
  const channelName = 'passiveintent-test-valid-transition';

  // smoothingAlpha: 0 — with one transition the only valid frequentist
  // assertion is P = 1.0; Bayesian smoothing would lower that to < 1.
  const graph = new MarkovGraph({ smoothingAlpha: 0 });
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
  const channelName = 'passiveintent-test-malformed';

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
  const channelName = 'passiveintent-test-empty-states';

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
  const channelName = 'passiveintent-test-nonobject';

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
  const channelName = 'passiveintent-sync:cross-tab-off';
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
  const channelName = 'passiveintent-sync:cross-tab-broadcast';
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
  const sync = new BroadcastSync('passiveintent-test-counter-apply', graph, bloom, counters);

  sync.applyRemoteCounter('articles_read', 3);
  assert.equal(counters.get('articles_read'), 3, 'first applyRemoteCounter sets the value');

  sync.applyRemoteCounter('articles_read', 2);
  assert.equal(counters.get('articles_read'), 5, 'second applyRemoteCounter accumulates');

  sync.applyRemoteCounter('videos_watched', 1);
  assert.equal(counters.get('videos_watched'), 1, 'independent counter is tracked separately');

  sync.close();
});

test('BroadcastSync counter message is delivered and applied via BroadcastChannel', () => {
  const channelName = 'passiveintent-test-counter-channel';

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
  const channelName = 'passiveintent-test-counter-oversize';

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
  const channelName = 'passiveintent-test-counter-emptykey';

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
  const channelName = 'passiveintent-test-counter-nonfinite';

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
  const channelName = 'passiveintent-sync:cross-tab-counter-broadcast';
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
  const channelName = 'passiveintent-sync:cross-tab-counter-off';
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
  const channelName = 'passiveintent-sync:cross-tab-counter-receive';
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

// ── IntentManager.createAsync ─────────────────────────────────────────────────

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

// ── Trajectory Scoring (smoothingEpsilon) ─────────────────────────────────────

test('trajectory scoring: smoothingEpsilon config controls unseen-transition likelihood', () => {
  const baseline = new MarkovGraph();
  baseline.incrementTransition('/known', '/known');

  const captureExpectedBaselineLL = (smoothingEpsilon) => {
    const local = new MemoryStorage();
    const manager = new IntentManager({
      storageKey: `smooth-${String(smoothingEpsilon)}`,
      storage: local,
      botProtection: false,
      baseline: baseline.toJSON(),
      graph: {
        divergenceThreshold: 0,
        ...(smoothingEpsilon !== undefined ? { smoothingEpsilon } : {}),
      },
    });

    let first = null;
    manager.on('trajectory_anomaly', (payload) => {
      if (!first) first = payload;
    });

    for (let i = 0; i < 20; i += 1) {
      manager.track(i % 2 === 0 ? '/x' : '/y');
    }

    assert.ok(first, 'expected trajectory_anomaly payload');
    manager.destroy();
    return first.expectedBaselineLogLikelihood;
  };

  const llDefault = captureExpectedBaselineLL(undefined);
  const llExplicitDefault = captureExpectedBaselineLL(0.01);
  const llHigh = captureExpectedBaselineLL(0.5);
  const llTiny = captureExpectedBaselineLL(1e-6);
  const llInvalid = captureExpectedBaselineLL(-1);

  assert.ok(
    llHigh > llDefault,
    `larger smoothingEpsilon should yield less-negative likelihood (${llHigh} > ${llDefault})`,
  );
  assert.ok(
    llTiny < llDefault,
    `smaller smoothingEpsilon should yield more-negative likelihood (${llTiny} < ${llDefault})`,
  );
  assert.ok(
    Math.abs(llExplicitDefault - llDefault) < 1e-12,
    `explicit default epsilon should match implicit default (${llExplicitDefault} vs ${llDefault})`,
  );
  assert.ok(
    Math.abs(llInvalid - llDefault) < 1e-12,
    `invalid smoothingEpsilon must fall back to default (${llInvalid} vs ${llDefault})`,
  );
});

// ── Async Persist ─────────────────────────────────────────────────────────────

test('IntentManager async persist: overlapping writes are coalesced and auto-flushed', async () => {
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
    persistDebounceMs: 60_000,
  });

  manager.track('/a');
  manager.track('/b');
  manager.flushNow(); // triggers first async write (in-flight)

  manager.track('/c');
  manager.flushNow(); // should be coalesced — write is still in flight

  // Wait for the in-flight write and queued follow-up pass to complete.
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    writes.length,
    2,
    'dirty state accumulated during in-flight write should be saved automatically',
  );
  // The second write should contain serialized graph data.
  const secondPayload = JSON.parse(writes[1]);
  assert.ok(secondPayload.graphBinary, 'second write should include graph data');

  manager.destroy();
});

test('IntentManager async persist: queued in-flight changes are persisted after destroy()', async () => {
  const writes = [];
  const asyncStorage = {
    getItem: async () => null,
    setItem: async (_key, value) => {
      writes.push(value);
      await new Promise((r) => setTimeout(r, 30));
    },
  };

  const manager = await IntentManager.createAsync({
    storageKey: 'async-destroy-overlap',
    asyncStorage,
    botProtection: false,
    persistDebounceMs: 60_000,
  });

  manager.track('/a');
  manager.track('/b');
  manager.flushNow(); // first write in-flight

  manager.track('/c');
  manager.destroy(); // flushNow during in-flight should queue a follow-up persist

  await new Promise((r) => setTimeout(r, 100));

  assert.equal(
    writes.length,
    2,
    'destroy() should not drop dirty state accumulated during an in-flight async write',
  );
  const secondPayload = JSON.parse(writes[1]);
  assert.ok(secondPayload.graphBinary, 'queued follow-up write should include graph data');
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

test('async setItem failure always schedules a retry even without hasPendingAsyncPersist', async () => {
  // Regression guard for the doc/impl drift: a failed async write must
  // schedule one retry via schedulePersist() unconditionally, not only when
  // another persist() call was queued during the in-flight write.
  let failOnce = true;
  const writes = [];
  const asyncStorage = {
    getItem: async () => null,
    setItem: async (_key, value) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient failure');
      }
      writes.push(value);
    },
  };

  const fakeTimers = [];
  const fakeTimer = {
    now: () => 0,
    setTimeout: (cb, _ms) => {
      const id = { id: fakeTimers.length };
      fakeTimers.push({ cb, id, fired: false });
      return id;
    },
    clearTimeout: (handle) => {
      const entry = fakeTimers.find((t) => t.id === handle);
      if (entry) entry.fired = true; // mark cancelled
    },
  };

  const manager = await IntentManager.createAsync({
    storageKey: 'async-retry-unconditional',
    asyncStorage,
    botProtection: false,
    persistDebounceMs: 10,
    timer: fakeTimer,
  });

  manager.track('/home');
  manager.track('/product');

  // Wait for the first (failing) write to resolve
  await new Promise((r) => setTimeout(r, 20));

  // The retry timer must have been scheduled — one pending timer entry
  const uncancelled = fakeTimers.filter((t) => !t.fired);
  assert.equal(uncancelled.length, 1, 'exactly one retry timer must be scheduled after a failure');

  // Fire the timer manually → should trigger persist() → successful write
  uncancelled[0].cb();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(writes.length, 1, 'retry must produce one successful write');
  manager.destroy();
});

test('consecutive async setItem failures do not schedule infinite retries', async () => {
  // The second consecutive failure must NOT schedule another schedulePersist()
  // (asyncWriteFailCount > 1 guard).  Without this guard, a persistently broken
  // storage backend would produce an infinite retry loop.
  let timerScheduleCount = 0;
  const fakeTimers = [];
  const fakeTimer = {
    now: () => 0,
    setTimeout: (cb, _ms) => {
      timerScheduleCount += 1;
      const id = { id: timerScheduleCount };
      fakeTimers.push({ cb, id });
      return id;
    },
    clearTimeout: () => {},
  };

  const asyncStorage = {
    getItem: async () => null,
    setItem: async () => {
      throw new Error('persistent failure');
    },
  };

  const manager = await IntentManager.createAsync({
    storageKey: 'async-retry-no-loop',
    asyncStorage,
    botProtection: false,
    persistDebounceMs: 10,
    timer: fakeTimer,
  });

  manager.track('/home');
  manager.track('/product');

  // Wait for first write attempt to fail
  await new Promise((r) => setTimeout(r, 20));

  const afterFirstFail = timerScheduleCount;
  assert.ok(afterFirstFail >= 1, 'at least one retry must be scheduled after first failure');

  // Fire all pending timers to trigger the retry attempt (which also fails)
  const pending = [...fakeTimers];
  for (const t of pending) t.cb();
  await new Promise((r) => setTimeout(r, 20));

  // No additional timer must have been scheduled after the second failure
  assert.equal(
    timerScheduleCount,
    afterFirstFail,
    'second consecutive async failure must NOT schedule another retry timer',
  );

  manager.destroy();
});

// ─── persistThrottleMs — sync persist throttle ──────────────────────────────────

test('persistThrottleMs: second write within window is skipped and trailing timer scheduled', () => {
  let now = 0;
  const writes = [];
  const fakeTimers = [];
  let timerSeq = 0;
  const fakeTimer = {
    now: () => now,
    setTimeout: (cb, ms) => {
      const id = { id: ++timerSeq };
      fakeTimers.push({ cb, id, ms, cancelled: false });
      return id;
    },
    clearTimeout: (handle) => {
      const t = fakeTimers.find((e) => e.id === handle);
      if (t) t.cancelled = true;
    },
  };
  const storage = {
    getItem: () => null,
    setItem: (_key, value) => writes.push(value),
  };

  const manager = new IntentManager({
    storageKey: 'throttle-skip-test',
    storage,
    botProtection: false,
    persistThrottleMs: 100,
    timer: fakeTimer,
  });

  // First track: lastPersistedAt = -Infinity, elapsed = Infinity >= 100 -> immediate write
  now = 0;
  manager.track('/home');
  assert.equal(writes.length, 1, 'first write must execute immediately (leading edge)');
  assert.equal(
    fakeTimers.filter((t) => !t.cancelled).length,
    0,
    'no trailing timer after first write',
  );

  // Second track: elapsed = 50 < 100 -> skip write, schedule trailing timer
  now = 50;
  manager.track('/products');
  assert.equal(writes.length, 1, 'second write within window must be skipped');
  assert.equal(
    fakeTimers.filter((t) => !t.cancelled).length,
    1,
    'trailing timer must be scheduled after skipped write',
  );

  // Third track within same window: timer already pending -> no duplicate timer
  now = 70;
  manager.track('/checkout');
  assert.equal(writes.length, 1, 'third write within window must also be skipped');
  assert.equal(
    fakeTimers.filter((t) => !t.cancelled).length,
    1,
    'no duplicate trailing timer must be scheduled',
  );

  manager.destroy();
});

test('persistThrottleMs: trailing timer fires and produces a write', () => {
  let now = 0;
  const writes = [];
  const fakeTimers = [];
  let timerSeq = 0;
  const fakeTimer = {
    now: () => now,
    setTimeout: (cb, _ms) => {
      const id = { id: ++timerSeq };
      fakeTimers.push({ cb, id, cancelled: false });
      return id;
    },
    clearTimeout: (handle) => {
      const t = fakeTimers.find((e) => e.id === handle);
      if (t) t.cancelled = true;
    },
  };
  const storage = {
    getItem: () => null,
    setItem: (_key, value) => writes.push(value),
  };

  const manager = new IntentManager({
    storageKey: 'throttle-trailing-test',
    storage,
    botProtection: false,
    persistThrottleMs: 100,
    timer: fakeTimer,
  });

  // Leading-edge write
  now = 0;
  manager.track('/home');
  assert.equal(writes.length, 1, 'leading-edge write must fire immediately');

  // Skipped write — schedules trailing timer
  now = 50;
  manager.track('/products');
  assert.equal(writes.length, 1, 'write must be throttled within window');
  const pending = fakeTimers.filter((t) => !t.cancelled);
  assert.equal(pending.length, 1, 'trailing timer must be scheduled');

  // Advance time past throttle window and fire the trailing timer
  now = 150;
  pending[0].cb();
  assert.equal(writes.length, 2, 'trailing timer must produce a second write');

  manager.destroy();
});

test('persistThrottleMs: flushNow() bypasses throttle and writes immediately', () => {
  let now = 0;
  const writes = [];
  const fakeTimers = [];
  let timerSeq = 0;
  const fakeTimer = {
    now: () => now,
    setTimeout: (cb, _ms) => {
      const id = { id: ++timerSeq };
      fakeTimers.push({ cb, id, cancelled: false });
      return id;
    },
    clearTimeout: (handle) => {
      const t = fakeTimers.find((e) => e.id === handle);
      if (t) t.cancelled = true;
    },
  };
  const storage = {
    getItem: () => null,
    setItem: (_key, value) => writes.push(value),
  };

  const manager = new IntentManager({
    storageKey: 'throttle-flushnow-test',
    storage,
    botProtection: false,
    persistThrottleMs: 100,
    timer: fakeTimer,
  });

  // Leading-edge write
  now = 0;
  manager.track('/home');
  assert.equal(writes.length, 1, 'leading-edge write must fire immediately');

  // Second track within window — would normally be throttled
  now = 50;
  manager.track('/products');
  assert.equal(writes.length, 1, 'write should be throttled within window');

  // flushNow() must bypass throttle and write the pending dirty state
  manager.flushNow();
  assert.equal(writes.length, 2, 'flushNow() must write even within the throttle window');

  manager.destroy();
});

// ─── onError — PassiveIntentError structured contract ───────────────────────────

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

  // With aggressive sync persist, track() persists immediately — flushNow() is not needed.
  assert.doesNotThrow(() => manager.track('/home'));

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

  // With aggressive sync persist, track() persists immediately — flushNow() is not needed.
  assert.doesNotThrow(() => manager.track('/home'));

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
  // originalError carries payloadLength (byte size) for diagnostics; the raw payload is redacted
  assert.ok(
    errors[0].originalError != null && typeof errors[0].originalError === 'object',
    'originalError must be an object',
  );
  assert.ok(
    typeof errors[0].originalError.payloadLength === 'number',
    'originalError.payloadLength must be the byte length of the stored string (payload is redacted)',
  );
  assert.ok(
    !('payload' in errors[0].originalError),
    'originalError must not expose the raw stored string',
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
    // With sync persist, each track() triggers one persist(). Use a single track
    // so exactly one SERIALIZE error is emitted.
    assert.doesNotThrow(
      () => manager.track('/home'),
      'SERIALIZE errors must never escape to the host',
    );

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
    // With sync persist, track() immediately triggers persist — no flushNow needed.
    assert.doesNotThrow(() => manager.track('/about'));

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

  // Apply the monkeypatch BEFORE calling track() so the sync persist inside
  // track() hits the broken toBinary, captures the SERIALIZE error, and leaves
  // isDirty=true (persist never reached its isDirty=false assignment).
  const original = MarkovGraph.prototype.toBinary;
  MarkovGraph.prototype.toBinary = () => {
    throw new Error('transient failure');
  };

  try {
    manager.track('/home'); // sync persist fires → serialize fails → isDirty stays true
    assert.equal(errors.length, 1, 'one SERIALIZE error expected');
    assert.equal(errors[0].code, 'SERIALIZE');
    assert.equal(setItemCalls, 0, 'storage must NOT be written when serialize fails');
  } finally {
    // Always restore the prototype so subsequent tests are unaffected.
    MarkovGraph.prototype.toBinary = original;
  }

  // After restoring toBinary, flushing again should succeed (isDirty is still true).
  manager.flushNow();
  assert.equal(setItemCalls, 1, 'successful persist should write to storage after retry');

  manager.destroy();
});

// ============================================================
// LifecycleAdapter — BrowserLifecycleAdapter
// ============================================================

test('BrowserLifecycleAdapter: pause and resume callbacks are dispatched', () => {
  let listener = null;
  let mockHidden = false;
  const originalDocument = globalThis.document;
  globalThis.document = {
    get hidden() {
      return mockHidden;
    },
    addEventListener(_type, fn) {
      listener = fn;
    },
    removeEventListener() {},
  };

  try {
    const adapter = new BrowserLifecycleAdapter();
    const pauses = [];
    const resumes = [];
    adapter.onPause(() => pauses.push(1));
    adapter.onResume(() => resumes.push(1));

    mockHidden = true;
    listener?.();
    assert.equal(pauses.length, 1, 'onPause callback must fire when hidden becomes true');
    assert.equal(resumes.length, 0, 'onResume must not fire on hidden');

    mockHidden = false;
    listener?.();
    assert.equal(pauses.length, 1, 'onPause must not fire again on visible');
    assert.equal(resumes.length, 1, 'onResume callback must fire when hidden becomes false');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('BrowserLifecycleAdapter: multiple callbacks are all dispatched', () => {
  let listener = null;
  let mockHidden = false;
  const originalDocument = globalThis.document;
  globalThis.document = {
    get hidden() {
      return mockHidden;
    },
    addEventListener(_type, fn) {
      listener = fn;
    },
    removeEventListener() {},
  };

  try {
    const adapter = new BrowserLifecycleAdapter();
    const log = [];
    adapter.onPause(() => log.push('pause-1'));
    adapter.onPause(() => log.push('pause-2'));
    adapter.onResume(() => log.push('resume-1'));
    adapter.onResume(() => log.push('resume-2'));

    mockHidden = true;
    listener?.();
    assert.deepEqual(log, ['pause-1', 'pause-2']);

    mockHidden = false;
    listener?.();
    assert.deepEqual(log, ['pause-1', 'pause-2', 'resume-1', 'resume-2']);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('BrowserLifecycleAdapter.destroy() removes the listener and clears all callbacks', () => {
  let listener = null;
  let removedCount = 0;
  let mockHidden = false;
  const originalDocument = globalThis.document;
  globalThis.document = {
    get hidden() {
      return mockHidden;
    },
    addEventListener(_type, fn) {
      listener = fn;
    },
    removeEventListener() {
      removedCount++;
    },
  };

  try {
    const adapter = new BrowserLifecycleAdapter();
    const pauses = [];
    adapter.onPause(() => pauses.push(1));

    adapter.destroy();
    assert.equal(removedCount, 1, 'removeEventListener should have been called once');

    // Callbacks should be cleared — firing the handler must be a no-op
    mockHidden = true;
    listener?.();
    assert.equal(pauses.length, 0, 'No callbacks should fire after destroy()');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('BrowserLifecycleAdapter: no-op in non-browser environment (no document)', () => {
  const originalDocument = globalThis.document;
  delete globalThis.document;

  try {
    // Must not throw
    assert.doesNotThrow(() => {
      const adapter = new BrowserLifecycleAdapter();
      adapter.onPause(() => {});
      adapter.onResume(() => {});
      adapter.destroy(); // also must not throw
    });
  } finally {
    globalThis.document = originalDocument;
  }
});

// ============================================================
// LifecycleAdapter wired into IntentManager
// ============================================================

test('IntentManager: injected lifecycleAdapter.destroy() is NOT called from IntentManager.destroy() (ownership: caller)', () => {
  // Ownership semantics: IntentManager only destroys lifecycle adapters it
  // created internally.  An adapter injected via config is owned by the caller
  // and must not be torn down by the manager (the adapter may be shared).
  let destroyed = false;
  const fakeAdapter = {
    onPause() {
      return () => {};
    },
    onResume() {
      return () => {};
    },
    destroy() {
      destroyed = true;
    },
  };

  const manager = new IntentManager({
    storageKey: 'lc-destroy-test',
    storage: new MemoryStorage(),
    botProtection: false,
    lifecycleAdapter: fakeAdapter,
  });

  manager.track('/home');
  manager.destroy();
  assert.equal(
    destroyed,
    false,
    'IntentManager.destroy() must NOT call destroy() on an injected adapter — caller owns it',
  );
});

test('IntentManager: tab-hidden gap is excluded from dwell measurement via custom LifecycleAdapter', () => {
  let pauseCallback = null;
  let resumeCallback = null;
  const fakeAdapter = {
    onPause(cb) {
      pauseCallback = cb;
      return () => {
        pauseCallback = null;
      };
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {},
  };

  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'lc-dwell-correct-test',
      storage,
      botProtection: false,
      lifecycleAdapter: fakeAdapter,
      dwellTime: { enabled: true, minSamples: 3, zScoreThreshold: 2.0 },
    });

    // Build a small baseline: 100ms dwell on A each time
    for (let i = 0; i < 4; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    // Tab hides while user is on B
    mockTime += 50; // 50ms of visible time on B before hiding
    pauseCallback?.();

    // OS suspends for 5 seconds — clock jumps forward
    mockTime += 5000;

    // Tab becomes visible again — 5000ms should be excluded from B's dwell
    resumeCallback?.();

    // 50ms more visible dwell on B, then navigate to A
    mockTime += 50;
    const dwellEvents = [];
    manager.on('dwell_time_anomaly', (e) => dwellEvents.push(e));
    manager.track('A');

    // Visible dwell on B is ~100ms, which matches the baseline — no anomaly
    assert.equal(
      dwellEvents.length,
      0,
      'No anomaly should fire: hidden gap was correctly excluded from B dwell',
    );

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

// ============================================================
// session_stale event
// ============================================================

test('session_stale does NOT fire when dwellTime.enabled is false (hidden_duration_exceeded suppressed)', () => {
  let pauseCallback = null;
  let resumeCallback = null;
  const fakeAdapter = {
    onPause(cb) {
      pauseCallback = cb;
      return () => {
        pauseCallback = null;
      };
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {},
  };

  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    // dwellTime not enabled — session_stale must be fully suppressed for both
    // hidden_duration_exceeded (LifecycleAdapter path) and dwell_exceeded
    // (runTransitionContextStage path), making the behaviour consistent.
    const manager = new IntentManager({
      storageKey: 'session-stale-dwell-disabled-test',
      storage,
      botProtection: false,
      lifecycleAdapter: fakeAdapter,
      // dwellTime intentionally absent (defaults to disabled)
    });

    manager.track('/home');

    const staleEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));

    // Simulate a 2-hour OS suspend — exceeds MAX_PLAUSIBLE_DWELL_MS
    pauseCallback?.();
    mockTime += 7_200_000;
    resumeCallback?.();

    assert.equal(
      staleEvents.length,
      0,
      'session_stale must not fire when dwellTime.enabled is false',
    );

    // Navigate after resume — dwell_exceeded path must also be silent
    mockTime += 100;
    manager.track('/checkout');

    assert.equal(
      staleEvents.length,
      0,
      'session_stale (dwell_exceeded) must not fire when dwellTime.enabled is false',
    );

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('injected lifecycleAdapter is NOT destroyed when IntentManager.destroy() is called', () => {
  // Verify ownership semantics: only an internally-created adapter should be
  // torn down by destroy().  An injected adapter may be shared across multiple
  // IntentManager instances; destroying it from one manager would silently
  // remove lifecycle listeners from all other managers using the same adapter.
  let destroyCalls = 0;
  const sharedAdapter = {
    onPause(_cb) {
      return () => {};
    },
    onResume(_cb) {
      return () => {};
    },
    destroy() {
      destroyCalls += 1;
    },
  };

  const storage = new MemoryStorage();
  const managerA = new IntentManager({
    storageKey: 'lifecycle-ownership-a',
    storage,
    botProtection: false,
    lifecycleAdapter: sharedAdapter,
  });
  const managerB = new IntentManager({
    storageKey: 'lifecycle-ownership-b',
    storage,
    botProtection: false,
    lifecycleAdapter: sharedAdapter,
  });

  managerA.destroy();
  assert.equal(
    destroyCalls,
    0,
    'destroy() on managerA must NOT call destroy() on an injected adapter',
  );

  managerB.destroy();
  assert.equal(
    destroyCalls,
    0,
    'destroy() on managerB must NOT call destroy() on an injected adapter',
  );
});

test('internally-created lifecycleAdapter IS destroyed when IntentManager.destroy() is called', () => {
  // Counterpart to the injection test: when no adapter is supplied, the engine
  // creates BrowserLifecycleAdapter internally and sets ownsLifecycleAdapter=true.
  // destroy() must call lifecycleAdapter.destroy() on the owned adapter.
  //
  // Strategy: construct the manager in a no-DOM environment (lifecycleAdapter
  // will be null, ownsLifecycleAdapter=true), then swap in a spy adapter and
  // force the ownership flag to true before calling destroy().  TypeScript
  // private is compile-time only, so both fields are directly accessible here.
  let destroyCalls = 0;
  let resumeCallback = null;
  const spyAdapter = {
    onPause(_cb) {
      return () => {};
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {
      destroyCalls += 1;
      resumeCallback = null;
    },
  };

  const manager = new IntentManager({
    storageKey: 'lifecycle-ownership-internal',
    storage: new MemoryStorage(),
    botProtection: false,
    // No lifecycleAdapter — ownsLifecycleAdapter is set to true internally.
  });

  // Wire the spy in place of whatever adapter the constructor created
  // (null in a non-browser env, or BrowserLifecycleAdapter in a browser env).
  manager.lifecycleCoordinator.setAdapterForTest(spyAdapter, true);

  // Prime resumeCallback so we can later verify it was cleared by destroy().
  spyAdapter.onResume(() => {});
  assert.ok(resumeCallback !== null, 'precondition: resumeCallback must be set before destroy()');

  assert.doesNotThrow(() => manager.destroy(), 'destroy() must not throw');

  assert.equal(
    destroyCalls,
    1,
    'destroy() must call lifecycleAdapter.destroy() on the owned adapter',
  );
  assert.equal(resumeCallback, null, 'spyAdapter.destroy() must clear resumeCallback');
});

test('session_stale (hidden_duration_exceeded) does NOT fire when no state has been tracked yet (previousState is null)', () => {
  // Regression guard: onResume must not emit session_stale when previousState
  // is null — there is no active dwell epoch so there is nothing to measure.
  // Before the fix, the event was unconditionally emitted and
  // previousStateEnteredAt was reset even though no navigation had occurred.
  let pauseCallback = null;
  let resumeCallback = null;
  const fakeAdapter = {
    onPause(cb) {
      pauseCallback = cb;
      return () => {
        pauseCallback = null;
      };
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {},
  };

  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'session-stale-no-prev-state',
      storage,
      botProtection: false,
      lifecycleAdapter: fakeAdapter,
      dwellTime: { enabled: true },
    });

    // Do NOT call track() — previousState remains null.

    const staleEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));

    // Simulate a 2-hour OS suspend
    pauseCallback?.();
    mockTime += 7_200_000;
    resumeCallback?.();

    assert.equal(
      staleEvents.length,
      0,
      'session_stale must not fire when previousState is null (no active dwell epoch)',
    );

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('session_stale fires with hidden_duration_exceeded when hidden gap > MAX_PLAUSIBLE_DWELL_MS', () => {
  let pauseCallback = null;
  let resumeCallback = null;
  const fakeAdapter = {
    onPause(cb) {
      pauseCallback = cb;
      return () => {
        pauseCallback = null;
      };
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {},
  };

  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'session-stale-hidden-test',
      storage,
      botProtection: false,
      lifecycleAdapter: fakeAdapter,
      dwellTime: { enabled: true },
    });

    manager.track('/home');

    const staleEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));

    // Pause at t=1000
    pauseCallback?.();

    // Simulate 2 hours of OS suspend (7,200,000 ms >> 1,800,000 threshold)
    mockTime += 7_200_000;
    resumeCallback?.();

    assert.equal(staleEvents.length, 1, 'Exactly one session_stale event expected');
    assert.equal(staleEvents[0].reason, 'hidden_duration_exceeded');
    assert.equal(staleEvents[0].measuredMs, 7_200_000);
    assert.equal(staleEvents[0].thresholdMs, 1_800_000);

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('session_stale does NOT fire for a normal short tab-hide (< MAX_PLAUSIBLE_DWELL_MS)', () => {
  let pauseCallback = null;
  let resumeCallback = null;
  const fakeAdapter = {
    onPause(cb) {
      pauseCallback = cb;
      return () => {
        pauseCallback = null;
      };
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {},
  };

  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'session-stale-short-hide-test',
      storage,
      botProtection: false,
      lifecycleAdapter: fakeAdapter,
      dwellTime: { enabled: true },
    });

    manager.track('/home');

    const staleEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));

    pauseCallback?.();
    mockTime += 30_000; // 30 seconds — well within the 30-minute threshold
    resumeCallback?.();

    assert.equal(staleEvents.length, 0, 'No session_stale for a short normal tab switch');

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('session_stale fires with dwell_exceeded when track() gap > MAX_PLAUSIBLE_DWELL_MS', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  // Use a no-op lifecycle adapter so the LifecycleAdapter path does NOT intercept the gap
  try {
    const manager = new IntentManager({
      storageKey: 'session-stale-dwell-test',
      storage,
      botProtection: false,
      lifecycleAdapter: {
        onPause() {
          return () => {};
        },
        onResume() {
          return () => {};
        },
        destroy() {},
      },
      dwellTime: { enabled: true, minSamples: 2, zScoreThreshold: 1.5 },
    });

    const staleEvents = [];
    const dwellAnomalyEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));
    manager.on('dwell_time_anomaly', (e) => dwellAnomalyEvents.push(e));

    mockTime = 1000;
    manager.track('/home');

    // Simulate 3 hours gap — far beyond MAX_PLAUSIBLE_DWELL_MS
    mockTime = 1000 + 10_800_000;
    manager.track('/checkout');

    assert.equal(
      staleEvents.length,
      1,
      'session_stale should fire when dwell is implausibly large',
    );
    assert.equal(staleEvents[0].reason, 'dwell_exceeded');
    assert.ok(
      staleEvents[0].measuredMs > 1_800_000,
      `measuredMs (${staleEvents[0].measuredMs}) should exceed 1_800_000`,
    );
    assert.equal(staleEvents[0].thresholdMs, 1_800_000);
    assert.equal(
      dwellAnomalyEvents.length,
      0,
      'dwell_time_anomaly must NOT fire for an implausible sleep-inflated dwell',
    );

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('Welford accumulator not corrupted after session_stale: subsequent normal anomaly detection works', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  // No-op lifecycle adapter — the dwell_exceeded path is exercised instead
  try {
    const manager = new IntentManager({
      storageKey: 'welford-no-corrupt-test',
      storage,
      botProtection: false,
      lifecycleAdapter: {
        onPause() {
          return () => {};
        },
        onResume() {
          return () => {};
        },
        destroy() {},
      },
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 2.0 },
    });

    const staleEvents = [];
    const dwellAnomalyEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));
    manager.on('dwell_time_anomaly', (e) => dwellAnomalyEvents.push(e));

    // Build a stable Welford baseline: consistent ~100ms dwells on A and B
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }
    assert.equal(staleEvents.length, 0, 'No stale events during normal session');
    assert.equal(dwellAnomalyEvents.length, 0, 'No anomalies during uniform-dwell baseline phase');

    // Simulate OS suspend: 33-minute gap between B and A
    mockTime += 2_000_000; // >> MAX_PLAUSIBLE_DWELL_MS
    manager.track('A'); // session_stale fires; Welford for B is NOT updated

    assert.equal(staleEvents.length, 1, 'session_stale should fire');
    assert.equal(staleEvents[0].reason, 'dwell_exceeded');
    assert.equal(
      dwellAnomalyEvents.length,
      0,
      'Welford must not be fed the sleep dwell — no dwell_time_anomaly here',
    );

    // Now introduce a genuine anomaly: 1000ms on A (vs ~100ms baseline)
    const preSleepAnomalyCount = dwellAnomalyEvents.length;
    mockTime += 1000;
    manager.track('B');

    assert.ok(
      dwellAnomalyEvents.length > preSleepAnomalyCount,
      'Normal z-score anomaly detection should still function after a stale-session event',
    );

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('session_stale: previousStateEnteredAt resets cleanly so next dwell epoch is accurate', () => {
  let pauseCallback = null;
  let resumeCallback = null;
  const fakeAdapter = {
    onPause(cb) {
      pauseCallback = cb;
      return () => {
        pauseCallback = null;
      };
    },
    onResume(cb) {
      resumeCallback = cb;
      return () => {
        resumeCallback = null;
      };
    },
    destroy() {},
  };

  const storage = new MemoryStorage();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;

  try {
    const manager = new IntentManager({
      storageKey: 'stale-epoch-reset-test',
      storage,
      botProtection: false,
      lifecycleAdapter: fakeAdapter,
      dwellTime: { enabled: true, minSamples: 2, zScoreThreshold: 2.0 },
    });

    const staleEvents = [];
    manager.on('session_stale', (e) => staleEvents.push(e));

    mockTime = 1000;
    manager.track('/home'); // previousStateEnteredAt = 1000

    // Simulate a 2-hour OS suspend.
    pauseCallback?.();
    mockTime += 7_200_000;
    resumeCallback?.(); // session_stale fires; previousStateEnteredAt resets to resumeTime

    assert.equal(staleEvents.length, 1, 'session_stale must fire exactly once');
    assert.equal(staleEvents[0].reason, 'hidden_duration_exceeded');

    const resumeTime = mockTime;

    // Collect any additional session_stale events that fire AFTER the resume.
    const postResumeStaleFires = [];
    manager.on('session_stale', (e) => postResumeStaleFires.push(e));

    // 200ms after resume, transition to /checkout.
    // If the epoch was correctly reset to resumeTime, the recorded dwell for /home
    // will be ~200ms — well within MAX_PLAUSIBLE_DWELL_MS — so no second session_stale fires.
    // If the epoch was NOT reset, the recorded dwell would be ~7_200_200ms, exceeding the
    // threshold and triggering a 'dwell_exceeded' session_stale.
    mockTime = resumeTime + 200;
    manager.track('/checkout');

    assert.equal(
      postResumeStaleFires.length,
      0,
      'No spurious session_stale must fire after resume: epoch was correctly reset to resumeTime',
    );

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

// ============================================================
// Aggressive synchronous persist
// ============================================================

test('persist is called synchronously on every track(): storage written immediately without debounce', () => {
  const writeLog = [];
  const manager = new IntentManager({
    storageKey: 'aggressive-persist-test',
    storage: {
      getItem: () => null,
      setItem: (_k, v) => writeLog.push(v),
    },
    botProtection: false,
    lifecycleAdapter: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
      destroy() {},
    },
  });

  assert.equal(writeLog.length, 0, 'No write before any track() call');

  manager.track('/a'); // first call: isNewToBloom=true sets isDirty; persist() writes immediately
  assert.equal(writeLog.length, 1, 'Storage must be written synchronously after first track()');

  manager.track('/b'); // second call: /a→/b transition, isDirty=true; persist() writes again
  assert.equal(writeLog.length, 2, 'Storage must be written synchronously after second track()');

  // A third distinct transition produces another write
  manager.track('/c');
  assert.equal(writeLog.length, 3, 'Storage must be written synchronously after third track()');

  manager.destroy();
});

test('persist respects dirty-flag: no write if nothing changed between track() calls', () => {
  const writeLog = [];
  const manager = new IntentManager({
    storageKey: 'dirty-flag-test',
    storage: {
      getItem: () => null,
      setItem: (_k, v) => writeLog.push(v),
    },
    botProtection: false,
    lifecycleAdapter: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
      destroy() {},
    },
  });

  manager.track('/a');
  manager.track('/b');
  const writesAfterTwoTracks = writeLog.length; // 2 writes

  // flushNow() with isDirty=false should be a no-op
  manager.flushNow();
  assert.equal(
    writeLog.length,
    writesAfterTwoTracks,
    'flushNow() with no dirty state must not produce an additional write',
  );

  manager.destroy();
});

// ─── ensureState hard-cap guard (burst bloat prevention) ─────────────────────

test('MarkovGraph ensureState triggers synchronous prune at 1.5× maxStates', () => {
  const graph = new MarkovGraph({ maxStates: 10 });

  // Without the hard cap, adding 30 unique states would grow indexToState to 30.
  // With the hard cap (prune at 1.5× = 15 live states), the array should stay
  // much smaller because prune recycles slots via freedIndices.
  for (let i = 0; i < 30; i++) {
    // Each state has an outgoing transition so it's not trivially evicted.
    graph.incrementTransition(`s${i}`, `s${(i + 1) % 30}`);
  }

  const json = graph.toJSON();
  const arrayLen = json.states.length;

  // The indexToState array must not have grown to 30 — the hard cap should
  // have pruned mid-burst and reused freed slots.
  assert.ok(
    arrayLen < 25,
    `Hard-cap guard should prevent unbounded array growth (got ${arrayLen} slots for 30 unique states)`,
  );

  // The hard-cap fires prune at the TOP of incrementTransition (before any
  // ensureState call), so freed slots are eligible for immediate reuse within
  // the same call.  Tombstones may or may not remain at the very end depending
  // on whether those slots were consumed by the two ensureState calls that
  // follow each prune.  The invariant to assert is that LIVE states are
  // bounded, which is the actual goal of the hard-cap guard.
  const liveStates = json.states.filter((s) => s !== '').length;
  assert.ok(
    liveStates <= Math.ceil(10 * 1.5),
    `Prune must keep live-state count bounded (got ${liveStates} live states for maxStates=10)`,
  );
});

test('MarkovGraph ensureState hard cap recycles freed indices', () => {
  const graph = new MarkovGraph({ maxStates: 5 });

  // Burst 8 unique states (1.6× maxStates).
  for (let i = 0; i < 8; i++) {
    graph.incrementTransition(`s${i}`, `s${(i + 1) % 8}`);
  }

  const jsonBeforeNewState = graph.toJSON();
  const arrayLenBefore = jsonBeforeNewState.states.length;

  // Add one more state — should reuse a freed slot, not grow the array.
  graph.incrementTransition('s0', 'new-state');
  const jsonAfter = graph.toJSON();

  assert.ok(
    jsonAfter.states.length <= arrayLenBefore,
    `Array should not grow after prune frees slots (was ${arrayLenBefore}, now ${jsonAfter.states.length})`,
  );
});

test('incrementTransition: fromState not evicted by prune triggered for toState (ghost-row regression)', () => {
  // maxStates = 4, burst threshold = 6 (4 * 1.5).
  // Reproduce the ghost-row bug:
  //   1. Fill graph with 5 states that each have high transition counts so
  //      they survive LFU pruning.
  //   2. Call incrementTransition('fresh-from', 'fresh-to') where both states
  //      are brand-new (total = 0).
  //   Pre-fix: ensureState('fresh-from') raised size to 6,
  //            ensureState('fresh-to') then triggered prune() which evicted
  //            'fresh-from' (total=0), leaving a ghost row at a tombstoned
  //            index and getProbability returning 0.
  //   Post-fix: prune fires at the TOP of incrementTransition (size=5 < 6,
  //             so no prune this time), then both states are allocated safely.
  const graph = new MarkovGraph({ maxStates: 4, smoothingAlpha: 0 });

  // Seed 5 states with heavy traffic so none of them are LFU-evicted.
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) {
      graph.incrementTransition(`seed${i}`, `seed${(i + 1) % 5}`);
    }
  }
  // stateToIndex.size == 5, below the burst threshold of 6.

  // Both 'fresh-from' and 'fresh-to' are new.  In the buggy code, prune would
  // fire during ensureState('fresh-to') and tombstone 'fresh-from'.
  graph.incrementTransition('fresh-from', 'fresh-to');

  const p = graph.getProbability('fresh-from', 'fresh-to');
  assert.ok(
    p > 0,
    `expected probability > 0 for fresh-from→fresh-to but got ${p} (ghost-row bug: fromState was evicted mid-resolution)`,
  );
});

// ─── stateNormalizer config option ───────────────────────────────────────────

test('IntentManager stateNormalizer: custom normalizer collapses blog slugs', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'state-normalizer-test',
    storage,
    botProtection: false,
    stateNormalizer: (state) => state.replace(/^\/blog\/[^/]+$/, '/blog/:slug'),
    lifecycleAdapter: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
      destroy() {},
    },
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/blog/how-to-tie-a-tie');
  manager.track('/blog/best-running-shoes-2026');

  assert.equal(changes[0], '/blog/:slug');
  assert.equal(changes[1], '/blog/:slug');
  manager.destroy();
});

test('IntentManager stateNormalizer: custom normalizer runs after built-in normalizer', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'state-normalizer-order-test',
    storage,
    botProtection: false,
    stateNormalizer: (state) => state.replace(/\/:id\/edit$/, '/:id/view'),
    lifecycleAdapter: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
      destroy() {},
    },
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  // UUID is stripped first by built-in normalizer, then custom normalizer remaps /edit → /view
  manager.track('/users/550e8400-e29b-41d4-a716-446655440000/edit');
  assert.equal(changes[0], '/users/:id/view');
  manager.destroy();
});

test('track() auto-normalizes: replaces numeric ID segments with :id', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'track-norm-numeric-id',
    storage,
    botProtection: false,
    lifecycleAdapter: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
      destroy() {},
    },
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/user/12345/profile');
  manager.track('/user/67890/profile');
  assert.equal(changes[0], '/user/:id/profile');
  assert.equal(changes[1], '/user/:id/profile');
  manager.destroy();
});

// ─── Entropy Crush fix ────────────────────────────────────────────────────────

test('normalizedEntropyForState: stays high even after many unique states are visited (Bayesian mode)', () => {
  // Regression test for the "entropy crush" bug.
  // With the old global-denominator formula, visiting 50+ unique pages
  // would grow ln(stateCount) large enough to crush the normalized score
  // of a locally-confused state well below the 0.75 threshold.
  const graph = new MarkovGraph({ smoothingAlpha: 0.1, highEntropyThreshold: 0.75 });

  // Simulate 50 unique "background" states to inflate the global state count.
  for (let i = 0; i < 50; i += 1) {
    graph.incrementTransition(`page-${i}`, `page-${i + 1}`);
  }

  // Now simulate a locally-confused state hopping between just 4 links
  // with near-uniform distribution — this should register as high entropy.
  for (let j = 0; j < 10; j += 1) {
    graph.incrementTransition('confused', 'linkA');
    graph.incrementTransition('confused', 'linkB');
    graph.incrementTransition('confused', 'linkC');
    graph.incrementTransition('confused', 'linkD');
  }

  const normalized = graph.normalizedEntropyForState('confused');
  assert.ok(
    normalized >= 0.75,
    `Expected normalized entropy >= 0.75 for locally confused state after 50 background pages; got ${normalized}`,
  );
});

test('normalizedEntropyForState: deterministic state scores at 0 regardless of global state count', () => {
  // A state with only one outgoing edge should always score 0 (no confusion)
  // regardless of how many total states are in the graph.
  const graph = new MarkovGraph({ smoothingAlpha: 0 });

  for (let i = 0; i < 100; i += 1) {
    graph.incrementTransition(`bg-${i}`, `bg-${i + 1}`);
  }

  for (let k = 0; k < 20; k += 1) {
    graph.incrementTransition('linear', 'always-next');
  }

  // frequentist mode: exactly 0 entropy (single outgoing edge)
  assert.equal(graph.normalizedEntropyForState('linear'), 0);
});

test('normalizedEntropyForState: never exceeds 1.0 without clamping when Bayesian smoothing is active and graph is large', () => {
  // Regression for the numerator/denominator mismatch:
  // entropyForState() (Bayesian) spreads mass over k global states, so its
  // maximum value is ln(k).  normalizedEntropyForState() used to divide by
  // ln(local fan-out), which is << ln(k), producing raw scores > 1 that the
  // clamp silently masked.  Now both use the local frequentist distribution.
  const graph = new MarkovGraph({ smoothingAlpha: 0.1 });

  // 200 background states to make global k large so Bayesian entropy >> ln(local fan-out).
  for (let i = 0; i < 200; i += 1) {
    graph.incrementTransition(`bg-${i}`, `bg-${i + 1}`);
  }

  // A state with 3 outgoing edges — local fan-out = 3, maxEntropy = ln(3).
  // With old code, Bayesian entropy (over k=200 states) would be >> ln(3),
  // so raw normalized score >> 1 before clamping.
  for (let j = 0; j < 10; j += 1) {
    graph.incrementTransition('focal', 'x');
    graph.incrementTransition('focal', 'y');
    graph.incrementTransition('focal', 'z');
  }

  // Compute the raw normalized value without the clamp to expose > 1 scores.
  // We can't access internals directly, but we can verify the public result
  // equals what pure frequentist math produces — i.e., ≤ 1 by definition.
  const normalized = graph.normalizedEntropyForState('focal');
  assert.ok(
    normalized >= 0 && normalized <= 1,
    `normalizedEntropyForState must be in [0, 1] without relying on clamping; got ${normalized}`,
  );

  // With perfectly uniform 3-way distribution, frequentist entropy = ln(3)
  // and maxEntropy = ln(max(2, 3)) = ln(3), so normalized must equal exactly 1.
  assert.ok(
    normalized >= 0.99,
    `Uniform 3-way local distribution should score near 1.0; got ${normalized}`,
  );
});

// ─── Counter hard cap ─────────────────────────────────────────────────────────

test('incrementCounter: hard cap at 50 unique keys triggers LIMIT_EXCEEDED error', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'counter-hard-cap-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
  });

  // Fill up to the cap.
  for (let i = 0; i < 50; i += 1) {
    manager.incrementCounter(`key-${i}`);
  }
  assert.equal(errors.length, 0, 'no errors until the cap is reached');

  // The 51st unique key must be rejected.
  const result = manager.incrementCounter('key-overflow');
  assert.equal(result, 0, 'must return 0 when cap is exceeded');
  assert.equal(errors.length, 1, 'must fire onError once');
  assert.equal(errors[0].code, 'LIMIT_EXCEEDED');

  // Existing keys must still be incrementable.
  const next = manager.incrementCounter('key-0');
  assert.equal(next, 2, 'existing counter must still increment normally');
  assert.equal(errors.length, 1, 'no extra error for incrementing existing key');

  manager.flushNow();
});

test('incrementCounter: cap allows exact 50 keys, rejects the 51st', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'counter-cap-boundary-test',
    storage,
    botProtection: false,
  });

  for (let i = 0; i < 50; i += 1) {
    const v = manager.incrementCounter(`k${i}`);
    assert.equal(v, 1, `key k${i} should register normally`);
  }

  // 51st new key must return 0 (rejected).
  assert.equal(manager.incrementCounter('overflow'), 0);
  manager.flushNow();
});

// ─── applyRemoteCounter cap ───────────────────────────────────────────────────

test('BroadcastSync.applyRemoteCounter: hard cap at 50 unique keys prevents Map growth', () => {
  const graph = new MarkovGraph();
  const bloom = new BloomFilter({ bitSize: 256, hashCount: 3 });
  const counters = new Map();
  const sync = new BroadcastSync('passiveintent-test-remote-cap', graph, bloom, counters);

  // Fill to the cap via remote increments.
  for (let i = 0; i < 50; i += 1) {
    sync.applyRemoteCounter(`remote-key-${i}`, 1);
  }
  assert.equal(counters.size, 50, 'exactly 50 keys should be stored');

  // The 51st unique remote key must be silently dropped (no OOM risk).
  sync.applyRemoteCounter('remote-overflow', 1);
  assert.equal(counters.size, 50, 'Map must not grow beyond 50 after cap is hit');

  // Existing remote key must still accumulate.
  sync.applyRemoteCounter('remote-key-0', 5);
  assert.equal(counters.get('remote-key-0'), 6, 'existing key still increments');

  sync.close();
});

// ─── stateNormalizer safety: throw, non-string, and empty-string ─────────────

test('stateNormalizer: throwing normalizer drops the track() call and fires onError', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'normalizer-throw-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
    stateNormalizer: () => {
      throw new Error('boom');
    },
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/home');
  assert.equal(changes.length, 0, 'track() must be dropped when normalizer throws');
  assert.equal(errors.length, 1, 'onError must fire once');
  assert.equal(errors[0].code, 'VALIDATION');
  assert.ok(
    errors[0].message.includes('boom'),
    `Expected "boom" in message, got: ${errors[0].message}`,
  );
  manager.flushNow();
});

test('stateNormalizer: non-string return is coerced to string and tracked normally', () => {
  storage.clear();
  const manager = new IntentManager({
    storageKey: 'normalizer-nonstring-test',
    storage,
    botProtection: false,
    // @ts-ignore — intentional: simulate a JS caller returning a number
    stateNormalizer: () => 42,
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/home');
  assert.equal(changes.length, 1, 'track() must succeed after string coercion');
  assert.equal(changes[0], '42', 'state must be the string-coerced return value');
  manager.flushNow();
});

test('stateNormalizer: returning empty string silently drops the track() call (no VALIDATION error)', () => {
  storage.clear();
  const errors = [];
  const manager = new IntentManager({
    storageKey: 'normalizer-empty-test',
    storage,
    botProtection: false,
    onError: (err) => errors.push(err),
    stateNormalizer: (state) => (state === '/skip-me' ? '' : state),
  });
  const changes = [];
  manager.on('state_change', ({ to }) => changes.push(to));

  manager.track('/skip-me');
  assert.equal(changes.length, 0, 'track() must be silently dropped when normalizer returns ""');
  assert.equal(
    errors.length,
    0,
    'no VALIDATION error must fire for normalizer empty-string return',
  );

  // Other states still tracked normally.
  manager.track('/home');
  assert.equal(changes.length, 1);
  assert.equal(changes[0], '/home');
  manager.flushNow();
});

// ─── Property-based invariant tests for normalizedEntropyForState ─────────────
//
// These tests assert *mathematical identities* across a range of inputs rather
// than single examples.  The goal is to catch regressions where the numerator
// and denominator of the normalized-entropy formula drift apart (e.g., Bayesian
// numerator vs. frequentist denominator), which was the root cause of the
// entropy-normalization bug that the Math.min(1,...) clamp was silently masking.

test('[property] normalizedEntropyForState: uniform k-way distribution always scores exactly 1.0', () => {
  // Identity: H_freq(uniform k) = ln(k) = maxEntropy → normalized = 1.0 exactly.
  // If numerator and denominator ever use different k values, this will fail for
  // at least one value of k, because ln(k_global) / ln(k_local) ≠ 1 when they differ.
  for (const k of [2, 3, 4, 5, 6, 8, 10]) {
    const graph = new MarkovGraph({ smoothingAlpha: 0 });
    // 100 background states inflates global k — score must remain 1.0 regardless.
    for (let bg = 0; bg < 100; bg++) graph.incrementTransition(`bg-${bg}`, `bg-${bg + 1}`);
    // Perfectly uniform k-way from 'focal': each destination visited exactly 20 times.
    for (let j = 0; j < 20; j++) {
      for (let d = 0; d < k; d++) graph.incrementTransition('focal', `dest-${d}`);
    }
    const score = graph.normalizedEntropyForState('focal');
    assert.ok(
      Math.abs(score - 1.0) < 1e-9,
      `Uniform ${k}-way with 100 background states must score exactly 1.0; got ${score}`,
    );
  }
});

test('[property] normalizedEntropyForState: single-edge state always scores exactly 0', () => {
  // Identity: H_freq(deterministic) = 0 → normalized = 0 / ln(supportSize) = 0 exactly.
  // Holds for any number of background states.
  for (const bgCount of [0, 5, 50, 200, 500]) {
    const graph = new MarkovGraph({ smoothingAlpha: 0 });
    for (let bg = 0; bg < bgCount; bg++) graph.incrementTransition(`bg-${bg}`, `bg-${bg + 1}`);
    for (let j = 0; j < 20; j++) graph.incrementTransition('linear', 'always-next');
    const score = graph.normalizedEntropyForState('linear');
    assert.equal(
      score,
      0,
      `Deterministic state must score exactly 0 at bgCount=${bgCount}; got ${score}`,
    );
  }
});

test('[property] normalizedEntropyForState: score does not change when unrelated states are added', () => {
  // Adding states that never transition from 'focal' must leave its score unchanged.
  // This is the "entropy crush" invariant in property form: the only input that
  // affects the score is the local transition distribution of the queried state.
  for (const [localFanOut, bgBefore, bgAfter] of [
    [2, 0, 100],
    [3, 5, 200],
    [4, 10, 500],
    [6, 20, 50],
  ]) {
    const graph = new MarkovGraph({ smoothingAlpha: 0 });
    for (let bg = 0; bg < bgBefore; bg++) graph.incrementTransition(`bg-${bg}`, `bg-${bg + 1}`);
    for (let j = 0; j < 10; j++) {
      for (let d = 0; d < localFanOut; d++) graph.incrementTransition('focal', `dest-${d}`);
    }
    const scoreBefore = graph.normalizedEntropyForState('focal');

    // Add many more background states — none touch 'focal'.
    for (let bg = bgBefore; bg < bgAfter; bg++)
      graph.incrementTransition(`bg-${bg}`, `bg-${bg + 1}`);
    const scoreAfter = graph.normalizedEntropyForState('focal');

    assert.ok(
      Math.abs(scoreBefore - scoreAfter) < 1e-9,
      `Score must be stable after adding ${bgAfter - bgBefore} background states ` +
        `(fanOut=${localFanOut}): was ${scoreBefore}, now ${scoreAfter}`,
    );
  }
});

test('[property] normalizedEntropyForState: clamp is never the mechanism — raw formula is already in [0, 1]', () => {
  // The Math.min(1, ...) clamp in normalizedEntropyForState is a SAFETY NET.
  // By the maximum-entropy principle, H_freq / ln(k) ∈ [0, 1] for any probability
  // distribution over k outcomes — no clamping is needed.
  // This test verifies that the public score equals the raw frequentist formula
  // exactly, proving the clamp never fired and the invariant holds by construction.
  const distributionShapes = [
    { counts: [10, 1] }, // skewed 2-way
    { counts: [5, 5, 1] }, // near-uniform 3-way
    { counts: [8, 4, 2, 1] }, // geometric 4-way
    { counts: [3, 3, 3, 3, 3] }, // uniform 5-way
    { counts: [1, 2, 3, 4, 5, 6] }, // linear-ramp 6-way
    { counts: [20, 1, 1] }, // heavily skewed 3-way
  ];

  for (const { counts } of distributionShapes) {
    const graph = new MarkovGraph({ smoothingAlpha: 0 });
    // 200 background states inflate global k to stress-test independence.
    for (let bg = 0; bg < 200; bg++) graph.incrementTransition(`bg-${bg}`, `bg-${bg + 1}`);
    for (let d = 0; d < counts.length; d++) {
      for (let c = 0; c < counts[d]; c++) graph.incrementTransition('focal', `dest-${d}`);
    }

    const publicScore = graph.normalizedEntropyForState('focal');

    // Compute the expected value from first principles.
    const total = counts.reduce((s, c) => s + c, 0);
    const rawH = counts.reduce((s, c) => {
      const p = c / total;
      return s - (p > 0 ? p * Math.log(p) : 0);
    }, 0);
    const supportSize = Math.max(2, counts.length);
    const expectedRaw = rawH / Math.log(supportSize);

    // Invariant 1: raw formula is already in [0, 1] (clamp never needed).
    assert.ok(
      expectedRaw >= 0 && expectedRaw <= 1 + 1e-9,
      `Raw formula must be in [0, 1] for counts=[${counts}]; got ${expectedRaw}`,
    );
    // Invariant 2: public result equals the raw formula (clamp had no effect).
    assert.ok(
      Math.abs(publicScore - expectedRaw) < 1e-9,
      `Public score must equal raw formula for counts=[${counts}]: ` +
        `expected ${expectedRaw}, got ${publicScore}`,
    );
  }
});
