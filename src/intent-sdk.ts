/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * EdgeSignal
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
import {
  BrowserStorageAdapter,
  BrowserTimerAdapter,
} from './adapters.js';
import type { StorageAdapter, TimerAdapter, TimerHandle } from './adapters.js';

export type {
  BenchmarkConfig,
  MemoryFootprintReport,
  OperationStats,
  PerformanceReport,
} from './performance-instrumentation.js';

export type IntentEventName = 'high_entropy' | 'trajectory_anomaly' | 'state_change' | 'dwell_time_anomaly' | 'conversion' | 'bot_detected' | 'hesitation_detected';

/**
 * Payload for a conversion event.
 * No PII is required — `type` is an application-defined label (e.g. 'purchase', 'signup').
 * `value` and `currency` are optional and never leave the device.
 */
export interface ConversionPayload {
  /** Application-defined conversion label. Must not contain user identifiers. */
  type: string;
  /** Optional monetary value of the conversion. */
  value?: number;
  /** ISO 4217 currency code, e.g. 'USD'. Only meaningful when `value` is set. */
  currency?: string;
}

/**
 * GDPR-compliant telemetry snapshot.
 * All fields are aggregate counters or derived status flags — no raw
 * behavioral data, no state labels, and no user-identifying information.
 */
export interface EdgeSignalTelemetry {
  /**
   * Short-lived, purely local session identifier generated with
   * `crypto.randomUUID()` (or a Math.random fallback).
   * Never persisted, never transmitted. Useful for correlating
   * in-memory events within a single page lifetime.
   */
  sessionId: string;
  /** Total number of state transitions evaluated this session. */
  transitionsEvaluated: number;
  /** Whether the current session is classified as human or a suspected bot. */
  botStatus: 'human' | 'suspected_bot';
  /** Total number of anomaly events emitted (high_entropy + trajectory_anomaly + dwell_time_anomaly). */
  anomaliesFired: number;
  /** Current operational health of the engine. */
  engineHealth: 'healthy' | 'pruning_active' | 'quota_exceeded';
}

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

export interface DwellTimeAnomalyPayload {
  /** The state the user just left (where they dwelled). */
  state: string;
  /** Actual dwell time in milliseconds. */
  dwellMs: number;
  /** Running mean dwell time for this state (ms). */
  meanMs: number;
  /** Running standard deviation of dwell time for this state (ms). */
  stdMs: number;
  /** Z-score: how many standard deviations from the mean. */
  zScore: number;
}

/**
 * Emitted on the false → true transition of EntropyGuard's bot classification.
 * Fires at most once per detection event (not on every track() call while bot is active).
 * Payload reuses the same fields as HighEntropyPayload for easy forwarding.
 */
export interface BotDetectedPayload {
  /** The state being tracked when bot classification was triggered. */
  state: string;
}

/**
 * Emitted when both a spatial (`trajectory_anomaly`) and a temporal
 * (`dwell_time_anomaly` with positive z-score) signal fire within the
 * `hesitationCorrelationWindowMs` window.
 *
 * This is the high-level convenience event for hesitation detection.
 * The low-level `trajectory_anomaly` and `dwell_time_anomaly` events
 * still fire independently for power users who need granular control.
 */
export interface HesitationDetectedPayload {
  /**
   * The state that completed the dual-signal correlation window.
   * Typically the state where the user dwelled anomalously (the 'from' state
   * of the transition that triggered `dwell_time_anomaly`).
   */
  state: string;
  /** Z-score from the trajectory anomaly that contributed. */
  trajectoryZScore: number;
  /** Z-score from the dwell-time anomaly that contributed (always positive). */
  dwellZScore: number;
}

export interface IntentEventMap {
  high_entropy: HighEntropyPayload;
  trajectory_anomaly: TrajectoryAnomalyPayload;
  state_change: StateChangePayload;
  dwell_time_anomaly: DwellTimeAnomalyPayload;
  conversion: ConversionPayload;
  bot_detected: BotDetectedPayload;
  hesitation_detected: HesitationDetectedPayload;
}

export interface DwellTimeConfig {
  /**
   * Enable dwell-time anomaly detection.
   * Default: false.
   */
  enabled?: boolean;

  /**
   * Minimum number of dwell-time samples on a state before
   * anomaly detection kicks in.  Prevents false signals
   * during the learning phase.
   *
   * Because dwell-time statistics are **session-scoped** (not persisted
   * across page reloads — see privacy rationale on `IntentManager.dwellStats`),
   * the learning phase restarts on every new instance.  Consider raising
   * this value for applications where users frequently reload the page.
   * Default: 10.
   */
  minSamples?: number;

  /**
   * Z-score threshold for dwell-time anomaly.
   * An event fires when |z| >= this value.
   * Default: 2.5.
   */
  zScoreThreshold?: number;
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

  /**
   * Maximum number of live states before LFU pruning kicks in.
   * Default: 500.  Set to Infinity to disable pruning entirely.
   */
  maxStates?: number;
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

  /**
   * Isomorphic storage adapter (defaults to BrowserStorageAdapter).
   * Provide a custom adapter for SSR or testing.
   */
  storage?: StorageAdapter;

  /**
   * Isomorphic timer adapter (defaults to BrowserTimerAdapter).
   * Provide a custom adapter for SSR or testing.
   */
  timer?: TimerAdapter;

  /**
   * Error callback invoked when persistence fails
   * (e.g. QuotaExceededError, SecurityError).
   * If not provided, errors are silently swallowed to avoid crashing the main thread.
   */
  onError?: (err: Error) => void;

  /**
   * Enable EntropyGuard bot detection.
   * When enabled, tracks timing patterns to detect automated/bot traffic
   * and silently disables entropy/trajectory evaluation for suspected bots.
   * Default: true. Set to false for E2E testing environments (e.g., Cypress).
   */
  botProtection?: boolean;

