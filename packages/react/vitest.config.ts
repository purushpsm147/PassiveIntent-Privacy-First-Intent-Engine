/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Map the workspace dependency to its TypeScript source so tests work
     * without requiring a prior `npm run build` in @passiveintent/core.
     * The import is fully mocked in tests anyway; the alias exists so that
     * TypeScript (via esbuild) can resolve the module types.
     */
    alias: {
      '@passiveintent/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    /**
     * jsdom provides the browser-like globals (window, localStorage, etc.)
     * required by IntentManager's BrowserStorageAdapter and BrowserTimerAdapter.
     * It is also required by @testing-library/react's act() and renderHook().
     */
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    /**
     * Ensure each test file gets a fresh module registry. This matters for
     * the SSR test that stubs `window` and re-imports the hook to re-evaluate
     * the IS_BROWSER constant.
     */
    isolate: true,
  },
});
