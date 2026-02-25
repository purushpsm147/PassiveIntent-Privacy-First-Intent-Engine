<!--
  Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# @edgesignal/core — EdgeSignal: A Privacy-First Intent Engine

[![Coverage: 97%](https://img.shields.io/badge/coverage-97%25-brightgreen)](#run-tests)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@edgesignal/core)](https://bundlephobia.com/package/@edgesignal/core)
[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz_small.svg)](https://stackblitz.com/github/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine)

A lightweight TypeScript SDK for on-device intent modeling.
It combines a Bloom filter for fast membership checks and a sparse Markov graph for transition learning, entropy signals, and trajectory anomaly detection.

## Why this library

- Local-first inference: no network calls required.
- SSR-safe runtime: browser globals are behind adapters.
- Bounded growth: LFU-style graph pruning prevents unbounded state expansion.
- Efficient persistence: binary graph encoding with dirty-flag optimization reduces serialization overhead.
- Bot-resilient signals: EntropyGuard suppresses entropy and trajectory events for suspected automated sessions.
- Dwell-time anomaly detection: statistical z-score analysis of per-state dwell times using Welford's online algorithm.
- Selective bigram Markov transitions: optional second-order transition learning with frequency-gated recording.
- Event cooldown: configurable per-channel cooldown prevents event flooding.
- Clean teardown: `destroy()` API for SPA lifecycle management.

## Why EdgeSignal vs. Mixpanel / Amplitude

Mixpanel and Amplitude are cloud-based analytics platforms: every event they capture leaves the user's browser and lands on a third-party server, creating GDPR/CCPA exposure, adding 50–200 ms of network latency per batch flush, and requiring you to buy a plan before you can query your own data. EdgeSignal runs the entire inference pipeline **inside the browser** — no data ever egresses, no vendor SDK is loaded, and signal evaluation completes in [under 0.004 ms on average (p95 < 0.006 ms)](./benchmarks/baseline.json). The serialized graph state fits in [~1.4 KB of localStorage](./benchmarks/baseline.json), meaning EdgeSignal works offline, survives cookie consent banners, and adds zero marginal cost per user. The trade-off is intentional: EdgeSignal detects _intent signals_ (rage clicks, hesitation, trajectory anomalies) rather than replacing a full event warehouse — use it alongside, or instead of, heavyweight analytics when privacy, latency, or cost is the constraint. For a full scenario accuracy breakdown see the [evaluation matrix](./benchmarks/evaluation-matrix.json).

## Install

```bash
npm install @edgesignal/core
```

## Quick usage

```ts
import {
  IntentManager,
  MarkovGraph,
  BrowserStorageAdapter,
  BrowserTimerAdapter,
} from '@edgesignal/core';

const baseline = new MarkovGraph();
baseline.incrementTransition('/home', '/search');
baseline.incrementTransition('/search', '/product');

const intent = new IntentManager({
  storageKey: 'edge-signal',
  persistDebounceMs: 1500,
  baseline: baseline.toJSON(),
  graph: {
    highEntropyThreshold: 0.75,
    divergenceThreshold: 2.0,
    maxStates: 500,
  },
  storage: new BrowserStorageAdapter(),
  timer: new BrowserTimerAdapter(),
  // botProtection defaults to true; set to false only for E2E test environments
  botProtection: true,
  onError: (err) => {
    // quota/security persistence failures land here
    console.warn('Intent persistence error:', err.message);
  },
});

intent.on('state_change', ({ from, to }) => {
  console.log('state_change', from, '=>', to);
});

intent.on('high_entropy', (signal) => {
  console.log('high_entropy', signal.state, signal.normalizedEntropy);
});

intent.on('trajectory_anomaly', (signal) => {
  console.log('trajectory_anomaly', signal.zScore);
});

intent.track('/home');
intent.track('/search');
intent.track('/product');

// force immediate save (optional)
intent.flushNow();
```

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

- `BloomFilter.computeOptimal(expectedItems, targetFPR)` computes tuned `bitSize` and `hashCount`.
- `estimateCurrentFPR(insertedItemsCount)` estimates live false-positive rate.
- `add(item)` and `check(item)` provide O(k) membership operations.

### MarkovGraph

- Sparse transition storage with state-index mapping.
- `prune()` applies LFU-style eviction when `maxStates` is exceeded.
- `toBinary()` / `MarkovGraph.fromBinary()` provide compact binary persistence.
- `toJSON()` / `fromJSON()` remain available for baseline transport and tooling compatibility.

### IntentManager

- `track(state)` updates Bloom + graph + event signals.
- Debounced persistence with adapter-based storage/timers.
- **Dirty-flag persistence**: `persist()` is a no-op when no state has changed since the last save, eliminating redundant writes.
- `persist()` performs graph pruning before snapshot.
- Restores from binary payload first, then legacy JSON payload fallback.
- **Dwell-time anomaly detection**: fires `dwell_time_anomaly` when time spent on a state deviates significantly from learned mean (Welford's online algorithm, O(1) per call).
- **Selective bigrams**: when `enableBigrams: true`, records second-order transitions (`A→B` → `B→C`) only after the unigram from-state crosses `bigramFrequencyThreshold` (default: 5). Bigram states share the same graph with LFU pruning.
- **Event cooldown**: `eventCooldownMs` suppresses repeated event emissions within a configurable window, per event type.
- **`destroy()`**: flushes pending state, cancels timers, and removes all listeners — use in SPA cleanup paths (`useEffect` teardown, `onUnmounted`, `ngOnDestroy`).

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
- **Compatibility-first migration**: restore supports both new binary payloads and legacy JSON payloads.
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
