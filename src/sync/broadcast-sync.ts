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
 * Wire format of a cross-tab sync message.
 *
 * Only complete, fully-validated objects matching this interface are acted on.
 * Any extra fields are ignored (structural subtyping is safe here because we
 * never serialize unknown fields back out).
 */
interface SyncMessage {
  /** Discriminant — allows future protocol versioning without breaking older tabs. */
  type: 'transition';
  /** The state the user navigated *from*. */
  from: string;
  /** The state the user navigated *to*. */
  to: string;
}

/**
 * Type-guard that validates an unknown value against `SyncMessage`.
 *
 * Rejects the payload if:
 *   - `type` is not `'transition'`
 *   - `from` or `to` are not strings
 *   - either state label exceeds `MAX_STATE_LENGTH` (memory-exhaustion guard)
 *
 * The length check is the primary XSS-amplification / model-poisoning defense:
 * a crafted tab cannot inject an unbounded key into every other tab's Markov
 * graph by sending a 1 MB state label.
 */
function isValidSyncMessage(data: unknown): data is SyncMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg['type'] !== 'transition') return false;
  if (typeof msg['from'] !== 'string' || typeof msg['to'] !== 'string') return false;
  if (msg['from'].length === 0 || msg['to'].length === 0) return false;
  if (msg['from'].length > MAX_STATE_LENGTH || msg['to'].length > MAX_STATE_LENGTH) return false;
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
 * 2. **XSS / model-poisoning hardening** — every incoming message is
 *    validated by `isValidSyncMessage` before touching any data structure:
 *    `from` and `to` must be non-empty strings ≤ `MAX_STATE_LENGTH` (256 chars).
 *    Oversized or malformed payloads are silently dropped.
 *
 * 3. **Infinite-loop prevention** — remote transitions applied via
 *    `applyRemote()` update the in-memory graph and Bloom filter directly
 *    **without** re-broadcasting to the channel.  Only locally-originated
 *    transitions (those that passed the local `EntropyGuard`) are ever sent.
 *
 * 4. **Bot flood containment** — `IntentManager` only calls `broadcast()`
 *    when the local `EntropyGuard` has *not* flagged the session as a bot,
 *    so a local script that spams `track()` cannot amplify noise into other tabs.
 *
 * **SSR / non-browser safety** — `BroadcastSync` checks for `BroadcastChannel`
 * availability at construction time.  When it is absent (Node.js, older
 * browsers) the instance is created but all methods become no-ops; `isActive`
 * returns `false` so callers can inspect the state.
 *
 * @example
 * ```ts
 * const sync = new BroadcastSync('edgesignal-sync', graph, bloom);
 * // Called by IntentManager after a verified local transition:
 * sync.broadcast('/home', '/products');
 * // Clean up on destroy:
 * sync.close();
 * ```
 */
export class BroadcastSync {
  private readonly channel: BroadcastChannel | null;
  private readonly graph: MarkovGraph;
  private readonly bloom: BloomFilter;

  /**
   * `true` when a real `BroadcastChannel` was opened successfully.
   * `false` in SSR / environments without the API.
   */
  readonly isActive: boolean;

  constructor(
    channelName: string,
    graph: MarkovGraph,
    bloom: BloomFilter,
  ) {
    this.graph = graph;
    this.bloom = bloom;

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
    const msg: SyncMessage = { type: 'transition', from, to };
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
   * Validate and apply an incoming raw message from the broadcast channel.
   *
   * Security invariants enforced here:
   *   1. `isValidSyncMessage` rejects non-object, wrong-type, non-string, empty,
   *      or oversized payloads — protecting against heap amplification.
   *   2. After validation, `applyRemote` is called (not `broadcast`) — the
   *      transition is applied locally only, never echoed back to the channel.
   */
  private handleMessage(data: unknown): void {
    if (!isValidSyncMessage(data)) return;
    this.applyRemote(data.from, data.to);
  }
}
