# @passiveintent/react — Interactive Demo

A full React 18 demo showcasing every major API in `@passiveintent/core` and `@passiveintent/react`.
Built with Vite + TypeScript + the `usePassiveIntent` hook.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/purushpsm147/PassiveIntent-Privacy-First-Intent-Engine/tree/main/demo-react)

---

## Demos included

| Demo               | API / Event                                | Description                                      |
| ------------------ | ------------------------------------------ | ------------------------------------------------ |
| Overview           | `getTelemetry()`                           | Live metrics — zero PII, GDPR-compliant snapshot |
| Basic Tracking     | `track()` + `state_change`                 | Route tracking with auto-normalization           |
| High Entropy       | `high_entropy`                             | Erratic navigation / frustration signal          |
| Dwell Time         | `dwell_time_anomaly`                       | Welford z-score, simulated hesitation            |
| Trajectory         | `trajectory_anomaly`                       | Baseline graph, divergence detection             |
| Hesitation         | `hesitation_detected`                      | Combined signal + intervention ladder recipe     |
| Attention Return   | `attention_return`                         | Comparison-shopper "Welcome Back" pattern        |
| Idle Detection     | `user_idle` + `user_resumed`               | 2-min idle, resume with idleMs                   |
| Exit Intent        | `exit_intent`                              | Smart — requires Markov confidence ≥ 0.4         |
| Bloom Filter       | `hasSeen()` + `BloomFilter`                | O(k) membership, bit visualizer, sizing API      |
| Markov Predictions | `predictNextStates()` + `MarkovGraph`      | Prefetch next page, binary vs JSON size          |
| Bot Detection      | `bot_detected`                             | EntropyGuard — 5-signal scoring system           |
| Conversion         | `trackConversion()`                        | Local-only revenue correlation, zero egress      |
| Counters           | `incrementCounter/getCounter/resetCounter` | Session counters, impression capping             |

---

## Run locally

```bash
# From the monorepo root
npm install

# Build the packages first (required for local resolution)
npm run build --workspace=packages/core
npm run build --workspace=packages/react

# Start the React demo
cd demo-react
npm install
npm run dev
```

Then open http://localhost:5174 (Vite auto-picks the next available port).

---

## Key React patterns shown

### Subscribe in `useEffect`, return cleanup

```tsx
const { on } = usePassiveIntent(config);

useEffect(() => {
  return on('hesitation_detected', ({ zScoreDwell, zScoreTrajectory }) => {
    // scale intervention based on combined severity
  });
}, [on]); // 'on' is referentially stable — effect runs once
```

### Stable method references

All methods returned by `usePassiveIntent` are **stable** (wrapped in `useCallback` internally).
Safe to use in `useEffect` dependency arrays without causing re-subscription loops.

### Controllable adapters (simulation)

The demo uses `ControllableTimerAdapter` and `ControllableLifecycleAdapter` so every
event can be triggered from a button click — no real 2-minute wait, no real tab-switching.

```tsx
// Fast-forward virtual clock for dwell-time tests
timer.fastForward(5 * 60 * 1000); // 5 minutes in milliseconds

// Trigger lifecycle events programmatically
lifecycle.triggerPause();
lifecycle.triggerResume();
lifecycle.triggerExitIntent();
```

---

## Architecture

```
src/
  main.tsx            # ReactDOM.createRoot entry point
  adapters.ts         # ControllableTimerAdapter + ControllableLifecycleAdapter
  baseline.ts         # Pre-built ecommerce MarkovGraph baseline
  IntentContext.tsx   # IntentProvider + useIntent() consumer hook
  App.tsx             # Page routing via useState
  Shell.tsx           # Fixed layout: header + sidebar + main + event log
  components/
    CodeBlock.tsx     # Pre-highlighted code snippets
    MetricCard.tsx    # Metric tile
  pages/              # 14 feature demos (one per page)
    Overview.tsx
    BasicTracking.tsx
    ...
  style.css           # Dark professional theme
```

---

## Related

- [Vanilla JS demo](../demo/) — same features, no framework
- [@passiveintent/core](../packages/core/) — the core engine
- [@passiveintent/react](../packages/react/) — the `usePassiveIntent` hook
- [Publishing guide](../PUBLISHING.md)
