/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIntentManagerOptions } from '../dist/src/engine/config-normalizer.js';
import { SMOOTHING_EPSILON } from '../dist/src/engine/constants.js';

/**
 * Mirror of fprToZScore from config-normalizer.ts for test expectations.
 * Beasley-Springer rational approximation: z = Φ⁻¹(1 − fpr).
 */
function fprToZScore(fpr) {
  const p = Math.min(0.5, Math.max(0.001, fpr));
  const t = Math.sqrt(-2.0 * Math.log(p));
  return (
    t -
    (2.515517 + t * (0.802853 + t * 0.010328)) /
      (1.0 + t * (1.432788 + t * (0.189269 + t * 0.001308)))
  );
}

// ─── Default values ──────────────────────────────────────────────────────────

test('buildIntentManagerOptions returns all defaults when called with {}', () => {
  const opts = buildIntentManagerOptions({});

  assert.equal(opts.botProtection, true);
  assert.equal(opts.dwellTimeEnabled, false);
  assert.equal(opts.crossTabSync, false);
  assert.equal(opts.holdoutPercent, 0);
  assert.equal(opts.storageKey, 'passive-intent');
  assert.equal(opts.persistDebounceMs, 2000);
  assert.equal(opts.persistThrottleMs, 0);
  assert.equal(opts.eventCooldownMs, 0);
  assert.equal(opts.dwellTimeMinSamples, 10);
  assert.equal(opts.dwellTimeZScoreThreshold, 2.5);
  assert.equal(opts.enableBigrams, false);
  assert.equal(opts.bigramFrequencyThreshold, 5);
  assert.equal(opts.driftMaxAnomalyRate, 0.4);
  assert.equal(opts.driftEvaluationWindowMs, 300_000);
  assert.equal(opts.hesitationCorrelationWindowMs, 30_000);
  assert.equal(opts.trajectorySmoothingEpsilon, SMOOTHING_EPSILON);
});

test('buildIntentManagerOptions returns defaults when called with no argument', () => {
  const opts = buildIntentManagerOptions();
  assert.equal(opts.botProtection, true);
  assert.equal(opts.storageKey, 'passive-intent');
});

// ─── baselineMeanLL / baselineStdLL alias precedence ─────────────────────────

test('top-level baselineMeanLL takes precedence over graph.baselineMeanLL', () => {
  const opts = buildIntentManagerOptions({
    baselineMeanLL: -5.0,
    graph: { baselineMeanLL: -10.0 },
  });
  assert.equal(opts.graphConfig.baselineMeanLL, -5.0);
});

test('graph.baselineMeanLL is used when top-level is undefined', () => {
  const opts = buildIntentManagerOptions({
    graph: { baselineMeanLL: -10.0 },
  });
  assert.equal(opts.graphConfig.baselineMeanLL, -10.0);
});

test('top-level baselineStdLL takes precedence over graph.baselineStdLL', () => {
  const opts = buildIntentManagerOptions({
    baselineStdLL: 1.5,
    graph: { baselineStdLL: 3.0 },
  });
  assert.equal(opts.graphConfig.baselineStdLL, 1.5);
});

test('graph.baselineStdLL is used when top-level is undefined', () => {
  const opts = buildIntentManagerOptions({
    graph: { baselineStdLL: 3.0 },
  });
  assert.equal(opts.graphConfig.baselineStdLL, 3.0);
});

test('baselineMeanLL/baselineStdLL are both undefined when neither is provided', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.graphConfig.baselineMeanLL, undefined);
  assert.equal(opts.graphConfig.baselineStdLL, undefined);
});

// ─── smoothingAlpha precedence ───────────────────────────────────────────────

test('top-level smoothingAlpha takes precedence over graph.smoothingAlpha', () => {
  const opts = buildIntentManagerOptions({
    smoothingAlpha: 0.5,
    graph: { smoothingAlpha: 1.0 },
  });
  assert.equal(opts.graphConfig.smoothingAlpha, 0.5);
});

test('graph.smoothingAlpha is used when top-level is undefined', () => {
  const opts = buildIntentManagerOptions({
    graph: { smoothingAlpha: 1.0 },
  });
  assert.equal(opts.graphConfig.smoothingAlpha, 1.0);
});

test('smoothingAlpha is undefined when neither is provided', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.graphConfig.smoothingAlpha, undefined);
});

// ─── graphConfig spread preserves other nested fields ────────────────────────

