# PassiveIntent — Interactive Demo

> Vite + TypeScript single-page playground covering **every** feature, recipe, and API in `@passiveintent/core`.

## Open in StackBlitz

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/purushpsm147/PassiveIntent-Privacy-First-Intent-Engine/tree/main/demo)

## Run locally

```bash
# From the repo root
cd demo
npm install
npm run dev
```

> **Pre-requisite:** `@passiveintent/core` must be published to npm (`npm install` pulls `^1.0.0`).  
> For local development before publishing, see the monorepo workspace setup below.

### Local dev before npm publish

```bash
# From repo root — build core first
cd packages/core && npm run build && cd ../..

# Then in demo/, temporarily override the dep
cd demo
npm install --save ../packages/core
npm run dev
```

## What's covered

| Section              | Event / API                                                 |
| -------------------- | ----------------------------------------------------------- |
| Overview & Telemetry | `getTelemetry()`, `getPerformanceReport()`, `exportGraph()` |
| Basic Tracking       | `track()`, `state_change`, auto-normalization               |
| High Entropy         | `high_entropy`, `highEntropyThreshold`                      |
| Dwell Time Anomaly   | `dwell_time_anomaly`, Welford's algorithm                   |
| Trajectory Anomaly   | `trajectory_anomaly`, baseline graph                        |
| Hesitation Detection | `hesitation_detected`, intervention ladder                  |
| Attention Return     | `attention_return`, comparison-shopper pattern              |
| Idle Detection       | `user_idle`, `user_resumed`                                 |
| Exit Intent          | `exit_intent`, `likelyNext` prediction                      |
| Bloom Filter         | `BloomFilter`, `computeBloomConfig()`, `hasSeen()`          |
| Markov Predictions   | `predictNextStates()`, `MarkovGraph`, binary vs JSON        |
| Bot Detection        | `bot_detected`, EntropyGuard                                |
| Conversion Tracking  | `trackConversion()`, `conversion` event                     |
| Session Counters     | `incrementCounter()`, `getCounter()`, `resetCounter()`      |
| Cross-Tab Sync       | `BroadcastSync`, `crossTabSync` config                      |
