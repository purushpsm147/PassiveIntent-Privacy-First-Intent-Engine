/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Unit tests for SyncPersistStrategy and AsyncPersistStrategy.
 *
 * These tests exercise the strategy classes directly via a minimal
 * PersistStrategyContext mock — unmediated by IntentManager — so that
 * every branch inside each strategy can be asserted in isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SyncPersistStrategy,
  AsyncPersistStrategy,
} from '../dist/src/engine/persistence-strategies.js';
import { serialize, deserialize, CURRENT_CODEC_VERSION } from '../dist/src/persistence/codec.js';

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

/**
 * Minimal fake graph object whose toBinary() either succeeds or throws.
 */
function makeGraph({ failSerialize = false } = {}) {
  return {
    prune() {},
    toBinary() {
      if (failSerialize) throw new Error('serialize-error');
      // Return a small Uint8Array so uint8ToBase64 can encode it.
      return new Uint8Array([1, 2, 3]);
    },
    stateCount: () => 1,
    totalTransitions: () => 1,
  };
}

/** Minimal fake bloom. */
function makeBloom() {
  return {
    toBase64() {
      return 'bloomdata==';
    },
  };
}

/**
 * Build a PersistStrategyContext mock.
 *
 * @param {object} overrides – partial overrides for any field.
 * @returns {{ ctx, state }} – ctx implements PersistStrategyContext;
 *   state holds mutable flags so tests can inspect side-effects.
 */
function makeCtx({
  storageSetItem = () => {},
  asyncStorageSetItem = null, // if provided → asyncStorage is non-null
  timerNow = () => 0,
  throttleMs = 0,
  debounceMs = 0,
  initialDirty = true,
  graph = makeGraph(),
  bloom = makeBloom(),
  closed = false,
  failSerialize = false,
} = {}) {
  const state = {
    dirty: initialDirty,
    closed,
    engineHealth: 'healthy',
    errors: [],
    scheduledTimers: [],
    timerNow: timerNow,
  };

  const actualGraph = failSerialize ? makeGraph({ failSerialize: true }) : graph;

  const ctx = {
    getStorageKey: () => 'test-key',
    getStorage: () => ({
      getItem: () => null,
      setItem: storageSetItem,
    }),
    getAsyncStorage: () =>
      asyncStorageSetItem ? { getItem: async () => null, setItem: asyncStorageSetItem } : null,
    getTimer: () => ({
      now: state.timerNow,
      setTimeout(cb, ms) {
        const handle = { id: state.scheduledTimers.length };
        state.scheduledTimers.push({ cb, ms, handle, cancelled: false });
        return handle;
      },
      clearTimeout(handle) {
        const t = state.scheduledTimers.find((e) => e.handle === handle);
        if (t) t.cancelled = true;
      },
    }),
    getThrottleMs: () => throttleMs,
    getDebounceMs: () => debounceMs,
    getGraphAndBloom: () => ({ graph: actualGraph, bloom }),
    isClosed: () => state.closed,
    isDirty: () => state.dirty,
    clearDirty: () => {
      state.dirty = false;
    },
    markDirty: () => {
      state.dirty = true;
    },
    setEngineHealth: (h) => {
      state.engineHealth = h;
    },
    reportError: (code, message, err) => {
      state.errors.push({ code, message, err });
    },
  };

  return { ctx, state };
}

// ---------------------------------------------------------------------------
// SyncPersistStrategy – success
// ---------------------------------------------------------------------------

test('SyncPersistStrategy: writes payload and clears dirty flag on success', () => {
  const writes = [];
  const { ctx, state } = makeCtx({
    storageSetItem: (_key, val) => writes.push(val),
  });

  const strategy = new SyncPersistStrategy(ctx);
  strategy.persist();

  assert.equal(writes.length, 1, 'setItem must be called once');
  const payload = JSON.parse(writes[0]);
  assert.equal(typeof payload.graphBinary, 'string', 'payload must contain graphBinary');
  assert.equal(payload.bloomBase64, 'bloomdata==', 'payload must contain bloomBase64');
  assert.equal(state.dirty, false, 'dirty flag must be cleared on success');
  assert.equal(state.errors.length, 0, 'no errors on success');
});

