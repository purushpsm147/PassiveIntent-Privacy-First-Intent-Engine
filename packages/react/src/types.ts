/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  ConversionPayload,
  IntentEventMap,
  IntentEventName,
  PassiveIntentTelemetry,
} from '@passiveintent/core';

// ── Public return type ────────────────────────────────────────────────────────

export interface UsePassiveIntentReturn {
  /**
   * Track a page view or custom state transition.
   *
   * State labels are automatically normalized (query strings, hash fragments,
   * trailing slashes, UUIDs, and MongoDB ObjectIDs are stripped), so passing
   * `window.location.href` or `location.pathname` directly is safe.
   *
   * No-op during SSR and before the instance is mounted.
   */
  track: (state: string) => void;

  /**
   * Subscribe to an IntentManager event.
   *
   * Returns an unsubscribe function — pass it as the return value of a
   * `useEffect` cleanup to avoid listener leaks:
   *
   * ```tsx
   * useEffect(() => on('high_entropy', handler), [on]);
   * ```
   *
   * Returns a no-op unsubscribe during SSR.
   */
  on: <K extends IntentEventName>(
    event: K,
    listener: (payload: IntentEventMap[K]) => void,
  ) => () => void;

  /**
   * Returns the current telemetry snapshot (session-scoped aggregate counters
   * only — no raw behavioral data). Returns an empty object cast during SSR.
   */
  getTelemetry: () => PassiveIntentTelemetry;

  /**
   * Returns `{ state, probability }[]` sorted descending by probability for
   * all next states whose transition probability exceeds `threshold` (default
   * `0.3`). Pass a `sanitize` predicate to exclude sensitive or state-mutating
   * routes before using results for prefetching — see architecture docs.
   *
   * Returns an empty array during SSR or before the first `track()` call.
   */
  predictNextStates: (
    threshold?: number,
    sanitize?: (state: string) => boolean,
  ) => { state: string; probability: number }[];

  /**
   * O(1) Bloom filter membership test — has the user ever visited this state
   * (across sessions, via `localStorage`)? Returns `false` during SSR.
   */
  hasSeen: (state: string) => boolean;

  /**
   * Increment a named deterministic counter by `by` (default `1`).
   * Exact integer arithmetic — zero false positives.
   *
   * Returns the new counter value, or `0` during SSR / when unmounted.
   */
  incrementCounter: (key: string, by?: number) => number;

  /**
   * Read the current value of a named deterministic counter.
   * Returns `0` during SSR.
   */
  getCounter: (key: string) => number;

  /**
   * Reset a named deterministic counter to zero. No-op during SSR.
   */
  resetCounter: (key: string) => void;

  /**
   * Emit a local-only `conversion` event. The payload never leaves the device
   * unless your `conversion` listener explicitly sends it. No-op during SSR.
   *
   * ```tsx
   * const { trackConversion } = usePassiveIntent();
   * trackConversion({ type: 'purchase', value: 49.99, currency: 'USD' });
   * ```
   */
  trackConversion: (payload: ConversionPayload) => void;
}
