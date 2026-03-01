/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';

const baselinePath = path.resolve('benchmarks/baseline.json');
const latestPath = path.resolve('benchmarks/latest.json');

if (!fs.existsSync(baselinePath)) {
  throw new Error('Missing benchmarks/baseline.json. Run: npm run test:perf:update-baseline');
}
if (!fs.existsSync(latestPath)) {
  throw new Error('Missing benchmarks/latest.json. Run: npm run test:perf:run first.');
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));

// Percentage threshold used as a hard-fail gate only for graph-size
// (a deterministic metric). For timing metrics, this threshold is
// warning-only (informational) and does not fail the run.
// Sub-millisecond timing metrics are NOT gated on this value — they vary
// 50–150 % across environments (Windows vs. Linux CI runner, scheduler
// jitter, runner load) even with identical code, making cross-machine
// percentage comparisons unreliable. For timings the hard ceiling below is
// the only hard-failure gate.
const maxRegressionPct = Number(process.env.PERF_MAX_REGRESSION_PCT ?? 25);
// Hard ceiling expressed as a multiplier of the baseline value.
// e.g. 3× means the metric can never exceed 3× its committed baseline,
// regardless of how the baseline drifts over time.  This remains the
// authoritative guard against genuine algorithmic regressions in timing.
const hardCeilingMultiplier = Number(process.env.PERF_HARD_CEILING_MULT ?? 3);
const maxGraphBytes = Number(process.env.PERF_MAX_GRAPH_BYTES ?? 20000);

const regressions = [];
const warnings = [];

function pctChange(base, current) {
  if (base == null || base === 0) return null; // can't compute — not a regression
  return ((current - base) / base) * 100;
}

// --- Timing metrics ---
// NOTE: The percentage-vs-baseline check is informational only for timing
// metrics.  Sub-ms timings vary 50–150% between a Windows dev machine and a
// Linux CI runner even with identical code (scheduler jitter, runner load,
// ASLR warm-up, etc.).  Only the hard ceiling (N× baseline) is a hard-fail
// gate for timing; that catches genuine algorithmic regressions regardless
// of the environment where the baseline was captured.
for (const key of ['avgTrackMs', 'p95TrackMs', 'p99TrackMs']) {
  const base = baseline[key];
  const current = latest[key];
  const delta = pctChange(base, current);

  if (delta !== null && delta > maxRegressionPct) {
    // Downgraded to warning — cross-environment noise, not a real gate.
    warnings.push(
      `${key} is ${delta.toFixed(1)}% slower than baseline` +
        ` (baseline=${base.toFixed(6)}ms, current=${current.toFixed(6)}ms)` +
        ` — informational; hard ceiling is the authoritative gate`,
    );
  }

  // Hard ceiling: reject if > N× baseline regardless of tolerance
  const ceiling = base * hardCeilingMultiplier;
  if (current > ceiling) {
    regressions.push(
      `${key} ${current.toFixed(6)}ms exceeds ${hardCeilingMultiplier}× baseline ceiling of ${ceiling.toFixed(6)}ms`,
    );
  }

  // Suspiciously fast — may indicate a measurement or warm-up issue
  if (delta !== null && delta < -50) {
    warnings.push(
      `${key} is ${Math.abs(delta).toFixed(1)}% faster than baseline — consider updating the baseline`,
    );
  }
}

// --- Graph size ---
if (latest.serializedGraphSizeBytes > maxGraphBytes) {
  regressions.push(
    `serializedGraphSizeBytes ${latest.serializedGraphSizeBytes} exceeds hard limit of ${maxGraphBytes}`,
  );
}
const graphDelta = pctChange(baseline.serializedGraphSizeBytes, latest.serializedGraphSizeBytes);
if (graphDelta !== null && graphDelta > maxRegressionPct) {
  regressions.push(
    `serializedGraphSizeBytes grew ${graphDelta.toFixed(1)}% vs baseline` +
      ` (baseline=${baseline.serializedGraphSizeBytes}, current=${latest.serializedGraphSizeBytes})`,
  );
}

// --- Memory ---
// Heap deltas are NOT checked as a regression gate. V8 GC scheduling, OS
// memory pressure, and warm-up allocations all vary significantly between
// environments (Windows dev machine vs. Linux CI runner), making a
// cross-machine baseline comparison meaningless and noisy. We log the
// value for observability only.
const memDelta = pctChange(baseline.memoryUsageEstimate, latest.memoryUsageEstimate);
if (memDelta !== null) {
  const direction = memDelta > 0 ? `+${memDelta.toFixed(1)}%` : `${memDelta.toFixed(1)}%`;
  console.log(
    `[perf-regression] info: memoryUsageEstimate ${direction} vs baseline` +
      ` (baseline=${baseline.memoryUsageEstimate}, current=${latest.memoryUsageEstimate}) — informational only`,
  );
}

if (warnings.length > 0) {
  for (const w of warnings) console.warn(`[perf-regression] warning: ${w}`);
}

if (regressions.length > 0) {
  console.error('Performance regression check FAILED:');
  for (const r of regressions) console.error(`  ✗ ${r}`);
  process.exit(1);
}

console.log('Performance regression check passed.');