  /**
   * Minimum interval (ms) between emissions of the same event type
   * (`high_entropy`, `trajectory_anomaly`, or `dwell_time_anomaly`).
   * Prevents listener flooding during rage-click or rapid-navigation bursts.
   *
   * Set to 0 to disable cooldown (fire on every qualifying `track()`).
   * Default: 0 (no cooldown — preserves backward-compatible behavior).
   */
  eventCooldownMs?: number;

  /**
   * Time window (ms) within which both a `trajectory_anomaly` AND a positive
   * `dwell_time_anomaly` must fire for the composite `hesitation_detected`
   * event to be emitted.
   *
   * Increase this value on slow-paced funnels (e.g. B2B quote flows);
   * decrease it for fast e-commerce checkouts.
   * Default: 30 000 (30 seconds).
   */
  hesitationCorrelationWindowMs?: number;

  /**
   * Dwell-time anomaly detection configuration.
   * Tracks how long a user stays on each state and fires
   * `dwell_time_anomaly` when the dwell time is statistically
   * unusual (z-score exceeds threshold).  Complements EntropyGuard.
   */
  dwellTime?: DwellTimeConfig;

  /**
   * Enable selective second-order (bigram) Markov transitions.
   *
   * When enabled, the engine records bigram states ("A→B") alongside
   * unigram states, but only for transitions whose unigram "from" state
   * has been observed at least `bigramFrequencyThreshold` times.
   * This prevents state-space explosion while capturing the most
   * informative two-step patterns.
   *
   * Bigram states share the same `maxStates` cap and are subject
   * to LFU pruning, so memory is bounded.
   *
   * Default: false.
   */
  enableBigrams?: boolean;

  /**
   * Minimum outgoing transition count on the unigram "from" state
   * before bigram states are recorded for that transition.
   * Only relevant when `enableBigrams` is true.
   * Default: 5.
   */
  bigramFrequencyThreshold?: number;
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
 * Convert a Uint8Array to a base64 string using chunked
 * String.fromCharCode to avoid O(n) string concatenation.
 * Processes in 32 KiB chunks to stay well within the
 * maximum argument count for Function.prototype.apply.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KiB
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return btoa(parts.join(''));
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

  /**
   * Compute optimal Bloom filter parameters for a given capacity and
   * desired false-positive rate using the standard formulas:
   *
   *   m = ceil( -(n * ln(p)) / (ln(2))^2 )
   *   k = round( (m / n) * ln(2) )
   *
   * where n = expectedItems, p = targetFPR, m = bitSize, k = hashCount.
   */
  static computeOptimal(
    expectedItems: number,
    targetFPR: number,
  ): { bitSize: number; hashCount: number } {
    // Guard against degenerate inputs.
    if (expectedItems <= 0) return { bitSize: 8, hashCount: 1 };
    if (targetFPR <= 0) targetFPR = 1e-10;
    if (targetFPR >= 1) targetFPR = 0.99;

    const ln2 = Math.LN2;                       // 0.6931…
    const ln2Sq = ln2 * ln2;                     // 0.4805…

    // m = ceil( -(n * ln(p)) / ln(2)^2 )
    const m = Math.ceil(-(expectedItems * Math.log(targetFPR)) / ln2Sq);

    // k = round( (m / n) * ln(2) )
    const k = Math.max(1, Math.round((m / expectedItems) * ln2));

    return { bitSize: m, hashCount: k };
  }

  /**
   * Estimate the current false-positive rate given the number of items
   * that have been inserted.  Uses the standard approximation:
   *
   *   FPR ≈ (1 - e^(-k*n/m))^k
   *
   * where m = bitSize, k = hashCount, n = insertedItemsCount.
   */
  estimateCurrentFPR(insertedItemsCount: number): number {
    if (insertedItemsCount <= 0) return 0;
    // Probability a single bit is still 0 after k*n insertions.
    const exponent = -(this.hashCount * insertedItemsCount) / this.bitSize;
    const bitZeroProbability = Math.exp(exponent);
    // FPR = probability that all k bits are 1 for a random query.
    return Math.pow(1 - bitZeroProbability, this.hashCount);
  }

  getBitsetByteSize(): number {
    return this.bits.byteLength;
  }

  toBase64(): string {
    return uint8ToBase64(this.bits);
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
  /** index → state label; '' marks a tombstone (freed) slot */
  states: string[];
  /** sparse rows: [fromIndex, total, [toIndex, count][]] */
  rows: Array<[number, number, Array<[number, number]>]>;
  /** explicit list of freed (tombstoned) slot indices */
  freedIndices: number[];
}

/**
 * Sparse Markov graph for transitions between states.
 * Uses nested Maps (sparse) and supports quantized probability export.
 */
export class MarkovGraph {
  private readonly rows = new Map<number, TransitionRow>();
  private readonly stateToIndex = new Map<string, number>();
  private readonly indexToState: string[] = [];
  private readonly freedIndices: number[] = [];

  readonly highEntropyThreshold: number;
  readonly divergenceThreshold: number;
  readonly smoothingEpsilon: number;
  readonly baselineMeanLL?: number;
  readonly baselineStdLL?: number;
  readonly maxStates: number;

  constructor(config: MarkovGraphConfig = {}) {
    this.highEntropyThreshold = config.highEntropyThreshold ?? 0.75;
    this.divergenceThreshold = Math.abs(config.divergenceThreshold ?? 3.5);
    this.smoothingEpsilon = config.smoothingEpsilon ?? 0.01;
    this.baselineMeanLL = config.baselineMeanLL;
    this.baselineStdLL = config.baselineStdLL;
    this.maxStates = config.maxStates ?? 500;
  }

