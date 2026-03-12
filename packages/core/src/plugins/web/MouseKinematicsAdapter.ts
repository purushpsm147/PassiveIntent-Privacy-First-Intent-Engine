/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * MouseKinematicsAdapter — web plugin for IInputAdapter
 * --------------------------------------------------------
 * Converts browser navigation and pointer/scroll physics into the engine's
 * canonical state string stream.
 *
 * Two classes of state are emitted:
 *
 *   1. **Navigation states** — emitted on `popstate` / `hashchange` events
 *      and on first `subscribe()` call.  State label = `location.pathname`.
 *
 *   2. **Scroll-depth sub-states** — emitted when the user crosses a scroll
 *      depth threshold within the current page.  State label format:
 *      `{pathname}@scroll.{percent}` (e.g. `/product/details@scroll.50`).
 *      Thresholds: 25 %, 50 %, 75 %, 100 %.
 *
 *   3. **Mouse-velocity states** — emitted when the pointer velocity crosses
 *      the boundary between "scanning" (fast) and "focused" (slow/stopped).
 *      State labels: `{pathname}@velocity.scanning`, `{pathname}@velocity.focused`.
 *      This gives the intent engine a signal for reading-depth vs. rapid browsing.
 *
 * All DOM access is guarded so the module is safe to import in SSR/Node.js
 * environments (subscribe will be a no-op and return a no-op unsubscriber).
 *
 * Usage:
 * ```ts
 * const engine = new IntentEngine({
 *   input: new MouseKinematicsAdapter(),
 *   // …
 * });
 * ```
 */

import type { IInputAdapter } from '../../types/microkernel.js';

/** Scroll depth thresholds at which sub-states are emitted (percent). */
const SCROLL_THRESHOLDS = [25, 50, 75, 100] as const;

/** Pointer velocity (px/ms) below which the user is considered "focused". */
const FOCUSED_VELOCITY_THRESHOLD = 0.3;

/** Minimum interval between mousemove velocity samples (ms). */
const VELOCITY_SAMPLE_INTERVAL_MS = 200;

/** Debounce delay for scroll depth evaluation (ms). */
const SCROLL_DEBOUNCE_MS = 150;

export class MouseKinematicsAdapter implements IInputAdapter {
  private callback: ((state: string) => void) | null = null;

  /** Registered DOM event removers — collected in subscribe(), drained in destroy(). */
  private readonly cleanups: Array<() => void> = [];

  /* ── Scroll tracking ─────────────────────────────────────────── */
  /** Last scroll threshold percent that was emitted. */
  private lastScrollPercent: number = -1;
  private scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /* ── Mouse velocity tracking ─────────────────────────────────── */
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMouseTime = 0;
  /** Last velocity zone emitted: 'scanning' | 'focused' | null (not yet emitted). */
  private lastVelocityZone: 'scanning' | 'focused' | null = null;

  /* ── Current page path ───────────────────────────────────────── */
  private currentPath = '';

  /* ================================================================= */
  /*  IInputAdapter                                                      */
  /* ================================================================= */

  subscribe(onState: (state: string) => void): () => void {
    if (typeof window === 'undefined') {
      // SSR / non-browser: return a no-op unsubscriber.
      return () => {};
    }

    this.callback = onState;
    this.currentPath = window.location.pathname;
    this.lastScrollPercent = -1;
    this.lastVelocityZone = null;

    // ── Emit initial page state ──────────────────────────────────────
    // Deferred via queueMicrotask so callers can register engine.on() listeners
    // before the first state_change fires.  The engine constructor calls
    // subscribe() synchronously, meaning any .on() registrations that happen
    // after createBrowserIntent() returns would otherwise miss this event.
    queueMicrotask(() => onState(this.currentPath));

    // ── Navigation events ────────────────────────────────────────────
    // Covers back/forward (popstate) and hash-based routing (hashchange).
    //
    // NOTE — push-state SPAs (React Router, Next.js App Router, Vue Router, …)
    // use history.pushState / history.replaceState, which do NOT fire popstate.
    // Monkeypatching those methods is intentionally avoided here: it produces
    // global side-effects that compose poorly when multiple adapters or routers
    // are present on the same page.
    //
    // For push-state SPAs, use one of:
    //   1. A custom IInputAdapter that calls `engine.track()` inside the
    //      router's navigation hook (e.g. React Router `history.listen`,
    //      Vue Router `router.afterEach`, Next.js `router.events.on`).
    //   2. The raw IntentEngine path: `new IntentEngine({ input: myAdapter })`.
    const onPopState = (): void => this.handleNavigation();
    const onHashChange = (): void => this.handleNavigation();

    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
    this.cleanups.push(() => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
    });

