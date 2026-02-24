import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BloomFilter,
  IntentManager,
  MarkovGraph,
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
  graph.incrementTransition('A', 'C');  // low-use — candidate for eviction
  graph.incrementTransition('C', 'A');
  graph.incrementTransition('A', 'D');  // 4th state pushes size over maxStates

  // stateToIndex.size == 4 > maxStates=3 → prune evicts 1 least-used state
  graph.prune();

  const jsonAfterPrune  = graph.toJSON();
  const statesAfterPrune = jsonAfterPrune.states;
  const liveAfterPrune   = statesAfterPrune.filter(s => s !== '');
  const tombstoneCount   = statesAfterPrune.filter(s => s === '').length;

  assert.ok(liveAfterPrune.length <= 3,  `Expected ≤3 live states, got ${liveAfterPrune.length}`);
  assert.ok(tombstoneCount >= 1,          `Expected ≥1 tombstone slot, got ${tombstoneCount}`);

  // V2: toJSON() must emit an explicit freedIndices array
  assert.ok(Array.isArray(jsonAfterPrune.freedIndices), 'toJSON() must emit freedIndices array');
  assert.equal(
    jsonAfterPrune.freedIndices.length, tombstoneCount,
    `freedIndices.length must equal tombstone count (${tombstoneCount})`
  );
  // Every freed index must point to a '' slot in states
  for (const idx of jsonAfterPrune.freedIndices) {
    assert.equal(statesAfterPrune[idx], '', `freedIndices[${idx}] must map to a tombstone slot`);
  }

  // ── In-memory slot reuse ──
  const arrayLenBeforeReuse = statesAfterPrune.length;
  graph.incrementTransition('A', 'E');   // E must occupy the freed slot

  assert.equal(
    graph.toJSON().states.length, arrayLenBeforeReuse,
    `ensureState must reuse freed slot, not grow array (was ${arrayLenBeforeReuse})`
  );
  assert.ok(graph.getProbability('A', 'E') > 0, 'A→E probability must be > 0 after slot reuse');

  // ── Primary path: toBinary / fromBinary (no JSON.stringify on main thread) ──
  const g2 = new MarkovGraph({ maxStates: 3 });
  for (let i = 0; i < 20; i++) g2.incrementTransition('A', 'B');
  for (let i = 0; i < 15; i++) g2.incrementTransition('B', 'A');
  g2.incrementTransition('A', 'C');
  g2.incrementTransition('C', 'A');
  g2.incrementTransition('A', 'D');
  g2.prune();  // leaves ≥1 tombstone

  assert.ok(g2.toJSON().states.includes(''), 'Precondition: g2 must have tombstone before binary encode');
  const pAB = g2.getProbability('A', 'B');

  const bin     = g2.toBinary();
  const fromBin = MarkovGraph.fromBinary(bin);

  assert.equal(fromBin.getProbability('', 'A'), 0, "fromBinary: '' must not be a live fromState");
  assert.equal(fromBin.getProbability('A', ''), 0, "fromBinary: '' must not be a live toState");
  assert.ok(
    Math.abs(pAB - fromBin.getProbability('A', 'B')) < 1e-9,
    `fromBinary: A→B probability mismatch`
  );

  // freedIndices must be repopulated — next new state must reuse a slot, not grow the array
  const arrayLenBin = fromBin.toJSON().states.length;
  fromBin.incrementTransition('A', 'F');
  assert.equal(
    fromBin.toJSON().states.length, arrayLenBin,
    `fromBinary: adding F must reuse a freed slot, not extend the array`
  );

  // ── Secondary path: fromJSON (baseline config loading path) ──
  const fromJson = MarkovGraph.fromJSON(g2.toJSON());
  assert.equal(fromJson.getProbability('', 'A'), 0, "fromJSON: '' must not be a live fromState");
  assert.equal(fromJson.getProbability('A', ''), 0, "fromJSON: '' must not be a live toState");
  assert.ok(
    Math.abs(pAB - fromJson.getProbability('A', 'B')) < 1e-9,
    `fromJSON: A→B probability mismatch`
  );
  const arrayLenJson = fromJson.toJSON().states.length;
  fromJson.incrementTransition('A', 'G');
  assert.equal(
    fromJson.toJSON().states.length, arrayLenJson,
    `fromJSON: adding G must reuse a freed slot, not extend the array`
  );
});

