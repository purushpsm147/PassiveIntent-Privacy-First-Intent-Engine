/**
 * Privacy-First Intent Engine ("UI Telepathy")
 * --------------------------------------------------------
 * Goals:
 * - Entirely local inference (no network/data egress)
 * - Tiny footprint + predictable runtime
 * - Sparse + quantized storage for state transitions
 */

import { BenchmarkRecorder } from './performance-instrumentation.js';
import type {
  BenchmarkConfig,
  PerformanceReport,
} from './performance-instrumentation.js';

export type {
  BenchmarkConfig,
  MemoryFootprintReport,
  OperationStats,
  PerformanceReport,
} from './performance-instrumentation.js';

export type IntentEventName = 'high_entropy' | 'trajectory_anomaly' | 'state_change';

export interface HighEntropyPayload {
  state: string;
  entropy: number;
  normalizedEntropy: number;
}

export interface TrajectoryAnomalyPayload {
  stateFrom: string;
  stateTo: string;
  realLogLikelihood: number;
  expectedBaselineLogLikelihood: number;
  zScore: number;
}

export interface StateChangePayload {
  from: string | null;
  to: string;
}

export interface IntentEventMap {
  high_entropy: HighEntropyPayload;
  trajectory_anomaly: TrajectoryAnomalyPayload;
  state_change: StateChangePayload;
}

export interface BloomFilterConfig {
  bitSize?: number;
  hashCount?: number;
}

export interface MarkovGraphConfig {
  /**
   * Entropy threshold in normalized [0..1] space.
   * Higher means "more random navigation".
   */
  highEntropyThreshold?: number;

  /**
   * Z-score trigger magnitude for anomaly detection.
   * A value of 3.5 means trigger when z <= -3.5.
   */
  divergenceThreshold?: number;

  /**
   * Calibrated baseline mean average log-likelihood.
   */
  baselineMeanLL?: number;

  /**
   * Calibrated baseline standard deviation of average log-likelihood.
   */
  baselineStdLL?: number;

  /**
   * Smoothing epsilon used when baseline transition probabilities are unknown.
   */
  smoothingEpsilon?: number;
}

export interface IntentManagerConfig {
  bloom?: BloomFilterConfig;
  graph?: MarkovGraphConfig;

  /**
   * Optional calibrated baseline mean average log-likelihood.
   */
  baselineMeanLL?: number;

  /**
   * Optional calibrated baseline standard deviation of average log-likelihood.
   */
  baselineStdLL?: number;

  /** localStorage key prefix */
  storageKey?: string;

  /** Debounce for persistence to avoid UI jank. */
  persistDebounceMs?: number;

  /**
   * Optional baseline graph used for trajectory log-likelihood comparison.
   */
  baseline?: SerializedMarkovGraph;

  /**
   * Optional performance instrumentation.
   */
  benchmark?: BenchmarkConfig;
}

/**
 * 32-bit FNV-1a hash.
 * Fast, deterministic, and non-cryptographic.
 */
function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (expanded to shifts/adds for speed in JS engines)
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return hash >>> 0;
}

/**
 * Convert a probability [0..1] to uint8 [0..255].
 */
function quantizeProbability(probability: number): number {
  if (probability <= 0) return 0;
  if (probability >= 1) return 255;
  return Math.round(probability * 255) & 0xff;
}

/**
 * Convert uint8 [0..255] back into [0..1].
 */
function dequantizeProbability(value: number): number {
  return (value & 0xff) / 255;
}

/**
 * Bloom Filter backed by Uint8Array bitset.
 * Storage overhead is fixed and tiny.
 */
export class BloomFilter {
  readonly bitSize: number;
  readonly hashCount: number;
  private readonly bits: Uint8Array;

  constructor(config: BloomFilterConfig = {}, existingBits?: Uint8Array) {
    this.bitSize = config.bitSize ?? 2048;
    this.hashCount = config.hashCount ?? 4;

    const byteSize = Math.ceil(this.bitSize / 8);
    this.bits = existingBits && existingBits.length === byteSize
      ? existingBits
      : new Uint8Array(byteSize);
  }

