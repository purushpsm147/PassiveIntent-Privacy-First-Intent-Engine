/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @fileoverview Tests for PassiveIntentProvider and the context-mode
 * usePassiveIntent() hook (no-argument overload).
 *
 * Four contracts tested:
 *   6. Provider lifecycle — creates and destroys its IntentManager correctly
 *   7. Context mode — hook reads from the Provider's engine, not its own
 *   8. Error path — descriptive throw when called outside a Provider
 *   9. Standalone inside Provider — config arg creates an isolated instance
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';

vi.mock('@passiveintent/core', () => ({
  IntentManager: vi.fn(),
}));

import { usePassiveIntent, PassiveIntentProvider } from '../src/index';
import { IntentManager } from '@passiveintent/core';

const MockIM = vi.mocked(IntentManager);

// ── Fake instance factory ─────────────────────────────────────────────────────

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
  trackConversion: ReturnType<typeof vi.fn>;
};

function makeFakeInstance(): FakeInstance {
  return {
    destroy: vi.fn(),
    track: vi.fn(),
    on: vi.fn().mockReturnValue(vi.fn()),
    getTelemetry: vi.fn().mockReturnValue({ sessionId: 'test-session' }),
    predictNextStates: vi.fn().mockReturnValue([{ state: '/next', probability: 0.8 }]),
    hasSeen: vi.fn().mockReturnValue(true),
    incrementCounter: vi.fn().mockReturnValue(2),
    getCounter: vi.fn().mockReturnValue(5),
    resetCounter: vi.fn(),
    trackConversion: vi.fn(),
  };
}

const BASE_CONFIG = { storageKey: 'test-key' };

