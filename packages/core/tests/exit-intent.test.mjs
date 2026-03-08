/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Smart Exit-Intent tests
 *
 * Verifies that the exit_intent event:
 *   - is suppressed when no previous state exists
 *   - is suppressed when the Markov graph has no likely next states (< 0.4 threshold)
 *   - fires with the top-probability candidate when likely next states exist
 *   - does not crash when the adapter lacks onExitIntent (backward compat)
 *   - cleans up its unsubscribe on destroy()
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IntentManager } from '../dist/src/intent-sdk.js';
import { MemoryStorage, setupTestEnvironment } from './helpers/test-env.mjs';

setupTestEnvironment();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fake LifecycleAdapter that supports onExitIntent.
 * Call `kit.triggerExitIntent()` to simulate the user's mouse leaving the
 * viewport from above (clientY <= 0).
 */
function createAdapterWithExitIntent() {
  let pauseCb = null;
  let resumeCb = null;
  let exitIntentCb = null;
  let exitIntentUnsubCalled = 0;

  const adapter = {
    onPause(cb) {
      pauseCb = cb;
      return () => {
        pauseCb = null;
      };
    },
    onResume(cb) {
      resumeCb = cb;
      return () => {
        resumeCb = null;
      };
    },
    onExitIntent(cb) {
      exitIntentCb = cb;
      return () => {
        exitIntentCb = null;
        exitIntentUnsubCalled += 1;
      };
    },
    destroy() {
      pauseCb = null;
      resumeCb = null;
      exitIntentCb = null;
    },
  };

  return {
    adapter,
    triggerExitIntent: () => exitIntentCb?.(),
    get isSubscribed() {
      return exitIntentCb !== null;
    },
    get unsubCallCount() {
      return exitIntentUnsubCalled;
    },
  };
}

/**
 * Creates a fake LifecycleAdapter WITHOUT onExitIntent (backward compat).
 */
function createAdapterWithoutExitIntent() {
  const adapter = {
    onPause(cb) {
      return () => {};
    },
    onResume(cb) {
      return () => {};
    },
    destroy() {},
  };
  return { adapter };
}

/**
 * Builds an IntentManager wired to the given lifecycle adapter with
 * botProtection disabled so track() is fully deterministic.
 */
function createManager(lifecycleAdapter) {
  return new IntentManager({
    storageKey: `exit-intent-test-${Date.now()}-${Math.random()}`,
    storage: new MemoryStorage(),
    botProtection: false,
    lifecycleAdapter,
    // Disable Bayesian smoothing so probability values are exact (count/total).
    smoothingAlpha: 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('exit_intent: no emit when no previous state', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  // Do NOT call track() — previousState is null.
  kit.triggerExitIntent();

  assert.equal(fired.length, 0, 'exit_intent must not fire when previousState is null');

  manager.destroy();
});

test('exit_intent: no emit when graph has no likely next states above threshold', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  // Track a single state — no outgoing transitions exist yet, so
  // getLikelyNextStates('/home', 0.4) returns an empty array.
  manager.track('/home');

  kit.triggerExitIntent();

  assert.equal(
    fired.length,
    0,
    'exit_intent must not fire when graph has no transitions from the current state',
  );

  manager.destroy();
});

test('exit_intent: emits with top likely next state when candidates exist', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  // Build up a clear transition: /home → /products (3x) and /home → /about (1x).
  // With smoothingAlpha=0: P(/products | /home) = 3/4 = 0.75 ≥ 0.4.
  manager.track('/home');
  manager.track('/products');
  manager.track('/home');
  manager.track('/products');
  manager.track('/home');
  manager.track('/products');
  manager.track('/home');
  manager.track('/about');

  // previousState is now '/about'. Track back to /home to test the exit from /home.
  manager.track('/home');

  kit.triggerExitIntent();

  assert.equal(fired.length, 1, 'Exactly one exit_intent event must fire');
  assert.equal(fired[0].state, '/home', 'event.state must be the current state');
  assert.equal(
    fired[0].likelyNext,
    '/products',
    'event.likelyNext must be the highest-probability next state',
  );

  manager.destroy();
});