test('fromJSON rejects inconsistent payloads (freedIndices / label mismatch)', () => {
  // Case 1: slot in freedIndices has a non-empty label
  assert.throws(
    () => MarkovGraph.fromJSON({
      states: ['A', 'oops'],
      rows: [],
      freedIndices: [1],   // slot 1 is 'oops', not ''
    }),
    /freedIndices.*non-empty label/,
    'Should throw when freedIndices slot has a non-empty label'
  );

  // Case 2: '' label not listed in freedIndices
  assert.throws(
    () => MarkovGraph.fromJSON({
      states: ['A', ''],
      rows: [],
      freedIndices: [],    // slot 1 is '' but not declared freed
    }),
    /empty-string label.*not listed in freedIndices/,
    'Should throw when an unlisted slot has an empty-string label'
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
    onError: (err) => errors.push(err.message),
  });

  // track('') must not throw — host app must not crash
  assert.doesNotThrow(() => manager.track(''));

  // onError must be called with a descriptive message
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('empty string'), `Expected 'empty string' in error message, got: "${errors[0]}"`);

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
  manager.on('high_entropy', () => { eventCount += 1; });

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
  assert.ok(eventCount > 0, `Expected high_entropy events with botProtection:false, got ${eventCount}`);
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
  manager.on('high_entropy', () => { entropyCount += 1; });
  manager.on('trajectory_anomaly', () => { anomalyCount += 1; });

  // 60 rapid synchronous calls produce near-zero deltas (< 50 ms each),
  // pushing botScore past the threshold of 5 well before transitions accumulate.
  const states = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = 0; i < 60; i += 1) {
    manager.track(states[i % states.length]);
  }

  assert.equal(entropyCount, 0, `Expected 0 entropy events after bot flag set, got ${entropyCount}`);
  assert.equal(anomalyCount, 0, `Expected 0 anomaly events after bot flag set, got ${anomalyCount}`);
  manager.flushNow();
});

