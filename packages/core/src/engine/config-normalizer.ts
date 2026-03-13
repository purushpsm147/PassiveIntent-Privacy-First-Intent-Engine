/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { IntentManagerConfig, MarkovGraphConfig } from '../types/events.js';
import { SMOOTHING_EPSILON } from './constants.js';

/**
 * Converts a one-tailed false positive rate to a Z-score threshold via the
 * standard inverse-normal CDF: z = Φ⁻¹(1 − fpr).
 *
 * Uses the rational approximation by Beasley & Springer (1977) — accurate to
 * within 4.5 × 10⁻⁴ across (0, 0.5], which is far tighter than the asymptotic
 * `√(−2 ln fpr)` approximation (≈ 36 % error at fpr = 0.05).
 * Finite inputs outside [0.001, 0.5] are silently clamped.
 * Non-finite inputs (NaN, ±Infinity) return NaN; callers must guard with
 * `Number.isFinite` and fall back to a sensible default.
 *
 * Bundle-size optimised: six scalar constants, no lookup tables.
 */
function fprToZScore(fpr: number): number {
  if (!Number.isFinite(fpr)) return NaN;
  const p = Math.min(0.5, Math.max(0.001, fpr));
  const t = Math.sqrt(-2.0 * Math.log(p));
  return (
    t -
    (2.515517 + t * (0.802853 + t * 0.010328)) /
      (1.0 + t * (1.432788 + t * (0.189269 + t * 0.001308)))
  );
}

/**
 * Strongly-typed internal options object produced by normalizing an
 * `IntentManagerConfig`.  Every field has a concrete, non-optional value —
 * the constructor can use them directly without further null-coalescing.
 *
 * This covers **only** the config-precedence / default / clamping logic that
 * previously lived inside the `IntentManager` constructor.  Fields that are
 * pure pass-through (e.g. `timer`, `storage`, `benchmark`, `onError`,
 * `baseline`, `lifecycleAdapter`, `asyncStorage`) are intentionally omitted
 * because they carry no defaulting or merging logic of their own.
 *
 * @internal Not part of the public package API.  Field names and defaults may
 * change across any release without a semver-major bump.
 */
export interface ResolvedIntentManagerOptions {
  /* ── Scalar flags ──────────────────────────────────────────────────────── */
  botProtection: boolean;
  dwellTimeEnabled: boolean;
  crossTabSync: boolean;

  /* ── Holdout ───────────────────────────────────────────────────────────── */
  /** Clamped to [0, 100]. */
  holdoutPercent: number;

  /* ── Graph config (merged from top-level aliases + nested graph) ──────── */
  graphConfig: MarkovGraphConfig;

  /**
   * Resolved Laplace smoothing epsilon for trajectory scoring.
   * Falls back to `SMOOTHING_EPSILON` when the configured value is not
   * a finite positive number.
   */
  trajectorySmoothingEpsilon: number;

  /* ── Persistence ───────────────────────────────────────────────────────── */
  storageKey: string;
  persistDebounceMs: number;
  persistThrottleMs: number;

  /* ── Signal engine ─────────────────────────────────────────────────────── */
  eventCooldownMs: number;
  dwellTimeMinSamples: number;
  dwellTimeZScoreThreshold: number;
  enableBigrams: boolean;
  bigramFrequencyThreshold: number;
  driftMaxAnomalyRate: number;
  driftEvaluationWindowMs: number;
  hesitationCorrelationWindowMs: number;
}

/**
 * Pure function that normalizes an external `IntentManagerConfig` into a
 * fully-resolved `ResolvedIntentManagerOptions`.
 *
 * All precedence, default-value, and clamping rules are centralised here so
 * that the `IntentManager` constructor becomes pure wiring.
 *
 * **Precedence rules (unchanged from original):**
 * - `config.baselineMeanLL` wins over `config.graph.baselineMeanLL`
 * - `config.baselineStdLL`  wins over `config.graph.baselineStdLL`
 * - `config.smoothingAlpha` wins over `config.graph.smoothingAlpha`
 *
 * **Clamping rules:**
 * - `holdoutConfig.percentage` is clamped to [0, 100].
 * - `graphConfig.smoothingEpsilon` must be a finite positive number; otherwise
 *   the compile-time constant `SMOOTHING_EPSILON` is used.
 *
 * @internal Not part of the public package API.
 */
