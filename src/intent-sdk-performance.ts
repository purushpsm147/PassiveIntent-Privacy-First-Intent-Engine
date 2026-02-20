import { IntentManager, MarkovGraph } from './intent-sdk.js';
import type { PerformanceReport } from './performance-instrumentation.js';

interface BaselineCalibration {
  mean: number;
  std: number;
}

export interface SimulationConfig {
  sessions: number;
  transitionsPerSession: number;
  stateSpaceSize: number;
  entropyControl: number;
  mode: 'baseline' | 'noisy' | 'adversarial' | 'random';
  anomalySessionRate?: number;
  seed?: number;
}

export interface DeterministicScenarioConfig {
  seed: number;
  sessions: number;
  transitionsPerSession: number;
  mode: 'baseline' | 'noisy' | 'adversarial' | 'random';
}

export interface SessionReplay {
  stateSequence: string[];
  entropyValues: number[];
  divergenceValues: number[];
}

export interface ScenarioReplaySummary {
  seed: number;
  mode: DeterministicScenarioConfig['mode'];
  sessions: number;
  transitionsPerSession: number;
  sessionReplays: SessionReplay[];
  evaluation: EvaluationSummary;
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

interface InternalRunResult {
  summary: SimulationSummary;
  sessionReplays: SessionReplay[];
  seed: number;
}

class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }
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
  rng: SeededRng,
): number {
  const randomness = clamp(entropyControl, 0, 1);

  if (mode === 'adversarial') {
    return step % 2 === 0
      ? (currentIndex + 1) % states.length
      : (currentIndex + states.length - 1) % states.length;
  }

  if (mode === 'random') {
    return rng.int(states.length);
  }

  if (rng.next() < randomness || mode === 'noisy') {
    return rng.int(states.length);
  }

  return (currentIndex + 1) % states.length;
}