test('other graph config fields are preserved through the merge', () => {
  const opts = buildIntentManagerOptions({
    graph: {
      highEntropyThreshold: 0.85,
      divergenceThreshold: 4.0,
      maxStates: 1000,
      smoothingEpsilon: 0.05,
    },
  });
  assert.equal(opts.graphConfig.highEntropyThreshold, 0.85);
  assert.equal(opts.graphConfig.divergenceThreshold, 4.0);
  assert.equal(opts.graphConfig.maxStates, 1000);
  assert.equal(opts.graphConfig.smoothingEpsilon, 0.05);
});

// ─── trajectorySmoothingEpsilon edge cases ───────────────────────────────────

test('smoothingEpsilon: valid positive finite number is used', () => {
  const opts = buildIntentManagerOptions({ graph: { smoothingEpsilon: 0.05 } });
  assert.equal(opts.trajectorySmoothingEpsilon, 0.05);
});

test('smoothingEpsilon: zero falls back to SMOOTHING_EPSILON', () => {
  const opts = buildIntentManagerOptions({ graph: { smoothingEpsilon: 0 } });
  assert.equal(opts.trajectorySmoothingEpsilon, SMOOTHING_EPSILON);
});

test('smoothingEpsilon: negative value falls back to SMOOTHING_EPSILON', () => {
  const opts = buildIntentManagerOptions({ graph: { smoothingEpsilon: -1 } });
  assert.equal(opts.trajectorySmoothingEpsilon, SMOOTHING_EPSILON);
});

test('smoothingEpsilon: NaN falls back to SMOOTHING_EPSILON', () => {
  const opts = buildIntentManagerOptions({ graph: { smoothingEpsilon: NaN } });
  assert.equal(opts.trajectorySmoothingEpsilon, SMOOTHING_EPSILON);
});

test('smoothingEpsilon: Infinity falls back to SMOOTHING_EPSILON', () => {
  const opts = buildIntentManagerOptions({ graph: { smoothingEpsilon: Infinity } });
  assert.equal(opts.trajectorySmoothingEpsilon, SMOOTHING_EPSILON);
});

test('smoothingEpsilon: undefined falls back to SMOOTHING_EPSILON', () => {
  const opts = buildIntentManagerOptions({ graph: {} });
  assert.equal(opts.trajectorySmoothingEpsilon, SMOOTHING_EPSILON);
});

// ─── holdoutPercent clamping ─────────────────────────────────────────────────

test('holdoutPercent defaults to 0 when holdoutConfig is absent', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.holdoutPercent, 0);
});

test('holdoutPercent is passed through when within range', () => {
  const opts = buildIntentManagerOptions({ holdoutConfig: { percentage: 25 } });
  assert.equal(opts.holdoutPercent, 25);
});

test('holdoutPercent is clamped to 0 for negative values', () => {
  const opts = buildIntentManagerOptions({ holdoutConfig: { percentage: -10 } });
  assert.equal(opts.holdoutPercent, 0);
});

test('holdoutPercent is clamped to 100 for values above 100', () => {
  const opts = buildIntentManagerOptions({ holdoutConfig: { percentage: 200 } });
  assert.equal(opts.holdoutPercent, 100);
});

test('holdoutPercent boundary: 0 passes through', () => {
  const opts = buildIntentManagerOptions({ holdoutConfig: { percentage: 0 } });
  assert.equal(opts.holdoutPercent, 0);
});

test('holdoutPercent boundary: 100 passes through', () => {
  const opts = buildIntentManagerOptions({ holdoutConfig: { percentage: 100 } });
  assert.equal(opts.holdoutPercent, 100);
});

test('holdoutPercent passes through NaN unchanged', () => {
  const opts = buildIntentManagerOptions({ holdoutConfig: { percentage: NaN } });
  // Number.isFinite(NaN) is false, so the else branch runs: rawHoldoutPct ?? 0.
  // NaN ?? 0 is NaN (nullish coalescing does not coerce NaN), so NaN passes through.
  assert.ok(Number.isNaN(opts.holdoutPercent));
});

// ─── debounce / throttle defaults ────────────────────────────────────────────

test('persistDebounceMs defaults to 2000', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.persistDebounceMs, 2000);
});

test('persistDebounceMs can be overridden', () => {
  const opts = buildIntentManagerOptions({ persistDebounceMs: 5000 });
  assert.equal(opts.persistDebounceMs, 5000);
});

test('persistThrottleMs defaults to 0', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.persistThrottleMs, 0);
});

test('persistThrottleMs can be overridden', () => {
  const opts = buildIntentManagerOptions({ persistThrottleMs: 500 });
  assert.equal(opts.persistThrottleMs, 500);
});

