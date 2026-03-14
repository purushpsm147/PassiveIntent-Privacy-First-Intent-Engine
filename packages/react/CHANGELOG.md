# Changelog

All notable changes to `@passiveintent/react` will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] - 2026-03-14

### Added

- `PassiveIntentProvider` for sharing a single `IntentManager` instance across a React subtree.
- Context-mode `usePassiveIntent()` so descendants can read the shared provider instance without passing config repeatedly.
- Provider-only reactive hooks built on top of the shared engine:
  - `useExitIntent()`
  - `useIdle()`
  - `useAttentionReturn()`
  - `useSignals()`
  - `usePropensity()`
  - `usePropensityScore()`
  - `usePredictiveLink()`
  - `useEventLog()`
- Standalone React wrappers for core data structures:
  - `useBloomFilter()`
  - `useMarkovGraph()`
- React package re-exports for the main core classes, helpers, event payload types, and adapter interfaces.
- Provider and hook-focused test coverage for context mode, lifecycle cleanup, and the new reactive hooks.

### Changed

- `usePassiveIntent` now supports two explicit modes:
  - `usePassiveIntent()` for provider context access
  - `usePassiveIntent(config)` for isolated component-scoped engines
- Engine creation in provider and standalone mode now happens synchronously during render with an idempotent guard, preventing missed child subscriptions during initial effects.
- `getTelemetry()` now returns a fully typed zero-value telemetry object before the engine is live instead of an empty object cast.
- The React package now targets `@passiveintent/core@^1.1.0`.

### Notes

- Provider-based hooks throw a descriptive error when used outside `PassiveIntentProvider`.
- Reactive provider hooks use `useSyncExternalStore` for React 18 concurrent rendering safety.

---

## [1.0.0] - 2026-03-09

### Added

- Initial React wrapper with standalone `usePassiveIntent(config)`.
- Stable methods for `track`, `on`, `getTelemetry`, `predictNextStates`, `hasSeen`, and deterministic counters.
- SSR-safe and Strict Mode-safe `IntentManager` lifecycle handling for React applications.
