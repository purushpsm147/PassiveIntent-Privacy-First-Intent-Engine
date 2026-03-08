/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IntentManager, MarkovGraph } from '../dist/src/intent-sdk.js';
import { MemoryStorage, setupTestEnvironment } from './helpers/test-env.mjs';

setupTestEnvironment();

/* ================================================================== */
/*  DwellTimePolicy — enabled / disabled path regression               */
/* ================================================================== */

test('DwellTimePolicy: dwell_time_anomaly fires when dwellTime.enabled=true', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-dwell-on',
      storage,
      botProtection: false,
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 2.0 },
    });
    const events = [];
    manager.on('dwell_time_anomaly', (payload) => events.push(payload));

    // Build up consistent 100ms dwell
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }
    assert.strictEqual(events.length, 0, 'No anomaly for uniform dwell');

    // Anomalous dwell
    mockTime += 1000;
    manager.track('A');
    assert.ok(events.length >= 1, 'dwell_time_anomaly should fire');
    assert.strictEqual(events[events.length - 1].state, 'B');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('DwellTimePolicy: dwell_time_anomaly does NOT fire when dwellTime.enabled=false', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-dwell-off',
      storage,
      botProtection: false,
      dwellTime: { enabled: false, minSamples: 5, zScoreThreshold: 2.0 },
    });
    const events = [];
    manager.on('dwell_time_anomaly', (payload) => events.push(payload));

    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }
    mockTime += 1000;
    manager.track('A');
    assert.strictEqual(events.length, 0, 'dwell_time_anomaly must NOT fire when disabled');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('DwellTimePolicy: session_stale(dwell_exceeded) fires when dwell > MAX_PLAUSIBLE_DWELL_MS', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-dwell-stale',
      storage,
      botProtection: false,
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 2.0 },
    });
    const staleEvents = [];
    manager.on('session_stale', (payload) => staleEvents.push(payload));

    manager.track('A');
    mockTime += 1_800_001; // > MAX_PLAUSIBLE_DWELL_MS (30 minutes)
    manager.track('B');

    assert.ok(staleEvents.length >= 1, 'session_stale should fire');
    assert.strictEqual(staleEvents[0].reason, 'dwell_exceeded');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('DwellTimePolicy: session_stale(dwell_exceeded) does NOT fire when dwell is disabled', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-dwell-stale-off',
      storage,
      botProtection: false,
      // dwellTime not enabled (default: false)
    });
    const staleEvents = [];
    manager.on('session_stale', (payload) => staleEvents.push(payload));

    manager.track('A');
    mockTime += 1_800_001;
    manager.track('B');

    assert.strictEqual(staleEvents.length, 0, 'session_stale must NOT fire when dwell disabled');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* ================================================================== */
/*  BigramPolicy — enabled / disabled path regression                  */
/* ================================================================== */

test('BigramPolicy: bigram transitions recorded when enableBigrams=true', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-bigram-on',
      storage,
      botProtection: false,
      enableBigrams: true,
      bigramFrequencyThreshold: 3,
      graph: { smoothingAlpha: 0 },
    });

    // Build up enough unigram transitions so the threshold is met:
    // A -> B -> C -> A -> B -> C (6 transitions, A→B appears 2x, B→C 2x, C→A 2x, etc.)
    const sequence = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C'];
    for (const s of sequence) {
      mockTime += 200;
      manager.track(s);
    }

    const json = manager.exportGraph();
    // Look for bigram states (containing →)
    const bigramStates = json.states.filter((s) => s.includes('\u2192'));
    assert.ok(bigramStates.length > 0, 'Bigram states should be recorded');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('BigramPolicy: no bigram transitions when enableBigrams=false (default)', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-bigram-off',
      storage,
      botProtection: false,
      // enableBigrams defaults to false
      graph: { smoothingAlpha: 0 },
    });

    const sequence = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C'];
    for (const s of sequence) {
      mockTime += 200;
      manager.track(s);
    }

    const json = manager.exportGraph();
    const bigramStates = json.states.filter((s) => s.includes('\u2192'));
    assert.strictEqual(bigramStates.length, 0, 'No bigram states should exist');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* ================================================================== */
/*  DriftProtectionPolicy — enabled path regression                    */
/* ================================================================== */

