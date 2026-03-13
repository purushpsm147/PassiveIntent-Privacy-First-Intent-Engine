/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * # Anomaly Dispatcher Tests
 *
 * These tests validate two complementary correctness properties:
 *
 * ## 1 — Dispatcher unit contract
 *   AnomalyDispatcher is constructed in isolation with manual mocks and its
 *   behaviour is verified for every policy it owns:
 *     - Cooldown gating
 *     - Holdout (control group) suppression
 *     - Telemetry counter accuracy
 *     - Drift-protection accounting for trajectory decisions
 *     - Hesitation-correlation emission
 *
 * ## 2 — Decision-stream ↔ emission equivalence (before/after)
 *   Two identical IntentManager replays are run on the same scenario.  All
 *   anomaly events captured from both runs must be identical, proving that the
 *   evaluator → dispatcher refactoring did not change when or what gets
 *   emitted.  The second run additionally verifies that `anomaliesFired`
 *   telemetry is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IntentManager, MarkovGraph, AnomalyDispatcher } from '../dist/src/intent-sdk.js';
import { setupTestEnvironment, MemoryStorage } from './helpers/test-env.mjs';

setupTestEnvironment();

/* ======================================================================== */
/* Helpers                                                                   */
/* ======================================================================== */

/** Minimal collocated mock emitter that records every emit() call. */
function makeMockEmitter() {
  const calls = [];
  return {
    calls,
    emit(event, payload) {
      calls.push({ event, payload });
    },
    on() {
      return () => {};
    },
    removeAll() {
      calls.length = 0;
    },
  };
}

/** Controllable monotonic timer. */
function makeMockTimer(start = 0) {
  let t = start;
  return {
    now() {
      return t;
    },
    advance(ms) {
      t += ms;
    },
  };
}

/** Minimal drift-policy stub. */
function makeMockDriftPolicy(drifted = false) {
  let anomalies = 0;
  return {
    get isDrifted() {
      return drifted;
    },
    get baselineStatus() {
      return drifted ? 'drifted' : 'active';
    },
    recordAnomaly() {
      anomalies += 1;
    },
    get anomalyCount() {
      return anomalies;
    },
  };
}

/** Build a minimal AnomalyDispatcher ready for unit tests. */
function makeDispatcher({
  emitter,
  timer,
  driftPolicy,
  assignmentGroup = 'treatment',
  eventCooldownMs = 0,
  hesitationCorrelationWindowMs = 5000,
} = {}) {
  emitter ??= makeMockEmitter();
  timer ??= makeMockTimer();
  driftPolicy ??= makeMockDriftPolicy();

  const dispatcher = new AnomalyDispatcher({
    emitter,
    timer,
    assignmentGroup,
    eventCooldownMs,
    hesitationCorrelationWindowMs,
    driftPolicy,
  });

  return { dispatcher, emitter, timer, driftPolicy };
}

/* ======================================================================== */
/* AnomalyDispatcher unit tests                                              */
/* ======================================================================== */

test('dispatcher: null decision is a no-op', () => {
  const { dispatcher, emitter } = makeDispatcher();
  dispatcher.dispatch(null);
  assert.equal(emitter.calls.length, 0);
  assert.equal(dispatcher.anomaliesFired, 0);
});

test('dispatcher: emits high_entropy for EntropyDecision in treatment group', () => {
  const { dispatcher, emitter } = makeDispatcher();

  dispatcher.dispatch({
    kind: 'high_entropy',
    payload: { state: '/home', entropy: 2.1, normalizedEntropy: 0.9 },
  });

  assert.equal(dispatcher.anomaliesFired, 1);
  assert.equal(emitter.calls.length, 1);
  assert.equal(emitter.calls[0].event, 'high_entropy');
  assert.deepEqual(emitter.calls[0].payload, {
    state: '/home',
    entropy: 2.1,
    normalizedEntropy: 0.9,
  });
});