test('SyncPersistStrategy: no-op when dirty flag is false', () => {
  const writes = [];
  const { ctx } = makeCtx({ storageSetItem: (_k, v) => writes.push(v), initialDirty: false });

  const strategy = new SyncPersistStrategy(ctx);
  strategy.persist();

  assert.equal(writes.length, 0, 'setItem must NOT be called when not dirty');
});

// ---------------------------------------------------------------------------
// SyncPersistStrategy – SERIALIZE failure
// ---------------------------------------------------------------------------

test('SyncPersistStrategy: reports SERIALIZE error when toBinary throws', () => {
  const writes = [];
  const { ctx, state } = makeCtx({
    storageSetItem: (_k, v) => writes.push(v),
    failSerialize: true,
  });

  const strategy = new SyncPersistStrategy(ctx);
  strategy.persist();

  assert.equal(writes.length, 0, 'setItem must NOT be called after serialize failure');
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].code, 'SERIALIZE');
  assert.ok(state.errors[0].message.includes('serialize-error'));
});

// ---------------------------------------------------------------------------
// SyncPersistStrategy – STORAGE_WRITE failure
// ---------------------------------------------------------------------------

test('SyncPersistStrategy: reports STORAGE_WRITE error when setItem throws', () => {
  const { ctx, state } = makeCtx({
    storageSetItem: () => {
      throw new Error('write-failed');
    },
  });

  const strategy = new SyncPersistStrategy(ctx);
  strategy.persist();

  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].code, 'STORAGE_WRITE');
  assert.ok(state.errors[0].message.includes('write-failed'));
  // Dirty flag stays true after write failure (was cleared only on success path)
  assert.equal(state.dirty, true, 'dirty must stay set after write failure');
});

// ---------------------------------------------------------------------------
// SyncPersistStrategy – QUOTA_EXCEEDED
// ---------------------------------------------------------------------------

test('SyncPersistStrategy: reports QUOTA_EXCEEDED and sets engineHealth on quota error', () => {
  const quotaErr = new Error('QuotaExceededError');
  quotaErr.name = 'QuotaExceededError';

  const { ctx, state } = makeCtx({
    storageSetItem: () => {
      throw quotaErr;
    },
  });

  const strategy = new SyncPersistStrategy(ctx);
  strategy.persist();

  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].code, 'QUOTA_EXCEEDED');
  assert.equal(state.engineHealth, 'quota_exceeded');
});

// ---------------------------------------------------------------------------
// BasePersistStrategy – throttle + trailing flush
// ---------------------------------------------------------------------------

test('BasePersistStrategy (Sync): skips write within throttle window and schedules trailing timer', () => {
  let now = 0;
  const writes = [];

  const { ctx, state } = makeCtx({
    storageSetItem: (_k, v) => writes.push(v),
    throttleMs: 100,
    timerNow: () => now,
  });

  const strategy = new SyncPersistStrategy(ctx);

  // Leading-edge write at t=0 (lastPersistedAt=-Infinity, elapsed=Infinity >= 100)
  now = 0;
  strategy.persist();
  assert.equal(writes.length, 1, 'leading-edge write must fire immediately');
  assert.equal(state.scheduledTimers.filter((t) => !t.cancelled).length, 0);

  // Re-mark dirty for next persist
  state.dirty = true;

  // Within window at t=50 → throttled, trailing timer scheduled
  now = 50;
  strategy.persist();
  assert.equal(writes.length, 1, 'write within throttle window must be skipped');
  const pending = state.scheduledTimers.filter((t) => !t.cancelled);
  assert.equal(pending.length, 1, 'trailing timer must be scheduled');

  // Re-mark dirty (as another track would)
  state.dirty = true;

  // Another call in the same window – no duplicate timer
  now = 70;
  strategy.persist();
  assert.equal(writes.length, 1, 'still throttled');
  assert.equal(
    state.scheduledTimers.filter((t) => !t.cancelled).length,
    1,
    'no duplicate trailing timer',
  );

  // Fire the trailing timer at t=150 (past window) → write
  now = 150;
  state.dirty = true;
  pending[0].cb();
  assert.equal(writes.length, 2, 'trailing timer must produce a second write');
});

// ---------------------------------------------------------------------------
// BasePersistStrategy – flushNow bypasses throttle
// ---------------------------------------------------------------------------

