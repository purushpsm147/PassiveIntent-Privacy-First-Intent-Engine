/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { MarkovGraphConfig } from '../types/events.js';

/**
 * Map probability [0, 1] to an 8-bit integer [0, 255].
 *
 * Only used by `getQuantizedRow` / `getQuantizedProbability` for
 * memory-compact exports (e.g. sending probability vectors over postMessage).
 * The *canonical* hot-path (`getProbability`) always works with raw floats
 * from live counts to avoid quantization error accumulation.
 */
function quantizeProbability(probability: number): number {
  if (probability <= 0) return 0;
  if (probability >= 1) return 255;
  return Math.round(probability * 255) & 0xff;
}

/** Inverse of `quantizeProbability`. */
function dequantizeProbability(value: number): number {
  return (value & 0xff) / 255;
}

/**
 * Outgoing transition counts for a single source state.
 *
 * Using a nested `Map<number, number>` keeps the representation sparse:
 * states that never transition to each other consume no memory.  For typical
 * navigation graphs (5–50 states, fan-out 2–8) this is cheaper than a dense
 * N×N matrix and avoids serializing zero entries in the binary codec.
 */
interface TransitionRow {
  /** Sum of all outgoing transition counts from this state. Pre-maintained to avoid O(k) map iteration on every probability query. */
  total: number;
  /** Destination state index → raw observation count. */
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
 * Sparse Markov graph for first-order (and optional second-order bigram) state transitions.
 *
 * **Index stability design:**
 * States are assigned an integer index on first encounter and that index
 * is never re-numbered.  This makes the binary codec trivially verifiable
 * (indices in the encoded rows map directly to the states array) and means
 * serialized data stays valid even after LFU pruning, because pruned slots
 * are *tombstoned* (set to `''`) rather than compacted.
 *
 * **Sparse Map representation:**
 * `rows` is a `Map<fromIndex, TransitionRow>` rather than a flat array.
 * Navigation graphs are typically sparse (most state pairs are never
 * observed), so flat N×N matrices would waste memory and inflate encoded size.
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
  /**
   * Dirichlet / Laplace smoothing pseudo-count.
   * When > 0, `getProbability` uses:
   *   P = (count + alpha) / (total + alpha * k)
   * where k = number of live states.  When 0, falls back to exact
   * frequentist math (count / total) with zero extra cost.
   *
   * **Default: `0.1`** — mild Bayesian regularization that prevents
   * cold-start 100 % probability spikes on Day-1 sessions.
   * Pass `0` explicitly to restore pure frequentist behaviour.
   *
   * Non-finite or negative values are clamped to `0` by the constructor.
   */
  readonly smoothingAlpha: number;

  constructor(config: MarkovGraphConfig = {}) {
    this.highEntropyThreshold = config.highEntropyThreshold ?? 0.75;
    this.divergenceThreshold = Math.abs(config.divergenceThreshold ?? 3.5);
    this.smoothingEpsilon = config.smoothingEpsilon ?? 0.01;
    this.baselineMeanLL = config.baselineMeanLL;
    this.baselineStdLL = config.baselineStdLL;
    this.maxStates = config.maxStates ?? 500;
    const rawSmoothingAlpha = config.smoothingAlpha ?? 0.1;
    this.smoothingAlpha =
      Number.isFinite(rawSmoothingAlpha) && rawSmoothingAlpha >= 0 ? rawSmoothingAlpha : 0;
  }

  /**
   * Return the integer index for a state label, allocating a new slot if
   * needed.  Reuses tombstoned (freed) slots from LFU pruning before
   * appending to the end of `indexToState`, keeping the array compact.
   *
   * Empty string is rejected because `''` is the internal tombstone marker.
   */
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
   * P(to|from) from live counts, with optional Bayesian Laplace smoothing.
   *
   * When `smoothingAlpha > 0`:
   *   P = (count + α) / (total + α × k)
   * where k = live-state count (`stateToIndex.size`).
   * α = 0 falls back to exact frequentist math with no overhead.
   *
   * No allocations are made during this call.
   */
  getProbability(fromState: string, toState: string): number {
    const from = this.stateToIndex.get(fromState);
    const to = this.stateToIndex.get(toState);
    if (from === undefined || to === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0) return 0;

    const count = row.toCounts.get(to) ?? 0;
    if (this.smoothingAlpha === 0) {
      return count / row.total;
    }
    return (
      (count + this.smoothingAlpha) / (row.total + this.smoothingAlpha * this.stateToIndex.size)
    );
  }

