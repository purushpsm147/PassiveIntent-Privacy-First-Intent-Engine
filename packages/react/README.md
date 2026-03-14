# `@passiveintent/react`

> React 18+ wrapper for [`@passiveintent/core`](../core/README.md) with provider-based sharing, standalone engine mode, reactive intent hooks, and React-friendly wrappers around the core data structures.

[![Open React demo in StackBlitz](https://img.shields.io/badge/StackBlitz-React-1389FD?logo=stackblitz&logoColor=white)](https://stackblitz.com/github/passiveintent/core/tree/main/demo-react)

---

## Installation

```bash
npm install @passiveintent/react @passiveintent/core
# peer deps
npm install react react-dom
```

`@passiveintent/react@1.1.x` expects `@passiveintent/core@^1.1.0`.

---

## What 1.1 Adds

- `PassiveIntentProvider` for a single shared `IntentManager` across your tree
- `usePassiveIntent()` context mode alongside the existing standalone `usePassiveIntent(config)`
- Reactive provider hooks for exit intent, idle/resume, attention return, propensity, predictive prefetching, and event logs
- Standalone `useBloomFilter()` and `useMarkovGraph()` hooks for visualizations and custom tooling
- Re-exports of the core types, classes, and helpers commonly needed in React apps

---

## Quick Start

### Recommended: shared engine with `PassiveIntentProvider`

```tsx
'use client';

import {
  PassiveIntentProvider,
  usePassiveIntent,
  useExitIntent,
  usePredictiveLink,
} from '@passiveintent/react';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

function IntentTracker() {
  const pathname = usePathname();
  const { track, on, getTelemetry } = usePassiveIntent();
  const { triggered, likelyNext, dismiss } = useExitIntent();

  usePredictiveLink({
    threshold: 0.35,
    sanitize: (state) => !state.startsWith('/admin'),
  });

  useEffect(() => {
    track(pathname);
  }, [pathname, track]);

  useEffect(() => {
    return on('high_entropy', () => {
      console.log('[PassiveIntent] telemetry', getTelemetry());
    });
  }, [on, getTelemetry]);

  if (!triggered) return null;

  return (
    <aside>
      <p>Still deciding?</p>
      <p>Most likely next step: {likelyNext ?? 'unknown'}</p>
      <button onClick={dismiss}>Close</button>
    </aside>
  );
}

export function App() {
  return (
    <PassiveIntentProvider
      config={{
        storageKey: 'my-app-intent',
        botProtection: true,
        eventCooldownMs: 60_000,
      }}
    >
      <IntentTracker />
    </PassiveIntentProvider>
  );
}
```

### Standalone mode

Use this when a component should own its own isolated engine instance.

```tsx
import { usePassiveIntent } from '@passiveintent/react';
import { useEffect } from 'react';

export function WidgetTracker({ route }: { route: string }) {
  const { track, getTelemetry } = usePassiveIntent({
    storageKey: 'embedded-widget',
    crossTabSync: false,
  });

  useEffect(() => {
    track(route);
  }, [route, track]);

  return <pre>{JSON.stringify(getTelemetry(), null, 2)}</pre>;
}
```

---

## Core API

### `PassiveIntentProvider`

Place this near your app root when multiple components should share one engine.

| Prop       | Type                               | Notes                                                                                         |
| ---------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `config`   | `IntentManagerConfig`              | Required. Captured on first render; remount to apply changes.                                 |
| `adapters` | `{ storage?, timer?, lifecycle? }` | Optional adapter overrides merged into `config`. `lifecycle` maps to core `lifecycleAdapter`. |
| `children` | `ReactNode`                        | Descendant components can call `usePassiveIntent()` with no arguments.                        |

### `usePassiveIntent`

Two overloads:

```ts
usePassiveIntent(): UsePassiveIntentReturn
usePassiveIntent(config: IntentManagerConfig): UsePassiveIntentReturn
```

- `usePassiveIntent()` reads the nearest `PassiveIntentProvider` and throws if none exists.
- `usePassiveIntent(config)` creates a component-scoped `IntentManager`.
- Both modes are SSR-safe and Strict Mode safe.
- Config is captured on first render in both modes; remount to apply a new config.

All returned methods are stable across re-renders.

| Method              | Signature                                                             | Notes                                                              |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `track`             | `(state: string) => void`                                             | Records a page view or custom state transition.                    |
| `on`                | `(event, listener) => () => void`                                     | Typed subscription API. Returns a no-op unsubscribe during SSR.    |
| `getTelemetry`      | `() => PassiveIntentTelemetry`                                        | Returns a fully shaped zero-value object until the engine is live. |
| `predictNextStates` | `(threshold?, sanitize?) => { state: string; probability: number }[]` | Sorted Markov predictions.                                         |
| `hasSeen`           | `(state: string) => boolean`                                          | Bloom filter membership test.                                      |
| `incrementCounter`  | `(key: string, by?: number) => number`                                | Exact session counter increment.                                   |
| `getCounter`        | `(key: string) => number`                                             | Reads a session counter.                                           |
| `resetCounter`      | `(key: string) => void`                                               | Resets a session counter.                                          |

---

## Provider Hooks

All hooks in this section require a `PassiveIntentProvider` ancestor.

| Hook                                        | Returns                                     | Purpose                                                                                            |
| ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `useExitIntent()`                           | `{ triggered, state, likelyNext, dismiss }` | Reacts to `exit_intent` and lets you clear the signal after showing UI.                            |
| `useIdle()`                                 | `{ isIdle, idleMs }`                        | Tracks `user_idle` and `user_resumed`.                                                             |
| `useAttentionReturn()`                      | `{ returned, hiddenDuration, dismiss }`     | Reacts when a user comes back after being away long enough to trigger `attention_return`.          |
| `useSignals()`                              | `{ exitIntent, idle, attentionReturn }`     | Convenience composition of the three signal hooks above.                                           |
| `usePropensity(targetState, options?)`      | `number`                                    | Single-hop conversion score with dwell-time friction.                                              |
| `usePropensityScore(targetState, options?)` | `number`                                    | Same scoring model, but computed directly in `getSnapshot()` for strictly snapshot-driven updates. |
| `usePredictiveLink(options?)`               | `{ predictions }`                           | Reads `predictNextStates()` on navigation and can inject `<link rel="prefetch">` tags.             |
| `useEventLog(events, options?)`             | `{ log, clear }`                            | Bounded reverse-chronological log of selected engine events.                                       |

### Hook defaults

| Hook                   | Default options                      |
| ---------------------- | ------------------------------------ |
| `usePropensity()`      | `alpha = 0.2`                        |
| `usePropensityScore()` | `alpha = 0.2`                        |
| `usePredictiveLink()`  | `threshold = 0.3`, `prefetch = true` |
| `useEventLog()`        | `maxEntries = 100`                   |

---

## Standalone Data-Structure Hooks

These hooks do not require a provider.

| Hook                      | Returns                                                                                                     | Purpose                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `useBloomFilter(config?)` | `{ add, check, itemCount, estimatedFPR, bits, toBase64 }`                                                   | React wrapper around core `BloomFilter` for visualizers, tooling, and custom seen-state workflows. |
| `useMarkovGraph(config?)` | `{ record, getProbability, getLikelyNextStates, entropyForState, stateCount, edgeCount, snapshot, toJSON }` | React wrapper around core `MarkovGraph` for graph explorers, dashboards, and experiments.          |

Both hooks create their underlying core instances synchronously on first render and keep derived visualization state reactive.

---

## Re-exports

The package also re-exports the core items most React consumers need:

- Classes: `IntentManager`, `PropensityCalculator`, `BloomFilter`, `MarkovGraph`
- Helpers: `computeBloomConfig`, `MemoryStorageAdapter`
- Config and telemetry types: `IntentManagerConfig`, `PassiveIntentTelemetry`, `BloomFilterConfig`, `MarkovGraphConfig`, `SerializedMarkovGraph`
- Event types: `IntentEventName`, `IntentEventMap`, and the exported payload types from `@passiveintent/core`
- Adapter interfaces: `TimerAdapter`, `LifecycleAdapter`, `StorageAdapter`

---

## Runtime Guarantees

- **Concurrent-safe subscriptions**: provider hooks use `useSyncExternalStore`, so snapshots stay consistent in React 18 concurrent rendering.
- **Strict Mode safe**: provider and standalone engine creation use idempotent guards and explicit cleanup.
- **SSR safe**: engine instances are never created server-side.
- **Stable references**: returned callbacks and provider context values are memoized for predictable dependency arrays.
- **No silent subscription loss**: provider and standalone engine instances are created before child effects run, so descendant hooks can subscribe immediately.

---

## React 18 Design Notes

The React demo and wrapper use React 18 primitives only where they solve a concrete problem:

| Primitive              | Where it is used                                                                                                            | Why                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `useSyncExternalStore` | `useExitIntent`, `useIdle`, `useAttentionReturn`, `usePropensity`, `usePropensityScore`, `usePredictiveLink`, `useEventLog` | Eliminates tearing in Concurrent Mode and keeps subscriptions aligned with React's external-store contract. |
| `useRef`               | Engine instance storage, hook snapshots, option refs, `notifyRef` for dismiss flows                                         | Holds mutable engine state without forcing re-renders.                                                      |
| `useCallback`          | All `usePassiveIntent` methods and stable hook callbacks                                                                    | Safe to use in dependency arrays without churn or effect loops.                                             |
| `useMemo`              | Provider value and object-returning hooks                                                                                   | Prevents downstream re-renders when snapshots have not changed.                                             |
| `useReducer`           | Event log state and version counters in `useBloomFilter` / `useMarkovGraph`                                                 | Keeps reducer identity stable and updates explicit.                                                         |
| `startTransition`      | Deferred Bloom filter bit decoding and Markov graph snapshot serialization                                                  | Pushes heavier visualization work off the urgent render path.                                               |
| `useDebugValue`        | `useEventLog`, `useBloomFilter`, `useMarkovGraph`                                                                           | Gives better DevTools visibility without changing runtime behavior.                                         |

This package avoids the older `useState` + `useEffect` subscription pattern for external stores. Event handlers write to refs and signal React; listener cleanup is always returned from the subscription boundary. The result is no stale-closure subscription flow and no leaked-listener bookkeeping in user code.

### Concurrency model

The `useSyncExternalStore` contract is followed directly:

- `subscribe` wires listeners, mutates refs in event handlers, and then calls `onStoreChange()`.
- `getSnapshot` returns a stable ref-backed snapshot, or computes directly from refs in `usePropensityScore()`.
- `getServerSnapshot` always returns safe SSR defaults such as `EXIT_INITIAL`, `IDLE_INITIAL`, `0`, or `[]`.

`usePropensity()` and `usePropensityScore()` intentionally differ:

| Hook                   | Where the formula runs                                      | Tradeoff                                              |
| ---------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `usePropensity()`      | Event handlers write a precomputed score into `snapshotRef` | Simple reads, slightly more work in the event path.   |
| `usePropensityScore()` | `getSnapshot()` computes from refs on demand                | Pure snapshot reads with no precomputed-score window. |

Both approaches satisfy the external-store contract; `usePropensityScore()` is the stricter snapshot-driven form.

### Memory and SSR behavior

| Pattern                                                                   | Guarantee                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Render-phase instance init with `if (ref.current === null && IS_BROWSER)` | The engine exists before child effects subscribe, and creation stays idempotent under Strict Mode. |
| Cleanup-only `useEffect(() => () => destroy(), [])`                       | Timers and listeners are torn down on unmount.                                                     |
| Subscription cleanup returned from `subscribe`                            | Re-subscribe and unmount both cleanly release listeners.                                           |
| `notifyRef.current = null` during teardown                                | Imperative dismiss handlers become harmless after unmount.                                         |

SSR support is explicit:

- `IS_BROWSER = typeof window !== 'undefined'` guards all engine creation.
- Server snapshots and no-op callbacks keep hooks safe before hydration.
- `react-dom` is an optional peer dependency, so the wrapper can still be consumed in SSR-only or non-DOM React environments.

```ts
// Before hydration or outside the browser
track(state); // no-op
on(event, listener); // returns a no-op unsubscribe
getTelemetry(); // returns TELEMETRY_DEFAULT
predictNextStates(); // []
hasSeen(state); // false
```

---

## Why Use The Wrapper

Compared with wiring `@passiveintent/core` manually inside every component, the React wrapper removes repetitive lifecycle and subscription code:

| Concern              | Raw `@passiveintent/core`                           | With `@passiveintent/react`                                              |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Instance lifecycle   | Manual `new IntentManager()` + `destroy()` handling | `PassiveIntentProvider` or `usePassiveIntent(config)` manages it for you |
| Event subscriptions  | Manual `.on()` bookkeeping in effects               | Declarative hooks with automatic teardown                                |
| Concurrent rendering | Caller must avoid tearing manually                  | `useSyncExternalStore` handles external-store semantics                  |
| Re-render control    | Caller must memoize callbacks and objects           | Stable references are built in                                           |
| SSR                  | Caller adds `typeof window` guards                  | Safe defaults and browser-gated init are built in                        |
| Prefetching          | Manual DOM link injection                           | `usePredictiveLink()` injects and cleans up prefetch links               |
| Composition          | Caller combines multiple signals                    | `useSignals()` bundles the common signal hooks                           |

---

## Demo

The live example app in [`demo-react`](../../demo-react) exercises the provider flow, event log, predictive prefetching, telemetry, and signal hooks. It is also the reference implementation for the React 18 design choices above: external-store subscriptions, stable callback identities, deferred visualization work, and SSR-safe engine wiring.