test('BasePersistStrategy (Sync): flushNow bypasses throttle and writes immediately', () => {
  let now = 0;
  const writes = [];

  const { ctx, state } = makeCtx({
    storageSetItem: (_k, v) => writes.push(v),
    throttleMs: 100,
    timerNow: () => now,
  });

  const strategy = new SyncPersistStrategy(ctx);

  // Leading-edge write
  now = 0;
  strategy.persist();
  assert.equal(writes.length, 1);

  // Within window: re-mark dirty and use flushNow
  now = 30;
  state.dirty = true;
  strategy.flushNow();
  assert.equal(writes.length, 2, 'flushNow must bypass throttle and write immediately');
});

// ---------------------------------------------------------------------------
// AsyncPersistStrategy – success
// ---------------------------------------------------------------------------

test('AsyncPersistStrategy: writes payload and clears dirty flag on success', async () => {
  const writes = [];
  const { ctx, state } = makeCtx({
    asyncStorageSetItem: async (_key, val) => writes.push(val),
  });

  const strategy = new AsyncPersistStrategy(ctx);
  strategy.persist();

  // Wait for microtasks scheduled by persist() to run
  await Promise.resolve();

  assert.equal(writes.length, 1, 'asyncStorage.setItem must be called once');
  const payload = JSON.parse(writes[0]);
  assert.equal(typeof payload.graphBinary, 'string');
  assert.equal(state.dirty, false);
  assert.equal(state.errors.length, 0);
});

// ---------------------------------------------------------------------------
// AsyncPersistStrategy – in-flight write sets pending flag
// ---------------------------------------------------------------------------

test('AsyncPersistStrategy: second persist() while in-flight sets pending flag, not a double-write', async () => {
  const writes = [];
  let resolveWrite;

  const { ctx, state } = makeCtx({
    asyncStorageSetItem: async (_key, val) => {
      writes.push(val);
      await new Promise((r) => {
        resolveWrite = r;
      });
    },
  });

  const strategy = new AsyncPersistStrategy(ctx);

  // First persist – starts the in-flight write
  strategy.persist();

  // Second persist while the first is still in-flight
  state.dirty = true;
  strategy.persist();

  // Only one write should be in-progress
  assert.equal(writes.length, 1, 'only one setItem call while in-flight');

  // Let the first write complete, then drain all queued microtasks.
  // setImmediate fires after all pending microtasks in the current event-loop
  // turn, so the AsyncPersistStrategy completion handler (which starts the
  // pending second write) is guaranteed to have run by the time we resume —
  // no arbitrary sleep needed.
  resolveWrite();
  await new Promise((r) => setImmediate(r));

  // After the first write completes, the pending flag should have triggered a second write
  assert.equal(writes.length, 2, 'pending write must be flushed after first completes');
});

// ---------------------------------------------------------------------------
// AsyncPersistStrategy – first-failure retry only
// ---------------------------------------------------------------------------

test('AsyncPersistStrategy: first failure schedules exactly one retry timer', async () => {
  let failOnce = true;
  const writes = [];

  const { ctx, state } = makeCtx({
    asyncStorageSetItem: async (_key, val) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient-fail');
      }
      writes.push(val);
    },
    debounceMs: 10,
    timerNow: () => 0,
  });

  const strategy = new AsyncPersistStrategy(ctx);
  strategy.persist();

  // Wait for the failing write to reject
  await new Promise((r) => setTimeout(r, 20));

  // Exactly one retry timer must be scheduled
  const uncancelled = state.scheduledTimers.filter((t) => !t.cancelled);
  assert.equal(uncancelled.length, 1, 'exactly one retry timer after first failure');
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].code, 'STORAGE_WRITE');

  // Fire the retry timer – should succeed this time
  uncancelled[0].cb();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writes.length, 1, 'retry must produce a successful write');
});

