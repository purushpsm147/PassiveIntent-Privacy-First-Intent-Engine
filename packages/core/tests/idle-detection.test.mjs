/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
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
 * Creates a fake LifecycleAdapter with an onInteraction method.
 * Returns the adapter plus functions to simulate pause/resume/interaction.
 */
function createFakeAdapterWithInteraction() {
  let pauseCb = null;
  let resumeCb = null;
  let interactionCb = null;
  let destroyCalls = 0;

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
    onInteraction(cb) {
      interactionCb = cb;
      return () => {
        interactionCb = null;
      };
    },
    destroy() {
      destroyCalls += 1;
      pauseCb = null;
      resumeCb = null;
      interactionCb = null;
    },
  };

  return {
    adapter,
    pause: () => pauseCb?.(),
    resume: () => resumeCb?.(),
    interact: () => interactionCb?.(),
    get destroyCalls() {
      return destroyCalls;
    },
  };
}

/**
 * Creates a fake LifecycleAdapter WITHOUT onInteraction (backward compat).
 */
function createFakeAdapterWithoutInteraction() {
  let pauseCb = null;
  let resumeCb = null;

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
    destroy() {
      pauseCb = null;
      resumeCb = null;
    },
  };

  return {
    adapter,
    pause: () => pauseCb?.(),
    resume: () => resumeCb?.(),
  };
}

/**
 * Creates an IntentManager with a controllable timer and lifecycle adapter.
 * The timer's setTimeout is backed by real timers but the `now()` is
 * controlled by the returned `setTime` function.
 *
 * Returns { manager, timer helpers, adapter helpers }.
 */
function createIdleTestHarness(adapterKit) {
  let mockTime = 1000;
  const pendingTimers = [];

  const timer = {
    now: () => mockTime,
    setTimeout(fn, delay) {
      const entry = { fn, fireAt: mockTime + delay, cleared: false };
      pendingTimers.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
  };

  const manager = new IntentManager({
    storageKey: `idle-test-${Date.now()}-${Math.random()}`,
    storage: new MemoryStorage(),
    botProtection: false,
    lifecycleAdapter: adapterKit.adapter,
    dwellTime: { enabled: true },
    timer,
  });

  /**
   * Advance time to `newTime` and fire any pending timers whose `fireAt` is
   * <= `newTime`. Timers that re-arm (like the idle check loop) will be
   * scheduled based on the new `mockTime`.
   */
  function advanceTo(newTime) {
    mockTime = newTime;
    // Drain timers in order; newly scheduled timers from callbacks are
    // also considered.
    let safety = 200;
    while (safety-- > 0) {
      // Find the next un-cleared timer that should fire.
      let nextIdx = -1;
      let nextFireAt = Infinity;
      for (let i = 0; i < pendingTimers.length; i++) {
        const t = pendingTimers[i];
        if (!t.cleared && t.fireAt <= mockTime && t.fireAt < nextFireAt) {
          nextIdx = i;
          nextFireAt = t.fireAt;
        }
      }
      if (nextIdx === -1) break;
      const t = pendingTimers[nextIdx];
      t.cleared = true; // prevent re-firing
      t.fn();
    }
  }

  function setTime(t) {
    mockTime = t;
  }

  return { manager, advanceTo, setTime, timer, pendingTimers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('user_idle emits once after USER_IDLE_THRESHOLD_MS of inactivity', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo } = createIdleTestHarness(kit);

  // Enter a state so hasPreviousState() returns true.
  manager.track('/products');

  const idleEvents = [];
  manager.on('user_idle', (e) => idleEvents.push(e));

  // Advance well past the 120 000 ms idle threshold (+ some check intervals).
  advanceTo(1000 + 130_000);

  assert.equal(idleEvents.length, 1, 'Exactly one user_idle event expected');
  assert.equal(idleEvents[0].state, '/products');
  assert.ok(idleEvents[0].idleMs >= 0, 'idleMs must be non-negative');

  // Further idle checks should NOT emit again.
  advanceTo(1000 + 200_000);
  assert.equal(idleEvents.length, 1, 'user_idle must fire only once per idle period');

  manager.destroy();
});

test('user_resumed emits on first interaction after idle', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo, setTime } = createIdleTestHarness(kit);

  manager.track('/checkout');

  const resumedEvents = [];
  manager.on('user_resumed', (e) => resumedEvents.push(e));

  // Go idle.
  advanceTo(1000 + 130_000);

  // Simulate interaction — must emit user_resumed.
  setTime(1000 + 140_000);
  kit.interact();

  assert.equal(resumedEvents.length, 1, 'Exactly one user_resumed event expected');
  assert.equal(resumedEvents[0].state, '/checkout');
  assert.ok(resumedEvents[0].idleMs > 0, 'idleMs must be > 0');

  manager.destroy();
});

test('dwell baseline adjustment excludes idle duration', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo, setTime } = createIdleTestHarness(kit);

  manager.track('/products');

  // Capture the dwell-clock baseline via the test-only getter (the field is
  // private; _previousStateEnteredAt is the sanctioned test accessor).
  const baselineBefore = manager._previousStateEnteredAt;

  // Go idle.
  advanceTo(1000 + 130_000);

  // Interact at 140s.
  setTime(1000 + 140_000);
  kit.interact();

  const baselineAfter = manager._previousStateEnteredAt;

  // The baseline should have been pushed forward by the idle duration.
  assert.ok(
    baselineAfter > baselineBefore,
    `Dwell baseline must be adjusted forward after idle (before=${baselineBefore}, after=${baselineAfter})`,
  );

  manager.destroy();
});