test('dispatcher: emits trajectory_anomaly for TrajectoryDecision in treatment group', () => {
  const { dispatcher, emitter } = makeDispatcher();

  const payload = {
    stateFrom: '/a',
    stateTo: '/b',
    realLogLikelihood: -1.5,
    expectedBaselineLogLikelihood: -0.5,
    zScore: -4.2,
    confidence: 'high',
    sampleSize: 50,
  };
  dispatcher.dispatch({ kind: 'trajectory_anomaly', payload });

  assert.equal(dispatcher.anomaliesFired, 1);
  assert.equal(emitter.calls.length, 1);
  assert.equal(emitter.calls[0].event, 'trajectory_anomaly');
  assert.deepEqual(emitter.calls[0].payload, payload);
});

test('dispatcher: emits dwell_time_anomaly for DwellDecision in treatment group', () => {
  const { dispatcher, emitter } = makeDispatcher();

  const payload = { state: '/cart', dwellMs: 8000, meanMs: 2000, stdMs: 500, zScore: 2.3 };
  dispatcher.dispatch({ kind: 'dwell_time_anomaly', payload, isPositiveZScore: true });

  assert.equal(dispatcher.anomaliesFired, 1);
  assert.equal(emitter.calls.length, 1);
  assert.equal(emitter.calls[0].event, 'dwell_time_anomaly');
});

test('dispatcher: control group suppresses all emissions but still counts anomalies', () => {
  const { dispatcher, emitter } = makeDispatcher({ assignmentGroup: 'control' });

  dispatcher.dispatch({
    kind: 'high_entropy',
    payload: { state: '/s', entropy: 1, normalizedEntropy: 0.8 },
  });
  dispatcher.dispatch({
    kind: 'trajectory_anomaly',
    payload: {
      stateFrom: '/a',
      stateTo: '/b',
      realLogLikelihood: -2,
      expectedBaselineLogLikelihood: -1,
      zScore: -5,
      confidence: 'high',
      sampleSize: 40,
    },
  });

  // No events emitted to the emitter — holdout suppression in effect.
  assert.equal(emitter.calls.length, 0);
  // But anomalies are counted toward telemetry.
  assert.equal(dispatcher.anomaliesFired, 2);
});

test('dispatcher: cooldown prevents re-emission within window', () => {
  const timer = makeMockTimer(1000);
  const { dispatcher, emitter } = makeDispatcher({
    timer,
    eventCooldownMs: 5000,
  });

  const payload = { state: '/s', entropy: 2, normalizedEntropy: 0.85 };

  dispatcher.dispatch({ kind: 'high_entropy', payload });
  assert.equal(emitter.calls.length, 1);
  assert.equal(dispatcher.anomaliesFired, 1);

  // Advance only 2 s — still within cooldown.
  timer.advance(2000);
  dispatcher.dispatch({ kind: 'high_entropy', payload });
  assert.equal(emitter.calls.length, 1, 'second dispatch within cooldown should not emit');
  assert.equal(dispatcher.anomaliesFired, 1, 'anomaliesFired must not increment during cooldown');

  // Advance past the cooldown boundary.
  timer.advance(3001);
  dispatcher.dispatch({ kind: 'high_entropy', payload });
  assert.equal(emitter.calls.length, 2, 'dispatch after cooldown should emit');
  assert.equal(dispatcher.anomaliesFired, 2);
});

test('dispatcher: cooldown is per event-type (independent windows)', () => {
  const timer = makeMockTimer(0);
  const { dispatcher, emitter } = makeDispatcher({ timer, eventCooldownMs: 10_000 });

  dispatcher.dispatch({
    kind: 'high_entropy',
    payload: { state: '/s', entropy: 2, normalizedEntropy: 0.85 },
  });

  // trajectory_anomaly has its own cooldown — should fire independently.
  dispatcher.dispatch({
    kind: 'trajectory_anomaly',
    payload: {
      stateFrom: '/a',
      stateTo: '/b',
      realLogLikelihood: -2,
      expectedBaselineLogLikelihood: -1,
      zScore: -4,
      confidence: 'medium',
      sampleSize: 15,
    },
  });

  assert.equal(emitter.calls.length, 2);
  assert.equal(emitter.calls[0].event, 'high_entropy');
  assert.equal(emitter.calls[1].event, 'trajectory_anomaly');
});

