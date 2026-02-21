/**
 * ROC / AUC Experiment
 * --------------------
 * Sweeps noise deltas (0.05 … 0.3) × divergence thresholds (1.0 … 6.0)
 * to produce a full ROC curve and AUC for each noise level.
 *
 * Outputs:
 *   1. Per-noise-level TPR/FPR table
 *   2. ROC curve (ASCII)
 *   3. AUC per noise level
 *   4. Diagnostic verdict
 */

import fs from 'node:fs';
import path from 'node:path';
import { IntentManager, MarkovGraph } from '../dist/src/intent-sdk.js';

// ── polyfills ──────────────────────────────────────────────
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, value); }
}
if (!globalThis.localStorage) globalThis.localStorage = new MemoryStorage();
if (!globalThis.window) globalThis.window = { setTimeout, clearTimeout };
if (!globalThis.btoa) globalThis.btoa = (v) => Buffer.from(v, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (v) => Buffer.from(v, 'base64').toString('binary');

// ── deterministic PRNG ────────────────────────────────────
class SeededRng {
  constructor(seed) { this.state = seed >>> 0; }
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(max) { return Math.floor(this.next() * max); }
}

// ── helpers ───────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function createStatePool(size) {
  return Array.from({ length: size }, (_, i) => `S${i}`);
}

function pickNextState(states, cur, entropy, rng) {
  if (rng.next() < clamp(entropy, 0, 1)) return rng.int(states.length);
  return (cur + 1) % states.length;
}

function buildBaselineGraph(statePool) {
  const g = new MarkovGraph();
  for (let i = 0; i < statePool.length; i++) {
    g.incrementTransition(statePool[i], statePool[(i + 1) % statePool.length]);
  }
  return g;
}

// ── calibration (must match runtime constants) ─────────────
const SMOOTHING_EPSILON = 0.01;
const MAX_WINDOW       = 32;

function calibrateBaseline(baselineGraph, statePool, rng, sessions = 200) {
  const baselineEntropy = 0.2;
  const avgs = [];
  for (let s = 0; s < sessions; s++) {
    const seq = [];
    let cur = rng.int(statePool.length);
    for (let t = 0; t < MAX_WINDOW; t++) {
      cur = pickNextState(statePool, cur, baselineEntropy, rng);
      seq.push(statePool[cur]);
    }
    const ll = MarkovGraph.logLikelihoodTrajectory(baselineGraph, seq, SMOOTHING_EPSILON);
    avgs.push(ll / Math.max(1, seq.length - 1));
  }
  const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
  const variance = avgs.reduce((a, v) => { const d = v - mean; return a + d * d; }, 0) / avgs.length;
  return { mean, std: Math.max(Math.sqrt(variance), Number.EPSILON) };
}

// ── single experiment run ──────────────────────────────────
/**
 * Run sessions at a given noise delta and divergence threshold.
 * Returns { tp, fp, tn, fn }.
 */
function runExperiment({
  statePool, baselineGraph, calibrated,
  noiseDelta, divergenceThreshold,
  baselineEntropy, anomalyRate,
  sessions, transitionsPerSession,
  seed,
}) {
  const rng = new SeededRng(seed);
  let tp = 0, fp = 0, tn = 0, fn = 0;

  const managerConfig = {
    baseline: baselineGraph.toJSON(),
    persistDebounceMs: 60_000,
    benchmark: { enabled: false },
    // Synthetic benchmark: all track() calls happen in a tight synchronous
    // loop with sub-millisecond deltas, which would always trip EntropyGuard
    // and silently suppress every anomaly event.  Disable for experiments.
    botProtection: false,
    graph: {
      divergenceThreshold,
      baselineMeanLL: calibrated.mean,
      baselineStdLL:  calibrated.std,
      highEntropyThreshold: 0.75,
    },
  };

  for (let s = 0; s < sessions; s++) {
    const isAnomaly = rng.next() < anomalyRate;
    const sessionEntropy = isAnomaly
      ? clamp(baselineEntropy + noiseDelta, 0, 1)
      : baselineEntropy;

    const manager = new IntentManager(managerConfig);
    let triggered = false;

    const offDiv = manager.on('trajectory_anomaly', () => { triggered = true; });
    const offEnt = manager.on('high_entropy',       () => { triggered = true; });

    let cur = rng.int(statePool.length);
    for (let t = 0; t < transitionsPerSession; t++) {
      cur = pickNextState(statePool, cur, sessionEntropy, rng);
      manager.track(statePool[cur]);
    }
    offDiv();
    offEnt();

    if (triggered && isAnomaly)  tp++;
    else if (triggered && !isAnomaly) fp++;
    else if (!triggered && isAnomaly) fn++;
    else tn++;
  }
  return { tp, fp, tn, fn };
}

// ── ROC computation ────────────────────────────────────────
function computeROC(points) {
  // points = [{ fpr, tpr }] — add (0,0) and (1,1) sentinels
  const sorted = [...points].sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  // Ensure we have the endpoints
  if (sorted.length === 0 || sorted[0].fpr > 0 || sorted[0].tpr > 0) {
    sorted.unshift({ fpr: 0, tpr: 0 });
  }
  if (sorted[sorted.length - 1].fpr < 1 || sorted[sorted.length - 1].tpr < 1) {
    sorted.push({ fpr: 1, tpr: 1 });
  }
  return sorted;
}

