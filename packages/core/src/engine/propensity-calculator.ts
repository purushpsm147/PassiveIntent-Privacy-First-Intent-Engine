/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { IStateModel } from '../types/microkernel.js';

// ---------------------------------------------------------------------------
// Internal BFS types
// ---------------------------------------------------------------------------

/**
 * A single node on the BFS frontier during the hitting-probability walk.
 *
 * Declared inline (not a class) so V8 can allocate it cheaply as a plain
 * object literal.  The BFS queue is short-lived and GC'd after `updateBaseline`
 * returns, so allocation cost is irrelevant on the hot path.
 */
interface BFSNode {
  /** Normalised route label at this position in the walk. */
  readonly state: string;
  /**
   * Product of all edge probabilities from the source state to this node.
   *
   * At the source node this is 1.0 (multiplicative identity).  Each hop
   * multiplies by the Markov transition probability P(nextState | state),
   * producing the joint probability of the entire path up to this point.
   */
  readonly pathProb: number;
  /** Number of hops taken from the source state to this node. */
  readonly depth: number;
  /**
   * States already visited on this specific path from the source to this node.
   * Tracked per-path (not globally) so that converging simple paths are not
   * incorrectly pruned: two different paths may visit the same intermediate
   * state independently without forming a cycle.
   */
  readonly pathVisited: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// PropensityCalculator
// ---------------------------------------------------------------------------

/**
 * Real-Time Propensity Calculator
 *
 * Produces a single normalised score in [0, 1] answering the question:
 * "How likely is the current user session to reach `targetState` given
 * the observed behavioural friction so far?"
 *
 * The score is the product of two independent, orthogonal factors:
 *
 * ─────────────────────────────────────────────────────────────────────
 * Factor 1 — Markov hitting probability  (structural, graph-derived)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   P_reach = Σ  ∏ P(s_{i+1} | s_i)
 *             ∀ simple paths  currentState → … → targetState
 *             of length 1 … maxDepth
 *
 * Computed once by a depth-bounded BFS over the live Markov graph and
 * cached in `cachedBaseline`.  Separating this from the Z-score means the
 * hot path (`getRealTimePropensity`) never re-traverses the graph.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Factor 2 — Welford Z-score friction penalty  (behavioural, real-time)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   frictionPenalty = exp(−α × max(0, z))
 *
 * Derived from the trajectory Z-score emitted by `SignalEngine.evaluateTrajectory`
 * (itself computed via Welford online variance over the log-likelihood series).
 * A high positive z means the current path deviates significantly from the
 * calibrated baseline — the user is confused or frustrated — which reduces
 * the probability of a clean conversion.
 *
 * `max(0, z)` clamps negative Z-scores to zero: a trajectory that is *more*
 * likely than baseline (smooth, decisive navigation) must not inflate the
 * propensity above the raw structural probability.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Combined score
 * ─────────────────────────────────────────────────────────────────────
 *
 *   propensity = P_reach × exp(−α × max(0, z))
 *
 * At the default α = 0.2:
 *   z = 0    →  penalty = 1.000  (no friction — full structural propensity)
 *   z = 3.5  →  penalty ≈ 0.497  (divergence threshold — score halved)
 *   z = 6.9  →  penalty ≈ 0.250  (severe anomaly — score quartered)
 *
 * ─────────────────────────────────────────────────────────────────────
 * Performance contract
 * ─────────────────────────────────────────────────────────────────────
 *
 *   `getRealTimePropensity()` — throttled to ≤ 1 full computation per
 *     THROTTLE_MS (default 500 ms).  Throttled calls: zero allocations,
 *     one `performance.now()` read, one float comparison, one return.
 *     Full computation: one `performance.now()`, one `Math.exp()`, one
 *     multiply.  Runs comfortably under 1 µs on V8.
 *
 *   `updateBaseline()` — O(D × F) BFS where D = maxDepth and F = average
 *     graph fan-out.  At D = 3, F ≤ 8 this is ≤ 512 frontier nodes.
 *     Must NOT be called on every `track()` — only when the
 *     (currentState, targetState) pair changes.
 *
 * Zero external dependencies.  No network I/O.  No PII.
 */
export class PropensityCalculator {
  /**
   * Exponential decay sensitivity constant α.
   *
   * Controls how sharply anomalous Z-scores suppress the propensity score.
   *
   *   frictionPenalty = exp(−α × z)
   *
   * Default 0.2 is calibrated against the library's default `divergenceThreshold`
   * of 3.5: at that threshold the score is halved, providing a meaningful
   * real-time signal without over-penalising brief navigation anomalies.
   *
   * Increase α (e.g., 0.4) for higher sensitivity in short funnel flows.
   * Decrease α (e.g., 0.1) for longer, noisier browsing sessions.
   */
  private readonly alpha: number;