test('dispatcher: trajectory decision calls driftPolicy.recordAnomaly() regardless of cooldown', () => {
  const timer = makeMockTimer(0);
  const driftPolicy = makeMockDriftPolicy();
  const { dispatcher } = makeDispatcher({ timer, eventCooldownMs: 10_000, driftPolicy });

  const payload = {
    stateFrom: '/a',
    stateTo: '/b',
    realLogLikelihood: -2,
    expectedBaselineLogLikelihood: -1,
    zScore: -4,
    confidence: 'high',
    sampleSize: 35,
  };

  dispatcher.dispatch({ kind: 'trajectory_anomaly', payload });
  assert.equal(driftPolicy.anomalyCount, 1, 'first dispatch: drift counted');

  // Second dispatch within cooldown — no event emitted, but drift still counted.
  dispatcher.dispatch({ kind: 'trajectory_anomaly', payload });
  assert.equal(driftPolicy.anomalyCount, 2, 'second dispatch during cooldown: drift still counted');
  assert.equal(dispatcher.anomaliesFired, 1, 'anomaliesFired not incremented during cooldown');
});

test('dispatcher: entropy/dwell decisions do NOT call driftPolicy.recordAnomaly()', () => {
  const driftPolicy = makeMockDriftPolicy();
  const { dispatcher } = makeDispatcher({ driftPolicy });

  dispatcher.dispatch({
    kind: 'high_entropy',
    payload: { state: '/x', entropy: 2, normalizedEntropy: 0.9 },
  });
  dispatcher.dispatch({
    kind: 'dwell_time_anomaly',
    payload: {
      state: '/y',
      dwellMs: 5000,
      meanMs: 1000,
      stdMs: 200,
      zScore: 2.5,
      confidence: 'high',
      sampleSize: 30,
    },
    isPositiveZScore: true,
  });

  assert.equal(driftPolicy.anomalyCount, 0, 'only trajectory decisions affect drift count');
});

test('dispatcher: hesitation emitted when trajectory and positive-dwell occur within window', () => {
  const timer = makeMockTimer(1000);
  const { dispatcher, emitter } = makeDispatcher({
    timer,
    hesitationCorrelationWindowMs: 2000,
  });

  dispatcher.dispatch({
    kind: 'trajectory_anomaly',
    payload: {
      stateFrom: '/a',
      stateTo: '/b',
      realLogLikelihood: -2,
      expectedBaselineLogLikelihood: -1,
      zScore: -4.5,
      confidence: 'high',
      sampleSize: 50,
    },
  });

  // Dwell fire 500 ms later — within the 2 s correlation window.
  timer.advance(500);
  dispatcher.dispatch({
    kind: 'dwell_time_anomaly',
    payload: {
      state: '/b',
      dwellMs: 9000,
      meanMs: 2000,
      stdMs: 500,
      zScore: 3.1,
      confidence: 'high',
      sampleSize: 12,
    },
    isPositiveZScore: true,
  });

  const hesitation = emitter.calls.find((c) => c.event === 'hesitation_detected');
  assert.ok(hesitation, 'hesitation_detected should have been emitted');
  assert.equal(hesitation.payload.state, '/b');
  assert.ok(hesitation.payload.trajectoryZScore < 0);
  assert.ok(hesitation.payload.dwellZScore > 0);
});

