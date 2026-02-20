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

const maxRegressionPct = Number(process.env.PERF_MAX_REGRESSION_PCT ?? 10);
const maxP95 = Number(process.env.PERF_MAX_P95_TRACK_MS ?? 0.15);
const maxP99 = Number(process.env.PERF_MAX_P99_TRACK_MS ?? 0.30);
const maxGraphBytes = Number(process.env.PERF_MAX_GRAPH_BYTES ?? 20000);
const maxMemorySlope = Number(process.env.PERF_MAX_MEMORY_SLOPE ?? 512);
const trackCalls = Number(process.env.PERF_TRACK_CALLS ?? 100000);

const regressions = [];

function pctChange(base, current) {
  if (!base) return 0;
  return ((current - base) / base) * 100;
}

for (const key of ['avgTrackMs', 'p95TrackMs', 'p99TrackMs', 'memoryUsageEstimate', 'serializedGraphSizeBytes']) {
  const delta = pctChange(baseline[key], latest[key]);
  if (delta > maxRegressionPct) {
    regressions.push(`${key} regressed by ${delta.toFixed(2)}% (baseline=${baseline[key]}, current=${latest[key]})`);
  }
}

if (latest.p95TrackMs > maxP95) regressions.push(`p95TrackMs ${latest.p95TrackMs.toFixed(6)} exceeds ${maxP95}`);
if (latest.p99TrackMs > maxP99) regressions.push(`p99TrackMs ${latest.p99TrackMs.toFixed(6)} exceeds ${maxP99}`);
if (latest.serializedGraphSizeBytes > maxGraphBytes) {
  regressions.push(`serializedGraphSizeBytes ${latest.serializedGraphSizeBytes} exceeds ${maxGraphBytes}`);
}

const memorySlope = trackCalls > 0 ? latest.memoryUsageEstimate / trackCalls : latest.memoryUsageEstimate;
if (memorySlope > maxMemorySlope) {
  regressions.push(`memory growth slope ${memorySlope.toFixed(6)} bytes/track exceeds ${maxMemorySlope}`);
}

if (regressions.length > 0) {
  console.error('Performance regression check failed:');
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exit(1);
}

console.log('Performance regression check passed.');
