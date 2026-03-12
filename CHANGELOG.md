<!--
  Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] – Microkernel Architecture, Web Integration & Testing

### Microkernel Architecture — Four-Layer Model

- **Strict four-layer separation** — the core package now enforces a clean boundary between `Layer 1` (pure domain logic: `IntentEngine`, `ContinuousGraphModel`), `Layer 2` (microkernel contracts: adapter interfaces), `Layer 3` (platform factories: `createBrowserIntent`), and `Layer 4` (web plugins: `src/plugins/web/`). Any domain adapter—web, React Native, Capacitor, food-delivery—can be plugged in by satisfying the Layer 2 contracts without touching engine internals.
- **`IInputAdapter`** — new interface for push-based navigation input. `subscribe(onState)` receives canonical state strings and returns a teardown function; `destroy()` cleans up listeners. `MouseKinematicsAdapter` is the standard web implementation.
- **`ILifecycleAdapter`** — new interface for page-visibility and interaction events. Declares `onPause()`, `onResume()`, `onInteraction()`, `onExitIntent()`, and `destroy()`. `BrowserLifecycleAdapter` is the standard web implementation.
- **`IStateModel`** — new interface for the probabilistic state graph (`ContinuousGraphModel`). Covers `markSeen`, `hasSeen`, `recordTransition`, `getLikelyNext`, `evaluateEntropy`, `evaluateTrajectory`, `serialize`, and `restore`. Unlike the other three interfaces, `IStateModel` has no `destroy()` — lifecycle cleanup is the responsibility of the adapter layer, not the model.
- **`IPersistenceAdapter`** — new interface replacing the old untyped `StorageAdapter` duck-type. Declares `load(): string | null`, `save(data: string): void`, and `destroy()`. `LocalStorageAdapter` is the standard web implementation.
- **`src/types/microkernel.ts`** — all four interfaces are exported from this module and re-exported from the package root, giving TypeScript consumers a stable import path for custom adapter authoring.
- **Documentation** — `docs/architecture.md` and `packages/core/README.md` include ASCII layer diagrams, interface contracts, and sample adapter implementations for React Native and Capacitor.

### `MouseKinematicsAdapter` — Browser Navigation & Pointer Physics

- **`MouseKinematicsAdapter` class** — new `IInputAdapter` implementation that converts browser navigation events and pointer/scroll physics into canonical state strings consumed by `IntentEngine`.
  - **Navigation states** — listens to `popstate` and `hashchange`; emits `window.location.pathname` as the canonical state on every navigation change.
  - **Scroll-depth sub-states** — emits `<pathname>#scroll:<depth>` suffixes (`25`, `50`, `75`, `100`) as the user scrolls through content, enabling per-section engagement tracking without query-string pollution.
  - **Mouse-velocity states** — samples `mousemove` events and emits `<pathname>#velocity:<band>` (`slow`, `medium`, `fast`) when pointer speed crosses configurable thresholds, surfacing hesitation vs. confident-scanning intent signals.
  - **Deferred initial state** — the current `window.location.pathname` is emitted via `queueMicrotask` on `subscribe()` so listeners registered _after_ the factory call (e.g., `engine.on('state_change', …)` in application code) still receive the page-load state. Previously, synchronous emission caused the event to fire before any listener could be attached.
  - **SSR / Node.js safe** — every `window` access is guarded with `typeof window !== 'undefined'`; `subscribe()` returns a no-op teardown in non-browser environments.
- **Bug fix: lost initial `state_change` on page load** — prior to this release, `MouseKinematicsAdapter.subscribe()` emitted the current pathname synchronously, before `IntentEngine` had finished wiring up internal listeners. The fix wraps the initial emit in `queueMicrotask`, guaranteeing it fires after the current call stack resolves. Consumers who paste the factory setup and immediately attach `engine.on('state_change', …)` now reliably receive the page-load event.

### `createBrowserIntent()` Factory — Layer 3 Web Integration