  /**
   * Entropy H(i) = -Σ P(i->j) log P(i->j)
   * Returned entropy is in nats (natural log).
   *
   * When `smoothingAlpha > 0`, smoothed probabilities are used for ALL k
   * states (observed + unobserved).  The contribution from the
   * `(k - observed)` unobserved transitions is computed analytically —
   * no temporary arrays are allocated.
   */
  entropyForState(state: string): number {
    const from = this.stateToIndex.get(state);
    if (from === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0) return 0;

    let entropy = 0;
    if (this.smoothingAlpha === 0) {
      row.toCounts.forEach((count) => {
        const p = count / row.total;
        if (p > 0) entropy -= p * Math.log(p);
      });
    } else {
      const k = this.stateToIndex.size;
      const denominator = row.total + this.smoothingAlpha * k;

      // Observed transitions
      row.toCounts.forEach((count) => {
        const p = (count + this.smoothingAlpha) / denominator;
        entropy -= p * Math.log(p);
      });

      // Unobserved transitions — computed analytically to avoid allocation
      const numUnobserved = k - row.toCounts.size;
      if (numUnobserved > 0) {
        const pUnobserved = this.smoothingAlpha / denominator;
        if (pUnobserved > 0) {
          entropy -= numUnobserved * pUnobserved * Math.log(pUnobserved);
        }
      }
    }
    return entropy;
  }

  /**
   * Normalized entropy in [0..1], dividing by max entropy ln(k)
   * where k is the support size of the probability distribution.
   *
   * - Frequentist mode (`smoothingAlpha = 0`): k = observed outgoing edges.
   * - Bayesian mode (`smoothingAlpha > 0`): k = live-state count, because
   *   unobserved transitions receive non-zero mass.
   */
  normalizedEntropyForState(state: string): number {
    const from = this.stateToIndex.get(state);
    if (from === undefined) return 0;

    const row = this.rows.get(from);
    if (!row || row.total === 0) return 0;

    const supportSize = this.smoothingAlpha > 0 ? this.stateToIndex.size : row.toCounts.size;
    if (supportSize <= 1) return 0;

    const entropy = this.entropyForState(state);
    const maxEntropy = Math.log(supportSize);
    if (maxEntropy <= 0) return 0;

    // Bound to [0, 1] to preserve the documented normalized-entropy contract.
    const normalized = entropy / maxEntropy;
    return Math.min(1, Math.max(0, normalized));
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
    sequence: readonly string[],
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
   * Returns all outgoing edges from `fromState` whose transition probability
   * meets or exceeds `minProbability`, sorted descending by probability.
   *
   * Intended for **read-only** UI prefetching hints.  The returned state
   * labels are raw values from the internal transition graph and may include
   * sensitive routes.
   *
   * ⚠ **Security notice — you MUST filter results before acting on them.**
   * Always pass a `sanitize` predicate (see `IntentManager.predictNextStates`)
   * that rejects state-mutating or privacy-sensitive routes such as
   * `/logout`, `/checkout/pay`, or any route containing PII.
   * Prefetching must **never** trigger state-mutating side effects.
   *
   * @param fromState     The source state to query outgoing transitions from.
   * @param minProbability Minimum probability threshold in [0, 1] (inclusive).
   *                       Values ≤ 0 return all edges; values > 1 return none.
   * @returns Array of `{ state, probability }` objects, sorted by probability
   *          descending.  Returns an empty array when the state is unknown or
   *          has no recorded transitions.
   */
  getLikelyNextStates(
    fromState: string,
    minProbability: number,
  ): { state: string; probability: number }[] {
    const fromIndex = this.stateToIndex.get(fromState);
    if (fromIndex === undefined) return [];

    const row = this.rows.get(fromIndex);
    if (!row || row.total === 0) return [];

    const results: { state: string; probability: number }[] = [];
    // Pre-compute smoothing denominator once — O(1), no allocation.
    const denominator =
      this.smoothingAlpha === 0
        ? row.total
        : row.total + this.smoothingAlpha * this.stateToIndex.size;

    row.toCounts.forEach((count, toIndex) => {
      const probability =
        this.smoothingAlpha === 0
          ? count / denominator
          : (count + this.smoothingAlpha) / denominator;
      if (probability >= minProbability) {
        const label = this.indexToState[toIndex];
        if (label && label !== '') {
          results.push({ state: label, probability });
        }
      }
    });

    results.sort((a, b) => b.probability - a.probability);
    return results;
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

  /**
   * Total number of allocated index slots, including tombstoned (freed) ones.
   *
   * ⚠ This is NOT the count of live states.  Use `stateToIndex.size`
   * (via `prune` or `fromJSON`) when you need the live count.
   * The value is useful for sizing serialization buffers.
   */
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
    const evictTarget = Math.max(
      1,
      Math.min(Math.ceil(liveCount * 0.2), liveCount - this.maxStates),
    );
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
      this.indexToState[idx] = ''; // dead slot
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
      totalSize += 8; // row header
      totalSize += row.toCounts.size * 6; // edges
    });

    // ── Allocate buffer + DataView ──
    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer);
    let offset = 0;

    // ── Write header ──

    // Byte 0: format version (0x02 — adds explicit freed-index list)
    view.setUint8(offset, 0x02); // version = 2
    offset += 1; // offset now 1

    // Bytes 1-2: number of states (Uint16 LE)
    view.setUint16(offset, this.indexToState.length, true);
    offset += 2; // offset now 3

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
