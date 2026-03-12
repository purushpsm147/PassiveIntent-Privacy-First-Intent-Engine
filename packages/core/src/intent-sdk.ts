/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PassiveIntent
 * --------------------------------------------------------
 * Goals:
 * - Entirely local inference (no network/data egress)
 * - Tiny footprint + predictable runtime
 * - Sparse + quantized storage for state transitions
 */

/**
 * Backward-compatible facade module.
 *
 * Core implementation has been split across domain modules:
 * - core/bloom
 * - core/markov
 * - engine/intent-manager
 * - types/events
 * - persistence/codec
 */

export { BloomFilter, computeBloomConfig } from './core/bloom.js';
export { MarkovGraph } from './core/markov.js';
export { IntentManager } from './engine/intent-manager.js';
export { BroadcastSync, MAX_STATE_LENGTH } from './sync/broadcast-sync.js';
export { normalizeRouteState } from './utils/route-normalizer.js';
export {
  ATTENTION_RETURN_THRESHOLD_MS,
  IDLE_CHECK_INTERVAL_MS,
  MAX_PLAUSIBLE_DWELL_MS,
  SMOOTHING_EPSILON,
  USER_IDLE_THRESHOLD_MS,
} from './engine/constants.js';
export { AnomalyDispatcher } from './engine/anomaly-dispatcher.js';
export { SignalEngine } from './engine/signal-engine.js';
export { EventEmitter } from './engine/event-emitter.js';
export { DriftProtectionPolicy } from './engine/policies/drift-protection-policy.js';
export { BenchmarkRecorder } from './performance-instrumentation.js';
export { PropensityCalculator } from './engine/propensity-calculator.js';

export type {
  AnomalyDispatcherConfig,
  AnomalyEventEmitter,
  DriftProtectionPolicyLike,
} from './engine/anomaly-dispatcher.js';
export type {
  AnomalyDecision,
  EntropyDecision,
  TrajectoryDecision,
  DwellDecision,
} from './engine/anomaly-decisions.js';
export type { SignalEngineConfig } from './engine/signal-engine.js';
export { BrowserLifecycleAdapter } from './adapters.js';

export type {
  IntentEventName,
  IntentEventMap,
  HighEntropyPayload,
  TrajectoryAnomalyPayload,
  DwellTimeAnomalyPayload,
  StateChangePayload,
  BotDetectedPayload,
  HesitationDetectedPayload,
  SessionStalePayload,
  AttentionReturnPayload,
  UserIdlePayload,
  UserResumedPayload,
  ExitIntentPayload,
  ConversionPayload,
  PassiveIntentTelemetry,
  BloomFilterConfig,
  MarkovGraphConfig,
  IntentManagerConfig,
  DwellTimeConfig,
  PassiveIntentError,
} from './types/events.js';

export type { SerializedMarkovGraph } from './core/markov.js';

export type {
  BenchmarkConfig,
  MemoryFootprintReport,
  OperationStats,
  PerformanceReport,
} from './performance-instrumentation.js';

export type { StorageAdapter, AsyncStorageAdapter, LifecycleAdapter } from './adapters.js';
