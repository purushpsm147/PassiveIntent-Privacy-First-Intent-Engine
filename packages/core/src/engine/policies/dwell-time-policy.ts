/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { EnginePolicy, PolicyTrackContext } from './engine-policy.js';
import type { EventEmitter } from '../event-emitter.js';
import type { IntentEventMap } from '../../types/events.js';
import { MAX_PLAUSIBLE_DWELL_MS } from '../constants.js';

/**
 * Dependencies injected by IntentManager at construction time.
 */
export interface DwellTimePolicyConfig {
  /** Returns `true` when the EntropyGuard flags the session as a bot. */
  isSuspected: () => boolean;
  /** Delegate — forwards the measured dwell to SignalEngine's Welford accumulator. */
  evaluateDwellTime: (state: string, dwellMs: number) => void;
  /** Returns the timestamp when the previous state was entered. */
  getPreviousStateEnteredAt: () => number;
  /** Shared event emitter for `session_stale` emission. */
  emitter: EventEmitter<IntentEventMap>;
}

/**
 * DwellTimePolicy — gates and measures dwell-time on each state transition.
 *
 * Replaces the inline `if (this.dwellTimeEnabled && …)` conditional that was
 * previously in `IntentManager.runTransitionContextStage`.  When this policy
 * is **not** instantiated (because `dwellTime.enabled` is `false`), no
 * dwell-time logic executes at all.
 *
 * Responsibilities:
 *   - Measure elapsed time since the previous state was entered.
 *   - Guard against implausibly large dwell durations caused by OS suspend
 *     (emits `session_stale` with `reason: 'dwell_exceeded'`).
 *   - Delegate valid measurements to `SignalEngine.evaluateDwellTime()`.
 *   - Skip evaluation when the session is flagged as a suspected bot.
 */
export class DwellTimePolicy implements EnginePolicy {
  private readonly isSuspected: () => boolean;
  private readonly evaluateDwellTime: (state: string, dwellMs: number) => void;
  private readonly getPreviousStateEnteredAt: () => number;
  private readonly emitter: EventEmitter<IntentEventMap>;

  constructor(config: DwellTimePolicyConfig) {
    this.isSuspected = config.isSuspected;
    this.evaluateDwellTime = config.evaluateDwellTime;
    this.getPreviousStateEnteredAt = config.getPreviousStateEnteredAt;
    this.emitter = config.emitter;
  }

  onTrackContext(ctx: PolicyTrackContext): void {
    if (!ctx.from || this.isSuspected()) return;

    const dwellMs = ctx.now - this.getPreviousStateEnteredAt();

    if (dwellMs > MAX_PLAUSIBLE_DWELL_MS) {
      // Implausibly large dwell — CPU suspend or OS hibernation slipped past
      // the LifecycleAdapter.  Discard the measurement and emit a diagnostic
      // event.
      //
      // CONTRACT: IntentManager.runTransitionContextStage unconditionally sets
      // `previousStateEnteredAt = ctx.now` immediately after all onTrackContext
      // hooks complete (including this one), so the stale baseline is always
      // cleared regardless of which branch executes here.  If that ordering
      // ever changes, this branch must perform the reset explicitly.
      this.emitter.emit('session_stale', {
        reason: 'dwell_exceeded',
        measuredMs: dwellMs,
        thresholdMs: MAX_PLAUSIBLE_DWELL_MS,
      });
    } else {
      this.evaluateDwellTime(ctx.from, dwellMs);
    }
  }
}