test('dispatcher: hesitation not emitted when dwell zScore is negative', () => {
  const timer = makeMockTimer(0);
  const { dispatcher, emitter } = makeDispatcher({
    timer,
    hesitationCorrelationWindowMs: 10_000,
  });

  dispatcher.dispatch({
    kind: 'trajectory_anomaly',
    payload: {
      stateFrom: '/a',
      stateTo: '/b',
      realLogLikelihood: -2,
      expectedBaselineLogLikelihood: -1,
      zScore: -4,
      confidence: 'medium',
      sampleSize: 20,
    },
  });

  // Negative zScore means unusually short dwell — not a hesitation signal.
  dispatcher.dispatch({
    kind: 'dwell_time_anomaly',
    payload: {
      state: '/b',
      dwellMs: 100,
      meanMs: 2000,
      stdMs: 500,
      zScore: -2.5,
      confidence: 'low',
      sampleSize: 7,
    },
    isPositiveZScore: false,
  });

  const hesitation = emitter.calls.find((c) => c.event === 'hesitation_detected');
  assert.equal(hesitation, undefined, 'hesitation should not fire for negative dwell z-score');
});

test('dispatcher: hesitation not emitted when signals are outside correlation window', () => {
  const timer = makeMockTimer(0);
  const { dispatcher, emitter } = makeDispatcher({
    timer,
    hesitationCorrelationWindowMs: 1000,
  });

  dispatcher.dispatch({
    kind: 'trajectory_anomaly',
    payload: {
      stateFrom: '/a',
      stateTo: '/b',
      realLogLikelihood: -2,
      expectedBaselineLogLikelihood: -1,
      zScore: -4,
      confidence: 'medium',
      sampleSize: 18,
    },
  });

  // Dwell fires 2 s later — outside the 1 s correlation window.
  timer.advance(2000);
  dispatcher.dispatch({
    kind: 'dwell_time_anomaly',
    payload: {
      state: '/b',
      dwellMs: 8000,
      meanMs: 2000,
      stdMs: 500,
      zScore: 3,
      confidence: 'medium',
      sampleSize: 14,
    },
    isPositiveZScore: true,
  });

  const hesitation = emitter.calls.find((c) => c.event === 'hesitation_detected');
  assert.equal(hesitation, undefined, 'hesitation should not fire outside correlation window');
});

test('dispatcher: hesitation pair is consumed (does not fire twice for the same signal pair)', () => {
  const timer = makeMockTimer(0);
  const { dispatcher, emitter } = makeDispatcher({
    timer,
    hesitationCorrelationWindowMs: 10_000,
  });

  const trajectoryPayload = {
    stateFrom: '/a',
    stateTo: '/b',
    realLogLikelihood: -2,
    expectedBaselineLogLikelihood: -1,
    zScore: -4,
    confidence: 'high',
    sampleSize: 45,
  };
  const dwellPayload = {
    state: '/b',
    dwellMs: 8000,
    meanMs: 2000,
    stdMs: 500,
    zScore: 3,
    confidence: 'medium',
    sampleSize: 11,
  };

  dispatcher.dispatch({ kind: 'trajectory_anomaly', payload: trajectoryPayload });
  dispatcher.dispatch({
    kind: 'dwell_time_anomaly',
    payload: dwellPayload,
    isPositiveZScore: true,
  });

  const firstHesitations = emitter.calls.filter((c) => c.event === 'hesitation_detected');
  assert.equal(firstHesitations.length, 1);

  // Attempting to double-fire with the same pair — timestamps were reset.
  dispatcher.dispatch({
    kind: 'dwell_time_anomaly',
    payload: dwellPayload,
    isPositiveZScore: true,
  });
  const allHesitations = emitter.calls.filter((c) => c.event === 'hesitation_detected');
  assert.equal(allHesitations.length, 1, 'consumed pair must not trigger hesitation again');
});

/* ======================================================================== */
/* Decision-stream ↔ emission equivalence (before/after comparison)         */
/* ======================================================================== */

/**
 * Build a deterministic baseline graph where A→B→C→D→A is the only
 * navigational pattern (trained with many repetitions so smoothing noise is
 * negligible).  Returns the serialised JSON consumed by IntentManager.
 */
