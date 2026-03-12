/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PropensityCalculator Unit Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests are grouped into three sections:
 *
 *  1. updateBaseline — BFS traversal and hitting-probability accumulation
 *  2. getRealTimePropensity — exponential friction formula and throttle gate
 *  3. Property-based — score invariants across arbitrary inputs
 *
 * All timing tests replace globalThis.performance.now with a controllable
 * clock and restore it in a finally block, so failure in one test cannot
 * contaminate another.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PropensityCalculator } from '../dist/src/intent-sdk.js';
import { setupTestEnvironment } from './helpers/test-env.mjs';

setupTestEnvironment();

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal IStateModel stub from a plain adjacency map.
 *
 * `edges` format:
 *   { '/home': [{ state: '/search', probability: 0.8 }, ...], ... }
 *
 * Only `getLikelyNext` is needed by PropensityCalculator; all other methods
 * are stubs that satisfy the structural contract without allocating.
 */
function makeStubModel(edges) {
  return {
    markSeen() {},
    hasSeen() {
      return false;
    },
    recordTransition() {},
    getLikelyNext(state, threshold) {
      return (edges[state] ?? []).filter((e) => e.probability >= threshold);
    },
    evaluateEntropy() {
      return { entropy: 0, normalizedEntropy: 0, isHigh: false };
    },
    evaluateTrajectory() {
      return null;
    },
    serialize() {
      return '';
    },
    restore() {},
  };
}

/**
 * Replace `performance.now` with a controllable clock for the duration of
 * `fn`, then restore the original regardless of whether `fn` throws.
 *
 * @param {(setTime: (ms: number) => void) => void} fn
 */
function withMockClock(fn) {
  let mockMs = 0;
  const origNow = performance.now;
  performance.now = () => mockMs;
  try {
    fn((ms) => {
      mockMs = ms;
    });
  } finally {
    performance.now = origNow;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. updateBaseline
// ─────────────────────────────────────────────────────────────────────────────

test('updateBaseline: currentState === targetState sets baseline to 1', () => {
  const calc = new PropensityCalculator();
  const model = makeStubModel({});
  calc.updateBaseline(model, '/checkout', '/checkout', 3);
  // When already at the target, propensity must be 1 with no friction.
  withMockClock((setTime) => {
    setTime(0);
    assert.equal(calc.getRealTimePropensity(0), 1);
  });
});

test('updateBaseline: direct single-hop path accumulates P(target|current)', () => {
  const calc = new PropensityCalculator();
  const model = makeStubModel({
    A: [{ state: 'B', probability: 0.75 }],
  });
  calc.updateBaseline(model, 'A', 'B', 2);

  withMockClock((setTime) => {
    setTime(0);
    // cachedBaseline = 0.75; z=0 → penalty=1 → propensity=0.75
    assert.ok(
      Math.abs(calc.getRealTimePropensity(0) - 0.75) < 1e-10,
      'single-hop propensity must equal edge probability',
    );
  });
});

test('updateBaseline: two-hop path multiplies edge probabilities', () => {
  const calc = new PropensityCalculator();
  // A → B (P=0.8) → C (P=0.5)
  // Expected hitting probability A→C in 2 hops: 0.8 × 0.5 = 0.4
  const model = makeStubModel({
    A: [{ state: 'B', probability: 0.8 }],
    B: [{ state: 'C', probability: 0.5 }],
  });
  calc.updateBaseline(model, 'A', 'C', 2);

  withMockClock((setTime) => {
    setTime(0);
    assert.ok(
      Math.abs(calc.getRealTimePropensity(0) - 0.4) < 1e-10,
      'two-hop propensity must be product of edge probabilities',
    );
  });
});

test('updateBaseline: multiple parallel paths to target accumulate correctly', () => {
  const calc = new PropensityCalculator();
  // Two parallel paths: A→X→target (0.6 × 1.0 = 0.6) and A→Y→target (0.4 × 1.0 = 0.4)
  // Total hitting probability: 1.0
  const model = makeStubModel({
    A: [
      { state: 'X', probability: 0.6 },
      { state: 'Y', probability: 0.4 },
    ],
    X: [{ state: 'target', probability: 1.0 }],
    Y: [{ state: 'target', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'target', 3);

  withMockClock((setTime) => {
    setTime(0);
    // 0.6 + 0.4 = 1.0 (two converging paths)
    assert.ok(
      Math.abs(calc.getRealTimePropensity(0) - 1.0) < 1e-10,
      'parallel paths must be summed, not only the first path taken',
    );
  });
});

test('updateBaseline: target unreachable within maxDepth returns 0', () => {
  const calc = new PropensityCalculator();
  // No outgoing edges from current state
  const model = makeStubModel({});
  calc.updateBaseline(model, 'A', 'Z', 3);

  withMockClock((setTime) => {
    setTime(0);
    assert.equal(calc.getRealTimePropensity(0), 0, 'unreachable target must produce 0 propensity');
  });
});

test('updateBaseline: target 3 hops away is found at maxDepth=3 but not maxDepth=2', () => {
  const calc = new PropensityCalculator();
  // A→B→C→target, all P=1.0 — target is exactly 3 hops away
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
    B: [{ state: 'C', probability: 1.0 }],
    C: [{ state: 'target', probability: 1.0 }],
  });

  // Both assertions run inside a single withMockClock so we can advance time
  // between them — the maxDepth=2 call sets lastCalculationTime=0 and we must
  // advance past THROTTLE_MS (500 ms) before the maxDepth=3 call or the
  // second getRealTimePropensity would be throttled and return the stale 0.
  withMockClock((setTime) => {
    // maxDepth=2: BFS expands A (depth 0) → B (depth 1) → C (depth 2, at limit).
    // C's neighbours are not expanded because depth+1=2 is NOT < maxDepth=2.
    calc.updateBaseline(model, 'A', 'target', 2);
    setTime(0);
    assert.equal(
      calc.getRealTimePropensity(0),
      0,
      'target at depth 3 must be unreachable with maxDepth=2',
    );

    // Advance past the throttle window so the next call recomputes.
    calc.updateBaseline(model, 'A', 'target', 3);
    setTime(600);
    assert.ok(
      calc.getRealTimePropensity(0) > 0,
      'target at depth 3 must be reachable with maxDepth=3',
    );
  });
});

test('updateBaseline: cycle-safe — cyclic graph does not loop infinitely', () => {
  const calc = new PropensityCalculator();
  // A→B→A cycle with no path to target 'Z'
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
    B: [{ state: 'A', probability: 1.0 }],
  });
  // This must terminate without hanging, returning 0 for unreachable 'Z'
  calc.updateBaseline(model, 'A', 'Z', 10);
  withMockClock((setTime) => {
    setTime(0);
    assert.equal(
      calc.getRealTimePropensity(0),
      0,
      'cyclic graph with no path to target must return 0',
    );
  });
});

test('updateBaseline: visited set prevents duplicate probability counting on cyclic routes', () => {
  const calc = new PropensityCalculator();
  // A→B (0.5), B→A (1.0), B→target (0.5)
  // Without visited set, the cycle A→B→A→B→... would inflate the score.
  // With visited set, A is blocked after the first visit, so only:
  //   path A→B→target contributes: 0.5 × 0.5 = 0.25
  const model = makeStubModel({
    A: [{ state: 'B', probability: 0.5 }],
    B: [
      { state: 'A', probability: 1.0 },
      { state: 'target', probability: 0.5 },
    ],
  });
  calc.updateBaseline(model, 'A', 'target', 3);
  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    // Score must be ≤ 1 and equal to the single simple-path contribution
    assert.ok(score >= 0 && score <= 1, `score must be in [0, 1], got ${score}`);
    assert.ok(
      Math.abs(score - 0.25) < 1e-10,
      `visited set must prevent cycle inflation; expected 0.25, got ${score}`,
    );
  });
});

