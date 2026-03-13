/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * ContinuousGraphModel — web plugin for IStateModel
 * --------------------------------------------------------
 * Implements IStateModel for standard web routing by composing the existing
 * `MarkovGraph` (transition modeling + signal evaluation) and `BloomFilter`
 * (state membership) primitives.
 *
 * Evaluation logic mirrors `SignalEngine` exactly — same constants, same
 * z-score formula, same calibration path — so ContinuousGraphModel + IntentEngine
 * produce numerically identical signals to IntentManager when configured
 * identically.
 *
 * Serialization format (JSON string):
 * ```json
 * { "bloomBase64": "<base64>", "graphBinary": "<base64>" }
 * ```
 * Matches the wire format used by `PersistenceCoordinator` / `SyncPersistStrategy`
 * so payloads are compatible with existing persisted data.
 *
 * Configuration:
 * ```ts
 * const model = new ContinuousGraphModel({
 *   graph:    { highEntropyThreshold: 0.75, divergenceThreshold: 3.5 },
 *   bloom:    { bitSize: 2048, hashCount: 4 },
 *   baseline: exportedGraph, // from IntentManager.exportGraph()
 * });
 * ```
 */

import { MarkovGraph } from '../../core/markov.js';
import { BloomFilter } from '../../core/bloom.js';
import { uint8ToBase64, base64ToUint8 } from '../../persistence/codec.js';
import type { IStateModel, EntropyResult, TrajectoryResult } from '../../types/microkernel.js';
import type { MarkovGraphConfig, BloomFilterConfig } from '../../types/events.js';
import type { SerializedMarkovGraph } from '../../core/markov.js';
import {
  MIN_SAMPLE_TRANSITIONS,
  MIN_WINDOW_LENGTH,
  MAX_WINDOW_LENGTH,
  SMOOTHING_EPSILON,
} from '../../engine/constants.js';

export interface ContinuousGraphModelConfig {
  /**
   * Markov graph tuning: entropy threshold, divergence threshold, smoothing, etc.
   * Defaults match IntentManager's defaults.
   */
  graph?: MarkovGraphConfig;
  /** Bloom filter sizing. Default: bitSize=2048, hashCount=4. */
  bloom?: BloomFilterConfig;
  /**
   * Optional pre-trained baseline graph (from `IntentManager.exportGraph()` or
   * `MarkovGraph.toJSON()`).  Required for `trajectory_anomaly` detection — when
   * absent, `evaluateTrajectory()` always returns `null`.
   */
  baseline?: SerializedMarkovGraph;
}

/** Wire format stored by `serialize()` / parsed by `restore()`. */
interface PersistedPayload {
  bloomBase64: string;
  graphBinary: string;
}

export class ContinuousGraphModel implements IStateModel {
  private graph: MarkovGraph;
  private bloom: BloomFilter;
  private readonly baseline: MarkovGraph | null;
  private readonly graphConfig: MarkovGraphConfig;
  private readonly bloomConfig: BloomFilterConfig;

  constructor(config: ContinuousGraphModelConfig = {}) {
    this.graphConfig = config.graph ?? {};
    this.bloomConfig = config.bloom ?? {};
    this.graph = new MarkovGraph(this.graphConfig);
    this.bloom = new BloomFilter(this.bloomConfig);
    this.baseline = config.baseline
      ? MarkovGraph.fromJSON(config.baseline, this.graphConfig)
      : null;
  }

  /* ================================================================= */
  /*  IStateModel — membership                                           */
  /* ================================================================= */

  markSeen(state: string): void {
    this.bloom.add(state);
  }

  hasSeen(state: string): boolean {
    return this.bloom.check(state);
  }

  /* ================================================================= */
  /*  IStateModel — transitions                                          */
  /* ================================================================= */

  recordTransition(from: string, to: string): void {
    this.graph.incrementTransition(from, to);
  }

  getLikelyNext(state: string, threshold: number): { state: string; probability: number }[] {
    return this.graph.getLikelyNextStates(state, threshold);
  }

  /* ================================================================= */
  /*  IStateModel — signal evaluation                                    */
  /* ================================================================= */