  add(item: string): void {
    // Compute both hashes once; derive k indices via double hashing.
    const h1 = fnv1a(item, 0x811c9dc5);
    const h2 = fnv1a(item, 0x01000193);
    for (let i = 0; i < this.hashCount; i += 1) {
      // Use >>> 0 to keep the sum as an unsigned 32-bit integer before modulo.
      const index = ((h1 + i * h2) >>> 0) % this.bitSize;
      this.setBit(index);
    }
  }

  check(item: string): boolean {
    // Same double-hash derivation as add() to ensure consistent bit positions.
    const h1 = fnv1a(item, 0x811c9dc5);
    const h2 = fnv1a(item, 0x01000193);
    for (let i = 0; i < this.hashCount; i += 1) {
      // Use >>> 0 to keep the sum as an unsigned 32-bit integer before modulo.
      const index = ((h1 + i * h2) >>> 0) % this.bitSize;
      if (!this.getBit(index)) return false;
    }
    // All bits are set => probably exists (allowing Bloom false positives).
    return true;
  }

  getBitsetByteSize(): number {
    return this.bits.byteLength;
  }

  toBase64(): string {
    let binary = '';
    for (let i = 0; i < this.bits.length; i += 1) {
      binary += String.fromCharCode(this.bits[i]);
    }
    return btoa(binary);
  }

  static fromBase64(base64: string, config: BloomFilterConfig = {}): BloomFilter {
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      arr[i] = binary.charCodeAt(i);
    }
    return new BloomFilter(config, arr);
  }

  private setBit(bitIndex: number): void {
    const byteIndex = bitIndex >> 3;
    const mask = 1 << (bitIndex & 7);
    this.bits[byteIndex] |= mask;
  }

  private getBit(bitIndex: number): boolean {
    const byteIndex = bitIndex >> 3;
    const mask = 1 << (bitIndex & 7);
    return (this.bits[byteIndex] & mask) !== 0;
  }
}

interface TransitionRow {
  total: number;
  toCounts: Map<number, number>;
}

export interface SerializedMarkovGraph {
  // index -> state label
  states: string[];
  // sparse rows, each entry [fromIndex, total, [toIndex, count][]]
  rows: Array<[number, number, Array<[number, number]>]>;
}

/**
 * Sparse Markov graph for transitions between states.
 * Uses nested Maps (sparse) and supports quantized probability export.
 */
export class MarkovGraph {
  private readonly rows = new Map<number, TransitionRow>();
  private readonly stateToIndex = new Map<string, number>();
  private readonly indexToState: string[] = [];

  readonly highEntropyThreshold: number;
  readonly divergenceThreshold: number;
  readonly smoothingEpsilon: number;
  readonly baselineMeanLL?: number;
  readonly baselineStdLL?: number;

  constructor(config: MarkovGraphConfig = {}) {
    this.highEntropyThreshold = config.highEntropyThreshold ?? 0.75;
    this.divergenceThreshold = Math.abs(config.divergenceThreshold ?? 3.5);
    this.smoothingEpsilon = config.smoothingEpsilon ?? 0.01;
    this.baselineMeanLL = config.baselineMeanLL;
    this.baselineStdLL = config.baselineStdLL;
  }

  ensureState(state: string): number {
    const existing = this.stateToIndex.get(state);
    if (existing !== undefined) return existing;
    const index = this.indexToState.length;
    this.stateToIndex.set(state, index);
    this.indexToState.push(state);
    return index;
  }

  incrementTransition(fromState: string, toState: string): void {
    const from = this.ensureState(fromState);
    const to = this.ensureState(toState);

    const row = this.rows.get(from) ?? { total: 0, toCounts: new Map<number, number>() };
    const nextCount = (row.toCounts.get(to) ?? 0) + 1;
    row.toCounts.set(to, nextCount);
    row.total += 1;
    this.rows.set(from, row);
  }

  /**
   * P(to|from) from live counts.
   */
  getProbability(fromState: string, toState: string): number {
    const from = this.stateToIndex.get(fromState);
    const to = this.stateToIndex.get(toState);
    if (from === undefined || to === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0) return 0;

    return (row.toCounts.get(to) ?? 0) / row.total;
  }

