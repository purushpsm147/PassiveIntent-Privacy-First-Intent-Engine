/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BloomFilter, MarkovGraph } from '../dist/src/intent-sdk.js';

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('property: BloomFilter has no false negatives for inserted items across random datasets', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const rand = makeRng(seed);
    const bloom = new BloomFilter({ bitSize: 4096, hashCount: 4 });
    const inserted = [];

    for (let i = 0; i < 200; i += 1) {
      const v = `s-${seed}-${Math.floor(rand() * 1_000_000)}-${i}`;
      inserted.push(v);
      bloom.add(v);
    }

    for (const value of inserted) {
      assert.equal(bloom.check(value), true, `False negative detected for seed=${seed}`);
    }
  }
});

test('property: outgoing Markov probabilities sum to ~1 for random transition counts', () => {
  for (let seed = 11; seed <= 20; seed += 1) {
    const rand = makeRng(seed);
    const graph = new MarkovGraph();

    const from = 'FROM';
    const targets = ['A', 'B', 'C', 'D', 'E'];

    for (let i = 0; i < 500; i += 1) {
      const t = targets[Math.floor(rand() * targets.length)];
      graph.incrementTransition(from, t);
    }

    let sum = 0;
    for (const t of targets) {
      sum += graph.getProbability(from, t);
    }

    assert.ok(Math.abs(sum - 1) < 1e-12, `Probabilities must sum to 1, got ${sum}`);
  }
});

test('property: MarkovGraph binary round-trip preserves probabilities for random graphs', () => {
  for (let seed = 21; seed <= 28; seed += 1) {
    const rand = makeRng(seed);
    const states = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const graph = new MarkovGraph({ maxStates: 1000 });

    for (let i = 0; i < 800; i += 1) {
      const from = states[Math.floor(rand() * states.length)];
      const to = states[Math.floor(rand() * states.length)];
      graph.incrementTransition(from, to);
    }

    const restored = MarkovGraph.fromBinary(graph.toBinary(), { maxStates: 1000 });

    for (const from of states) {
      for (const to of states) {
        assert.equal(
          restored.getProbability(from, to),
          graph.getProbability(from, to),
          `Probability mismatch at seed=${seed} edge=${from}->${to}`,
        );
      }
    }
  }
});
