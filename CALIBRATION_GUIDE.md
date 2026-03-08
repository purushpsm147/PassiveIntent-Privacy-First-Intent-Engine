<!--
  Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# The PassiveIntent Enterprise Calibration Guide

> **The core insight:** A hardcoded threshold that works on an e-commerce checkout flow is noise on a media site. PassiveIntent does not guess — it learns your site's mathematics and builds a unique statistical model around your traffic. This is the calibration moat.

---

## Overview

Generic intent engines ship with fixed thresholds tuned on aggregate, cross-industry datasets. They treat a B2B SaaS dashboard and a DTC fashion store as equivalent. They are not.

PassiveIntent's calibration system is built on three compounding pillars:

| Pillar                         | Concept          | Why It Matters                                                                                                                                                                         |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Domain Baseline**         | The Topography   | Every site has a structurally unique "Perfect Path." Anomaly detection is meaningless without knowing what normal looks like.                                                          |
| **2. Statistical Calibration** | The Z-Score Moat | Your site's log-likelihood distribution has a unique mean and variance. A single Z-score cutoff applied universally produces catastrophic false-positive rates on high-variance sites. |
| **3. Intervention Mapping**    | The ROI          | Mathematical anomalies have zero business value unless they are mapped to a concrete, timed action that recovers revenue or engagement.                                                |

---

## Pillar 1: The Domain Baseline (The Topography)

Every website has a "Perfect Path" — the sequence of states a highly-intent user traverses before converting. The engine's Markov chain is trained on this topology.

**The critical insight:** A linear purchase funnel and a cyclical SaaS workflow produce fundamentally different transition probability matrices. A `/cart → /checkout` transition that implies high intent on an e-commerce site is the equivalent of `/reports → /settings` on a SaaS dashboard — routine, not exceptional.

### Baseline Architecture Comparison

| Dimension                    | E-commerce Baseline                               | SaaS Dashboard Baseline                           |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| **Path structure**           | Linear, converging                                | Cyclical, hub-and-spoke                           |
| **Perfect Path example**     | `/home → /product → /cart → /checkout`            | `/dashboard → /reports → /settings → /dashboard`  |
| **High-intent signal**       | Forward progression toward `/checkout`            | Repeated engagement with `/billing` or `/upgrade` |
| **Anomaly type to watch**    | Backward navigation; drop to `/home` from `/cart` | Stagnation on `/pricing`; exit from `/billing`    |
| **Markov chain topology**    | Directed acyclic graph (DAG)                      | Directed cyclic graph (DCG)                       |
| **Session length profile**   | Short, focused (< 5 min typical)                  | Long, exploratory (10–40 min typical)             |
| **Idle detection threshold** | Low (< 30 s signals abandonment)                  | High (2–5 min idle is normal research behavior)   |

### Configuring Your Baseline

```typescript
import { createIntentEngine } from '@passiveintent/core';

const engine = createIntentEngine({
  // Define the states the Markov model should track.
  // Use abstract labels — not raw URLs — for robustness across locale variants.
  states: ['home', 'product', 'cart', 'checkout', 'confirmation'],

  // Define which transitions represent the "Perfect Path."
  // The engine assigns higher prior probabilities to these edges.
  baseline: {
    perfectPath: ['home', 'product', 'cart', 'checkout'],
    idleThresholdMs: 20_000, // 20 s idle = potential abandonment (e-commerce)
    highEntropyStates: ['cart', 'checkout'],
  },
});
```

For a SaaS topology:

```typescript
const engine = createIntentEngine({
  states: ['dashboard', 'reports', 'settings', 'billing', 'upgrade'],

  baseline: {
    // Cyclical return to 'dashboard' is normal — do not penalize it.
    perfectPath: ['dashboard', 'billing', 'upgrade'],
    idleThresholdMs: 120_000, // 2 min idle is normal research behavior (SaaS)
    highEntropyStates: ['billing', 'upgrade'],
  },
});
```

---

## Pillar 2: Statistical Calibration (The Z-Score Moat)