- **`createBrowserIntent(options?)` factory** — new convenience factory exported from `@passiveintent/core` that wires all four standard web plugins (`ContinuousGraphModel`, `LocalStorageAdapter`, `BrowserLifecycleAdapter`, `MouseKinematicsAdapter`) into a ready-to-use `IntentEngine` in a single call. Replaces the previous manual wiring pattern.
- **Options** — accepts `storageKey` (defaults to `'__passiveintent'`), `stateNormalizer`, `onError`, and the full `IntentEngineConfig` surface. All fields are optional; a zero-config call works out of the box.
- **SSR-safe** — the factory itself is importable in Node.js / Edge Workers; plugins that access `window` or `document` self-disable via their individual guards.
- **Usage example** updated in `packages/core/README.md` — the quick-start snippet now places `engine.destroy()` in a dedicated teardown section (annotated as `// call during unmount / cleanup`) rather than inline with the setup code, preventing readers who paste the snippet from immediately destroying the engine.

### Performance Improvements

- **Average tracking time** — reduced from prior baseline; updated figures in `benchmarks/baseline.json` and `benchmarks/latest.json`.
- **Memory usage** — serialized graph size reduced; memory estimate updated in benchmark reports.
- **Benchmark methodology** — `perf-runner.mjs` was updated with a 5 000-call JIT warm-up pass so reported figures reflect steady-state V8 performance, not cold-start overhead.

### E2E Test Suite — `createBrowserIntent()` Browser Integration

- **`cypress/e2e/browser-intent.cy.ts`** — new Cypress E2E spec with 7 tests covering the full browser integration path:
  - Emits initial `state_change` with the page-load pathname via `MouseKinematicsAdapter` on page load (regression guard for the `queueMicrotask` fix above).
  - Emits `state_change` on `history.pushState` navigation.
  - Persists and restores engine state across page reloads via `LocalStorageAdapter`.
  - Emits `exit_intent` when the pointer leaves the viewport from above after a navigation.
  - Emits `high_entropy` after rapid-fire navigation transitions.
  - Calls `engine.destroy()` without throwing and stops emitting events afterward.
  - Exposes the engine on `window.__intent` for Cypress introspection via the sandbox app.
- **`sandbox/browser-intent/app.ts`** — new sandbox entry point that creates a `createBrowserIntent()` engine, logs all events to a `data-cy` event log in the DOM, and exposes `window.__intent` for automated test access.

### `PropensityCalculator` — Real-Time Conversion Funnel Scoring

- **`PropensityCalculator` class** — new zero-dependency, < 1 kB minified utility that answers "How likely is the current session to reach a target state?" in real time. Combines two scoring factors:
  1. **Markov hitting probability** (`updateBaseline`) — a depth-bounded BFS over the live transition graph that accumulates `Σ Π P(s_{i+1}|s_i)` across all simple paths of length ≤ `maxDepth`. Cached between calls.
  2. **Welford Z-score friction penalty** (`getRealTimePropensity`) — applies `exp(−α × max(0, z))` so that behavioral friction (dwell-time z-score) decays the structural probability in real time. Negative z-scores are clamped to 0.
- **Combined formula:** `propensity = P_reach × exp(−α × max(0, z))` — always in `[0, 1]`.
- **Constructor:** `new PropensityCalculator(alpha?: number = 0.2, throttleMs?: number = 500)`
  - `alpha` — friction sensitivity. At z = 3.5, α = 0.2 halves the score (half-life z = ln(2)/α ≈ 3.47). Increase for short, high-intent funnels; decrease for long, noisier sessions.
  - `throttleMs` — minimum ms between full recomputations. Throttled calls return the cached score with zero allocations.
