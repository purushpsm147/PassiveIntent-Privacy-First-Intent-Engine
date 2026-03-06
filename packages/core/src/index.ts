/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PassiveIntent — Public API Barrel Export
 * --------------------------------------------------------
 * Import everything you need from one clean entry-point:
 *
 *   import { IntentManager, BloomFilter, MarkovGraph } from '@passiveintent/core';
 */

/* ---- Core SDK ---- */
export {
  BloomFilter,
  computeBloomConfig,
  MarkovGraph,
  IntentManager,
  BroadcastSync,
  MAX_STATE_LENGTH,
  MAX_PLAUSIBLE_DWELL_MS,
  ATTENTION_RETURN_THRESHOLD_MS,
  USER_IDLE_THRESHOLD_MS,
  IDLE_CHECK_INTERVAL_MS,
  normalizeRouteState,
  AnomalyDispatcher,
  SignalEngine,
  EventEmitter,
  DriftProtectionPolicy,
  BenchmarkRecorder,
} from './intent-sdk.js';

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
  PassiveIntentError,
  DwellTimeConfig,
  SerializedMarkovGraph,
  AnomalyDecision,
  EntropyDecision,
  TrajectoryDecision,
  DwellDecision,
  AnomalyDispatcherConfig,
  AnomalyEventEmitter,
  DriftProtectionPolicyLike,
  SignalEngineConfig,
} from './intent-sdk.js';

/* ---- Adapters ---- */
export {
  BrowserStorageAdapter,
  BrowserTimerAdapter,
  MemoryStorageAdapter,
  BrowserLifecycleAdapter,
} from './adapters.js';

export type {
  StorageAdapter,
  AsyncStorageAdapter,
  TimerAdapter,
  TimerHandle,
  LifecycleAdapter,
} from './adapters.js';

/* ---- Performance Instrumentation ---- */
export type {
  BenchmarkConfig,
  MemoryFootprintReport,
  OperationStats,
  PerformanceReport,
} from './performance-instrumentation.js';