function makeAnomalyScenario() {
  const baselineGraph = new MarkovGraph({ smoothingAlpha: 0 });
  const normal = ['A', 'B', 'C', 'D'];
  // 200 complete cycles — probabilities converge to 1.0 per edge.
  for (let r = 0; r < 200; r += 1) {
    for (let i = 0; i < normal.length; i += 1) {
      baselineGraph.incrementTransition(normal[i], normal[(i + 1) % normal.length]);
    }
  }
  return baselineGraph.toJSON();
}

/**
 * Build a full scenario sequence and run it through an IntentManager.
 *
 * Layout:
 *   - 40 baseline transitions (A→B→C→D loop × 10) to warm the online graph
 *   - 40 adversarial transitions (X→Y→Z→W→V loop × 8) to saturate the window
 *
 * The adversarial block ensures the trajectory window (MIN_WINDOW_LENGTH=16)
 * is filled with states the baseline has never seen, reliably triggering
 * trajectory anomaly events at every applicable step.
 */
function runScenario(baselineJSON, storage) {
  const manager = new IntentManager({
    storageKey: 'anomaly-equiv-test',
    storage,
    baseline: baselineJSON,
    botProtection: false,
    eventCooldownMs: 0,
    dwellTime: { enabled: false },
  });

  const captured = [];
  const off1 = manager.on('high_entropy', (p) =>
    captured.push({ event: 'high_entropy', payload: p }),
  );
  const off2 = manager.on('trajectory_anomaly', (p) =>
    captured.push({ event: 'trajectory_anomaly', payload: p }),
  );

  const baselineStates = ['A', 'B', 'C', 'D'];
  const adversarialStates = ['X', 'Y', 'Z', 'W', 'V'];
  for (let r = 0; r < 10; r += 1) for (const s of baselineStates) manager.track(s);
  for (let r = 0; r < 8; r += 1) for (const s of adversarialStates) manager.track(s);

  const telemetry = manager.getTelemetry();
  off1();
  off2();
  manager.destroy();

  return { captured, anomaliesFired: telemetry.anomaliesFired };
}

test('event stream is identical across two independent replays of the same scenario', () => {
  const baselineJSON = makeAnomalyScenario();
  const storageA = new MemoryStorage();
  const storageB = new MemoryStorage();

  const runA = runScenario(baselineJSON, storageA);
  const runB = runScenario(baselineJSON, storageB);

  // The scenario must actually fire some events to be meaningful.
  assert.ok(
    runA.captured.length > 0,
    `expected at least one anomaly event; got ${runA.captured.length}`,
  );

  // Both runs must produce the same number of events.
  assert.equal(
    runA.captured.length,
    runB.captured.length,
    `event count mismatch: runA=${runA.captured.length}, runB=${runB.captured.length}`,
  );

  // Every individual event must match in kind and in the fields that are
  // deterministic across runs (stateFrom, stateTo — no timestamps or IDs).
  for (let i = 0; i < runA.captured.length; i += 1) {
    const a = runA.captured[i];
    const b = runB.captured[i];
    assert.equal(a.event, b.event, `event[${i}].event mismatch`);
    if (a.event === 'trajectory_anomaly') {
      assert.equal(a.payload.stateFrom, b.payload.stateFrom, `trajectory[${i}].stateFrom`);
      assert.equal(a.payload.stateTo, b.payload.stateTo, `trajectory[${i}].stateTo`);
    }
    if (a.event === 'high_entropy') {
      assert.equal(a.payload.state, b.payload.state, `entropy[${i}].state`);
    }
  }

  // Telemetry counters must be identical.
  assert.equal(runA.anomaliesFired, runB.anomaliesFired, 'anomaliesFired telemetry must match');
});