    // ── Scroll depth events ──────────────────────────────────────────
    const onScroll = (): void => this.scheduleScrollEvaluation();

    window.addEventListener('scroll', onScroll, { passive: true });
    this.cleanups.push(() => window.removeEventListener('scroll', onScroll));

    // ── Mouse velocity events ────────────────────────────────────────
    const onMouseMove = (e: MouseEvent): void => this.sampleMouseVelocity(e);

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    this.cleanups.push(() => window.removeEventListener('mousemove', onMouseMove));

    return () => this.teardown();
  }

  destroy(): void {
    this.teardown();
  }

  /* ================================================================= */
  /*  Navigation                                                         */
  /* ================================================================= */

  private handleNavigation(): void {
    if (typeof window === 'undefined') return;

    this.currentPath = window.location.pathname;

    // Cancel any pending scroll debounce from the previous page.
    if (this.scrollDebounceTimer !== null) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }

    // Reset sub-state tracking for the new page.
    this.lastScrollPercent = -1;
    this.lastVelocityZone = null;

    // Reset mouse velocity tracking to prevent stale velocity calculations.
    this.lastMouseTime = 0;
    this.lastMouseX = 0;
    this.lastMouseY = 0;

    this.emit(this.currentPath);
  }

  /* ================================================================= */
  /*  Scroll depth                                                       */
  /* ================================================================= */

  private scheduleScrollEvaluation(): void {
    if (this.scrollDebounceTimer !== null) {
      clearTimeout(this.scrollDebounceTimer);
    }
    this.scrollDebounceTimer = setTimeout(() => {
      this.scrollDebounceTimer = null;
      this.evaluateScrollDepth();
    }, SCROLL_DEBOUNCE_MS);
  }

  private evaluateScrollDepth(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const scrollY = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;

    if (docHeight <= 0) return;

    const percent = Math.min(100, Math.round((scrollY / docHeight) * 100));

    // Find the highest threshold crossed.
    let crossed: number | null = null;
    for (const threshold of SCROLL_THRESHOLDS) {
      if (percent >= threshold && threshold > this.lastScrollPercent) {
        crossed = threshold;
      }
    }

    if (crossed !== null) {
      this.lastScrollPercent = crossed;
      this.emit(`${this.currentPath}@scroll.${crossed}`);
    }
  }

  /* ================================================================= */
  /*  Mouse velocity                                                     */
  /* ================================================================= */

  private sampleMouseVelocity(e: MouseEvent): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (this.lastMouseTime === 0) {
      // First sample — seed without emitting.
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.lastMouseTime = now;
      return;
    }

    const dt = now - this.lastMouseTime;
    if (dt < VELOCITY_SAMPLE_INTERVAL_MS) return;

    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const velocity = distance / dt; // px/ms

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.lastMouseTime = now;

    const zone: 'scanning' | 'focused' =
      velocity >= FOCUSED_VELOCITY_THRESHOLD ? 'scanning' : 'focused';

    if (zone !== this.lastVelocityZone) {
      this.lastVelocityZone = zone;
      this.emit(`${this.currentPath}@velocity.${zone}`);
    }
  }

  /* ================================================================= */
  /*  Internal helpers                                                   */
  /* ================================================================= */

  private emit(state: string): void {
    this.callback?.(state);
  }

  private teardown(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;

    if (this.scrollDebounceTimer !== null) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }

    this.callback = null;
  }
}