### Why Hardcoded Thresholds Fail

The log-likelihood score produced by the Markov model represents how probable the observed navigation sequence is relative to the trained baseline. A naive implementation gates interventions at a fixed threshold like `logLikelihood < -2.0`.

This fails in production for a structural reason:

| Site Type                          | Log-Likelihood Distribution                | Effect of Fixed `-2.0` Threshold                                             |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| **Strict enterprise SaaS**         | Narrow distribution, low σ (e.g., σ ≈ 0.4) | Threshold is far in the tail — almost never fires. Interventions are missed. |
| **High-traffic media / editorial** | Wide distribution, high σ (e.g., σ ≈ 2.1)  | Threshold is near the mean — fires constantly. False positives destroy UX.   |
| **E-commerce (mixed intent)**      | Moderate distribution (e.g., σ ≈ 0.9)      | Threshold works coincidentally — but breaks on seasonal traffic shifts.      |

A single number calibrated on one site will be structurally wrong on every other site.

### The Z-Score Model

PassiveIntent normalizes raw log-likelihood scores against the site's own observed distribution:

$$Z = \frac{LL_{observed} - \mu_{baseline}}{\sigma_{baseline}}$$

Where:

- $LL_{observed}$ is the current session's log-likelihood score
- $\mu_{baseline}$ is the mean log-likelihood of your site's normal sessions (`baselineMeanLL`)
- $\sigma_{baseline}$ is the standard deviation of that distribution (`baselineStdLL`)

A Z-score of `-2.0` now means the same thing on every site: _this session is 2 standard deviations below your site's own normal._ The threshold is portable. The calibration is not.

### Running the Calibration Script

Instrument a representative sample of sessions (minimum 500 sessions recommended) and extract the distribution parameters. The `@passiveintent/core` package ships a calibration utility for this:

```typescript
import { runCalibration } from '@passiveintent/core/calibration';

// sessionLogs: array of raw log-likelihood scores from real production sessions
const result = runCalibration(sessionLogs);

console.log(result);
// {
//   baselineMeanLL: -3.47,
//   baselineStdLL:  0.91,
//   sampleSize:     1243,
//   p5:            -5.12,   // 5th percentile — useful as a hard floor
//   p95:           -1.83    // 95th percentile — confirms upper bound
// }
```

Feed the output directly into the engine configuration:

```typescript
const engine = createIntentEngine({
  // ... state and baseline config ...

  calibration: {
    baselineMeanLL: -3.47,
    baselineStdLL: 0.91,

    // Fire when a session drops 1.8 standard deviations below your site's normal.
    // This is your site's -1.8σ — not some generic industry number.
    zScoreThreshold: -1.8,
  },
});
```

### Recalibration Cadence

| Event                                       | Action                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Initial deployment                          | Run calibration on first 500–1,000 sessions.                                      |
| Major navigation redesign                   | Recalibrate immediately — topology change invalidates the prior.                  |
| Seasonal traffic shift (e.g., Black Friday) | Recalibrate or use a time-windowed rolling mean if traffic profiles diverge >15%. |
| New market / locale launch                  | Recalibrate per locale if navigation behavior differs materially.                 |

---

## Pillar 3: Intervention Mapping (The ROI)

A statistically significant anomaly is not business value. Business value is the action taken in response. The following examples illustrate how different organizations translate the same mathematical output into measurable revenue impact.

### Example 1: E-commerce — High Entropy → Priority Support Chat

**Context:** A consumer electronics retailer with high-ticket items (average order value > $800). High-entropy sessions on `/product` pages indicate a user who is repeatedly comparing options, scrolling back, or exhibiting hesitation signals.

**Signal used:** `intentScore.entropy > threshold` while state = `product`

**Intervention:** Proactively surface a "Talk to a Product Specialist" live chat widget — bypassing the standard chatbot queue.

