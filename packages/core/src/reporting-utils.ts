/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { EvaluationSummary } from './intent-sdk-performance.js';

export interface PerfSummaryInput {
  avgTrackMs: number;
  p95TrackMs: number;
  p99TrackMs: number;
  memoryUsageEstimate: number;
  serializedGraphSizeBytes: number;
}

export function printPerfSummary(summary: PerfSummaryInput): string {
  const lines = [
    'Performance Summary',
    `  avgTrackMs: ${summary.avgTrackMs.toFixed(6)} ms`,
    `  p95TrackMs: ${summary.p95TrackMs.toFixed(6)} ms`,
    `  p99TrackMs: ${summary.p99TrackMs.toFixed(6)} ms`,
    `  memoryUsageEstimate: ${summary.memoryUsageEstimate} bytes`,
    `  serializedGraphSizeBytes: ${summary.serializedGraphSizeBytes} bytes`,
  ];
  const rendered = lines.join('\n');
  // eslint-disable-next-line no-console
  console.log(rendered);
  return rendered;
}

export function printAccuracySummary(summary: EvaluationSummary): string {
  const lines = [
    'Accuracy Summary',
    `  TPR: ${summary.truePositiveRate.toFixed(4)}`,
    `  FPR: ${summary.falsePositiveRate.toFixed(4)}`,
    `  Precision: ${summary.precision.toFixed(4)}`,
    `  Recall: ${summary.recall.toFixed(4)}`,
    `  F1: ${summary.f1.toFixed(4)}`,
    `  avgDetectionLatency: ${summary.avgDetectionLatency.toFixed(4)}`,
  ];
  const rendered = lines.join('\n');
  // eslint-disable-next-line no-console
  console.log(rendered);
  return rendered;
}