  /**
   * Entropy H(i) = -Σ P(i->j) log P(i->j)
   * Returned entropy is in nats (natural log).
   */
  entropyForState(state: string): number {
    const from = this.stateToIndex.get(state);
    if (from === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0) return 0;

    let entropy = 0;
    row.toCounts.forEach((count) => {
      const p = count / row.total;
      if (p > 0) entropy -= p * Math.log(p);
    });
    return entropy;
  }

  /**
   * Normalized entropy in [0..1], dividing by max entropy ln(k)
   * where k is number of outgoing edges.
   */
  normalizedEntropyForState(state: string): number {
    const from = this.stateToIndex.get(state);
    if (from === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0 || row.toCounts.size <= 1) return 0;

    const entropy = this.entropyForState(state);
    const maxEntropy = Math.log(row.toCounts.size);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * Log-likelihood trajectory:
   *   log L = Σ log P_baseline(s_t+1 | s_t)
   *
   * To avoid -Infinity when a transition doesn't exist in baseline,
   * apply epsilon smoothing.
   */
  static logLikelihoodTrajectory(
    baseline: MarkovGraph,
    sequence: string[],
    epsilon = 0.01,
  ): number {
    if (sequence.length < 2) return 0;

    let sum = 0;
    for (let i = 0; i < sequence.length - 1; i += 1) {
      const p = baseline.getProbability(sequence[i], sequence[i + 1]);
      sum += Math.log(p > 0 ? p : epsilon);
    }
    return sum;
  }

  /**
   * Quantized view of outgoing probabilities for a state as Uint8Array.
   *
   * Encoding per edge (3 bytes):
   *   byte 0: low byte  of toIndex  (toIndex & 0xff)
   *   byte 1: high byte of toIndex  ((toIndex >> 8) & 0xff)
   *   byte 2: quantized probability  round(P * 255) & 0xff
   *
   * Using 2 bytes for toIndex supports up to 65535 states without overflow.
   */
  getQuantizedRow(state: string): Uint8Array {
    const from = this.stateToIndex.get(state);
    if (from === undefined) return new Uint8Array(0);

    const row = this.rows.get(from);
    if (!row || row.total === 0) return new Uint8Array(0);

    // 3 bytes per edge: [lowByte(toIndex), highByte(toIndex), quantizedProbability]
    const out = new Uint8Array(row.toCounts.size * 3);
    let offset = 0;
    row.toCounts.forEach((count, toIndex) => {
      const probability = count / row.total;
      out[offset] = toIndex & 0xff; // low byte of toIndex
      out[offset + 1] = (toIndex >> 8) & 0xff; // high byte of toIndex
      out[offset + 2] = quantizeProbability(probability); // quantized probability
      offset += 3;
    });
    return out;
  }

  /**
   * Return dequantized transition probability by state labels.
   */
  getQuantizedProbability(fromState: string, toState: string): number {
    const from = this.stateToIndex.get(fromState);
    const to = this.stateToIndex.get(toState);
    if (from === undefined || to === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0) return 0;

    const count = row.toCounts.get(to) ?? 0;
    if (count === 0) return 0;

    return dequantizeProbability(quantizeProbability(count / row.total));
  }

  /**
   * Returns the total number of outgoing transitions recorded for a state.
   * Used as a minimum-sample guard before firing entropy/divergence events.
   */
  rowTotal(state: string): number {
    const from = this.stateToIndex.get(state);
    if (from === undefined) return 0;
    return this.rows.get(from)?.total ?? 0;
  }

  stateCount(): number {
    return this.indexToState.length;
  }

  totalTransitions(): number {
    let total = 0;
    this.rows.forEach((row) => {
      total += row.total;
    });
    return total;
  }

  toJSON(): SerializedMarkovGraph {
    const rows: SerializedMarkovGraph['rows'] = [];
    this.rows.forEach((row, fromIndex) => {
      const edges: Array<[number, number]> = [];
      row.toCounts.forEach((count, toIndex) => {
        edges.push([toIndex, count]);
      });
      rows.push([fromIndex, row.total, edges]);
    });

    return {
      states: [...this.indexToState],
      rows,
    };
  }

  static fromJSON(data: SerializedMarkovGraph, config: MarkovGraphConfig = {}): MarkovGraph {
    const graph = new MarkovGraph(config);

    for (let i = 0; i < data.states.length; i += 1) {
      graph.ensureState(data.states[i]);
    }

    for (let r = 0; r < data.rows.length; r += 1) {
      const [fromIndex, total, edges] = data.rows[r];
      const row: TransitionRow = { total, toCounts: new Map<number, number>() };
      for (let e = 0; e < edges.length; e += 1) {
        const [toIndex, count] = edges[e];
        row.toCounts.set(toIndex, count);
      }
      graph.rows.set(fromIndex, row);
    }

    return graph;
  }
}

/**
 * Smoothing epsilon for log-likelihood calculations.
 * Must be identical between calibration and runtime.
 */
const SMOOTHING_EPSILON = 0.01;

/**
 * Minimum sliding window length before evaluating trajectory.
 * This "warm-up" allows the average log-likelihood to stabilize.
 */
const MIN_WINDOW_LENGTH = 16;

/**
 * Maximum sliding window length (recentTrajectory cap).
 * Used as reference for variance scaling.
 */
const MAX_WINDOW_LENGTH = 32;

/**
 * Minimum number of outgoing transitions a state must have before entropy
 * evaluation is considered statistically meaningful.
 * Higher values prevent spurious entropy triggers on small samples.
 */
const MIN_SAMPLE_TRANSITIONS = 10;

type Listener<T> = (payload: T) => void;

/**
 * Tiny event emitter.
 */
class EventEmitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener<Events[K]>>();
    set.add(listener);
    this.listeners.set(event, set as Set<Listener<any>>);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach((listener) => listener(payload));
  }
}

