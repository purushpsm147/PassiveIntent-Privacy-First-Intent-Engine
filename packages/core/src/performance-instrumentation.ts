/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface BenchmarkConfig {
  enabled?: boolean;
  maxSamples?: number;
}

export interface OperationStats {
  count: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface MemoryFootprintReport {
  stateCount: number;
  totalTransitions: number;
  bloomBitsetBytes: number;
  serializedGraphBytes: number;
}

export interface PerformanceReport {
  benchmarkEnabled: boolean;
  track: OperationStats;
  bloomAdd: OperationStats;
  bloomCheck: OperationStats;
  incrementTransition: OperationStats;
  entropyComputation: OperationStats;
  divergenceComputation: OperationStats;
  memoryFootprint: MemoryFootprintReport;
}

/**
 * Circular-buffer reservoir for per-operation timing samples.
 *
 * Once `maxSamples` is reached, new samples overwrite old ones at position
 * `count % maxSamples` (not true reservoir / random sampling).  This means
 * percentile estimates (p95, p99) are computed over the *most-recent*
 * `maxSamples` observations rather than a statistically unbiased sample of
 * all observations.  For the SDK’s benchmark use-case (detecting regressions
 * in the steady-state hot path) recency bias is acceptable.  If you need
 * unbiased percentiles across an arbitrary run duration, increase `maxSamples`
 * in the `BenchmarkConfig` to cover the full session.
 */
interface BenchmarkAccumulator {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
}

const DEFAULT_BENCHMARK_MAX_SAMPLES = 4096;

function createAccumulator(): BenchmarkAccumulator {
  return { count: 0, totalMs: 0, maxMs: 0, samples: [] };
}

function recordSample(acc: BenchmarkAccumulator, elapsedMs: number, maxSamples: number): void {
  acc.count += 1;
  acc.totalMs += elapsedMs;
  if (elapsedMs > acc.maxMs) acc.maxMs = elapsedMs;
  if (acc.samples.length < maxSamples) {
    acc.samples.push(elapsedMs);
  } else if (maxSamples > 0) {
    acc.samples[acc.count % maxSamples] = elapsedMs;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function toOperationStats(acc: BenchmarkAccumulator): OperationStats {
  if (acc.count === 0) return { count: 0, avgMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };

  const sorted = [...acc.samples].sort((a, b) => a - b);
  return {
    count: acc.count,
    avgMs: acc.totalMs / acc.count,
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: acc.maxMs,
  };
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

type OpName =
  | 'track'
  | 'bloomAdd'
  | 'bloomCheck'
  | 'incrementTransition'
  | 'entropyComputation'
  | 'divergenceComputation';

/**
 * Optional performance recorder for the SDK’s internal hot-path operations.
 *
 * Disabled by default (`enabled: false`) — all `now()` and `record()` calls
 * are no-ops when disabled, so there is zero overhead in production unless
 * callers explicitly opt in via `IntentManagerConfig.benchmark.enabled: true`.
 *
 * Exposes p95/p99 latency and a memory-footprint snapshot via `report()`.
 */
export class BenchmarkRecorder {
  readonly enabled: boolean;
  private readonly maxSamples: number;
  private readonly stats: Record<OpName, BenchmarkAccumulator>;

  constructor(config: BenchmarkConfig = {}) {
    this.enabled = config.enabled ?? false;
    this.maxSamples = config.maxSamples ?? DEFAULT_BENCHMARK_MAX_SAMPLES;
    this.stats = {
      track: createAccumulator(),
      bloomAdd: createAccumulator(),
      bloomCheck: createAccumulator(),
      incrementTransition: createAccumulator(),
      entropyComputation: createAccumulator(),
      divergenceComputation: createAccumulator(),
    };
  }

  now(): number {
    return this.enabled ? performance.now() : 0;
  }

  record(operation: OpName, startedAt: number): void {
    if (!this.enabled) return;
    recordSample(this.stats[operation], performance.now() - startedAt, this.maxSamples);
  }

  report(memoryFootprint: MemoryFootprintReport): PerformanceReport {
    return {
      benchmarkEnabled: this.enabled,
      track: toOperationStats(this.stats.track),
      bloomAdd: toOperationStats(this.stats.bloomAdd),
      bloomCheck: toOperationStats(this.stats.bloomCheck),
      incrementTransition: toOperationStats(this.stats.incrementTransition),
      entropyComputation: toOperationStats(this.stats.entropyComputation),
      divergenceComputation: toOperationStats(this.stats.divergenceComputation),
      memoryFootprint,
    };
  }

  serializedSizeBytes(payload: unknown): number {
    const asText = JSON.stringify(payload);
    return textEncoder ? textEncoder.encode(asText).byteLength : asText.length;
  }
}
