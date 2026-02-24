/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BenchmarkSimulationEngine } from '../dist/src/intent-sdk-performance.js';
import { printAccuracySummary } from '../dist/src/reporting-utils.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, value); }
}

if (!globalThis.localStorage) globalThis.localStorage = new MemoryStorage();
if (!globalThis.window) globalThis.window = { setTimeout, clearTimeout };
if (!globalThis.btoa) globalThis.btoa = (v) => Buffer.from(v, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (v) => Buffer.from(v, 'base64').toString('binary');

const scenarios = ['baseline', 'noisy', 'adversarial', 'random'];
const engine = new BenchmarkSimulationEngine();
const matrix = {};

for (let i = 0; i < scenarios.length; i += 1) {
  const mode = scenarios[i];
  const run = engine.simulateScenario({
    seed: 4242 + i,
    sessions: 24,
    transitionsPerSession: 64,
    mode,
  });

  matrix[mode] = {
    TPR: run.evaluation.truePositiveRate,
    FPR: run.evaluation.falsePositiveRate,
    Precision: run.evaluation.precision,
    Recall: run.evaluation.recall,
    F1: run.evaluation.f1,
    avgDetectionLatency: run.evaluation.avgDetectionLatency,
  };

  console.log(`Scenario: ${mode}`);
  printAccuracySummary(run.evaluation);
}

const benchmarkDir = path.resolve('benchmarks');
fs.mkdirSync(benchmarkDir, { recursive: true });
const outputPath = path.join(benchmarkDir, 'evaluation-matrix.json');
fs.writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`);

if (process.argv.includes('--check-golden')) {
  const goldenPath = path.join(benchmarkDir, 'evaluation-matrix.golden.json');
  if (!fs.existsSync(goldenPath)) {
    throw new Error('Missing benchmarks/evaluation-matrix.golden.json. Run with --update-golden once.');
  }

  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const fprTolerance = Number(process.env.MATRIX_MAX_FPR_INCREASE ?? 0.03);
  const tprTolerance = Number(process.env.MATRIX_MAX_TPR_DROP ?? 0.03);
  const latencyTolerance = Number(process.env.MATRIX_MAX_LATENCY_INCREASE ?? 2);
  const failures = [];

  for (const mode of scenarios) {
    const g = golden[mode];
    const n = matrix[mode];
    if (!g || !n) {
      failures.push(`Missing scenario in golden/current: ${mode}`);
      continue;
    }

    if (n.FPR - g.FPR > fprTolerance) {
      failures.push(`${mode}: FPR increased by ${(n.FPR - g.FPR).toFixed(4)} (tol=${fprTolerance})`);
    }
    if (g.TPR - n.TPR > tprTolerance) {
      failures.push(`${mode}: TPR dropped by ${(g.TPR - n.TPR).toFixed(4)} (tol=${tprTolerance})`);
    }
    if (n.avgDetectionLatency - g.avgDetectionLatency > latencyTolerance) {
      failures.push(`${mode}: latency increased by ${(n.avgDetectionLatency - g.avgDetectionLatency).toFixed(4)} (tol=${latencyTolerance})`);
    }
  }

  if (failures.length > 0) {
    console.error('Scenario matrix regression check failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log('Scenario matrix regression check passed.');
}

if (process.argv.includes('--update-golden')) {
  fs.writeFileSync(path.join(benchmarkDir, 'evaluation-matrix.golden.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  console.log('Updated golden scenario matrix baseline.');
}