// ─── dwell time defaults ─────────────────────────────────────────────────────

test('dwellTimeEnabled defaults to false', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.dwellTimeEnabled, false);
});

test('dwellTimeEnabled is true when dwellTime.enabled is true', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { enabled: true } });
  assert.equal(opts.dwellTimeEnabled, true);
});

test('dwellTimeMinSamples defaults to 10', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.dwellTimeMinSamples, 10);
});

test('dwellTimeMinSamples can be overridden', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { enabled: true, minSamples: 20 } });
  assert.equal(opts.dwellTimeMinSamples, 20);
});

test('dwellTimeZScoreThreshold defaults to 2.5', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.dwellTimeZScoreThreshold, 2.5);
});

test('dwellTimeZScoreThreshold can be overridden', () => {
  const opts = buildIntentManagerOptions({
    dwellTime: { enabled: true, zScoreThreshold: 3.0 },
  });
  assert.equal(opts.dwellTimeZScoreThreshold, 3.0);
});

// ─── bigram defaults ─────────────────────────────────────────────────────────

test('enableBigrams defaults to false', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.enableBigrams, false);
});

test('enableBigrams can be enabled', () => {
  const opts = buildIntentManagerOptions({ enableBigrams: true });
  assert.equal(opts.enableBigrams, true);
});

test('bigramFrequencyThreshold defaults to 5', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.bigramFrequencyThreshold, 5);
});

test('bigramFrequencyThreshold can be overridden', () => {
  const opts = buildIntentManagerOptions({ bigramFrequencyThreshold: 10 });
  assert.equal(opts.bigramFrequencyThreshold, 10);
});

// ─── drift protection defaults ───────────────────────────────────────────────

test('driftMaxAnomalyRate defaults to 0.4', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.driftMaxAnomalyRate, 0.4);
});

test('driftMaxAnomalyRate can be overridden', () => {
  const opts = buildIntentManagerOptions({
    driftProtection: { maxAnomalyRate: 0.6, evaluationWindowMs: 300_000 },
  });
  assert.equal(opts.driftMaxAnomalyRate, 0.6);
});

test('driftEvaluationWindowMs defaults to 300000', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.driftEvaluationWindowMs, 300_000);
});

test('driftEvaluationWindowMs can be overridden', () => {
  const opts = buildIntentManagerOptions({
    driftProtection: { maxAnomalyRate: 0.4, evaluationWindowMs: 600_000 },
  });
  assert.equal(opts.driftEvaluationWindowMs, 600_000);
});

// ─── hesitation and event cooldown defaults ──────────────────────────────────

test('hesitationCorrelationWindowMs defaults to 30000', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.hesitationCorrelationWindowMs, 30_000);
});

test('hesitationCorrelationWindowMs can be overridden', () => {
  const opts = buildIntentManagerOptions({ hesitationCorrelationWindowMs: 60_000 });
  assert.equal(opts.hesitationCorrelationWindowMs, 60_000);
});

test('eventCooldownMs defaults to 0', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.eventCooldownMs, 0);
});

test('eventCooldownMs can be overridden', () => {
  const opts = buildIntentManagerOptions({ eventCooldownMs: 1000 });
  assert.equal(opts.eventCooldownMs, 1000);
});

// ─── crossTabSync ────────────────────────────────────────────────────────────

test('crossTabSync defaults to false', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.crossTabSync, false);
});

test('crossTabSync requires strict true', () => {
  const opts1 = buildIntentManagerOptions({ crossTabSync: true });
  assert.equal(opts1.crossTabSync, true);

  // Falsy values should yield false
  const opts2 = buildIntentManagerOptions({ crossTabSync: false });
  assert.equal(opts2.crossTabSync, false);
});

// ─── botProtection ───────────────────────────────────────────────────────────

test('botProtection defaults to true', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.botProtection, true);
});

test('botProtection can be disabled', () => {
  const opts = buildIntentManagerOptions({ botProtection: false });
  assert.equal(opts.botProtection, false);
});

// ─── storageKey ──────────────────────────────────────────────────────────────

test('storageKey defaults to passive-intent', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.storageKey, 'passive-intent');
});

test('storageKey can be overridden', () => {
  const opts = buildIntentManagerOptions({ storageKey: 'my-intent' });
  assert.equal(opts.storageKey, 'my-intent');
});

// ─── Full override scenario ──────────────────────────────────────────────────