  ensureState(state: string): number {
    if (state === '') throw new Error('MarkovGraph: state label must not be empty string');
    const existing = this.stateToIndex.get(state);
    if (existing !== undefined) return existing;

    let index: number;
    if (this.freedIndices.length > 0) {
      index = this.freedIndices.pop()!;
      this.indexToState[index] = state;
    } else {
      index = this.indexToState.length;
      this.indexToState.push(state);
    }
    this.stateToIndex.set(state, index);
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

  /**
   * LFU (Least-Frequently-Used) pruning.
   *
   * When the number of live states exceeds `maxStates`, evict the bottom
   * ~20 % of states ranked by total outgoing transitions.  Rather than
   * re-indexing (which would invalidate every edge reference), pruned
   * states are "tombstoned":
   *
   *   1. Their outgoing row is deleted from `this.rows`.
   *   2. Any inbound edges referencing them are removed from other rows.
   *   3. The slot in `indexToState` is set to '' (dead index) and the
   *      entry is removed from `stateToIndex`.
   *
   * This is O(S + E) where S = stateCount and E = total edge entries.
   */
  prune(): void {
    const liveCount = this.stateToIndex.size;
    if (liveCount <= this.maxStates) return;

    // ── 1. Rank every live state by total outgoing transitions (LFU) ──
    // Map.forEach callback: (value: number, key: string) where value = index.
    const ranked: Array<{ index: number; total: number }> = [];
    this.stateToIndex.forEach((idx) => {
      const row = this.rows.get(idx);
      ranked.push({ index: idx, total: row?.total ?? 0 });
    });

    // Sort ascending by total transitions (lowest first = least used).
    ranked.sort((a, b) => a.total - b.total);

    // Evict bottom 20 % (at least 1, at most enough to get back to maxStates).
    const evictTarget = Math.max(1, Math.min(
      Math.ceil(liveCount * 0.2),
      liveCount - this.maxStates,
    ));
    const evictSet = new Set<number>();
    for (let i = 0; i < evictTarget && i < ranked.length; i += 1) {
      evictSet.add(ranked[i].index);
    }

    // ── 2. Remove outgoing rows for evicted states ──
    evictSet.forEach((idx) => {
      this.rows.delete(idx);
    });

    // ── 3. Scrub inbound edges from surviving rows ──
    this.rows.forEach((row) => {
      let removedTotal = 0;
      evictSet.forEach((deadIdx) => {
        const count = row.toCounts.get(deadIdx);
        if (count !== undefined) {
          removedTotal += count;
          row.toCounts.delete(deadIdx);
        }
      });
      row.total -= removedTotal;
    });

    // ── 4. Tombstone index slots and register for reuse ──
    evictSet.forEach((idx) => {
      const label = this.indexToState[idx];
      if (label !== undefined && label !== '') {
        this.stateToIndex.delete(label);
      }
      this.freedIndices.push(idx);
      this.indexToState[idx] = '';  // dead slot
    });
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
      freedIndices: [...this.freedIndices],
    };
  }

