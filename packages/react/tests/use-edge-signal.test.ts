/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @fileoverview Unit tests for the useEdgeSignal hook.
 *
 * Five critical lifecycle contracts tested here:
 *   1. Instance creation and cleanup in useEffect
 *   2. SSR safety — no errors and safe defaults when the instance is absent
 *   3. React Strict Mode — correct destroy/recreate double-invocation handling
 *   4. Stable callback references across re-renders (useCallback deps are empty)
 *   5. Config stability — mutating the config object does not recreate the instance
 */

// vi.mock is hoisted before any imports by Vite/Vitest's transform, so
// `@edgesignal/core` will be mocked before `useEdgeSignal` is evaluated.
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';

vi.mock('@edgesignal/core', () => ({
  IntentManager: vi.fn(),
}));

import { useEdgeSignal } from '../src/index';
import { IntentManager } from '@edgesignal/core';

const MockIM = vi.mocked(IntentManager);

// ── Fake instance factory ─────────────────────────────────────────────────────
//
// Each call to `new IntentManager(...)` in the hook creates a new object via
// `MockIM.mockImplementation`. Using a factory (rather than prototype methods)
// means every instance gets its own independent vi.fn() references, which makes
// it straightforward to assert on a specific instance.

type FakeInstance = {
  destroy: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getTelemetry: ReturnType<typeof vi.fn>;
  predictNextStates: ReturnType<typeof vi.fn>;
  hasSeen: ReturnType<typeof vi.fn>;
  incrementCounter: ReturnType<typeof vi.fn>;
  getCounter: ReturnType<typeof vi.fn>;
  resetCounter: ReturnType<typeof vi.fn>;
};

function makeFakeInstance(): FakeInstance {
  return {
    destroy: vi.fn(),
    track: vi.fn(),
    // on() must return a callable unsubscribe function
    on: vi.fn().mockReturnValue(vi.fn()),
    getTelemetry: vi.fn().mockReturnValue({ sessionId: 'test-session' }),
    predictNextStates: vi.fn().mockReturnValue([{ state: '/next', probability: 0.8 }]),
    hasSeen: vi.fn().mockReturnValue(true),
    incrementCounter: vi.fn().mockReturnValue(2),
    getCounter: vi.fn().mockReturnValue(5),
    resetCounter: vi.fn(),
  };
}

