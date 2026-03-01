/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Isomorphic adapters for storage and timers.
 * --------------------------------------------------------
 * Allows the SDK to run safely in SSR environments (Next.js,
 * Nuxt, Remix, etc.) where `window` / `localStorage` are
 * not available at import time or at runtime.
 *
 * Browser implementations gracefully degrade to no-ops when
 * the DOM globals are absent.
 */

/* ------------------------------------------------------------------ */
/*  Storage Adapter                                                    */
/* ------------------------------------------------------------------ */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Async storage adapter for environments where storage I/O is inherently
 * asynchronous (React Native AsyncStorage, Capacitor Preferences, IndexedDB
 * wrappers, etc.).
 *
 * Use `IntentManager.createAsync(config)` to initialize the engine with an
 * async backend — the factory awaits the initial `getItem` call before
 * constructing the engine, preserving the synchronous hot-path for `track()`.
 *
 * The synchronous `StorageAdapter` interface remains the default for
 * browser `localStorage`-backed use cases.
 */
export interface AsyncStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * localStorage-backed adapter.
 * Falls back to no-ops when `window` or `localStorage` is unavailable
 * (e.g. SSR, Web Workers, or restrictive iframes).
 */
export class BrowserStorageAdapter implements StorageAdapter {
  getItem(key: string): string | null {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      // SecurityError in sandboxed iframes / opaque origins
      return null;
    }
  }

  setItem(key: string, value: string): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    // QuotaExceededError / SecurityError are intentionally NOT caught here.
    // The caller (IntentManager.persist) wraps this in its own try/catch
    // so the error surfaces through the configured onError callback.
    window.localStorage.setItem(key, value);
  }
}

/* ------------------------------------------------------------------ */
/*  Timer Adapter                                                      */
/* ------------------------------------------------------------------ */

/**
 * Opaque handle returned by the timer adapter.
 * Bridges the gap between browser (number) and Node.js (Timeout) return types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TimerHandle = any;

export interface TimerAdapter {
  setTimeout(fn: () => void, delay: number): TimerHandle;
  clearTimeout(id: TimerHandle): void;
  now(): number;
}

/**
 * Timer adapter backed by the global `setTimeout` / `clearTimeout`.
 * Uses `globalThis` so it works in browsers, Node.js, Deno, Bun, and
 * Cloudflare Workers alike.
 */
export class BrowserTimerAdapter implements TimerAdapter {
  setTimeout(fn: () => void, delay: number): TimerHandle {
    if (typeof globalThis.setTimeout !== 'function') {
      // Edge-case: extremely minimal JS runtimes without timers.
      return 0 as TimerHandle;
    }
    return globalThis.setTimeout(fn, delay);
  }

  clearTimeout(id: TimerHandle): void {
    if (typeof globalThis.clearTimeout !== 'function') return;
    globalThis.clearTimeout(id);
  }

  now(): number {
    if (
      typeof globalThis.performance !== 'undefined' &&
      typeof globalThis.performance.now === 'function'
    ) {
      return globalThis.performance.now();
    }
    return Date.now();
  }
}

/* ------------------------------------------------------------------ */
/*  In-Memory Adapter (useful for tests / SSR)                         */
/* ------------------------------------------------------------------ */

/**
 * Simple in-memory storage adapter.
 * Handy for unit tests and server-side rendering where persistence is
 * neither needed nor available.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

/* ------------------------------------------------------------------ */
/*  Lifecycle Adapter                                                  */
/* ------------------------------------------------------------------ */

/**
 * Abstracts browser DOM lifecycle events (page visibility) out of the core
 * engine so that the SDK can be used safely in React Native, Electron, and
 * server-side / SSR environments where `document` is absent.
 *
 * Implementations should call registered callbacks when the host environment
 * transitions between an active ("resumed") and an inactive ("paused") state.
 */
export interface LifecycleAdapter {
  /**
   * Register a callback to be invoked when the environment becomes inactive.
   * Returns an unsubscribe function that removes only this callback, leaving
   * any other registered callbacks untouched.
   */
  onPause(callback: () => void): () => void;
  /**
   * Register a callback to be invoked when the environment becomes active.
   * Returns an unsubscribe function that removes only this callback, leaving
   * any other registered callbacks untouched.
   */
  onResume(callback: () => void): () => void;
  /**
   * Optional: register a callback to be invoked on any user interaction
   * (mouse, keyboard, scroll, touch).  Used by the idle-state detector.
   *
   * Implementations should throttle the callback internally (e.g. max once
   * per 1 000 ms) to avoid flooding the engine with high-frequency events.
   *
   * Returns an unsubscribe function that removes only this callback, or
   * `null` when the environment cannot deliver interaction events (e.g.
   * SSR, Node.js tests with a stubbed `window`).
   *
   * Backward-compatible — adapters that do not implement this method are
   * silently skipped and idle detection is disabled.
   */
  onInteraction?(callback: () => void): (() => void) | null;
  /** Remove all event listeners and release resources held by this adapter. */
  destroy(): void;
}