- **`updateBaseline(graph, currentState, targetState, maxDepth = 3)`** — computes and caches the Markov hitting probability via path-aware BFS. Each node on the BFS frontier carries its own `pathVisited` set (the states already on that route), so a state is only blocked within the path that introduced it, not globally. This allows multiple distinct simple paths to converge through a shared intermediate state and have their probabilities accumulated correctly. Cycles along a single route are still rejected (the path cannot revisit a node it already contains). Time complexity O(D × F^D) in the worst case where D = `maxDepth` and F = average fan-out. Call on each `track()` navigation event.
- **`getRealTimePropensity(zScore)`** — applies the exponential friction penalty and returns the combined score, throttled to at most one full computation per `THROTTLE_MS` window.
- **`lastCalculationTime` initialized to `−Infinity`** — guarantees the first call is never throttled even in test environments where `performance.now()` returns `0`.
- **Per-path cycle prevention** — each BFS node carries a `pathVisited` set of states already on its route from source. Neighbours already in that set are skipped, blocking cycles (A→B→A→…) without a global visited set. Distinct simple paths that converge through a shared intermediate state are each explored independently and their probabilities summed.
- **Bundle impact:** 866 bytes minified / 453 bytes gzipped.
- **New file:** `src/engine/propensity-calculator.ts`
- **Exports:** available from `@passiveintent/core` package root and `intent-sdk` façade. Exposed on `window.__PassiveIntentSDK` in the sandbox app for E2E access.

### Unit Tests — `PropensityCalculator`

- **43 unit tests** in `packages/core/tests/propensity-calculator.test.mjs` in six groups:
  - **`updateBaseline` (10):** BFS traversal, hitting-probability accumulation, cycle safety, `visited` set semantics, baseline clamping, converging simple paths through shared intermediate state (regression for global-visited-set bug).
  - **`getRealTimePropensity` (11):** cold start, z=0 identity, positive/negative z clamping, mathematical accuracy, large z, throttle window, post-throttle recomputation, mid-throttle baseline update, zero-baseline score reset, zero-baseline throttle enforcement, post-zero-baseline throttled read.
  - **Constructor options (2):** custom `alpha` magnitude, custom `throttleMs` override.
  - **Input validation / sanitization guards (7):** `alpha=NaN` fallback, negative `alpha` fallback, `throttleMs=NaN` fallback, `throttleMs=Infinity` fallback, `maxDepth=NaN` fallback, `maxDepth=Infinity` fallback, `z=NaN` treated as 0.
  - **Property-based invariants (3):** `[0, 1]` range, monotonic decrease, empty-graph zero.
  - **Mathematical edge cases (10):** α=0 no-friction identity, half-life formula `z = ln(2)/α`, decay-ratio doubling identity, three-hop probability product, mixed-depth parallel path accumulation, direct-edge reachability at any `maxDepth`, successive `updateBaseline` overwrite semantics, `throttleMs=0` no-cache behavior, `Math.min(1, …)` clamp on degenerate graphs, dense formula grid across 3 α values × 14 z-scores.
- Total unit test count: **85 tests, 0 failures** (up from 75).

### E2E Tests — `PropensityCalculator` (`cypress/e2e/propensity.cy.ts`)

- **12 Cypress E2E tests** (Tests AL–AV) in real Chromium via the sandbox app: availability (AL), cold start (AM), reachable target score (AN), unreachable target (AO), probability accuracy (AP), positive z friction (AQ), negative z clamp (AR), throttle via `win.performance.now` override (AS), throttle window reset (AT), evidence accumulation (AU), `[0,1]` invariant sweep (AV).

### Unit Tests — Microkernel Architecture (Section 9)

- **6 new unit tests** added to `packages/core/tests/microkernel.test.mjs` covering `MouseKinematicsAdapter` behavior and the `createBrowserIntent` microtask contract:
  - `initial state is NOT emitted synchronously inside subscribe()` — verifies the `queueMicrotask` deferral is in place.
  - `initial state is emitted after the current microtask checkpoint` — verifies the deferred emit fires correctly after `await Promise.resolve()`.
  - `listener registered after subscribe() still receives the initial state` — directly models the regression scenario.
  - `popstate fires synchronously` — ensures navigation events (not the initial state) remain immediate.
  - `destroy() prevents further state emissions after popstate` — guards the teardown path.
  - `createBrowserIntent: listener registered after construction receives initial state_change via microtask` — end-to-end factory-level regression guard.
