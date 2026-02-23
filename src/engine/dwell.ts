/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

export interface DwellStats {
  count: number;
  meanMs: number;
  m2: number;
}

export function updateDwellStats(current: DwellStats | undefined, dwellMs: number): DwellStats {
  const stats = current ?? { count: 0, meanMs: 0, m2: 0 };
  stats.count += 1;
  const delta = dwellMs - stats.meanMs;
  stats.meanMs += delta / stats.count;
  const delta2 = dwellMs - stats.meanMs;
  stats.m2 += delta * delta2;
  return stats;
}

export function dwellStd(stats: DwellStats): number {
  if (stats.count < 2) return 0;
  return Math.sqrt(stats.m2 / stats.count);
}
