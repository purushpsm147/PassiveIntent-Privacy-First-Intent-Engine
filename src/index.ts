/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * EdgeSignal — Public API Barrel Export
 * --------------------------------------------------------
 * Import everything you need from one clean entry-point:
 *
 *   import { IntentManager, BloomFilter, MarkovGraph } from 'edge-signal';
 */

/* ---- Core SDK ---- */
export {
  BloomFilter,
  MarkovGraph,
  IntentManager,
  normalizeRouteState,
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
  ConversionPayload,
  EdgeSignalTelemetry,
  BloomFilterConfig,
  MarkovGraphConfig,
  IntentManagerConfig,
  DwellTimeConfig,
  SerializedMarkovGraph,
} from './intent-sdk.js';

/* ---- Adapters ---- */
export {
  BrowserStorageAdapter,
  BrowserTimerAdapter,
  MemoryStorageAdapter,
} from './adapters.js';

export type {
  StorageAdapter,
  TimerAdapter,
  TimerHandle,
} from './adapters.js';

/* ---- Performance Instrumentation ---- */
export type {
  BenchmarkConfig,
  MemoryFootprintReport,
  OperationStats,
  PerformanceReport,
} from './performance-instrumentation.js';
