# Privacy-First Intent Engine

A lightweight TypeScript SDK for modeling user navigation intent entirely on-device.
It combines a Bloom filter for state presence checks and a sparse Markov graph for
transition modeling, entropy monitoring, and trajectory anomaly detection.

## Features

- **Local-first state modeling**: no network requests required for inference.
- **Compact memory profile**:
  - Bloom filter for fast "seen state" checks.
  - Sparse graph representation for state transitions.
- **Behavior signals**:
  - High-entropy navigation detection.
  - Baseline trajectory divergence detection.
- **Persistence support**:
  - Automatic `localStorage` snapshot/restore.
  - Debounced persistence to reduce UI overhead.

## Core API

### `BloomFilter`

- `add(item: string)`
- `check(item: string): boolean`
- `toBase64(): string`
- `BloomFilter.fromBase64(base64, config)`

### `MarkovGraph`

- `incrementTransition(fromState, toState)`
- `getProbability(fromState, toState)`
- `entropyForState(state)`
- `normalizedEntropyForState(state)`
- `getQuantizedRow(state)`
- `getQuantizedProbability(fromState, toState)`
- `toJSON()` / `MarkovGraph.fromJSON(data)`
- `MarkovGraph.logLikelihoodTrajectory(baseline, sequence)`

### `IntentManager`

- `track(state)` records the latest state and transition.
- `hasSeen(state)` checks Bloom filter membership.
- `on(event, listener)` subscribes to SDK events:
  - `state_change`
  - `high_entropy`
  - `trajectory_anomaly`
- `exportGraph()` exports transition graph JSON.
- `flushNow()` forces immediate persistence.

## Development

### Install dependencies

```bash
npm install
```

### Run test suite

```bash
npm test
```

## Test Coverage

The automated test suite validates:

- Bloom filter add/check and base64 round-trip behavior.
- Markov probability, entropy, quantization, and JSON serialization.
- Markov trajectory likelihood smoothing for unseen edges.
- Intent manager event emission, state tracking, persistence, and restore behavior.

## Repository Structure

- `src/intent-sdk.ts`: SDK source implementation.
- `tests/intent-sdk.test.mjs`: Node test suite.
- `package.json`: project metadata and test script.
