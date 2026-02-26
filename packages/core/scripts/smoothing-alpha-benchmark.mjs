/**
 * smoothing-alpha-benchmark.mjs
 *
 * Node.js benchmark (node:test) that measures the impact of Bayesian
 * Laplace smoothing (smoothingAlpha) on cold-start trajectory variance
 * in the EdgeSignal Markov engine, and verifies that the smoothing layer
 * does NOT weaken bot detection.
 *
 * ──────────────────────────────────────────────────────────────────────
 * WHY  MIN_WINDOW_LENGTH  IS BYPASSED
 * ──────────────────────────────────────────────────────────────────────
 * IntentManager gates trajectory scoring at MIN_WINDOW_LENGTH = 16 steps
 * for statistical stability.  A cold-start session of 4 clicks never
 * reaches this gate.  However, the MATH used once the gate opens is
 * identical to what we compute here directly:
 *
 *   expected_avg = logLikelihoodTrajectory(baseline, trajectory) / N
 *   adjustedStd  = baselineStdLL * sqrt(MAX_WINDOW_LENGTH / N)
 *   zScore       = (expected_avg - baselineMeanLL) / adjustedStd
 *
 * Scoring 4 clicks this way is not "cheating" — it is a direct measure
 * of how extreme the probability estimates become during cold start,
 * which is the root cause of false-positive trajectory_anomaly events.
 *
 * ──────────────────────────────────────────────────────────────────────
 * HOW TO RUN
 * ──────────────────────────────────────────────────────────────────────
 *   # 1. Build the package first (required — the script imports from dist/)
 *   npm run build --workspace=packages/core
 *
 *   # 2. Run the benchmark suite
 *   node --test packages/core/scripts/smoothing-alpha-benchmark.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentManager, MarkovGraph } from '../dist/src/intent-sdk.js';
import { MemoryStorage, setupTestEnvironment } from '../tests/helpers/test-env.mjs';

setupTestEnvironment();

// ─── Engine constants (mirrored from packages/core/src/engine/constants.ts) ──
/** Fallback probability applied to p=0 transitions inside logLikelihoodTrajectory. */
const SMOOTHING_EPSILON = 0.01;
/**
 * Maximum sliding-window length.  The variance-scaling formula divides by N and
 * multiplies by this constant to keep adjustedStd consistent across window sizes.
 */
const MAX_WINDOW_LENGTH = 32;

// ─── Deterministic mock timer ──────────────────────────────────────────────────
/**
 * Provides reproducible timestamps for bot-detection tests.
 * Call advance(ms) before each track() to control the apparent inter-click gap.
 */
class MockTimer {
  #now;
  constructor(initial = 100_000) {
    this.#now = initial;
  }
  now() {
    return this.#now;
  }
  advance(deltaMs) {
    this.#now += deltaMs;
  }
  // The persist debounce timer is disabled (persistDebounceMs=999_999) in all
  // benchmark engines, so these no-ops are safe.
  setTimeout(_fn, _delay) {
    return 0;
  }
  clearTimeout(_id) {}
}

// ─── Sparse "cold-start" baseline factory ─────────────────────────────────────
/**
 * Builds a sparse SerializedMarkovGraph representing a production baseline
 * trained on ONLY two sessions — simulating cold-start conditions.
 *
 * Navigation graph (state vocabulary = 5 states):
 *   /home  /products  /pricing  /account  /checkout
 *
 * Raw transition counts:
 *   /home     → /products   : 2   (seen in both sessions)
 *   /products → /pricing    : 1
 *   /pricing  → /account    : 1
 *   /products → /checkout   : 1
 *   /checkout → /account    : 1
 *
 * Crucially: /pricing → /checkout has count=0 but /checkout IS a known state.
 * This is the "seen-but-never-transitioned" edge that exposes the cold-start
 * brittleness of frequentist math:
 *
 *   Frequentist: P = 0 → ε fallback → log(0.01) ≈ −4.61 nats
 *   Bayesian:    P = α / (total + α·k) ≈ 0.067   → log ≈ −2.71 nats  (α=0.1, k=5)
 */
