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

export type {
  IntentEventName,
  IntentEventMap,
  HighEntropyPayload,
  TrajectoryAnomalyPayload,
  DwellTimeAnomalyPayload,
  StateChangePayload,
  BotDetectedPayload,
  HesitationDetectedPayload,
  ConversionPayload,
  EdgeSignalTelemetry,
  BloomFilterConfig,
  MarkovGraphConfig,
  IntentManagerConfig,
  DwellTimeConfig,
  EdgeSignalError,
} from './types/events.js';

export type { SerializedMarkovGraph } from './core/markov.js';

export type {
  BenchmarkConfig,
  MemoryFootprintReport,
  OperationStats,
  PerformanceReport,
} from './performance-instrumentation.js';

export type { StorageAdapter, AsyncStorageAdapter } from './adapters.js';