  static fromJSON(data: SerializedMarkovGraph, config: MarkovGraphConfig = {}): MarkovGraph {
    const graph = new MarkovGraph(config);
    const tombstoneSet = new Set(data.freedIndices);

    for (let i = 0; i < data.states.length; i += 1) {
      const label = data.states[i];
      graph.indexToState.push(label);

      if (tombstoneSet.has(i)) {
        if (label !== '') {
          throw new Error(
            `MarkovGraph.fromJSON: slot ${i} is listed in freedIndices but has non-empty label "${label}"`,
          );
        }
        graph.freedIndices.push(i);
      } else {
        if (label === '') {
          throw new Error(
            `MarkovGraph.fromJSON: slot ${i} has an empty-string label but is not listed in ` +
            `freedIndices. Empty string is reserved as the tombstone marker.`,
          );
        }
        graph.stateToIndex.set(label, i);
      }
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

  /* ================================================================== */
  /*  Binary serialization — zero-dependency, zero JSON.stringify        */
  /* ================================================================== */

  /**
   * Binary wire format — version 0x02, little-endian throughout:
   *
   * ┌──────────────────────────────────────┐
   * │ Version           : Uint8   (1B)     │  — always 0x02
   * │ NumStates         : Uint16  (2B)     │
   * │ ┌── for each state ───────────────┐  │
   * │ │ StringByteLen : Uint16 (2B)     │  │  — 0 bytes for tombstone slots
   * │ │ UTF-8 Bytes   : [N]             │  │
   * │ └─────────────────────────────────┘  │
   * │ NumFreedIndices   : Uint16  (2B)     │  — 0 if no tombstones
   * │ ┌── for each freed index ─────────┐  │
   * │ │ SlotIndex : Uint16 (2B)         │  │
   * │ └─────────────────────────────────┘  │
   * │ NumRows           : Uint16  (2B)     │
   * │ ┌── for each row ──────────────────┐ │
   * │ │ FromIndex  : Uint16  (2B)        │ │
   * │ │ Total      : Uint32  (4B)        │ │
   * │ │ NumEdges   : Uint16  (2B)        │ │
   * │ │ ┌── for each edge ─────────────┐ │ │
   * │ │ │ ToIndex : Uint16 (2B)        │ │ │
   * │ │ │ Count   : Uint32 (4B)        │ │ │
   * │ │ └──────────────────────────────┘ │ │
   * │ └──────────────────────────────────┘ │
   * └──────────────────────────────────────┘
   */
  toBinary(): Uint8Array {
    const encoder = new TextEncoder();

    // ── Pre-compute total buffer size so we allocate exactly once ──

    // Header: version (1B) + numStates (2B) = 3 bytes
    let totalSize = 3;

    // Encode all state labels to UTF-8 up front and cache the buffers.
    const encodedLabels: Uint8Array[] = new Array(this.indexToState.length);
    for (let i = 0; i < this.indexToState.length; i += 1) {
      encodedLabels[i] = encoder.encode(this.indexToState[i]);
      // Per state: stringByteLen (Uint16 = 2B) + actual bytes
      totalSize += 2 + encodedLabels[i].byteLength;
    }

    // V2 freed-index section: numFreedIndices (2B) + freed index values (2B each)
    totalSize += 2 + this.freedIndices.length * 2;

    // NumRows header: 2 bytes
    totalSize += 2;

    // Per row:  fromIndex (2B) + total (4B) + numEdges (2B) = 8 bytes
    // Per edge: toIndex (2B) + count (4B) = 6 bytes
    this.rows.forEach((row) => {
      totalSize += 8;                          // row header
      totalSize += row.toCounts.size * 6;      // edges
    });

    // ── Allocate buffer + DataView ──
    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer);
    let offset = 0;

    // ── Write header ──

    // Byte 0: format version (0x02 — adds explicit freed-index list)
    view.setUint8(offset, 0x02);               // version = 2
    offset += 1;                               // offset now 1

    // Bytes 1-2: number of states (Uint16 LE)
    view.setUint16(offset, this.indexToState.length, true);
    offset += 2;                               // offset now 3

    // ── Write state labels ──
    for (let i = 0; i < this.indexToState.length; i += 1) {
      const encoded = encodedLabels[i];

      // 2 bytes: UTF-8 byte length of this label
      view.setUint16(offset, encoded.byteLength, true);
      offset += 2;

      // N bytes: raw UTF-8 payload
      buffer.set(encoded, offset);
      offset += encoded.byteLength;
    }

    // ── Write freed-index list (V2) ──

    // 2 bytes: number of freed indices (Uint16 LE)
    view.setUint16(offset, this.freedIndices.length, true);
    offset += 2;

    // 2 bytes each: freed slot index (Uint16 LE)
    for (let i = 0; i < this.freedIndices.length; i += 1) {
      view.setUint16(offset, this.freedIndices[i], true);
      offset += 2;
    }

    // ── Write rows header ──

    // 2 bytes: number of rows with data
    view.setUint16(offset, this.rows.size, true);
    offset += 2;

    // ── Write each row ──
    this.rows.forEach((row, fromIndex) => {
      // 2 bytes: fromIndex (Uint16 LE)
      view.setUint16(offset, fromIndex, true);
      offset += 2;

      // 4 bytes: total outgoing transitions (Uint32 LE)
      view.setUint32(offset, row.total, true);
      offset += 4;

      // 2 bytes: number of edges (Uint16 LE)
      view.setUint16(offset, row.toCounts.size, true);
      offset += 2;

      // Per edge: toIndex (2B) + count (4B)
      row.toCounts.forEach((count, toIndex) => {
        // 2 bytes: destination state index (Uint16 LE)
        view.setUint16(offset, toIndex, true);
        offset += 2;

        // 4 bytes: transition count (Uint32 LE)
        view.setUint32(offset, count, true);
        offset += 4;
      });
    });

    return buffer;
  }

  /**
   * Reconstruct a MarkovGraph from the binary format produced by `toBinary()`.
   * See the encoding spec in `toBinary()` for the wire layout.
   */
  static fromBinary(buffer: Uint8Array, config: MarkovGraphConfig = {}): MarkovGraph {
    const graph = new MarkovGraph(config);
    const decoder = new TextDecoder();
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;

    // ── Read header ──

    // Byte 0: version — only 0x02 is supported.
    const version = view.getUint8(offset);
    offset += 1;
    if (version !== 0x02) {
      throw new Error(
        `Unsupported MarkovGraph binary version: 0x${version.toString(16).padStart(2, '0')}. ` +
        `Only version 0x02 is supported.`,
      );
    }

    // Bytes 1-2: number of states (Uint16 LE)
    const numStates = view.getUint16(offset, true);
    offset += 2;

    // ── Read state labels into a temporary buffer ──
    // Classification (live vs tombstone) happens after reading the freed-index
    // list, so we store raw labels first and populate the graph below.
    const rawLabels: string[] = [];
    for (let i = 0; i < numStates; i += 1) {
      const strLen = view.getUint16(offset, true);
      offset += 2;
      rawLabels.push(decoder.decode(buffer.subarray(offset, offset + strLen)));
      offset += strLen;
    }

    // ── Read freed-index list and classify slots ──
    const numFreed = view.getUint16(offset, true);
    offset += 2;

    const tombstoneSet = new Set<number>();
    for (let i = 0; i < numFreed; i += 1) {
      tombstoneSet.add(view.getUint16(offset, true));
      offset += 2;
    }

    for (let i = 0; i < rawLabels.length; i += 1) {
      const label = rawLabels[i];
      graph.indexToState.push(label);
      if (tombstoneSet.has(i)) {
        if (label !== '') {
          throw new Error(
            `MarkovGraph.fromBinary: slot ${i} is listed as freed but has non-empty label "${label}"`,
          );
        }
        graph.freedIndices.push(i);
      } else {
        if (label === '') {
          throw new Error(
            `MarkovGraph.fromBinary: slot ${i} has an empty-string label but is not listed ` +
            `in the freed-index section. Empty string is reserved as the tombstone marker.`,
          );
        }
        graph.stateToIndex.set(label, i);
      }
    }

    // ── Read rows ──

    // 2 bytes: number of rows
    const numRows = view.getUint16(offset, true);
    offset += 2;

    for (let r = 0; r < numRows; r += 1) {
      // 2 bytes: fromIndex
      const fromIndex = view.getUint16(offset, true);
      offset += 2;

      // 4 bytes: total transitions
      const total = view.getUint32(offset, true);
      offset += 4;

      // 2 bytes: number of edges
      const numEdges = view.getUint16(offset, true);
      offset += 2;

      const toCounts = new Map<number, number>();
      for (let e = 0; e < numEdges; e += 1) {
        // 2 bytes: toIndex
        const toIndex = view.getUint16(offset, true);
        offset += 2;

        // 4 bytes: count
        const count = view.getUint32(offset, true);
        offset += 4;

        toCounts.set(toIndex, count);
      }

      graph.rows.set(fromIndex, { total, toCounts });
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

/* ============================================ */
/* EntropyGuard Constants                       */
/* ============================================ */

/**
 * Number of recent track() timestamps to keep for bot detection.
 * Uses a fixed-size circular buffer to avoid allocations.
 */
const BOT_DETECTION_WINDOW = 10;

/**
 * Minimum time delta (ms) between track() calls.
 * Deltas below this are considered "impossibly fast" for humans.
 */
const BOT_MIN_DELTA_MS = 50;

/**
 * Maximum variance threshold for delta timings.
 * Robotic clicking tends to have extremely low variance.
 */
const BOT_MAX_VARIANCE = 100;

/**
 * Score threshold at which we flag the session as a suspected bot.
 */
const BOT_SCORE_THRESHOLD = 5;

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

  removeAll(): void {
    this.listeners.clear();
  }
}

/**
 * Persisted payload format.
 *
 * `graphBinary` is a base64-encoded Uint8Array produced by MarkovGraph.toBinary().
 * The `graph` field (JSON-serialized) is kept for the baseline config path only;
 * the persistence hot-path always uses the binary format.
 */
interface PersistedPayload {
  /** Always present. */
  bloomBase64: string;
  /** Base64-encoded binary graph (preferred for restore). */
  graphBinary?: string;
  /** JSON-serialized graph — used only for the baseline config path. */
  graph?: SerializedMarkovGraph;
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
  private readonly storage: StorageAdapter;
  private readonly timer: TimerAdapter;
  private readonly onError?: (err: Error) => void;
  private readonly botProtection: boolean;
  private readonly eventCooldownMs: number;

  /* Dwell-time anomaly detection */
  private readonly dwellTimeEnabled: boolean;
  private readonly dwellTimeMinSamples: number;
  private readonly dwellTimeZScoreThreshold: number;
  /**
   * Per-state Welford accumulators: [count, mean, m2].
   *
   * **Session-scoped — intentionally not persisted.**
   * Persisting per-state timing distributions across page reloads would
   * meaningfully increase the cross-session fingerprinting surface area,
   * which conflicts with the library's privacy-first design goal.
   * As a result, the learning phase (governed by `minSamples`) restarts
   * on every new `IntentManager` instance.  Increase `minSamples` if
   * short sessions cause excessive false positives.
   */
  private readonly dwellStats = new Map<string, [number, number, number]>();

  /* Selective bigram (2nd-order) Markov */
  private readonly enableBigrams: boolean;
  private readonly bigramFrequencyThreshold: number;

  /** Timestamp of the last emission per cooldown-gated event type */
  private lastEmittedAt: Record<'high_entropy' | 'trajectory_anomaly' | 'dwell_time_anomaly', number> = {
    high_entropy: -Infinity,
    trajectory_anomaly: -Infinity,
    dwell_time_anomaly: -Infinity,
  };

  private persistTimer: TimerHandle | null = null;
  private previousState: string | null = null;
  /** Timestamp (ms, from timer.now()) when previousState was entered */
  private previousStateEnteredAt: number = 0;
  private recentTrajectory: string[] = [];

  /* Dirty-flag persistence: only persist when state actually changed */
  private isDirty = false;

  /* EntropyGuard: bot detection state */
  private isSuspectedBot = false;
  /** Fixed-size circular buffer for track() timestamps (avoids allocations) */
  private readonly trackTimestamps: number[] = new Array(BOT_DETECTION_WINDOW).fill(0);
  /** Current index in the circular buffer */
  private trackTimestampIndex = 0;
  /** Number of timestamps recorded (up to BOT_DETECTION_WINDOW) */
  private trackTimestampCount = 0;

  /* ================================================================== */
  /*  GDPR-Compliant Telemetry                                           */
  /* ================================================================== */

  /**
   * Short-lived session identifier. Generated once at construction.
   * Never persisted to storage and never transmitted.
   */
  private readonly sessionId: string;
  /** Aggregate count of state transitions evaluated this session. */
  private transitionsEvaluated = 0;
  /** Aggregate count of anomaly events emitted this session. */
  private anomaliesFired = 0;
  /** Operational health flag — mutated by persist() and the quota error handler. */
  private engineHealth: EdgeSignalTelemetry['engineHealth'] = 'healthy';

  /* Hesitation detection: timestamps and z-scores from the last contributing signals */
  private lastTrajectoryAnomalyAt = -Infinity;
  private lastTrajectoryAnomalyZScore = 0;
  private lastDwellAnomalyAt = -Infinity;
  private lastDwellAnomalyZScore = 0;
  /** The state where the user dwelled anomalously — anchors hesitation_detected.state. */
  private lastDwellAnomalyState = '';
  private readonly hesitationCorrelationWindowMs: number;

  constructor(config: IntentManagerConfig = {}) {
    this.storageKey = config.storageKey ?? 'edge-signal';
    this.persistDebounceMs = config.persistDebounceMs ?? 2000;
    this.benchmark = new BenchmarkRecorder(config.benchmark);
    this.storage = config.storage ?? new BrowserStorageAdapter();
    this.timer = config.timer ?? new BrowserTimerAdapter();
    this.onError = config.onError;
    this.botProtection = config.botProtection ?? true;
    this.eventCooldownMs = config.eventCooldownMs ?? 0;
    this.hesitationCorrelationWindowMs = config.hesitationCorrelationWindowMs ?? 30_000;

    // Dwell-time config
    this.dwellTimeEnabled = config.dwellTime?.enabled ?? false;
    this.dwellTimeMinSamples = config.dwellTime?.minSamples ?? 10;
    this.dwellTimeZScoreThreshold = config.dwellTime?.zScoreThreshold ?? 2.5;

    // Bigram config
    this.enableBigrams = config.enableBigrams ?? false;
    this.bigramFrequencyThreshold = config.bigramFrequencyThreshold ?? 5;

    // Telemetry: generate a short-lived, local-only session ID.
    // globalThis.crypto.randomUUID() is available in all modern browsers and
    // Node ≥ 19 (unflagged). Node 14.17–18 exposed randomUUID() only via the
    // built-in 'crypto' module (require('crypto')), NOT as a global, so those
    // runtimes will correctly fall back to the Math.random path below.
    this.sessionId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

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
    // Guard: '' is reserved internally as a tombstone marker.
    // Silently drop the call and surface a non-fatal error rather than letting
    // MarkovGraph.ensureState() throw and potentially crash the host app.
    if (state === '') {
      if (this.onError) {
        this.onError(new Error('IntentManager.track(): state label must not be an empty string'));
      }
      return;
    }

    // Use timer.now() for bot detection to ensure it works even when benchmark is disabled
    const now = this.timer.now();
    const trackStart = this.benchmark.enabled ? now : 0;

    // EntropyGuard: record timestamp and evaluate for bot-like patterns
    if (this.botProtection) {
      this.recordTrackTimestamp(now, state);
    }

    // Check if state is new to the Bloom filter (for dirty-flag tracking)
    const isNewToBloom = !this.bloom.check(state);

    const bloomAddStart = this.benchmark.now();
    this.bloom.add(state);
    this.benchmark.record('bloomAdd', bloomAddStart);

    const from = this.previousState;
    this.previousState = state;

    // Dwell-time: evaluate how long the user stayed on the *previous* state
    if (this.dwellTimeEnabled && from && !this.isSuspectedBot) {
      const dwellMs = now - this.previousStateEnteredAt;
      this.evaluateDwellTime(from, dwellMs);
    }
    this.previousStateEnteredAt = now;

    this.recentTrajectory.push(state);
    // Keep a short tail to bound memory and compute costs.
    if (this.recentTrajectory.length > MAX_WINDOW_LENGTH) this.recentTrajectory.shift();

    if (from) {
      this.transitionsEvaluated += 1;

      const incrementStart = this.benchmark.now();
      this.graph.incrementTransition(from, state);
      this.benchmark.record('incrementTransition', incrementStart);

      // Selective bigram: record "A→B" → "B→C" transition when the unigram
      // from-state has been observed enough times to be statistically meaningful.
      if (this.enableBigrams && this.recentTrajectory.length >= 3) {
        const prev2 = this.recentTrajectory[this.recentTrajectory.length - 3];
        const bigramFrom = `${prev2}\u2192${from}`;
        const bigramTo = `${from}\u2192${state}`;
        // Only record bigrams when the unigram from-state is well-established
        if (this.graph.rowTotal(from) >= this.bigramFrequencyThreshold) {
          this.graph.incrementTransition(bigramFrom, bigramTo);
        }
      }

      // Mark dirty: new transition was added
      this.isDirty = true;

      this.evaluateEntropy(state);
      this.evaluateTrajectory(from, state);
    } else if (isNewToBloom) {
      // Mark dirty: Bloom filter was updated with a new state
      this.isDirty = true;
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
    this.previousStateEnteredAt = 0;
  }

  exportGraph(): SerializedMarkovGraph {
    return this.graph.toJSON();
  }

  flushNow(): void {
    if (this.persistTimer !== null) {
      this.timer.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  /**
   * Tear down the manager: flush any pending state to storage,
   * cancel the debounce timer, and remove all event listeners.
   *
   * Call this in SPA cleanup paths (React `useEffect` teardown,
   * Vue `onUnmounted`, Angular `ngOnDestroy`) to prevent memory
   * leaks from retained listener references.
   *
   * After `destroy()` the instance should be discarded.
   */
  destroy(): void {
    this.flushNow();
    this.emitter.removeAll();
  }

  /**
   * Returns a GDPR-compliant telemetry snapshot for the current session.
   *
   * All fields are aggregate counters or derived status flags.
   * No raw behavioral data, no state labels, and no user-identifying
   * information is included. Safe to send to your own analytics endpoint
   * without triggering GDPR personal-data obligations.
   *
   * ```ts
   * const t = intent.getTelemetry();
   * // { sessionId: 'a1b2...', transitionsEvaluated: 42, botStatus: 'human',
   * //   anomaliesFired: 3, engineHealth: 'healthy' }
   * ```
   */
  getTelemetry(): EdgeSignalTelemetry {
    return {
      sessionId: this.sessionId,
      transitionsEvaluated: this.transitionsEvaluated,
      botStatus: this.isSuspectedBot ? 'suspected_bot' : 'human',
      anomaliesFired: this.anomaliesFired,
      engineHealth: this.engineHealth,
    };
  }

  /**
   * Record a conversion event and emit it through the event bus.
   *
   * Use this to measure the ROI of intent-driven interventions (e.g.
   * whether a hesitation discount actually led to a purchase).
   *
   * ```ts
   * intent.on('conversion', ({ type, value, currency }) => {
   *   // All local — log to your own backend if needed
   *   console.log(`Conversion: ${type} ${value} ${currency}`);
   * });
   *
   * // After a purchase completes:
   * intent.trackConversion({ type: 'purchase', value: 49.99, currency: 'USD' });
   * ```
   *
   * **Privacy note:** `type` must not contain user identifiers.
   * This event never leaves the device unless your `conversion` listener
   * explicitly sends it — which remains entirely under your control.
   */
  trackConversion(payload: ConversionPayload): void {
    this.emitter.emit('conversion', payload);
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

    // EntropyGuard: silently skip for suspected bots
    if (this.isSuspectedBot) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    // Skip if there are fewer than MIN_SAMPLE_TRANSITIONS outgoing transitions (too small a sample).
    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) {
      this.benchmark.record('entropyComputation', start);
      return;
    }

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);

    if (normalizedEntropy >= this.graph.highEntropyThreshold) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.high_entropy >= this.eventCooldownMs) {
        this.lastEmittedAt.high_entropy = now;
        this.anomaliesFired += 1;
        this.emitter.emit('high_entropy', {
          state,
          entropy,
          normalizedEntropy,
        });
      }
    }

    this.benchmark.record('entropyComputation', start);
  }

  private evaluateTrajectory(from: string, to: string): void {
    const start = this.benchmark.now();

    // EntropyGuard: silently skip for suspected bots
    if (this.isSuspectedBot) {
      this.benchmark.record('divergenceComputation', start);
      return;
    }

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
    // "real"     = how likely this sequence is under the *live* (learned) graph.
    // "expected" = how likely it would be under the *baseline* reference graph.
    // These two values are the meaningful comparison exposed in the event payload.
    const real = MarkovGraph.logLikelihoodTrajectory(
      this.graph,
      this.recentTrajectory,
      SMOOTHING_EPSILON,
    );
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

    // ⚠  KNOWN LIMITATION (v1 — accepted for initial release):
    //    At very low noise deltas (Δε ≤ 0.05, entropy difference < 0.05 nats)
    //    the z-score distributions of normal and anomalous sessions overlap
    //    substantially, yielding AUC ≈ 0.74 at the best operating point.
    //    This is a *fundamental signal constraint*, not a tuning problem:
    //    no post-processing layer (CUSUM, EWMA, confirmation counter) on top
    //    of a 32-step single-window average log-likelihood can fully separate
    //    distributions that close without either:
    //      a) a significantly longer observation horizon (> 32 steps), or
    //      b) richer feature space beyond marginal transition probabilities
    //         (e.g. dwell-time, click-velocity, inter-event interval entropy).
    //    Revisit when:  longer trajectory windows are viable, or when timing
    //    side-channels (EntropyGuard deltas) can be folded into the score.

    if (shouldEmit) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.trajectory_anomaly >= this.eventCooldownMs) {
        this.lastEmittedAt.trajectory_anomaly = now;
        this.anomaliesFired += 1;
        this.emitter.emit('trajectory_anomaly', {
          stateFrom: from,
          stateTo: to,
          realLogLikelihood: real,
          expectedBaselineLogLikelihood: expected,
          zScore,
        });
        this.lastTrajectoryAnomalyAt = now;
        this.lastTrajectoryAnomalyZScore = zScore;
        this.maybeEmitHesitation();
      }
    }

    this.benchmark.record('divergenceComputation', start);
  }

