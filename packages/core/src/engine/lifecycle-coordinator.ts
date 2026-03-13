/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BrowserLifecycleAdapter } from '../adapters.js';
import type { LifecycleAdapter, TimerAdapter, TimerHandle } from '../adapters.js';
import { EventEmitter } from './event-emitter.js';
import type { IntentEventMap } from '../types/events.js';
import {
  ATTENTION_RETURN_THRESHOLD_MS,
  MAX_PLAUSIBLE_DWELL_MS,
  USER_IDLE_THRESHOLD_MS,
} from './constants.js';

/**
 * Configuration for LifecycleCoordinator.
 *
 * All callbacks are supplied by IntentManager and run synchronously
 * inside the onResume handler — no closure captures of coordinator internals.
 */
export interface LifecycleCoordinatorConfig {
  /**
   * Optional pre-built adapter.  When `undefined` (not set), a new
   * `BrowserLifecycleAdapter` is created internally (and owned).  Explicitly
   * passing `null` disables lifecycle tracking entirely.
   *
   * The `undefined` vs. `null` distinction is intentional and mirrors the
   * original `IntentManager` constructor behaviour.
   */
  lifecycleAdapter?: LifecycleAdapter | null;
  timer: TimerAdapter;
  dwellTimeEnabled: boolean;
  emitter: EventEmitter<IntentEventMap>;
  /**
   * Called on resume when the hidden duration was within the plausible range.
   * IntentManager should execute: `previousStateEnteredAt += delta`.
   */
  onAdjustBaseline: (delta: number) => void;
  /**
   * Called on resume when the hidden duration exceeded `MAX_PLAUSIBLE_DWELL_MS`.
   * IntentManager should execute: `previousStateEnteredAt = timer.now()`.
   */
  onResetBaseline: () => void;
  /**
   * Returns whether the engine has an active dwell epoch in progress.
   * Translates to `previousState !== null` in IntentManager.
   */
  hasPreviousState: () => boolean;
  /**
   * Returns the current state the user is viewing, or `null` when no state
   * has been entered yet.  Used by the comparison-shopper detection path.
   */
  getPreviousState: () => string | null;
  /**
   * Called when exit intent is detected and Markov math confirms a
   * likely continuation path.  Supplied by `IntentManager` which performs
   * the probability check and emits the `exit_intent` event.
   *
   * Optional — when absent, exit-intent detection is disabled even if the
   * underlying `LifecycleAdapter` supports `onExitIntent`.
   */
  onExitIntent?: () => void;
}

/**
 * LifecycleCoordinator — owns pause/resume handling and session-stale detection.
 *
 * Responsibilities:
 *   - Creates or accepts an injected `LifecycleAdapter`
 *   - On tab hide (pause): records `tabHiddenAt`
 *   - On tab show (resume):
 *     - Computes hidden duration
 *     - When within plausible range: calls `onAdjustBaseline(duration)` to
 *       offset `previousStateEnteredAt` so the dwell clock ignores off-screen time
 *     - When duration exceeds `MAX_PLAUSIBLE_DWELL_MS` (OS suspend / hibernate):
 *       calls `onResetBaseline()` and emits `session_stale`
 *     - Both paths are skipped when `dwellTimeEnabled` is `false`
 *   - `destroy()`: deregisters callbacks and (conditionally) tears down the adapter
 *   - Idle detection (when the adapter supports `onInteraction`):
 *     - Resets a `USER_IDLE_THRESHOLD_MS` debounce timer on every interaction
 *     - Emits `user_idle` when the timer fires (no interaction for that duration)
 *     - Emits `user_resumed` on the first interaction after an idle period
 *     - Adjusts the dwell baseline to exclude idle duration
 */
export class LifecycleCoordinator {
  private readonly timer: TimerAdapter;
  private readonly dwellTimeEnabled: boolean;
  private readonly emitter: EventEmitter<IntentEventMap>;
  private readonly onAdjustBaseline: (delta: number) => void;
  private readonly onResetBaseline: () => void;
  private readonly hasPreviousState: () => boolean;
  private readonly getPreviousState: () => string | null;

  private lifecycleAdapter: LifecycleAdapter | null;
  private ownsLifecycleAdapter: boolean;
  private pauseUnsub: (() => void) | null = null;
  private resumeUnsub: (() => void) | null = null;
  private exitIntentUnsub: (() => void) | null = null;