test('exit_intent: likelyNext is the highest-probability candidate (not just any candidate)', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  // Build transitions from /dashboard:
  //   /dashboard → /reports (5x) — P = 5/7 ≈ 0.714
  //   /dashboard → /settings (2x) — P = 2/7 ≈ 0.286 (below 0.4 threshold)
  // After the setup, navigate back to /dashboard so it is previousState.
  for (let i = 0; i < 5; i++) {
    manager.track('/dashboard');
    manager.track('/reports');
  }
  for (let i = 0; i < 2; i++) {
    manager.track('/dashboard');
    manager.track('/settings');
  }
  manager.track('/dashboard');

  kit.triggerExitIntent();

  assert.equal(fired.length, 1, 'One exit_intent event expected');
  assert.equal(fired[0].likelyNext, '/reports', '/reports has the highest probability');

  manager.destroy();
});

test('exit_intent: fires multiple times on repeated triggers (no self-suppression)', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  manager.track('/home');
  manager.track('/products');
  manager.track('/home');

  // Trigger exit intent twice in a row — the event has no internal cooldown.
  kit.triggerExitIntent();
  kit.triggerExitIntent();

  assert.equal(fired.length, 2, 'exit_intent must fire on each trigger when graph is ready');

  manager.destroy();
});

test('exit_intent: no runtime errors when adapter lacks onExitIntent (backward compat)', () => {
  const { adapter } = createAdapterWithoutExitIntent();

  assert.doesNotThrow(() => {
    const manager = createManager(adapter);
    manager.track('/home');
    // No exit intent fires since `onExitIntent` is absent on the adapter.
    manager.destroy();
  }, 'IntentManager must not throw when the lifecycle adapter lacks onExitIntent');
});

test('exit_intent: unsubscribe is called on destroy()', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  // Subscription should have been set up during IntentManager construction.
  assert.equal(
    kit.isSubscribed,
    true,
    'onExitIntent callback should be subscribed after construction',
  );

  manager.destroy();

  assert.equal(
    kit.unsubCallCount,
    1,
    'The exit-intent unsubscribe must be called once on destroy()',
  );
  assert.equal(kit.isSubscribed, false, 'Callback must be cleared after unsubscribe');
});

test('exit_intent: no emission after destroy()', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  manager.track('/home');
  manager.track('/products');
  manager.track('/home');

  manager.destroy();

  // Simulate exit intent after destroy — the unsubscribe should have been
  // called, so the adapter's exitIntentCb is now null and nothing fires.
  kit.triggerExitIntent();

  assert.equal(fired.length, 0, 'exit_intent must not fire after destroy()');
});

test('exit_intent: state label in payload reflects normalizeRouteState output', () => {
  const kit = createAdapterWithExitIntent();
  const manager = createManager(kit.adapter);

  const fired = [];
  manager.on('exit_intent', (e) => fired.push(e));

  // Raw URL with UUID — normalizeRouteState converts to '/users/:id/profile'.
  manager.track('/users/550e8400-e29b-41d4-a716-446655440000/profile');
  manager.track('/checkout');
  // Navigate back: previousState becomes '/users/:id/profile' after normalization.
  manager.track('/users/550e8400-e29b-41d4-a716-446655440000/profile');
  manager.track('/checkout');
  manager.track('/users/550e8400-e29b-41d4-a716-446655440000/profile');

  kit.triggerExitIntent();

  assert.equal(fired.length, 1, 'exit_intent fires');
  assert.equal(
    fired[0].state,
    '/users/:id/profile',
    'state in payload must be the normalized route',
  );
  assert.equal(fired[0].likelyNext, '/checkout', 'likelyNext must also be a normalized route');

  manager.destroy();
});
