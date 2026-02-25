# @edgesignal/core

> Privacy-first, SSR-safe intent detection engine using local Markov-chain inference and Bloom filters.

This is the core package of the [EdgeSignal](https://github.com/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine) monorepo.

## Install

```bash
npm install @edgesignal/core
```

## Quick start

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
});

intent.on('state_change', (e) => console.log(e));
intent.track('/home');
```

## Features

- **Local-first inference** — no network calls required
- **SSR-safe runtime** — browser globals are behind adapters
- **Bounded growth** — LFU-style graph pruning prevents unbounded state expansion
- **Efficient persistence** — binary graph encoding with dirty-flag optimization
- **Bot-resilient signals** — EntropyGuard suppresses events for suspected automated sessions
- **Dwell-time anomaly detection** — statistical z-score analysis via Welford's online algorithm

## Documentation

See the full [project README](https://github.com/purushpsm147/EdgeSignal-Privacy-First-Intent-Engine#readme) for detailed documentation, architecture, and API reference.

## License

AGPL-3.0-only — see [LICENSE](./LICENSE) for details.
