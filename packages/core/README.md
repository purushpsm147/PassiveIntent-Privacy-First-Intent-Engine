<!--
  Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# @passiveintent/core — PassiveIntent: A Privacy-First Intent Engine

[![Coverage](https://img.shields.io/badge/coverage-passing-brightgreen)](#run-tests)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@passiveintent/core)](https://bundlephobia.com/package/@passiveintent/core)
[![npm](https://img.shields.io/npm/v/@passiveintent/core)](https://www.npmjs.com/package/@passiveintent/core)
[![Open Vanilla JS demo in StackBlitz](https://img.shields.io/badge/StackBlitz-Vanilla%20JS-1389FD?logo=stackblitz&logoColor=white)](https://stackblitz.com/github/passiveintent/core/tree/main/demo)
[![Open React demo in StackBlitz](https://img.shields.io/badge/StackBlitz-React-1389FD?logo=stackblitz&logoColor=white)](https://stackblitz.com/github/passiveintent/core/tree/main/demo-react)

**PassiveIntent is a ~11 kB gzip, zero-egress intent engine that detects user hesitation and frustration in real-time.**
Catch rage-clicks, prevent checkout abandonment, and trigger personalized UI interventions in `< 2ms`—all entirely within the browser. Because zero behavioral data leaves the device by default, PassiveIntent can **reduce cookie-consent and GDPR overhead** for intent detection, subject to your full implementation and legal review.

_(Under the hood, it uses a highly-optimized sparse Markov graph and Bloom filters to model probabilistic intent locally.)_

## Why PassiveIntent?

- **No Cookie Banners Required:** 100% local execution. No network requests, no PII sent to servers. Designed to help you meet GDPR and CCPA requirements when used with appropriate configuration and legal review.
- **Sub-Millisecond Reactions:** Catch frustrated users _before_ they close the tab. Traditional analytics take minutes to process rage-clicks; PassiveIntent triggers in `< 2ms`.
- **Detect True Hesitation:** Evaluates user reading speed and dwell-time anomalies dynamically, allowing you to trigger "Free Shipping" tooltips exactly when a user hesitates at checkout.
- **Cold-Start Friendly Math:** Unlike brittle rule engines that overreact to brand-new users, PassiveIntent can apply Bayesian Laplace smoothing (`smoothingAlpha`) so Day-1 organic traffic is handled gracefully instead of being penalized by sparse-history spikes.
- **Bot & Scraper Resilient:** Built-in `EntropyGuard` automatically detects impossibly fast or robotic click cadences, preventing bots from triggering your interventions.
- **Zero Performance Hit:** Capped at 500 tracked states, compiles to a tiny ~11 kB gzip footprint, and uses dirty-flag persistence to skip unnecessary writes.
- **SPA-Ready Lifecycle:** SSR-safe adapters and a clean `destroy()` API make it drop-in compatible with Next.js, Vue, Angular, and React Router.
- **Comparison Shopper Awareness:** Automatically detects users who leave and return after ≥ 15 seconds, firing an `attention_return` event so you can greet them with a personalized welcome-back offer.
- **Idle-State Detection:** Tracks interaction silence with a lightweight polling loop and fires `user_idle` / `user_resumed` events, letting you dim overlays or pause expensive animations without any extra timers.
- **Smart Exit-Intent:** Detects when the user is about to leave the page (pointer moves above the viewport) and fires `exit_intent` — **only** when the Markov graph confirms a likely continuation path. No spammy overlays; only data-backed interventions.

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

**4. The Comparison Shopper — Welcome Back Discount**

Detect when a user tabs away (likely to compare prices) and show a "Welcome Back" offer instantly on return.

```ts
intent.on('attention_return', ({ state, hiddenDuration }) => {
  if (state === '/product' || state === '/pricing') {
    UI.showModal({
      title: 'Welcome back!',
      message: `Still comparing? Here's 10% off for the next 15 minutes.`,
      coupon: 'WELCOMEBACK10',
    });
  }
});
```

**5. The Idle-State Overlay**

Detect when a user walks away from their device and dim the UI; refresh stale content when they return.

```ts
intent.on('user_idle', ({ state }) => {
  UI.showIdleOverlay({ message: 'Still there? Your session is open.' });
});

intent.on('user_resumed', ({ state, idleMs }) => {
  UI.hideIdleOverlay();
  if (idleMs > 300_000) {
    refreshPageData(); // content may be stale after 5+ min
  }
});
```

**6. The Smart Exit-Intent Interceptor**

Fire a last-chance offer or save-progress prompt only when the Markov graph suggests the user has a meaningful next destination — not on every accidental cursor drift to the toolbar.

```ts
intent.on('exit_intent', ({ state, likelyNext }) => {
  if (state === '/checkout/payment') {
    // The graph says they're likely to navigate to /checkout/review next —
    // show a quick win to keep them in the funnel.
    UI.showModal({
      title: 'Wait — your cart is saved!',
      message: `You were heading to ${likelyNext}. Need help completing your order?`,
      cta: 'Continue checkout',
    });
  }
});
```

**7. The Propensity Scorer — Real-Time Conversion Readiness**

Combine Markov graph reachability with live dwell-time friction to produce a `[0, 1]` propensity score that reflects _both_ how navigable the funnel path is _and_ how behaviorally engaged the user is at this exact moment.

```ts
import { PropensityCalculator, IntentManager } from '@passiveintent/core';

// Two-factor propensity model:
//   P_reach  — probability of reaching /checkout from current state (graph structure)
//   friction — exp(-α × max(0, z)) applied at read time (behavioral signal)
const propensity = new PropensityCalculator(
  0.2, // alpha: friction sensitivity (0.2 = score halves at z ≈ 3.47)
  500, // throttleMs: max one recomputation per 500 ms
);

const intent = new IntentManager({ storageKey: 'shop-intent', baseline: myBaseline });

// Refresh the structural baseline on every navigation.
intent.on('state_change', ({ state }) => {
  propensity.updateBaseline(
    intent.getStateModel(), // live IStateModel backed by the Markov graph
    state, // current position in the funnel
    '/checkout', // conversion target
    3, // BFS depth: explore up to 3 hops ahead
  );
});

// Read the real-time score on every dwell-time signal —
// fused with the current Welford z-score, never older than 500 ms.
intent.on('dwell_time_anomaly', ({ zScore }) => {
  const score = propensity.getRealTimePropensity(zScore);

  if (score > 0.7) {
    // High structural probability AND low behavioral friction: user is on track.
    // Show a subtle progress indicator rather than a disruptive modal.
    UI.showProgressBar({ step: 'payment', confidence: score });
  } else if (score < 0.25 && zScore > 2.0) {
    // Low structural probability AND high friction: user is struggling.
    UI.showChatWidget('Need help completing your order?');
  }
});
```

## Install

```bash
npm install @passiveintent/core
```

## Quick start

### Standard web — one line (recommended)

`createBrowserIntent` is the Layer 3 factory. It wires all standard web plugins
(`MouseKinematicsAdapter`, `BrowserLifecycleAdapter`, `ContinuousGraphModel`,
`LocalStorageAdapter`) into a raw `IntentEngine` and returns it ready to use.

```ts
import { createBrowserIntent } from '@passiveintent/core';

const intent = createBrowserIntent({ storageKey: 'my-app' });

intent.on('high_entropy', ({ state, normalizedEntropy }) => {
  // User wandering — show help widget
  console.log('Erratic navigation on', state, normalizedEntropy);
});

const SAFE_PREFETCH_ROUTES = new Set(['/checkout', '/pricing', '/signup']);

intent.on('exit_intent', ({ likelyNext }) => {
  // Always validate against an explicit allowlist before prefetching —
  // never pass an unvalidated state string directly to prefetch().
  if (likelyNext && SAFE_PREFETCH_ROUTES.has(likelyNext)) {
    prefetch(likelyNext);
  }
});

intent.on('trajectory_anomaly', ({ zScore }) => {
  Analytics.track('checkout_path_abandoned', { zScore });
});
```

Call `destroy()` during component teardown — **not** inline with setup:

```ts
// React
useEffect(() => {
  return () => intent.destroy();
}, []);

// Vue
onUnmounted(() => intent.destroy());
```

### Full control (`IntentManager`)

For dwell-time anomaly detection, bot protection, cross-tab sync, A/B holdout,
and the complete event surface, use `IntentManager` directly:

```ts
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@passiveintent/core';

const intent = new IntentManager({
  storageKey: 'my-app-intent',
  storage: new BrowserStorageAdapter(),
  timer: new BrowserTimerAdapter(),
});

intent.track('/home');
intent.track('/pricing');
intent.track('/checkout');

intent.on('dwell_time_anomaly', (signal) => {
  console.log('Hesitation on', signal.state, '— z-score:', signal.zScore);
});

intent.on('trajectory_anomaly', (signal) => {
  console.log('Path deviation. Z-Score:', signal.zScore);
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
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@passiveintent/core';

export function IntentProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const intentRef = useRef<IntentManager | null>(null);

  useEffect(() => {
    intentRef.current = new IntentManager({
      storageKey: 'passive-intent',
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
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@passiveintent/core';

let intent: IntentManager | null = null;
const route = useRoute();

onMounted(() => {
  intent = new IntentManager({
    storageKey: 'passive-intent',
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
import { IntentManager, BrowserStorageAdapter, BrowserTimerAdapter } from '@passiveintent/core';

@Injectable({ providedIn: 'root' })
export class IntentService implements OnDestroy {
  private intent = new IntentManager({
    storageKey: 'passive-intent',
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

**Static factory**

| Method                              | Signature                                                 | Description                                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IntentManager.createAsync(config)` | `(config: IntentManagerConfig) => Promise<IntentManager>` | Async factory for use with `asyncStorage` backends (e.g. React Native `AsyncStorage`, IndexedDB wrappers). Awaits the initial `getItem` before constructing the instance so the synchronous `track()` hot-path is never blocked. Throws if `config.asyncStorage` is absent. |

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
| `getTelemetry`         | `() => PassiveIntentTelemetry`                                                        | GDPR-safe aggregate snapshot: `sessionId`, `transitionsEvaluated`, `botStatus`, `anomaliesFired`, `engineHealth`, `baselineStatus`, `assignmentGroup`. No raw behavioral data. |
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

| Event                 | Payload type                | Fired when                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state_change`        | `StateChangePayload`        | Every `track()` call that records a new transition.                                                                                                                                                                                                                                                        |
| `high_entropy`        | `HighEntropyPayload`        | Outgoing-transition distribution exceeds `highEntropyThreshold`.                                                                                                                                                                                                                                           |
| `trajectory_anomaly`  | `TrajectoryAnomalyPayload`  | Log-likelihood window diverges from baseline beyond `divergenceThreshold`.                                                                                                                                                                                                                                 |
| `dwell_time_anomaly`  | `DwellTimeAnomalyPayload`   | Time on previous state deviates beyond z-score threshold (Welford's algorithm).                                                                                                                                                                                                                            |
| `bot_detected`        | `BotDetectedPayload`        | `botScore` reaches 5 — EntropyGuard flags the session.                                                                                                                                                                                                                                                     |
| `hesitation_detected` | `HesitationDetectedPayload` | A `trajectory_anomaly` and positive `dwell_time_anomaly` occur within `hesitationCorrelationWindowMs`.                                                                                                                                                                                                     |
| `session_stale`       | `SessionStalePayload`       | **Only emitted when `dwellTime.enabled` is `true`.** A time delta (hidden-duration from `LifecycleAdapter`, or dwell measured at `track()` time) exceeded `MAX_PLAUSIBLE_DWELL_MS` (30 min), indicating CPU suspend or OS sleep. The inflated measurement is discarded to protect the Welford accumulator. |
| `attention_return`    | `AttentionReturnPayload`    | User returns to the tab after being hidden for ≥ `ATTENTION_RETURN_THRESHOLD_MS` (15 s). Fires independently of `dwellTime.enabled`. Use for "Welcome Back" discount modals after comparison shopping.                                                                                                     |
| `user_idle`           | `UserIdlePayload`           | No user interaction (mouse, keyboard, scroll, touch) for `USER_IDLE_THRESHOLD_MS` (2 min). Fires at most once per idle period. Requires the `LifecycleAdapter` to implement `onInteraction()`.                                                                                                             |
| `user_resumed`        | `UserResumedPayload`        | First interaction after an idle period. Includes total `idleMs`. The dwell-time baseline is adjusted to exclude the idle gap automatically.                                                                                                                                                                |
| `exit_intent`         | `ExitIntentPayload`         | User moved the pointer above the viewport top edge **and** the Markov graph has at least one continuation candidate with probability ≥ 0.4. `likelyNext` is the highest-probability next state. Suppressed entirely when no candidates meet the threshold. Requires `LifecycleAdapter.onExitIntent()`.     |
| `conversion`          | `ConversionPayload`         | `trackConversion()` was called.                                                                                                                                                                                                                                                                            |

**`onError` callback** (in `IntentManagerConfig`)

```ts
new IntentManager({
  storageKey: 'passive-intent',
  onError: (err: PassiveIntentError) => {
    // Fires on storage quota/security errors and validation failures.
    // err.code: 'STORAGE_READ' | 'STORAGE_WRITE' | 'QUOTA_EXCEEDED' | 'RESTORE_PARSE' | 'SERIALIZE' | 'VALIDATION'
    console.warn('[PassiveIntent]', err.code, err.message);
  },
});
```

### IntentManagerConfig

All fields are optional. Pass them to `new IntentManager(config)` or `IntentManager.createAsync(config)`.

| Field                           | Type                                                     | Default                                               | Description                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageKey`                    | `string`                                                 | `'passive-intent'`                                    | `localStorage` key used to persist the Bloom filter and Markov graph.                                                                                                        |
| `storage`                       | `StorageAdapter`                                         | `BrowserStorageAdapter`                               | Synchronous storage backend. Override for custom persistence or tests.                                                                                                       |
| `asyncStorage`                  | `AsyncStorageAdapter`                                    | —                                                     | Async storage backend (React Native, IndexedDB, etc.). Use with `IntentManager.createAsync()`. Takes precedence over `storage` for writes.                                   |
| `timer`                         | `TimerAdapter`                                           | `BrowserTimerAdapter`                                 | Timer backend. Override for deterministic tests.                                                                                                                             |
| `lifecycleAdapter`              | `LifecycleAdapter`                                       | `BrowserLifecycleAdapter`                             | Page-visibility adapter. Override for React Native, Electron, or SSR environments.                                                                                           |
| `bloom`                         | `BloomFilterConfig`                                      | —                                                     | Bloom filter sizing: `{ bitSize?: number, hashCount?: number }`. Defaults to 2048 bits / 4 hashes.                                                                           |
| `graph`                         | `MarkovGraphConfig`                                      | —                                                     | Markov graph tuning (see sub-fields below).                                                                                                                                  |
| `graph.highEntropyThreshold`    | `number`                                                 | `0.75`                                                | Normalized entropy threshold `[0, 1]` above which `high_entropy` fires.                                                                                                      |
| `graph.divergenceThreshold`     | `number`                                                 | `3.5`                                                 | Z-score magnitude for `trajectory_anomaly`. Decrease for more sensitivity.                                                                                                   |
| `graph.baselineMeanLL`          | `number`                                                 | —                                                     | Pre-computed mean of average per-step log-likelihood for normal sessions. Enables Z-score calibration. Also available as top-level `baselineMeanLL` (takes precedence).      |
| `graph.baselineStdLL`           | `number`                                                 | —                                                     | Pre-computed std of average per-step log-likelihood. Pair with `baselineMeanLL`. Also available as top-level `baselineStdLL` (takes precedence).                             |
| `graph.smoothingEpsilon`        | `number`                                                 | `0.01`                                                | Laplace smoothing probability for unseen transitions.                                                                                                                        |
| `graph.smoothingAlpha`          | `number`                                                 | `0.1`                                                 | Dirichlet pseudo-count for cold-start regularization. `0` = pure frequentist math. Also available as top-level `smoothingAlpha` (takes precedence).                          |
| `graph.maxStates`               | `number`                                                 | `500`                                                 | Maximum live states before LFU pruning triggers.                                                                                                                             |
| `baselineMeanLL`                | `number`                                                 | —                                                     | Top-level alias for `graph.baselineMeanLL`. Takes precedence when both are set.                                                                                              |
| `baselineStdLL`                 | `number`                                                 | —                                                     | Top-level alias for `graph.baselineStdLL`. Takes precedence when both are set.                                                                                               |
| `smoothingAlpha`                | `number`                                                 | `0.1`                                                 | Top-level alias for `graph.smoothingAlpha`. Takes precedence when both are set.                                                                                              |
| `baseline`                      | `SerializedMarkovGraph`                                  | —                                                     | Pre-trained baseline graph (from `MarkovGraph.toJSON()`). Required for `trajectory_anomaly` detection.                                                                       |
| `botProtection`                 | `boolean`                                                | `true`                                                | Enable EntropyGuard heuristic bot detection. Set `false` in E2E/CI environments.                                                                                             |
| `dwellTime`                     | `DwellTimeConfig`                                        | —                                                     | Dwell-time anomaly settings: `{ enabled?: boolean, minSamples?: number, zScoreThreshold?: number }`.                                                                         |
| `enableBigrams`                 | `boolean`                                                | `false`                                               | Record second-order (bigram) Markov transitions for more discriminative modeling.                                                                                            |
| `bigramFrequencyThreshold`      | `number`                                                 | `5`                                                   | Minimum outgoing transitions a unigram state must have before bigram edges are recorded.                                                                                     |
| `crossTabSync`                  | `boolean`                                                | `false`                                               | Broadcast verified transitions to other tabs via `BroadcastChannel`. No-op in SSR / unsupported environments.                                                                |
| `persistThrottleMs`             | `number`                                                 | `0`                                                   | Max write frequency for the prune+serialize pipeline. `0` = sync write on every `track()` (full crash-safety). `200–500` recommended for typical graphs.                     |
| `persistDebounceMs`             | `number`                                                 | `2000`                                                | Delay for the async-error retry path and `flushNow()` timer cancellation only. Does not control write frequency for normal `track()` flow.                                   |
| `eventCooldownMs`               | `number`                                                 | `0`                                                   | Minimum ms between consecutive emissions of the same cooldown-gated event (`high_entropy`, `trajectory_anomaly`, `dwell_time_anomaly`). `0` disables throttling.             |
| `hesitationCorrelationWindowMs` | `number`                                                 | `30000`                                               | Max gap (ms) between a `trajectory_anomaly` and a `dwell_time_anomaly` for them to combine into a `hesitation_detected` event.                                               |
| `driftProtection`               | `{ maxAnomalyRate: number; evaluationWindowMs: number }` | `{ maxAnomalyRate: 0.4, evaluationWindowMs: 300000 }` | Killswitch: disables trajectory evaluation when anomaly rate exceeds `maxAnomalyRate` within the rolling window. Set `maxAnomalyRate: 1` to disable.                         |
| `holdoutConfig`                 | `{ percentage: number }`                                 | —                                                     | Local A/B holdout: `percentage` (0–100) chance of routing a session to the `'control'` group, which suppresses anomaly events. Visible via `getTelemetry().assignmentGroup`. |
| `benchmark`                     | `BenchmarkConfig`                                        | —                                                     | Enable op-latency instrumentation: `{ enabled?: boolean, maxSamples?: number }`. Read results via `getPerformanceReport()`.                                                  |
| `onError`                       | `(error: PassiveIntentError) => void`                    | —                                                     | Non-fatal error callback for storage errors, quota exhaustion, parse failures, and validation errors. The engine never throws to the host.                                   |

### Adapters

| Export                    | Kind      | Description                                                                                                                                                                                         |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserStorageAdapter`   | class     | Wraps `localStorage`. Use in any browser context.                                                                                                                                                   |
| `BrowserTimerAdapter`     | class     | Wraps `setTimeout` / `clearTimeout`.                                                                                                                                                                |
| `MemoryStorageAdapter`    | class     | In-memory fallback — no persistence. Useful for SSR, tests, or ephemeral sessions.                                                                                                                  |
| `BrowserLifecycleAdapter` | class     | Page Visibility API adapter. Registers a `visibilitychange` listener and dispatches `onPause` / `onResume` callbacks. All `document` accesses are guarded so it is safe to import in SSR.           |
| `StorageAdapter`          | interface | Implement to provide a custom storage backend (IndexedDB, Capacitor Preferences, etc.).                                                                                                             |
| `TimerAdapter`            | interface | Implement to provide a custom timer backend (e.g. Node.js timers in tests).                                                                                                                         |
| `LifecycleAdapter`        | interface | Implement to provide a custom page-visibility / app-lifecycle backend for React Native, Electron, or environments where `document` is unavailable. Pass via `IntentManagerConfig.lifecycleAdapter`. |
| `TimerHandle`             | type      | Opaque handle returned by `TimerAdapter.setTimeout`.                                                                                                                                                |

### PropensityCalculator

Real-time conversion funnel scoring: combines Markov hitting probability with Welford Z-score friction into a single `[0, 1]` score.

**Formula:** `propensity = P_reach × exp(−α × max(0, z))`

| Method / Property                                             | Description                                                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new PropensityCalculator(alpha?, throttleMs?)`               | Construct with optional `alpha` (friction sensitivity, default `0.2`) and `throttleMs` (recompute gate, default `500`). At default α, the score halves when z ≈ 3.47 (one natural log unit). |
| `updateBaseline(graph, currentState, targetState, maxDepth?)` | Run a depth-bounded BFS over `graph` (any `IStateModel`) and cache the Markov hitting probability. O(D × F). Call on every `state_change` / navigation event.                                |
| `getRealTimePropensity(currentZScore)`                        | Apply `exp(−α × max(0, z))` to the cached baseline and return the fused score. Throttled: returns the cached score unchanged within the `throttleMs` window.                                 |

**Parameters for `updateBaseline`:**

| Parameter      | Type          | Default | Description                                                                                   |
| -------------- | ------------- | ------- | --------------------------------------------------------------------------------------------- |
| `graph`        | `IStateModel` | —       | Live state model. Pass `intent.getStateModel()` or any object implementing `getLikelyNext()`. |
| `currentState` | `string`      | —       | Starting node for the BFS (e.g. the route the user is currently on).                          |
| `targetState`  | `string`      | —       | Conversion goal (e.g. `'/checkout'`).                                                         |
| `maxDepth`     | `number`      | `3`     | Maximum BFS hops. Higher values find longer paths but cost more CPU.                          |

**Alpha calibration guide:**

| Session type                           | Recommended `alpha` | Behaviour at z = 3.5              |
| -------------------------------------- | ------------------- | --------------------------------- |
| Short, high-intent (e.g. checkout)     | `0.4`               | Score reduced to ~24 % of P_reach |
| Medium friction (default)              | `0.2`               | Score reduced to ~50 % of P_reach |
| Long, noisier browsing (e.g. research) | `0.1`               | Score reduced to ~70 % of P_reach |

**Import:**

```ts
import { PropensityCalculator } from '@passiveintent/core';
```

### Utilities

| Export                          | Signature                                                                                       | Description                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computeBloomConfig`            | `(expectedItems: number, falsePositiveRate: number) => { bitSize, hashCount, estimatedFpRate }` | Pure math helper — compute Bloom parameters without instantiating `BloomFilter`. Tree-shakeable.                                                                                                                                  |
| `normalizeRouteState`           | `(url: string) => string`                                                                       | Strips query strings/hash fragments, removes trailing slashes, and replaces UUID v4 / MongoDB ObjectID segments with `:id` — call this before `track()` to keep the state space compact.                                          |
| `MAX_STATE_LENGTH`              | `256` (constant)                                                                                | Hard upper bound on state label length accepted by `BroadcastSync`. Payloads exceeding this are silently dropped.                                                                                                                 |
| `MAX_PLAUSIBLE_DWELL_MS`        | `1_800_000` (constant, 30 min)                                                                  | Threshold above which a dwell-time or tab-hidden duration is considered implausible (CPU suspend / OS sleep). Measurements exceeding this are discarded and trigger a `session_stale` event (when `dwellTime.enabled` is `true`). |
| `ATTENTION_RETURN_THRESHOLD_MS` | `15_000` (constant, 15 s)                                                                       | Minimum tab-hidden duration before `attention_return` fires. Long enough to filter quick alt-tab glances; short enough to catch comparison shopping.                                                                              |
| `USER_IDLE_THRESHOLD_MS`        | `120_000` (constant, 2 min)                                                                     | Duration of user inactivity before `user_idle` fires. Conservative default that avoids false positives from reading or watching embedded video.                                                                                   |
| `IDLE_CHECK_INTERVAL_MS`        | `5_000` (constant, 5 s)                                                                         | Polling interval for idle-state checks. The `user_idle` event fires within 5 seconds of the actual threshold crossing. CPU overhead is negligible.                                                                                |

### Performance types

Exported from `@passiveintent/core` for use with `getPerformanceReport()`. Enable instrumentation via `benchmark: { enabled: true }` in `IntentManagerConfig`.

| Type                    | Description                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BenchmarkConfig`       | `{ enabled?: boolean; maxSamples?: number }` — passed to `IntentManagerConfig.benchmark` to activate latency recording.                                                                                                                                              |
| `OperationStats`        | Per-operation statistics: `{ count, avgMs, p95Ms, p99Ms, maxMs }`. One entry per tracked operation inside `PerformanceReport`.                                                                                                                                       |
| `MemoryFootprintReport` | Snapshot of engine size: `{ stateCount, totalTransitions, bloomBitsetBytes, serializedGraphBytes }`.                                                                                                                                                                 |
| `PerformanceReport`     | Full report returned by `getPerformanceReport()`: contains `track`, `bloomAdd`, `bloomCheck`, `incrementTransition`, `entropyComputation`, `divergenceComputation` (`OperationStats` each), plus `memoryFootprint` (`MemoryFootprintReport`) and `benchmarkEnabled`. |

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

### React Wrapper — `@passiveintent/react`

A separate package ships a drop-in `usePassiveIntent` hook that manages the full `IntentManager` lifecycle for React 18+, Next.js, and React Router apps:

```bash
npm install @passiveintent/react
```

```tsx
import { usePassiveIntent } from '@passiveintent/react';

const { track, on, getTelemetry, predictNextStates } = usePassiveIntent({
  storageKey: 'passive-intent',
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

## Microkernel API (Layer 2 + Layer 3)

The microkernel refactor introduced a strict 4-layer separation so any domain
(food-delivery, dating, fintech, React Native) can plug into the intent engine
without touching the core algorithms.

```text
Layer 1 — Core algorithms      MarkovGraph, BloomFilter       pure math, no I/O
Layer 2 — Microkernel          IntentEngine                   adapter interfaces only
Layer 3 — Web factory          createBrowserIntent()          progressive disclosure
Layer 4 — Framework SDKs       usePassiveIntent (React hook)  wraps IntentManager
```

### `createBrowserIntent(config?)` — Layer 3

| Field             | Type                                             | Default                       | Description                                                                    |
| ----------------- | ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------ |
| `storageKey`      | `string`                                         | `'passive-intent-engine'`     | `localStorage` key for cross-session persistence.                              |
| `baseline`        | `SerializedMarkovGraph`                          | —                             | Pre-trained graph for `trajectory_anomaly` detection.                          |
| `graph`           | `MarkovGraphConfig`                              | production defaults           | Entropy / divergence thresholds, smoothing, state cap.                         |
| `bloom`           | `BloomFilterConfig`                              | `bitSize: 2048, hashCount: 4` | Bloom filter sizing.                                                           |
| `stateNormalizer` | `(s: string) => string`                          | —                             | Custom normalizer applied after the built-in one. Return `''` to drop a state. |
| `onError`         | `(e: { code: string; message: string }) => void` | —                             | Non-fatal error callback (storage errors, parse failures).                     |

### `IntentEngine` — Layer 2

The raw microkernel for enterprise / cross-platform use cases. Zero references to
`window`, `document`, or `localStorage` — all I/O flows through four injected
adapter interfaces.

```ts
import { IntentEngine, type IntentEngineConfig } from '@passiveintent/core';

const engine = new IntentEngine({
  stateModel: myModel, // IStateModel
  persistence: myStorage, // IPersistenceAdapter
  lifecycle: myLifecycle, // ILifecycleAdapter
  input: myInput, // IInputAdapter (optional)
  storageKey: 'acme-app',
  onError: ({ code, message }) => logger.warn(code, message),
});
```

| Adapter interface     | Responsibility                                        |
| --------------------- | ----------------------------------------------------- |
| `IInputAdapter`       | Push-based navigation events (URL changes, swipes, …) |
| `ILifecycleAdapter`   | Platform pause / resume / exit-intent signals         |
| `IStateModel`         | Markov graph + Bloom filter signal evaluation         |
| `IPersistenceAdapter` | Synchronous key-value storage (load / save)           |

### `CoreInterfaces` namespace — enterprise plugin contracts

Import the namespace to implement custom adapters for any domain:

```ts
import type { CoreInterfaces } from '@passiveintent/core';

// React Native navigation adapter
class ReactNativeInputAdapter implements CoreInterfaces.IInputAdapter {
  subscribe(onState: (s: string) => void): () => void {
    return navigation.addListener('state', (e) => onState(e.data.state.routes.at(-1)?.name ?? '/'));
  }
  destroy(): void {}
}

// Swipe adapter for dating / food-delivery apps
class SwipeKinematicsAdapter implements CoreInterfaces.IInputAdapter {
  subscribe(onState: (s: string) => void): () => void {
    return swipeEmitter.on('swipe', ({ direction, cardId }) =>
      onState(`card:${cardId}:${direction}`),
    );
  }
  destroy(): void {}
}

// Capacitor storage for iOS / Android
// IPersistenceAdapter.load() is synchronous, so pre-load values into an
// in-memory cache before constructing IntentEngine.  save() updates the cache
// immediately and fire-and-forgets Preferences.set() for durability.
//
// For a fully async path without the pre-load step, use
// IntentManager.createAsync() with an AsyncStorageAdapter instead.
class CapacitorStorageAdapter implements CoreInterfaces.IPersistenceAdapter {
  private readonly cache = new Map<string, string>();

  /** Call once and await before passing this adapter to new IntentEngine(). */
  async init(keys: string[]): Promise<void> {
    for (const key of keys) {
      const { value } = await Preferences.get({ key });
      if (value !== null) this.cache.set(key, value);
    }
  }

  load(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  save(key: string, value: string): void {
    this.cache.set(key, value); // synchronous — engine sees it immediately
    void Preferences.set({ key, value }); // fire-and-forget persistence
  }
}
```

All four interfaces, plus `EntropyResult`, `TrajectoryResult`, and
`IntentEngineConfig`, are exported under the `CoreInterfaces` namespace.

---

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
10. **Persist synchronously** (crash-safe write on every `track()` call).

During persistence:

1. Return immediately if `isDirty` is `false` (no-op — nothing changed).
2. For async backends: return immediately (setting a pending-write flag) if a write is already in-flight; avoids redundant prune + serialize work.
3. Prune graph if state count exceeds limit.
4. Serialize graph to binary.
5. Encode binary to base64 and store alongside Bloom snapshot.
6. Reset `isDirty` to `false`.

> **`persistDebounceMs`** no longer controls write frequency for normal flow. Every `track()` calls `persist()` synchronously. The debounce value is only consulted by the async-error retry path and `flushNow()` timer cancellation.

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
│   ├── index.ts               # public barrel — all three layers exported here
│   ├── intent-sdk.ts
│   ├── adapters.ts
│   ├── factory.ts             # Layer 3 — createBrowserIntent() factory
│   ├── core/
│   │   ├── bloom.ts
│   │   └── markov.ts
│   ├── engine/
│   │   ├── intent-engine.ts   # Layer 2 — raw IntentEngine (microkernel)
│   │   ├── dwell.ts
│   │   ├── entropy-guard.ts
│   │   └── intent-manager.ts
│   ├── persistence/
│   │   └── codec.ts
│   ├── plugins/
│   │   └── web/               # Standard browser plugin implementations
│   │       ├── BrowserLifecycleAdapter.ts   # ILifecycleAdapter (Page Visibility API)
│   │       ├── MouseKinematicsAdapter.ts    # IInputAdapter (URL + scroll + velocity)
│   │       ├── ContinuousGraphModel.ts      # IStateModel (Markov + Bloom)
│   │       └── LocalStorageAdapter.ts       # IPersistenceAdapter (localStorage)
│   ├── sync/
│   │   └── broadcast-sync.ts
│   ├── types/
│   │   ├── events.ts
│   │   └── microkernel.ts     # IInputAdapter, ILifecycleAdapter, IStateModel, IPersistenceAdapter
│   └── utils/
│       └── route-normalizer.ts
├── tests/
│   ├── microkernel.test.mjs   # IntentEngine + web plugins + factory (58 tests)
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

PassiveIntent is dual-licensed:

### AGPLv3 — Free

Use PassiveIntent at no cost under the [GNU Affero General Public License v3.0](./LICENSE) if **all** of the following apply:

- Your project is open-source **and** you publish the complete source code.
- You are not incorporating PassiveIntent into a proprietary or closed-source product.
- If you run PassiveIntent as part of a network service, your entire application is also released under AGPLv3.

### Commercial License — Paid

A commercial license removes the AGPLv3 copyleft obligations. You need one if:

- You ship PassiveIntent inside a **closed-source or proprietary** product.
- You run it in a **SaaS / network service** without releasing your application source.
- You re-sell or white-label it inside an analytics or AdTech platform.

See [**PRICING.md**](../../PRICING.md) for tier details (Indie · Startup · Growth · Enterprise).  
Contact [support@passiveintent.dev](mailto:support@passiveintent.dev) to purchase a license.
