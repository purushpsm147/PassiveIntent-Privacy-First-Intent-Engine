/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
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

/* ================================================================== */
/*  Microkernel — Layer 2                                              */
/* ================================================================== */

/**
 * Raw IntentEngine class for enterprise / cross-platform use cases.
 *
 * Requires explicit injection of all four adapter interfaces.
 * Use `createBrowserIntent()` instead for standard web applications.
 *
 * ```ts
 * import { IntentEngine } from '@passiveintent/core';
 *
 * const engine = new IntentEngine({
 *   stateModel:  myModel,
 *   persistence: myStorage,
 *   lifecycle:   myLifecycle,
 *   input:       myInput,
 * });
 * ```
 */
export { PropensityCalculator } from './engine/propensity-calculator.js';
export { IntentEngine } from './engine/intent-engine.js';
export type { IntentEngineConfig } from './types/microkernel.js';

/* ================================================================== */
/*  Web Factory — Layer 3 (Progressive Disclosure)                     */
/* ================================================================== */

/**
 * `createBrowserIntent` — primary entry point for standard web applications.
 *
 * Automatically wires `ContinuousGraphModel`, `LocalStorageAdapter`,
 * `BrowserLifecycleAdapter`, and `MouseKinematicsAdapter` into a new
 * `IntentEngine` and returns it ready to use.
 *
 * ```ts
 * import { createBrowserIntent } from '@passiveintent/core';
 *
 * const intent = createBrowserIntent({ storageKey: 'my-app' });
 * intent.on('high_entropy', ({ state }) => showHelpWidget(state));
 * intent.on('exit_intent',  ({ likelyNext }) => prefetch(likelyNext));
 * ```
 */
export { createBrowserIntent } from './factory.js';
export type { BrowserConfig } from './factory.js';

/* ================================================================== */
/*  CoreInterfaces namespace — enterprise plugin contracts             */
/* ================================================================== */

/**
 * TypeScript contracts for building custom plugins against the IntentEngine
 * microkernel.  Import the namespace to implement your own adapters:
 *
 * ```ts
 * import type { CoreInterfaces } from '@passiveintent/core';
 *
 * // React Native navigation adapter
 * class ReactNativeInputAdapter implements CoreInterfaces.IInputAdapter {
 *   subscribe(onState: (state: string) => void): () => void {
 *     return navigation.addListener('state', (e) => onState(e.data.state.routes.at(-1)?.name ?? '/'));
 *   }
 *   destroy(): void {}
 * }
 *
 * // Custom swipe-based input for dating / food-delivery apps
 * class SwipeKinematicsAdapter implements CoreInterfaces.IInputAdapter {
 *   subscribe(onState: (state: string) => void): () => void {
 *     return swipeEmitter.on('swipe', ({ direction, cardId }) =>
 *       onState(`card:${cardId}:${direction}`));
 *   }
 *   destroy(): void {}
 * }
 * ```
 *
 * Available contracts:
 *   - `IInputAdapter`       — push-based navigation/behavioral input
 *   - `ILifecycleAdapter`   — platform pause / resume / exit-intent
 *   - `IStateModel`         — Markov + Bloom state model
 *   - `IPersistenceAdapter` — synchronous key-value storage
 *   - `IntentEngineConfig`  — full constructor config shape
 *   - `EntropyResult`       — return type of `IStateModel.evaluateEntropy`
 *   - `TrajectoryResult`    — return type of `IStateModel.evaluateTrajectory`
 */
export type * as CoreInterfaces from './types/microkernel.js';
