/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * Unit tests — Microkernel Architecture (Layer 2 + Web Plugins)
 *
 * Covers:
 *   1. IntentEngine — construction-time adapter wiring
 *   2. IntentEngine — track() processing pipeline (signals, events, persistence)
 *   3. IntentEngine — lifecycle event callbacks (pause, exit-intent)
 *   4. IntentEngine — IInputAdapter push path
 *   5. IntentEngine — destroy() teardown sequence
 *   6. ContinuousGraphModel — IStateModel contract (membership, transitions,
 *                             entropy, trajectory, serialize/restore)
 *   7. LocalStorageAdapter — IPersistenceAdapter contract (Node.js + mock window)
 *   8. createBrowserIntent factory — SSR-safe construction and functional smoke test
 *   9. MouseKinematicsAdapter — deferred initial state + navigation events
 *
 * All tests use plain-object mocks — no class inheritance, no spy libraries.
 * DOM-dependent adapters are tested by polyfilling `global.window` in-place
 * and cleaning up in `finally` blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IntentEngine } from '../dist/src/engine/intent-engine.js';
import { ContinuousGraphModel } from '../dist/src/plugins/web/ContinuousGraphModel.js';
import { LocalStorageAdapter } from '../dist/src/plugins/web/LocalStorageAdapter.js';
import { MouseKinematicsAdapter } from '../dist/src/plugins/web/MouseKinematicsAdapter.js';
import { createBrowserIntent } from '../dist/src/factory.js';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal IStateModel mock whose return values are fully configurable.
 *
 * @param {{ likelyNext?, entropy?, trajectory?, throwOnRestore? }} opts
 * @returns {{ model: IStateModel, calls: object }}
 */
function makeModel({
  likelyNext = [],
  entropy = { entropy: 0, normalizedEntropy: 0, isHigh: false },
  trajectory = null,
  throwOnRestore = false,
} = {}) {
  const calls = {
    markSeen: /** @type {string[]} */ ([]),
    recordTransition: /** @type {[string,string][]} */ ([]),
    evaluateEntropy: /** @type {string[]} */ ([]),
    evaluateTrajectory: /** @type {object[]} */ ([]),
    serialize: 0,
    restore: /** @type {string[]} */ ([]),
  };
  return {
    model: {
      markSeen(s) {
        calls.markSeen.push(s);
      },
      hasSeen(_s) {
        return false;
      },
      recordTransition(f, t) {
        calls.recordTransition.push([f, t]);
      },
      getLikelyNext(_s, _th) {
        return likelyNext;
      },
      evaluateEntropy(s) {
        calls.evaluateEntropy.push(s);
        return entropy;
      },
      evaluateTrajectory(f, t, traj) {
        calls.evaluateTrajectory.push({ f, t, traj });
        return trajectory;
      },
      serialize() {
        calls.serialize++;
        return '{"bloomBase64":"AA==","graphBinary":""}';
      },
      restore(s) {
        calls.restore.push(s);
        if (throwOnRestore) throw new Error('parse-fail');
      },
    },
    calls,
  };
}

/**
 * Build a minimal IPersistenceAdapter mock.
 *
 * @param {{ stored?, throwOnSave? }} opts
 * @returns {{ persistence: IPersistenceAdapter, calls: object }}
 */
function makePersistence({ stored = null, throwOnSave = false } = {}) {
  const calls = { load: 0, save: /** @type {string[]} */ ([]) };
  const store = new Map();
  if (stored !== null) store.set('passive-intent-engine', stored);
  return {
    persistence: {
      load(key) {
        calls.load++;
        return store.get(key) ?? null;
      },
      save(key, value) {
        calls.save.push(value);
        if (throwOnSave) throw new Error('quota');
        store.set(key, value);
      },
    },
    calls,
  };
}

/**
 * Build a minimal ILifecycleAdapter mock.
 *
 * @param {{ hasExitIntent? }} opts
 * @returns {{ lifecycle, fire, calls, teardowns }}
 */
function makeLifecycle({ hasExitIntent = true } = {}) {
  let pauseCb = null;
  let exitCb = null;
  const teardowns = { pause: false, exit: false };
  const calls = { onPause: 0, onExitIntent: 0, destroy: 0 };

  const lifecycle = {
    onPause(cb) {
      calls.onPause++;
      pauseCb = cb;
      return () => {
        teardowns.pause = true;
      };
    },
    onResume(_cb) {
      return () => {};
    },
    destroy() {
      calls.destroy++;
    },
  };

  if (hasExitIntent) {
    lifecycle.onExitIntent = (cb) => {
      calls.onExitIntent++;
      exitCb = cb;
      return () => {
        teardowns.exit = true;
      };
    };
  }

  return {
    lifecycle,
    fire: {
      pause() {
        pauseCb?.();
      },
      exitIntent() {
        exitCb?.();
      },
    },
    calls,
    teardowns,
  };
}

