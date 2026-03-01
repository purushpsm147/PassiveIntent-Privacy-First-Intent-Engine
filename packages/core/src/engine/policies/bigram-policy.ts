/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { EnginePolicy } from './engine-policy.js';
import type { MarkovGraph } from '../../core/markov.js';

/**
 * BigramPolicy — records second-order (bigram) Markov transitions.
 *
 * Replaces the inline `if (this.enableBigrams && trajectory.length >= 3)`
 * conditional that was previously in `SignalEngine.recordTransition`.
 * When this policy is **not** instantiated (because `enableBigrams` is
 * `false`), no bigram accounting executes at all.
 *
 * Bigram states are encoded as `"prev→from"` → `"from→to"` using U+2192
 * as a collision-resistant separator that will not appear in normal URL-based
 * state labels.
 *
 * The frequency-threshold guard prevents sparse bigram pollution during the
 * early learning phase: bigrams are only recorded when the *unigram* source
 * state (`from`) has accumulated at least `bigramFrequencyThreshold`
 * outgoing transitions.
 */
export class BigramPolicy implements EnginePolicy {
  private readonly graph: MarkovGraph;
  private readonly bigramFrequencyThreshold: number;

  constructor(graph: MarkovGraph, bigramFrequencyThreshold: number) {
    this.graph = graph;
    this.bigramFrequencyThreshold = bigramFrequencyThreshold;
  }

  onTransition(from: string, to: string, trajectory: readonly string[]): void {
    if (trajectory.length < 3) return;

    const prev2 = trajectory[trajectory.length - 3];
    const bigramFrom = `${prev2}\u2192${from}`;
    const bigramTo = `${from}\u2192${to}`;

    // Only record when the unigram source has enough outgoing transitions.
    if (this.graph.rowTotal(from) >= this.bigramFrequencyThreshold) {
      this.graph.incrementTransition(bigramFrom, bigramTo);
    }
  }
}