test('updateBaseline: baseline is clamped to [0, 1]', () => {
  const calc = new PropensityCalculator();
  // Multiple independent paths all reaching target directly — total prob = 1.5
  // (a deliberately degenerate graph to exercise the Math.min(1, ...) clamp)
  const model = makeStubModel({
    A: [
      { state: 'target', probability: 0.8 },
      { state: 'target', probability: 0.7 }, // duplicate target edge (unusual but possible)
    ],
  });
  calc.updateBaseline(model, 'A', 'target', 1);
  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.ok(score <= 1, `propensity must never exceed 1, got ${score}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getRealTimePropensity
// ─────────────────────────────────────────────────────────────────────────────

test('getRealTimePropensity: returns 0 before updateBaseline is called (cold start)', () => {
  withMockClock((setTime) => {
    setTime(0);
    const calc = new PropensityCalculator();
    assert.equal(
      calc.getRealTimePropensity(0),
      0,
      'cold-start propensity must be 0 — no baseline available',
    );
  });
});

test('getRealTimePropensity: z=0 applies no friction (penalty = 1.0)', () => {
  const calc = new PropensityCalculator(0.2, 0); // throttleMs=0 so every call recomputes
  const model = makeStubModel({
    A: [{ state: 'B', probability: 0.6 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    // z=0: exp(-0.2 × max(0, 0)) = exp(0) = 1 → propensity = 0.6 × 1 = 0.6
    assert.ok(
      Math.abs(calc.getRealTimePropensity(0) - 0.6) < 1e-10,
      'z=0 must not reduce propensity below cachedBaseline',
    );
  });
});

test('getRealTimePropensity: positive z-score applies exponential friction penalty', () => {
  const alpha = 0.2;
  const calc = new PropensityCalculator(alpha, 0); // throttleMs=0
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const z = 3.5; // typical divergence threshold
    const expected = 1.0 * Math.exp(-alpha * z); // ≈ 0.497
    const actual = calc.getRealTimePropensity(z);
    assert.ok(
      Math.abs(actual - expected) < 1e-10,
      `z=${z} propensity mismatch: expected ${expected}, got ${actual}`,
    );
    // Must be strictly less than the z=0 baseline
    setTime(1);
    assert.ok(
      calc.getRealTimePropensity(z) < calc.getRealTimePropensity(0),
      'positive z-score must produce lower propensity than z=0',
    );
  });
});

test('getRealTimePropensity: negative z-score is clamped to 0 (no negative friction)', () => {
  const alpha = 0.2;
  const calc = new PropensityCalculator(alpha, 0); // throttleMs=0
  const model = makeStubModel({
    A: [{ state: 'B', probability: 0.7 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    // Negative z: user navigates better than baseline — no friction applied
    const scoreNeg = calc.getRealTimePropensity(-5);
    setTime(1);
    const scoreZero = calc.getRealTimePropensity(0);
    assert.ok(
      Math.abs(scoreNeg - scoreZero) < 1e-10,
      `negative z-score (z=-5) must produce same propensity as z=0: neg=${scoreNeg}, zero=${scoreZero}`,
    );
  });
});

test('getRealTimePropensity: mathematical accuracy — formula matches spec', () => {
  // Verify: propensity = cachedBaseline × exp(-alpha × max(0, z))
  const alpha = 0.35;
  const baseline = 0.72; // P(A → target, maxDepth=1) with edge probability 0.72
  const zScore = 2.8;
  const calc = new PropensityCalculator(alpha, 0); // throttleMs=0

  const model = makeStubModel({
    A: [{ state: 'target', probability: baseline }],
  });
  calc.updateBaseline(model, 'A', 'target', 1);

  withMockClock((setTime) => {
    setTime(0);
    const expected = baseline * Math.exp(-alpha * zScore);
    const actual = calc.getRealTimePropensity(zScore);
    assert.ok(
      Math.abs(actual - expected) < 1e-12,
      `formula mismatch: expected ${expected}, got ${actual}`,
    );
  });
});

test('getRealTimePropensity: very large z-score drives propensity toward 0, never below', () => {
  const calc = new PropensityCalculator(0.2, 0); // throttleMs=0
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(1000); // z=1000: exp(-200) ≈ 7e-88
    assert.ok(score >= 0, 'propensity must never be negative');
    assert.ok(score < 0.001, 'extreme z-score must drive propensity near 0');
  });
});

test('getRealTimePropensity: throttle returns cached value within THROTTLE_MS', () => {
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, 500); // 500ms throttle
    const model = makeStubModel({
      A: [{ state: 'B', probability: 1.0 }],
    });
    calc.updateBaseline(model, 'A', 'B', 1);

    setTime(0);
    // First call: z=0, score = 1.0, primes the throttle window at t=0
    const firstScore = calc.getRealTimePropensity(0);
    assert.ok(Math.abs(firstScore - 1.0) < 1e-10);

    // Within window (t=400ms): pass z=10 — if NOT throttled, score ≈ 0.135
    // If throttled, must return cached 1.0
    setTime(400);
    const throttledScore = calc.getRealTimePropensity(10);
    assert.equal(
      throttledScore,
      firstScore,
      'within THROTTLE_MS, getRealTimePropensity must return cached value regardless of z-score',
    );
  });
});

test('getRealTimePropensity: recomputes after throttle window expires', () => {
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, 500);
    const model = makeStubModel({
      A: [{ state: 'B', probability: 1.0 }],
    });
    calc.updateBaseline(model, 'A', 'B', 1);

    setTime(0);
    const firstScore = calc.getRealTimePropensity(0); // primes cache: score=1.0

    // After throttle expires (t=600ms): must recompute with z=10
    setTime(600);
    const freshScore = calc.getRealTimePropensity(10);
    const expected = 1.0 * Math.exp(-0.2 * 10);

    assert.ok(
      Math.abs(freshScore - expected) < 1e-10,
      `after throttle, score must be recomputed: expected ${expected}, got ${freshScore}`,
    );
    assert.ok(
      freshScore < firstScore,
      'post-throttle score with z=10 must be less than pre-throttle score with z=0',
    );
  });
});

test('getRealTimePropensity: updateBaseline mid-throttle — new baseline reflected after window', () => {
  // This test verifies a subtle contract: if updateBaseline is called within an
  // active throttle window, the new cachedBaseline is NOT visible until the
  // window expires and a fresh computation runs.
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, 500);

    // Graph 1: A→B with P=1.0
    const model1 = makeStubModel({ A: [{ state: 'B', probability: 1.0 }] });
    calc.updateBaseline(model1, 'A', 'B', 1);

    setTime(0);
    const beforeUpdate = calc.getRealTimePropensity(0); // primes cache: score=1.0
    assert.ok(Math.abs(beforeUpdate - 1.0) < 1e-10);

    // Update baseline within throttle window: A→B with P=0.3
    const model2 = makeStubModel({ A: [{ state: 'B', probability: 0.3 }] });
    calc.updateBaseline(model2, 'A', 'B', 1);

    // Still within window: must return stale 1.0
    setTime(300);
    assert.equal(
      calc.getRealTimePropensity(0),
      beforeUpdate,
      'baseline update within throttle window must not be reflected until window expires',
    );

    // After window: must reflect new baseline 0.3
    setTime(600);
    const afterExpiry = calc.getRealTimePropensity(0);
    assert.ok(
      Math.abs(afterExpiry - 0.3) < 1e-10,
      `after throttle expiry, new baseline (0.3) must be used; got ${afterExpiry}`,
    );
  });
});

test('getRealTimePropensity: zero-baseline branch resets lastPropensity — no stale score on next throttled read', () => {
  // Regression: the zero-baseline early-exit path previously set lastCalculationTime
  // but not lastPropensity, so a subsequent throttled call would return the previous
  // non-zero cached score instead of 0.
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0, 500); // alpha=0, 500ms throttle

    // Prime a non-zero score: A→B with P=0.8
    const model1 = makeStubModel({ A: [{ state: 'B', probability: 0.8 }] });
    calc.updateBaseline(model1, 'A', 'B', 1);
    setTime(0);
    const firstScore = calc.getRealTimePropensity(0);
    assert.ok(Math.abs(firstScore - 0.8) < 1e-10, `expected 0.8, got ${firstScore}`);

    // Advance past the throttle window, then call with an unreachable target so
    // the zero-baseline branch executes and sets lastCalculationTime=now.
    const model2 = makeStubModel({}); // no edges → baseline = 0
    calc.updateBaseline(model2, 'A', 'B', 1);
    setTime(600);
    const zeroScore = calc.getRealTimePropensity(0);
    assert.equal(zeroScore, 0, `zero-baseline must return 0, got ${zeroScore}`);

    // Immediately re-call within the new throttle window: must return 0, not the
    // stale 0.8 that was cached before the baseline was cleared.
    setTime(700);
    const throttledScore = calc.getRealTimePropensity(0);
    assert.equal(
      throttledScore,
      0,
      `throttled call after zero-baseline must return 0, not stale ${firstScore}; got ${throttledScore}`,
    );
  });
});

test('getRealTimePropensity: throttle is enforced for zero-baseline calls too', () => {
  // If cachedBaseline=0, the function still advances lastCalculationTime so
  // repeated calls in rapid succession don't hammer performance.now().
  // Observable: calling within 500ms always returns 0 (same as the "primed" value).
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, 500);
    // No updateBaseline → cachedBaseline=0

    setTime(0);
    assert.equal(calc.getRealTimePropensity(0), 0, 'no baseline → 0');
    setTime(300);
    assert.equal(
      calc.getRealTimePropensity(0),
      0,
      'within throttle with no baseline → still 0 (throttled)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Constructor options
// ─────────────────────────────────────────────────────────────────────────────

test('constructor: custom alpha changes friction magnitude', () => {
  const zScore = 3.5;
  const baselineProb = 1.0;

  const calcLow = new PropensityCalculator(0.05, 0); // gentle friction
  const calcHigh = new PropensityCalculator(0.5, 0); // aggressive friction

  const model = makeStubModel({ A: [{ state: 'B', probability: baselineProb }] });
  calcLow.updateBaseline(model, 'A', 'B', 1);
  calcHigh.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const scoreLow = calcLow.getRealTimePropensity(zScore);
    setTime(0);
    const scoreHigh = calcHigh.getRealTimePropensity(zScore);

    assert.ok(
      scoreLow > scoreHigh,
      `lower alpha must produce less friction: low=${scoreLow}, high=${scoreHigh}`,
    );
    assert.ok(
      Math.abs(scoreLow - Math.exp(-0.05 * zScore)) < 1e-10,
      'low-alpha score must match formula',
    );
    assert.ok(
      Math.abs(scoreHigh - Math.exp(-0.5 * zScore)) < 1e-10,
      'high-alpha score must match formula',
    );
  });
});

test('constructor: custom throttleMs overrides the 500ms default', () => {
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, 100); // 100ms throttle
    const model = makeStubModel({ A: [{ state: 'B', probability: 1.0 }] });
    calc.updateBaseline(model, 'A', 'B', 1);

    setTime(0);
    const first = calc.getRealTimePropensity(0); // primes cache: 1.0

    // Still within 100ms window
    setTime(80);
    assert.equal(
      calc.getRealTimePropensity(10),
      first,
      'within custom 100ms throttle, must return cached value',
    );

    // Past the 100ms window (well before the default 500ms)
    setTime(150);
    const fresh = calc.getRealTimePropensity(10);
    const expected = 1.0 * Math.exp(-0.2 * 10);
    assert.ok(
      Math.abs(fresh - expected) < 1e-10,
      `custom throttleMs=100: after 150ms, score must recompute; expected ${expected}, got ${fresh}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Input validation / sanitization guards
// ─────────────────────────────────────────────────────────────────────────────

test('input: alpha=NaN falls back to 0 — no friction applied', () => {
  // NaN alpha: Math.exp(-NaN × z) = NaN, corrupting lastPropensity.
  // Guard clamps invalid alpha to 0 (no friction), so propensity === cachedBaseline.
  const calc = new PropensityCalculator(NaN, 0);
  const model = makeStubModel({ A: [{ state: 'B', probability: 0.7 }] });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(5); // large z would reduce score if alpha > 0
    assert.ok(Number.isFinite(score), `score must be finite after alpha=NaN; got ${score}`);
    assert.ok(
      Math.abs(score - 0.7) < 1e-10,
      `alpha=NaN must be treated as 0 (no friction): expected 0.7, got ${score}`,
    );
  });
});

test('input: alpha negative falls back to 0 — no friction applied', () => {
  // Negative alpha inverts the friction relationship: higher z → higher propensity,
  // violating the [0, 1] contract.  Guard clamps negative alpha to 0.
  const calc = new PropensityCalculator(-0.5, 0);
  const model = makeStubModel({ A: [{ state: 'B', probability: 0.6 }] });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(3);
    assert.ok(score >= 0 && score <= 1, `score must be in [0, 1], got ${score}`);
    assert.ok(
      Math.abs(score - 0.6) < 1e-10,
      `alpha=-0.5 must be treated as 0 (no friction): expected 0.6, got ${score}`,
    );
  });
});

