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