// Helper: renders a hook inside a PassiveIntentProvider
function withProvider(children: React.ReactNode) {
  return React.createElement(PassiveIntentProvider, { config: BASE_CONFIG }, children);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('PassiveIntentProvider + context-mode usePassiveIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockIM.mockImplementation(function MockIntentManager() {
      return makeFakeInstance() as unknown as InstanceType<typeof IntentManager>;
    });
  });

  // ── 6. Provider lifecycle ──────────────────────────────────────────────────

  describe('6 — Provider lifecycle', () => {
    it('constructs exactly one IntentManager on mount', () => {
      const { unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(MockIM).toHaveBeenCalledTimes(1);
      expect(MockIM).toHaveBeenCalledWith(BASE_CONFIG);
      unmount();
    });

    it('calls destroy() exactly once on Provider unmount', () => {
      const { unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;
      expect(instance.destroy).not.toHaveBeenCalled();

      unmount();

      expect(instance.destroy).toHaveBeenCalledTimes(1);
    });

    it('handles Strict Mode double-invocation: all non-live instances destroyed; live instance destroyed on unmount', () => {
      const { unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) =>
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(PassiveIntentProvider, { config: BASE_CONFIG }, children),
          ),
      });

      const total = MockIM.mock.results.length;
      expect(total).toBeGreaterThanOrEqual(1);

      for (let i = 0; i < total - 1; i++) {
        const inst = MockIM.mock.results[i].value as unknown as FakeInstance;
        expect(inst.destroy).toHaveBeenCalledTimes(1);
      }

      const live = MockIM.mock.results[total - 1].value as unknown as FakeInstance;
      expect(live.destroy).not.toHaveBeenCalled();

      unmount();
      expect(live.destroy).toHaveBeenCalledTimes(1);
    });
  });

  // ── 7. Context mode ────────────────────────────────────────────────────────

  describe('7 — usePassiveIntent() context mode', () => {
    it('creates exactly one IntentManager — the context-mode hook does not create its own', () => {
      const { unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(MockIM).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('delegates track() to the Provider instance', () => {
      const { result, unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;

      result.current.track('/home');
      result.current.track('/checkout');

      expect(instance.track).toHaveBeenCalledTimes(2);
      expect(instance.track).toHaveBeenNthCalledWith(1, '/home');
      expect(instance.track).toHaveBeenNthCalledWith(2, '/checkout');
      unmount();
    });

    it('delegates trackConversion() to the Provider instance', () => {
      const { result, unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;
      const payload = { type: 'purchase', value: 49.99, currency: 'USD' };

      result.current.trackConversion(payload);

      expect(instance.trackConversion).toHaveBeenCalledTimes(1);
      expect(instance.trackConversion).toHaveBeenCalledWith(payload);
      unmount();
    });

    it('delegates on() to the Provider instance and returns its unsubscribe fn', () => {
      const { result, unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      const instance = MockIM.mock.results[0].value as unknown as FakeInstance;
      const listener = vi.fn();
      const unsub = result.current.on('exit_intent', listener);

      expect(instance.on).toHaveBeenCalledWith('exit_intent', listener);
      expect(unsub).toBe((instance.on as ReturnType<typeof vi.fn>).mock.results[0].value);
      unmount();
    });

    it('returns stable callback references across re-renders via context', () => {
      const { result, rerender, unmount } = renderHook(() => usePassiveIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      const snapshot = {
        track: result.current.track,
        on: result.current.on,
        getTelemetry: result.current.getTelemetry,
        predictNextStates: result.current.predictNextStates,
        hasSeen: result.current.hasSeen,
        incrementCounter: result.current.incrementCounter,
        getCounter: result.current.getCounter,
        resetCounter: result.current.resetCounter,
      };

      rerender();
      rerender();

      expect(result.current.track).toBe(snapshot.track);
      expect(result.current.on).toBe(snapshot.on);
      expect(result.current.getTelemetry).toBe(snapshot.getTelemetry);
      expect(result.current.predictNextStates).toBe(snapshot.predictNextStates);
      expect(result.current.hasSeen).toBe(snapshot.hasSeen);
      expect(result.current.incrementCounter).toBe(snapshot.incrementCounter);
      expect(result.current.getCounter).toBe(snapshot.getCounter);
      expect(result.current.resetCounter).toBe(snapshot.resetCounter);
      unmount();
    });

    it('multiple consumers in the same tree all share the single Provider instance', () => {
      const { result, unmount } = renderHook(
        () => {
          const first = usePassiveIntent();
          const second = usePassiveIntent();
          return { first, second };
        },
        {
          wrapper: ({ children }) => withProvider(children),
        },
      );

      expect(MockIM).toHaveBeenCalledTimes(1);
      expect(result.current.first.track).toBe(result.current.second.track);

      result.current.second.track('/page');
      const sharedInstance = MockIM.mock.results[0].value as unknown as FakeInstance;
      expect(sharedInstance.track).toHaveBeenCalledWith('/page');

      unmount();
    });
  });

  // ── 8. Error path ──────────────────────────────────────────────────────────

  describe('8 — error: called without config outside a Provider', () => {
    it('throws with a message mentioning PassiveIntentProvider', () => {
      expect(() => renderHook(() => usePassiveIntent())).toThrow('PassiveIntentProvider');
    });

    it('thrown error message mentions passing a config as the alternative', () => {
      expect(() => renderHook(() => usePassiveIntent())).toThrow('config');
    });
  });

  // ── 9. Standalone mode inside a Provider ──────────────────────────────────

  describe('9 — standalone mode (config arg) inside a Provider', () => {
    it('creates its own IntentManager instance even when inside a Provider', () => {
      const standaloneConfig = { storageKey: 'isolated-widget' };

      const { unmount } = renderHook(() => usePassiveIntent(standaloneConfig), {
        wrapper: ({ children }) => withProvider(children),
      });

      // The Provider creates its instance synchronously during render (lazy
      // ref init), while the standalone hook creates in useEffect (child
      // effects run before parent effects, but both run after render).
      expect(MockIM).toHaveBeenCalledTimes(2);
      expect(MockIM).toHaveBeenNthCalledWith(1, BASE_CONFIG);
      expect(MockIM).toHaveBeenNthCalledWith(2, standaloneConfig);
      unmount();
    });

    it('standalone instance delegates to its own engine, not the Provider engine', () => {
      const standaloneConfig = { storageKey: 'isolated-widget' };

      const { result, unmount } = renderHook(() => usePassiveIntent(standaloneConfig), {
        wrapper: ({ children }) => withProvider(children),
      });

      // Provider created synchronously → results[0], standalone via effect → results[1]
      const providerInstance = MockIM.mock.results[0].value as unknown as FakeInstance;
      const standaloneInstance = MockIM.mock.results[1].value as unknown as FakeInstance;

      result.current.track('/widget-page');

      expect(standaloneInstance.track).toHaveBeenCalledWith('/widget-page');
      expect(providerInstance.track).not.toHaveBeenCalled();
      unmount();
    });

    it('destroys the standalone instance (not the Provider instance) on unmount', () => {
      const { unmount } = renderHook(() => usePassiveIntent({ storageKey: 'widget' }), {
        wrapper: ({ children }) => withProvider(children),
      });

      // Provider created synchronously → results[0], standalone via effect → results[1]
      const providerInstance = MockIM.mock.results[0].value as unknown as FakeInstance;
      const standaloneInstance = MockIM.mock.results[1].value as unknown as FakeInstance;

      unmount();

      expect(standaloneInstance.destroy).toHaveBeenCalledTimes(1);
      expect(providerInstance.destroy).toHaveBeenCalledTimes(1); // Provider unmounts too
    });
  });
});