/**
 * Build a minimal IInputAdapter mock.
 *
 * @returns {{ input, push, calls, unsubCalled }}
 */
function makeInput() {
  let stateCb = null;
  let _unsubCalled = false;
  const calls = { subscribe: 0, destroy: 0 };
  return {
    input: {
      subscribe(cb) {
        calls.subscribe++;
        stateCb = cb;
        return () => {
          _unsubCalled = true;
        };
      },
      destroy() {
        calls.destroy++;
      },
    },
    push(state) {
      stateCb?.(state);
    },
    calls,
    get unsubCalled() {
      return _unsubCalled;
    },
  };
}

/**
 * Assemble a fully-mocked IntentEngine with optional overrides.
 *
 * @param {{ model?, persistence?, lifecycle?, withInput?, config? }} opts
 */
function makeEngine(opts = {}) {
  const { model, calls: modelCalls } = makeModel(opts.model ?? {});
  const { persistence, calls: persistCalls } = makePersistence(opts.persistence ?? {});
  const lcMock = makeLifecycle(opts.lifecycle ?? {});
  const inputMock = opts.withInput ? makeInput() : null;
  const errors = [];

  const engine = new IntentEngine({
    stateModel: model,
    persistence,
    lifecycle: lcMock.lifecycle,
    ...(inputMock ? { input: inputMock.input } : {}),
    onError: (e) => errors.push(e),
    ...(opts.config ?? {}),
  });

  return { engine, modelCalls, persistCalls, lcMock, inputMock, errors };
}

// ===========================================================================
// Section 1 — IntentEngine: construction-time adapter wiring
// ===========================================================================

test('IntentEngine construction: calls persistence.load() exactly once', () => {
  const { persistCalls } = makeEngine();
  assert.equal(persistCalls.load, 1);
});

test('IntentEngine construction: calls stateModel.restore() with the persisted payload', () => {
  const stored = '{"bloomBase64":"AA==","graphBinary":""}';
  const { modelCalls } = makeEngine({ persistence: { stored } });
  assert.equal(modelCalls.restore.length, 1);
  assert.equal(modelCalls.restore[0], stored);
});

test('IntentEngine construction: does NOT call stateModel.restore() when persistence returns null', () => {
  const { modelCalls } = makeEngine({ persistence: { stored: null } });
  assert.equal(modelCalls.restore.length, 0);
});

test('IntentEngine construction: routes RESTORE_READ error when persistence.load() throws', () => {
  const { model, calls: modelCalls } = makeModel();
  const errors = [];
  const throwingPersistence = {
    load() {
      throw new Error('storage-read-fail');
    },
    save() {},
  };
  new IntentEngine({
    stateModel: model,
    persistence: throwingPersistence,
    lifecycle: makeLifecycle().lifecycle,
    onError: (e) => errors.push(e),
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'RESTORE_READ');
  assert.ok(errors[0].message.includes('storage-read-fail'));
  // restore() must NOT be called when load() threw
  assert.equal(modelCalls.restore.length, 0);
});

test('IntentEngine construction: routes RESTORE_PARSE error when stateModel.restore() throws', () => {
  const { errors } = makeEngine({
    persistence: { stored: 'data' },
    model: { throwOnRestore: true },
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'RESTORE_PARSE');
  assert.ok(errors[0].message.includes('parse-fail'));
});

test('IntentEngine construction: registers lifecycle.onPause()', () => {
  const { lcMock } = makeEngine();
  assert.equal(lcMock.calls.onPause, 1);
});

test('IntentEngine construction: registers lifecycle.onExitIntent() when the method exists', () => {
  const { lcMock } = makeEngine({ lifecycle: { hasExitIntent: true } });
  assert.equal(lcMock.calls.onExitIntent, 1);
});

test('IntentEngine construction: does not require lifecycle.onExitIntent() to exist', () => {
  // Optional method — engine must construct cleanly without it.
  assert.doesNotThrow(() => makeEngine({ lifecycle: { hasExitIntent: false } }));
});

test('IntentEngine construction: calls input.subscribe() when an input adapter is provided', () => {
  const { inputMock } = makeEngine({ withInput: true });
  assert.equal(inputMock.calls.subscribe, 1);
});

// ===========================================================================
// Section 2 — IntentEngine: track() processing pipeline
// ===========================================================================

test('IntentEngine track(): emits state_change with from:null on the first call', () => {
  const { engine } = makeEngine();
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/home');
  assert.equal(events.length, 1);
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, '/home');
  engine.destroy();
});

test('IntentEngine track(): emits state_change with the previous state as from on subsequent calls', () => {
  const { engine } = makeEngine();
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/home');
  engine.track('/checkout');
  assert.equal(events[1].from, '/home');
  assert.equal(events[1].to, '/checkout');
  engine.destroy();
});

test('IntentEngine track(): stateModel.markSeen() throwing routes STATE_MODEL error and aborts the call', () => {
  const { model, calls: modelCalls } = makeModel();
  let throwOnNext = false;
  const originalMarkSeen = model.markSeen.bind(model);
  model.markSeen = (s) => {
    if (throwOnNext) throw new Error('markSeen-fail');
    originalMarkSeen(s);
  };
  const errors = [];
  const engine = new IntentEngine({
    stateModel: model,
    persistence: makePersistence().persistence,
    lifecycle: makeLifecycle().lifecycle,
    onError: (e) => errors.push(e),
  });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  throwOnNext = true;
  engine.track('/boom');
  assert.equal(events.length, 0, 'state_change must not fire when markSeen throws');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'STATE_MODEL');
  assert.ok(errors[0].message.includes('markSeen-fail'));
  engine.destroy();
});