function buildSparseBaselineJSON() {
  // smoothingAlpha: 0 here — we only want raw counts in the serialized JSON.
  // Smoothing is applied at deserialization time (fromJSON) per engine.
  const g = new MarkovGraph({ smoothingAlpha: 0 });
  // Session 1: /home → /products → /pricing → /account
  g.incrementTransition('/home', '/products');
  g.incrementTransition('/products', '/pricing');
  g.incrementTransition('/pricing', '/account');
  // Session 2: /home → /products → /checkout → /account
  // Ensures /checkout exists as a live state → smoothing can assign a non-zero
  // probability to the unseen /pricing → /checkout edge.
  g.incrementTransition('/home', '/products');
  g.incrementTransition('/products', '/checkout');
  g.incrementTransition('/checkout', '/account');
  return g.toJSON();
}

// ─── Z-score helper (mirrors IntentManager.evaluateTrajectory math) ───────────
/**
 * Scores `trajectory` against `baseline` using the same formula as
 * evaluateTrajectory() — bypassing only the MIN_WINDOW_LENGTH warm-up gate.
 *
 * @param {MarkovGraph} baseline      - Restored baseline graph (carries smoothingAlpha).
 * @param {string[]}    trajectory    - Sequence of state labels.
 * @param {{ baselineMeanLL: number, baselineStdLL: number }} calibration
 * @returns {{ ll: number, llAvg: number, zScore: number }}
 */
function computeZScore(baseline, trajectory, calibration) {
  const N = Math.max(1, trajectory.length - 1);
  const ll = MarkovGraph.logLikelihoodTrajectory(baseline, trajectory, SMOOTHING_EPSILON);
  const llAvg = ll / N;
  // Dynamic variance scaling: std(average of N steps) ∝ 1/√N
  const adjustedStd = calibration.baselineStdLL * Math.sqrt(MAX_WINDOW_LENGTH / N);
  const zScore = (llAvg - calibration.baselineMeanLL) / adjustedStd;
  return { ll, llAvg, zScore };
}

// ─── Shared calibration ───────────────────────────────────────────────────────
/**
 * Represents the per-step log-likelihood statistics of a *longer*, well-trained
 * session where most transitions have high probability (e.g. a 20-click guided
 * checkout flow).  Typical per-step LL clusters around −0.3 nats.
 *
 * We deliberately use a "rich path" baseline so the 4-click cold-start sequence
 * (which includes an unseen edge) scores as anomalous in both engines — and we
 * can measure HOW anomalous each engine thinks it is.
 */
const CALIBRATION = {
  baselineMeanLL: -0.3,
  baselineStdLL: 0.25,
};

// ─── Sequences ────────────────────────────────────────────────────────────────

/**
 * Cold-start human sequence: exactly 4 normal navigation clicks.
 * The /pricing → /checkout edge is unobserved in the sparse baseline.
 */
const COLD_START_CLICKS = ['/home', '/products', '/pricing', '/checkout'];

/** Bot loop: two states alternated rapidly. */
const BOT_STATES = ['/bot-a', '/bot-b'];

