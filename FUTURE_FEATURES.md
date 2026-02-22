# Future Features & Requested Enhancements

> Items discussed during architecture review that are **not yet implemented**.
> Revisit this list when planning the next development cycle.

---

## 1. Cross-Tab Synchronization

**Priority:** Medium
**Complexity:** High
**Status:** Deferred — held for post-launch consideration

### Problem

Each browser tab maintains its own in-memory Markov graph and Bloom filter. Users who navigate across multiple tabs build fragmented models that never converge into a unified behavioral picture.

### Proposed Solution

Use the `BroadcastChannel` API (or `storage` event fallback for older browsers) to synchronize state mutations across tabs:

- **Leader election:** One tab owns the write lock; others forward `track()` deltas.
- **Merge protocol:** Graph transitions are additive (count summation). Bloom filters merge via bitwise OR.
- **Conflict resolution:** Last-writer-wins with vector clock or Lamport timestamp.
- **Adapter pattern:** Expose a `SyncAdapter` interface so consumers can plug in SharedWorker, ServiceWorker, or server-side sync.

### Risks

- `BroadcastChannel` is not available in all environments (e.g., SSR, some WebViews).
- Merge storms on high-frequency `track()` calls across many tabs.
- Increased `localStorage` write contention.

### Alternatives Considered

- Server-side graph merge on session end (simpler, but violates zero-egress promise).
- `SharedArrayBuffer` for lock-free Bloom filter sharing (requires COOP/COEP headers).

---

## 2. Click Velocity / Interaction Rate Feature Channel

**Priority:** Medium
**Complexity:** Medium

### Problem

The current anomaly detection relies solely on state-transition patterns (Markov) and timing regularity (EntropyGuard). It does not capture the *rate* of interactions within a single state — rapid clicking on a product page vs. calm scrolling are indistinguishable.

### Proposed Solution

Track clicks-per-second (or interactions-per-second) as a feature channel:

- Maintain a sliding window of interaction timestamps per state.
- Compute instantaneous rate and compare against learned mean/std per state.
- Emit `interaction_rate_anomaly` when z-score exceeds threshold.
- Could complement rage-click detection use case documented in the recipes.

### Considerations

- Must not regress `track()` latency — use the same Welford accumulator pattern as dwell-time.
- Requires a new `trackInteraction(state, type)` API or overloaded `track()` signature.

---

## 3. Inter-Event Interval Entropy

**Priority:** Low
**Complexity:** Medium

### Problem

EntropyGuard uses a simple threshold-based bot detector (delta < 50ms, variance < 100ms²). A more nuanced signal would be the **entropy of inter-event intervals** — bots produce near-zero entropy (perfectly regular), while humans produce moderate entropy (variable but not random).

### Proposed Solution

- Compute Shannon entropy over quantized inter-event intervals in the circular buffer.
- Very low entropy → bot-like regularity.
- Very high entropy → potentially random/noisy automation.
- Middle range → human.

### Considerations

- Quantization bin width needs careful tuning to avoid collapsing human variance.
- May overlap with existing EntropyGuard logic — evaluate whether it replaces or supplements.

---

## 4. Pluggable Scoring Dimensions (Feature Vector Architecture)

**Priority:** Low
**Complexity:** High

### Problem

The SDK currently evaluates anomalies through fixed pipelines (entropy, trajectory log-likelihood). Adding new signals (dwell-time, click velocity, interval entropy) creates a combinatorial explosion of independent event channels that consumers must manually correlate.

### Proposed Solution

Introduce a `FeatureVector` abstraction:

- Each scoring dimension (entropy, trajectory, dwell-time, click velocity) produces a normalized score in [0, 1].
- A configurable aggregation function (weighted sum, max, learned ensemble) produces a single `anomaly_score`.
- Consumers subscribe to `anomaly_score` events with a single threshold.

### Considerations

- Breaking API change — would need a major version bump.
- Aggregation weights need calibration data; default weights may not suit all applications.
- Could be offered as an opt-in "v2 scoring mode" alongside the existing per-channel events.

---

## 5. Session Replay Export (Privacy-Preserving)

**Priority:** Low
**Complexity:** Low

### Problem

Developers debugging anomaly detection thresholds have no visibility into what the SDK "saw" during a session.

### Proposed Solution

- `exportSessionReplay()` returns the recent trajectory, Bloom filter state, entropy scores, and dwell-time stats — all data that already exists in memory.
- No PII, no DOM snapshots, no network calls.
- Output format: JSON blob suitable for paste into the scenario matrix scripts.

---

## 6. Adaptive Threshold Tuning

**Priority:** Low
**Complexity:** High

### Problem

Static thresholds (`highEntropyThreshold`, `divergenceThreshold`, `zScoreThreshold`) work well for average applications but may be too sensitive or too lenient for specific domains.

### Proposed Solution

- Track historical event-fire rates over N sessions.
- Suggest adjusted thresholds that hit a target anomaly rate (e.g., "fire on the worst 5% of sessions").
- Expose via `getThresholdSuggestions()` — advisory only, no auto-mutation.

---

## 7. WebWorker Offload for Persistence

**Priority:** Low
**Complexity:** Medium

### Problem

Binary serialization and base64 encoding during `persist()` happens on the main thread. While fast today (~0.002ms), very large graphs could cause frame drops on low-end devices.

### Proposed Solution

- Optional `WorkerPersistAdapter` that posts the dirty graph to a dedicated worker for serialization.
- Main thread continues unblocked; worker writes to `localStorage` (or IndexedDB).
- Fallback to synchronous persist when `Worker` is unavailable.

---

## Implementation Priority Matrix

| Feature | Impact | Effort | Risk | Suggested Phase |
|---------|--------|--------|------|-----------------|
| Cross-Tab Sync | High | High | Medium | v1.2 |
| Click Velocity Channel | Medium | Medium | Low | v1.2 |
| Inter-Event Interval Entropy | Medium | Medium | Low | v1.3 |
| Feature Vector Architecture | High | High | High | v2.0 |
| Session Replay Export | Low | Low | None | v1.1 |
| Adaptive Threshold Tuning | Medium | High | Medium | v2.0 |
| WebWorker Persistence | Low | Medium | Low | v1.3 |

---

*Last updated: 2026-02-22*
