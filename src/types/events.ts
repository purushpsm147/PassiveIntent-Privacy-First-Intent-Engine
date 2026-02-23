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
  highEntropyThreshold?: number;
  divergenceThreshold?: number;
  baselineMeanLL?: number;
  baselineStdLL?: number;
  smoothingEpsilon?: number;
  maxStates?: number;
}

export interface IntentManagerConfig {
  bloom?: BloomFilterConfig;
  graph?: MarkovGraphConfig;
  baselineMeanLL?: number;
  baselineStdLL?: number;
  storageKey?: string;
  persistDebounceMs?: number;
  baseline?: SerializedMarkovGraph;
  benchmark?: BenchmarkConfig;
  storage?: StorageAdapter;
  timer?: TimerAdapter;
  onError?: (err: Error) => void;
  botProtection?: boolean;
  eventCooldownMs?: number;
  hesitationCorrelationWindowMs?: number;
  dwellTime?: DwellTimeConfig;
  enableBigrams?: boolean;
  bigramFrequencyThreshold?: number;
}
