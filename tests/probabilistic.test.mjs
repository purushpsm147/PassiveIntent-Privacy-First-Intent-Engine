import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IntentManager,
  MarkovGraph,
} from '../dist/src/intent-sdk.js';
import {
  BenchmarkSimulationEngine,
  evaluatePredictionMatrix,
} from '../dist/src/intent-sdk-performance.js';
import { setupTestEnvironment, storage } from './helpers/test-env.mjs';

setupTestEnvironment();

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
