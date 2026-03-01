/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { EnginePolicy } from './engine-policy.js';
import { BroadcastSync } from '../../sync/broadcast-sync.js';
import type { BloomFilter } from '../../core/bloom.js';
import type { MarkovGraph } from '../../core/markov.js';

/**
 * Configuration for CrossTabSyncPolicy.
 */
export interface CrossTabSyncPolicyConfig {
  channelName: string;
  graph: MarkovGraph;
  bloom: BloomFilter;
  counters: Map<string, number>;
  /** Returns `true` when the EntropyGuard flags the session as a bot. */
  isSuspected: () => boolean;
}

/**
 * CrossTabSyncPolicy — broadcasts locally-verified transitions and counter
 * increments to other tabs via the BroadcastChannel API.
 *
 * Replaces the inline `if (this.broadcastSync && !this.signalEngine.suspected)`
 * conditionals that were previously in `IntentManager.runGraphAndSignalStage`
 * and `IntentManager.incrementCounter`.
 *
 * When this policy is **not** instantiated (because `crossTabSync` is
 * `false`), no broadcast logic executes at all.
 *
 * Security invariants (enforced by the underlying `BroadcastSync`):
 *   - Incoming payloads are strictly validated (non-empty, ≤ 256 chars).
 *   - Remote transitions are applied without re-broadcasting.
 *   - Only non-bot sessions broadcast (guards bot-flood amplification).
 */
export class CrossTabSyncPolicy implements EnginePolicy {
  private readonly broadcastSync: BroadcastSync;
  private readonly isSuspected: () => boolean;

  constructor(config: CrossTabSyncPolicyConfig) {
    this.broadcastSync = new BroadcastSync(
      config.channelName,
      config.graph,
      config.bloom,
      config.counters,
    );
    this.isSuspected = config.isSuspected;
  }

  /**
   * Broadcast a transition after all signal evaluation has completed.
   * Skipped when the session is suspected as a bot.
   */
  onAfterEvaluation(from: string, _to: string): void {
    // The `from` parameter name in the hook maps to the transition's source
    // state; `_to` would be the arriving state.  We broadcast the original
    // (from, to) pair.
    // Note: this guard mirrors the original IntentManager conditional exactly.
    if (!this.isSuspected()) {
      this.broadcastSync.broadcast(from, _to);
    }
  }

  /**
   * Broadcast a counter increment to other tabs.
   * Skipped when the session is suspected as a bot.
   */
  onCounterIncrement(key: string, by: number): void {
    if (!this.isSuspected()) {
      this.broadcastSync.broadcastCounter(key, by);
    }
  }

  /**
   * Close the underlying BroadcastChannel and release the message handler.
   */
  destroy(): void {
    this.broadcastSync.close();
  }
}
