# Privacy-First Intent Engine

A lightweight TypeScript SDK for on-device intent modeling.
It combines a Bloom filter for fast membership checks and a sparse Markov graph for transition learning, entropy signals, and trajectory anomaly detection.

## Why this library

- Local-first inference: no network calls required.
- SSR-safe runtime: browser globals are behind adapters.
- Bounded growth: LFU-style graph pruning prevents unbounded state expansion.
- Efficient persistence: binary graph encoding reduces serialization overhead.

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
- `persist()` performs graph pruning before snapshot.
- Restores from binary payload first, then legacy JSON payload fallback.

## Design decisions (brief)

- **Isomorphic adapters**: direct `window`/`localStorage` usage is avoided in core flow to keep SSR safe.
- **Memory bounds by default**: `maxStates` defaults to `500`; low-frequency states are pruned first.
- **Binary graph serialization**: reduces main-thread pressure compared to deep JSON graph snapshots.
- **Compatibility-first migration**: restore supports both new binary payloads and legacy JSON payloads.
- **Predictable anomaly math**:
  - entropy signal from normalized outgoing distribution,
  - trajectory anomaly from baseline log-likelihood window and optional z-score calibration.

## Logic flow (brief)

On each `track(state)`:

1. Add state to Bloom filter.
2. Add transition from previous state to current state.
3. Evaluate entropy signal (after minimum sample gate).
4. Evaluate trajectory anomaly (after minimum window gate and baseline availability).
5. Emit `state_change`.
6. Schedule debounced persistence.

During persistence:

1. Prune graph if state count exceeds limit.
2. Serialize graph to binary.
3. Encode binary to base64 and store alongside Bloom snapshot.

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

Run E2E tests (headless):

```bash
npm run test:e2e
```

Run E2E tests (headed):

```bash
npm run test:e2e:headed
```

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
│   └── scenario-matrix.mjs
├── sandbox/
│   ├── app.ts
│   └── index.html
├── cypress/
│   └── e2e/
│       └── intent.cy.ts
└── package.json
```
