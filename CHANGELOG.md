<!--
  Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>

  This source code is licensed under the AGPL-3.0-only license found in the
  LICENSE file in the root directory of this source tree.
-->

# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] – Post-1.0 Engineering & Infrastructure

_Branch: `codex/convert-to-npm-workspaces-monorepo` — included in v1.0.0 initial release to enable future ecosystem extensions without breaking changes_

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
