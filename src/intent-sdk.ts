/**
 * Privacy-First Intent Engine ("UI Telepathy")
 * --------------------------------------------------------
 * Goals:
 * - Entirely local inference (no network/data egress)
 * - Tiny footprint + predictable runtime
 * - Sparse + quantized storage for state transitions
 */

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
  divergence: number;
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
   * Trigger anomaly when current trajectory deviates from baseline by this value.
   */
  divergenceThreshold?: number;
}

export interface IntentManagerConfig {
  bloom?: BloomFilterConfig;
  graph?: MarkovGraphConfig;

  /** localStorage key prefix */
  storageKey?: string;

  /** Debounce for persistence to avoid UI jank. */
  persistDebounceMs?: number;

  /**
   * Optional baseline graph used for trajectory log-likelihood comparison.
   */
  baseline?: SerializedMarkovGraph;
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

  constructor(config: MarkovGraphConfig = {}) {
    this.highEntropyThreshold = config.highEntropyThreshold ?? 0.75;
    // Default is per-step divergence; raw sum threshold of 6 was replaced by
    // a normalized per-step threshold of 0.5 (see evaluateTrajectory).
    this.divergenceThreshold = config.divergenceThreshold ?? 0.5;
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
    epsilon = 1e-6,
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
      out[offset]     = toIndex & 0xff;          // low byte of toIndex
      out[offset + 1] = (toIndex >> 8) & 0xff;   // high byte of toIndex
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
 * Minimum number of outgoing transitions a state must have before entropy or
 * divergence evaluation is considered statistically meaningful.
 */
const MIN_SAMPLE_TRANSITIONS = 3;

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

  private persistTimer: number | null = null;
  private previousState: string | null = null;
  private recentTrajectory: string[] = [];

  constructor(config: IntentManagerConfig = {}) {
    this.storageKey = config.storageKey ?? 'ui-telepathy';
    this.persistDebounceMs = config.persistDebounceMs ?? 2000;

    const restored = this.restore();

    this.bloom = restored?.bloom ?? new BloomFilter(config.bloom);
    this.graph = restored?.graph ?? new MarkovGraph(config.graph);
    this.baseline = config.baseline ? MarkovGraph.fromJSON(config.baseline, config.graph) : null;
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
    this.bloom.add(state);

    const from = this.previousState;
    this.previousState = state;

    this.recentTrajectory.push(state);
    // Keep a short tail to bound memory and compute costs.
    if (this.recentTrajectory.length > 32) this.recentTrajectory.shift();

    if (from) {
      this.graph.incrementTransition(from, state);
      this.evaluateEntropy(state);
      this.evaluateTrajectory(from, state);
    }

    this.emitter.emit('state_change', { from, to: state });
    this.schedulePersist();
  }

  hasSeen(state: string): boolean {
    return this.bloom.check(state);
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

  private evaluateEntropy(state: string): void {
    // Skip if there are fewer than MIN_SAMPLE_TRANSITIONS outgoing transitions (too small a sample).
    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) return;

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);

    if (normalizedEntropy >= this.graph.highEntropyThreshold) {
      this.emitter.emit('high_entropy', {
        state,
        entropy,
        normalizedEntropy,
      });
    }
  }

  private evaluateTrajectory(from: string, to: string): void {
    if (!this.baseline) return;

    // Skip if the from-state has too few transitions for a reliable estimate.
    if (this.graph.rowTotal(from) < MIN_SAMPLE_TRANSITIONS) return;

    // Calculate real log-likelihood for the bounded window using the live graph.
    let realLogLikelihood = 0;
    for (let i = 0; i < this.recentTrajectory.length - 1; i++) {
      const fromNode = this.recentTrajectory[i];
      const toNode = this.recentTrajectory[i + 1];
      const p = this.graph.getProbability(fromNode, toNode);
      realLogLikelihood += Math.log(p > 0 ? p : 1e-6);
    }

    // Expected baseline likelihood for the same window.
    const expected = MarkovGraph.logLikelihoodTrajectory(this.baseline, this.recentTrajectory);

    // Normalize both values by the number of transitions to make divergence
    // independent of trajectory length (per-step average log likelihood).
    const N = Math.max(1, this.recentTrajectory.length - 1);
    const realAvg = realLogLikelihood / N;
    const expectedAvg = expected / N;
    const divergence = Math.abs(realAvg - expectedAvg);

    if (divergence >= this.graph.divergenceThreshold) {
      this.emitter.emit('trajectory_anomaly', {
        stateFrom: from,
        stateTo: to,
        realLogLikelihood,
        expectedBaselineLogLikelihood: expected,
        divergence,
      });
    }
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

  private restore(): { bloom: BloomFilter; graph: MarkovGraph } | null {
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as PersistedPayload;
      const bloom = BloomFilter.fromBase64(parsed.bloomBase64);
      const graph = MarkovGraph.fromJSON(parsed.graph);
      return { bloom, graph };
    } catch {
      return null;
    }
  }
}