test('input: throttleMs=NaN falls back to 500ms default', () => {
  // NaN throttleMs: `now - last < NaN` is always false, disabling throttling silently.
  // Guard falls back to 500ms so the throttle window behaves as documented.
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, NaN);
    const model = makeStubModel({ A: [{ state: 'B', probability: 1.0 }] });
    calc.updateBaseline(model, 'A', 'B', 1);

    setTime(0);
    const first = calc.getRealTimePropensity(0); // primes cache
    assert.ok(Math.abs(first - 1.0) < 1e-10);

    // 400ms later — within the 500ms fallback window: must return cached value.
    setTime(400);
    assert.equal(
      calc.getRealTimePropensity(10),
      first,
      'throttleMs=NaN must fall back to 500ms; call at 400ms must be throttled',
    );

    // 600ms later — past the 500ms window: must recompute.
    setTime(600);
    const fresh = calc.getRealTimePropensity(10);
    assert.ok(
      fresh < first,
      'throttleMs=NaN fallback: after 600ms, score must recompute with z=10',
    );
  });
});

test('input: throttleMs=Infinity falls back to 500ms default', () => {
  // Infinity throttleMs: `now - last < Infinity` is always true after the first
  // computation, freezing the score forever.  Guard falls back to 500ms.
  withMockClock((setTime) => {
    const calc = new PropensityCalculator(0.2, Infinity);
    const model = makeStubModel({ A: [{ state: 'B', probability: 1.0 }] });
    calc.updateBaseline(model, 'A', 'B', 1);

    setTime(0);
    const first = calc.getRealTimePropensity(0); // primes cache: 1.0

    // 600ms later — past the 500ms fallback window: must recompute with z=10.
    setTime(600);
    const fresh = calc.getRealTimePropensity(10);
    assert.ok(
      fresh < first,
      'throttleMs=Infinity fallback: after 600ms score must recompute, not be frozen',
    );
  });
});

