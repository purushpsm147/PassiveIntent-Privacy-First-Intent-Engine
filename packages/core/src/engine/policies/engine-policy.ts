/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.devt.devt.devt.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Read-only context slice available to every policy hook that fires during
 * a `track()` call.  Intentionally a plain-object interface so that
 * IntentManager's internal `TrackContext` satisfies it structurally.
 */
export interface PolicyTrackContext {
  readonly state: string;
  readonly now: number;
  readonly from: string | null;
}

/**
 * Internal pluggable policy interface.
 *
 * Policies replace scattered boolean feature-flags and inline conditionals
 * with self-contained modules.  Each policy implements only the hooks it
 * needs.  IntentManager invokes the hooks in a deterministic order during
 * the `track()` pipeline:
 *
 *   1. `onTrackStart(now)` — once, before pipeline stages (drift window)
 *   2. `onTrackContext(ctx)` — inside the transition-context stage
 *   3. `onTransition(from, to, trajectory)` — after the transition is recorded
 *   4. `onAfterEvaluation(from, to)` — after all signal evaluation completes
 *   5. `onCounterIncrement(key, by)` — inside `incrementCounter()`
 *   6. `destroy()` — inside `IntentManager.destroy()`
 *
 * All hooks are optional; a policy that only cares about transitions
 * implements `onTransition` alone.
 */
export interface EnginePolicy {
  /**
   * Called once at the start of each `track()` invocation, before any
   * pipeline stage executes.  The current monotonic timestamp is passed so
   * time-windowed bookkeeping (e.g. drift protection) can advance.
   */
  onTrackStart?(now: number): void;

  /**
   * Called during the transition-context pipeline stage, after
   * `previousState` is captured into `ctx.from` but **before**
   * `previousStateEnteredAt` is reset.  This is the correct position
   * for dwell-time measurement.
   */
  onTrackContext?(ctx: PolicyTrackContext): void;

  /**
   * Called immediately after a transition is recorded in the Markov graph
   * and the telemetry counter incremented, but **before** `markDirty`,
   * entropy evaluation, and trajectory evaluation.  Bigram accounting
   * belongs here.
   */
  onTransition?(from: string, to: string, trajectory: readonly string[]): void;

  /**
   * Called after entropy and trajectory signal evaluation completes.
   * Cross-tab broadcasting belongs here — broadcast only after the local
   * model has been updated and evaluated.
   */
  onAfterEvaluation?(from: string, to: string): void;

  /**
   * Called when a deterministic counter is incremented via
   * `IntentManager.incrementCounter()`.
   */
  onCounterIncrement?(key: string, by: number): void;

  /**
   * Called during `IntentManager.destroy()` to release resources (channels,
   * timers, subscriptions).
   */
  destroy?(): void;
}