test('IntentEngine track(): stateModel.evaluateEntropy() throwing routes STATE_MODEL error but state_change still fires', () => {
  const { model } = makeModel();
  model.evaluateEntropy = () => {
    throw new Error('entropy-fail');
  };
  const errors = [];
  const engine = new IntentEngine({
    stateModel: model,
    persistence: makePersistence().persistence,
    lifecycle: makeLifecycle().lifecycle,
    onError: (e) => errors.push(e),
  });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/a');
  engine.track('/b');
  assert.equal(events.length, 2, 'state_change must still fire after evaluateEntropy throws');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'STATE_MODEL');
  assert.ok(errors[0].message.includes('entropy-fail'));
  engine.destroy();
});

test('IntentEngine track(): stateModel.evaluateTrajectory() throwing routes STATE_MODEL error but state_change still fires', () => {
  const { model } = makeModel();
  model.evaluateTrajectory = () => {
    throw new Error('trajectory-fail');
  };
  const errors = [];
  const engine = new IntentEngine({
    stateModel: model,
    persistence: makePersistence().persistence,
    lifecycle: makeLifecycle().lifecycle,
    onError: (e) => errors.push(e),
  });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/a');
  engine.track('/b');
  assert.equal(events.length, 2, 'state_change must still fire after evaluateTrajectory throws');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'STATE_MODEL');
  assert.ok(errors[0].message.includes('trajectory-fail'));
  engine.destroy();
});

test('IntentEngine track(): stateModel.markSeen() for every tracked state', () => {
  const { engine, modelCalls } = makeEngine();
  engine.track('/a');
  engine.track('/b');
  assert.deepEqual(modelCalls.markSeen, ['/a', '/b']);
  engine.destroy();
});

test('IntentEngine track(): does NOT call recordTransition on the very first track (no prior state)', () => {
  const { engine, modelCalls } = makeEngine();
  engine.track('/a');
  assert.equal(modelCalls.recordTransition.length, 0);
  engine.destroy();
});

test('IntentEngine track(): calls recordTransition(from, to) starting with the second track', () => {
  const { engine, modelCalls } = makeEngine();
  engine.track('/a');
  engine.track('/b');
  assert.equal(modelCalls.recordTransition.length, 1);
  assert.deepEqual(modelCalls.recordTransition[0], ['/a', '/b']);
  engine.destroy();
});

test('IntentEngine track(): does NOT call evaluateEntropy before a transition exists', () => {
  const { engine, modelCalls } = makeEngine();
  engine.track('/a');
  assert.equal(modelCalls.evaluateEntropy.length, 0);
  engine.destroy();
});

test('IntentEngine track(): emits high_entropy when evaluateEntropy returns isHigh:true', () => {
  const { engine } = makeEngine({
    model: { entropy: { entropy: 2.5, normalizedEntropy: 0.92, isHigh: true } },
  });
  const events = [];
  engine.on('high_entropy', (e) => events.push(e));
  engine.track('/a');
  engine.track('/b');
  assert.equal(events.length, 1);
  assert.equal(events[0].state, '/b');
  assert.equal(events[0].normalizedEntropy, 0.92);
  engine.destroy();
});

test('IntentEngine track(): does NOT emit high_entropy when evaluateEntropy returns isHigh:false', () => {
  const { engine } = makeEngine({
    model: { entropy: { entropy: 0.1, normalizedEntropy: 0.1, isHigh: false } },
  });
  const events = [];
  engine.on('high_entropy', (e) => events.push(e));
  engine.track('/a');
  engine.track('/b');
  assert.equal(events.length, 0);
  engine.destroy();
});