  /* ================================================================== */
  /*  Dwell-Time Anomaly Detection                                       */
  /* ================================================================== */

  /**
   * Evaluate dwell time on the *previous* state using Welford's online
   * algorithm to maintain running mean and variance.  Fires a
   * `dwell_time_anomaly` event when the z-score exceeds the configured
   * threshold and enough samples have been collected.
   *
   * All computation is O(1) per call — no arrays or sorting.
   */
  private evaluateDwellTime(state: string, dwellMs: number): void {
    // Ignore non-positive dwell times (first track, or clock issues)
    if (dwellMs <= 0) return;

    // Retrieve or initialise the Welford accumulator: [count, mean, m2]
    let stats = this.dwellStats.get(state);
    if (!stats) {
      stats = [0, 0, 0];
      this.dwellStats.set(state, stats);
    }

    // Welford online update
    stats[0] += 1;                            // count
    const delta = dwellMs - stats[1];
    stats[1] += delta / stats[0];             // mean
    const delta2 = dwellMs - stats[1];
    stats[2] += delta * delta2;               // m2

    // Need enough samples for a meaningful standard deviation
    if (stats[0] < this.dwellTimeMinSamples) return;

    const variance = stats[2] / stats[0];     // population variance
    const std = Math.sqrt(variance);

    // Guard: if std is zero (all identical dwell times) skip
    if (std <= 0) return;

    const zScore = (dwellMs - stats[1]) / std;

    if (Math.abs(zScore) >= this.dwellTimeZScoreThreshold) {
      const now = this.timer.now();
      if (this.eventCooldownMs <= 0 || now - this.lastEmittedAt.dwell_time_anomaly >= this.eventCooldownMs) {
        this.lastEmittedAt.dwell_time_anomaly = now;
        this.anomaliesFired += 1;
        this.emitter.emit('dwell_time_anomaly', {
          state,
          dwellMs,
          meanMs: stats[1],
          stdMs: std,
          zScore,
        });
        // Only lingering (positive z-score) contributes to hesitation.
        if (zScore > 0) {
          this.lastDwellAnomalyAt = now;
          this.lastDwellAnomalyZScore = zScore;
          this.lastDwellAnomalyState = state;
          this.maybeEmitHesitation();
        }
      }
    }
  }

