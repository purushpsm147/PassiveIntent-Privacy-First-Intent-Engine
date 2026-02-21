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

test('simulation engine produces benchmark and evaluation outputs', () => {
  const engine = new BenchmarkSimulationEngine();
  const summary = engine.run({
    sessions: 4,
    transitionsPerSession: 30,
    stateSpaceSize: 8,
    entropyControl: 0.3,
    mode: 'noisy',
    anomalySessionRate: 0.5,
    seed: 99,
  });

  assert.equal(summary.totalTransitions, 120);
  assert.ok(summary.cpuMsPer10kTransitions >= 0);
  assert.ok(summary.performanceReport.track.count > 0);
  assert.ok(summary.evaluation.precision >= 0);
  assert.ok(summary.evaluation.recall >= 0);
});

test('simulateScenario is deterministic with a fixed seed', () => {
  const engine = new BenchmarkSimulationEngine();
  const runA = engine.simulateScenario({
    seed: 1234,
    sessions: 5,
    transitionsPerSession: 20,
    mode: 'random',
  });
  const runB = engine.simulateScenario({
    seed: 1234,
    sessions: 5,
    transitionsPerSession: 20,
    mode: 'random',
  });

  assert.deepEqual(runA.sessionReplays, runB.sessionReplays);
  assert.deepEqual(runA.evaluation, runB.evaluation);
});

test('baseline trajectory sessions keep anomaly false positive rate below 0.1', () => {
  const states = ['A', 'B', 'C', 'D', 'E', 'F'];
  const baseline = new MarkovGraph();
  for (let i = 0; i < states.length; i += 1) {
    baseline.incrementTransition(states[i], states[(i + 1) % states.length]);
  }

  let anomalies = 0;
  const sessions = 20;
  for (let session = 0; session < sessions; session += 1) {
    // Create a fresh IntentManager per session for proper isolation
    const manager = new IntentManager({
      storageKey: `fpr-baseline-check-${session}`,
      baseline: baseline.toJSON(),
      botProtection: false, // Disable bot detection for tests
    });

    let fired = false;
    const off = manager.on('trajectory_anomaly', () => {
      fired = true;
    });

    // Track 64 structured transitions (baseline pattern)
    for (let step = 0; step < 64; step += 1) {
      manager.track(states[(session + step) % states.length]);
    }

    off();
    if (fired) anomalies += 1;
    manager.flushNow();
  }

  // Baseline (structured) trajectories should rarely trigger false positives
  assert.ok(anomalies / sessions < 0.1, `Expected FPR < 0.1, got ${anomalies}/${sessions} = ${(anomalies/sessions).toFixed(2)}`);
});

test('adversarial trajectory sessions keep anomaly true positive rate above 0.8', () => {
  const states = ['A', 'B', 'C', 'D', 'E', 'F'];
  const baseline = new MarkovGraph();
  for (let i = 0; i < states.length; i += 1) {
    baseline.incrementTransition(states[i], states[(i + 1) % states.length]);
  }

  // Calibrate baseline statistics for proper Z-score detection
  const SMOOTHING_EPSILON = 0.01;
  const CALIBRATION_WINDOW = 32;
  const calibrationSamples = [];
  
  for (let i = 0; i < 100; i += 1) {
    const sequence = [];
    for (let j = 0; j < CALIBRATION_WINDOW; j += 1) {
      sequence.push(states[(i + j) % states.length]);
    }
    const ll = MarkovGraph.logLikelihoodTrajectory(baseline, sequence, SMOOTHING_EPSILON);
    calibrationSamples.push(ll / Math.max(1, sequence.length - 1));
  }
  
  const baselineMeanLL = calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length;
  const variance = calibrationSamples.reduce((a, v) => {
    const d = v - baselineMeanLL;
    return a + d * d;
  }, 0) / calibrationSamples.length;
  const baselineStdLL = Math.sqrt(variance);

  let rngState = 1337;
  const nextInt = (max) => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState % max;
  };

  let detected = 0;
  const sessions = 20;
  for (let session = 0; session < sessions; session += 1) {
    // Create a fresh IntentManager per session with calibration
    const manager = new IntentManager({
      storageKey: `tpr-adversarial-check-${session}`,
      baseline: baseline.toJSON(),
      graph: {
        divergenceThreshold: 2.0,  // More sensitive threshold for adversarial detection
        baselineMeanLL,
        baselineStdLL,
      },
      botProtection: false, // Disable bot detection for tests
    });

    let fired = false;
    const off = manager.on('trajectory_anomaly', () => {
      fired = true;
    });

    // Track 64 random transitions (adversarial pattern).
    for (let step = 0; step < 64; step += 1) {
      manager.track(states[nextInt(states.length)]);
    }

    off();
    if (fired) detected += 1;
    manager.flushNow();
  }

  // Random navigation should trigger anomalies with high probability when calibrated.
  assert.ok(detected / sessions > 0.8, `Expected TPR > 0.8, got ${detected}/${sessions} = ${(detected/sessions).toFixed(2)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// EntropyGuard — Bot Protection
// ─────────────────────────────────────────────────────────────────────────────

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
    setItem: (key, value) => { writeCount += 1; storage.setItem(key, value); },
  };

  const manager = new IntentManager({
    storageKey: 'dirty-write-count-test',
    persistDebounceMs: 5,
    botProtection: false,
    storage: countingStorage,
  });

  manager.track('A');
  manager.track('B');
  manager.flushNow(); // dirty → write #1, resets flag

  manager.flushNow(); // not dirty → no write
  manager.flushNow(); // not dirty → no write

  assert.equal(writeCount, 1, `Expected exactly 1 storage write, got ${writeCount}`);

  // Track again → should produce exactly one more write.
  manager.track('C');
  manager.flushNow();

  assert.equal(writeCount, 2, `Expected exactly 2 storage writes after second track, got ${writeCount}`);
});

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