// Shared config used across most tests
const BASE_CONFIG = { storageKey: 'test-key' };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('useEdgeSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockIM.mockImplementation(
      () => makeFakeInstance() as unknown as InstanceType<typeof IntentManager>,
    );
  });

  // ── 1. Lifecycle ────────────────────────────────────────────────────────────

  describe('1 — lifecycle: instance creation and cleanup', () => {
    it('constructs exactly one IntentManager on mount', () => {
      const { unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      expect(MockIM).toHaveBeenCalledTimes(1);
      expect(MockIM).toHaveBeenCalledWith(BASE_CONFIG);
      unmount();
    });

    it('calls destroy() exactly once on unmount', () => {
      const { unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      // mock.results[N].value is the object returned by mockImplementation(),
      // i.e. the FakeInstance. mock.instances[N] is the `this` context of the
      // constructor call, which is a different (empty) object.
      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;
      expect(instance.destroy).not.toHaveBeenCalled();

      unmount();

      expect(instance.destroy).toHaveBeenCalledTimes(1);
    });

    it('delegates track() calls to the live instance', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;

      result.current.track('/home');
      result.current.track('/checkout');

      expect(instance.track).toHaveBeenCalledTimes(2);
      expect(instance.track).toHaveBeenNthCalledWith(1, '/home');
      expect(instance.track).toHaveBeenNthCalledWith(2, '/checkout');
      unmount();
    });

    it('delegates on() to the instance and returns the unsubscribe fn from it', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;

      const listener = vi.fn();
      const unsubscribe = result.current.on('state_change', listener);

      expect(instance.on).toHaveBeenCalledWith('state_change', listener);
      // The returned unsubscribe should be the same fn the mock returned
      expect(unsubscribe).toBe((instance.on as ReturnType<typeof vi.fn>).mock.results[0].value);
      unmount();
    });
  });

  // ── 2. SSR safety ──────────────────────────────────────────────────────────

  describe('2 — SSR safety: null-instance resilience', () => {
    /**
     * During server-side rendering, React never runs useEffect, so
     * `instanceRef.current` remains null throughout the component lifetime.
     * Post-unmount is the easiest way to reach the exact same ref=null state
     * in a jsdom test environment. All callbacks use optional-chaining
     * (`instanceRef.current?.method()`) so the contracts are identical.
     */
    it('track() is a no-op and does not throw after unmount (SSR-equivalent null state)', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount(); // instanceRef.current is now null

      expect(() => result.current.track('/page')).not.toThrow();
    });

    it('on() returns a callable NOOP_UNSUBSCRIBE and does not throw', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount();

      const unsub = result.current.on('high_entropy', vi.fn());
      expect(typeof unsub).toBe('function');
      expect(() => unsub()).not.toThrow();
    });

    it('getTelemetry() returns an empty object', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount();

      expect(result.current.getTelemetry()).toEqual({});
    });

    it('predictNextStates() returns an empty array', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount();

      expect(result.current.predictNextStates()).toEqual([]);
    });

    it('hasSeen() returns false', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount();

      expect(result.current.hasSeen('/any')).toBe(false);
    });

    it('getCounter() returns 0', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount();

      expect(result.current.getCounter('clicks')).toBe(0);
    });

    it('incrementCounter() and resetCounter() are no-ops that do not throw', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG));
      unmount();

      expect(() => result.current.incrementCounter('x', 3)).not.toThrow();
      expect(() => result.current.resetCounter('x')).not.toThrow();
    });
  });

  // ── 3. Strict Mode ─────────────────────────────────────────────────────────

  describe('3 — React Strict Mode: double-invocation correctness', () => {
    /**
     * React 18 Strict Mode intentionally runs effects twice in non-production
     * environments to surface cleanup bugs (mount → destroy → remount).
     * React 19 may or may not replicate this for all effect types. We therefore
     * assert on the invariant that MUST hold across all React 18+ versions:
     *   - At least one instance is created.
     *   - Every instance except the last (live) one has been destroyed.
     *   - The live instance is destroyed exactly once when the hook unmounts.
     */
    it('every non-live instance is destroyed; live instance destroyed on unmount', () => {
      const { unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG), {
        wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
      });

      const total = MockIM.mock.results.length;
      expect(total).toBeGreaterThanOrEqual(1);

      // All instances except the last should have been destroyed (Strict Mode
      // teardown). In React 19 where double-invocation is absent there will
      // be only 1 instance and this loop body never runs — still valid.
      for (let i = 0; i < total - 1; i++) {
        const inst = MockIM.mock.results[i].value as unknown as FakeInstance;
        expect(inst.destroy).toHaveBeenCalledTimes(1);
      }

      const live = MockIM.mock.results[total - 1].value as unknown as FakeInstance;
      expect(live.destroy).not.toHaveBeenCalled();

      unmount();

      expect(live.destroy).toHaveBeenCalledTimes(1);
    });

    it('the live instance correctly handles track() after rendering in StrictMode', () => {
      const { result, unmount } = renderHook(() => useEdgeSignal(BASE_CONFIG), {
        wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
      });

      const total = MockIM.mock.results.length;
      const live = MockIM.mock.results[total - 1].value as unknown as FakeInstance;

      result.current.track('/product');

      expect(live.track).toHaveBeenCalledWith('/product');
      unmount();
    });
  });

  // ── 4. Stable callback references ──────────────────────────────────────────

  describe('4 — stable callbacks: references survive re-renders', () => {
    /**
     * All returned functions are created with `useCallback(() => ..., [])`.
     * The empty dependency array means each callback is memoized for the full
     * lifetime of the component — re-renders must not produce new function
     * objects. This is critical for consumers who use these in their own
     * dependency arrays without memoization.
     */
    it('returns the same function references across re-renders', () => {
      const { result, rerender, unmount } = renderHook(
        ({ key }) => useEdgeSignal({ storageKey: key }),
        { initialProps: { key: 'alpha' } },
      );

      const snapshot1 = {
        track: result.current.track,
        on: result.current.on,
        getTelemetry: result.current.getTelemetry,
        predictNextStates: result.current.predictNextStates,
        hasSeen: result.current.hasSeen,
        incrementCounter: result.current.incrementCounter,
        getCounter: result.current.getCounter,
        resetCounter: result.current.resetCounter,
      };

      // Trigger a re-render (key prop change doesn't affect the memoized callbacks
      // because the hook ignores config changes after first mount)
      rerender({ key: 'beta' });

      expect(result.current.track).toBe(snapshot1.track);
      expect(result.current.on).toBe(snapshot1.on);
      expect(result.current.getTelemetry).toBe(snapshot1.getTelemetry);
      expect(result.current.predictNextStates).toBe(snapshot1.predictNextStates);
      expect(result.current.hasSeen).toBe(snapshot1.hasSeen);
      expect(result.current.incrementCounter).toBe(snapshot1.incrementCounter);
      expect(result.current.getCounter).toBe(snapshot1.getCounter);
      expect(result.current.resetCounter).toBe(snapshot1.resetCounter);

      unmount();
    });

    it('stable callbacks still call through to the live instance after re-render', () => {
      const { result, rerender, unmount } = renderHook(
        ({ key }) => useEdgeSignal({ storageKey: key }),
        { initialProps: { key: 'alpha' } },
      );

      rerender({ key: 'beta' });
      rerender({ key: 'gamma' });

      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;
      result.current.track('/cart');

      expect(instance.track).toHaveBeenCalledWith('/cart');
      unmount();
    });
  });

  // ── 5. Config stability ─────────────────────────────────────────────────────

  describe('5 — config stability: config changes do not recreate the instance', () => {
    /**
     * The hook captures `config` into a `useRef` on first render and passes
     * `configRef.current` (not `config`) to the `useEffect`. The effect has
     * an empty dependency array, so it runs exactly once regardless of how
     * many times the parent re-renders with a new config object.
     *
     * Documented contract: to apply a new config, remount the component
     * (e.g. change its `key` prop).
     */
    it('does not recreate the instance when the config object reference changes', () => {
      const { rerender, unmount } = renderHook(({ cfg }) => useEdgeSignal(cfg), {
        initialProps: { cfg: { storageKey: 'test' } },
      });

      expect(MockIM).toHaveBeenCalledTimes(1);

      // New object literal on every re-render — different identity, same values
      rerender({ cfg: { storageKey: 'test' } });
      rerender({ cfg: { storageKey: 'test' } });

      expect(MockIM).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('does not recreate the instance when config values change', () => {
      const { rerender, unmount } = renderHook(({ cfg }) => useEdgeSignal(cfg), {
        initialProps: { cfg: { storageKey: 'test' } },
      });

      expect(MockIM).toHaveBeenCalledTimes(1);

      rerender({ cfg: { storageKey: 'different-key', botProtection: true } });
      rerender({ cfg: { storageKey: 'yet-another-key', botProtection: false } });

      expect(MockIM).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('never calls destroy() between re-renders (no remount occurred)', () => {
      const { rerender, unmount } = renderHook(({ cfg }) => useEdgeSignal(cfg), {
        initialProps: { cfg: { storageKey: 'test' } },
      });

      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;

      rerender({ cfg: { storageKey: 'new-key' } });
      rerender({ cfg: { storageKey: 'newest-key', botProtection: true } });

      // No destroy between renders — only on final unmount
      expect(instance.destroy).not.toHaveBeenCalled();

      unmount();
      expect(instance.destroy).toHaveBeenCalledTimes(1);
    });

    it('uses the initial config (not the latest) when creating the instance', () => {
      const initialConfig = { storageKey: 'initial' };
      const { unmount } = renderHook(() => useEdgeSignal(initialConfig));

      // Only called once, with the initial config
      expect(MockIM).toHaveBeenCalledTimes(1);
      expect(MockIM).toHaveBeenCalledWith(initialConfig);
      unmount();
    });
  });
});