export function buildIntentManagerOptions(
  config: IntentManagerConfig = {},
): ResolvedIntentManagerOptions {
  // ── Scalar flags ────────────────────────────────────────────────────────
  const botProtection = config.botProtection ?? true;
  const dwellTimeEnabled = config.dwellTime?.enabled ?? false;
  const crossTabSync = config.crossTabSync === true;

  // ── Holdout — clamped to [0, 100] ──────────────────────────────────────
  const rawHoldoutPct = config.holdoutConfig?.percentage;
  const holdoutPercent = Number.isFinite(rawHoldoutPct)
    ? Math.min(100, Math.max(0, rawHoldoutPct as number))
    : (rawHoldoutPct ?? 0);

  // ── Merge top-level convenience aliases into the nested graph config ────
  // Top-level fields take precedence when both are supplied.
  // targetFPR overrides divergenceThreshold when present.
  const graphFPR = config.graph?.targetFPR;
  const graphConfig: MarkovGraphConfig = {
    ...config.graph,
    baselineMeanLL: config.baselineMeanLL ?? config.graph?.baselineMeanLL,
    baselineStdLL: config.baselineStdLL ?? config.graph?.baselineStdLL,
    smoothingAlpha: config.smoothingAlpha ?? config.graph?.smoothingAlpha,
    divergenceThreshold: Number.isFinite(graphFPR)
      ? fprToZScore(graphFPR as number)
      : config.graph?.divergenceThreshold,
  };

  // ── Trajectory smoothing epsilon ────────────────────────────────────────
  const configuredSmoothing = graphConfig.smoothingEpsilon;
  const trajectorySmoothingEpsilon =
    typeof configuredSmoothing === 'number' &&
    Number.isFinite(configuredSmoothing) &&
    configuredSmoothing > 0
      ? configuredSmoothing
      : SMOOTHING_EPSILON;

  // ── Persistence ─────────────────────────────────────────────────────────
  const storageKey = config.storageKey ?? 'passive-intent';

  const rawPersistDebounce = config.persistDebounceMs;
  const persistDebounceMs =
    Number.isFinite(rawPersistDebounce) && (rawPersistDebounce as number) >= 0
      ? Math.floor(rawPersistDebounce as number)
      : 2000;

  const rawPersistThrottle = config.persistThrottleMs;
  const persistThrottleMs =
    Number.isFinite(rawPersistThrottle) && (rawPersistThrottle as number) >= 0
      ? Math.floor(rawPersistThrottle as number)
      : 0;

  // ── Signal engine ───────────────────────────────────────────────────────
  const rawEventCooldown = config.eventCooldownMs;
  const eventCooldownMs =
    Number.isFinite(rawEventCooldown) && (rawEventCooldown as number) >= 0
      ? Math.floor(rawEventCooldown as number)
      : 0;

  const rawDwellMinSamples = config.dwellTime?.minSamples;
  const dwellTimeMinSamples =
    Number.isFinite(rawDwellMinSamples) && (rawDwellMinSamples as number) >= 1
      ? Math.floor(rawDwellMinSamples as number)
      : 10;

  const dwellFPR = config.dwellTime?.targetFPR;
  const rawDwellZScore = config.dwellTime?.zScoreThreshold;
  const dwellTimeZScoreThreshold = Number.isFinite(dwellFPR)
    ? fprToZScore(dwellFPR as number)
    : Number.isFinite(rawDwellZScore) && (rawDwellZScore as number) > 0
      ? (rawDwellZScore as number)
      : 2.5;

  const enableBigrams = config.enableBigrams ?? false;

  const rawBigramThreshold = config.bigramFrequencyThreshold;
  const bigramFrequencyThreshold =
    Number.isFinite(rawBigramThreshold) && (rawBigramThreshold as number) >= 1
      ? Math.floor(rawBigramThreshold as number)
      : 5;

  const rawDriftMaxRate = config.driftProtection?.maxAnomalyRate;
  const driftMaxAnomalyRate = Number.isFinite(rawDriftMaxRate)
    ? Math.min(1, Math.max(0, rawDriftMaxRate as number))
    : 0.4;

  const rawDriftWindowMs = config.driftProtection?.evaluationWindowMs;
  const driftEvaluationWindowMs =
    Number.isFinite(rawDriftWindowMs) && (rawDriftWindowMs as number) > 0
      ? Math.floor(rawDriftWindowMs as number)
      : 300_000;

  const rawHesitationMs = config.hesitationCorrelationWindowMs;
  const hesitationCorrelationWindowMs =
    Number.isFinite(rawHesitationMs) && (rawHesitationMs as number) >= 0
      ? Math.floor(rawHesitationMs as number)
      : 30_000;

  return {
    botProtection,
    dwellTimeEnabled,
    crossTabSync,
    holdoutPercent,
    graphConfig,
    trajectorySmoothingEpsilon,
    storageKey,
    persistDebounceMs,
    persistThrottleMs,
    eventCooldownMs,
    dwellTimeMinSamples,
    dwellTimeZScoreThreshold,
    enableBigrams,
    bigramFrequencyThreshold,
    driftMaxAnomalyRate,
    driftEvaluationWindowMs,
    hesitationCorrelationWindowMs,
  };
}
