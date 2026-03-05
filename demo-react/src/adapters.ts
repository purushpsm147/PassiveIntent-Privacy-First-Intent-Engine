/**
 * Controllable adapters for the React demo.
 * Passed into usePassiveIntent() config so every lifecycle event
 * and timer can be triggered programmatically from UI buttons —
 * no real tab-switching or waiting required.
 */

import type { LifecycleAdapter, TimerAdapter } from '@passiveintent/core';

// ─── Controllable Timer ──────────────────────────────────────────────────────

export class ControllableTimerAdapter implements TimerAdapter {
  private offset = 0;
  private realIds = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;

  setTimeout(fn: () => void, delay: number): number {
    const id = this.nextId++;
    this.realIds.set(id, globalThis.setTimeout(fn, delay));
    return id;
  }
  clearTimeout(id: number): void {
    const r = this.realIds.get(id);
    if (r !== undefined) globalThis.clearTimeout(r);
    this.realIds.delete(id);
  }
  now(): number {
    return performance.now() + this.offset;
  }
  /** Advance the virtual clock without real waiting. */
  fastForward(ms: number): void {
    this.offset += ms;
  }
  reset(): void {
    this.offset = 0;
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
    document.documentElement.addEventListener(
      'mouseleave',
      this.exitHandler as EventListener,
    );
  }

  // ── Manual triggers (called by demo buttons) ────────────────────────────
  triggerPause()       { this.pauseCbs.forEach(cb => cb()); }
  triggerResume()      { this.resumeCbs.forEach(cb => cb()); }
  triggerInteraction() { this.interactionCbs.forEach(cb => cb()); }
  triggerExitIntent()  { this.exitIntentCbs.forEach(cb => cb()); }

  // ── LifecycleAdapter interface ──────────────────────────────────────────
  onPause(cb: () => void) {
    this.pauseCbs.push(cb);
    return () => { const i = this.pauseCbs.indexOf(cb); if (i >= 0) this.pauseCbs.splice(i, 1); };
  }
  onResume(cb: () => void) {
    this.resumeCbs.push(cb);
    return () => { const i = this.resumeCbs.indexOf(cb); if (i >= 0) this.resumeCbs.splice(i, 1); };
  }
  onInteraction(cb: () => void) {
    this.interactionCbs.push(cb);
    return () => { const i = this.interactionCbs.indexOf(cb); if (i >= 0) this.interactionCbs.splice(i, 1); };
  }
  onExitIntent(cb: () => void) {
    this.exitIntentCbs.push(cb);
    return () => { const i = this.exitIntentCbs.indexOf(cb); if (i >= 0) this.exitIntentCbs.splice(i, 1); };
  }
  destroy() {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    document.documentElement.removeEventListener(
      'mouseleave',
      this.exitHandler as EventListener,
    );
    this.pauseCbs = [];
    this.resumeCbs = [];
    this.interactionCbs = [];
    this.exitIntentCbs = [];
  }
}

// Singletons — created once per app lifetime, passed via context
export const timerAdapter     = new ControllableTimerAdapter();
export const lifecycleAdapter = new ControllableLifecycleAdapter();