/**
 * Lifecycle adapter backed by the Page Visibility API
 * (`document.visibilitychange`).
 *
 * Guards every `document` access with a `typeof document !== 'undefined'`
 * check so the class can be imported in SSR / Node.js / React Native
 * environments without throwing.
 *
 * Usage:
 * ```ts
 * const lifecycle = new BrowserLifecycleAdapter();
 * lifecycle.onPause(() => {
 *   // e.g. flush pending work or persist state
 * });
 * lifecycle.onResume(() => {
 *   // e.g. restart timers or resume work
 * });
 * // later…
 * lifecycle.destroy();
 * ```
 */
export class BrowserLifecycleAdapter implements LifecycleAdapter {
  private readonly pauseCallbacks: Array<() => void> = [];
  private readonly resumeCallbacks: Array<() => void> = [];
  private readonly interactionCallbacks: Array<() => void> = [];
  private readonly handler: () => void;

  /** Tracks the DOM listeners registered for interaction throttling. */
  private interactionHandler: (() => void) | null = null;
  private interactionLastFired = 0;
  private static readonly INTERACTION_THROTTLE_MS = 1_000;
  private static readonly INTERACTION_EVENTS: ReadonlyArray<string> = [
    'mousemove',
    'scroll',
    'touchstart',
    'keydown',
  ];

  constructor() {
    this.handler = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        for (const cb of this.pauseCallbacks) cb();
      } else {
        for (const cb of this.resumeCallbacks) cb();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handler);
    }
  }

  onPause(callback: () => void): () => void {
    this.pauseCallbacks.push(callback);
    return () => {
      const idx = this.pauseCallbacks.indexOf(callback);
      if (idx !== -1) this.pauseCallbacks.splice(idx, 1);
    };
  }

  onResume(callback: () => void): () => void {
    this.resumeCallbacks.push(callback);
    return () => {
      const idx = this.resumeCallbacks.indexOf(callback);
      if (idx !== -1) this.resumeCallbacks.splice(idx, 1);
    };
  }

  onInteraction(callback: () => void): (() => void) | null {
    // When DOM event APIs are unavailable (SSR, Node.js tests with a
    // stubbed `window`), interaction tracking cannot function.
    // Return null to signal "not supported" so the coordinator skips
    // idle-check timer scheduling.
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return null;
    }

    this.interactionCallbacks.push(callback);

    // Lazily attach DOM listeners on the first subscription.
    if (
      this.interactionHandler === null &&
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      this.interactionHandler = () => {
        const now =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        if (now - this.interactionLastFired < BrowserLifecycleAdapter.INTERACTION_THROTTLE_MS) {
          return;
        }
        this.interactionLastFired = now;
        for (const cb of this.interactionCallbacks) cb();
      };

      const opts: AddEventListenerOptions = { passive: true };
      for (const evt of BrowserLifecycleAdapter.INTERACTION_EVENTS) {
        window.addEventListener(evt, this.interactionHandler, opts);
      }
    }

    return () => {
      const idx = this.interactionCallbacks.indexOf(callback);
      if (idx !== -1) this.interactionCallbacks.splice(idx, 1);

      // Remove DOM listeners when the last subscriber unsubscribes.
      if (this.interactionCallbacks.length === 0) {
        this.teardownInteractionListeners();
      }
    };
  }

  /** Remove interaction DOM listeners if they are currently attached. */
  private teardownInteractionListeners(): void {
    if (
      this.interactionHandler !== null &&
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      for (const evt of BrowserLifecycleAdapter.INTERACTION_EVENTS) {
        window.removeEventListener(evt, this.interactionHandler);
      }
    }
    this.interactionHandler = null;
  }

  destroy(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handler);
    }
    this.teardownInteractionListeners();
    this.pauseCallbacks.length = 0;
    this.resumeCallbacks.length = 0;
    this.interactionCallbacks.length = 0;
  }
}