- Total unit test count: **85 tests, 0 failures**.

---

## [Unreleased] – Post-1.0 Engineering & Infrastructure

_Branch: `codex/convert-to-npm-workspaces-monorepo` — included in v1.0.0 initial release to enable future ecosystem extensions without breaking changes_

### Smart Exit-Intent Detection — `exit_intent` Event

- **`exit_intent` event** — emitted by `IntentManager` when the user's pointer exits the viewport from above (toward the browser chrome / address bar) **and** the Markov graph has at least one continuation candidate with probability ≥ 0.4. The event is suppressed entirely when no candidates meet the threshold, making data-free overlays structurally impossible.
- **`ExitIntentPayload`** — includes `state` (the route the user was viewing) and `likelyNext` (the highest-probability next state according to the graph). Exported as a public type.
- **`LifecycleAdapter.onExitIntent()`** — new optional method on the adapter interface. `BrowserLifecycleAdapter` implements it with a lazy `mouseleave` listener on `document.documentElement`, firing the callback only when `event.clientY <= 0`. Returns an unsubscribe function; the listener is torn down on unsubscription or `destroy()`.
- **Markov-gated architecture** — the probability check lives in `IntentManager` (not `LifecycleCoordinator`) to keep the coordinator decoupled from graph math. `LifecycleCoordinator` receives an opaque `onExitIntent?: () => void` callback and calls it when the adapter signals. The `IntentManager` callback performs `getLikelyNextStates(previousState, 0.4)` and either emits or silently returns.
- **Backward-compatible** — adapters that do not implement `onExitIntent` are silently skipped. Existing custom `LifecycleAdapter` implementations continue to work unchanged. Passing `null` or `undefined` as `lifecycleAdapter` still disables all lifecycle tracking as before.
- **`LifecycleCoordinator.destroy()`** — `exitIntentUnsub` is unconditionally nulled and called on teardown, preventing listener leaks after `IntentManager.destroy()`.
- **8 unit tests** in `packages/core/tests/exit-intent.test.mjs` covering: no emit when no previous state, no emit when graph has no candidates, correct emission with top-probability candidate, likelyNext accuracy on multi-transition graphs, multi-trigger (no self-suppression), backward-compat (adapter without `onExitIntent`), unsubscribe called on `destroy()`, no emission after `destroy()`, and state-label normalization via `normalizeRouteState`.

### Comparison Shopper — `attention_return` Event

- **`attention_return` event** — new event emitted by `LifecycleCoordinator` when the user returns to the tab after being hidden for ≥ 15 seconds. Designed for "Welcome Back" experiences — show a discount modal, refresh content, or surface a comparison offer the moment a user returns from price-shopping on a competitor tab.
- **`ATTENTION_RETURN_THRESHOLD_MS` constant (`15_000` ms / 15 seconds)** — exported from `@passiveintent/core`. Defines the minimum tab-hidden duration before the event fires. Short enough to catch genuine comparison shopping; long enough to filter out quick alt-tab / notification glances.
- **`AttentionReturnPayload`** — includes `state` (the route the user was viewing before switching away) and `hiddenDuration` (the exact hidden gap in milliseconds). Exported as a public type.
- **Independent of `session_stale`** — `attention_return` fires for any hide ≥ 15 s regardless of dwell-time configuration, while `session_stale` fires only when `dwellTime.enabled` is `true` and the gap exceeds 30 minutes. Both can fire on the same resume if the hidden duration exceeds both thresholds.
- **E2E coverage** — 7 Cypress E2E tests in `cypress/e2e/idle-attention.cy.ts` (Tests AL–AP, AW–AX) covering threshold gating, no-state guard, multi-cycle, session_stale co-firing, and Amazon demo integration.