  /**
   * Cached Markov hitting probability from the most recent `updateBaseline()` call.
   *
   * Stores the sum of joint path probabilities over all simple paths of
   * length 1 … maxDepth that connect `currentState` to `targetState` in the
   * live Markov graph.  Clamped to [0, 1] by `updateBaseline`.
   *
   * A value of 0 signals one of:
   *   (a) `updateBaseline()` has never been called in this session.
   *   (b) `targetState` is structurally unreachable from `currentState`
   *       within `maxDepth` hops given the observed transition history.
   */
  private cachedBaseline: number;

  /**
   * `performance.now()` timestamp of the last accepted propensity computation.
   *
   * Compared against the current timestamp on each `getRealTimePropensity()`
   * call to enforce the THROTTLE_MS gate.
   *
   * Initialized to `-Infinity` so the very first call always satisfies
   * `now - lastCalculationTime ≥ THROTTLE_MS` regardless of what
   * `performance.now()` returns — including 0 in controlled test environments.
   * Using `0` would throttle the first call whenever the clock also starts at 0.
   */
  private lastCalculationTime: number;

  /**
   * The propensity score produced by the most recent full (non-throttled) computation.
   *
   * Returned as-is on all subsequent calls within the THROTTLE_MS window,
   * avoiding redundant `Math.exp()` evaluations when the caller polls faster
   * than the throttle interval.
   */
  private lastPropensity: number;

  /**
   * Minimum elapsed time in milliseconds between full propensity re-computations.
   *
   * 500 ms was chosen to:
   *   • Align with the dwell-time sampling cadence so the score only updates
   *     when new dwell-time evidence has likely been collected.
   *   • Prevent score oscillation in React consumers: a 500 ms stable window
   *     maps to a single React render cycle at typical re-render rates.
   *   • Stay well above the p99 `track()` latency (1.6 µs in benchmarks), so
   *     throttling never masks a meaningful computation.
   */
  private readonly THROTTLE_MS: number;