interface PersistedPayload {
  bloomBase64: string;
  graph: SerializedMarkovGraph;
}

/**
 * Intent manager orchestrates collection + modeling + interventions.
 */
export class IntentManager {
  private readonly bloom: BloomFilter;
  private readonly graph: MarkovGraph;
  private readonly baseline: MarkovGraph | null;
  private readonly emitter = new EventEmitter<IntentEventMap>();
  private readonly storageKey: string;
  private readonly persistDebounceMs: number;
  private readonly benchmark: BenchmarkRecorder;

  private persistTimer: number | null = null;
  private previousState: string | null = null;
  private recentTrajectory: string[] = [];

  constructor(config: IntentManagerConfig = {}) {
    this.storageKey = config.storageKey ?? 'ui-telepathy';
    this.persistDebounceMs = config.persistDebounceMs ?? 2000;
    this.benchmark = new BenchmarkRecorder(config.benchmark);

    const graphConfig: MarkovGraphConfig = {
      ...config.graph,
      baselineMeanLL: config.baselineMeanLL ?? config.graph?.baselineMeanLL,
      baselineStdLL: config.baselineStdLL ?? config.graph?.baselineStdLL,
    };

    const restored = this.restore(graphConfig);

    this.bloom = restored?.bloom ?? new BloomFilter(config.bloom);
    this.graph = restored?.graph ?? new MarkovGraph(graphConfig);
    this.baseline = config.baseline ? MarkovGraph.fromJSON(config.baseline, graphConfig) : null;
  }

