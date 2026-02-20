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
  });

  assert.equal(restored.hasSeen('home'), true);
  assert.equal(restored.exportGraph().states.includes('search'), true);
});

test('IntentManager returns performance report when benchmark mode is enabled', () => {
  const manager = new IntentManager({
    storageKey: 'perf-test',
    benchmark: { enabled: true, maxSamples: 32 },
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
  }

  // Random navigation should trigger anomalies with high probability when calibrated.
  assert.ok(detected / sessions > 0.8, `Expected TPR > 0.8, got ${detected}/${sessions} = ${(detected/sessions).toFixed(2)}`);
});

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