  /** Timestamp when the tab last became hidden; `null` while visible. */
  private tabHiddenAt: number | null = null;

  /* ── Idle-state detection ───────────────────────────────────────────── */
  private lastInteractionAt: number;
  private idleStartedAt: number = 0;
  private isIdle: boolean = false;
  private idleCheckTimer: TimerHandle | null = null;
  private interactionUnsub: (() => void) | null = null;

  private readonly onExitIntentCallback: (() => void) | undefined;

  constructor(config: LifecycleCoordinatorConfig) {
    this.timer = config.timer;
    this.dwellTimeEnabled = config.dwellTimeEnabled;
    this.emitter = config.emitter;
    this.onAdjustBaseline = config.onAdjustBaseline;
    this.onResetBaseline = config.onResetBaseline;
    this.hasPreviousState = config.hasPreviousState;
    this.getPreviousState = config.getPreviousState;
    this.lastInteractionAt = this.timer.now();

    this.onExitIntentCallback = config.onExitIntent;

    // Preserve the exact undefined-vs-null semantics from the original constructor:
    //   - undefined → create a BrowserLifecycleAdapter (owned by this coordinator)
    //   - null      → no adapter; lifecycle tracking disabled
    //   - object    → injected adapter; this coordinator does NOT own it
    if (config.lifecycleAdapter !== undefined) {
      this.lifecycleAdapter = config.lifecycleAdapter;
      this.ownsLifecycleAdapter = false;
    } else {
      this.lifecycleAdapter = typeof window !== 'undefined' ? new BrowserLifecycleAdapter() : null;
      this.ownsLifecycleAdapter = true;
    }

    this.bindAdapter(this.lifecycleAdapter);
  }

  /**
   * Unsubscribe any existing pause/resume callbacks and re-register them on
   * `adapter` (or leave them null when `adapter` is null).
   *
   * Single source of truth for handler registration — used by both the
   * constructor and `setAdapterForTest`.
   */
  private bindAdapter(adapter: LifecycleAdapter | null): void {
    this.pauseUnsub?.();
    this.pauseUnsub = null;
    this.resumeUnsub?.();
    this.resumeUnsub = null;
    this.exitIntentUnsub?.();
    this.exitIntentUnsub = null;
    this.stopIdleTracking();

    if (!adapter) return;

    this.pauseUnsub = adapter.onPause(() => {
      this.tabHiddenAt = this.timer.now();
    });

    this.resumeUnsub = adapter.onResume(() => {
      if (this.tabHiddenAt === null) return;
      const hiddenDuration = this.timer.now() - this.tabHiddenAt;
      this.tabHiddenAt = null;

      // ── Comparison-shopper detection (attention_return) ─────────────────
      // When the user returns after ≥15 s and was viewing a known state,
      // emit an attention_return event so the host app can surface a
      // "Welcome Back" experience (e.g. discount modal).
      if (hiddenDuration >= ATTENTION_RETURN_THRESHOLD_MS) {
        const currentState = this.getPreviousState();
        if (currentState !== null) {
          this.emitter.emit('attention_return', {
            state: currentState,
            hiddenDuration,
          });
        }
      }

      // All resume-path operations are dwell-time bookkeeping.  When dwell-time
      // detection is disabled the caller has opted out of all dwell diagnostics.
      if (!this.dwellTimeEnabled) return;

      if (hiddenDuration > MAX_PLAUSIBLE_DWELL_MS) {
        // Almost certainly an OS suspend / hibernate event.  Only act when an
        // active dwell epoch is in progress.
        if (this.hasPreviousState()) {
          this.onResetBaseline();
          this.emitter.emit('session_stale', {
            reason: 'hidden_duration_exceeded',
            measuredMs: hiddenDuration,
            thresholdMs: MAX_PLAUSIBLE_DWELL_MS,
          });
        }
        return;
      }

      // Offset the dwell baseline only when a state has been entered.
      if (this.hasPreviousState()) {
        this.onAdjustBaseline(hiddenDuration);
      }
    });

    this.startIdleTracking(adapter);

    // Subscribe to exit-intent detection when the adapter supports it and the
    // coordinator has been given a callback to invoke.
    if (this.onExitIntentCallback !== undefined && typeof adapter.onExitIntent === 'function') {
      this.exitIntentUnsub = adapter.onExitIntent(() => {
        this.onExitIntentCallback!();
      });
    }
  }

