/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @fileoverview Tests for domain-specific hooks:
 *   useExitIntent, useIdle, useAttentionReturn, usePropensity, usePredictiveLink
 *
 * All hooks require a <PassiveIntentProvider> ancestor and are tested via
 * renderHook with a Provider wrapper.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

vi.mock('@passiveintent/core', () => ({
  IntentManager: vi.fn(),
}));

import {
  useExitIntent,
  useIdle,
  useAttentionReturn,
  usePropensity,
  usePredictiveLink,
  PassiveIntentProvider,
} from '../src/index';
import { IntentManager } from '@passiveintent/core';

const MockIM = vi.mocked(IntentManager);

// ── Fake instance with event emitter ──────────────────────────────────────────

type EventCallback = (...args: any[]) => any;

function makeFakeInstance() {
  const listeners = new Map<string, Set<EventCallback>>();

  return {
    destroy: vi.fn(),
    track: vi.fn(),
    on: vi.fn((event: string, cb: EventCallback) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => {
        listeners.get(event)?.delete(cb);
      };
    }),
    getTelemetry: vi.fn().mockReturnValue({}),
    predictNextStates: vi.fn().mockReturnValue([]),
    hasSeen: vi.fn().mockReturnValue(false),
    incrementCounter: vi.fn().mockReturnValue(0),
    getCounter: vi.fn().mockReturnValue(0),
    resetCounter: vi.fn(),
    trackConversion: vi.fn(),
    // Test helper: emit an event to all registered listeners
    _emit(event: string, payload: any) {
      listeners.get(event)?.forEach((cb) => {
        cb(payload);
      });
    },
    _listeners: listeners,
  };
}

type FakeInstance = ReturnType<typeof makeFakeInstance>;

const BASE_CONFIG = { storageKey: 'test-hooks' };