test('DriftProtectionPolicy: baseline status transitions to drifted at high anomaly rate', () => {
  const storage = new MemoryStorage();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    // Build a baseline graph that disagrees with the live pattern.
    const baseline = new MarkovGraph({ divergenceThreshold: 1.0, smoothingAlpha: 0 });
    baseline.incrementTransition('X', 'Y');
    baseline.incrementTransition('Y', 'X');
    for (let i = 0; i < 20; i++) {
      baseline.incrementTransition('X', 'Y');
      baseline.incrementTransition('Y', 'X');
    }

    const manager = new IntentManager({
      storageKey: 'policy-drift',
      storage,
      botProtection: false,
      baseline: baseline.toJSON(),
      graph: { divergenceThreshold: 0.1, smoothingAlpha: 0 },
      driftProtection: { maxAnomalyRate: 0.3, evaluationWindowMs: 100_000 },
    });

    // Repeatedly track states that the baseline never saw.
    // This should drive the anomaly rate above maxAnomalyRate.
    for (let i = 0; i < 60; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    const telemetry = manager.getTelemetry();
    assert.strictEqual(
      telemetry.baselineStatus,
      'drifted',
      'Baseline should be flagged as drifted',
    );
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('DriftProtectionPolicy: baseline stays active when anomaly rate is low', () => {
  const storage = new MemoryStorage();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    // Build a baseline that matches the live traffic exactly.
    const baseline = new MarkovGraph({ smoothingAlpha: 0 });
    for (let i = 0; i < 50; i++) {
      baseline.incrementTransition('A', 'B');
      baseline.incrementTransition('B', 'A');
    }

    const manager = new IntentManager({
      storageKey: 'policy-drift-no',
      storage,
      botProtection: false,
      baseline: baseline.toJSON(),
      graph: { divergenceThreshold: 3.5, smoothingAlpha: 0 },
      driftProtection: { maxAnomalyRate: 0.4, evaluationWindowMs: 100_000 },
    });

    for (let i = 0; i < 40; i++) {
      mockTime += 200;
      manager.track('A');
      mockTime += 200;
      manager.track('B');
    }

    const telemetry = manager.getTelemetry();
    assert.strictEqual(telemetry.baselineStatus, 'active', 'Baseline should stay active');
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* ================================================================== */
/*  CrossTabSyncPolicy — enabled / disabled path regression            */
/* ================================================================== */

// Note: BroadcastChannel is not available in Node.js, so CrossTabSyncPolicy
// creates a BroadcastSync that is NOT active (isActive: false).  We test that
// the policy is properly constructed and destroyed without errors, and that
// the boolean gating works (no crash, no leaks).

test('CrossTabSyncPolicy: no error when crossTabSync=true in Node (BroadcastChannel unavailable)', () => {
  const storage = new MemoryStorage();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-crosstab-on',
      storage,
      botProtection: false,
      crossTabSync: true,
    });

    // Track some states — should not throw.
    for (let i = 0; i < 5; i++) {
      mockTime += 200;
      manager.track('page' + i);
    }
    // incrementCounter should not throw.
    manager.incrementCounter('articles', 1);

    manager.destroy(); // destroy should close the policy cleanly
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('CrossTabSyncPolicy: no error when crossTabSync=false (default)', () => {
  const storage = new MemoryStorage();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-crosstab-off',
      storage,
      botProtection: false,
      // crossTabSync defaults to false
    });

    for (let i = 0; i < 5; i++) {
      mockTime += 200;
      manager.track('page' + i);
    }
    manager.incrementCounter('articles', 1);
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* ================================================================== */
/*  Combined policy scenarios                                          */
/* ================================================================== */

test('All policies enabled: same events fire under same input trace', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-all-on',
      storage,
      botProtection: false,
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 2.0 },
      enableBigrams: true,
      bigramFrequencyThreshold: 3,
      crossTabSync: true,
      driftProtection: { maxAnomalyRate: 1.0, evaluationWindowMs: 300_000 },
      graph: { smoothingAlpha: 0 },
    });

    const stateChanges = [];
    manager.on('state_change', (p) => stateChanges.push(p));
    const dwellEvents = [];
    manager.on('dwell_time_anomaly', (p) => dwellEvents.push(p));

    // Uniform dwell
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }
    assert.strictEqual(stateChanges.length, 20, 'All state changes should fire');
    assert.strictEqual(dwellEvents.length, 0, 'No dwell anomaly for uniform dwell');

    // Anomalous dwell
    mockTime += 1000;
    manager.track('A');
    assert.ok(dwellEvents.length >= 1, 'Dwell anomaly should fire with all policies enabled');

    // Check bigrams exist
    const json = manager.exportGraph();
    const bigramStates = json.states.filter((s) => s.includes('\u2192'));
    assert.ok(bigramStates.length > 0, 'Bigram states should be recorded');

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('All policies disabled: state_change still fires, no feature events', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-all-off',
      storage,
      botProtection: false,
      // dwellTime defaults to disabled
      // enableBigrams defaults to false
      // crossTabSync defaults to false
      graph: { smoothingAlpha: 0 },
    });

    const stateChanges = [];
    manager.on('state_change', (p) => stateChanges.push(p));
    const dwellEvents = [];
    manager.on('dwell_time_anomaly', (p) => dwellEvents.push(p));

    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }
    mockTime += 1000;
    manager.track('A');

    assert.strictEqual(stateChanges.length, 21, 'state_change always fires');
    assert.strictEqual(dwellEvents.length, 0, 'No dwell anomaly when disabled');

    const json = manager.exportGraph();
    const bigramStates = json.states.filter((s) => s.includes('\u2192'));
    assert.strictEqual(bigramStates.length, 0, 'No bigram states when disabled');

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* ================================================================== */
/*  Event timing / cooldown preserved through policies                 */
/* ================================================================== */

