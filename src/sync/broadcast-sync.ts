/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { BloomFilter } from '../core/bloom.js';
import type { MarkovGraph } from '../core/markov.js';

/**
 * Hard upper bound on each state label accepted over the broadcast channel.
 *
 * A compromised tab could send arbitrarily long strings to exhaust memory in
 * every other tab (heap amplification / buffer-overflow equivalent in JS).
 * Payloads that exceed this limit are **silently dropped** so that a single
 * bad tab cannot degrade the rest of the session fleet.
 */
export const MAX_STATE_LENGTH = 256;

/**
 * Wire format of a Markov-transition sync message.
 */
interface TransitionMessage {
  /** Discriminant. */
  type: 'transition';
  /** The state the user navigated *from*. */
  from: string;
  /** The state the user navigated *to*. */
  to: string;
}

/**
 * Wire format of a deterministic counter increment sync message.
 *
 * Only positive, finite `by` values are acted on; malformed or unbounded
 * payloads are silently dropped.
 */
interface CounterMessage {
  /** Discriminant. */
  type: 'counter';
  /** Counter key — same length constraints as state labels (≤ MAX_STATE_LENGTH). */
  key: string;
  /** Amount to add to the counter. Must be finite; validated before use. */
  by: number;
}

/** Union of all wire-protocol message types. */
type SyncMessage = TransitionMessage | CounterMessage;

/**
 * Type-guard for `TransitionMessage`.
 *
 * Rejects the payload if `from` or `to` exceed `MAX_STATE_LENGTH` (memory-
 * exhaustion / model-poisoning guard).
 */
function isValidTransitionMessage(msg: Record<string, unknown>): boolean {
  if (msg['type'] !== 'transition') return false;
  if (typeof msg['from'] !== 'string' || typeof msg['to'] !== 'string') return false;
  if (msg['from'].length === 0 || msg['to'].length === 0) return false;
  if (msg['from'].length > MAX_STATE_LENGTH || msg['to'].length > MAX_STATE_LENGTH) return false;
  return true;
}

/**
 * Type-guard for `CounterMessage`.
 *
 * Rejects the payload if:
 *   - `key` is not a non-empty string ≤ `MAX_STATE_LENGTH`
 *   - `by` is not a finite number (guards against `Infinity`, `NaN`)
 */
function isValidCounterMessage(msg: Record<string, unknown>): boolean {
  if (msg['type'] !== 'counter') return false;
  if (typeof msg['key'] !== 'string') return false;
  if (msg['key'].length === 0 || msg['key'].length > MAX_STATE_LENGTH) return false;
  if (typeof msg['by'] !== 'number' || !Number.isFinite(msg['by'])) return false;
  return true;
}

/**
 * Optional cross-tab synchronization layer using the
 * [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).
 *
 * **Design goals**
 *
 * 1. **Model consistency** — when a user navigates in Tab A, Tab B's Markov
 *    graph and Bloom filter learn that transition too, so prefetch hints stay
 *    accurate across a multi-tab session.
 *
 * 2. **Counter consistency** — when a user increments a named counter in Tab A
 *    (e.g. `incrementCounter('articles_read')`), all other tabs receive the
 *    same increment so their local counts stay in sync.
 *
 * 3. **XSS / model-poisoning hardening** — every incoming message is
 *    validated before touching any data structure: state labels and counter
 *    keys must be non-empty strings ≤ `MAX_STATE_LENGTH` (256 chars);
 *    counter `by` values must be finite numbers.
 *    Oversized or malformed payloads are silently dropped.
 *
 * 4. **Infinite-loop prevention** — remote transitions/increments applied via
 *    `applyRemote()` / `applyRemoteCounter()` update in-memory state directly
 *    **without** re-broadcasting to the channel.
 *
 * 5. **Bot flood containment** — `IntentManager` only calls `broadcast()` and
 *    `broadcastCounter()` when the local `EntropyGuard` has *not* flagged the
 *    session as a bot.
 *
 * **SSR / non-browser safety** — `BroadcastSync` checks for `BroadcastChannel`
 * availability at construction time.  When it is absent (Node.js, older
 * browsers) the instance is created but all methods become no-ops; `isActive`
 * returns `false` so callers can inspect the state.
 *
 * @example
 * ```ts
 * const sync = new BroadcastSync('edgesignal-sync', graph, bloom, counters);
 * // Called by IntentManager after a verified local transition:
 * sync.broadcast('/home', '/products');
 * // Called by IntentManager after a local counter increment:
 * sync.broadcastCounter('articles_read', 1);
 * // Clean up on destroy:
 * sync.close();
 * ```
 */
