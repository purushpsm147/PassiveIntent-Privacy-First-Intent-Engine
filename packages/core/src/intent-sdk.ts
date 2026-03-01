/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
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
export { MAX_PLAUSIBLE_DWELL_MS, SMOOTHING_EPSILON } from './engine/constants.js';
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
