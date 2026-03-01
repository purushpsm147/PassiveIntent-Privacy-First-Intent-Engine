/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { IntentManagerConfig, MarkovGraphConfig } from '../types/events.js';
import { SMOOTHING_EPSILON } from './constants.js';

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
 */
export function buildIntentManagerOptions(
  config: IntentManagerConfig = {},
): ResolvedIntentManagerOptions {
  // ── Scalar flags ────────────────────────────────────────────────────────
  const botProtection = config.botProtection ?? true;
  const dwellTimeEnabled = config.dwellTime?.enabled ?? false;
  const crossTabSync = config.crossTabSync === true;

  // ── Holdout — clamped to [0, 100] ──────────────────────────────────────
  const holdoutPercent = Math.min(100, Math.max(0, config.holdoutConfig?.percentage ?? 0));

  // ── Merge top-level convenience aliases into the nested graph config ────
  // Top-level fields take precedence when both are supplied.
  const graphConfig: MarkovGraphConfig = {
    ...config.graph,
    baselineMeanLL: config.baselineMeanLL ?? config.graph?.baselineMeanLL,
    baselineStdLL: config.baselineStdLL ?? config.graph?.baselineStdLL,
    smoothingAlpha: config.smoothingAlpha ?? config.graph?.smoothingAlpha,
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
  const persistDebounceMs = config.persistDebounceMs ?? 2000;
  const persistThrottleMs = config.persistThrottleMs ?? 0;

  // ── Signal engine ───────────────────────────────────────────────────────
  const eventCooldownMs = config.eventCooldownMs ?? 0;
  const dwellTimeMinSamples = config.dwellTime?.minSamples ?? 10;
  const dwellTimeZScoreThreshold = config.dwellTime?.zScoreThreshold ?? 2.5;
  const enableBigrams = config.enableBigrams ?? false;
  const bigramFrequencyThreshold = config.bigramFrequencyThreshold ?? 5;
  const driftMaxAnomalyRate = config.driftProtection?.maxAnomalyRate ?? 0.4;
  const driftEvaluationWindowMs = config.driftProtection?.evaluationWindowMs ?? 300_000;
  const hesitationCorrelationWindowMs = config.hesitationCorrelationWindowMs ?? 30_000;

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
