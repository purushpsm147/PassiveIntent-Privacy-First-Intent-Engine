/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCalibration } from '../dist/src/calibration.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seeded LCG pseudo-random number generator (portable, no imports needed). */
function makePrng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Produce `n` log-likelihood-like values from a Normal(mean, std) distribution. */
function generateNormal(n, mean, std, seed = 42) {
  const rand = makePrng(seed);
  const samples = [];
  for (let i = 0; i < n; i += 2) {
    // Box-Muller
    const u1 = rand() || 1e-12;
    const u2 = rand();
    const mag = std * Math.sqrt(-2 * Math.log(u1));
    samples.push(mean + mag * Math.cos(2 * Math.PI * u2));
    if (i + 1 < n) samples.push(mean + mag * Math.sin(2 * Math.PI * u2));
  }
  return samples.slice(0, n);
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('runCalibration throws RangeError on empty input', () => {
  assert.throws(() => runCalibration([]), RangeError);
});

// ---------------------------------------------------------------------------
// Single element
// ---------------------------------------------------------------------------

test('runCalibration handles a single-element array', () => {
  const result = runCalibration([-3.5]);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.baselineMeanLL, -3.5);
  assert.equal(result.baselineStdLL, 0);
  assert.equal(result.p5, -3.5);
  assert.equal(result.p95, -3.5);
});

// ---------------------------------------------------------------------------
// All-same values
// ---------------------------------------------------------------------------

test('runCalibration with uniform values has std=0 and all percentiles equal', () => {
  const logs = Array(50).fill(-2.0);
  const result = runCalibration(logs);
  assert.equal(result.baselineMeanLL, -2.0);
  assert.equal(result.baselineStdLL, 0);
  assert.equal(result.p5, -2.0);
  assert.equal(result.p95, -2.0);
  assert.equal(result.sampleSize, 50);
});

// ---------------------------------------------------------------------------
// Known small dataset — exact arithmetic
// ---------------------------------------------------------------------------

test('runCalibration computes exact mean and population std for [−2, −4, −6]', () => {
  // mean = −4, population variance = ((4+0+4)/3) = 8/3, std = sqrt(8/3)
  const logs = [-2, -4, -6];
  const result = runCalibration(logs);
  const expectedMean = -4;
  const expectedStd = Math.sqrt(8 / 3);

  assert.ok(Math.abs(result.baselineMeanLL - expectedMean) < 1e-10, 'mean');
  assert.ok(Math.abs(result.baselineStdLL - expectedStd) < 1e-10, 'std');
  assert.equal(result.sampleSize, 3);
});

test('runCalibration percentile interpolation for [−6, −4, −2] (sorted)', () => {
  // sorted: [−6, −4, −2], n=3
  // p5:  idx = 0.05 * 2 = 0.1  → −6 * 0.9 + −4 * 0.1 = −5.8
  // p95: idx = 0.95 * 2 = 1.9  → −4 * 0.1 + −2 * 0.9 = −2.2
  const result = runCalibration([-2, -4, -6]);
  assert.ok(Math.abs(result.p5 - -5.8) < 1e-10, `p5 expected -5.8, got ${result.p5}`);
  assert.ok(Math.abs(result.p95 - -2.2) < 1e-10, `p95 expected -2.2, got ${result.p95}`);
});

// ---------------------------------------------------------------------------
// Monotonicity invariant: p5 ≤ mean ≤ p95
// ---------------------------------------------------------------------------

test('runCalibration satisfies p5 ≤ mean ≤ p95 for varied datasets', () => {
  const datasets = [
    generateNormal(10, -3, 0.5, 1),
    generateNormal(100, -4, 1.2, 2),
    generateNormal(500, -3.5, 0.9, 3),
    [-10, -1, -5, -3, -2, -8, -4, -6, -2.5, -3.5],
  ];

  for (const logs of datasets) {
    const r = runCalibration(logs);
    assert.ok(r.p5 <= r.baselineMeanLL, `p5 (${r.p5}) should be ≤ mean (${r.baselineMeanLL})`);
    assert.ok(r.baselineMeanLL <= r.p95, `mean (${r.baselineMeanLL}) should be ≤ p95 (${r.p95})`);
  }
});

// ---------------------------------------------------------------------------
// Statistical accuracy on a large synthetic sample
// ---------------------------------------------------------------------------

test('runCalibration recovers mean/std within 5% on N=1000 normal sample', () => {
  const trueMean = -3.47;
  const trueStd = 0.91;
  const logs = generateNormal(1000, trueMean, trueStd, 42);
  const result = runCalibration(logs);

  assert.equal(result.sampleSize, 1000);

  const meanErr = Math.abs(result.baselineMeanLL - trueMean) / Math.abs(trueMean);
  const stdErr = Math.abs(result.baselineStdLL - trueStd) / trueStd;

  assert.ok(meanErr < 0.05, `mean relative error ${(meanErr * 100).toFixed(2)}% exceeds 5%`);
  assert.ok(stdErr < 0.05, `std relative error ${(stdErr * 100).toFixed(2)}% exceeds 5%`);
});

test('runCalibration p5/p95 cover ~90% of a large normal sample', () => {
  const logs = generateNormal(2000, -3.5, 1.0, 99);
  const { p5, p95 } = runCalibration(logs);

  // Count values in [p5, p95]
  const inside = logs.filter((v) => v >= p5 && v <= p95).length;
  const coverage = inside / logs.length;

  // With a proper 5th/95th percentile, ~90% of the sample should fall inside ±1%
  assert.ok(coverage >= 0.88, `coverage ${(coverage * 100).toFixed(1)}% is below 88%`);
  assert.ok(coverage <= 0.92, `coverage ${(coverage * 100).toFixed(1)}% is above 92%`);
});

// ---------------------------------------------------------------------------
// Result does not mutate the input array
// ---------------------------------------------------------------------------

test('runCalibration does not mutate the input array', () => {
  const logs = [-5, -1, -3, -2, -4];
  const original = logs.slice();
  runCalibration(logs);
  assert.deepEqual(logs, original);
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

test('runCalibration returns an object with the expected keys', () => {
  const result = runCalibration([-3, -4, -2]);
  const keys = ['baselineMeanLL', 'baselineStdLL', 'sampleSize', 'p5', 'p95'];
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing key: ${key}`);
    assert.ok(typeof result[key] === 'number', `${key} should be a number`);
  }
});