test('AsyncPersistStrategy: second consecutive failure does NOT schedule another retry', async () => {
  let timerCount = 0;

  const { ctx, state } = makeCtx({
    asyncStorageSetItem: async () => {
      throw new Error('persistent-fail');
    },
    debounceMs: 10,
    timerNow: () => 0,
  });

  // Override setTimeout to count calls
  const baseTimer = ctx.getTimer();
  const origGetTimer = ctx.getTimer.bind(ctx);
  ctx.getTimer = () => ({
    ...origGetTimer(),
    setTimeout(cb, ms) {
      timerCount += 1;
      return baseTimer.setTimeout(cb, ms);
    },
  });

  const strategy = new AsyncPersistStrategy(ctx);
  strategy.persist();

  // Wait for first failure
  await new Promise((r) => setTimeout(r, 20));
  const afterFirst = timerCount;
  assert.ok(afterFirst >= 1, 'at least one retry scheduled after first failure');

  // Fire the retry – will fail again
  const pending = state.scheduledTimers.filter((t) => !t.cancelled);
  for (const t of pending) t.cb();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(timerCount, afterFirst, 'second failure must NOT schedule another retry');
});

// ---------------------------------------------------------------------------
// AsyncPersistStrategy – QUOTA_EXCEEDED on async write
// ---------------------------------------------------------------------------

test('AsyncPersistStrategy: reports QUOTA_EXCEEDED and sets engineHealth on quota error', async () => {
  const quotaErr = new Error('QuotaExceededError');
  quotaErr.name = 'QuotaExceededError';

  const { ctx, state } = makeCtx({
    asyncStorageSetItem: async () => {
      throw quotaErr;
    },
    debounceMs: 0,
    timerNow: () => 0,
  });

  const strategy = new AsyncPersistStrategy(ctx);
  strategy.persist();

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].code, 'QUOTA_EXCEEDED');
  assert.equal(state.engineHealth, 'quota_exceeded');
});

// ---------------------------------------------------------------------------
// AsyncPersistStrategy – flushNow cancels retry timer and writes immediately
// ---------------------------------------------------------------------------

test('AsyncPersistStrategy: flushNow cancels pending retry and writes immediately', async () => {
  let failOnce = true;
  const writes = [];

  const { ctx, state } = makeCtx({
    asyncStorageSetItem: async (_key, val) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      writes.push(val);
    },
    debounceMs: 99999, // very long debounce – would never fire normally
    timerNow: () => 0,
  });

  const strategy = new AsyncPersistStrategy(ctx);
  strategy.persist();

  // Wait for first (failing) write
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    state.scheduledTimers.filter((t) => !t.cancelled).length,
    1,
    'retry timer scheduled',
  );

  // flushNow must cancel the retry timer and force an immediate write
  strategy.flushNow();
  await new Promise((r) => setTimeout(r, 20));

  const retryTimerCancelled = state.scheduledTimers[0]?.cancelled;
  assert.equal(retryTimerCancelled, true, 'retry timer must be cancelled by flushNow');
  assert.equal(writes.length, 1, 'flushNow must produce a successful write');
});

// ---------------------------------------------------------------------------
// codec: deserialize guards
// ---------------------------------------------------------------------------

test('codec/deserialize: empty base64 string throws RESTORE_PARSE (not a TypeError)', () => {
  // atob('') → '' → Uint8Array([]) → versioned.length === 0 → versioned[0] is undefined
  // Without the length guard, `undefined.toString(16)` would throw TypeError instead.
  assert.throws(
    () => deserialize(''),
    (err) => {
      assert.equal(err.code, 'RESTORE_PARSE', `expected RESTORE_PARSE, got ${err.code}`);
      assert.ok(typeof err.message === 'string' && err.message.length > 0);
      return true;
    },
  );
});

test('codec/deserialize: version mismatch throws RESTORE_PARSE with hex bytes in message', () => {
  const wrongVersion = (CURRENT_CODEC_VERSION + 1) & 0xff;
  // Build a raw versioned buffer with the wrong version byte
  const raw = new Uint8Array([wrongVersion, 0x01, 0x02, 0x03]);
  const base64 = btoa(String.fromCharCode(...raw));
  assert.throws(
    () => deserialize(base64),
    (err) => {
      assert.equal(err.code, 'RESTORE_PARSE', `expected RESTORE_PARSE, got ${err.code}`);
      assert.ok(err.message.includes('0x'), `message should contain hex bytes: ${err.message}`);
      return true;
    },
  );
});

test('codec/deserialize: valid round-trip returns original bytes', () => {
  const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const base64 = serialize(original);
  const result = deserialize(base64);
  assert.deepEqual(Array.from(result), Array.from(original));
});