function computeAUC(roc) {
  let auc = 0;
  for (let i = 1; i < roc.length; i++) {
    const dx = roc[i].fpr - roc[i - 1].fpr;
    const avgY = (roc[i].tpr + roc[i - 1].tpr) / 2;
    auc += dx * avgY;
  }
  return auc;
}

// ── ASCII ROC plot ─────────────────────────────────────────
function plotROC(curves, width = 60, height = 24) {
  // curves: { label, roc: [{fpr,tpr}] }[]
  const grid = Array.from({ length: height + 1 }, () => Array(width + 1).fill(' '));

  // Draw axes
  for (let y = 0; y <= height; y++) grid[y][0] = '│';
  for (let x = 0; x <= width; x++) grid[height][x] = '─';
  grid[height][0] = '└';

  // Diagonal (random classifier)
  for (let i = 0; i <= Math.min(width, height); i++) {
    const x = Math.round((i / Math.max(width, height)) * width);
    const y = height - Math.round((i / Math.max(width, height)) * height);
    if (grid[y][x] === ' ') grid[y][x] = '·';
  }

  const symbols = ['●', '■', '▲', '◆', '★'];
  const legend = [];

  curves.forEach(({ label, roc }, idx) => {
    const sym = symbols[idx % symbols.length];
    legend.push(`  ${sym}  ${label}`);
    for (const pt of roc) {
      const x = Math.round(pt.fpr * width);
      const y = height - Math.round(pt.tpr * height);
      if (x >= 0 && x <= width && y >= 0 && y <= height) {
        grid[y][x] = sym;
      }
    }
  });

  const lines = [];
  lines.push('  TPR');
  lines.push(' 1.0 ' + grid[0].join(''));
  for (let y = 1; y < height; y++) {
    const label = y === Math.round(height / 2) ? ' 0.5 ' : '     ';
    lines.push(label + grid[y].join(''));
  }
  lines.push(' 0.0 ' + grid[height].join(''));
  lines.push('     0.0' + ' '.repeat(Math.round(width / 2) - 4) + '0.5' + ' '.repeat(width - Math.round(width / 2) - 3) + '1.0');
  lines.push('     ' + ' '.repeat(Math.round(width / 2) - 2) + 'FPR');
  lines.push('');
  lines.push('  Legend:');
  legend.forEach(l => lines.push(l));

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════
//  MAIN EXPERIMENT
// ══════════════════════════════════════════════════════════

const STATE_SPACE       = 50;
const BASELINE_ENTROPY  = 0.2;
const SESSIONS          = 200;      // per (noiseDelta, threshold) pair
const TRANSITIONS       = 64;
const ANOMALY_RATE      = 0.5;      // 50/50 split for proper ROC
const MASTER_SEED       = 77777;

const NOISE_DELTAS      = [0.05, 0.10, 0.15, 0.20, 0.30];
const THRESHOLDS        = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];

const statePool     = createStatePool(STATE_SPACE);
const baselineGraph = buildBaselineGraph(statePool);
const calRng        = new SeededRng(MASTER_SEED ^ 0xa5a5a5a5);
const calibrated    = calibrateBaseline(baselineGraph, statePool, calRng);