test('all fields can be overridden simultaneously', () => {
  const opts = buildIntentManagerOptions({
    botProtection: false,
    dwellTime: { enabled: true, minSamples: 20, zScoreThreshold: 3.0 },
    crossTabSync: true,
    holdoutConfig: { percentage: 50 },
    baselineMeanLL: -4.0,
    baselineStdLL: 2.0,
    smoothingAlpha: 0.3,
    graph: {
      smoothingEpsilon: 0.02,
      highEntropyThreshold: 0.9,
    },
    storageKey: 'custom-key',
    persistDebounceMs: 3000,
    persistThrottleMs: 200,
    eventCooldownMs: 500,
    enableBigrams: true,
    bigramFrequencyThreshold: 8,
    driftProtection: { maxAnomalyRate: 0.5, evaluationWindowMs: 600_000 },
    hesitationCorrelationWindowMs: 45_000,
  });

  assert.equal(opts.botProtection, false);
  assert.equal(opts.dwellTimeEnabled, true);
  assert.equal(opts.crossTabSync, true);
  assert.equal(opts.holdoutPercent, 50);
  assert.equal(opts.graphConfig.baselineMeanLL, -4.0);
  assert.equal(opts.graphConfig.baselineStdLL, 2.0);
  assert.equal(opts.graphConfig.smoothingAlpha, 0.3);
  assert.equal(opts.graphConfig.smoothingEpsilon, 0.02);
  assert.equal(opts.graphConfig.highEntropyThreshold, 0.9);
  assert.equal(opts.trajectorySmoothingEpsilon, 0.02);
  assert.equal(opts.storageKey, 'custom-key');
  assert.equal(opts.persistDebounceMs, 3000);
  assert.equal(opts.persistThrottleMs, 200);
  assert.equal(opts.eventCooldownMs, 500);
  assert.equal(opts.dwellTimeMinSamples, 20);
  assert.equal(opts.dwellTimeZScoreThreshold, 3.0);
  assert.equal(opts.enableBigrams, true);
  assert.equal(opts.bigramFrequencyThreshold, 8);
  assert.equal(opts.driftMaxAnomalyRate, 0.5);
  assert.equal(opts.driftEvaluationWindowMs, 600_000);
  assert.equal(opts.hesitationCorrelationWindowMs, 45_000);
});

// ─── Pure function guarantee ─────────────────────────────────────────────────

test('buildIntentManagerOptions is pure — multiple calls with same input yield equal output', () => {
  const input = {
    baselineMeanLL: -3.0,
    graph: { smoothingEpsilon: 0.1, baselineStdLL: 2.0 },
    holdoutConfig: { percentage: 30 },
  };
  const a = buildIntentManagerOptions(input);
  const b = buildIntentManagerOptions(input);
  assert.deepStrictEqual(a, b);
});

test('buildIntentManagerOptions does not mutate the input config', () => {
  const input = {
    graph: { baselineMeanLL: -5.0, smoothingAlpha: 0.2 },
    baselineMeanLL: -3.0,
    smoothingAlpha: 0.4,
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  buildIntentManagerOptions(input);
  assert.deepStrictEqual(input, snapshot);
});

// ─── Numeric field validation (NaN / Infinity / negative guard) ───────────────

test('persistDebounceMs: NaN falls back to default 2000', () => {
  const opts = buildIntentManagerOptions({ persistDebounceMs: NaN });
  assert.equal(opts.persistDebounceMs, 2000);
});

test('persistDebounceMs: negative falls back to default 2000', () => {
  const opts = buildIntentManagerOptions({ persistDebounceMs: -500 });
  assert.equal(opts.persistDebounceMs, 2000);
});

test('persistDebounceMs: Infinity falls back to default 2000', () => {
  const opts = buildIntentManagerOptions({ persistDebounceMs: Infinity });
  assert.equal(opts.persistDebounceMs, 2000);
});

test('persistDebounceMs: float is floored', () => {
  const opts = buildIntentManagerOptions({ persistDebounceMs: 1500.9 });
  assert.equal(opts.persistDebounceMs, 1500);
});

test('persistThrottleMs: NaN falls back to default 0', () => {
  const opts = buildIntentManagerOptions({ persistThrottleMs: NaN });
  assert.equal(opts.persistThrottleMs, 0);
});

test('persistThrottleMs: negative falls back to default 0', () => {
  const opts = buildIntentManagerOptions({ persistThrottleMs: -1 });
  assert.equal(opts.persistThrottleMs, 0);
});

test('eventCooldownMs: NaN falls back to default 0', () => {
  const opts = buildIntentManagerOptions({ eventCooldownMs: NaN });
  assert.equal(opts.eventCooldownMs, 0);
});

test('eventCooldownMs: negative falls back to default 0', () => {
  const opts = buildIntentManagerOptions({ eventCooldownMs: -100 });
  assert.equal(opts.eventCooldownMs, 0);
});

test('dwellTimeMinSamples: NaN falls back to default 10', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { minSamples: NaN } });
  assert.equal(opts.dwellTimeMinSamples, 10);
});

