/**
 * Controllable adapters for the React demo.
 * Passed into usePassiveIntent() config so every lifecycle event
 * and timer can be triggered programmatically from UI buttons —
 * no real tab-switching or waiting required.
 */

import type { LifecycleAdapter, TimerAdapter } from '@passiveintent/react';

// ─── Controllable Timer ──────────────────────────────────────────────────────

export class ControllableTimerAdapter implements TimerAdapter {
  private offset = 0;
  private nextId = 1;
  /**
   * Pending timers.  Each entry keeps:
   *   - `fn` — the callback
   *   - `firesAt` — the **virtual** timestamp when it should fire
   *   - `realId` — the real browser timer handle (for normal real-time firing)
   *
   * Normal operation: timers fire via real `globalThis.setTimeout`.
   * `fastForward()`: timers are flushed synchronously (real timer cancelled).
   */
  private pending = new Map<
    number,
    { fn: () => void; firesAt: number; realId: ReturnType<typeof globalThis.setTimeout> }
  >();

  setTimeout(fn: () => void, delay: number): number {
    const id = this.nextId++;
    const firesAt = this.now() + delay;

    // Schedule a real timer so the callback fires even without fastForward
    const realId = globalThis.setTimeout(() => {
      if (!this.pending.has(id)) return; // already flushed or cleared
      this.pending.delete(id);
      fn();
    }, delay);

    this.pending.set(id, { fn, firesAt, realId });
    return id;
  }

  clearTimeout(id: number): void {
    const entry = this.pending.get(id);
    if (entry) {
      globalThis.clearTimeout(entry.realId);
      this.pending.delete(id);
    }
  }

  now(): number {
    return performance.now() + this.offset;
  }

  /**
   * Advance the virtual clock by `ms` and **synchronously flush** every
   * pending timer whose fire-time falls within the elapsed window.
   *
   * Real browser timers are cancelled before the callback is invoked so
   * there is no double-fire.  Any new timers scheduled by flushed callbacks
   * (e.g. the lifecycle coordinator re-arming its idle-check) are tracked
   * and may themselves be flushed if they're due within the same window.
   */
  fastForward(ms: number): void {
    this.offset += ms;
    this.flushPending();
  }

  /**
   * Undo accumulated virtual clock offset.
   * Called after a simulation completes so subsequent real interactions
   * use unshifted timestamps.  Pending timers are re-scheduled with
   * fresh real browser timers relative to the current wall-clock.
   */
  resetOffset(): void {
    const oldNow = this.now();
    this.offset = 0;
    const newNow = this.now();

    // Re-schedule every pending timer so its real browser timer reflects
    // the reset.  The virtual firesAt is kept the same; we only adjust the
    // real delay so the callback fires at the right wall-clock moment.
    for (const [id, entry] of this.pending) {
      globalThis.clearTimeout(entry.realId);
      const remaining = Math.max(0, entry.firesAt - oldNow);
      // Shift firesAt into the new timeline
      const newFiresAt = newNow + remaining;
      const realId = globalThis.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        entry.fn();
      }, remaining);
      this.pending.set(id, { fn: entry.fn, firesAt: newFiresAt, realId });
    }
  }

  reset(): void {
    for (const entry of this.pending.values()) {
      globalThis.clearTimeout(entry.realId);
    }
    this.pending.clear();
    this.offset = 0;
  }

  /** Flush all pending timers whose fire-time ≤ now(), in chronological order. */
  private flushPending(): void {
    let iterations = 0;
    const MAX_FLUSH = 500;
    while (iterations++ < MAX_FLUSH) {
      const now = this.now();
      let earliest: {
        id: number;
        entry: {
          fn: () => void;
          firesAt: number;
          realId: ReturnType<typeof globalThis.setTimeout>;
        };
      } | null = null;
      for (const [id, entry] of this.pending) {
        if (entry.firesAt <= now && (!earliest || entry.firesAt < earliest.entry.firesAt)) {
          earliest = { id, entry };
        }
      }
      if (!earliest) break;
      globalThis.clearTimeout(earliest.entry.realId);
      this.pending.delete(earliest.id);
      earliest.entry.fn();
    }
  }
}

// ─── Controllable Lifecycle ──────────────────────────────────────────────────

export class ControllableLifecycleAdapter implements LifecycleAdapter {
  private pauseCbs: Array<() => void> = [];
  private resumeCbs: Array<() => void> = [];
  private interactionCbs: Array<() => void> = [];
  private exitIntentCbs: Array<() => void> = [];

  // Also wire the real browser Page Visibility API so genuine tab switches work
  private visibilityHandler = () => {
    if (document.hidden) this.triggerPause();
    else this.triggerResume();
  };
  private exitHandler = (e: MouseEvent) => {
    if (e.clientY <= 0) this.triggerExitIntent();
  };

  constructor() {
    document.addEventListener('visibilitychange', this.visibilityHandler);
    document.documentElement.addEventListener('mouseleave', this.exitHandler as EventListener);
  }

  // ── Manual triggers (called by demo buttons) ────────────────────────────
  triggerPause() {
    this.pauseCbs.forEach((cb) => cb());
  }
  triggerResume() {
    this.resumeCbs.forEach((cb) => cb());
  }
  triggerInteraction() {
    this.interactionCbs.forEach((cb) => cb());
  }
  triggerExitIntent() {
    this.exitIntentCbs.forEach((cb) => cb());
  }

  // ── LifecycleAdapter interface ──────────────────────────────────────────
  onPause(cb: () => void) {
    this.pauseCbs.push(cb);
    return () => {
      const i = this.pauseCbs.indexOf(cb);
      if (i >= 0) this.pauseCbs.splice(i, 1);
    };
  }
  onResume(cb: () => void) {
    this.resumeCbs.push(cb);
    return () => {
      const i = this.resumeCbs.indexOf(cb);
      if (i >= 0) this.resumeCbs.splice(i, 1);
    };
  }
  onInteraction(cb: () => void) {
    this.interactionCbs.push(cb);
    return () => {
      const i = this.interactionCbs.indexOf(cb);
      if (i >= 0) this.interactionCbs.splice(i, 1);
    };
  }
  onExitIntent(cb: () => void) {
    this.exitIntentCbs.push(cb);
    return () => {
      const i = this.exitIntentCbs.indexOf(cb);
      if (i >= 0) this.exitIntentCbs.splice(i, 1);
    };
  }
  destroy() {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    document.documentElement.removeEventListener('mouseleave', this.exitHandler as EventListener);
    this.pauseCbs = [];
    this.resumeCbs = [];
    this.interactionCbs = [];
    this.exitIntentCbs = [];
  }
}

// Singletons — created once per app lifetime, passed via context
export const timerAdapter = new ControllableTimerAdapter();
export const lifecycleAdapter = new ControllableLifecycleAdapter();