### Idle-State Detector — `user_idle` / `user_resumed` Events

- **`user_idle` event** — emitted by `LifecycleCoordinator` after 2 minutes of user inactivity (no mouse, keyboard, scroll, or touch events). Fires at most once per idle period. Useful for pausing expensive UI, dimming overlays, or logging engagement drop-off.
- **`user_resumed` event** — emitted on the first user interaction after an idle period. Includes the total idle duration in `idleMs`. The dwell-time baseline is automatically adjusted to exclude the idle gap so downstream dwell-time anomaly detection is not distorted.
- **`USER_IDLE_THRESHOLD_MS` constant (`120_000` ms / 2 minutes)** — minimum inactivity before `user_idle` fires. Exported from `@passiveintent/core`.
- **`IDLE_CHECK_INTERVAL_MS` constant (`5_000` ms / 5 seconds)** — polling cadence for idle checks. CPU overhead is negligible; `user_idle` fires within 5 seconds of the actual threshold crossing.
- **`LifecycleAdapter.onInteraction()`** — new optional method on the adapter interface. `BrowserLifecycleAdapter` implements it with passive `mousemove`, `scroll`, `touchstart`, and `keydown` listeners throttled to 1 000 ms. Returns `null` in SSR / Node.js environments where `window.addEventListener` is unavailable, gracefully disabling idle detection.
- **Backward-compatible** — adapters that do not implement `onInteraction` are silently skipped. Existing custom `LifecycleAdapter` implementations continue to work unchanged.
- **`UserIdlePayload` / `UserResumedPayload`** — new event payload types. Both include `state` (the current state label) and `idleMs` (duration in milliseconds). Exported as public types.
- **E2E coverage** — 6 Cypress E2E tests in `cypress/e2e/idle-attention.cy.ts` (Tests AQ–AV) covering threshold firing, active-interaction prevention, resume detection, no-state guard, destroy cleanup, and feature independence from `attention_return`.

### Engine Modularisation (PRs #55 – #57)

The internal engine has been substantially refactored for separation of concerns.
**All public APIs and event semantics remain unchanged** — these are internal structural improvements only.

#### `SignalEngine` — Pure Evaluation Kernel

- **`SignalEngine` class extracted** — contains three evaluator methods that return typed decision objects with no external side-effects (no event emission, no I/O, no timer scheduling). Note: `evaluateDwellTime` intentionally mutates the per-state Welford accumulator as a statistical side-effect so that successive calls converge on accurate mean/std estimates:
  - `evaluateEntropy(state)` → `EntropyDecision | null`
  - `evaluateTrajectory(from, to, trajectory)` → `TrajectoryDecision | null`
  - `evaluateDwellTime(state, dwellMs)` → `DwellDecision | null` _(updates internal Welford accumulator)_
- The `AnomalyDecision` discriminated union is the typed contract between evaluators and the dispatcher; compile-time exhaustiveness is enforced via `assertNever`.
- `SignalEngine` owns `EntropyGuard` (bot detection) and per-state Welford dwell accumulators. `AnomalyDispatcher` is composed internally.

#### `AnomalyDispatcher` — Centralized Side-Effect Point

- **`AnomalyDispatcher` class** consolidates all anomaly emission logic previously scattered across `IntentManager`:
  - **Cooldown gating** — per-event-name `lastEmittedAt` map; one gate applied once per `dispatch()` call
  - **Holdout suppression** — control-group check applied in one place; counters still increment for A/B parity
  - **Telemetry counting** — `anomaliesFired` incremented after each non-cooldown-blocked decision
  - **Drift accounting** — `driftPolicy.recordAnomaly()` called for every `TrajectoryDecision` _before_ the cooldown check, preserving the original semantics
  - **Hesitation correlation** — trajectory + dwell-time timestamp bookkeeping and `hesitation_detected` emission