  /**
   * Emit `hesitation_detected` when a `trajectory_anomaly` and a positive
   * `dwell_time_anomaly` have both fired within `hesitationCorrelationWindowMs`.
   * Called from both evaluateTrajectory and evaluateDwellTime after they update
   * their respective timestamps.
   *
   * `hesitation_detected.state` is always the dwell-anomaly state (where the user
   * lingered), regardless of which signal fires second.  This is consistent with
   * the interface docs and avoids the caller-provided value varying between the
   * two call sites.
   */
  private maybeEmitHesitation(): void {
    const now = this.timer.now();
    const correlated =
      now - this.lastTrajectoryAnomalyAt < this.hesitationCorrelationWindowMs &&
      now - this.lastDwellAnomalyAt < this.hesitationCorrelationWindowMs;

    if (!correlated) return;

    // Reset timestamps to prevent re-triggering until both signals fire again.
    this.lastTrajectoryAnomalyAt = -Infinity;
    this.lastDwellAnomalyAt = -Infinity;

    this.emitter.emit('hesitation_detected', {
      state: this.lastDwellAnomalyState,
      trajectoryZScore: this.lastTrajectoryAnomalyZScore,
      dwellZScore: this.lastDwellAnomalyZScore,
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      this.timer.clearTimeout(this.persistTimer);
    }

    this.persistTimer = this.timer.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, this.persistDebounceMs);
  }

