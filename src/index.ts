/**
 * Privacy-First Intent Engine — Public API Barrel Export
 * --------------------------------------------------------
 * Import everything you need from one clean entry-point:
 *
 *   import { IntentManager, BloomFilter, MarkovGraph } from 'privacy-first-intent-engine';
 */

/* ---- Core SDK ---- */
export {
  BloomFilter,
  MarkovGraph,
  IntentManager,
} from './intent-sdk.js';

export type {
  IntentEventName,
  IntentEventMap,
  HighEntropyPayload,
  TrajectoryAnomalyPayload,
  StateChangePayload,
  BloomFilterConfig,
  MarkovGraphConfig,
  IntentManagerConfig,
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