console.log('═══════════════════════════════════════════════════════════');
console.log('  ROC / AUC Experiment — Privacy-First Intent Engine');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  State space:   ${STATE_SPACE}`);
console.log(`  Baseline ε:    ${BASELINE_ENTROPY}`);
console.log(`  Sessions/pt:   ${SESSIONS}`);
console.log(`  Transitions:   ${TRANSITIONS}`);
console.log(`  Anomaly rate:  ${(ANOMALY_RATE * 100).toFixed(0)}%`);
console.log(`  Calibration:   μ=${calibrated.mean.toFixed(4)}, σ=${calibrated.std.toFixed(4)}`);
console.log(`  Noise deltas:  ${NOISE_DELTAS.join(', ')}`);
console.log(`  Thresholds:    ${THRESHOLDS.join(', ')}`);
console.log('═══════════════════════════════════════════════════════════\n');

const allResults = {};
const rocCurves  = [];

for (const delta of NOISE_DELTAS) {
  const anomalyEntropy = clamp(BASELINE_ENTROPY + delta, 0, 1);
  const points = [];

  console.log(`──── Noise Δ = ${delta.toFixed(2)}  (anomaly entropy = ${anomalyEntropy.toFixed(2)}) ────`);
  console.log('  Threshold │   TPR   │   FPR   │  Prec   │   F1');
  console.log('  ──────────┼─────────┼─────────┼─────────┼────────');

  for (const thr of THRESHOLDS) {
    const { tp, fp, tn, fn } = runExperiment({
      statePool, baselineGraph, calibrated,
      noiseDelta: delta,
      divergenceThreshold: thr,
      baselineEntropy: BASELINE_ENTROPY,
      anomalyRate: ANOMALY_RATE,
      sessions: SESSIONS,
      transitionsPerSession: TRANSITIONS,
      seed: MASTER_SEED + Math.round(delta * 1000) + Math.round(thr * 100),
    });

    const tpr = tp + fn > 0 ? tp / (tp + fn) : 0;
    const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const f1   = prec + tpr > 0 ? (2 * prec * tpr) / (prec + tpr) : 0;

    points.push({ threshold: thr, tpr, fpr, prec, f1, tp, fp, tn, fn });

    console.log(
      `    ${thr.toFixed(1).padStart(5)}   │ ${tpr.toFixed(4)} │ ${fpr.toFixed(4)} │ ${prec.toFixed(4)} │ ${f1.toFixed(4)}`
    );
  }

  const roc = computeROC(points.map(p => ({ fpr: p.fpr, tpr: p.tpr })));
  const auc = computeAUC(roc);

  console.log(`  AUC = ${auc.toFixed(4)}\n`);

  allResults[`delta_${delta}`] = { points, roc, auc, anomalyEntropy };
  rocCurves.push({ label: `Δ=${delta.toFixed(2)} (AUC=${auc.toFixed(3)})`, roc });
}

// ── ROC plot ───────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  ROC Curves (· = random classifier)');
console.log('═══════════════════════════════════════════════════════════\n');
console.log(plotROC(rocCurves));

// ── summary table ──────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Noise Δ │ Anomaly ε │  AUC   │ Verdict');
console.log('  ────────┼───────────┼────────┼───────────────────────');

for (const delta of NOISE_DELTAS) {
  const r = allResults[`delta_${delta}`];
  let verdict;
  if (r.auc >= 0.95) verdict = '✓ Excellent';
  else if (r.auc >= 0.90) verdict = '~ Good';
  else if (r.auc >= 0.80) verdict = '△ Acceptable';
  else verdict = '✗ Needs improvement';

  console.log(
    `   ${delta.toFixed(2)}   │   ${r.anomalyEntropy.toFixed(2)}    │ ${r.auc.toFixed(4)} │ ${verdict}`
  );
}

// ── overall assessment ─────────────────────────────────────
const aucs = NOISE_DELTAS.map(d => allResults[`delta_${d}`].auc);
const minAUC = Math.min(...aucs);
const maxAUC = Math.max(...aucs);

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Diagnostic Assessment');
console.log('═══════════════════════════════════════════════════════════');

// Check for cliff vs smooth degradation
const aucDiffs = [];
for (let i = 1; i < aucs.length; i++) {
  aucDiffs.push(aucs[i] - aucs[i - 1]);
}
const maxJump = Math.max(...aucDiffs.map(Math.abs));

if (maxJump > 0.3 && aucs[0] < 0.6 && aucs[aucs.length - 1] > 0.9) {
  console.log('  Pattern: CLIFF — perfect separation until sudden jump.');
  console.log('  → Simulator may be unrealistic. Consider:');
  console.log('    - Adding overlap between baseline/noisy distributions');
  console.log('    - Adding subtle behavior drift');
} else if (aucs[0] < aucs[aucs.length - 1] - 0.01) {
  console.log('  Pattern: SMOOTH DEGRADATION — AUC rises with noise delta.');
  console.log('  → Engine is working as expected.');
} else {
  console.log('  Pattern: FLAT/HIGH — engine discriminates well at all noise levels.');
}

console.log('');
if (minAUC >= 0.95) {
  console.log('  Overall: All AUC ≥ 0.95. Engine is performing well.');
  console.log('  → No immediate model changes needed.');
} else if (minAUC >= 0.80) {
  console.log(`  Overall: Min AUC = ${minAUC.toFixed(4)}. Acceptable but room for improvement.`);
  console.log('  → Consider: sliding-window recalibration, confirmation counter.');
} else {
  console.log(`  Overall: Min AUC = ${minAUC.toFixed(4)} < 0.80. Model needs improvement.`);
  console.log('  → Recommended actions:');
  console.log('    1. Sliding window variance recalibration');
  console.log('    2. Confirmation counter (require N consecutive anomalies)');
  console.log('    3. Alternative confidence metrics (e.g., CUSUM, EWMA)');
}

console.log('═══════════════════════════════════════════════════════════\n');

// ── save results ───────────────────────────────────────────
const benchmarkDir = path.resolve('benchmarks');
fs.mkdirSync(benchmarkDir, { recursive: true });
const outputPath = path.join(benchmarkDir, 'roc-experiment.json');
const output = {
  config: {
    stateSpace: STATE_SPACE,
    baselineEntropy: BASELINE_ENTROPY,
    sessions: SESSIONS,
    transitions: TRANSITIONS,
    anomalyRate: ANOMALY_RATE,
    calibration: calibrated,
  },
  results: Object.fromEntries(
    NOISE_DELTAS.map(d => [
      `delta_${d}`,
      { ...allResults[`delta_${d}`], roc: undefined, points: allResults[`delta_${d}`].points },
    ])
  ),
  aucs: Object.fromEntries(NOISE_DELTAS.map(d => [d, allResults[`delta_${d}`].auc])),
};
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(`Results saved to ${outputPath}`);