test('input: updateBaseline maxDepth=NaN falls back to depth 3', () => {
  // NaN maxDepth: `depth + 1 < NaN` is always false, so only direct target edges
  // are accumulated (non-target neighbours are never enqueued).
  // Guard falls back to 3, allowing multi-hop paths to be found.
  const calc = new PropensityCalculator(0, 0);
  // 3-hop chain — unreachable with maxDepth=NaN (which behaves as depth 1),
  // reachable with the fallback maxDepth=3.
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
    B: [{ state: 'C', probability: 1.0 }],
    C: [{ state: 'target', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'target', NaN);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.ok(
      Math.abs(score - 1.0) < 1e-10,
      `maxDepth=NaN must fall back to 3 and find 3-hop path; expected 1.0, got ${score}`,
    );
  });
});

test('input: updateBaseline maxDepth=Infinity falls back to depth 3', () => {
  // Infinity maxDepth removes the depth gate entirely, risking unbounded BFS.
  // Guard falls back to 3.  Verify by using a 4-hop chain: with the fallback,
  // only paths up to 3 hops are explored, so the 4-hop target is not found.
  const calc = new PropensityCalculator(0, 0);
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
    B: [{ state: 'C', probability: 1.0 }],
    C: [{ state: 'D', probability: 1.0 }],
    D: [{ state: 'target', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'target', Infinity);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.equal(
      score,
      0,
      `maxDepth=Infinity must fall back to 3; 4-hop target must not be found, got ${score}`,
    );
  });
});