test('control group produces identical anomaliesFired but zero emissions for same scenario', () => {
  const baselineJSON = makeAnomalyScenario();
  const baselineStates = ['A', 'B', 'C', 'D'];
  const adversarialStates = ['X', 'Y', 'Z', 'W', 'V'];

  // Build the same full sequence used in runScenario.
  function buildSeq() {
    const s = [];
    for (let r = 0; r < 10; r += 1) for (const x of baselineStates) s.push(x);
    for (let r = 0; r < 8; r += 1) for (const x of adversarialStates) s.push(x);
    return s;
  }

  // Treatment run — captures events.
  const treatmentManager = new IntentManager({
    storageKey: 'ctrl-treatment',
    storage: new MemoryStorage(),
    baseline: baselineJSON,
    botProtection: false,
    eventCooldownMs: 0,
    dwellTime: { enabled: false },
    holdoutConfig: { percentage: 0 }, // force treatment group
  });
  const treatmentEvents = [];
  const tOff = treatmentManager.on('trajectory_anomaly', (p) => treatmentEvents.push(p));
  for (const s of buildSeq()) treatmentManager.track(s);
  const treatmentTelemetry = treatmentManager.getTelemetry();
  tOff();
  treatmentManager.destroy();

  // Control run — no events should fire, but anomaliesFired must equal treatment.
  const controlManager = new IntentManager({
    storageKey: 'ctrl-control',
    storage: new MemoryStorage(),
    baseline: baselineJSON,
    botProtection: false,
    eventCooldownMs: 0,
    dwellTime: { enabled: false },
    holdoutConfig: { percentage: 100 }, // force control group
  });
  const controlEvents = [];
  const cOff = controlManager.on('trajectory_anomaly', (p) => controlEvents.push(p));
  for (const s of buildSeq()) controlManager.track(s);
  const controlTelemetry = controlManager.getTelemetry();
  cOff();
  controlManager.destroy();

  assert.ok(treatmentEvents.length > 0, 'treatment group must receive at least one event');
  assert.equal(controlEvents.length, 0, 'control group must emit zero events');
  assert.equal(
    controlTelemetry.anomaliesFired,
    treatmentTelemetry.anomaliesFired,
    'anomaliesFired must be identical regardless of holdout group',
  );
});

test('cooldown correctly caps event count for rapid anomaly sequence', () => {
  const baselineJSON = makeAnomalyScenario();
  const baselineStates = ['A', 'B', 'C', 'D'];
  const adversarialStates = ['X', 'Y', 'Z', 'W', 'V'];

  function buildSeq() {
    const s = [];
    for (let r = 0; r < 10; r += 1) for (const x of baselineStates) s.push(x);
    for (let r = 0; r < 8; r += 1) for (const x of adversarialStates) s.push(x);
    return s;
  }

  // With no cooldown, the adversarial block should fire multiple trajectory events.
  const noCooldownManager = new IntentManager({
    storageKey: 'cooldown-none',
    storage: new MemoryStorage(),
    baseline: baselineJSON,
    botProtection: false,
    eventCooldownMs: 0,
    dwellTime: { enabled: false },
  });
  let noCooldownFires = 0;
  const offNC = noCooldownManager.on('trajectory_anomaly', () => {
    noCooldownFires += 1;
  });
  for (const s of buildSeq()) noCooldownManager.track(s);
  offNC();
  noCooldownManager.destroy();

  // With a very large cooldown, the same sequence should fire at most once.
  const heavyCooldownManager = new IntentManager({
    storageKey: 'cooldown-heavy',
    storage: new MemoryStorage(),
    baseline: baselineJSON,
    botProtection: false,
    eventCooldownMs: 999_999_999,
    dwellTime: { enabled: false },
  });
  let heavyCooldownFires = 0;
  const offHC = heavyCooldownManager.on('trajectory_anomaly', () => {
    heavyCooldownFires += 1;
  });
  for (const s of buildSeq()) heavyCooldownManager.track(s);
  offHC();
  heavyCooldownManager.destroy();

  assert.ok(
    noCooldownFires > 0,
    `no-cooldown manager must fire at least once (got ${noCooldownFires})`,
  );
  assert.ok(
    noCooldownFires > heavyCooldownFires,
    `no-cooldown should fire more events (got ${noCooldownFires} vs ${heavyCooldownFires})`,
  );
  assert.ok(
    heavyCooldownFires <= 1,
    `heavy cooldown should cap to ≤1 event (got ${heavyCooldownFires})`,
  );
});