// ════════════════════════════════════════════════════════════════════════════════
//  TEST 1 — Cold-start variance: Bayesian vs Frequentist after 4 clicks
// ════════════════════════════════════════════════════════════════════════════════
test('Cold-start variance: Bayesian zScore is significantly less extreme than Frequentist', () => {
  const baselineJSON = buildSparseBaselineJSON();

  // ── Restore the same baseline JSON under two smoothing regimes ───────────
  // The only difference between these two objects is smoothingAlpha:
  //   frequentist → getProbability returns count/total (or 0 → ε fallback)
  //   bayesian    → getProbability returns (count+α)/(total+α·k)
  const baselineFrequentist = MarkovGraph.fromJSON(baselineJSON, { smoothingAlpha: 0 });
  const baselineBayesian = MarkovGraph.fromJSON(baselineJSON, { smoothingAlpha: 0.1 });

  // ── Initialize two IntentManagers ────────────────────────────────────────
  // Both receive the same baseline JSON; each deserializes it under its own
  // smoothingAlpha (now wired via the top-level alias in the constructor).
  const sharedBase = {
    storageKey: 'bench-cold-start',
    persistDebounceMs: 999_999, // suppress I/O during benchmark
    baseline: baselineJSON,
    ...CALIBRATION,
    storage: new MemoryStorage(),
    timer: new MockTimer(100_000),
    botProtection: false, // isolate to trajectory logic for this test
  };

  const engineFrequentist = new IntentManager({ ...sharedBase, smoothingAlpha: 0 });
  const engineBayesian = new IntentManager({ ...sharedBase, smoothingAlpha: 0.1 });

  // ── Track EXACTLY 4 cold-start clicks in both engines ────────────────────
  for (const state of COLD_START_CLICKS) {
    engineFrequentist.track(state);
    engineBayesian.track(state);
  }

  // ── Score the 4-click sequence against each restored baseline ────────────
  // IntentManager.evaluateTrajectory gates at MIN_WINDOW_LENGTH=16 (statistical
  // warm-up guard), so we score directly here using the identical formula.
  const freqScore = computeZScore(baselineFrequentist, COLD_START_CLICKS, CALIBRATION);
  const bayScore = computeZScore(baselineBayesian, COLD_START_CLICKS, CALIBRATION);

  // ── Show the comparison ───────────────────────────────────────────────────
  //
  // Expected math for /pricing → /checkout (unseen edge, k=5 states):
  //
  //   Frequentist: P = 0 → ε=0.01 → log(0.01) ≈ −4.606 nats
  //   Bayesian:    P = 0.1/(1+0.5)=0.0667 → log(0.0667) ≈ −2.708 nats
  //
  // The 1.9-nat gap per unseen transition directly raises the per-step LL avg
  // and shrinks the z-score by ≈ 30–40 % at this window size.
  //
  console.log('\n── Cold-Start Trajectory Score after 4 Clicks ──────────────────────────');
  console.table({
    Frequentist: {
      smoothingAlpha: '0 (pure frequentist)',
      'Total LL': freqScore.ll.toFixed(4),
      'Per-step LL avg': freqScore.llAvg.toFixed(4),
      'Z-Score': freqScore.zScore.toFixed(4),
      'Anomaly at |z|>3.5?': Math.abs(freqScore.zScore) > 3.5 ? 'YES ⚠️ ' : 'no',
    },
    Bayesian: {
      smoothingAlpha: '0.1 (Laplace)',
      'Total LL': bayScore.ll.toFixed(4),
      'Per-step LL avg': bayScore.llAvg.toFixed(4),
      'Z-Score': bayScore.zScore.toFixed(4),
      'Anomaly at |z|>3.5?': Math.abs(bayScore.zScore) > 3.5 ? 'YES ⚠️ ' : 'no',
    },
  });

  const reductionPct =
    ((Math.abs(freqScore.zScore) - Math.abs(bayScore.zScore)) / Math.abs(freqScore.zScore)) * 100;
  console.log(
    `Result: Bayesian z-score is ${reductionPct.toFixed(1)}% less extreme than Frequentist ` +
      `(${Math.abs(freqScore.zScore).toFixed(3)} → ${Math.abs(bayScore.zScore).toFixed(3)} |z|).\n`,
  );

  // ── Assertions ────────────────────────────────────────────────────────────

  // Sanity: both scores must be finite numbers
  assert.ok(Number.isFinite(freqScore.ll), 'Frequentist LL must be a finite number');
  assert.ok(Number.isFinite(bayScore.ll), 'Bayesian LL must be a finite number');

  // Core claim: Bayesian per-step LL is strictly less negative (closer to 0).
  // The unseen /pricing→/checkout edge gets log(ε)=-4.6 Frequentist vs
  // log(0.067)=-2.7 Bayesian — a 1.9-nat improvement on that one transition alone.
  assert.ok(
    bayScore.llAvg > freqScore.llAvg,
    `Bayesian per-step LL avg (${bayScore.llAvg.toFixed(4)}) should be higher (less extreme) ` +
      `than Frequentist (${freqScore.llAvg.toFixed(4)}). ` +
      `Smoothing assigns a non-zero probability to the unseen /pricing→/checkout edge.`,
  );

  // Magnitude claim: Bayesian |z-score| is ≥ 15 % smaller than Frequentist.
  // Actual reduction is ~35–40 % for this graph geometry.
  assert.ok(
    Math.abs(bayScore.zScore) < Math.abs(freqScore.zScore) * 0.85,
    `Bayesian |z-score| (${Math.abs(bayScore.zScore).toFixed(4)}) must be < 85% of ` +
      `Frequentist (${Math.abs(freqScore.zScore).toFixed(4)}). ` +
      `Expected at least a 15% cold-start variance reduction.`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════
//  TEST 2 — Bot detection: smoothing must NOT weaken the security layer
// ════════════════════════════════════════════════════════════════════════════════
test('Bot detection: both engines flag a clear bot sequence regardless of smoothingAlpha', () => {
  const baselineJSON = buildSparseBaselineJSON();

  // Separate timers so each engine has its own clock
  const timerFreq = new MockTimer(50_000);
  const timerBay = new MockTimer(50_000);

  const botBase = {
    storageKey: 'bench-bot',
    persistDebounceMs: 999_999,
    baseline: baselineJSON,
    ...CALIBRATION,
    botProtection: true, // explicitly enabled — must fire for both engines
  };

  const botFrequentist = new IntentManager({
    ...botBase,
    smoothingAlpha: 0,
    storage: new MemoryStorage(),
    timer: timerFreq,
  });
  const botBayesian = new IntentManager({
    ...botBase,
    smoothingAlpha: 0.1,
    storage: new MemoryStorage(),
    timer: timerBay,
  });

  // Capture emitted events
  const freqBotEvents = [];
  const bayBotEvents = [];
  botFrequentist.on('bot_detected', (p) => freqBotEvents.push(p));
  botBayesian.on('bot_detected', (p) => bayBotEvents.push(p));

  // ── Simulate a "Clear Bot": 10 rapid clicks, 10 ms apart ──────────────
  //
  // EntropyGuard scoring mechanics (BOT_SCORE_THRESHOLD = 5):
  //   Speed criterion:    each delta < BOT_MIN_DELTA_MS (50 ms) → +1 pt
  //   Variance criterion: variance of all deltas < BOT_MAX_VARIANCE (100 ms²) → +1 pt
  //
  // With 10 ms constant spacing:
  //   9 consecutive deltas × 1 pt = 9 pts (speed)
  //   variance of {10,10,10,...} = 0 ms² < 100 → +1 pt (variance)
  //   Total score ≥ 5 after the 5th track() call → bot_detected fires.
  //
  // smoothingAlpha lives in the Markov / trajectory layer, NOT in EntropyGuard.
  // A correct implementation must not allow alpha to suppress bot detection.
  //
  console.log('\n── Bot Sequence: 10 rapid clicks @10 ms intervals ──────────────────────');
  for (let i = 0; i < 10; i++) {
    const state = BOT_STATES[i % 2];
    // Advance both clocks BEFORE the track() call so timer.now() inside
    // runBotProtectionStage sees the new timestamp on this iteration.
    timerFreq.advance(10);
    timerBay.advance(10);
    botFrequentist.track(state);
    botBayesian.track(state);
  }

  console.table({
    Frequentist: {
      smoothingAlpha: '0 (pure frequentist)',
      'bot_detected fired?':
        freqBotEvents.length > 0 ? `YES (${freqBotEvents.length}x) 🔒` : 'NO ❌',
      'First flagged state': freqBotEvents[0]?.state ?? '—',
    },
    Bayesian: {
      smoothingAlpha: '0.1 (Laplace)',
      'bot_detected fired?': bayBotEvents.length > 0 ? `YES (${bayBotEvents.length}x) 🔒` : 'NO ❌',
      'First flagged state': bayBotEvents[0]?.state ?? '—',
    },
  });
  console.log(
    'Result: smoothingAlpha=0.1 does NOT reduce bot detection sensitivity — ' +
      'EntropyGuard operates independently of the Markov probability layer.\n',
  );

  // ── Assertions ────────────────────────────────────────────────────────────

  // Both engines must fire bot_detected — smoothingAlpha must never weaken
  // the timing-based EntropyGuard security layer.
  assert.ok(
    freqBotEvents.length > 0,
    'Frequentist engine (α=0) must fire bot_detected for 10 rapid clicks @10 ms gaps.',
  );
  assert.ok(
    bayBotEvents.length > 0,
    'Bayesian engine (α=0.1) must fire bot_detected for 10 rapid clicks @10 ms gaps. ' +
      'smoothingAlpha must not degrade EntropyGuard bot detection.',
  );

  // Both engines must flag one of the known bot loop states (not a phantom state)
  assert.ok(
    BOT_STATES.includes(freqBotEvents[0].state),
    `Frequentist: flagged state "${freqBotEvents[0].state}" should be a bot loop state.`,
  );
  assert.ok(
    BOT_STATES.includes(bayBotEvents[0].state),
    `Bayesian: flagged state "${bayBotEvents[0].state}" should be a bot loop state.`,
  );

  // The number of bot_detected events must match between both engines —
  // smoothing changes the probability layer only, not the detection cadence.
  assert.strictEqual(
    bayBotEvents.length,
    freqBotEvents.length,
    `Both engines must produce the same number of bot_detected events ` +
      `(freq=${freqBotEvents.length}, bay=${bayBotEvents.length}). ` +
      `EntropyGuard is smoothingAlpha-invariant.`,
  );
});