test('dwellTimeMinSamples: zero falls back to default 10 (must be >= 1)', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { minSamples: 0 } });
  assert.equal(opts.dwellTimeMinSamples, 10);
});

test('dwellTimeMinSamples: float is floored', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { minSamples: 7.8 } });
  assert.equal(opts.dwellTimeMinSamples, 7);
});

test('dwellTimeZScoreThreshold: NaN falls back to default 2.5', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { zScoreThreshold: NaN } });
  assert.equal(opts.dwellTimeZScoreThreshold, 2.5);
});

test('dwellTimeZScoreThreshold: zero falls back to default 2.5 (must be > 0)', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { zScoreThreshold: 0 } });
  assert.equal(opts.dwellTimeZScoreThreshold, 2.5);
});

test('bigramFrequencyThreshold: NaN falls back to default 5', () => {
  const opts = buildIntentManagerOptions({ bigramFrequencyThreshold: NaN });
  assert.equal(opts.bigramFrequencyThreshold, 5);
});

test('bigramFrequencyThreshold: zero falls back to default 5 (must be >= 1)', () => {
  const opts = buildIntentManagerOptions({ bigramFrequencyThreshold: 0 });
  assert.equal(opts.bigramFrequencyThreshold, 5);
});

test('bigramFrequencyThreshold: float is floored', () => {
  const opts = buildIntentManagerOptions({ bigramFrequencyThreshold: 3.9 });
  assert.equal(opts.bigramFrequencyThreshold, 3);
});

test('driftMaxAnomalyRate: NaN falls back to default 0.4', () => {
  const opts = buildIntentManagerOptions({ driftProtection: { maxAnomalyRate: NaN } });
  assert.equal(opts.driftMaxAnomalyRate, 0.4);
});

test('driftMaxAnomalyRate: negative is clamped to 0', () => {
  const opts = buildIntentManagerOptions({ driftProtection: { maxAnomalyRate: -0.5 } });
  assert.equal(opts.driftMaxAnomalyRate, 0);
});

test('driftMaxAnomalyRate: value above 1 is clamped to 1', () => {
  const opts = buildIntentManagerOptions({ driftProtection: { maxAnomalyRate: 2.0 } });
  assert.equal(opts.driftMaxAnomalyRate, 1);
});

test('driftEvaluationWindowMs: NaN falls back to default 300000', () => {
  const opts = buildIntentManagerOptions({ driftProtection: { evaluationWindowMs: NaN } });
  assert.equal(opts.driftEvaluationWindowMs, 300_000);
});

test('driftEvaluationWindowMs: negative falls back to default 300000', () => {
  const opts = buildIntentManagerOptions({ driftProtection: { evaluationWindowMs: -1 } });
  assert.equal(opts.driftEvaluationWindowMs, 300_000);
});

test('driftEvaluationWindowMs: 0 falls back to default 300000 (would reset window every track call)', () => {
  const opts = buildIntentManagerOptions({ driftProtection: { evaluationWindowMs: 0 } });
  assert.equal(opts.driftEvaluationWindowMs, 300_000);
});
test('hesitationCorrelationWindowMs: NaN falls back to default 30000', () => {
  const opts = buildIntentManagerOptions({ hesitationCorrelationWindowMs: NaN });
  assert.equal(opts.hesitationCorrelationWindowMs, 30_000);
});

test('hesitationCorrelationWindowMs: negative falls back to default 30000', () => {
  const opts = buildIntentManagerOptions({ hesitationCorrelationWindowMs: -1 });
  assert.equal(opts.hesitationCorrelationWindowMs, 30_000);
});

// ─── targetFPR → Z-score conversion (dwellTime) ──────────────────────────────

test('dwellTime.targetFPR drives dwellTimeZScoreThreshold via fprToZScore', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { targetFPR: 0.02 } });
  const expected = fprToZScore(0.02); // Φ⁻¹(1 − 0.02) ≈ 2.054
  assert.ok(Math.abs(opts.dwellTimeZScoreThreshold - expected) < 1e-4);
});