export class BroadcastSync {
  private readonly channel: BroadcastChannel | null;
  private readonly graph: MarkovGraph;
  private readonly bloom: BloomFilter;
  private readonly counters: Map<string, number>;

  /**
   * `true` when a real `BroadcastChannel` was opened successfully.
   * `false` in SSR / environments without the API.
   */
  readonly isActive: boolean;

  constructor(
    channelName: string,
    graph: MarkovGraph,
    bloom: BloomFilter,
    counters: Map<string, number> = new Map(),
  ) {
    this.graph = graph;
    this.bloom = bloom;
    this.counters = counters;

    if (typeof BroadcastChannel === 'undefined') {
      this.channel = null;
      this.isActive = false;
      return;
    }

    this.channel = new BroadcastChannel(channelName);
    this.isActive = true;

    this.channel.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
  }

  /**
   * Broadcast a locally-verified transition to all other tabs on the same
   * channel.
   *
   * **Must only be called for transitions that have already passed the local
   * `EntropyGuard` check.**  `IntentManager` enforces this invariant; do not
   * call this method directly unless you can guarantee the same condition.
   *
   * @param from  Normalized source state label (must not be empty).
   * @param to    Normalized destination state label (must not be empty).
   */
  broadcast(from: string, to: string): void {
    if (!this.channel) return;
    const msg: TransitionMessage = { type: 'transition', from, to };
    this.channel.postMessage(msg);
  }

  /**
   * Broadcast a counter increment to all other tabs so their local counter
   * Maps stay in sync with the tab that originated the increment.
   *
   * **Must only be called when the local `EntropyGuard` has not flagged the
   * session as a bot.**  `IntentManager.incrementCounter()` enforces this.
   *
   * @param key  Counter key (must not be empty, ≤ MAX_STATE_LENGTH chars).
   * @param by   Amount the counter was incremented (must be finite).
   */
  broadcastCounter(key: string, by: number): void {
    if (!this.channel) return;
    const msg: CounterMessage = { type: 'counter', key, by };
    this.channel.postMessage(msg);
  }

  /**
   * Apply a validated remote transition to the local in-memory model.
   *
   * This method updates the `MarkovGraph` and `BloomFilter` **without**
   * re-broadcasting the transition, which prevents the infinite-loop amplification
   * that would occur if received transitions were forwarded back to the channel.
   *
   * This is an internal method exposed for testing; production code should rely
   * on `onmessage` calling `handleMessage` automatically.
   *
   * @param from  Validated source state label.
   * @param to    Validated destination state label.
   */
  applyRemote(from: string, to: string): void {
    this.bloom.add(from);
    this.bloom.add(to);
    this.graph.incrementTransition(from, to);
  }

  /**
   * Apply a validated remote counter increment to the local counters Map
   * **without** re-broadcasting, preventing infinite-loop amplification.
   *
   * This is an internal method exposed for testing; production code should rely
   * on `onmessage` calling `handleMessage` automatically.
   *
   * @param key  Validated counter key.
   * @param by   Validated finite increment amount.
   */
  applyRemoteCounter(key: string, by: number): void {
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + by);
  }

  /**
   * Close the underlying `BroadcastChannel` and release the message handler.
   *
   * Call this inside `IntentManager.destroy()` to prevent ghost listeners.
   * Safe to call multiple times and in non-browser environments.
   */
  close(): void {
    if (!this.channel) return;
    this.channel.onmessage = null;
    this.channel.close();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Validate and dispatch an incoming raw message from the broadcast channel.
   *
   * Security invariants:
   *   - Non-object, null, and unrecognised `type` values are silently dropped.
   *   - `TransitionMessage`: `from`/`to` must be non-empty strings ≤ `MAX_STATE_LENGTH`.
   *   - `CounterMessage`: `key` must be a non-empty string ≤ `MAX_STATE_LENGTH`;
   *     `by` must be a finite number.
   *   - No re-broadcasting occurs — remote state is applied locally only.
   */
  private handleMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const msg = data as Record<string, unknown>;
    if (msg['type'] === 'transition') {
      if (!isValidTransitionMessage(msg)) return;
      this.applyRemote(msg['from'] as string, msg['to'] as string);
    } else if (msg['type'] === 'counter') {
      if (!isValidCounterMessage(msg)) return;
      this.applyRemoteCounter(msg['key'] as string, msg['by'] as number);
    }
    // Unknown type values are silently ignored for forward-compatibility.
  }
}