  on<K extends keyof IntentEventMap>(
    event: K,
    listener: (payload: IntentEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /**
   * Track a page view or custom state transition.
   */
  track(state: string): void {
    const trackStart = this.benchmark.now();

    const bloomAddStart = this.benchmark.now();
    this.bloom.add(state);
    this.benchmark.record('bloomAdd', bloomAddStart);

    const from = this.previousState;
    this.previousState = state;

    this.recentTrajectory.push(state);
    // Keep a short tail to bound memory and compute costs.
    if (this.recentTrajectory.length > MAX_WINDOW_LENGTH) this.recentTrajectory.shift();

    if (from) {
      const incrementStart = this.benchmark.now();
      this.graph.incrementTransition(from, state);
      this.benchmark.record('incrementTransition', incrementStart);

      this.evaluateEntropy(state);
      this.evaluateTrajectory(from, state);
    }

    this.emitter.emit('state_change', { from, to: state });
    this.schedulePersist();

    this.benchmark.record('track', trackStart);
  }

  hasSeen(state: string): boolean {
    const start = this.benchmark.now();
    const seen = this.bloom.check(state);
    this.benchmark.record('bloomCheck', start);
    return seen;
  }

  /**
   * Reset session-specific state for clean evaluation boundaries.
   * Clears the recent trajectory and previous state, but preserves
   * the learned Markov graph and Bloom filter.
   */
  resetSession(): void {
    this.recentTrajectory = [];
    this.previousState = null;
  }

  exportGraph(): SerializedMarkovGraph {
    return this.graph.toJSON();
  }

  flushNow(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  getPerformanceReport(): PerformanceReport {
    const serialized = this.graph.toJSON();
    return this.benchmark.report({
      stateCount: this.graph.stateCount(),
      totalTransitions: this.graph.totalTransitions(),
      bloomBitsetBytes: this.bloom.getBitsetByteSize(),
      serializedGraphBytes: this.benchmark.serializedSizeBytes(serialized),
    });
  }

  private evaluateEntropy(state: string): void {
    const start = this.benchmark.now();

    // Skip if there are fewer than MIN_SAMPLE_TRANSITIONS outgoing transitions (too small a sample).
    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);

    if (normalizedEntropy >= this.graph.highEntropyThreshold) {
      this.emitter.emit('high_entropy', {
        state,
        entropy,
        normalizedEntropy,
      });
    }

    this.benchmark.record('entropyComputation', start);
  }

  private evaluateTrajectory(from: string, to: string): void {
    const start = this.benchmark.now();

    // Stabilization gate: wait until window reaches minimum size for statistical stability.
    if (this.recentTrajectory.length < MIN_WINDOW_LENGTH) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    if (!this.baseline) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

    // Use explicit SMOOTHING_EPSILON for parity with calibration phase.
    const expected = MarkovGraph.logLikelihoodTrajectory(
      this.baseline,
      this.recentTrajectory,
      SMOOTHING_EPSILON,
    );

    const N = Math.max(1, this.recentTrajectory.length - 1);
    const expectedAvg = expected / N;
    const threshold = -Math.abs(this.graph.divergenceThreshold);

    const hasCalibratedBaseline =
      typeof this.graph.baselineMeanLL === 'number'
      && typeof this.graph.baselineStdLL === 'number'
      && Number.isFinite(this.graph.baselineMeanLL)
      && Number.isFinite(this.graph.baselineStdLL)
      && this.graph.baselineStdLL > 0;

    // Dynamic variance scaling: std of an average scales by 1/sqrt(N).
    // Scale baselineStdLL by sqrt(CALIBRATION_LENGTH / N) where CALIBRATION_LENGTH = MAX_WINDOW_LENGTH.
    const adjustedStd = hasCalibratedBaseline
      ? this.graph.baselineStdLL * Math.sqrt(MAX_WINDOW_LENGTH / N)
      : 0;

    const zScore = hasCalibratedBaseline
      ? (expectedAvg - this.graph.baselineMeanLL) / adjustedStd
      : expectedAvg;

    const shouldEmit = hasCalibratedBaseline
      ? zScore <= threshold
      : expectedAvg <= threshold;

    if (shouldEmit) {
      this.emitter.emit('trajectory_anomaly', {
        stateFrom: from,
        stateTo: to,
        realLogLikelihood: expected,
        expectedBaselineLogLikelihood: expected,
        zScore,
      });
    }

    this.benchmark.record('divergenceComputation', start);
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
    }

    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, this.persistDebounceMs);
  }

  private persist(): void {
    const payload: PersistedPayload = {
      bloomBase64: this.bloom.toBase64(),
      graph: this.graph.toJSON(),
    };
    localStorage.setItem(this.storageKey, JSON.stringify(payload));
  }

  private restore(graphConfig: MarkovGraphConfig): { bloom: BloomFilter; graph: MarkovGraph } | null {
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as PersistedPayload;
      const bloom = BloomFilter.fromBase64(parsed.bloomBase64);
      const graph = MarkovGraph.fromJSON(parsed.graph, graphConfig);
      return { bloom, graph };
    } catch {
      return null;
    }
  }
}
