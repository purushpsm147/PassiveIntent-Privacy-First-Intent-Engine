/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * IntentEngine — Layer 2 Microkernel
 * --------------------------------------------------------
 * The raw, platform-agnostic intent detection kernel.
 *
 * This class has ZERO hardcoded references to `window`, `document`, or
 * `localStorage`.  Every platform concern is delegated to the four adapter
 * interfaces supplied in `IntentEngineConfig`:
 *
 *   - IInputAdapter      — push-based navigation events from the host domain
 *   - ILifecycleAdapter  — pause / resume / exit-intent lifecycle signals
 *   - IStateModel        — Markov graph + Bloom filter signal evaluation
 *   - IPersistenceAdapter — key-value storage I/O
 *
 * Layer 3 (`IntentManager`) wraps this kernel and wires in browser-specific
 * implementations for environments that have a DOM.  All existing
 * `IntentManager` behavior is preserved — this class does not replace it.
 */

import type {
  IntentEngineConfig,
  IInputAdapter,
  ILifecycleAdapter,
  IStateModel,
  IPersistenceAdapter,
} from '../types/microkernel.js';
import type { IntentEventMap } from '../types/events.js';
import { EventEmitter } from './event-emitter.js';
import { normalizeRouteState } from '../utils/route-normalizer.js';

/** Maximum trajectory window kept for signal evaluation. */
const TRAJECTORY_WINDOW = 20;

export class IntentEngine {
  private readonly emitter = new EventEmitter<IntentEventMap>();
  private readonly stateModel: IStateModel;
  private readonly persistence: IPersistenceAdapter;
  private readonly lifecycle: ILifecycleAdapter;
  private readonly input: IInputAdapter | undefined;
  private readonly storageKey: string;
  private readonly stateNormalizer: ((state: string) => string) | undefined;
  private readonly onError: ((error: { code: string; message: string }) => void) | undefined;

  /** Unsubscribe functions collected during construction, released in destroy(). */
  private readonly teardowns: Array<() => void> = [];

  /** Most recently tracked state. */
  private previousState: string | null = null;
  /** Rolling window of recently visited states for trajectory evaluation. */
  private recentTrajectory: string[] = [];

