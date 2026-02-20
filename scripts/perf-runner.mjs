import fs from 'node:fs';
import path from 'node:path';
import { IntentManager } from '../dist/src/intent-sdk.js';
import { printPerfSummary } from '../dist/src/reporting-utils.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, value); }
}

if (!globalThis.localStorage) globalThis.localStorage = new MemoryStorage();
if (!globalThis.window) globalThis.window = { setTimeout, clearTimeout };
if (!globalThis.btoa) globalThis.btoa = (v) => Buffer.from(v, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (v) => Buffer.from(v, 'base64').toString('binary');

const TRACK_CALLS = Number(process.env.PERF_TRACK_CALLS ?? 100000);
const STATE_COUNT = 50;

function scenarioState(i) {
  return `S${i % STATE_COUNT}`;
}

const manager = new IntentManager({
  storageKey: 'perf-benchmark',
  persistDebounceMs: 60_000,
  benchmark: { enabled: true, maxSamples: TRACK_CALLS },
});

const startHeap = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().heapUsed : 0;
for (let i = 0; i < TRACK_CALLS; i += 1) {
  manager.track(scenarioState(i));
}
const report = manager.getPerformanceReport();
const endHeap = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().heapUsed : 0;

const benchmarkReport = {
  sdkVersion: process.env.npm_package_version ?? '0.0.0',
  nodeVersion: typeof process !== 'undefined' ? process.version : 'browser',
  avgTrackMs: report.track.avgMs,
  p95TrackMs: report.track.p95Ms,
  p99TrackMs: report.track.p99Ms,
  memoryUsageEstimate: Math.max(0, endHeap - startHeap) || report.memoryFootprint.serializedGraphBytes,
  serializedGraphSizeBytes: report.memoryFootprint.serializedGraphBytes,
};

const benchmarkDir = path.resolve('benchmarks');
fs.mkdirSync(benchmarkDir, { recursive: true });
fs.writeFileSync(path.join(benchmarkDir, 'latest.json'), `${JSON.stringify(benchmarkReport, null, 2)}\n`);
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(path.join(benchmarkDir, 'baseline.json'), `${JSON.stringify(benchmarkReport, null, 2)}\n`);
}

printPerfSummary(benchmarkReport);
console.log(`Saved benchmark report to ${path.join('benchmarks', 'latest.json')}`);
