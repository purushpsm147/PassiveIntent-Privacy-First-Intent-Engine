/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { BenchmarkConfig } from '../performance-instrumentation.js';
import type { SerializedMarkovGraph } from '../core/markov.js';
import type {
  AsyncStorageAdapter,
  LifecycleAdapter,
  StorageAdapter,
  TimerAdapter,
} from '../adapters.js';

export type IntentEventName =
  | 'high_entropy'
  | 'trajectory_anomaly'
  | 'state_change'
  | 'dwell_time_anomaly'
  | 'conversion'
  | 'bot_detected'
  | 'hesitation_detected'
  | 'session_stale'
  | 'attention_return'
  | 'user_idle'
  | 'user_resumed'
  | 'exit_intent';

export interface ConversionPayload {
  type: string;
  value?: number;
  currency?: string;
}

export interface PassiveIntentTelemetry {
  sessionId: string;
  transitionsEvaluated: number;
  botStatus: 'human' | 'suspected_bot';
  anomaliesFired: number;
  engineHealth: 'healthy' | 'pruning_active' | 'quota_exceeded';
  baselineStatus: 'active' | 'drifted';
  assignmentGroup: 'treatment' | 'control';
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

/**
 * Emitted when a measured time delta (dwell time or tab-hidden duration) exceeds
 * `MAX_PLAUSIBLE_DWELL_MS`, indicating that the host machine was likely suspended
 * or the user was genuinely absent for an implausible length of time.
 *
 * The inflated measurement is **discarded** — it is never entered into the Welford
 * accumulator and never used to offset `previousStateEnteredAt`.  The engine
 * resets its dwell baseline to the current timestamp so the next transition
 * measurement starts from a clean epoch.
 *
 * This is a diagnostic / observability event only.  It does not affect the
 * Markov graph, Bloom filter, or any anomaly-detection signals.
 *
 * **Precondition**: both `'hidden_duration_exceeded'` and `'dwell_exceeded'`
 * are only emitted when `dwellTime.enabled` is `true`.  Callers who opt out of
 * dwell-time detection will never receive this event.
 */
export interface SessionStalePayload {
  /**
   * What triggered the stale-session guard:
   * - `'hidden_duration_exceeded'` — the tab-hidden gap from the LifecycleAdapter
   *   exceeded the plausible threshold when the tab resumed.
   * - `'dwell_exceeded'` — the computed dwell time for the previous state exceeded
   *   the plausible threshold at `track()` time.
   */
  reason: 'hidden_duration_exceeded' | 'dwell_exceeded';
  /** The raw (uncapped) duration in milliseconds that triggered the guard. */
  measuredMs: number;
  /** The threshold in milliseconds that was exceeded (`MAX_PLAUSIBLE_DWELL_MS`). */
  thresholdMs: number;
}

export interface AttentionReturnPayload {
  /** The state the user was viewing before they tabbed away. */
  state: string;
  /** How long the tab was hidden, in milliseconds. */
  hiddenDuration: number;
}

export interface UserIdlePayload {
  /** The state the user was viewing when they became idle. */
  state: string;
  /**
   * Time spent in the idle state in milliseconds at the time the event fired,
   * i.e. time since crossing the idle-threshold after the last interaction.
   */
  idleMs: number;
}

export interface UserResumedPayload {
  /** The state the user was viewing when they resumed interaction. */
  state: string;
  /**
   * Total time spent in the idle state in milliseconds before the user resumed,
   * i.e. time since crossing the idle-threshold after the last interaction.
   */
  idleMs: number;
}

/**
 * Emitted when the user signals exit intent (e.g. mouse leaving the viewport
 * toward the browser chrome) **and** the Markov graph contains at least one
 * likely continuation path from the current state.
 *
 * The event is only emitted when the graph indicates the user has a plausible
 * next destination — not blindly on every mouseleave — so hosts can use it to
 * surface targeted retention interventions rather than spammy overlays.
 *
 * `likelyNext` is the highest-probability candidate state (probability ≥ 0.4).
 * It is `null` only when no candidates meet the threshold, in which case the
 * event is suppressed entirely and this payload is never delivered.
 */
export interface ExitIntentPayload {
  /** The state the user was viewing when exit intent was detected. */
  state: string;
  /**
   * The most probable next state according to the Markov graph, or `null` when
   * no candidate exceeds the probability threshold.  In practice this field is
   * always a non-null string when the event fires, because a null result
   * suppresses the emission entirely.
   */
  likelyNext: string | null;
}

export interface IntentEventMap {
  high_entropy: HighEntropyPayload;
  trajectory_anomaly: TrajectoryAnomalyPayload;
  state_change: StateChangePayload;
  dwell_time_anomaly: DwellTimeAnomalyPayload;
  conversion: ConversionPayload;
  bot_detected: BotDetectedPayload;
  hesitation_detected: HesitationDetectedPayload;
  session_stale: SessionStalePayload;
  attention_return: AttentionReturnPayload;
  user_idle: UserIdlePayload;
  user_resumed: UserResumedPayload;
  exit_intent: ExitIntentPayload;
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
  /**
   * Dirichlet / Laplace smoothing pseudo-count added to every observed
   * transition count when computing `P(to|from)`.
   *
   * Applies Bayesian smoothing:
   *   `P = (count + alpha) / (total + alpha * k)`
   * where `k` is the number of live states in the graph.
   *
   * This prevents cold-start 100 % probability spikes that otherwise
   * trigger false `trajectory_anomaly` events in early sessions.
   *
   * **Default: `0.1`** (mild regularization, enabled by default).
   *
   * - `alpha = 0.1` — default; effective for typical navigation graphs with
   *                  5–50 states.  Prevents false positives during cold-start.
   * - `alpha = 0`   — disables smoothing; falls back to exact frequentist
   *                  math (`count / total`) with no performance cost.
   * - `alpha = 1`   — full Laplace (add-one) smoothing.
   *
   * Non-finite or negative values are silently clamped to `0`.
   */
  smoothingAlpha?: number;
}

/**
 * Structured error object passed to the `onError` callback.
 * The engine never throws these errors to the host application — they are
 * always swallowed and forwarded here so the host can log, alert, or recover.
 */
export interface PassiveIntentError {
  /**
   * Machine-readable error category.
   * - `STORAGE_READ`    — `localStorage.getItem` threw (e.g., SecurityError in private browsing).
   * - `STORAGE_WRITE`   — `localStorage.setItem` threw for a non-quota reason.
   * - `QUOTA_EXCEEDED`  — `localStorage.setItem` threw `QuotaExceededError`; graph was not persisted.
   * - `RESTORE_PARSE`   — Binary/JSON parse failed when restoring a saved graph; cold-start applied.
   * - `SERIALIZE`       — Binary serialization failed when saving the graph.
   * - `VALIDATION`      — An invalid argument was passed to a public API method (e.g., empty `track('')`).
   * - `LIMIT_EXCEEDED`   — A hard cap was reached (e.g., max unique counter keys).
   */
  code:
    | 'STORAGE_READ'
    | 'STORAGE_WRITE'
    | 'QUOTA_EXCEEDED'
    | 'RESTORE_PARSE'
    | 'SERIALIZE'
    | 'VALIDATION'
    | 'LIMIT_EXCEEDED';
  /** Human-readable description of the failure. */
  message: string;
  /**
   * The underlying caught value, if available.
   * For `RESTORE_PARSE`, this is `{ cause: unknown; payloadLength: number }` where
   * `payloadLength` is the byte length of the raw string that failed to parse.
   * The raw payload itself is intentionally omitted to avoid surfacing stored
   * user-navigation data in error reports.
   * For all other codes, this is the raw caught exception.
   */
  originalError?: unknown;
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
  /**
   * Convenience alias for `graph.smoothingAlpha`.
   *
   * Dirichlet pseudo-count that regularizes transition probabilities during
   * the cold-start phase.  Default: `0.1` (mild regularization, enabled by
   * default).  Pass `0` explicitly to disable smoothing and use pure
   * frequentist math.  Non-finite or negative values are clamped to `0`.
   *
   * **Precedence:** when both this field and `graph.smoothingAlpha` are set,
   * _this field wins_.
   */
  smoothingAlpha?: number;
  /** localStorage key used to persist the Bloom filter and Markov graph. Default: `'passive-intent'`. */
  storageKey?: string;
  /**
   * Delay in ms used for the **async retry / coalescing path** only. Default: `2000`.
   *
   * When `persistThrottleMs` is `0` (the default), `track()` calls
   * `persist()` synchronously on every invocation, giving full crash-safety —
   * no navigation data is lost on a sudden process kill.  This field does not
   * control write frequency in that mode.
   *
   * When `persistThrottleMs > 0`, the `persist()` call inside `track()` is
   * throttled: writes are skipped for calls that fall within the throttle
   * window, relaxing the per-track crash-safety guarantee (up to
   * `persistThrottleMs` ms of recent navigation data can be lost in a hard
   * crash). In this mode, the trailing-flush timer that fires after the
   * throttle window expires is governed by `persistThrottleMs`, not this
   * debounce value.
   *
   * This value governs two narrower scenarios regardless of `persistThrottleMs`:
   * - **Async storage retry**: when an async `setItem` fails for the first time
   *   in a consecutive sequence, one retry pass is scheduled after
   *   `persistDebounceMs`.  This gives the host app time to surface the error
   *   (via `onError`) before the retry fires.  If the retry also fails, no
   *   further automatic retry is scheduled — the dirty flag is preserved and
   *   the next `track()` or `flushNow()` call will trigger a fresh attempt.
   * - **`flushNow()`**: cancels any pending throttle and retry timers and
   *   requests an immediate write.  With a sync `StorageAdapter` the write
   *   completes before `flushNow()` returns.  With `asyncStorage`, if a write
   *   is already in-flight the actual flush is deferred until that write
   *   settles — `flushNow()` cannot interrupt an in-progress async `setItem`
   *   call.  Reducing `persistDebounceMs` has no observable effect on this
   *   behaviour.
   *
   * If your async backend cannot handle burst writes, consider wrapping it in a
   * throttled `AsyncStorageAdapter` instead of tuning this value.
   */
  persistDebounceMs?: number;
  /**
   * Maximum frequency at which the expensive prune+serialize+write pipeline
   * runs during normal `track()` flow, in milliseconds.
   * Default: `0` (disabled — every dirty `track()` writes synchronously,
   * full crash-safety).
   *
   * When `> 0`, the pipeline runs at most once per `persistThrottleMs` window:
   * - The **first** dirty write after a quiescent period executes immediately
   *   (leading-edge), preserving crash-safety for the initial navigation event.
   * - Subsequent dirty writes within the same window are **skipped**, but a
   *   trailing timer fires within `persistThrottleMs` ms to flush any
   *   accumulated dirty state.
   * - At most `persistThrottleMs` ms of recent navigation data can be lost in a
   *   hard crash (OS kill, power loss, Chrome tab discard).
   *
   * `flushNow()` and `destroy()` always bypass the throttle: they request a
   * flush as soon as possible. If no async write is in-flight, they write
   * immediately; with `asyncStorage` and an in-flight write, they schedule a
   * flush to run right after the current write settles.
   *
   * Recommended values:
   * - `0`       — full crash-safety (default); best for checkout / payment flows.
   * - `200–500` — good balance for typical graphs (50–200 states).
   * - `1000`    — aggressive throttle for large graphs (300+ states) where
   *               prune+serialize takes >1 ms per call.
   */
  persistThrottleMs?: number;
  /**
   * Pre-trained baseline graph (from `MarkovGraph.toJSON()`) representing
   * the expected normal navigation pattern.  Required for `trajectory_anomaly`
   * detection.  If absent, trajectory evaluation is skipped.
   */
  baseline?: SerializedMarkovGraph;
  benchmark?: BenchmarkConfig;
  /** Override the storage backend (useful for tests or custom persistence layers). */
  storage?: StorageAdapter;
  /**
   * Async storage backend for environments where I/O is inherently asynchronous
   * (React Native AsyncStorage, Capacitor Preferences, IndexedDB wrappers, etc.).
   *
   * When provided, use `IntentManager.createAsync(config)` to initialize the
   * engine — the factory awaits the initial `getItem` before constructing the
   * instance so that the synchronous `track()` hot-path is never blocked.
   *
   * The `persist()` method detects this adapter and handles `setItem` as a
   * fire-and-forget promise, guarded by an in-flight write flag to prevent
   * overlapping writes.
   *
   * Cannot be combined with `storage` — if both are provided `asyncStorage`
   * takes precedence for writes; `storage` is ignored.
   */
  asyncStorage?: AsyncStorageAdapter;
  /** Override the timer backend (useful for deterministic tests). */
  timer?: TimerAdapter;
  /**
   * Override the lifecycle (page-visibility) adapter.
   *
   * Provide a custom implementation to support React Native, Electron, or any
   * SSR environment where `document` is unavailable.  When omitted the engine
   * falls back to `BrowserLifecycleAdapter` in browser contexts and does
   * nothing in non-browser contexts.
   */
  lifecycleAdapter?: LifecycleAdapter;
  /**
   * Non-fatal error callback — surfaces storage errors, quota exhaustion, parse
   * failures, and invalid API calls without ever throwing to the host application.
   *
   * @example
   * ```ts
   * new IntentManager({
   *   onError({ code, message, originalError }) {
   *     Sentry.captureException(originalError ?? new Error(message), {
   *       tags: { passiveintent_error: code },
   *     });
   *   },
   * });
   * ```
   */
  onError?: (error: PassiveIntentError) => void;
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
   * Optional custom state normalizer applied **after** the built-in
   * `normalizeRouteState()` (which strips query strings, hash fragments,
   * trailing slashes, UUIDs, MongoDB ObjectIDs, and numeric IDs ≥ 4 digits).
   *
   * Use this to collapse dynamic segments that the built-in normalizer does
   * not recognise — for example, SEO slugs on a blog:
   *
   * ```ts
   * new IntentManager({
   *   stateNormalizer: (state) =>
   *     state.replace(/^\/blog\/[^/]+$/, '/blog/:slug'),
   * });
   * ```
   *
   * The return value of this function becomes the canonical state label.
   * Returning an empty string causes the `track()` call to be silently dropped.
   */
  stateNormalizer?: (state: string) => string;
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
  /**
   * Failsafe killswitch: protects against baseline drift by monitoring the
   * ratio of `trajectory_anomaly` **detections** to `track()` calls within a
   * rolling time window.  A detection is counted every time the z-score crosses
   * the anomaly threshold, regardless of whether the event was suppressed by
   * `eventCooldownMs`.  When the ratio exceeds `maxAnomalyRate` the engine
   * sets an internal `isBaselineDrifted` flag that silently disables further
   * trajectory evaluation until the instance is replaced.
   *
   * Defaults: `maxAnomalyRate: 0.4` (40 %) and `evaluationWindowMs: 300_000`
   * (5 minutes).  Set `maxAnomalyRate: 1` to effectively disable the feature.
   */
  driftProtection?: { maxAnomalyRate: number; evaluationWindowMs: number };
  /**
   * Local A/B testing holdout configuration.
   *
   * When provided, each new `IntentManager` instance is randomly assigned to
   * either `'treatment'` or `'control'` at construction time.  The `percentage`
   * field specifies the probability (0–100) of being placed in the control
   * group.  For example, `{ percentage: 10 }` routes ~10 % of sessions to
   * control and ~90 % to treatment.
   *
   * Values outside the 0–100 range are clamped: negative values behave like 0
   * (always treatment) and values above 100 behave like 100 (always control).
   *
   * Sessions in the **control** group still perform all entropy, trajectory,
   * and dwell-time calculations and increment the telemetry counters, but
   * will **not** emit `high_entropy`, `trajectory_anomaly`,
   * `dwell_time_anomaly`, or `hesitation_detected` events.  This lets you
   * measure conversion lift (ROI) without any server-side tracking.
   *
   * The assigned group is exposed via `getTelemetry().assignmentGroup`.
   */
  holdoutConfig?: { percentage: number };
  /**
   * Enable optional cross-tab synchronization via the
   * [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).
   *
   * When `true`, every locally-verified state transition is broadcast to all
   * other tabs that share the same `storageKey`-derived channel name, and
   * incoming remote transitions update the local Markov graph and Bloom filter
   * so that prefetch hints stay accurate across a multi-tab session.
   *
   * **Security invariants (always enforced):**
   * - Incoming payloads are strictly validated: `from`/`to` must be non-empty
   *   strings ≤ 256 characters — malformed or oversized messages are silently
   *   dropped to prevent heap amplification / model poisoning from a compromised tab.
   * - Remote transitions are applied **without re-broadcasting**, eliminating
   *   the infinite-loop amplification that would occur if received messages were
   *   forwarded back to the channel.
   * - Transitions are only broadcast after passing the local `EntropyGuard`
   *   check, so a local bot script cannot flood all open tabs.
   *
   * No-op in SSR / non-browser environments where `BroadcastChannel` is absent.
   *
   * Default: `false`.
   */
  crossTabSync?: boolean;
}