test('dwellTime.targetFPR takes precedence over zScoreThreshold when both provided', () => {
  const opts = buildIntentManagerOptions({
    dwellTime: { zScoreThreshold: 3.0, targetFPR: 0.02 },
  });
  const expected = fprToZScore(0.02);
  assert.ok(Math.abs(opts.dwellTimeZScoreThreshold - expected) < 1e-4);
  assert.notEqual(opts.dwellTimeZScoreThreshold, 3.0);
});

test('dwellTime.targetFPR absent: zScoreThreshold still works', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { zScoreThreshold: 3.0 } });
  assert.equal(opts.dwellTimeZScoreThreshold, 3.0);
});

test('dwellTime.targetFPR: values below 0.001 are clamped to 0.001', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { targetFPR: 0.0001 } });
  const expected = fprToZScore(0.001); // clamp to 0.001 → Φ⁻¹(0.999) ≈ 3.090
  assert.ok(Math.abs(opts.dwellTimeZScoreThreshold - expected) < 1e-4);
});

test('dwellTime.targetFPR: values above 0.5 are clamped to 0.5', () => {
  const opts = buildIntentManagerOptions({ dwellTime: { targetFPR: 0.9 } });
  const expected = fprToZScore(0.5); // clamp to 0.5 → Φ⁻¹(0.5) = 0
  assert.ok(Math.abs(opts.dwellTimeZScoreThreshold - expected) < 1e-4);
});

test('dwellTime.targetFPR: NaN falls back to default 2.5 (does not propagate NaN)', () => {
  // NaN is non-finite so the Number.isFinite guard treats it as absent; detection stays enabled.
  const opts = buildIntentManagerOptions({ dwellTime: { targetFPR: NaN } });
  assert.equal(opts.dwellTimeZScoreThreshold, 2.5);
});

// ─── targetFPR → Z-score conversion (graph / divergenceThreshold) ────────────

test('graph.targetFPR drives graphConfig.divergenceThreshold via fprToZScore', () => {
  const opts = buildIntentManagerOptions({ graph: { targetFPR: 0.005 } });
  const expected = fprToZScore(0.005); // Φ⁻¹(0.995) ≈ 2.576
  assert.ok(Math.abs(opts.graphConfig.divergenceThreshold - expected) < 1e-4);
});

test('graph.targetFPR takes precedence over graph.divergenceThreshold when both provided', () => {
  const opts = buildIntentManagerOptions({
    graph: { divergenceThreshold: 4.0, targetFPR: 0.005 },
  });
  const expected = fprToZScore(0.005);
  assert.ok(Math.abs(opts.graphConfig.divergenceThreshold - expected) < 1e-4);
  assert.notEqual(opts.graphConfig.divergenceThreshold, 4.0);
});

test('graph.targetFPR absent: divergenceThreshold passes through unchanged', () => {
  const opts = buildIntentManagerOptions({ graph: { divergenceThreshold: 4.0 } });
  assert.equal(opts.graphConfig.divergenceThreshold, 4.0);
});

test('graph.targetFPR absent and no divergenceThreshold: graphConfig.divergenceThreshold is undefined', () => {
  const opts = buildIntentManagerOptions({});
  assert.equal(opts.graphConfig.divergenceThreshold, undefined);
});

test('graph.targetFPR: values below 0.001 are clamped to 0.001', () => {
  const opts = buildIntentManagerOptions({ graph: { targetFPR: 0.0001 } });
  const expected = fprToZScore(0.001); // clamp to 0.001 → Φ⁻¹(0.999) ≈ 3.090
  assert.ok(Math.abs(opts.graphConfig.divergenceThreshold - expected) < 1e-4);
});

test('graph.targetFPR: values above 0.5 are clamped to 0.5', () => {
  const opts = buildIntentManagerOptions({ graph: { targetFPR: 0.9 } });
  const expected = fprToZScore(0.5); // clamp to 0.5 → Φ⁻¹(0.5) = 0
  assert.ok(Math.abs(opts.graphConfig.divergenceThreshold - expected) < 1e-4);
});

test('graph.targetFPR: NaN falls back to undefined divergenceThreshold (does not propagate NaN)', () => {
  // NaN is non-finite so the Number.isFinite guard treats it as absent; no threshold is set.
  const opts = buildIntentManagerOptions({ graph: { targetFPR: NaN } });
  assert.equal(opts.graphConfig.divergenceThreshold, undefined);
});
