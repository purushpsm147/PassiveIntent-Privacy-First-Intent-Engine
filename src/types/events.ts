/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { BenchmarkConfig } from '../performance-instrumentation.js';
import type { SerializedMarkovGraph } from '../core/markov.js';
import type { StorageAdapter, TimerAdapter } from '../adapters.js';

export type IntentEventName =
  | 'high_entropy'
  | 'trajectory_anomaly'
  | 'state_change'
  | 'dwell_time_anomaly'
  | 'conversion'
  | 'bot_detected'
  | 'hesitation_detected';

export interface ConversionPayload {
  type: string;
  value?: number;
  currency?: string;
}

export interface EdgeSignalTelemetry {
  sessionId: string;
  transitionsEvaluated: number;
  botStatus: 'human' | 'suspected_bot';
  anomaliesFired: number;
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
  state: string;
  dwellMs: number;
  meanMs: number;
  stdMs: number;
  zScore: number;
}

export interface BotDetectedPayload {
  state: string;
}

export interface HesitationDetectedPayload {
  state: string;
  trajectoryZScore: number;
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
  enabled?: boolean;
  minSamples?: number;
  zScoreThreshold?: number;
}

export interface BloomFilterConfig {
  bitSize?: number;
  hashCount?: number;
}

export interface MarkovGraphConfig {
  /** Normalized entropy threshold [0, 1] above which `high_entropy` fires. Default: 0.75. */
  highEntropyThreshold?: number;
  /**
   * Z-score (or raw average log-likelihood) threshold for `trajectory_anomaly`.
   * Interpreted as a *magnitude*: the sign is forced negative internally so
   * that a lower (more anomalous) value triggers the event.
   * Default: 3.5.  Decrease to increase sensitivity; increase to reduce noise.
   */
  divergenceThreshold?: number;
  /**
   * Pre-computed mean of average per-step log-likelihood over a representative
   * set of *normal* sessions.  Required together with `baselineStdLL` to enable
   * Z-score calibration.  When absent, the raw `divergenceThreshold` is used instead.
   *
   * Can also be supplied as `IntentManagerConfig.baselineMeanLL` (the top-level
   * convenience alias).  If both are provided, **the top-level alias takes
   * precedence** — see `IntentManagerConfig.baselineMeanLL` for details.
   */
  baselineMeanLL?: number;
  /**
   * Pre-computed standard deviation of average per-step log-likelihood over
   * normal sessions.  Pair with `baselineMeanLL`.
   *
   * Can also be supplied as `IntentManagerConfig.baselineStdLL` (the top-level
   * convenience alias).  If both are provided, **the top-level alias takes
   * precedence** — see `IntentManagerConfig.baselineStdLL` for details.
   */
  baselineStdLL?: number;
  /** Laplace smoothing probability applied to unseen transitions. Default: 0.01. */
  smoothingEpsilon?: number;
  /**
   * Maximum number of live states before LFU pruning is triggered.
   * Higher values give better recall at the cost of more memory and larger
   * serialized payloads.  Default: 500.
   */
  maxStates?: number;
}

export interface IntentManagerConfig {
  bloom?: BloomFilterConfig;
  graph?: MarkovGraphConfig;
  /**
   * Convenience alias for `graph.baselineMeanLL`.
   *
   * **Precedence:** when this top-level field and `graph.baselineMeanLL` are
   * both set, _this field wins_.  The constructor merges them as:
   * ```ts
   * baselineMeanLL: config.baselineMeanLL ?? config.graph?.baselineMeanLL
   * ```
   * Rationale: this alias was added so callers that derive the statistics
   * externally (e.g. from a calibration script) can pass them flat rather
   * than constructing a nested `graph` object.  Both paths are intentionally
   * supported for backward compatibility — do not remove either.
   */
  baselineMeanLL?: number;
  /**
   * Convenience alias for `graph.baselineStdLL`.
   *
   * **Precedence:** when this top-level field and `graph.baselineStdLL` are
   * both set, _this field wins_ (same merge rule as `baselineMeanLL` above).
   */
  baselineStdLL?: number;
  /** localStorage key used to persist the Bloom filter and Markov graph. Default: `'edge-signal'`. */
  storageKey?: string;
  /** Debounce delay in ms before writing to storage after a `track()` call. Default: 2000. */
  persistDebounceMs?: number;
  /**
   * Pre-trained baseline graph (from `MarkovGraph.toJSON()`) representing
   * the expected normal navigation pattern.  Required for `trajectory_anomaly`
   * detection.  If absent, trajectory evaluation is skipped.
   */
  baseline?: SerializedMarkovGraph;
  benchmark?: BenchmarkConfig;
  /** Override the storage backend (useful for tests or custom persistence layers). */
  storage?: StorageAdapter;
  /** Override the timer backend (useful for deterministic tests). */
  timer?: TimerAdapter;
  /** Non-fatal error callback — surfaces storage errors and invalid `track('')` calls. */
  onError?: (err: Error) => void;
  /** Enable heuristic bot detection via timing analysis. Default: `true`. */
  botProtection?: boolean;
  /**
   * Minimum milliseconds between consecutive emissions of the same cooldown-gated
   * event type (`high_entropy`, `trajectory_anomaly`, `dwell_time_anomaly`).
   * 0 disables throttling (every qualifying call fires). Default: 0.
   */
  eventCooldownMs?: number;
  /**
   * Maximum gap (ms) between a `trajectory_anomaly` and a `dwell_time_anomaly`
   * for them to be correlated into a `hesitation_detected` event. Default: 30 000.
   */
  hesitationCorrelationWindowMs?: number;
  dwellTime?: DwellTimeConfig;
  /**
   * Enable second-order (bigram) Markov transitions.
   * Bigram states are encoded as `"prev→from"` → `"from→to"` using U+2192
   * as a separator chosen to be collision-resistant against normal state labels.
   * Requires more memory; useful when single-step transitions are not
   * discriminative enough for the application’s navigation graph.
   */
  enableBigrams?: boolean;
  /**
   * Minimum number of outgoing transitions a unigram state must have before
   * bigram transitions are recorded for it.  Guards against sparse bigram
   * pollution in the early learning phase.  Default: 5.
   */
  bigramFrequencyThreshold?: number;
}