function withProvider(children: React.ReactNode) {
  return React.createElement(PassiveIntentProvider, { config: BASE_CONFIG }, children);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Domain hooks', () => {
  let fakeInstance: FakeInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeInstance = makeFakeInstance();
    MockIM.mockImplementation(function MockIntentManager() {
      return fakeInstance as unknown as InstanceType<typeof IntentManager>;
    });
  });

  // ── useExitIntent ─────────────────────────────────────────────────────────

  describe('useExitIntent', () => {
    it('throws when called outside a Provider', () => {
      expect(() => renderHook(() => useExitIntent())).toThrow('PassiveIntentProvider');
    });

    it('returns triggered: false initially', () => {
      const { result, unmount } = renderHook(() => useExitIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(result.current.triggered).toBe(false);
      expect(result.current.state).toBeNull();
      expect(result.current.likelyNext).toBeNull();
      unmount();
    });

    it('sets triggered: true with payload on exit_intent event', () => {
      const { result, unmount } = renderHook(() => useExitIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('exit_intent', { state: '/pricing', likelyNext: '/checkout' });
      });

      expect(result.current.triggered).toBe(true);
      expect(result.current.state).toBe('/pricing');
      expect(result.current.likelyNext).toBe('/checkout');
      unmount();
    });

    it('dismiss() resets state back to initial', () => {
      const { result, unmount } = renderHook(() => useExitIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('exit_intent', { state: '/pricing', likelyNext: '/checkout' });
      });
      expect(result.current.triggered).toBe(true);

      act(() => {
        result.current.dismiss();
      });

      expect(result.current.triggered).toBe(false);
      expect(result.current.state).toBeNull();
      expect(result.current.likelyNext).toBeNull();
      unmount();
    });

    it('handles likelyNext: null from the event', () => {
      const { result, unmount } = renderHook(() => useExitIntent(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('exit_intent', { state: '/about', likelyNext: null });
      });

      expect(result.current.triggered).toBe(true);
      expect(result.current.likelyNext).toBeNull();
      unmount();
    });
  });

  // ── useIdle ───────────────────────────────────────────────────────────────

  describe('useIdle', () => {
    it('throws when called outside a Provider', () => {
      expect(() => renderHook(() => useIdle())).toThrow('PassiveIntentProvider');
    });

    it('returns isIdle: false initially', () => {
      const { result, unmount } = renderHook(() => useIdle(), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(result.current.isIdle).toBe(false);
      expect(result.current.idleMs).toBe(0);
      unmount();
    });

    it('sets isIdle: true on user_idle event', () => {
      const { result, unmount } = renderHook(() => useIdle(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('user_idle', { state: '/home', idleMs: 120_000 });
      });

      expect(result.current.isIdle).toBe(true);
      expect(result.current.idleMs).toBe(120_000);
      unmount();
    });

    it('resets isIdle to false on user_resumed event', () => {
      const { result, unmount } = renderHook(() => useIdle(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('user_idle', { state: '/home', idleMs: 120_000 });
      });
      expect(result.current.isIdle).toBe(true);

      act(() => {
        fakeInstance._emit('user_resumed', { state: '/home', idleMs: 135_000 });
      });

      expect(result.current.isIdle).toBe(false);
      expect(result.current.idleMs).toBe(135_000);
      unmount();
    });

    it('unsubscribes from both events on unmount', () => {
      const { unmount } = renderHook(() => useIdle(), {
        wrapper: ({ children }) => withProvider(children),
      });

      // Provider's on() + hook subscribes to user_idle and user_resumed
      const idleListeners = fakeInstance._listeners.get('user_idle')?.size ?? 0;
      const resumedListeners = fakeInstance._listeners.get('user_resumed')?.size ?? 0;
      expect(idleListeners).toBe(1);
      expect(resumedListeners).toBe(1);

      unmount();

      expect(fakeInstance._listeners.get('user_idle')?.size ?? 0).toBe(0);
      expect(fakeInstance._listeners.get('user_resumed')?.size ?? 0).toBe(0);
    });
  });

  // ── useAttentionReturn ────────────────────────────────────────────────────

  describe('useAttentionReturn', () => {
    it('throws when called outside a Provider', () => {
      expect(() => renderHook(() => useAttentionReturn())).toThrow('PassiveIntentProvider');
    });

    it('returns returned: false initially', () => {
      const { result, unmount } = renderHook(() => useAttentionReturn(), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(result.current.returned).toBe(false);
      expect(result.current.hiddenDuration).toBe(0);
      unmount();
    });

    it('sets returned: true on attention_return event', () => {
      const { result, unmount } = renderHook(() => useAttentionReturn(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('attention_return', { state: '/products', hiddenDuration: 45_000 });
      });

      expect(result.current.returned).toBe(true);
      expect(result.current.hiddenDuration).toBe(45_000);
      unmount();
    });

    it('dismiss() resets state back to initial', () => {
      const { result, unmount } = renderHook(() => useAttentionReturn(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('attention_return', { state: '/products', hiddenDuration: 45_000 });
      });
      expect(result.current.returned).toBe(true);

      act(() => {
        result.current.dismiss();
      });

      expect(result.current.returned).toBe(false);
      expect(result.current.hiddenDuration).toBe(0);
      unmount();
    });
  });

  // ── usePropensity ─────────────────────────────────────────────────────────

  describe('usePropensity', () => {
    it('throws when called outside a Provider', () => {
      expect(() => renderHook(() => usePropensity('/checkout'))).toThrow('PassiveIntentProvider');
    });

    it('returns 0 initially', () => {
      const { result, unmount } = renderHook(() => usePropensity('/checkout'), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(result.current).toBe(0);
      unmount();
    });

    it('returns the target probability on state_change when target is reachable', () => {
      fakeInstance.predictNextStates.mockReturnValue([
        { state: '/checkout', probability: 0.6 },
        { state: '/cart', probability: 0.3 },
      ]);

      const { result, unmount } = renderHook(() => usePropensity('/checkout'), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: '/home', to: '/products' });
      });

      expect(result.current).toBeCloseTo(0.6);
      unmount();
    });

    it('returns 0 when target is not in predictions', () => {
      fakeInstance.predictNextStates.mockReturnValue([{ state: '/cart', probability: 0.5 }]);

      const { result, unmount } = renderHook(() => usePropensity('/checkout'), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: '/home', to: '/products' });
      });

      expect(result.current).toBe(0);
      unmount();
    });

    it('applies dwell-time friction penalty to the score', () => {
      fakeInstance.predictNextStates.mockReturnValue([{ state: '/checkout', probability: 0.8 }]);

      const { result, unmount } = renderHook(() => usePropensity('/checkout', { alpha: 0.2 }), {
        wrapper: ({ children }) => withProvider(children),
      });

      // First: anomaly sets z-score
      act(() => {
        fakeInstance._emit('dwell_time_anomaly', {
          state: '/products',
          dwellMs: 30000,
          meanMs: 5000,
          stdMs: 2000,
          zScore: 3.0,
          confidence: 'high',
          sampleSize: 50,
        });
      });

      // Then: state change triggers score computation with friction
      act(() => {
        fakeInstance._emit('state_change', { from: '/products', to: '/cart' });
      });

      // Expected: 0.8 * exp(-0.2 * 3.0) = 0.8 * exp(-0.6) ≈ 0.439
      expect(result.current).toBeCloseTo(0.8 * Math.exp(-0.6), 5);
      unmount();
    });

    it('clamps negative z-scores to 0 (no friction boost)', () => {
      fakeInstance.predictNextStates.mockReturnValue([{ state: '/checkout', probability: 0.5 }]);

      const { result, unmount } = renderHook(() => usePropensity('/checkout'), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('dwell_time_anomaly', {
          state: '/products',
          dwellMs: 1000,
          meanMs: 5000,
          stdMs: 2000,
          zScore: -2.0,
          confidence: 'high',
          sampleSize: 50,
        });
      });

      act(() => {
        fakeInstance._emit('state_change', { from: null, to: '/products' });
      });

      // z clamped to 0 → friction = exp(0) = 1 → score = 0.5
      expect(result.current).toBeCloseTo(0.5);
      unmount();
    });
  });

  // ── usePredictiveLink ─────────────────────────────────────────────────────

  describe('usePredictiveLink', () => {
    it('throws when called outside a Provider', () => {
      expect(() => renderHook(() => usePredictiveLink())).toThrow('PassiveIntentProvider');
    });

    it('returns empty predictions initially', () => {
      const { result, unmount } = renderHook(() => usePredictiveLink(), {
        wrapper: ({ children }) => withProvider(children),
      });

      expect(result.current.predictions).toEqual([]);
      unmount();
    });

    it('updates predictions on state_change', () => {
      fakeInstance.predictNextStates.mockReturnValue([
        { state: '/checkout', probability: 0.7 },
        { state: '/cart', probability: 0.4 },
      ]);

      const { result, unmount } = renderHook(() => usePredictiveLink({ threshold: 0.3 }), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: '/home', to: '/products' });
      });

      expect(result.current.predictions).toEqual([
        { state: '/checkout', probability: 0.7 },
        { state: '/cart', probability: 0.4 },
      ]);
      unmount();
    });

    it('passes threshold and sanitize to predictNextStates', () => {
      const sanitize = (s: string) => !s.startsWith('/admin');

      const { unmount } = renderHook(() => usePredictiveLink({ threshold: 0.5, sanitize }), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: null, to: '/home' });
      });

      expect(fakeInstance.predictNextStates).toHaveBeenCalledWith(0.5, sanitize);
      unmount();
    });

    it('injects <link rel="prefetch"> tags when prefetch is enabled (default)', () => {
      fakeInstance.predictNextStates.mockReturnValue([{ state: '/checkout', probability: 0.8 }]);

      const { unmount } = renderHook(() => usePredictiveLink(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: null, to: '/products' });
      });

      const prefetchLinks = document.querySelectorAll('link[rel="prefetch"]');
      expect(prefetchLinks.length).toBe(1);
      expect(prefetchLinks[0].getAttribute('href')).toBe('/checkout');

      unmount();

      // Links should be cleaned up on unmount
      expect(document.querySelectorAll('link[rel="prefetch"]').length).toBe(0);
    });

    it('does not inject <link> tags when prefetch is disabled', () => {
      fakeInstance.predictNextStates.mockReturnValue([{ state: '/checkout', probability: 0.8 }]);

      const { unmount } = renderHook(() => usePredictiveLink({ prefetch: false }), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: null, to: '/products' });
      });

      expect(document.querySelectorAll('link[rel="prefetch"]').length).toBe(0);
      unmount();
    });

    it('cleans up old prefetch links when predictions change', () => {
      fakeInstance.predictNextStates
        .mockReturnValueOnce([{ state: '/old-page', probability: 0.8 }])
        .mockReturnValueOnce([{ state: '/new-page', probability: 0.9 }]);

      const { unmount } = renderHook(() => usePredictiveLink(), {
        wrapper: ({ children }) => withProvider(children),
      });

      act(() => {
        fakeInstance._emit('state_change', { from: null, to: '/a' });
      });

      expect(document.querySelector('link[href="/old-page"]')).not.toBeNull();

      act(() => {
        fakeInstance._emit('state_change', { from: '/a', to: '/b' });
      });

      // Old link removed, new link added
      expect(document.querySelector('link[href="/old-page"]')).toBeNull();
      expect(document.querySelector('link[href="/new-page"]')).not.toBeNull();

      unmount();
    });
  });
});