  constructor(config: IntentEngineConfig) {
    this.stateModel = config.stateModel;
    this.persistence = config.persistence;
    this.lifecycle = config.lifecycle;
    this.input = config.input;
    this.storageKey = config.storageKey ?? 'passive-intent-engine';
    this.stateNormalizer = config.stateNormalizer;
    this.onError = config.onError;

    // ── 1. Restore persisted model state ──────────────────────────────────────
    let raw: string | null = null;
    try {
      raw = this.persistence.load(this.storageKey);
    } catch (err) {
      this.onError?.({
        code: 'RESTORE_READ',
        message: `IntentEngine: failed to read persisted state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    if (raw !== null) {
      try {
        this.stateModel.restore(raw);
      } catch (err) {
        this.onError?.({
          code: 'RESTORE_PARSE',
          message: `IntentEngine: failed to restore persisted state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    // ── 2. Subscribe to IInputAdapter (push-based navigation) ─────────────────
    if (this.input) {
      try {
        const unsubInput = this.input.subscribe((state) => this._processState(state));
        this.teardowns.push(unsubInput);
      } catch (err) {
        this.onError?.({
          code: 'ADAPTER_SETUP',
          message: `IntentEngine: input.subscribe() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    // ── 3. Wire ILifecycleAdapter ──────────────────────────────────────────────
    // Persist on pause so state survives app backgrounding / tab hide.
    try {
      this.teardowns.push(
        this.lifecycle.onPause(() => {
          this._persist();
        }),
      );
    } catch (err) {
      this.onError?.({
        code: 'ADAPTER_SETUP',
        message: `IntentEngine: lifecycle.onPause() threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    // Exit-intent: only fire when the graph has a likely continuation path.
    if (typeof this.lifecycle.onExitIntent === 'function') {
      try {
        this.teardowns.push(
          this.lifecycle.onExitIntent(() => {
            if (this.previousState === null) return;
            let candidates: { state: string; probability: number }[] = [];
            try {
              candidates = this.stateModel.getLikelyNext(this.previousState, 0.4);
            } catch (err) {
              this.onError?.({
                code: 'STATE_MODEL',
                message: `IntentEngine: stateModel.getLikelyNext() threw: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
            }
            if (candidates.length === 0) return;
            this.emitter.emit('exit_intent', {
              state: this.previousState,
              likelyNext: candidates[0].state,
            });
          }),
        );
      } catch (err) {
        this.onError?.({
          code: 'ADAPTER_SETUP',
          message: `IntentEngine: lifecycle.onExitIntent() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Subscribe to an intent event.
   *
   * ```ts
   * const off = engine.on('high_entropy', ({ state, normalizedEntropy }) => {
   *   console.log(`High entropy in state ${state}: ${normalizedEntropy}`);
   * });
   * // later…
   * off(); // unsubscribe
   * ```
   *
   * @returns An unsubscribe function.
   */
  on<K extends keyof IntentEventMap>(
    event: K,
    listener: (payload: IntentEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /**
   * Manually track a state transition.
   *
   * Use this when no `IInputAdapter` is provided, or to supplement automatic
   * navigation tracking with custom application events.
   *
   * The state is normalized via `normalizeRouteState()` before processing.
   *
   * ```ts
   * engine.track('/checkout/review');
   * ```
   */
  track(state: string): void {
    this._processState(state);
  }

  /**
   * Tear down the engine: flush pending state, unsubscribe all listeners,
   * and release adapter resources.
   *
   * Call this in SPA cleanup paths (React `useEffect` return, Vue
   * `onUnmounted`, Angular `ngOnDestroy`).
   */
  destroy(): void {
    this._persist();
    for (const teardown of this.teardowns) {
      try {
        teardown();
      } catch (err) {
        this.onError?.({
          code: 'ADAPTER_TEARDOWN',
          message: `IntentEngine: teardown threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
    try {
      this.lifecycle.destroy();
    } catch (err) {
      this.onError?.({
        code: 'ADAPTER_TEARDOWN',
        message: `IntentEngine: lifecycle.destroy() threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    if (this.input) {
      try {
        this.input.destroy();
      } catch (err) {
        this.onError?.({
          code: 'ADAPTER_TEARDOWN',
          message: `IntentEngine: input.destroy() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
    this.emitter.removeAll();
  }

  /* ------------------------------------------------------------------ */
  /*  Private pipeline                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Core processing pipeline.  Called by both the `IInputAdapter` push path
   * and the manual `track()` call path.
   *
   * Steps:
   *   1. Normalize state label
   *   2. Update state model (markSeen + recordTransition)
   *   3. Evaluate entropy signal → emit `high_entropy` if triggered
   *   4. Evaluate trajectory signal → emit `trajectory_anomaly` if triggered
   *   5. Emit `state_change`
   *   6. Persist model state
   */
  private _processState(raw: string): void {
    // ── Normalize ────────────────────────────────────────────────────────────
    let state = normalizeRouteState(raw);

    if (this.stateNormalizer) {
      try {
        const normalized = this.stateNormalizer(state);
        if (typeof normalized !== 'string') {
          this.onError?.({
            code: 'VALIDATION',
            message: `IntentEngine.track(): stateNormalizer must return a string, got ${typeof normalized}`,
          });
          return;
        }
        // Empty string is a deliberate "skip this state" signal.
        if (normalized === '') return;
        state = normalized;
      } catch (err) {
        this.onError?.({
          code: 'VALIDATION',
          message: `IntentEngine.track(): stateNormalizer threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        return;
      }
    }

    if (state === '') {
      this.onError?.({
        code: 'VALIDATION',
        message: 'IntentEngine.track(): state label must not be an empty string',
      });
      return;
    }

    const from = this.previousState;

    // ── Update state model ────────────────────────────────────────────────────
    // markSeen / recordTransition are state mutations — if either throws we abort
    // this track() call entirely.  previousState has NOT been advanced yet so the
    // engine state remains consistent.
    try {
      this.stateModel.markSeen(state);
    } catch (err) {
      this.onError?.({
        code: 'STATE_MODEL',
        message: `IntentEngine: stateModel.markSeen() threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }
    if (from !== null) {
      try {
        this.stateModel.recordTransition(from, state);
      } catch (err) {
        this.onError?.({
          code: 'STATE_MODEL',
          message: `IntentEngine: stateModel.recordTransition() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        return;
      }
    }

    // Advance internal position before evaluation so signals see the new state.
    this.previousState = state;
    this.recentTrajectory.push(state);
    if (this.recentTrajectory.length > TRAJECTORY_WINDOW) this.recentTrajectory.shift();

    // ── Signal evaluation (transition-dependent) ─────────────────────────────
    // Evaluation methods are read-only — if they throw we skip that signal and
    // continue so state_change and persistence still fire.
    if (from !== null) {
      // Entropy signal
      let entropyResult = { entropy: 0, normalizedEntropy: 0, isHigh: false };
      try {
        entropyResult = this.stateModel.evaluateEntropy(state);
      } catch (err) {
        this.onError?.({
          code: 'STATE_MODEL',
          message: `IntentEngine: stateModel.evaluateEntropy() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (entropyResult.isHigh) {
        this.emitter.emit('high_entropy', {
          state,
          entropy: entropyResult.entropy,
          normalizedEntropy: entropyResult.normalizedEntropy,
        });
      }

      // Trajectory anomaly signal
      let trajectoryResult = null;
      try {
        trajectoryResult = this.stateModel.evaluateTrajectory(from, state, this.recentTrajectory);
      } catch (err) {
        this.onError?.({
          code: 'STATE_MODEL',
          message: `IntentEngine: stateModel.evaluateTrajectory() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (trajectoryResult !== null && trajectoryResult.isAnomalous) {
        const sampleSize = trajectoryResult.sampleSize;
        this.emitter.emit('trajectory_anomaly', {
          stateFrom: from,
          stateTo: state,
          realLogLikelihood: trajectoryResult.logLikelihood,
          expectedBaselineLogLikelihood: trajectoryResult.baselineLogLikelihood,
          zScore: trajectoryResult.zScore,
          sampleSize,
          confidence: sampleSize < 10 ? 'low' : sampleSize < 30 ? 'medium' : 'high',
        });
      }
    }

    // ── Emit state_change (always) ────────────────────────────────────────────
    this.emitter.emit('state_change', { from, to: state });

    // ── Persist ───────────────────────────────────────────────────────────────
    this._persist();
  }

  /** Serialize and save model state via IPersistenceAdapter. */
  private _persist(): void {
    try {
      this.persistence.save(this.storageKey, this.stateModel.serialize());
    } catch (err) {
      this.onError?.({
        code: 'STORAGE_WRITE',
        message: `IntentEngine: persistence.save() threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
}