test('eventCooldownMs still throttles dwell_time_anomaly through DwellTimePolicy', () => {
  const storage = new MemoryStorage();
  let mockTime = 1000;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-dwell-cooldown',
      storage,
      botProtection: false,
      eventCooldownMs: 5000,
      driftProtection: { maxAnomalyRate: 1.0, evaluationWindowMs: 300_000 },
      dwellTime: { enabled: true, minSamples: 5, zScoreThreshold: 2.0 },
    });
    const events = [];
    manager.on('dwell_time_anomaly', (p) => events.push(p));

    // Build up 10 consistent dwells
    for (let i = 0; i < 10; i++) {
      mockTime += 100;
      manager.track('A');
      mockTime += 100;
      manager.track('B');
    }

    // First anomaly: should fire.
    mockTime += 1000;
    manager.track('A');
    const countAfterFirst = events.length;
    assert.ok(countAfterFirst >= 1, 'First anomaly should fire');

    // Second anomaly too soon (within 5s cooldown): should NOT fire.
    mockTime += 100;
    manager.track('B');
    mockTime += 1000;
    manager.track('A');
    assert.strictEqual(events.length, countAfterFirst, 'Second anomaly suppressed by cooldown');

    // Third anomaly after cooldown expires: should fire.
    mockTime += 5000;
    manager.track('B');
    mockTime += 1000;
    manager.track('A');
    assert.ok(events.length > countAfterFirst, 'Anomaly should fire after cooldown expires');

    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});

/* ================================================================== */
/*  Telemetry / assignmentGroup preserved                              */
/* ================================================================== */

test('getTelemetry() returns correct structure after policy refactor', () => {
  const storage = new MemoryStorage();
  let mockTime = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => mockTime;
  try {
    const manager = new IntentManager({
      storageKey: 'policy-telemetry',
      storage,
      botProtection: false,
    });
    mockTime += 100;
    manager.track('A');
    mockTime += 100;
    manager.track('B');

    const t = manager.getTelemetry();
    assert.ok(typeof t.sessionId === 'string');
    assert.ok(typeof t.transitionsEvaluated === 'number');
    assert.ok(['human', 'suspected_bot'].includes(t.botStatus));
    assert.ok(typeof t.anomaliesFired === 'number');
    assert.ok(['healthy', 'degraded', 'quota_exceeded'].includes(t.engineHealth));
    assert.ok(['active', 'drifted'].includes(t.baselineStatus));
    assert.ok(['treatment', 'control'].includes(t.assignmentGroup));
    manager.destroy();
  } finally {
    globalThis.performance.now = originalNow;
  }
});
