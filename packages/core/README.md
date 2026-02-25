<!--
  Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# @edgesignal/core — EdgeSignal: A Privacy-First Intent Engine

[![Coverage: 97%](https://img.shields.io/badge/coverage-97%25-brightgreen)](#run-tests)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@edgesignal/core)](https://bundlephobia.com/package/@edgesignal/core)
[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz_small.svg)](https://stackblitz.com/github/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine)

**EdgeSignal is a 6 kB, zero-egress intent engine that detects user hesitation and frustration in real-time.**
Catch rage-clicks, prevent checkout abandonment, and trigger personalized UI interventions in `< 2ms`—all entirely within the browser. Because zero behavioral data ever leaves the device, EdgeSignal requires **no cookie consent banner** and easily passes strict GDPR/HIPAA compliance.

_(Under the hood, it uses a highly-optimized sparse Markov graph and Bloom filters to model probabilistic intent locally.)_

## Why EdgeSignal?

- **No Cookie Banners Required:** 100% local execution. No network requests, no PII sent to servers. Perfectly compliant with GDPR and CCPA.
- **Sub-Millisecond Reactions:** Catch frustrated users _before_ they close the tab. Traditional analytics take minutes to process rage-clicks; EdgeSignal triggers in `< 2ms`.
- **Detect True Hesitation:** Evaluates user reading speed and dwell-time anomalies dynamically, allowing you to trigger "Free Shipping" tooltips exactly when a user hesitates at checkout.
- **Bot & Scraper Resilient:** Built-in `EntropyGuard` automatically detects impossibly fast or robotic click cadences, preventing bots from triggering your interventions.
- **Zero Performance Hit:** Capped at 500 tracked states, compiles to a tiny 6 kB footprint, and uses dirty-flag persistence to skip unnecessary writes.
- **SPA-Ready Lifecycle:** SSR-safe adapters and a clean `destroy()` API make it drop-in compatible with Next.js, Vue, Angular, and React Router.

## What can you build?

**1. The Zero-Latency Churn Healer**

Detect when a user is frustrated (erratic navigation, rage-clicking) and instantly offer help.

```ts
intent.on('high_entropy', (signal) => {
  if (signal.state === '/billing' && signal.normalizedEntropy > 0.85) {
    ZendeskWidget.open({ message: 'Having trouble with your billing details? Chat with us!' });
  }
});
```

**2. The Hesitation Discount (Intervention Ladder)**

Detect when a user stalls on a checkout step compared to their normal browsing speed.

```ts
intent.on('dwell_time_anomaly', (signal) => {
  if (signal.state === '/checkout/payment' && signal.zScore > 2.0) {
    // User is hesitating. Show a reassurance tooltip.
    UI.showTooltip('Free 30-day returns on all orders.');
  }
});
```

**3. The Abandoned-Path Detector**

Learn what the normal conversion path looks like and fire an event the moment a user deviates.

```ts
intent.on('trajectory_anomaly', (signal) => {
  if (signal.zScore > 2.5) {
    Analytics.track('checkout_path_abandoned', { zScore: signal.zScore });
  }
});
```

## Install

```bash
npm install @edgesignal/core
```

## Quick start

```ts
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@edgesignal/core';

// 1. Initialize the engine
const intent = new IntentManager({
  storageKey: 'my-app-intent',
  storage: new BrowserStorageAdapter(),
  timer: new BrowserTimerAdapter(),
});

// 2. Track page views or UI states
intent.track('/home');
intent.track('/pricing');
intent.track('/checkout');

// 3. Listen for behavioral signals
intent.on('dwell_time_anomaly', (signal) => {
  // User is hesitating — offer help
  console.log('Hesitation detected on', signal.state, '— z-score:', signal.zScore);
});

intent.on('trajectory_anomaly', (signal) => {
  // User deviated heavily from the normal conversion path
  console.log('Path deviation detected. Z-Score:', signal.zScore);
});

intent.on('high_entropy', (signal) => {
  // User is bouncing around erratically — possible frustration
  console.log('Erratic navigation on', signal.state, signal.normalizedEntropy);
});
```

> **Advanced configuration** (baselines, tuning thresholds, cross-tab sync, `onError` callback) is covered in the [full API reference](#api-highlights) and [architecture docs](./docs/architecture.md).

## Framework integration

### Next.js (App Router — `app/` directory)

```tsx
// app/providers/intent-provider.tsx
'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@edgesignal/core';

export function IntentProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const intentRef = useRef<IntentManager | null>(null);

  useEffect(() => {
    intentRef.current = new IntentManager({
      storageKey: 'edge-signal',
      storage: new BrowserStorageAdapter(),
      timer: new BrowserTimerAdapter(),
    });
    return () => {
      intentRef.current?.destroy();
      intentRef.current = null;
    };
  }, []);

  useEffect(() => {
    intentRef.current?.track(pathname);
  }, [pathname]);

  return <>{children}</>;
}
```

Mount the provider in your root layout:

```tsx
// app/layout.tsx
import { IntentProvider } from './providers/intent-provider';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <IntentProvider>{children}</IntentProvider>
      </body>
    </html>
  );
}
```

### Vue 3 (`onMounted` / `onUnmounted`)

```vue
<!-- src/composables/useIntent.ts -->
<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@edgesignal/core';

let intent: IntentManager | null = null;
const route = useRoute();

onMounted(() => {
  intent = new IntentManager({
    storageKey: 'edge-signal',
    storage: new BrowserStorageAdapter(),
    timer: new BrowserTimerAdapter(),
  });
  intent.track(route.fullPath);
});

watch(
  () => route.fullPath,
  (path) => {
    intent?.track(path);
  },
);

onUnmounted(() => {
  intent?.destroy();
  intent = null;
});
</script>
```

### Angular (`ngOnInit` / `ngOnDestroy`)

```ts
// intent.service.ts
import { Injectable, OnDestroy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@edgesignal/core';

@Injectable({ providedIn: 'root' })
export class IntentService implements OnDestroy {
  private intent = new IntentManager({
    storageKey: 'edge-signal',
    storage: new BrowserStorageAdapter(),
    timer: new BrowserTimerAdapter(),
  });
  private sub: Subscription;

  constructor(router: Router) {
    this.sub = router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.intent.track(e.urlAfterRedirects));
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.intent.destroy();
  }
}
```

Inject `IntentService` in your root `AppComponent` (or import it in the root module) so it is instantiated on app start.

## API highlights

### BloomFilter

| Method / Property                                      | Description                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BloomFilter.computeOptimal(expectedItems, targetFPR)` | Static factory: computes optimal `bitSize` and `hashCount` for given capacity and target false-positive rate.                                                             |
| `computeBloomConfig(expectedItems, targetFPR)`         | **Standalone tree-shakeable utility** (exported separately from the class). Returns `{ bitSize, hashCount, estimatedFpRate }` — use when you don't need the class itself. |
| `add(item)`                                            | O(k) insert — hashes item into bitset.                                                                                                                                    |
| `check(item)`                                          | O(k) membership test — returns `true` if item was probably added.                                                                                                         |
| `estimateCurrentFPR(insertedItemsCount)`               | Estimates live false-positive rate given how many items have been inserted.                                                                                               |
| `toBase64()` / `BloomFilter.fromBase64(str, k)`        | Compact base64 serialization for snapshot storage.                                                                                                                        |

### MarkovGraph

| Method / Property                            | Description                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `incrementTransition(from, to)`              | Record a from→to navigation; creates states on demand.                                    |
| `getLikelyNextStates(state, threshold)`      | Returns `{ state, probability }[]` sorted descending; entries below `threshold` excluded. |
| `prune()`                                    | LFU-style eviction of the lowest-frequency states when `maxStates` is exceeded.           |
| `stateCount()`                               | Current number of unique tracked states.                                                  |
| `totalTransitions()`                         | Total recorded transition count across all edges.                                         |
| `toBinary()` / `MarkovGraph.fromBinary(buf)` | Compact binary persistence (smaller than JSON at scale).                                  |
| `toJSON()` / `MarkovGraph.fromJSON(obj)`     | Human-readable snapshot; use for baseline transport and tooling.                          |

### IntentManager

**Lifecycle & tracking**

| Method         | Signature                                         | Description                                                                               |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `track`        | `(state: string) => void`                         | Core call: updates Bloom + Markov + fires event signals.                                  |
| `on`           | `(event: IntentEventName, handler) => () => void` | Subscribe to an event; call the returned function to unsubscribe.                         |
| `flushNow`     | `() => void`                                      | Cancel the debounce timer and persist immediately.                                        |
| `destroy`      | `() => void`                                      | Flush, cancel timers, remove all listeners, close BroadcastChannel. Call in SPA teardown. |
| `resetSession` | `() => void`                                      | Clear recent trajectory and previous state while preserving the learned graph.            |

**Prediction & introspection**

| Method                 | Signature                                                                             | Description                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `predictNextStates`    | `(threshold?: number, sanitize?: (s: string) => boolean) => { state, probability }[]` | Top-N Markov predictions above `threshold` (default `0.3`). Always provide a `sanitize` guard in production to exclude sensitive routes.                                       |
| `hasSeen`              | `(state: string) => boolean`                                                          | Bloom filter membership test — O(k), no false negatives.                                                                                                                       |
| `getTelemetry`         | `() => EdgeSignalTelemetry`                                                           | GDPR-safe aggregate snapshot: `sessionId`, `transitionsEvaluated`, `botStatus`, `anomaliesFired`, `engineHealth`, `baselineStatus`, `assignmentGroup`. No raw behavioral data. |
| `exportGraph`          | `() => SerializedMarkovGraph`                                                         | Returns the full Markov graph as a JSON-serializable object.                                                                                                                   |
| `getPerformanceReport` | `() => PerformanceReport`                                                             | Detailed benchmark report: op latencies, state/transition counts, serialization size.                                                                                          |

**Session counters** (exact integer counts, never persisted)

| Method             | Signature                              | Description                                                                                                                                                                |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incrementCounter` | `(key: string, by?: number) => number` | Increment a named counter (default `+1`); accepts any finite value (including negative deltas) and returns the new value. Synced cross-tab when `BroadcastSync` is active. |
| `getCounter`       | `(key: string) => number`              | Read a counter; returns `0` if never incremented.                                                                                                                          |
| `resetCounter`     | `(key: string) => void`                | Reset a counter back to `0`.                                                                                                                                               |

**Conversion tracking**

| Method            | Signature                              | Description                                                                                                                                                          |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trackConversion` | `(payload: ConversionPayload) => void` | Emit a `conversion` event locally. `ConversionPayload` carries `type`, optional `value`, optional `currency`. Never leaves the device unless your listener sends it. |

**Events emitted** (`on(event, handler)`)

| Event                 | Payload type                | Fired when                                                                                             |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `state_change`        | `StateChangePayload`        | Every `track()` call that records a new transition.                                                    |
| `high_entropy`        | `HighEntropyPayload`        | Outgoing-transition distribution exceeds `highEntropyThreshold`.                                       |
| `trajectory_anomaly`  | `TrajectoryAnomalyPayload`  | Log-likelihood window diverges from baseline beyond `divergenceThreshold`.                             |
| `dwell_time_anomaly`  | `DwellTimeAnomalyPayload`   | Time on previous state deviates beyond z-score threshold (Welford's algorithm).                        |
| `bot_detected`        | `BotDetectedPayload`        | `botScore` reaches 5 — EntropyGuard flags the session.                                                 |
| `hesitation_detected` | `HesitationDetectedPayload` | A `trajectory_anomaly` and positive `dwell_time_anomaly` occur within `hesitationCorrelationWindowMs`. |
| `conversion`          | `ConversionPayload`         | `trackConversion()` was called.                                                                        |

**`onError` callback** (in `IntentManagerConfig`)

```ts
new IntentManager({
  storageKey: 'edge-signal',
  onError: (err: EdgeSignalError) => {
    // Fires on storage quota/security errors and validation failures.
    // err.code: 'STORAGE_READ' | 'STORAGE_WRITE' | 'QUOTA_EXCEEDED' | 'RESTORE_PARSE' | 'SERIALIZE' | 'VALIDATION'
    console.warn('[EdgeSignal]', err.code, err.message);
  },
});
```

### Adapters

| Export                  | Kind      | Description                                                                             |
| ----------------------- | --------- | --------------------------------------------------------------------------------------- |
| `BrowserStorageAdapter` | class     | Wraps `localStorage`. Use in any browser context.                                       |
| `BrowserTimerAdapter`   | class     | Wraps `setTimeout` / `clearTimeout`.                                                    |
| `MemoryStorageAdapter`  | class     | In-memory fallback — no persistence. Useful for SSR, tests, or ephemeral sessions.      |
| `StorageAdapter`        | interface | Implement to provide a custom storage backend (IndexedDB, Capacitor Preferences, etc.). |
| `TimerAdapter`          | interface | Implement to provide a custom timer backend (e.g. Node.js timers in tests).             |
| `TimerHandle`           | type      | Opaque handle returned by `TimerAdapter.setTimeout`.                                    |

### Utilities

| Export                | Signature                                                                                       | Description                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computeBloomConfig`  | `(expectedItems: number, falsePositiveRate: number) => { bitSize, hashCount, estimatedFpRate }` | Pure math helper — compute Bloom parameters without instantiating `BloomFilter`. Tree-shakeable.                                                                                         |
| `normalizeRouteState` | `(url: string) => string`                                                                       | Strips query strings/hash fragments, removes trailing slashes, and replaces UUID v4 / MongoDB ObjectID segments with `:id` — call this before `track()` to keep the state space compact. |
| `MAX_STATE_LENGTH`    | `256` (constant)                                                                                | Hard upper bound on state label length accepted by `BroadcastSync`. Payloads exceeding this are silently dropped.                                                                        |

### BroadcastSync

Cross-tab synchronization over the [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel). `IntentManager` manages this automatically when `crossTabSync: true` is set in config — you rarely need to use `BroadcastSync` directly.

| Method / Property             | Description                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `isActive`                    | `true` when a real `BroadcastChannel` was opened; `false` in SSR or unsupported environments. |
| `broadcast(from, to)`         | Send a transition to all other tabs on the channel.                                           |
| `broadcastCounter(key, by)`   | Sync a counter increment across tabs.                                                         |
| `applyRemote(from, to)`       | Apply a validated remote transition locally (no re-broadcast).                                |
| `applyRemoteCounter(key, by)` | Apply a validated remote counter increment locally.                                           |
| `close()`                     | Release the channel and remove the message handler. Called by `destroy()`.                    |

### React Wrapper — `@edgesignal/react`

A separate package ships a drop-in `useEdgeSignal` hook that manages the full `IntentManager` lifecycle for React 18+, Next.js, and React Router apps:

```bash
npm install @edgesignal/react
```

```tsx
import { useEdgeSignal } from '@edgesignal/react';

const { track, on, getTelemetry, predictNextStates } = useEdgeSignal({
  storageKey: 'edge-signal',
  botProtection: true,
});
```

The hook is **Strict Mode safe** (instance held in `useRef`), **SSR safe** (`typeof window` guard), and exposes all eight `IntentManager` methods as stable `useCallback` wrappers. See [`packages/react/README.md`](../react/README.md) for the full API table and Next.js / React Router examples.

### EntropyGuard (Bot Protection)

EntropyGuard tracks the timing of the last 10 `track()` calls using a fixed-size circular buffer (no heap allocations in the hot path). It calculates a `windowBotScore` from the circular buffer when:

- A delta between consecutive calls is below **50 ms** (impossibly fast for a human).
- The variance of recent deltas is below **100 ms²** (robotic, highly regular cadence).

When `botScore` reaches **5**, the session is flagged as `isSuspectedBot = true`. While flagged, `evaluateEntropy` and `evaluateTrajectory` return immediately without emitting events — normal navigation state is still recorded.

**Configuration:**

| Option          | Type      | Default | Description                                                                                                           |
| --------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `botProtection` | `boolean` | `true`  | Enable EntropyGuard. Set to `false` in E2E test environments where a headless browser drives clicks programmatically. |

**Production usage** (protection on by default):

```ts
const intent = new IntentManager({ storageKey: 'app' });
```

**E2E / CI usage** (disable so automated clicks reach signal evaluation):

```ts
const intent = new IntentManager({
  storageKey: 'app',
  botProtection: false,
});
```

### Dirty-Flag Persistence

`persist()` checks an internal `isDirty` flag before doing any work. The flag is set to `true` inside `track()` only when:

- A new transition is recorded between two states, **or**
- The Bloom filter is updated with a previously unseen state.

After a successful write to storage, the flag is reset to `false`. This means apps that call `flushNow()` or trigger the debounce timer repeatedly without having navigated will incur zero serialization cost.

## Design decisions (brief)

- **Isomorphic adapters**: direct `window`/`localStorage` usage is avoided in core flow to keep SSR safe.
- **Memory bounds by default**: `maxStates` defaults to `500`; low-frequency states are pruned first.
- **Binary graph serialization**: reduces main-thread pressure compared to deep JSON graph snapshots.
- **Binary persistence contract**: restore expects the current binary payload (`bloomBase64` + `graphBinary`) and safely cold-starts on invalid/corrupt storage.
- **Predictable anomaly math**:
  - entropy signal from normalized outgoing distribution,
  - trajectory anomaly from baseline log-likelihood window and optional z-score calibration,
  - dwell-time anomaly from Welford's online z-score per state.
- **Bot-resilient signals**: EntropyGuard uses a fixed circular buffer to detect impossibly-fast or robotic timing patterns without allocating on every `track()` call.
- **Write-efficient persistence**: the dirty flag eliminates redundant `localStorage` writes when the user has not navigated since the last persist cycle.
- **Memory-safe bigrams**: selective second-order Markov recording is frequency-gated to prevent state explosion. Only well-established unigram states generate bigram edges, and all states share the same `maxStates` cap with LFU pruning.
- **Event flood protection**: per-channel cooldown gating ensures downstream consumers are not overwhelmed by rapid sequential anomaly events.

## Logic flow (brief)

On each `track(state)`:

1. If `botProtection` is enabled, record the call timestamp into a circular buffer and evaluate timing patterns.
2. Check Bloom filter for the state (used to detect new-to-filter states for dirty tracking).
3. Add state to Bloom filter; mark dirty if the state was new.
4. Evaluate **dwell-time anomaly** on the previous state (if enabled, not bot-suspected, and enough samples collected).
5. Add transition from previous state to current state; mark dirty.
6. If `enableBigrams` is true and the unigram from-state is well-established, record the bigram transition.
7. Evaluate entropy signal (skipped if bot suspected, or below minimum sample gate).
8. Evaluate trajectory anomaly (skipped if bot suspected, or below minimum window gate, or no baseline).
9. Emit `state_change` (always emitted — cooldown applies only to anomaly channels).
10. Schedule debounced persistence.

During persistence:

1. Return immediately if `isDirty` is `false` (no-op).
2. Prune graph if state count exceeds limit.
3. Serialize graph to binary.
4. Encode binary to base64 and store alongside Bloom snapshot.
5. Reset `isDirty` to `false`.

## Run tests

Install project dependencies first:

```bash
npm install
```

Run TypeScript build:

```bash
npm run build
```

Run unit tests:

```bash
npm test
```

Run unit tests with coverage:

```bash
npm run test:coverage
```

Run performance suite:

```bash
npm run test:perf
```

### Cypress E2E tests

The E2E suite requires port **3000** to be free. If a previous run crashed without releasing the port, kill the occupying process before re-running.

**Headless (CI default):**

```bash
npm run test:e2e
```

**Headed (Chrome, useful for local debugging):**

```bash
npm run test:e2e:headed
```

**Run a single spec directly:**

```bash
npx cypress run --spec "packages/core/cypress/e2e/intent.cy.ts"
npx cypress run --spec "packages/core/cypress/e2e/amazon.cy.ts"
```

**Open interactive test runner:**

```bash
npx cypress open
```

> **Note — bot protection in the sandbox:** Both `sandbox/app.ts` and `sandbox/amazon/app.ts` initialize `IntentManager` with `botProtection: false`. This is intentional: Cypress drives clicks programmatically in rapid succession, which would otherwise trigger EntropyGuard and suppress the entropy/anomaly toasts that the E2E assertions depend on. Never set `botProtection: false` in a production bundle.

## Documentation

Full architecture and API deep-dive: [docs/architecture.md](./docs/architecture.md)

## Repository structure

```
packages/core/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── docs/
│   └── architecture.md       # full architecture & API reference
├── src/
│   ├── index.ts
│   ├── intent-sdk.ts
│   ├── adapters.ts
│   ├── core/
│   │   ├── bloom.ts
│   │   └── markov.ts
│   ├── engine/
│   │   ├── dwell.ts
│   │   ├── entropy-guard.ts
│   │   └── intent-manager.ts
│   ├── persistence/
│   │   └── codec.ts
│   ├── sync/
│   │   └── broadcast-sync.ts
│   ├── types/
│   │   └── events.ts
│   └── utils/
│       └── route-normalizer.ts
├── tests/
│   ├── unit-fast.test.mjs
│   ├── integration-contract.test.mjs
│   ├── probabilistic.test.mjs
│   ├── property-based.test.mjs
│   └── compatibility-matrix.test.mjs
├── scripts/
│   ├── perf-runner.mjs
│   ├── perf-regression.mjs
│   ├── roc-experiment.mjs
│   ├── scenario-matrix.mjs
│   └── verify-package.mjs
├── benchmarks/
├── sandbox/
│   ├── app.ts
│   ├── index.html
│   └── amazon/
│       ├── app.ts
│       └── index.html
└── cypress/
    └── e2e/
        ├── intent.cy.ts
        └── amazon.cy.ts
```

## License

EdgeSignal is dual-licensed:

### AGPLv3 — Free

Use EdgeSignal at no cost under the [GNU Affero General Public License v3.0](./LICENSE) if **all** of the following apply:

- Your project is open-source **and** you publish the complete source code.
- You are not incorporating EdgeSignal into a proprietary or closed-source product.
- If you run EdgeSignal as part of a network service, your entire application is also released under AGPLv3.

### Commercial License — Paid

A commercial license removes the AGPLv3 copyleft obligations. You need one if:

- You ship EdgeSignal inside a **closed-source or proprietary** product.
- You run it in a **SaaS / network service** without releasing your application source.
- You re-sell or white-label it inside an analytics or AdTech platform.

See [**PRICING.md**](../../PRICING.md) for tier details (Indie · Startup · Growth · Enterprise).  
Contact [purushpsm147@yahoo.co.in](mailto:purushpsm147@yahoo.co.in) or [successfulindian147@gmail.com](mailto:successfulindian147@gmail.com) to purchase a license.