#### `EnginePolicy` Plugin Interface

- **`EnginePolicy` interface** replaces scattered boolean feature-flags and inline conditionals with self-contained pluggable modules invoked in deterministic order during the `track()` pipeline:
  `onTrackStart → onTrackContext → onTransition → onAfterEvaluation → onCounterIncrement → destroy`
- **`DwellTimePolicy`** — owns dwell-time measurement and passes `DwellDecision` to the signal kernel via `onTrackContext()`.
- **`BigramPolicy`** — owns second-order Markov recording via `onTransition()`; frequency-gated.
- **`DriftProtectionPolicy`** — owns the rolling-window anomaly-rate killswitch; referenced by `AnomalyDispatcher` for per-decision drift accounting.
- **`CrossTabSyncPolicy`** — owns `BroadcastChannel` propagation logic via `onTransition()` and `onCounterIncrement()`.

#### `LifecycleCoordinator` and `PersistenceCoordinator`

- **`LifecycleCoordinator`** extracts all page-visibility logic from `IntentManager`: tab-hide/show timestamp tracking, `previousStateEnteredAt` adjustment, `session_stale` emission, and adapter lifecycle management for internally-created adapters only (injected adapters are left untouched).
- **`PersistenceCoordinator`** extracts all storage logic: `restore()` on startup, throttle gate, dirty-flag short-circuit, sync vs. async strategy selection (`SyncPersistStrategy` / `AsyncPersistStrategy`), and write-failure retry.

---

### Repository Structure

- **npm workspaces monorepo** — repository restructured from a single-package layout to a proper npm workspaces monorepo. `@passiveintent/core` is the first published package; `@passiveintent/adaptive-ui` and `@passiveintent/security` are reserved as future workspace package names for upcoming releases.
- **Self-contained package** — all files specific to `@passiveintent/core` (Cypress E2E suite, sandbox apps, benchmark scripts, `tsconfig.json`, `cypress.config.ts`) were moved inside `packages/core/`. The repository root is now pure monorepo orchestration.
- **Root scripts via `--workspaces --if-present`** — replaced 18 hardcoded per-package passthrough scripts in the root `package.json` with workspace-forwarded equivalents, following the React / Angular monorepo convention.
- **Per-package `LICENSE` and `README.md`** — `packages/core/` now ships its own `LICENSE` (AGPL-3.0) and package-level `README.md` so npm consumers see the correct metadata without landing on the monorepo root.
- **Planned future packages** — `@passiveintent/adaptive-ui` and `@passiveintent/security` are planned but not yet present in this repository; their package directories will be added once they are ready for public release.

### Developer Experience

- **`.editorconfig`** — added root-level editor config (LF line endings, 2-space indent, UTF-8, trim trailing whitespace) so any editor auto-conforms without Prettier running.
- **Prettier** — added `prettier` as a root dev dependency with a `.prettierrc` (single quotes, trailing commas, `printWidth: 100`, LF) and `.prettierignore`. `format` / `format:check` scripts added to root `package.json`.
- **`engines` field** — `node: ">=20"` declared in both root and `packages/core/package.json` to surface a clear error on unsupported runtimes.
- **`.github/CODEOWNERS`** — auto-assigns `@purushpsm147` as reviewer on every PR across all packages.
- **`.github/PULL_REQUEST_TEMPLATE.md`** — standardised PR checklist (type of change, lint/typecheck, tests, docs).

### CI / CD

- All GitHub Actions steps now target `@passiveintent/core` explicitly via `-w @passiveintent/core` to avoid running against placeholder packages.
- Added `format:check` step to `ci.yml` so unformatted code fails the pipeline.
- Switched perf-matrix workflow to `npm ci` for reproducible installs.
- Added `ci.react.yml` for `@passiveintent/react` typecheck/test/build coverage.
- Added `release-gate.yml` to run full release-critical checks (typecheck, tests, build, package verification, and React pack dry-run) on publish-critical changes.