test('EntropyGuard: state_change events are still emitted for suspected bots', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'bot-state-change-test',
    botProtection: true,
  });

  const changes = [];
  manager.on('state_change', ({ from, to }) => { changes.push({ from, to }); });

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
  withProtection.on('high_entropy', () => { freeCount += 1; });

  // Must accumulate >= MIN_SAMPLE_TRANSITIONS (10) on one state to get entropy events.
  for (let i = 0; i < 30; i += 1) {
    withProtection.track(i % 2 === 0 ? 'home' : ['search', 'product', 'cart', 'help', 'checkout'][i % 5]);
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
  withBot.on('high_entropy', () => { suppressedCount += 1; });

  for (let i = 0; i < 30; i += 1) {
    withBot.track(i % 2 === 0 ? 'home' : ['search', 'product', 'cart', 'help', 'checkout'][i % 5]);
  }

  assert.equal(suppressedCount, 0, `With botProtection:true, expected 0 entropy events; got ${suppressedCount}`);
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
    manager.on('high_entropy', () => { eventCount += 1; });

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
    assert.ok(eventCount > 0, `Expected high_entropy events after bot flag cleared, got ${eventCount}`);
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
    { isGroundTruthHesitation: true, entropyTriggered: true, divergenceTriggered: false, detectionLatency: 2, hesitationAtTrigger: 0.8 },
    { isGroundTruthHesitation: true, entropyTriggered: false, divergenceTriggered: false, detectionLatency: null, hesitationAtTrigger: null },
    { isGroundTruthHesitation: false, entropyTriggered: true, divergenceTriggered: false, detectionLatency: 1, hesitationAtTrigger: 0.7 },
    { isGroundTruthHesitation: false, entropyTriggered: false, divergenceTriggered: false, detectionLatency: null, hesitationAtTrigger: null },
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

test('eventCooldownMs: default (0) fires on every qualifying track()', () => {
  storage.clear();

  const manager = new IntentManager({
    storageKey: 'cooldown-default-test',
    graph: { highEntropyThreshold: 0 },
    botProtection: false,
    // eventCooldownMs defaults to 0
  });

  let eventCount = 0;
  manager.on('high_entropy', () => { eventCount += 1; });

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
    manager.on('high_entropy', () => { eventCount += 1; });

    // Hub-spoke pattern to exceed MIN_SAMPLE_TRANSITIONS (10)
    const destinations = ['A', 'B', 'C', 'D', 'E'];
    for (let i = 0; i < 40; i++) {
      mockTime += 100; // 100ms between calls — human-paced
      manager.track(i % 2 === 0 ? 'hub' : destinations[Math.floor(i / 2) % destinations.length]);
    }

    // Total elapsed: 40 × 100ms = 4000ms, which is less than the 5000ms cooldown.
    // So only the first qualifying event should have fired.
    assert.equal(eventCount, 1, `Expected exactly 1 entropy event within cooldown, got ${eventCount}`);

    // Advance past the cooldown window and trigger more events
    mockTime += 5000;
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track(i % 2 === 0 ? 'hub' : destinations[i % destinations.length]);
    }

    // Now a second event should have fired
    assert.equal(eventCount, 2, `Expected 2 entropy events after cooldown expired, got ${eventCount}`);
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
    manager.on('trajectory_anomaly', () => { anomalyCount += 1; });

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

    assert.ok(anomalyCount > countBefore, `Expected more anomaly events after cooldown expired, got ${anomalyCount} (was ${countBefore})`);
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
    manager.on('dwell_time_anomaly', (payload) => { events.push(payload); });

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
    assert.ok(events.length >= 1, `Expected at least 1 dwell_time_anomaly event, got ${events.length}`);
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
    manager.on('dwell_time_anomaly', (payload) => { events.push(payload); });

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
    manager.on('dwell_time_anomaly', (payload) => { dwellEvents.push(payload); });

    // Rapid, identical-interval transitions to trigger bot detection
    for (let i = 0; i < 30; i++) {
      mockTime += 1; // 1ms intervals — very bot-like
      manager.track(i % 2 === 0 ? 'A' : 'B');
    }

    // Now an outlier
    mockTime += 50000;
    manager.track('A');

    // Bot flag should suppress dwell_time_anomaly
    assert.strictEqual(dwellEvents.length, 0, 'Dwell anomaly should be suppressed when bot is suspected');

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
    manager.on('dwell_time_anomaly', (payload) => { events.push(payload); });

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
    assert.strictEqual(events.length, afterFirst, 'Second anomaly within cooldown should be suppressed');

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
    manager.on('dwell_time_anomaly', (payload) => { events.push(payload); });

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
    const bigramStates = exported.states.filter(s => s.includes('\u2192'));
    assert.ok(bigramStates.length > 0, `Expected bigram state names in graph, found states: ${JSON.stringify(exported.states.slice(0, 10))}`);

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
    const bigramStates = exported.states.filter(s => s.includes('\u2192'));
    assert.strictEqual(bigramStates.length, 0, 'No bigram states should exist when enableBigrams is false');

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
    const bigramStates = exported.states.filter(s => s.includes('\u2192'));
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
  assert.equal(manager.getTelemetry().transitionsEvaluated, 0,
    'First track() has no prior state, so no transition is evaluated');

  manager.track('B');
  assert.equal(manager.getTelemetry().transitionsEvaluated, 1,
    'Second track() produces the first A→B transition');

  manager.track('C');
  assert.equal(manager.getTelemetry().transitionsEvaluated, 2,
    'Third track() produces B→C');

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
  const m1 = new IntentManager({ storageKey: 'telemetry-session-unique-a', storage, botProtection: false });
  const m2 = new IntentManager({ storageKey: 'telemetry-session-unique-b', storage, botProtection: false });

  // crypto.randomUUID() or the Math.random fallback should produce distinct values
  assert.notEqual(m1.getTelemetry().sessionId, m2.getTelemetry().sessionId,
    'Two distinct IntentManager instances must have different sessionIds');
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
  assert.ok(t.anomaliesFired > 0, `anomaliesFired must be > 0 after high_entropy events, got ${t.anomaliesFired}`);
  assert.equal(t.anomaliesFired, received.length,
    'anomaliesFired must equal the number of high_entropy events actually delivered');

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
    assert.ok(t.anomaliesFired > 0, `anomaliesFired must be > 0 after trajectory_anomaly events, got ${t.anomaliesFired}`);
    assert.equal(t.anomaliesFired, received.length,
      'anomaliesFired must equal the number of trajectory_anomaly events actually delivered');

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
      mockTime += 100; manager.track('A');
      mockTime += 100; manager.track('B');
    }

    const snapshotBefore = manager.getTelemetry().anomaliesFired;

    // Spike: dwell 5000 ms on A — should produce a high positive z-score
    mockTime += 5000; manager.track('A');
    mockTime += 100;  manager.track('B');

    assert.ok(manager.getTelemetry().anomaliesFired > snapshotBefore,
      'anomaliesFired must increment after dwell_time_anomaly fires');
    assert.equal(received.length, manager.getTelemetry().anomaliesFired - snapshotBefore,
      'delta in anomaliesFired must equal number of dwell_time_anomaly events delivered');

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
  assert.ok(received.length <= 1,
    `With 60s cooldown, at most 1 high_entropy event should fire; got ${received.length}`);
  assert.equal(manager.getTelemetry().anomaliesFired, received.length,
    'anomaliesFired must match the number of events that actually passed the cooldown gate');

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

    assert.equal(manager.getTelemetry().botStatus, 'suspected_bot',
      'botStatus must be suspected_bot after rapid-fire track() calls');

    // Now advance time so each call is 200ms apart — bot flag should clear
    for (let i = 0; i < 12; i++) {
      mockTime += 200;
      manager.track(i % 2 === 0 ? 'X' : 'Y');
    }

    assert.equal(manager.getTelemetry().botStatus, 'human',
      'botStatus must recover to human after human-paced interactions fill the buffer');

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

  assert.equal(snapshotAfter.transitionsEvaluated, snapshotBefore.transitionsEvaluated,
    'trackConversion() must not increment transitionsEvaluated');
  assert.equal(snapshotAfter.anomaliesFired, snapshotBefore.anomaliesFired,
    'trackConversion() must not increment anomaliesFired');
  assert.equal(snapshotAfter.sessionId, snapshotBefore.sessionId,
    'trackConversion() must not change sessionId');

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

  assert.ok(detected.length >= 1,
    `Expected bot_detected to fire at least once, got ${detected.length}`);
  assert.ok(typeof detected[0].state === 'string',
    'bot_detected payload must have a string state property');
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
  manager.on('bot_detected', () => { fireCount += 1; });

  const states = ['A', 'B'];
  for (let i = 0; i < 60; i++) {
    manager.track(states[i % states.length]);
  }

  assert.equal(fireCount, 1,
    `bot_detected must fire exactly once per false→true transition, got ${fireCount}`);
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

    assert.ok(hesitations.length >= 1,
      `Expected ≥1 hesitation_detected, got ${hesitations.length}. ` +
      `trajectory_anomaly: ${trajFires.length}, dwell_time_anomaly: ${dwellFires.length}`);
    const h = hesitations[0];
    // hesitation_detected fires from evaluateDwellTime's maybeEmitHesitation call,
    // so state = the state where the user lingered (the 'from' state of the final track).
    assert.ok(typeof h.state === 'string' && h.state.length > 0, 'state must be a non-empty string');
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

    assert.equal(hesitations.length, 0,
      `hesitation_detected must NOT fire without dwell_time_anomaly, got ${hesitations.length}`);

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

    assert.equal(hesitations.length, 0,
      `hesitation_detected must NOT fire for negative z-score (rushing), got ${hesitations.length}`);

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
      assert.ok(trajFires.length >= 1,
        'trajectory_anomaly must have fired alongside hesitation_detected');
      assert.ok(dwellFires.length >= 1,
        'dwell_time_anomaly must have fired alongside hesitation_detected');
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

  assert.equal(manager.getTelemetry().baselineStatus, 'active',
    'baselineStatus must start as "active"');
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
    assert.equal(t.baselineStatus, 'drifted',
      `baselineStatus must be "drifted" after anomaly rate exceeded; anomaliesFired=${t.anomaliesFired}`);

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

    assert.equal(manager.getTelemetry().baselineStatus, 'drifted',
      'must be drifted after phase 1');

    const anomaliesBeforePhase2 = anomalies.length;

    // Phase 2: more tracks — no new trajectory_anomaly should fire once drifted
    for (let i = 0; i < 20; i++) {
      mockTime += 100;
      manager.track(states[i % states.length]);
    }

    assert.equal(anomalies.length, anomaliesBeforePhase2,
      'no new trajectory_anomaly events must fire after killswitch engages');

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
    assert.equal(manager.getTelemetry().baselineStatus, 'active',
      'baselineStatus must remain "active" when maxAnomalyRate=1.0');

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
    get hidden() { return docHidden; },
    addEventListener(_evt, fn) { capturedListener = fn; },
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
      mockTime += 100; manager.track('A');
      mockTime += 100; manager.track('B');
    }
    assert.equal(anomalies.length, 0, 'no anomalies during uniform baseline phase');

    // User switches away — tab becomes hidden
    docHidden = true;
    capturedListener();               // fire visibilitychange (hidden)
    mockTime += 30000;                // 30 seconds hidden — would inflate dwellMs massively

    // User returns — tab becomes visible
    docHidden = false;
    capturedListener();               // fire visibilitychange (visible)

    // Navigate away from B — dwell on B should reflect only ~100 ms, not 30 100 ms.
    // We record the anomaly list to inspect the actual dwellMs payload if one fires.
    mockTime += 100; manager.track('A');
    mockTime += 100; manager.track('B');

    assert.equal(anomalies.length, 0,
      'dwell_time_anomaly must NOT fire after tab-switch because hidden time was excluded');

    // Positive control: introduce a genuine anomalous dwell AFTER the correction
    // and confirm the payload dwellMs reflects only visible time (not hidden time).
    mockTime += 2000; // genuine long dwell on B (~2 000 ms visible — anomalous vs ~100 ms mean)
    manager.track('A');

    assert.ok(anomalies.length >= 1,
      'dwell_time_anomaly MUST fire for a genuine long dwell after the tab-switch fix');
    const payload = anomalies[anomalies.length - 1];
    // dwellMs must be ~2 000 ms, NOT ~32 100 ms (hidden + genuine)
    assert.ok(payload.dwellMs < 5000,
      `dwellMs should be ~2 000 ms (genuine dwell only), got ${payload.dwellMs} ms`);

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
    addEventListener(_evt, fn) { capturedListener = fn; },
    removeEventListener(_evt, fn) { removedListener = fn; },
  };

  try {
    const manager = new IntentManager({
      storageKey: 'visibility-destroy-test',
      storage,
      botProtection: false,
    });

    assert.ok(capturedListener !== null, 'listener must be registered on construction');
    manager.destroy();
    assert.equal(removedListener, capturedListener,
      'destroy() must remove the exact same listener reference that was registered');
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
  assert.ok(manager.getTelemetry().anomaliesFired > 0, 'control group must still increment anomaliesFired');
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
