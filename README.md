# Privacy-First Intent Engine

A lightweight TypeScript SDK for on-device intent modeling.
It combines a Bloom filter for fast membership checks and a sparse Markov graph for transition learning, entropy signals, and trajectory anomaly detection.

## Why this library

- Local-first inference: no network calls required.
- SSR-safe runtime: browser globals are behind adapters.
- Bounded growth: LFU-style graph pruning prevents unbounded state expansion.
- Efficient persistence: binary graph encoding with dirty-flag optimization reduces serialization overhead.
- Bot-resilient signals: EntropyGuard suppresses entropy and trajectory events for suspected automated sessions.

## Install

```bash
npm install privacy-first-intent-engine
```

## Quick usage

```ts
import {
  IntentManager,
  MarkovGraph,
  BrowserStorageAdapter,
  BrowserTimerAdapter,
} from 'privacy-first-intent-engine';

const baseline = new MarkovGraph();
baseline.incrementTransition('/home', '/search');
baseline.incrementTransition('/search', '/product');

const intent = new IntentManager({
  storageKey: 'ui-telepathy',
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

### EntropyGuard (Bot Protection)

EntropyGuard tracks the timing of the last 10 `track()` calls using a fixed-size circular buffer (no heap allocations in the hot path). It increments an internal `botScore` when:

- A delta between consecutive calls is below **50 ms** (impossibly fast for a human).
- The variance of recent deltas is below **100 ms²** (robotic, highly regular cadence).

When `botScore` reaches **5**, the session is flagged as `isSuspectedBot = true`. While flagged, `evaluateEntropy` and `evaluateTrajectory` return immediately without emitting events — normal navigation state is still recorded.

**Configuration:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `botProtection` | `boolean` | `true` | Enable EntropyGuard. Set to `false` in E2E test environments where a headless browser drives clicks programmatically. |

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
  - trajectory anomaly from baseline log-likelihood window and optional z-score calibration.
- **Bot-resilient signals**: EntropyGuard uses a fixed circular buffer to detect impossibly-fast or robotic timing patterns without allocating on every `track()` call.
- **Write-efficient persistence**: the dirty flag eliminates redundant `localStorage` writes when the user has not navigated since the last persist cycle.

## Logic flow (brief)

On each `track(state)`:

1. If `botProtection` is enabled, record the call timestamp into a circular buffer and evaluate timing patterns.
2. Check Bloom filter for the state (used to detect new-to-filter states for dirty tracking).
3. Add state to Bloom filter; mark dirty if the state was new.
4. Add transition from previous state to current state; mark dirty.
5. Evaluate entropy signal (skipped if bot suspected, or below minimum sample gate).
6. Evaluate trajectory anomaly (skipped if bot suspected, or below minimum window gate, or no baseline).
7. Emit `state_change`.
8. Schedule debounced persistence.

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
npx cypress run --spec "cypress/e2e/intent.cy.ts"
npx cypress run --spec "cypress/e2e/amazon.cy.ts"
```

**Open interactive test runner:**

```bash
npx cypress open
```

> **Note — bot protection in the sandbox:** Both `sandbox/app.ts` and `sandbox/amazon/app.ts` initialize `IntentManager` with `botProtection: false`. This is intentional: Cypress drives clicks programmatically in rapid succession, which would otherwise trigger EntropyGuard and suppress the entropy/anomaly toasts that the E2E assertions depend on. Never set `botProtection: false` in a production bundle.

## Repository structure

```
.
├── src/
│   ├── adapters.ts
│   ├── index.ts
│   └── intent-sdk.ts
├── tests/
│   └── intent-sdk.test.mjs
├── scripts/
│   ├── perf-runner.mjs
│   ├── perf-regression.mjs
│   ├── roc-experiment.mjs
│   └── scenario-matrix.mjs
├── sandbox/
│   ├── app.ts
│   ├── index.html
│   └── amazon/
│       ├── app.ts
│       └── index.html
├── cypress/
│   └── e2e/
│       ├── amazon.cy.ts
│       └── intent.cy.ts
└── package.json
```

## License

This project is dual-licensed:

1. **AGPLv3:** Free for open-source projects, personal use, and testing. Under this license, any modifications or integrations in a network-accessible service must also be open-sourced.
2. **Commercial License:** For use in closed-source, proprietary, or commercial applications without the AGPLv3 copyleft restrictions, a commercial license must be purchased. Contact purushpsm147@yahoo.co.in or successfulindian147@gmail.com for commercial licensing details.
