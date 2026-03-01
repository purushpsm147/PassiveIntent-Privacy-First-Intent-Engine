/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { IntentManager } from '../dist/src/intent-sdk.js';
import { printPerfSummary } from '../dist/src/reporting-utils.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, value);
  }
}

if (!globalThis.localStorage) globalThis.localStorage = new MemoryStorage();
if (!globalThis.window) globalThis.window = { setTimeout, clearTimeout };
if (!globalThis.btoa) globalThis.btoa = (v) => Buffer.from(v, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (v) => Buffer.from(v, 'base64').toString('binary');

const TRACK_CALLS = Number(process.env.PERF_TRACK_CALLS ?? 100000);
const WARMUP_CALLS = Number(process.env.PERF_WARMUP_CALLS ?? 5000);
const STATE_COUNT = 50;

function scenarioState(i) {
  return `S${i % STATE_COUNT}`;
}

// --- JIT warm-up -------------------------------------------------------
// Run a throwaway manager first so V8 has compiled the hot paths before
// we start collecting timed samples. Without this, early iterations run
// in the interpreter and inflate p99 significantly.
const warmupManager = new IntentManager({
  storageKey: 'perf-warmup',
  persistDebounceMs: 60_000,
});
for (let i = 0; i < WARMUP_CALLS; i += 1) {
  warmupManager.track(scenarioState(i));
}
warmupManager.destroy();

// --- Measurement -------------------------------------------------------
// Snapshot heap *after* warm-up so the warm-up allocations are already
// counted in the baseline and don't inflate our delta.
const startHeap = process.memoryUsage?.().heapUsed ?? 0;

const manager = new IntentManager({
  storageKey: 'perf-benchmark',
  // Use persistThrottleMs (not persistDebounceMs) to suppress serialization
  // overhead during the benchmark.  persistDebounceMs is only consumed by the
  // async retry path (AsyncPersistStrategy) and has no effect on the
  // SyncPersistStrategy that runs in this Node.js test harness.
  // A 60-second throttle window means the graph is serialized at most once
  // across the entire 100 k-call run, keeping per-track timing clean.
  persistThrottleMs: 60_000,
  benchmark: { enabled: true, maxSamples: TRACK_CALLS },
});
for (let i = 0; i < TRACK_CALLS; i += 1) {
  manager.track(scenarioState(i));
}
const report = manager.getPerformanceReport();
const endHeap = process.memoryUsage?.().heapUsed ?? 0;

// A single before/after heap snapshot is sufficient for a non-gated
// informational metric. If GC fires between the two readings the delta
// goes negative; in that case fall back to the graph's serialized size
// as a conservative lower-bound proxy rather than reporting 0 or a
// negative number.
const heapDelta = endHeap - startHeap;
const memoryUsageEstimate =
  heapDelta > 0 ? heapDelta : report.memoryFootprint.serializedGraphBytes * 10;

const benchmarkReport = {
  sdkVersion: process.env.npm_package_version ?? '0.0.0',
  nodeVersion: process.version ?? 'unknown',
  avgTrackMs: report.track.avgMs,
  p95TrackMs: report.track.p95Ms,
  p99TrackMs: report.track.p99Ms,
  memoryUsageEstimate,
  serializedGraphSizeBytes: report.memoryFootprint.serializedGraphBytes,
};

const benchmarkDir = path.resolve('benchmarks');
fs.mkdirSync(benchmarkDir, { recursive: true });
fs.writeFileSync(
  path.join(benchmarkDir, 'latest.json'),
  `${JSON.stringify(benchmarkReport, null, 2)}\n`,
);
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(
    path.join(benchmarkDir, 'baseline.json'),
    `${JSON.stringify(benchmarkReport, null, 2)}\n`,
  );
}

printPerfSummary(benchmarkReport);
console.log(`Saved benchmark report to ${path.join('benchmarks', 'latest.json')}`);

// Explicitly destroy the manager to flush pending debounce timers and
// event listeners, then force-exit so Node doesn't wait on dangling handles.
manager.destroy();
process.exit(0);