  constructor(alpha: number = 0.2, throttleMs: number = 500) {
    // Negative alpha inverts the friction relationship (higher z → higher score),
    // and non-finite alpha (NaN or ±Infinity) causes Math.exp to produce NaN at
    // z=0 via Infinity×0.  Clamp to [0, ∞) finite; 0 means no friction applied.
    this.alpha = Number.isFinite(alpha) && alpha >= 0 ? alpha : 0;
    this.cachedBaseline = 0;
    this.lastCalculationTime = -Infinity;
    this.lastPropensity = 0;
    // NaN throttleMs disables throttling silently (n < NaN is always false).
    // Infinity throttleMs freezes the score after the first computation forever.
    // Both are hazards; fall back to the documented 500 ms default.
    this.THROTTLE_MS = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : 500;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Recompute and cache the structural hitting probability via a depth-bounded BFS.
   *
   * ### Why BFS over DFS?
   * BFS explores the graph level-by-level (by hop count), making it natural to
   * accumulate probability mass per depth and terminate cleanly at `maxDepth`.
   * With iterative DFS an explicit depth counter is needed alongside the stack;
   * BFS's queue subsumes both responsibilities and reads more clearly for a
   * probabilistic forward walk.
   *
   * ### Cycle prevention
   * Each queued node carries its own `pathVisited` set — the states already on
   * that specific path from `currentState` to this node.  Before enqueuing a
   * neighbor we check `pathVisited` and skip it if it appears, preventing the
   * BFS from following cycles (A→B→A→…) along any single route.  Unlike a
   * global visited set, this approach allows two *different* paths to pass
   * through the same intermediate state independently, which is required to
   * correctly sum all simple-path contributions to the hitting probability.
   *
   * ### Probability accumulation
   * Each BFS node carries `pathProb` — the running product of edge probabilities
   * from the source.  When a neighbour is `targetState`, we add
   * `pathProb × P(target | state)` to `accumulated` and do NOT enqueue
   * `targetState` for further expansion — once the target is reached, the path
   * has terminated.  This correctly handles multiple paths of different lengths
   * that all converge on the target.
   *
   * @param graph        The live `IStateModel`.  Only `getLikelyNext` is used,
   *                     so any conforming implementation (real graph, test stub)
   *                     works without change.
   * @param currentState The user's current observed state (normalised route string).
   * @param targetState  The goal state whose reachability we are estimating
   *                     (e.g., `/checkout/confirm`, `/onboarding/complete`).
   * @param maxDepth     Maximum BFS hops.  Default 3.  At fan-out 8 the frontier
   *                     is ≤ 8^3 = 512 nodes — safe for a synchronous call.
   *                     Values above 5 are not recommended: at fan-out 8, depth 5
   *                     yields 32 768 nodes and adds measurable latency.
   */
  public updateBaseline(
    graph: IStateModel,
    currentState: string,
    targetState: string,
    maxDepth: number = 3,
  ): void {
    // ── Input sanitization ────────────────────────────────────────────────────
    // NaN maxDepth: `depth + 1 < NaN` is always false, so non-target neighbors
    // are never enqueued — only direct target edges are found, silently ignoring
    // the requested depth.  Infinity maxDepth removes the depth gate entirely,
    // risking unbounded BFS in dense graphs.  Fall back to the documented default.
    const safeMaxDepth = Number.isFinite(maxDepth) && maxDepth >= 1 ? Math.floor(maxDepth) : 3;

    // ── Trivial case: the user is already at the target ───────────────────────
    // Markov hitting probability from a state to itself is 1 by definition —
    // the chain has already hit the absorbing target state.
    if (currentState === targetState) {
      this.cachedBaseline = 1;
      return;
    }

    // ── BFS initialisation ────────────────────────────────────────────────────
    // The queue holds frontier nodes in FIFO order.
    // `pathVisited` is tracked per-path so that converging simple paths are not
    // incorrectly pruned: two routes may share an intermediate state without
    // forming a cycle.  A global visited set would drop valid second arrivals.
    const queue: BFSNode[] = [
      { state: currentState, pathProb: 1, depth: 0, pathVisited: new Set([currentState]) },
    ];

    // Running sum of joint path probabilities that terminate at `targetState`.
    let accumulated = 0;

    while (queue.length > 0) {
      // `shift()` is O(n) but the queue is bounded by the number of distinct
      // simple paths: at fan-out F and depth D that is at most F×(F-1)^(D-1).
      // At D=3, F=8 this is ~400 entries — a ring-buffer would save nothing.
      const node = queue.shift()!;

      // ── Expand: enumerate all outgoing transitions from this state ──────────
      // Threshold 0 returns every observed edge regardless of probability.
      // We intentionally do not filter: even a 1% edge can compound into a
      // meaningful multi-hop path, and silently dropping low-probability edges
      // would understate reachability.
      const neighbours = graph.getLikelyNext(node.state, 0);

      for (const { state: nextState, probability: edgeProb } of neighbours) {
        // Skip states already on this path to prevent cycles.
        if (node.pathVisited.has(nextState)) {
          continue;
        }

        // Joint probability of the path ending at `nextState`:
        //   pathProb(node → nextState) = pathProb(source → node) × P(nextState | node)
        const reachProb = node.pathProb * edgeProb;

        if (nextState === targetState) {
          // ── Target reached — accumulate and continue ────────────────────────
          // Do NOT enqueue `targetState`: we only need to count arrivals,
          // not expand from the goal.  Multiple paths of different lengths
          // can hit the target, so we accumulate rather than early-return.
          accumulated += reachProb;
        } else if (node.depth + 1 < safeMaxDepth) {
          // ── Not yet at target and depth budget remains — keep walking ────────
          // Push a shallow copy of pathVisited with nextState added so each
          // queued node carries its own independent path history.
          const nextPathVisited = new Set(node.pathVisited);
          nextPathVisited.add(nextState);
          queue.push({
            state: nextState,
            pathProb: reachProb,
            depth: node.depth + 1,
            pathVisited: nextPathVisited,
          });
        }
        // States beyond maxDepth are silently discarded —
        // they cannot improve the estimate without risking cycle inflation.
      }
    }

    // Clamp to [0, 1]: by the Markov chain probability axioms, the hitting
    // probability is in [0, 1].  Floating-point products across many parallel
    // paths can accumulate rounding error beyond 1.0 in degenerate graphs;
    // the clamp is a correctness safety net, not the normal code path.
    this.cachedBaseline = Math.min(1, accumulated);
  }

  /**
   * Return the real-time propensity score, throttled to at most one full
   * computation per `THROTTLE_MS` milliseconds.
   *
   * ### Formula
   *
   *   frictionPenalty = exp(−α × max(0, currentZScore))
   *   propensity      = cachedBaseline × frictionPenalty
   *
   * ### Why exponential decay for the friction penalty?
   *
   *   • It maps every non-negative Z-score to a unique value in (0, 1],
   *     preserving the [0, 1] domain without a separate clamp.
   *   • It is monotonically decreasing — higher friction always reduces propensity.
   *   • It is C∞ differentiable — smooth score transitions eliminate visual
   *     jitter in React consumers that read the score via `usePassiveIntent`.
   *   • It requires a single `Math.exp()` call — < 100 ns on V8.
   *   • The `max(0, z)` clamp ensures negative Z-scores (the user navigates
   *     *better* than baseline) produce no friction, keeping the score at
   *     `cachedBaseline` rather than inflating it above the Markov probability.
   *
   * ### Throttle mechanics
   *
   * `performance.now()` provides sub-millisecond resolution without OS-level
   * privileges (resolution: ~0.1 ms in secure browser contexts, ~1 µs in Node.js).
   * It is monotonically increasing within a browsing context, immune to wall-clock
   * adjustments that would cause `Date.now()` to produce negative deltas.
   *
   * @param currentZScore Trajectory Z-score from `SignalEngine.evaluateTrajectory`.
   *                      Pass 0 on cold start or when no baseline is configured.
   *                      Values < 0 are treated as 0 (no friction for healthy paths).
   * @returns Propensity score in [0, 1].  0 when no baseline is available.
   */
  public getRealTimePropensity(currentZScore: number): number {
    // ── Throttle gate ──────────────────────────────────────────────────────────
    // performance.now() returns a DOMHighResTimeStamp in milliseconds.
    // Comparing against THROTTLE_MS determines whether we are within the
    // stable window established by the previous full computation.
    const now = performance.now();

    if (now - this.lastCalculationTime < this.THROTTLE_MS) {
      // Within the throttle window: return the last score with zero work.
      // This is the overwhelmingly common case during rapid `track()` bursts.
      return this.lastPropensity;
    }

    // ── No-baseline early exit ─────────────────────────────────────────────────
    // cachedBaseline === 0 means the target state is unreachable from the
    // current position within maxDepth hops (or updateBaseline has not been
    // called yet).  Multiplying zero by any penalty factor yields zero;
    // we skip Math.exp() and return early.
    //
    // We still advance lastCalculationTime so repeated calls on an unreachable
    // target are throttled and do not cause a performance.now() call storm.
    if (this.cachedBaseline <= 0) {
      this.lastCalculationTime = now;
      this.lastPropensity = 0;
      return 0;
    }

    // ── Welford Z-score exponential friction penalty ───────────────────────────
    //
    // The Z-score is produced by SignalEngine.evaluateTrajectory using Welford's
    // online algorithm for running mean and variance of the log-likelihood series:
    //
    //   z = (LL_observed − μ_baseline) / (σ_baseline × √(W_max / N))
    //
    // where LL_observed is the log-likelihood of the current trajectory under the
    // live graph, μ_baseline and σ_baseline are the Welford-derived mean and
    // standard deviation of the baseline log-likelihood distribution, W_max is the
    // maximum trajectory window length, and N is the current window length.
    //
    // We map this Z-score to a friction multiplier via exponential decay:
    //
    //   frictionPenalty = exp(−α × max(0, z))
    //
    // The `max(0, z)` clamp zeroes out any benefit from below-baseline deviation
    // (the user is navigating more efficiently than average — we do not reward
    // this, we simply report no friction).
    // Non-finite z-scores (NaN, ±Infinity) propagate through Math.exp to NaN or
    // produce degenerate results, corrupting lastPropensity.
    // Treat them as 0 (no friction): the caller provided no usable signal.
    const safeZ = Number.isFinite(currentZScore) ? currentZScore : 0;
    const frictionPenalty = Math.exp(-this.alpha * Math.max(0, safeZ));

    // ── Combined propensity ────────────────────────────────────────────────────
    //
    //   propensity = P_reach(current → target, maxDepth) × exp(−α × max(0, z))
    //
    // This is the Hadamard product of the structural graph estimate and the
    // real-time behavioural signal.  Both factors are in [0, 1], so the result
    // is guaranteed to remain in [0, 1] without a final clamp.
    const propensity = this.cachedBaseline * frictionPenalty;

    // ── Persist for throttle window ────────────────────────────────────────────
    this.lastPropensity = propensity;
    this.lastCalculationTime = now;

    return propensity;
  }
}