test('IntentEngine track(): emits trajectory_anomaly when evaluateTrajectory returns isAnomalous:true', () => {
  const { engine } = makeEngine({
    model: {
      trajectory: { zScore: 4.2, isAnomalous: true, logLikelihood: -9, baselineLogLikelihood: -2 },
    },
  });
  const events = [];
  engine.on('trajectory_anomaly', (e) => events.push(e));
  engine.track('/a');
  engine.track('/b');
  assert.equal(events.length, 1);
  assert.equal(events[0].stateFrom, '/a');
  assert.equal(events[0].stateTo, '/b');
  assert.equal(events[0].zScore, 4.2);
  engine.destroy();
});

test('IntentEngine track(): does NOT emit trajectory_anomaly when evaluateTrajectory returns null', () => {
  const { engine } = makeEngine({ model: { trajectory: null } });
  const events = [];
  engine.on('trajectory_anomaly', (e) => events.push(e));
  engine.track('/a');
  engine.track('/b');
  assert.equal(events.length, 0);
  engine.destroy();
});

test('IntentEngine track(): calls persistence.save() after every track call', () => {
  const { engine, persistCalls } = makeEngine();
  engine.track('/a');
  engine.track('/b');
  engine.track('/c');
  assert.equal(persistCalls.save.length, 3);
  engine.destroy();
});

test('IntentEngine track(): strips query string from state via built-in normalizer', () => {
  const { engine } = makeEngine();
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/page?search=cats&sort=asc');
  assert.equal(events[0].to, '/page');
  engine.destroy();
});

test('IntentEngine track(): applies custom stateNormalizer after built-in normalization', () => {
  const { engine } = makeEngine({
    config: {
      stateNormalizer: (s) => s.replace(/^\/product\/[^/]+$/, '/product/:slug'),
    },
  });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/product/cool-sneakers');
  assert.equal(events[0].to, '/product/:slug');
  engine.destroy();
});

test('IntentEngine track(): empty string returned by stateNormalizer silently drops the track call', () => {
  const { engine } = makeEngine({ config: { stateNormalizer: () => '' } });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/any');
  assert.equal(events.length, 0);
  engine.destroy();
});

test('IntentEngine track(): stateNormalizer returning a non-string routes a VALIDATION error and drops the call', () => {
  for (const badReturn of [null, undefined, 42, {}, []]) {
    const { engine, errors } = makeEngine({
      config: { stateNormalizer: () => badReturn },
    });
    const events = [];
    engine.on('state_change', (e) => events.push(e));
    engine.track('/any');
    assert.equal(
      events.length,
      0,
      `expected no state_change for return value ${JSON.stringify(badReturn)}`,
    );
    assert.equal(
      errors.length,
      1,
      `expected one VALIDATION error for return value ${JSON.stringify(badReturn)}`,
    );
    assert.equal(errors[0].code, 'VALIDATION');
    assert.ok(errors[0].message.includes('stateNormalizer must return a string'));
    engine.destroy();
  }
});

test('IntentEngine track(): stateNormalizer throwing routes a VALIDATION error and drops the call', () => {
  const { engine, errors } = makeEngine({
    config: {
      stateNormalizer: () => {
        throw new Error('normalizer-fail');
      },
    },
  });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/any');
  assert.equal(events.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'VALIDATION');
  engine.destroy();
});

test('IntentEngine track(): persistence.save() throwing routes a STORAGE_WRITE error', () => {
  const { engine, errors } = makeEngine({ persistence: { throwOnSave: true } });
  engine.track('/a');
  assert.equal(errors[0].code, 'STORAGE_WRITE');
  // engine.destroy() will also attempt save; don't assert errors.length after
});

// ===========================================================================
// Section 3 — IntentEngine: lifecycle event callbacks
// ===========================================================================

test('IntentEngine lifecycle: onPause callback triggers persistence.save()', () => {
  const { lcMock, persistCalls } = makeEngine();
  const savesBefore = persistCalls.save.length;
  lcMock.fire.pause();
  assert.equal(persistCalls.save.length, savesBefore + 1);
});

test('IntentEngine lifecycle: onExitIntent emits exit_intent with the top candidate', () => {
  const { engine, lcMock } = makeEngine({
    model: { likelyNext: [{ state: '/checkout', probability: 0.8 }] },
    lifecycle: { hasExitIntent: true },
  });
  const events = [];
  engine.on('exit_intent', (e) => events.push(e));
  engine.track('/cart');
  lcMock.fire.exitIntent();
  assert.equal(events.length, 1);
  assert.equal(events[0].state, '/cart');
  assert.equal(events[0].likelyNext, '/checkout');
  engine.destroy();
});

