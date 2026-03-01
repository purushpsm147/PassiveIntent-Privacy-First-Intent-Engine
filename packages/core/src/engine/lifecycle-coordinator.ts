/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BrowserLifecycleAdapter } from '../adapters.js';
import type { LifecycleAdapter, TimerAdapter } from '../adapters.js';
import { EventEmitter } from './event-emitter.js';
import type { IntentEventMap } from '../types/events.js';
import { MAX_PLAUSIBLE_DWELL_MS } from './constants.js';

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
 */
export class LifecycleCoordinator {
  private readonly timer: TimerAdapter;
  private readonly dwellTimeEnabled: boolean;
  private readonly emitter: EventEmitter<IntentEventMap>;
  private readonly onAdjustBaseline: (delta: number) => void;
  private readonly onResetBaseline: () => void;
  private readonly hasPreviousState: () => boolean;

  private lifecycleAdapter: LifecycleAdapter | null;
  private ownsLifecycleAdapter: boolean;
  private pauseUnsub: (() => void) | null = null;
  private resumeUnsub: (() => void) | null = null;

  /** Timestamp when the tab last became hidden; `null` while visible. */
  private tabHiddenAt: number | null = null;

  constructor(config: LifecycleCoordinatorConfig) {
    this.timer = config.timer;
    this.dwellTimeEnabled = config.dwellTimeEnabled;
    this.emitter = config.emitter;
    this.onAdjustBaseline = config.onAdjustBaseline;
    this.onResetBaseline = config.onResetBaseline;
    this.hasPreviousState = config.hasPreviousState;

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

    if (!adapter) return;

    this.pauseUnsub = adapter.onPause(() => {
      this.tabHiddenAt = this.timer.now();
    });

    this.resumeUnsub = adapter.onResume(() => {
      if (this.tabHiddenAt === null) return;
      const hiddenDuration = this.timer.now() - this.tabHiddenAt;
      this.tabHiddenAt = null;

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
    this.pauseUnsub?.();
    this.pauseUnsub = null;
    this.resumeUnsub?.();
    this.resumeUnsub = null;
    if (this.ownsLifecycleAdapter) {
      this.lifecycleAdapter?.destroy();
    }
  }
}