test('no idle events when no previous state exists', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo } = createIdleTestHarness(kit);

  // Do NOT call track() — previousState remains null.

  const idleEvents = [];
  const resumedEvents = [];
  manager.on('user_idle', (e) => idleEvents.push(e));
  manager.on('user_resumed', (e) => resumedEvents.push(e));

  advanceTo(1000 + 200_000);

  assert.equal(idleEvents.length, 0, 'user_idle must not fire when no state is active');
  assert.equal(resumedEvents.length, 0, 'user_resumed must not fire when no state is active');

  manager.destroy();
});

test('cleanup on destroy — no timer leaks', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, pendingTimers } = createIdleTestHarness(kit);

  manager.track('/home');
  manager.destroy();

  // All pending timers should be cleared after destroy.
  const active = pendingTimers.filter((t) => !t.cleared);
  assert.equal(active.length, 0, 'All timers must be cleared after destroy()');
});

test('destroy during user_idle handler leaves no idle-check timers', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo, pendingTimers } = createIdleTestHarness(kit);

  manager.track('/home');

  // Call destroy() re-entrantly from within the user_idle handler, i.e.
  // while the idle-check timer callback is running.
  manager.on('user_idle', () => {
    manager.destroy();
  });

  // Advance time far enough to trigger the idle check and fire user_idle.
  // Other tests use 1000 + 130_000 as a "definitely idle" threshold.
  advanceTo(1000 + 130_000);

  // After destroy() has been invoked from within the handler, there must be
  // no further idle-check timers left scheduled.
  const active = pendingTimers.filter((t) => !t.cleared);
  assert.equal(
    active.length,
    0,
    'No idle-check timers may remain after destroy() is called from user_idle handler',
  );
});
test('adapter without onInteraction does not crash (backward compat)', () => {
  const kit = createFakeAdapterWithoutInteraction();
  let mockTime = 1000;
  const timer = {
    now: () => mockTime,
    setTimeout(fn, delay) {
      return globalThis.setTimeout(fn, delay);
    },
    clearTimeout(id) {
      globalThis.clearTimeout(id);
    },
  };

  const manager = new IntentManager({
    storageKey: `idle-nointeraction-${Date.now()}`,
    storage: new MemoryStorage(),
    botProtection: false,
    lifecycleAdapter: kit.adapter,
    dwellTime: { enabled: true },
    timer,
  });

  const idleEvents = [];
  manager.on('user_idle', (e) => idleEvents.push(e));

  assert.doesNotThrow(() => manager.track('/home'), 'track() must not throw with old adapter');
  assert.equal(idleEvents.length, 0, 'No idle events with adapter lacking onInteraction');

  manager.destroy();
});

test('user_idle does not fire when user keeps interacting', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo, setTime } = createIdleTestHarness(kit);

  manager.track('/home');

  const idleEvents = [];
  manager.on('user_idle', (e) => idleEvents.push(e));

  // Simulate interactions every 30 seconds — well below the 120s threshold.
  for (let t = 1000; t < 1000 + 300_000; t += 30_000) {
    setTime(t);
    kit.interact();
    advanceTo(t);
  }

  assert.equal(idleEvents.length, 0, 'user_idle must not fire when the user interacts regularly');

  manager.destroy();
});

test('second idle cycle after resume emits user_idle again', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, advanceTo, setTime } = createIdleTestHarness(kit);

  manager.track('/products');

  const idleEvents = [];
  const resumedEvents = [];
  manager.on('user_idle', (e) => idleEvents.push(e));
  manager.on('user_resumed', (e) => resumedEvents.push(e));

  // First idle cycle.
  advanceTo(1000 + 130_000);
  assert.equal(idleEvents.length, 1, 'First user_idle fires');

  // Resume.
  setTime(1000 + 140_000);
  kit.interact();
  assert.equal(resumedEvents.length, 1, 'First user_resumed fires');

  // Second idle cycle.
  advanceTo(1000 + 280_000);
  assert.equal(idleEvents.length, 2, 'Second user_idle fires after re-idling');

  // Second resume.
  setTime(1000 + 290_000);
  kit.interact();
  assert.equal(resumedEvents.length, 2, 'Second user_resumed fires');

  manager.destroy();
});

test('existing session_stale / attention_return still fire correctly with idle detection', () => {
  const kit = createFakeAdapterWithInteraction();
  const { manager, setTime } = createIdleTestHarness(kit);

  manager.track('/cart');

  const staleEvents = [];
  const attentionEvents = [];
  manager.on('session_stale', (e) => staleEvents.push(e));
  manager.on('attention_return', (e) => attentionEvents.push(e));

  // Simulate a 2-hour OS suspend via pause/resume.
  setTime(1000);
  kit.pause();
  setTime(1000 + 7_200_000);
  kit.resume();

  assert.equal(staleEvents.length, 1, 'session_stale must still fire');
  assert.equal(staleEvents[0].reason, 'hidden_duration_exceeded');

  assert.equal(attentionEvents.length, 1, 'attention_return must still fire');
  assert.equal(attentionEvents[0].state, '/cart');

  manager.destroy();
});