### Performance Tooling

- **JIT warm-up in `perf-runner.mjs`** — added a 5 000-call throwaway warm-up pass before measurement starts, so V8 JIT-compiles the hot paths before samples are collected. Previously early cold iterations inflated p99 by 2–3×.
- **Fixed memory measurement fallback** — removed the silent `|| serializedGraphBytes` fallback that made `memoryUsageEstimate` report `1 409 bytes` (the graph size) whenever GC fired mid-run. Now uses a clearly labelled proxy (`serializedGraphBytes × 10`) when the heap delta is negative.
- **Clean process exit** — added `manager.destroy()` + `process.exit(0)` at end of `perf-runner.mjs` to drain pending debounce timers; previously Node exited with code `1` due to hanging handles.
- **Regression thresholds overhauled in `perf-regression.mjs`**:
  - Replaced loose absolute p95/p99 ceilings (`0.15 ms` / `0.30 ms` — 21× headroom) with a **3× baseline multiplier hard ceiling**, providing a proportional guard that tightens automatically as the baseline improves.
  - Percentage regression tolerance raised to 25 % to absorb OS scheduling jitter at sub-microsecond scales, while the 3× ceiling still catches genuine algorithmic regressions.
  - Memory is now checked as a `%` regression vs baseline only (absolute heap bytes are too environment-dependent for a hard limit).
  - Added a "suspiciously fast" warning when a metric is >50 % below baseline — prompts a baseline update rather than silently drifting downward.
  - Fixed `pctChange()` returning `0` instead of skipping when the baseline value is `0`.

### Runtime Hardening

- **Async persist durability** — when `persist()` is called while an async write is already in flight, the engine now guarantees one follow-up persist pass after the in-flight write settles. This prevents dirty state from being stranded until a future manual flush.
- **Destroy + async overlap safety** — `destroy()`/`flushNow()` now preserve queued async persistence work instead of silently dropping updates that arrive during an in-flight write.
- **Trajectory smoothing correctness** — runtime trajectory scoring now honors `graph.smoothingEpsilon` with defensive fallback to the default `0.01` for invalid values.
- **Compatibility note** — all changes above are non-breaking and preserve default runtime behavior when custom `smoothingEpsilon` is not provided.

### Lifecycle Adapter Abstraction

- **`LifecycleAdapter` interface** — new `onPause(callback)`, `onResume(callback)`, and `destroy()` interface exported from `@passiveintent/core`. Decouples all page-visibility logic from the core engine, enabling safe usage in React Native, Electron, and SSR environments where `document` is unavailable.
- **`BrowserLifecycleAdapter` class** — concrete implementation backed by the Page Visibility API (`document.visibilitychange`). Guards every `document` access with `typeof document !== 'undefined'` checks so the class can be imported in Node.js / SSR without throwing.
- **`IntentManager` refactored** — removed all hardcoded `document.addEventListener` calls from `IntentManager`. The constructor now accepts an optional `lifecycleAdapter?: LifecycleAdapter` config field, falling back to `new BrowserLifecycleAdapter()` in browser contexts and `null` in non-browser contexts. When it creates the adapter internally, `destroy()` will call `lifecycleAdapter.destroy()`; for injected adapters it only unsubscribes its own callbacks.
- **`IntentManagerConfig.lifecycleAdapter`** — new optional field. Pass a custom implementation to support React Native, test environments without a DOM, or any host that has its own app-lifecycle events. Ownership remains with the caller; `IntentManager.destroy()` will not destroy injected adapters.

### CPU / OS Suspend Guard (`session_stale`)