  /**
   * Evaluate whether the current state's outgoing entropy is anomalously high.
   *
   * Guards:
   *   - Fewer than `MIN_SAMPLE_TRANSITIONS` outgoing edges → not enough data.
   *
   * Mirrors `SignalEngine.evaluateEntropy()`.
   */
  evaluateEntropy(state: string): EntropyResult {
    const NOT_HIGH: EntropyResult = { entropy: 0, normalizedEntropy: 0, isHigh: false };

    if (this.graph.rowTotal(state) < MIN_SAMPLE_TRANSITIONS) {
      return NOT_HIGH;
    }

    const entropy = this.graph.entropyForState(state);
    const normalizedEntropy = this.graph.normalizedEntropyForState(state);
    const isHigh = normalizedEntropy >= this.graph.highEntropyThreshold;

    return { entropy, normalizedEntropy, isHigh };
  }

  /**
   * Evaluate whether the `from → to` transition is anomalous relative to the
   * baseline distribution.
   *
   * Guards:
   *   - No baseline configured → `null`.
   *   - Trajectory shorter than `MIN_WINDOW_LENGTH` → `null` (warm-up phase).
   *
   * When `baselineMeanLL` + `baselineStdLL` are configured on the graph, uses
   * z-score comparison.  Otherwise falls back to raw average LL threshold.
   *
   * Mirrors `SignalEngine.evaluateTrajectory()`.
   */
  evaluateTrajectory(
    from: string,
    _to: string,
    trajectory: readonly string[],
  ): TrajectoryResult | null {
    if (this.baseline === null) return null;
    if (trajectory.length < MIN_WINDOW_LENGTH) return null;

    const real = MarkovGraph.logLikelihoodTrajectory(this.graph, trajectory, SMOOTHING_EPSILON);
    const expected = MarkovGraph.logLikelihoodTrajectory(
      this.baseline,
      trajectory,
      SMOOTHING_EPSILON,
    );

    const N = Math.max(1, trajectory.length - 1);
    const expectedAvg = expected / N;
    const threshold = -Math.abs(this.graph.divergenceThreshold);

    const hasCalibratedBaseline =
      typeof this.graph.baselineMeanLL === 'number' &&
      typeof this.graph.baselineStdLL === 'number' &&
      Number.isFinite(this.graph.baselineMeanLL) &&
      Number.isFinite(this.graph.baselineStdLL) &&
      this.graph.baselineStdLL > 0;

    const adjustedStd = hasCalibratedBaseline
      ? this.graph.baselineStdLL! * Math.sqrt(MAX_WINDOW_LENGTH / N)
      : 0;

    const zScore = hasCalibratedBaseline
      ? (expectedAvg - this.graph.baselineMeanLL!) / adjustedStd
      : expectedAvg;

    const isAnomalous = hasCalibratedBaseline ? zScore <= threshold : expectedAvg <= threshold;

    return {
      zScore,
      isAnomalous,
      logLikelihood: real,
      baselineLogLikelihood: expected,
      sampleSize: this.graph.rowTotal(from),
    };
  }

  /* ================================================================= */
  /*  IStateModel — serialization                                        */
  /* ================================================================= */

  /**
   * Serialize the live Markov graph and Bloom filter to a JSON string.
   *
   * Wire format matches `SyncPersistStrategy` so payloads written by
   * `IntentManager` / `PersistenceCoordinator` can be loaded here, and
   * vice versa.
   */
  serialize(): string {
    this.graph.prune();
    const graphBinary = uint8ToBase64(this.graph.toBinary());
    const bloomBase64 = this.bloom.toBase64();
    const payload: PersistedPayload = { bloomBase64, graphBinary };
    return JSON.stringify(payload);
  }

  /**
   * Restore the Markov graph and Bloom filter from a previously serialized string.
   * Throws on parse failure so `IntentEngine` can surface it through `onError`.
   */
  restore(serialized: string): void {
    const payload = JSON.parse(serialized) as Partial<PersistedPayload>;

    if (payload.graphBinary) {
      this.graph = MarkovGraph.fromBinary(base64ToUint8(payload.graphBinary), this.graphConfig);
    }

    if (payload.bloomBase64) {
      this.bloom = BloomFilter.fromBase64(payload.bloomBase64, this.bloomConfig);
    }
  }
}
