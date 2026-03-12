/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PropensityCalculator — E2E Integration Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * These tests run in a real Chromium browser (Cypress) to verify:
 *
 *   1. The class is correctly bundled and accessible in the browser.
 *   2. `performance.now()` integration works with the real browser timer.
 *   3. The throttle gate behaves correctly when time advances via
 *      `win.performance.now` override — the same pattern used in intent.cy.ts
 *      for session_stale tests.
 *   4. Full integration with `MarkovGraph` (available via __PassiveIntentSDK)
 *      as a backing IStateModel, exercising the actual BFS graph traversal.
 *
 * Sandbox: sandbox/index.html
 * SDK access: window.__PassiveIntentSDK.PropensityCalculator
 *             window.__PassiveIntentSDK.MarkovGraph
 *
 * All tests are self-contained within cy.window() callbacks — no UI clicks
 * are needed because PropensityCalculator is a pure-computation utility.
 */

export {};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal IStateModel-compatible wrapper around a `MarkovGraph`
 * instance, mapping the graph's `getLikelyNextStates` to the `getLikelyNext`
 * contract expected by `PropensityCalculator.updateBaseline`.
 */
function wrapGraph(graph: {
  getLikelyNextStates(state: string, threshold: number): { state: string; probability: number }[];
}): {
  markSeen(): void;
  hasSeen(): boolean;
  recordTransition(): void;
  getLikelyNext(state: string, threshold: number): { state: string; probability: number }[];
  evaluateEntropy(): { entropy: number; normalizedEntropy: number; isHigh: boolean };
  evaluateTrajectory(): null;
  serialize(): string;
  restore(): void;
} {
  return {
    markSeen() {},
    hasSeen() {
      return false;
    },
    recordTransition() {},
    getLikelyNext(state, threshold) {
      return graph.getLikelyNextStates(state, threshold);
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('PropensityCalculator — browser integration', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Availability
  // ─────────────────────────────────────────────────────────────────────────

  it('Test AL: PropensityCalculator is exported and accessible via __PassiveIntentSDK', () => {
    cy.window().then((win) => {
      const { PropensityCalculator } = (win as any).__PassiveIntentSDK;
      expect(PropensityCalculator).to.be.a(
        'function',
        '__PassiveIntentSDK.PropensityCalculator must be a constructor',
      );

      // Instantiate with defaults — must not throw
      const calc = new PropensityCalculator();
      expect(calc).to.be.an('object');
      expect(calc.updateBaseline).to.be.a('function');
      expect(calc.getRealTimePropensity).to.be.a('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cold start (no baseline)
  // ─────────────────────────────────────────────────────────────────────────

  it('Test AM: getRealTimePropensity returns 0 before updateBaseline is called', () => {
    cy.window().then((win) => {
      const { PropensityCalculator } = (win as any).__PassiveIntentSDK;
      const calc = new PropensityCalculator();
      expect(calc.getRealTimePropensity(0)).to.equal(0, 'cold-start score must be 0');
      expect(calc.getRealTimePropensity(3.5)).to.equal(0, 'cold-start score must be 0 for any z');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Baseline from real MarkovGraph
  // ─────────────────────────────────────────────────────────────────────────

  it('Test AN: updateBaseline with a reachable target produces a score in (0, 1]', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      // Build a funnel: /home → /search → /checkout (smoothingAlpha:0 for exact probabilities)
      const graph = new MarkovGraph({ smoothingAlpha: 0 });
      graph.incrementTransition('/home', '/search');
      graph.incrementTransition('/search', '/checkout');

      const model = wrapGraph(graph);
      const calc = new PropensityCalculator(0.2, 0); // throttleMs=0 for deterministic testing

      calc.updateBaseline(model, '/home', '/checkout', 3);

      const score = calc.getRealTimePropensity(0);
      expect(score).to.be.greaterThan(0, 'reachable target must produce score > 0');
      expect(score).to.be.at.most(1, 'score must never exceed 1');
    });
  });

  it('Test AO: updateBaseline with an unreachable target returns 0', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      // Graph with no edges at all
      const graph = new MarkovGraph({ smoothingAlpha: 0 });
      const model = wrapGraph(graph);
      const calc = new PropensityCalculator(0.2, 0);

      calc.updateBaseline(model, '/home', '/checkout', 3);
      expect(calc.getRealTimePropensity(0)).to.equal(0, 'no path to target must produce 0');
    });
  });

  it('Test AP: hitting probability for a linear funnel matches expected product of probabilities', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      // Train the funnel A→B three times so P(B|A) = 1.0, then A→C once (P=0.25, P(B|A)=0.75)
      const graph = new MarkovGraph({ smoothingAlpha: 0 });
      for (let i = 0; i < 3; i++) graph.incrementTransition('A', 'B');
      graph.incrementTransition('A', 'C'); // 1/4 of A's exits go to C

      const model = wrapGraph(graph);
      const calc = new PropensityCalculator(0.2, 0);
      calc.updateBaseline(model, 'A', 'B', 1); // maxDepth=1: direct edge only

      const score = calc.getRealTimePropensity(0);
      // P(B|A) = 3/4 = 0.75; z=0 → no friction
      expect(score).to.be.closeTo(
        0.75,
        1e-9,
        'score must equal P(B|A)=0.75 for a direct 1-hop funnel',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Friction penalty
  // ─────────────────────────────────────────────────────────────────────────

  it('Test AQ: positive z-score reduces propensity via exponential decay', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      const graph = new MarkovGraph({ smoothingAlpha: 0 });
      graph.incrementTransition('/home', '/checkout');
      const model = wrapGraph(graph);

      const alpha = 0.2;
      const calc = new PropensityCalculator(alpha, 0);
      calc.updateBaseline(model, '/home', '/checkout', 1);

      const scoreNoFriction = calc.getRealTimePropensity(0);
      const scoreWithFriction = calc.getRealTimePropensity(3.5);
      const expectedFriction = scoreNoFriction * Math.exp(-alpha * 3.5);

      expect(scoreWithFriction).to.be.below(
        scoreNoFriction,
        'positive z-score must reduce propensity',
      );
      expect(scoreWithFriction).to.be.closeTo(
        expectedFriction,
        1e-9,
        'friction penalty must match exp(-alpha × z)',
      );
    });
  });

  it('Test AR: negative z-score does not reduce propensity (max(0, z) clamp)', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      const graph = new MarkovGraph({ smoothingAlpha: 0 });
      graph.incrementTransition('/home', '/checkout');
      const model = wrapGraph(graph);

      const calc = new PropensityCalculator(0.2, 0);
      calc.updateBaseline(model, '/home', '/checkout', 1);

      const scoreZero = calc.getRealTimePropensity(0);
      const scoreNegative = calc.getRealTimePropensity(-5);

      expect(scoreNegative).to.be.closeTo(
        scoreZero,
        1e-9,
        'negative z-score must produce same propensity as z=0 (no negative friction)',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Throttle — real browser performance.now() override
  // ─────────────────────────────────────────────────────────────────────────

  it('Test AS: throttle returns cached value within THROTTLE_MS using real browser timer override', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      // Replace performance.now with a controllable clock — same technique
      // used in Tests AI/AJ for session_stale verification.
      let mockTime = 0;
      const origNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      try {
        const graph = new MarkovGraph({ smoothingAlpha: 0 });
        graph.incrementTransition('A', 'B');
        const model = wrapGraph(graph);

        const calc = new PropensityCalculator(0.2, 500); // 500ms throttle
        calc.updateBaseline(model, 'A', 'B', 1);

        // t=0: first call (z=0) primes cache with score=1.0
        mockTime = 0;
        const first = calc.getRealTimePropensity(0);
        expect(first).to.equal(1, 'baseline probability must be 1 for single observed transition');

        // t=400ms (within 500ms window): z=10 would produce ≈0.135 if not throttled
        mockTime = 400;
        const throttled = calc.getRealTimePropensity(10);
        expect(throttled).to.equal(
          first,
          'within throttle window, cached score must be returned regardless of z-score',
        );

        // t=600ms (past window): z=10 must produce fresh computation
        mockTime = 600;
        const fresh = calc.getRealTimePropensity(10);
        const expected = 1.0 * Math.exp(-0.2 * 10);
        expect(fresh).to.be.closeTo(
          expected,
          1e-9,
          'after throttle expiry, score must be recomputed with new z-score',
        );
        expect(fresh).to.be.below(
          first,
          'post-throttle score with z=10 must be less than z=0 score',
        );
      } finally {
        // Always restore the clock so Cypress timers are not affected
        win.performance.now = origNow;
      }
    });
  });

  it('Test AT: throttle window resets after each fresh computation', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      let mockTime = 0;
      const origNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      try {
        const graph = new MarkovGraph({ smoothingAlpha: 0 });
        graph.incrementTransition('A', 'B');
        const model = wrapGraph(graph);

        const calc = new PropensityCalculator(0.2, 500);
        calc.updateBaseline(model, 'A', 'B', 1);

        // First computation at t=0
        mockTime = 0;
        calc.getRealTimePropensity(0);

        // Fresh computation at t=600ms (past first window)
        mockTime = 600;
        const secondScore = calc.getRealTimePropensity(0);

        // New throttle window starts at t=600ms
        // t=900ms is only 300ms past t=600ms — must still be throttled
        mockTime = 900;
        const shouldBeThrottled = calc.getRealTimePropensity(10);
        expect(shouldBeThrottled).to.equal(
          secondScore,
          'throttle window must reset after each fresh computation',
        );

        // t=1200ms is 600ms past t=600ms — must recompute
        mockTime = 1200;
        const shouldBeFrech = calc.getRealTimePropensity(10);
        expect(shouldBeFrech).to.be.below(
          secondScore,
          'score at t=1200ms (z=10) must be lower than score at t=600ms (z=0)',
        );
      } finally {
        win.performance.now = origNow;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration with real navigation data
  // ─────────────────────────────────────────────────────────────────────────

  it('Test AU: propensity increases as more evidence of a funnel path is observed', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      const graph = new MarkovGraph({ smoothingAlpha: 0 });
      const calc = new PropensityCalculator(0.2, 0); // throttleMs=0

      // Initially: graph is cold — A→target path has been seen once
      graph.incrementTransition('A', 'target');
      // Also add a competing edge so P(target|A) < 1
      graph.incrementTransition('A', 'other');

      calc.updateBaseline(wrapGraph(graph), 'A', 'target', 1);
      const scoreAfterFewSamples = calc.getRealTimePropensity(0);

      // After more funnel traversals, the A→target edge dominates
      for (let i = 0; i < 9; i++) {
        graph.incrementTransition('A', 'target');
      }
      calc.updateBaseline(wrapGraph(graph), 'A', 'target', 1);
      const scoreAfterMoreSamples = calc.getRealTimePropensity(0);

      expect(scoreAfterMoreSamples).to.be.above(
        scoreAfterFewSamples,
        'propensity must increase as the A→target path becomes more probable',
      );
    });
  });

  it('Test AV: score is always in [0, 1] across varied z-scores and graph structures', () => {
    cy.window().then((win) => {
      const { PropensityCalculator, MarkovGraph } = (win as any).__PassiveIntentSDK;

      const zScores = [0, 0.5, 3.5, 10, 100];
      const funnels = [
        // Single hop
        [['A', 'target']],
        // Two hops
        [
          ['A', 'mid'],
          ['mid', 'target'],
        ],
        // No path
        [],
      ];

      for (const transitions of funnels) {
        for (const z of zScores) {
          const graph = new MarkovGraph({ smoothingAlpha: 0 });
          for (const [from, to] of transitions) {
            graph.incrementTransition(from, to);
          }

          const calc = new PropensityCalculator(0.2, 0);
          calc.updateBaseline(wrapGraph(graph), 'A', 'target', 3);
          const score = calc.getRealTimePropensity(z);

          expect(score).to.be.at.least(0, `score must be ≥ 0 (z=${z})`);
          expect(score).to.be.at.most(1, `score must be ≤ 1 (z=${z})`);
        }
      }
    });
  });
});