  /**
   * @internal — test-only hook. Replaces the active lifecycle adapter after
   * construction: unsubscribes the coordinator's pause/resume callbacks from
   * the previous adapter, swaps in the new one, and re-registers the same
   * handlers on the new adapter (or leaves them null when `adapter` is null).
   *
   * Do NOT call this in production code; injecting the adapter via
   * `LifecycleCoordinatorConfig.lifecycleAdapter` is the correct approach.
   */
  /* @internal */
  setAdapterForTest(adapter: LifecycleAdapter | null, owns: boolean): void {
    if (this.ownsLifecycleAdapter) {
      this.lifecycleAdapter?.destroy();
    }
    this.lifecycleAdapter = adapter;
    this.ownsLifecycleAdapter = owns;
    this.tabHiddenAt = null;
    this.isIdle = false;
    this.lastInteractionAt = this.timer.now();
    this.exitIntentUnsub?.();
    this.exitIntentUnsub = null;
    this.bindAdapter(adapter);
  }

  /**
   * Deregister this instance's specific pause/resume callbacks and, if this
   * coordinator owns its adapter, destroy it.
   *
   * Injected (shared) adapters are NOT destroyed here — they may serve other
   * `IntentManager` instances and must be torn down by their owner.
   */
  destroy(): void {
    this.stopIdleTracking();
    this.pauseUnsub?.();
    this.pauseUnsub = null;
    this.resumeUnsub?.();
    this.resumeUnsub = null;
    this.exitIntentUnsub?.();
    this.exitIntentUnsub = null;
    if (this.ownsLifecycleAdapter) {
      this.lifecycleAdapter?.destroy();
    }
  }

  /* ── Idle-state detection internals ────────────────────────────────── */

  /**
   * Set up the interaction subscription and debounce-based idle detection.
   * Gracefully skips when the adapter does not implement `onInteraction`.
   *
   * Every interaction resets a `USER_IDLE_THRESHOLD_MS` one-shot timer.
   * When the timer fires without being cancelled, the user is considered idle.
   */
  private startIdleTracking(adapter: LifecycleAdapter | null): void {
    if (!adapter || typeof adapter.onInteraction !== 'function') return;

    const armIdleTimer = (): void => {
      if (this.idleCheckTimer !== null) {
        this.timer.clearTimeout(this.idleCheckTimer);
      }
      this.idleCheckTimer = this.timer.setTimeout(() => {
        this.idleCheckTimer = null;
        if (this.isIdle || !this.hasPreviousState()) return;

        this.isIdle = true;
        this.idleStartedAt = this.lastInteractionAt + USER_IDLE_THRESHOLD_MS;

        const currentState = this.getPreviousState();
        if (currentState !== null) {
          this.emitter.emit('user_idle', {
            state: currentState,
            idleMs: this.timer.now() - this.idleStartedAt,
          });
        }
      }, USER_IDLE_THRESHOLD_MS);
    };

    const unsub = adapter.onInteraction(() => {
      this.lastInteractionAt = this.timer.now();

      if (this.isIdle) {
        const idleMs = this.timer.now() - this.idleStartedAt;
        this.isIdle = false;

        // Exclude the idle period from the dwell clock.
        if (this.dwellTimeEnabled && this.hasPreviousState()) {
          this.onAdjustBaseline(idleMs);
        }

        const currentState = this.getPreviousState();
        if (currentState !== null) {
          this.emitter.emit('user_resumed', {
            state: currentState,
            idleMs,
          });
        }
      }

      armIdleTimer();
    });

    // The adapter returned null — it cannot deliver interaction events
    // (e.g. SSR / Node.js with a stubbed window).  Skip idle tracking.
    if (!unsub) return;

    this.interactionUnsub = unsub;
    // Arm the initial timer so idle is detected even with no interactions.
    armIdleTimer();
  }

  /** Tear down the interaction listener and idle-check timer. */
  private stopIdleTracking(): void {
    this.interactionUnsub?.();
    this.interactionUnsub = null;
    if (this.idleCheckTimer !== null) {
      this.timer.clearTimeout(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }
}
