import { IntentManager, MarkovGraph } from './intent-sdk.js';
import type { PerformanceReport } from './performance-instrumentation.js';

export interface SimulationConfig {
  sessions: number;
  transitionsPerSession: number;
  stateSpaceSize: number;
  entropyControl: number;
  mode: 'baseline' | 'noisy' | 'adversarial';
  anomalySessionRate?: number;
}

export interface EvaluationSummary {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  avgDetectionLatency: number;
  avgHesitationAtTrigger: number;
  entropyTriggerRate: number;
  divergenceTriggerRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
}

export interface SimulationSummary {
  totalTransitions: number;
  cpuMsPer10kTransitions: number;
  memoryGrowthBytes: number;
  entropyTriggerRate: number;
  divergenceTriggerRate: number;
  evaluation: EvaluationSummary;
  performanceReport: PerformanceReport;
}

interface SessionResult {
  isGroundTruthHesitation: boolean;
  entropyTriggered: boolean;
  divergenceTriggered: boolean;
  detectionLatency: number | null;
  hesitationAtTrigger: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createStatePool(size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < size; i += 1) out.push(`S${i}`);
  return out;
}

function pickNextState(
  states: string[],
  currentIndex: number,
  entropyControl: number,
  mode: SimulationConfig['mode'],
  step: number,
): number {
  const randomness = clamp(entropyControl, 0, 1);

  if (mode === 'adversarial') {
    return step % 2 === 0
      ? (currentIndex + 1) % states.length
      : (currentIndex + states.length - 1) % states.length;
  }

  if (Math.random() < randomness || mode === 'noisy') {
    return Math.floor(Math.random() * states.length);
  }

  return (currentIndex + 1) % states.length;
}

export function evaluatePredictionMatrix(results: SessionResult[]): EvaluationSummary {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let entropyTriggers = 0;
  let divergenceTriggers = 0;
  let triggerCount = 0;
  let latencyTotal = 0;
  let hesitationTotal = 0;

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const predicted = result.entropyTriggered || result.divergenceTriggered;

    if (result.entropyTriggered) entropyTriggers += 1;
    if (result.divergenceTriggered) divergenceTriggers += 1;

    if (predicted && result.detectionLatency !== null) {
      triggerCount += 1;
      latencyTotal += result.detectionLatency;
      hesitationTotal += result.hesitationAtTrigger ?? 0;
    }

    if (predicted && result.isGroundTruthHesitation) tp += 1;
    else if (predicted && !result.isGroundTruthHesitation) fp += 1;
    else if (!predicted && result.isGroundTruthHesitation) fn += 1;
    else tn += 1;
  }

  const total = results.length || 1;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

  return {
    accuracy: (tp + tn) / total,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    avgDetectionLatency: triggerCount > 0 ? latencyTotal / triggerCount : 0,
    avgHesitationAtTrigger: triggerCount > 0 ? hesitationTotal / triggerCount : 0,
    entropyTriggerRate: entropyTriggers / total,
    divergenceTriggerRate: divergenceTriggers / total,
    truePositiveRate: recall,
    falsePositiveRate: fp + tn > 0 ? fp / (fp + tn) : 0,
  };
}

export class BenchmarkSimulationEngine {
  run(config: SimulationConfig): SimulationSummary {
    const statePool = createStatePool(config.stateSpaceSize);

    const baselineBuilder = new MarkovGraph();
    for (let i = 0; i < statePool.length; i += 1) {
      baselineBuilder.incrementTransition(statePool[i], statePool[(i + 1) % statePool.length]);
    }

    const manager = new IntentManager({
      baseline: baselineBuilder.toJSON(),
      persistDebounceMs: 60_000,
      benchmark: { enabled: true },
    });

    const anomalyRate = clamp(config.anomalySessionRate ?? 0.2, 0, 1);
    const sessionResults: SessionResult[] = [];
    let entropyFires = 0;
    let divergenceFires = 0;

    const startedAt = performance.now();
    const startMemory = manager.getPerformanceReport().memoryFootprint.serializedGraphBytes;

    for (let session = 0; session < config.sessions; session += 1) {
      const isGroundTruthHesitation = Math.random() < anomalyRate || config.mode !== 'baseline';
      let entropyTriggered = false;
      let divergenceTriggered = false;
      let detectionLatency: number | null = null;
      let hesitationAtTrigger: number | null = null;
      let currentStep = 0;

      const offEntropy = manager.on('high_entropy', (payload) => {
        entropyTriggered = true;
        entropyFires += 1;
        if (detectionLatency === null) {
          detectionLatency = currentStep;
          hesitationAtTrigger = payload.normalizedEntropy;
        }
      });

      const offDivergence = manager.on('trajectory_anomaly', (payload) => {
        divergenceTriggered = true;
        divergenceFires += 1;
        if (detectionLatency === null) {
          detectionLatency = currentStep;
          hesitationAtTrigger = payload.divergence;
        }
      });

      let current = Math.floor(Math.random() * statePool.length);
      for (let step = 0; step < config.transitionsPerSession; step += 1) {
        currentStep = step + 1;
        const sessionEntropy = isGroundTruthHesitation
          ? clamp(config.entropyControl + 0.35, 0, 1)
          : config.entropyControl;

        current = pickNextState(statePool, current, sessionEntropy, config.mode, step);
        manager.track(statePool[current]);
      }

      offEntropy();
      offDivergence();

      sessionResults.push({
        isGroundTruthHesitation,
        entropyTriggered,
        divergenceTriggered,
        detectionLatency,
        hesitationAtTrigger,
      });
    }

    const elapsed = performance.now() - startedAt;
    const totalTransitions = config.sessions * config.transitionsPerSession;
    const performanceReport = manager.getPerformanceReport();
    const endMemory = performanceReport.memoryFootprint.serializedGraphBytes;

    return {
      totalTransitions,
      cpuMsPer10kTransitions: totalTransitions > 0 ? (elapsed / totalTransitions) * 10_000 : 0,
      memoryGrowthBytes: endMemory - startMemory,
      entropyTriggerRate: totalTransitions > 0 ? entropyFires / totalTransitions : 0,
      divergenceTriggerRate: totalTransitions > 0 ? divergenceFires / totalTransitions : 0,
      evaluation: evaluatePredictionMatrix(sessionResults),
      performanceReport,
    };
  }
}