- **`MAX_PLAUSIBLE_DWELL_MS` constant (`1_800_000` ms / 30 minutes)** — added to `constants.ts`. Any time delta exceeding this threshold is considered caused by CPU suspend, laptop sleep, or OS hibernation rather than genuine user behaviour.
- **`session_stale` event** — new event emitted on two code paths:
  - `reason: 'hidden_duration_exceeded'` — fired from the `onResume` callback when the tab-hidden gap exceeds the threshold. `previousStateEnteredAt` is reset to the current timestamp so the next `track()` begins a clean dwell epoch.
  - `reason: 'dwell_exceeded'` — fired from `runTransitionContextStage` when `dwellMs > MAX_PLAUSIBLE_DWELL_MS` is detected at `track()` time (fallback for environments without a Page Visibility API). The implausible measurement is discarded; `evaluateDwellTime` is never called with it.
- **Welford accumulator protection** — a sleep-inflated dwell is never fed into the per-state Welford accumulator. The statistical baseline is preserved; anomaly detection resumes cleanly on the next normal transition.
- **`SessionStalePayload`** — includes `reason`, `measuredMs`, and `thresholdMs` fields. Exported as a public type from `@passiveintent/core`.

### Crash-Safe Persist

- **Aggressive synchronous persist** — `runEmitAndPersistStage` now calls `persist()` directly instead of `schedulePersist()`. Every `track()` call flushes the compressed binary payload to the `StorageAdapter` synchronously (for `localStorage`-backed adapters) or fires the async promise immediately (for async backends). This eliminates the up-to-2-second crash window where unbuffered transitions could be lost to a sudden OS process kill (iOS swipe-up, Android OOM reaper, Chrome tab discard) before the debounce timer fired.
- **Dirty-flag short-circuit preserved** — the `isDirty` guard in `persist()` ensures back-to-back `track()` calls with no new behavioral data incur zero serialization overhead.
- **`schedulePersist()` retained** — still used as the retry mechanism after a failed async `setItem` write (the `.catch()` path), where debouncing is correct behaviour.

---

## 1.0.0 – Initial Release

### Features

- **Local-first inference** — no network calls required; the entire intent model runs inside the user's browser.
- **SSR-safe runtime** — browser globals (`window`, `localStorage`) are accessed only through swappable adapter interfaces, keeping the SDK safe in Node.js, Deno, Bun, and Edge Worker environments.
- **Bounded growth** — LFU-style graph pruning evicts the least-frequently-used states when `maxStates` is exceeded, preventing unbounded memory growth.
- **Efficient persistence** — binary graph encoding (`toBinary` / `fromBinary`) paired with a dirty-flag optimization eliminates redundant `localStorage` writes when no navigation has occurred since the last persist cycle.
- **Bot-resilient signals** — `EntropyGuard` tracks the last 10 `track()` call timestamps in a fixed circular buffer and suppresses entropy and trajectory events for sessions exhibiting impossibly-fast or robotic timing patterns.
- **Dwell-time anomaly detection** — per-state dwell time is tracked using Welford's online algorithm; a `dwell_time_anomaly` event fires when the z-score exceeds the configured threshold.
- **Selective bigram Markov transitions** — optional second-order transition learning (`A→B→C`) is frequency-gated: bigram edges are only recorded once the unigram from-state crosses `bigramFrequencyThreshold` (default: 5), preventing state explosion.
- **Event cooldown** — configurable `eventCooldownMs` suppresses repeated emissions of the same event type within a rolling window, protecting downstream consumers from event flooding.
- **Cross-tab synchronization** — `BroadcastSync` uses the `BroadcastChannel` API to propagate `track()` deltas and deterministic counter increments across tabs, with input-length validation to prevent heap-amplification attacks from compromised tabs.
- **Clean teardown** — `destroy()` flushes pending state, cancels all timers, and removes all event listeners; designed for SPA lifecycle hooks (`useEffect` teardown, `onUnmounted`, `ngOnDestroy`).
- **Route state normalizer** — `normalizeRouteState()` strips UUIDs and MongoDB ObjectIDs from URLs, collapsing dynamic routes to stable canonical keys.