test('IntentEngine lifecycle: onExitIntent does NOT emit before any state has been tracked', () => {
  const { engine, lcMock } = makeEngine({
    model: { likelyNext: [{ state: '/checkout', probability: 0.8 }] },
    lifecycle: { hasExitIntent: true },
  });
  const events = [];
  engine.on('exit_intent', (e) => events.push(e));
  lcMock.fire.exitIntent(); // fired before any track()
  assert.equal(events.length, 0);
  engine.destroy();
});

test('IntentEngine lifecycle: onExitIntent does NOT emit when likelyNext candidates are empty', () => {
  const { engine, lcMock } = makeEngine({
    model: { likelyNext: [] },
    lifecycle: { hasExitIntent: true },
  });
  const events = [];
  engine.on('exit_intent', (e) => events.push(e));
  engine.track('/cart');
  lcMock.fire.exitIntent();
  assert.equal(events.length, 0);
  engine.destroy();
});

// ===========================================================================
// Section 4 — IntentEngine: IInputAdapter push path
// ===========================================================================

test('IntentEngine input adapter: push-based state triggers the full track() pipeline', () => {
  const { engine, inputMock } = makeEngine({ withInput: true });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  inputMock.push('/from-adapter');
  assert.equal(events.length, 1);
  assert.equal(events[0].to, '/from-adapter');
  engine.destroy();
});

test('IntentEngine input adapter: two pushed states produce a recordTransition call', () => {
  const { engine, inputMock, modelCalls } = makeEngine({ withInput: true });
  inputMock.push('/a');
  inputMock.push('/b');
  assert.equal(modelCalls.recordTransition.length, 1);
  assert.deepEqual(modelCalls.recordTransition[0], ['/a', '/b']);
  engine.destroy();
});

// ===========================================================================
// Section 5 — IntentEngine: destroy() teardown sequence
// ===========================================================================