function deterministicSeedFromConfig(config: Omit<SimulationConfig, 'seed'>): number {
  let hash = 2166136261;
  const encoded = `${config.sessions}:${config.transitionsPerSession}:${config.stateSpaceSize}:${config.entropyControl}:${config.mode}:${config.anomalySessionRate ?? ''}`;
  for (let i = 0; i < encoded.length; i += 1) {
    hash ^= encoded.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildBaselineGraph(statePool: string[]): MarkovGraph {
  const baselineBuilder = new MarkovGraph();
  for (let i = 0; i < statePool.length; i += 1) {
    baselineBuilder.incrementTransition(statePool[i], statePool[(i + 1) % statePool.length]);
  }
  return baselineBuilder;
}

/**
 * Smoothing epsilon used for log-likelihood calculations.
 * Must be identical between calibration and runtime.
 */
const SMOOTHING_EPSILON = 0.01;

/**
 * Minimum sliding window length for calibration sampling.
 * Matches the warm-up gate in IntentManager.evaluateTrajectory.
 */
const MIN_WINDOW_LENGTH = 16;

/**
 * Maximum sliding window length for calibration sampling.
 * Matches the recentTrajectory cap in IntentManager.
 */
const MAX_WINDOW_LENGTH = 32;

/**
 * Calibrate baseline statistics using independent samples at the reference window size.
 * 
 * Statistical approach:
 * 1. Generate trajectories of MAX_WINDOW_LENGTH states (the reference size)
 * 2. Compute average log-likelihood per transition for each trajectory
 * 3. Calculate mean and std from these independent samples
 * 
 * At runtime, variance is scaled by sqrt(MAX_WINDOW_LENGTH / N) for windows of size N.
 */
function calibrateBaseline(
  baselineGraph: MarkovGraph,
  statePool: string[],
  transitionsPerSession: number,
  rng: SeededRng,
  sessions = 160,
  entropyControl = 0.2,
): BaselineCalibration {
  const averages: number[] = [];

  // Generate many independent samples at the reference window size
  const samplesPerSession = Math.max(1, Math.floor(transitionsPerSession / MAX_WINDOW_LENGTH));
  
  for (let session = 0; session < sessions; session += 1) {
    for (let sample = 0; sample < samplesPerSession; sample += 1) {
      const sequence: string[] = [];
      let current = rng.int(statePool.length);

      // Generate a trajectory of exactly MAX_WINDOW_LENGTH states
      for (let step = 0; step < MAX_WINDOW_LENGTH; step += 1) {
        current = pickNextState(statePool, current, entropyControl, 'baseline', step, rng);
        sequence.push(statePool[current]);
      }

      const ll = MarkovGraph.logLikelihoodTrajectory(
        baselineGraph,
        sequence,
        SMOOTHING_EPSILON,
      );
      const denominator = Math.max(1, sequence.length - 1);
      averages.push(ll / denominator);
    }
  }

  const mean = averages.reduce((acc, value) => acc + value, 0) / Math.max(1, averages.length);
  const variance = averages.reduce((acc, value) => {
    const delta = value - mean;
    return acc + delta * delta;
  }, 0) / Math.max(1, averages.length);

  return {
    mean,
    std: Math.max(Math.sqrt(variance), Number.EPSILON),
  };
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
    return this.runWithReplay(config).summary;
  }

  simulateScenario(config: DeterministicScenarioConfig): ScenarioReplaySummary {
    const stateSpaceSize = 50;
    const entropyControl = config.mode === 'random' ? 1 : config.mode === 'baseline' ? 0.2 : 0.55;
    const anomalySessionRate = config.mode === 'baseline' ? 0.1 : 0.8;

    const runResult = this.runWithReplay({
      sessions: config.sessions,
      transitionsPerSession: config.transitionsPerSession,
      stateSpaceSize,
      entropyControl,
      mode: config.mode,
      anomalySessionRate,
      seed: config.seed,
    });

    return {
      seed: config.seed,
      mode: config.mode,
      sessions: config.sessions,
      transitionsPerSession: config.transitionsPerSession,
      sessionReplays: runResult.sessionReplays,
      evaluation: runResult.summary.evaluation,
    };
  }

  private runWithReplay(config: SimulationConfig): InternalRunResult {
    const statePool = createStatePool(config.stateSpaceSize);
    const baselineBuilder = buildBaselineGraph(statePool);
    const seed = config.seed ?? deterministicSeedFromConfig(config);
    const rng = new SeededRng(seed);
    const calibrationRng = new SeededRng(seed ^ 0xa5a5a5a5);
    const calibrated = calibrateBaseline(
      baselineBuilder,
      statePool,
      config.transitionsPerSession,
      calibrationRng,
    );

    const anomalyRate = clamp(config.anomalySessionRate ?? 0.2, 0, 1);
    const sessionResults: SessionResult[] = [];
    const sessionReplays: SessionReplay[] = [];
    let entropyFires = 0;
    let divergenceFires = 0;

    // Shared config for per-session IntentManagers
    const managerConfig = {
      baseline: baselineBuilder.toJSON(),
      persistDebounceMs: 60_000,
      benchmark: { enabled: true },
      graph: {
        divergenceThreshold: 3.5,
        baselineMeanLL: calibrated.mean,
        baselineStdLL: calibrated.std,
      },
    };

    const startedAt = performance.now();
    // Use a fresh manager for initial memory measurement
    const firstManager = new IntentManager(managerConfig);
    const startMemory = firstManager.getPerformanceReport().memoryFootprint.serializedGraphBytes;
    let lastPerformanceReport = firstManager.getPerformanceReport();

    for (let session = 0; session < config.sessions; session += 1) {
      // Create a fresh IntentManager per session for clean evaluation.
      // This ensures entropy detection starts fresh (no cross-session pollution)
      // and divergence detection uses the fixed baseline properly.
      const manager = new IntentManager(managerConfig);

      const entropyValues: number[] = [];
      const divergenceValues: number[] = [];
      const stateSequence: string[] = [];

      const isGroundTruthHesitation = rng.next() < anomalyRate || config.mode !== 'baseline';
      let entropyTriggered = false;
      let divergenceTriggered = false;
      let detectionLatency: number | null = null;
      let hesitationAtTrigger: number | null = null;
      let currentStep = 0;

      const offEntropy = manager.on('high_entropy', (payload) => {
        entropyValues.push(payload.normalizedEntropy);
        entropyTriggered = true;
        entropyFires += 1;
        if (detectionLatency === null) {
          detectionLatency = currentStep;
          hesitationAtTrigger = payload.normalizedEntropy;
        }
      });

      const offDivergence = manager.on('trajectory_anomaly', (payload) => {
        divergenceValues.push(payload.zScore);
        divergenceTriggered = true;
        divergenceFires += 1;
        if (detectionLatency === null) {
          detectionLatency = currentStep;
          hesitationAtTrigger = payload.zScore;
        }
      });

      let current = rng.int(statePool.length);
      for (let step = 0; step < config.transitionsPerSession; step += 1) {
        currentStep = step + 1;
        const sessionEntropy = isGroundTruthHesitation
          ? clamp(config.entropyControl + 0.35, 0, 1)
          : config.entropyControl;

        current = pickNextState(statePool, current, sessionEntropy, config.mode, step, rng);
        const state = statePool[current];
        stateSequence.push(state);
        manager.track(state);
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
      sessionReplays.push({ stateSequence, entropyValues, divergenceValues });
      lastPerformanceReport = manager.getPerformanceReport();
    }

    const elapsed = performance.now() - startedAt;
    const totalTransitions = config.sessions * config.transitionsPerSession;
    const endMemory = lastPerformanceReport.memoryFootprint.serializedGraphBytes;

    return {
      seed,
      sessionReplays,
      summary: {
        totalTransitions,
        cpuMsPer10kTransitions: totalTransitions > 0 ? (elapsed / totalTransitions) * 10_000 : 0,
        memoryGrowthBytes: endMemory - startMemory,
        entropyTriggerRate: totalTransitions > 0 ? entropyFires / totalTransitions : 0,
        divergenceTriggerRate: totalTransitions > 0 ? divergenceFires / totalTransitions : 0,
        evaluation: evaluatePredictionMatrix(sessionResults),
        performanceReport: lastPerformanceReport,
      },
    };
  }
}