test('input: getRealTimePropensity(NaN) treated as z=0, does not corrupt lastPropensity', () => {
  // NaN z-score propagates through Math.exp(-alpha × NaN) = NaN, storing NaN in
  // lastPropensity.  Guard replaces NaN with 0 (no friction).
  const calc = new PropensityCalculator(0.2, 500);
  const model = makeStubModel({ A: [{ state: 'B', probability: 0.8 }] });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(NaN);
    assert.ok(Number.isFinite(score), `NaN z-score must not corrupt score; got ${score}`);
    assert.ok(
      Math.abs(score - 0.8) < 1e-10,
      `NaN z-score must be treated as 0 (no friction): expected 0.8, got ${score}`,
    );

    // Verify lastPropensity is also clean: next throttled read returns the same finite value.
    setTime(100);
    const throttled = calc.getRealTimePropensity(NaN);
    assert.ok(
      Number.isFinite(throttled),
      `lastPropensity must not be NaN after NaN z-score; got ${throttled}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Property-based invariants
// ─────────────────────────────────────────────────────────────────────────────

test('property: score is always in [0, 1] for any non-negative z-score and valid baseline', () => {
  const zScores = [0, 0.001, 1, 3.5, 10, 100, Number.MAX_SAFE_INTEGER];
  const baselineProbs = [0, 0.01, 0.5, 0.99, 1.0];

  withMockClock((setTime) => {
    for (const prob of baselineProbs) {
      for (const z of zScores) {
        const calc = new PropensityCalculator(0.2, 0);
        if (prob > 0) {
          const model = makeStubModel({ A: [{ state: 'B', probability: prob }] });
          calc.updateBaseline(model, 'A', 'B', 1);
        }
        setTime(0);
        const score = calc.getRealTimePropensity(z);
        assert.ok(
          score >= 0 && score <= 1,
          `score out of [0,1]: baseline=${prob}, z=${z}, score=${score}`,
        );
      }
    }
  });
});

test('property: higher z-score always produces lower or equal propensity (monotonically decreasing)', () => {
  const calc = new PropensityCalculator(0.2, 0); // throttleMs=0 so each call recomputes
  const model = makeStubModel({ A: [{ state: 'B', probability: 0.8 }] });
  calc.updateBaseline(model, 'A', 'B', 1);

  const zScores = [0, 0.5, 1.0, 2.0, 3.5, 5.0, 10.0];

  withMockClock((setTime) => {
    let prevScore = Infinity;
    for (let i = 0; i < zScores.length; i++) {
      setTime(i); // advance time so throttle never fires
      const score = calc.getRealTimePropensity(zScores[i]);
      assert.ok(
        score <= prevScore,
        `propensity must be monotonically non-increasing as z rises; ` +
          `z[${i}]=${zScores[i]}: score=${score}, prev=${prevScore}`,
      );
      prevScore = score;
    }
  });
});

test('property: updateBaseline on empty graph always produces 0 propensity', () => {
  withMockClock((setTime) => {
    const zScores = [0, 1, 3.5, 10];
    for (const z of zScores) {
      const calc = new PropensityCalculator(0.2, 0);
      calc.updateBaseline(makeStubModel({}), 'A', 'B', 5);
      setTime(0);
      assert.equal(
        calc.getRealTimePropensity(z),
        0,
        `empty graph must produce 0 propensity for any z=${z}`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Mathematical edge cases and formula verification
// ─────────────────────────────────────────────────────────────────────────────

test('math: alpha=0 → no friction — propensity equals cachedBaseline for any z-score', () => {
  // exp(-0 × z) = exp(0) = 1 for all z, so the friction penalty is always 1.
  // Verifies that alpha is a true scaling coefficient and does not corrupt the
  // formula when set to 0.
  const calc = new PropensityCalculator(0, 0); // alpha=0, throttleMs=0
  const model = makeStubModel({
    A: [{ state: 'B', probability: 0.65 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  const zScores = [0, 1, 3.5, 10, 100];
  withMockClock((setTime) => {
    for (let i = 0; i < zScores.length; i++) {
      setTime(i);
      const score = calc.getRealTimePropensity(zScores[i]);
      assert.ok(
        Math.abs(score - 0.65) < 1e-12,
        `alpha=0 must produce no friction at z=${zScores[i]}: expected 0.65, got ${score}`,
      );
    }
  });
});

test('math: half-life identity — at z = ln(2)/alpha, propensity equals baseline/2', () => {
  // The exponential decay formula exp(-alpha × z) reaches 0.5 exactly when
  // z = ln(2) / alpha. This is the "half-life" of the propensity signal.
  // Derived from: exp(-alpha × z_half) = 0.5 → z_half = ln(2) / alpha.
  const alpha = 0.2;
  const baseline = 0.8;
  const calc = new PropensityCalculator(alpha, 0);
  const model = makeStubModel({
    A: [{ state: 'B', probability: baseline }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  const zHalf = Math.LN2 / alpha; // ln(2) / 0.2 ≈ 3.466
  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(zHalf);
    assert.ok(
      Math.abs(score - baseline / 2) < 1e-12,
      `half-life identity failed: expected ${baseline / 2}, got ${score}`,
    );
  });
});

test('math: decay ratio — doubling z-score squares the decay factor', () => {
  // exp(-alpha × 2z) = [exp(-alpha × z)]^2, so doubling z squares the decay.
  // This is a pure algebraic identity that must hold in IEEE 754 double precision.
  const alpha = 0.3;
  const calc = new PropensityCalculator(alpha, 0);
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  const z = 2.0;
  withMockClock((setTime) => {
    setTime(0);
    const scoreZ = calc.getRealTimePropensity(z);
    setTime(1);
    const scoreDoubleZ = calc.getRealTimePropensity(2 * z);

    const expected = scoreZ * scoreZ; // [exp(-alpha × z)]^2
    assert.ok(
      Math.abs(scoreDoubleZ - expected) < 1e-12,
      `decay ratio identity failed: score(2z)=${scoreDoubleZ}, score(z)^2=${expected}`,
    );
  });
});

test('math: three-hop chain probability is exact product of all three edge probabilities', () => {
  // P(A→target via A→B→C→target) = P(B|A) × P(C|B) × P(target|C)
  // The BFS must multiply probabilities correctly across three levels of depth.
  const pAB = 0.9;
  const pBC = 0.7;
  const pCT = 0.6;
  const expected = pAB * pBC * pCT; // 0.9 × 0.7 × 0.6 = 0.378

  const calc = new PropensityCalculator(0, 0); // alpha=0 so score == baseline
  const model = makeStubModel({
    A: [{ state: 'B', probability: pAB }],
    B: [{ state: 'C', probability: pBC }],
    C: [{ state: 'target', probability: pCT }],
  });
  calc.updateBaseline(model, 'A', 'target', 3);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.ok(
      Math.abs(score - expected) < 1e-12,
      `3-hop probability product failed: expected ${expected}, got ${score}`,
    );
  });
});

test('math: parallel paths at different hop depths accumulate independently', () => {
  // Short path: A→target (P=0.3, 1 hop)
  // Long path:  A→mid→target (P=0.6 × 0.8 = 0.48, 2 hops)
  // Total hitting probability: 0.3 + 0.48 = 0.78
  const calc = new PropensityCalculator(0, 0);
  const model = makeStubModel({
    A: [
      { state: 'target', probability: 0.3 },
      { state: 'mid', probability: 0.6 },
    ],
    mid: [{ state: 'target', probability: 0.8 }],
  });
  calc.updateBaseline(model, 'A', 'target', 2);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.ok(
      Math.abs(score - 0.78) < 1e-12,
      `mixed-depth parallel accumulation failed: expected 0.78, got ${score}`,
    );
  });
});

test('math: direct target edge always accumulated regardless of maxDepth', () => {
  // The BFS checks if the neighbor IS the target before applying the depth gate,
  // so a 1-hop A→target edge is always found at any maxDepth ≥ 1.
  const model = makeStubModel({
    A: [{ state: 'target', probability: 0.55 }],
  });

  const depths = [1, 2, 5, 10];
  withMockClock((setTime) => {
    for (let i = 0; i < depths.length; i++) {
      const c = new PropensityCalculator(0, 0);
      c.updateBaseline(model, 'A', 'target', depths[i]);
      setTime(i);
      const score = c.getRealTimePropensity(0);
      assert.ok(
        Math.abs(score - 0.55) < 1e-12,
        `direct edge must be found at maxDepth=${depths[i]}: expected 0.55, got ${score}`,
      );
    }
  });
});

test('updateBaseline: converging simple paths through shared intermediate state both accumulate', () => {
  // Regression for the global-visited-set bug.
  //
  // Graph:
  //   A → M → target   (path 1: 0.5 × 0.8 = 0.40)
  //   A → B → M → target (path 2: 0.6 × 1.0 × 0.8 = 0.48)
  //
  // Both paths are simple (no repeated nodes within each path) but they share
  // the intermediate state M.  With a global visited set, M is marked after
  // path 1 is enqueued, so path 2's copy of M is silently dropped, yielding
  // only 0.40 instead of the correct 0.40 + 0.48 = 0.88.
  const calc = new PropensityCalculator(0, 0); // alpha=0 so score == baseline
  const model = makeStubModel({
    A: [
      { state: 'M', probability: 0.5 },
      { state: 'B', probability: 0.6 },
    ],
    B: [{ state: 'M', probability: 1.0 }],
    M: [{ state: 'target', probability: 0.8 }],
  });
  calc.updateBaseline(model, 'A', 'target', 3);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    // Expected: 0.40 + 0.48 = 0.88
    assert.ok(
      Math.abs(score - 0.88) < 1e-10,
      `converging simple paths must both accumulate; expected 0.88, got ${score}`,
    );
  });
});

test('math: successive updateBaseline calls — last call fully overwrites cachedBaseline', () => {
  // updateBaseline must replace the previous cached score with no blending,
  // averaging, or accumulation across multiple calls.
  const calc = new PropensityCalculator(0, 0);

  // First baseline: A→B with P=0.9
  calc.updateBaseline(makeStubModel({ A: [{ state: 'B', probability: 0.9 }] }), 'A', 'B', 1);
  // Immediately overwrite: A→B with P=0.1
  calc.updateBaseline(makeStubModel({ A: [{ state: 'B', probability: 0.1 }] }), 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.ok(
      Math.abs(score - 0.1) < 1e-12,
      `second updateBaseline must fully overwrite first: expected 0.1, got ${score}`,
    );
  });
});

test('math: throttleMs=0 — distinct z-scores at the same timestamp produce distinct scores', () => {
  // With THROTTLE_MS=0, the condition (now - lastCalculationTime < 0) is always
  // false, so every call recomputes regardless of the elapsed time.
  const alpha = 0.5;
  const calc = new PropensityCalculator(alpha, 0);
  const model = makeStubModel({
    A: [{ state: 'B', probability: 1.0 }],
  });
  calc.updateBaseline(model, 'A', 'B', 1);

  withMockClock((setTime) => {
    setTime(0);
    const s0 = calc.getRealTimePropensity(0); // exp(-0.5 × 0) = 1.0
    const s2 = calc.getRealTimePropensity(2); // exp(-0.5 × 2) ≈ 0.368

    assert.ok(Math.abs(s0 - 1.0) < 1e-12, `z=0: expected 1.0, got ${s0}`);
    assert.ok(
      Math.abs(s2 - Math.exp(-alpha * 2)) < 1e-12,
      `z=2: expected ${Math.exp(-alpha * 2)}, got ${s2}`,
    );
    assert.notEqual(s0, s2, 'throttleMs=0: distinct z-scores at same timestamp must differ');
  });
});

test('math: probability clamp prevents baseline from exceeding 1.0 on degenerate graphs', () => {
  // Two direct edges to the same target with probabilities summing to > 1.0.
  // The Math.min(1, accumulated) clamp must prevent an impossible baseline.
  const calc = new PropensityCalculator(0, 0);
  const model = makeStubModel({
    A: [
      { state: 'target', probability: 0.6 },
      { state: 'target', probability: 0.7 }, // duplicate: total = 1.3
    ],
  });
  calc.updateBaseline(model, 'A', 'target', 1);

  withMockClock((setTime) => {
    setTime(0);
    const score = calc.getRealTimePropensity(0);
    assert.ok(score <= 1.0, `clamp failed: expected ≤ 1.0, got ${score}`);
    assert.ok(Math.abs(score - 1.0) < 1e-12, `clamped score must equal 1.0, got ${score}`);
  });
});

test('math: friction formula verified across a dense (alpha × z) grid', () => {
  // Exhaustive verification of propensity = baseline × exp(-alpha × z) across
  // three alpha values and 14 z-scores to within double-precision accuracy.
  const alphas = [0.1, 0.2, 0.5];
  const zGrid = [0, 0.1, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 7.5, 10.0, 20.0];
  const baseline = 0.75;
  const model = makeStubModel({ A: [{ state: 'B', probability: baseline }] });

  withMockClock((setTime) => {
    let tick = 0;
    for (const alpha of alphas) {
      const calc = new PropensityCalculator(alpha, 0);
      calc.updateBaseline(model, 'A', 'B', 1);
      for (const z of zGrid) {
        setTime(tick++);
        const actual = calc.getRealTimePropensity(z);
        const expected = baseline * Math.exp(-alpha * z);
        assert.ok(
          Math.abs(actual - expected) < 1e-12,
          `formula grid — alpha=${alpha}, z=${z}: expected ${expected}, got ${actual}`,
        );
      }
    }
  });
});