```typescript
engine.on('high_entropy', (signal) => {
  if (signal.state === 'product' && signal.normalizedEntropy > 0.72) {
    chatWidget.escalateToPriorityQueue({
      message: 'Need help choosing? A specialist is available now.',
      triggerSource: 'passiveintent_entropy',
    });
  }
});
```

**ROI lever:** Converts undecided high-value sessions before they tab away to a competitor. Measurable via chat-assisted conversion rate vs. organic.

---

### Example 2: SaaS — Trajectory Anomaly → Billing Page Discount

**Context:** A project management SaaS. A trajectory anomaly on the `/billing` page — the user has visited it 3+ times in the session but has not converted — is a statistically reliable signal of price sensitivity or procurement hesitation.

**Signal used:** `intentScore.trajectoryAnomaly === true` while state = `billing`

**Intervention:** Trigger a time-limited 10% discount modal, presented as a one-time offer, surfaced only to this statistically-identified high-intent cohort.

```typescript
engine.on('trajectory_anomaly', (signal) => {
  if (signal.stateTo === 'billing' && signal.zScore > 2.5) {
    discountEngine.showLimitedOffer({
      discountPercent: 10,
      expiryMinutes: 30,
      cohortTag: 'billing_anomaly_passiveintent',
    });
  }
});
```

**ROI lever:** Surgical discount targeting — only fires for statistically identified fence-sitters, not all billing page visitors. Protects margin while recovering churnable accounts.

---

### Example 3: Media / Editorial — High Next-State Probability → Aggressive Prefetching

**Context:** A high-traffic editorial publication. When the Markov model assigns a high transition probability to the next state (e.g., `P(article_B | article_A) > 0.65`), the user's next click is predictable before it happens.

**Signal used:** `intentScore.topPredictedNextState` with `probability > 0.65`

**Intervention:** Prefetch and pre-render the predicted next article into the browser cache before the user clicks.

> **Planned feature — not yet available.** Dedicated `highProbabilityPrediction` event emission is on the roadmap. Today, call `intent.predictNextStates(threshold, sanitize)` after each `track()` call to get `{ state, probability }[]` and trigger prefetching from your own handler.

```typescript
// Current API — poll predictNextStates after each navigation
engine.on('state_change', () => {
  const predictions = intent.predictNextStates(0.65);
  for (const { state, probability } of predictions) {
    if (probability > 0.65) {
      const nextUrl = stateToUrlMap[state];
      prefetchLink(nextUrl); // <link rel="prefetch">
      prerenderPage(nextUrl); // Navigation API prerender hint
    }
  }
});
```

**ROI lever:** Perceived page load time drops to near-zero for the predicted navigation. Directly improves Core Web Vitals (LCP), scroll depth, and pages-per-session — all critical for ad-impression revenue.

---

## Calibration Checklist

Use this checklist before declaring a PassiveIntent deployment production-ready.

| Step                           | Description                                                     | Status |
| ------------------------------ | --------------------------------------------------------------- | ------ |
| ☐ State taxonomy defined       | Abstract state labels mapped to your URL/route patterns         | —      |
| ☐ Perfect Path documented      | Linear or cyclical baseline path confirmed with product team    | —      |
| ☐ Idle threshold set           | Validated against real session recordings, not guessed          | —      |
| ☐ Calibration sample collected | Minimum 500 production sessions logged                          | —      |
| ☐ `baselineMeanLL` extracted   | Computed via `runCalibration()` utility                         | —      |
| ☐ `baselineStdLL` extracted    | Computed via `runCalibration()` utility                         | —      |
| ☐ `zScoreThreshold` tuned      | Back-tested against labeled sessions (false-positive rate < 5%) | —      |
| ☐ Intervention handlers wired  | Each anomaly event type mapped to a concrete business action    | —      |
| ☐ Recalibration schedule set   | Calendar reminder for post-redesign and seasonal recalibration  | —      |

---

## Further Reading

- [Architecture & API Deep-Dive](./packages/core/docs/architecture.md)
- [Binary Codec Specification](./BINARY_CODEC_SPEC.md)
- [Pricing & Commercial Licensing](./PRICING.md)