  private persist(): void {
    // Dirty-flag optimization: skip persistence if nothing changed
    if (!this.isDirty) {
      return;
    }

    // LFU prune before serializing — keeps storage bounded.
    // Wrap in try-finally so engineHealth is always restored even if prune() throws.
    this.engineHealth = 'pruning_active';
    try {
      this.graph.prune();
    } finally {
      this.engineHealth = 'healthy';
    }

    // Binary-encode the graph: avoids JSON.stringify on potentially
    // large objects, keeping the main thread free of heavy work.
    const graphBytes = this.graph.toBinary();

    // Convert Uint8Array → base64 string for localStorage compatibility.
    // Uses chunked String.fromCharCode to avoid O(n) string concatenation.
    const graphBinary = uint8ToBase64(graphBytes);

    // Build the minimal JSON envelope (two short strings, no deep trees).
    const payload: PersistedPayload = {
      bloomBase64: this.bloom.toBase64(),
      graphBinary,
    };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(payload));
      // Reset dirty flag after successful save
      this.isDirty = false;
    } catch (err) {
      // QuotaExceededError, SecurityError, or Private Browsing restrictions.
      // Surface through the optional error callback; never crash the main thread.
      if (err instanceof Error) {
        if (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota')) {
          this.engineHealth = 'quota_exceeded';
        }
        if (this.onError) {
          this.onError(err);
        }
      }
    }
  }

  /* ================================================================== */
  /*  EntropyGuard: Bot Detection                                        */
  /* ================================================================== */

  /**
   * Record a track() timestamp and evaluate for bot-like patterns.
   * Uses a fixed-size circular buffer to avoid allocations in the hot path.
   */
  private recordTrackTimestamp(timestamp: number, state: string): void {
    // Store timestamp in circular buffer
    this.trackTimestamps[this.trackTimestampIndex] = timestamp;
    this.trackTimestampIndex = (this.trackTimestampIndex + 1) % BOT_DETECTION_WINDOW;
    if (this.trackTimestampCount < BOT_DETECTION_WINDOW) {
      this.trackTimestampCount++;
    }

    // Need at least 2 timestamps to calculate a delta
    if (this.trackTimestampCount < 2) {
      return;
    }

    // Always re-evaluate: the sliding window naturally decays old bot signals
    // as new human-like timestamps fill the buffer, allowing recovery from
    // false positives (e.g. a fast-navigating-then-slowing-down user).
    this.evaluateBotPatterns(state);
  }

  /**
   * Evaluate timing patterns for bot-like behavior using a pure
   * sliding-window score computed fresh from the current circular buffer.
   *
   * Because the score is recalculated on every call rather than accumulated
   * into a permanent counter, old bot-like timestamps naturally age out as
   * new human-paced interactions fill the buffer.  This prevents false
   * positives from permanently silencing events for users who navigate
   * quickly at first and then slow to normal browsing speed.
   */
  private evaluateBotPatterns(state: string): void {
    const count = this.trackTimestampCount;
    if (count < 2) return;

    // ── Compute a fresh window score from the current buffer contents ──
    let windowBotScore = 0;
    let mean = 0;
    let m2 = 0;
    let deltaCount = 0;

    // Oldest entry in chronological order.
    const oldestIndex = count < BOT_DETECTION_WINDOW
      ? 0
      : this.trackTimestampIndex; // wraps around when buffer is full

    for (let i = 0; i < count - 1; i++) {
      const currIdx = (oldestIndex + i) % BOT_DETECTION_WINDOW;
      const nextIdx = (oldestIndex + i + 1) % BOT_DETECTION_WINDOW;
      const delta = this.trackTimestamps[nextIdx] - this.trackTimestamps[currIdx];

      // Each impossibly-fast delta scores 1 point.
      if (delta >= 0 && delta < BOT_MIN_DELTA_MS) {
        windowBotScore++;
      }

      // Accumulate for variance calculation (only positive deltas).
      // Using Welford's online algorithm for numerical stability.
      if (delta > 0) {
        deltaCount++;
        const deltaFromMean = delta - mean;
        mean += deltaFromMean / deltaCount;
        const deltaFromNewMean = delta - mean;
        m2 += deltaFromMean * deltaFromNewMean;
      }
    }

    // Robotic (extremely low variance) timing scores 1 additional point.
    // Variance = M2 / N (population variance)
    if (deltaCount >= 3) {
      const variance = m2 / deltaCount;
      if (variance >= 0 && variance < BOT_MAX_VARIANCE) {
        windowBotScore++;
      }
    }

    // Window-bounded decision: flag OR recover based solely on recent behavior.
    // As human-paced calls replace fast ones in the circular buffer the score
    // drops automatically, clearing the flag without any explicit timer.
    const wasSuspected = this.isSuspectedBot;
    this.isSuspectedBot = windowBotScore >= BOT_SCORE_THRESHOLD;

    // Emit bot_detected only on the false → true transition to avoid flooding.
    if (this.isSuspectedBot && !wasSuspected) {
      this.emitter.emit('bot_detected', { state });
    }
  }

  private restore(graphConfig: MarkovGraphConfig): { bloom: BloomFilter; graph: MarkovGraph } | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as PersistedPayload;
      if (!parsed.graphBinary) return null;

      const bloom = BloomFilter.fromBase64(parsed.bloomBase64);
      const binaryStr = atob(parsed.graphBinary);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i += 1) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const graph = MarkovGraph.fromBinary(bytes, graphConfig);

      return { bloom, graph };
    } catch {
      return null;
    }
  }
}