test('IntentEngine construction: input.subscribe() throwing routes ADAPTER_SETUP error and engine still constructs', () => {
  const errors = [];
  const throwingInput = {
    subscribe() {
      throw new Error('subscribe-fail');
    },
    destroy() {},
  };
  let engine;
  assert.doesNotThrow(() => {
    engine = new IntentEngine({
      stateModel: makeModel().model,
      persistence: makePersistence().persistence,
      lifecycle: makeLifecycle().lifecycle,
      input: throwingInput,
      onError: (e) => errors.push(e),
    });
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ADAPTER_SETUP');
  assert.ok(errors[0].message.includes('subscribe-fail'));
  engine.destroy();
});

test('IntentEngine destroy(): one throwing teardown does not prevent subsequent teardowns from running', () => {
  const ran = [];
  const { engine } = makeEngine();
  // Inject two teardowns: first throws, second must still run
  engine['teardowns'].push(() => {
    throw new Error('teardown-boom');
  });
  engine['teardowns'].push(() => ran.push('after-throw'));
  const errors = [];
  engine['onError'] = (e) => errors.push(e);
  engine.destroy();
  assert.ok(ran.includes('after-throw'), 'teardown after the throwing one must still run');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ADAPTER_TEARDOWN');
});

test('IntentEngine destroy(): lifecycle.destroy() throwing does not prevent input.destroy() from running', () => {
  const inputDestroyCalled = { value: false };
  const { lifecycle } = makeLifecycle();
  lifecycle.destroy = () => {
    throw new Error('lifecycle-destroy-fail');
  };
  const input = makeInput();
  const errors = [];
  const engine = new IntentEngine({
    stateModel: makeModel().model,
    persistence: makePersistence().persistence,
    lifecycle,
    input: input.input,
    onError: (e) => errors.push(e),
  });
  engine.destroy();
  assert.equal(
    input.calls.destroy,
    1,
    'input.destroy() must run even when lifecycle.destroy() throws',
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ADAPTER_TEARDOWN');
});

test('IntentEngine destroy(): flushes persistence before tearing down', () => {
  const { engine, persistCalls } = makeEngine();
  const savesBeforeDestroy = persistCalls.save.length;
  engine.destroy();
  assert.ok(
    persistCalls.save.length > savesBeforeDestroy,
    'final persist must fire during destroy()',
  );
});

test('IntentEngine destroy(): calls lifecycle.destroy()', () => {
  const { engine, lcMock } = makeEngine();
  engine.destroy();
  assert.equal(lcMock.calls.destroy, 1);
});

test('IntentEngine destroy(): calls input.destroy() when an input adapter was provided', () => {
  const { engine, inputMock } = makeEngine({ withInput: true });
  engine.destroy();
  assert.equal(inputMock.calls.destroy, 1);
});

test('IntentEngine destroy(): calls the input unsubscribe teardown', () => {
  const { engine, inputMock } = makeEngine({ withInput: true });
  engine.destroy();
  assert.equal(inputMock.unsubCalled, true);
});

test('IntentEngine destroy(): calls the lifecycle onPause unsubscribe teardown', () => {
  const { engine, lcMock } = makeEngine();
  engine.destroy();
  assert.equal(lcMock.teardowns.pause, true);
});

test('IntentEngine destroy(): calls the lifecycle onExitIntent unsubscribe teardown', () => {
  const { engine, lcMock } = makeEngine({ lifecycle: { hasExitIntent: true } });
  engine.destroy();
  assert.equal(lcMock.teardowns.exit, true);
});

// ===========================================================================
// Section 6 — ContinuousGraphModel: IStateModel contract
// ===========================================================================

test('ContinuousGraphModel: hasSeen returns false for a state that was never marked', () => {
  const model = new ContinuousGraphModel();
  assert.equal(model.hasSeen('/home'), false);
});

test('ContinuousGraphModel: markSeen / hasSeen round-trip', () => {
  const model = new ContinuousGraphModel();
  model.markSeen('/home');
  assert.equal(model.hasSeen('/home'), true);
});

test('ContinuousGraphModel: marking one state does not affect membership of another', () => {
  const model = new ContinuousGraphModel();
  model.markSeen('/home');
  assert.equal(model.hasSeen('/about'), false);
});

test('ContinuousGraphModel: getLikelyNext returns the recorded candidate after repeated transitions', () => {
  const model = new ContinuousGraphModel();
  model.recordTransition('/home', '/checkout');
  model.recordTransition('/home', '/checkout');
  const candidates = model.getLikelyNext('/home', 0.1);
  assert.ok(candidates.length > 0, 'must return at least one candidate');
  assert.equal(candidates[0].state, '/checkout');
  assert.ok(candidates[0].probability > 0, 'probability must be positive');
});

test('ContinuousGraphModel: getLikelyNext returns empty array for an unknown state', () => {
  const model = new ContinuousGraphModel();
  assert.deepEqual(model.getLikelyNext('/ghost', 0.1), []);
});

test('ContinuousGraphModel: evaluateEntropy returns isHigh:false on a fresh model', () => {
  const model = new ContinuousGraphModel();
  const result = model.evaluateEntropy('/any');
  assert.equal(result.isHigh, false);
  assert.equal(result.entropy, 0);
});

test('ContinuousGraphModel: evaluateTrajectory returns null when no baseline is configured', () => {
  const model = new ContinuousGraphModel();
  const result = model.evaluateTrajectory('/a', '/b', ['/a', '/b']);
  assert.equal(result, null);
});

test('ContinuousGraphModel: serialize / restore round-trip preserves Bloom filter membership', () => {
  const original = new ContinuousGraphModel();
  original.markSeen('/dashboard');
  original.markSeen('/settings');

  const serialized = original.serialize();
  assert.equal(typeof serialized, 'string', 'serialize must return a string');

  const restored = new ContinuousGraphModel();
  restored.restore(serialized);
  assert.equal(restored.hasSeen('/dashboard'), true);
  assert.equal(restored.hasSeen('/settings'), true);
  assert.equal(restored.hasSeen('/never-seen'), false);
});

test('ContinuousGraphModel: serialize / restore round-trip preserves transition history', () => {
  const original = new ContinuousGraphModel();
  original.recordTransition('/a', '/b');
  original.recordTransition('/a', '/b');

  const restored = new ContinuousGraphModel();
  restored.restore(original.serialize());

  const candidates = restored.getLikelyNext('/a', 0.1);
  assert.ok(
    candidates.some((c) => c.state === '/b'),
    'restored model must know /a→/b transition',
  );
});

test('ContinuousGraphModel: restore() throws on invalid JSON so IntentEngine can surface it', () => {
  const model = new ContinuousGraphModel();
  assert.throws(() => model.restore('not-valid-json'), SyntaxError);
});

// ===========================================================================
// Section 7 — LocalStorageAdapter: IPersistenceAdapter contract
// ===========================================================================

test('LocalStorageAdapter: load() returns null in Node.js (no window object)', () => {
  const adapter = new LocalStorageAdapter();
  assert.equal(adapter.load('any-key'), null);
});

test('LocalStorageAdapter: save() is a no-op in Node.js (no window object)', () => {
  const adapter = new LocalStorageAdapter();
  assert.doesNotThrow(() => adapter.save('any-key', 'value'));
});

test('LocalStorageAdapter: load() returns null when the key is absent from storage', () => {
  const store = new Map();
  global.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  try {
    const adapter = new LocalStorageAdapter();
    assert.equal(adapter.load('missing-key'), null);
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: save() then load() returns the persisted value', () => {
  const store = new Map();
  global.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  try {
    const adapter = new LocalStorageAdapter();
    adapter.save('intent-key', 'serialized-payload');
    assert.equal(adapter.load('intent-key'), 'serialized-payload');
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: save() overwrites a previously stored value', () => {
  const store = new Map();
  global.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  try {
    const adapter = new LocalStorageAdapter();
    adapter.save('k', 'first');
    adapter.save('k', 'second');
    assert.equal(adapter.load('k'), 'second');
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: load() returns null on SecurityError (sandboxed iframe)', () => {
  global.window = {
    localStorage: {
      getItem: () => {
        const e = new Error('Permission denied');
        e.name = 'SecurityError';
        throw e;
      },
      setItem: () => {},
    },
  };
  try {
    const adapter = new LocalStorageAdapter();
    assert.equal(adapter.load('any-key'), null);
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: load() returns null when window.localStorage property access itself throws SecurityError', () => {
  // Covers the case where accessing window.localStorage (not just getItem) throws —
  // e.g. sandboxed iframes on opaque origins. The guard is now inside the try block.
  Object.defineProperty(global, 'window', {
    get() {
      const e = new Error('SecurityError');
      e.name = 'SecurityError';
      throw e;
    },
    configurable: true,
  });
  try {
    const adapter = new LocalStorageAdapter();
    assert.equal(adapter.load('any-key'), null);
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: save() swallows QuotaExceededError without throwing', () => {
  global.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      },
    },
  };
  try {
    const adapter = new LocalStorageAdapter();
    assert.doesNotThrow(() => adapter.save('any-key', 'large-value'));
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: save() swallows SecurityError from setItem without throwing', () => {
  global.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        const e = new Error('SecurityError');
        e.name = 'SecurityError';
        throw e;
      },
    },
  };
  try {
    const adapter = new LocalStorageAdapter();
    assert.doesNotThrow(() => adapter.save('any-key', 'value'));
  } finally {
    delete global.window;
  }
});

test('LocalStorageAdapter: multiple adapters sharing storage are independent by key', () => {
  const store = new Map();
  global.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  try {
    const a = new LocalStorageAdapter();
    const b = new LocalStorageAdapter();
    a.save('app-a', 'data-a');
    b.save('app-b', 'data-b');
    assert.equal(a.load('app-a'), 'data-a');
    assert.equal(b.load('app-b'), 'data-b');
    assert.equal(a.load('app-b'), 'data-b'); // same backing store
  } finally {
    delete global.window;
  }
});

// ===========================================================================
// Section 8 — createBrowserIntent factory
// ===========================================================================

test('createBrowserIntent: returns a live IntentEngine without throwing in Node.js (SSR-safe)', () => {
  // All web plugins guard against typeof window === 'undefined', so this
  // must not throw even in a Node.js environment with no DOM.
  const engine = createBrowserIntent({ storageKey: 'test-factory' });
  assert.ok(engine !== null && typeof engine === 'object');
  assert.equal(typeof engine.on, 'function');
  assert.equal(typeof engine.track, 'function');
  assert.equal(typeof engine.destroy, 'function');
  engine.destroy();
});

test('createBrowserIntent: track() and on() are functional on the returned engine', () => {
  const engine = createBrowserIntent({ storageKey: 'test-factory-events' });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/test-page');
  assert.equal(events.length, 1);
  assert.equal(events[0].to, '/test-page');
  engine.destroy();
});

test('createBrowserIntent: custom onError is wired through to the engine', () => {
  const errors = [];
  const engine = createBrowserIntent({
    storageKey: 'test-factory-error',
    onError: (e) => errors.push(e),
    stateNormalizer: () => {
      throw new Error('normalizer-boom');
    },
  });
  engine.track('/anything');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'VALIDATION');
  engine.destroy();
});

test('createBrowserIntent: custom stateNormalizer is applied to tracked states', () => {
  const engine = createBrowserIntent({
    storageKey: 'test-factory-normalizer',
    stateNormalizer: (s) => s.replace(/^\/item\/\d+$/, '/item/:id'),
  });
  const events = [];
  engine.on('state_change', (e) => events.push(e));
  engine.track('/item/9876');
  assert.equal(events[0].to, '/item/:id');
  engine.destroy();
});

test('createBrowserIntent: two independent instances do not share state', () => {
  const a = createBrowserIntent({ storageKey: 'factory-a' });
  const b = createBrowserIntent({ storageKey: 'factory-b' });
  const aEvents = [];
  const bEvents = [];
  a.on('state_change', (e) => aEvents.push(e));
  b.on('state_change', (e) => bEvents.push(e));
  a.track('/only-in-a');
  assert.equal(aEvents.length, 1);
  assert.equal(bEvents.length, 0);
  a.destroy();
  b.destroy();
});

// ===========================================================================
// Section 9 — MouseKinematicsAdapter: deferred initial state + navigation
// ===========================================================================

/**
 * Minimal mock window that satisfies MouseKinematicsAdapter.subscribe().
 * Listeners are collected so tests can fire fake events.
 */
function makeMockWindow(pathname = '/mock-path') {
  const listeners = {};
  return {
    location: { pathname },
    addEventListener(event, handler) {
      listeners[event] = handler;
    },
    removeEventListener(event) {
      delete listeners[event];
    },
    history: { pushState() {} },
    /** Fire a registered event handler by name. */
    dispatch(event) {
      listeners[event]?.();
    },
    listeners,
  };
}

test('MouseKinematicsAdapter: initial state is NOT emitted synchronously inside subscribe()', () => {
  const mockWin = makeMockWindow('/deferred-check');
  global.window = mockWin;
  try {
    const adapter = new MouseKinematicsAdapter();
    const states = [];
    adapter.subscribe((s) => states.push(s));
    // Must be zero — queueMicrotask defers the emit
    assert.equal(states.length, 0, 'initial state must not fire synchronously');
    adapter.destroy();
  } finally {
    delete global.window;
  }
});

test('MouseKinematicsAdapter: initial state is emitted after the current microtask checkpoint', async () => {
  const mockWin = makeMockWindow('/async-check');
  global.window = mockWin;
  try {
    const adapter = new MouseKinematicsAdapter();
    const states = [];
    adapter.subscribe((s) => states.push(s));
    // Yield to the microtask queue
    await Promise.resolve();
    assert.equal(states.length, 1);
    assert.equal(states[0], '/async-check');
    adapter.destroy();
  } finally {
    delete global.window;
  }
});

test('MouseKinematicsAdapter: listener registered after subscribe() still receives the initial state', async () => {
  // This is the exact regression scenario: engine.on() is called after
  // createBrowserIntent() returns, so the callback is set up after subscribe().
  const mockWin = makeMockWindow('/regression-guard');
  global.window = mockWin;
  try {
    const adapter = new MouseKinematicsAdapter();
    // subscribe first — simulates what IntentEngine constructor does
    const states = [];
    const unsub = adapter.subscribe((s) => states.push(s));
    // Attach a downstream listener after subscribe (simulates app.ts engine.on())
    // — in the real flow this is the event listener added to the IntentEngine
    // after createBrowserIntent() returns; the adapter callback captures it via closure.
    assert.equal(states.length, 0, 'must not fire before microtask boundary');
    await Promise.resolve();
    assert.equal(states.length, 1, 'must fire after microtask boundary');
    unsub();
    adapter.destroy();
  } finally {
    delete global.window;
  }
});

test('MouseKinematicsAdapter: popstate fires synchronously (navigation events are not deferred)', () => {
  const mockWin = makeMockWindow('/start');
  global.window = mockWin;
  try {
    const adapter = new MouseKinematicsAdapter();
    const states = [];
    adapter.subscribe((s) => states.push(s));
    // Simulate a popstate navigation (synchronous path)
    mockWin.location.pathname = '/after-nav';
    mockWin.dispatch('popstate');
    // Popstate handler calls handleNavigation() → emit() synchronously
    assert.equal(states.length, 1, 'popstate state must fire synchronously');
    assert.equal(states[0], '/after-nav');
    adapter.destroy();
  } finally {
    delete global.window;
  }
});

test('MouseKinematicsAdapter: destroy() prevents further state emissions after popstate', () => {
  const mockWin = makeMockWindow('/page');
  global.window = mockWin;
  try {
    const adapter = new MouseKinematicsAdapter();
    const states = [];
    adapter.subscribe((s) => states.push(s));
    adapter.destroy();
    mockWin.location.pathname = '/after-destroy';
    mockWin.dispatch('popstate');
    assert.equal(states.length, 0, 'no events must fire after destroy()');
  } finally {
    delete global.window;
  }
});

test('createBrowserIntent: listener registered after construction receives initial state_change via microtask', async () => {
  const store = new Map();
  const mockWin = makeMockWindow('/factory-deferred');
  mockWin.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  mockWin.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  mockWin.documentElement = { addEventListener() {}, removeEventListener() {} };
  global.window = mockWin;
  global.document = mockWin.document;
  try {
    const engine = createBrowserIntent({ storageKey: 'test-microtask-deferred' });
    const events = [];
    engine.on('state_change', (e) => events.push(e));
    // Synchronously: no events yet — deferred to microtask
    assert.equal(events.length, 0, 'state_change must not fire synchronously after construction');
    await Promise.resolve();
    assert.equal(events.length, 1, 'state_change must fire after microtask boundary');
    assert.equal(events[0].to, '/factory-deferred');
    engine.destroy();
  } finally {
    delete global.window;
    delete global.document;
  }
});
