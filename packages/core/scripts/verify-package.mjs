/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'edge-signal-pack-'));

let tarballPath = '';
try {
  const tarballName = execSync('npm pack --silent', { encoding: 'utf-8' }).trim();
  tarballPath = join(process.cwd(), tarballName);
  const consumerDir = join(tempRoot, 'consumer');

  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'consumer-smoke', version: '1.0.0', type: 'module' }, null, 2),
  );

  execSync(`npm install --silent "${tarballPath}"`, { cwd: consumerDir, stdio: 'inherit' });

  const smoke = `
import { IntentManager, MarkovGraph, BloomFilter } from '@edgesignal/core';
const g = new MarkovGraph();
g.incrementTransition('home', 'search');
const b = new BloomFilter();
b.add('home');
const m = new IntentManager({ storageKey: 'smoke-test', botProtection: false });
m.track('home');
m.track('search');
if (!b.check('home') || g.getProbability('home', 'search') <= 0) {
  throw new Error('Package smoke validation failed');
}
console.log('package smoke test passed');
`;

  // Write smoke test to file instead of using stdin (Node 24+ doesn't support --input-type with stdin)
  const smokeFilePath = join(consumerDir, 'smoke-test.mjs');
  writeFileSync(smokeFilePath, smoke);
  execSync(`node ${smokeFilePath}`, {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  console.log('verify-package: success');
} finally {
  try {
    if (tarballPath) unlinkSync(tarballPath);
  } catch {
    // ignore cleanup errors
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
