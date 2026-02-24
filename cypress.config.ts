/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineConfig } from 'cypress';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';

const PORT = 3000;
const ROOT = process.cwd();

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.map':  'application/json',
  '.ts':   'application/typescript',
};

let serverStarted = false;

export default defineConfig({
  e2e: {
    baseUrl: `http://localhost:${PORT}`,
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: false,
    chromeWebSecurity: false,
    setupNodeEvents(on, config) {
      if (!serverStarted) {
        const server = createServer((req, res) => {
          const url = (req.url ?? '/').split('?')[0];
          const filePath = join(ROOT, url);

          if (existsSync(filePath) && statSync(filePath).isFile()) {
            const ext = extname(filePath);
            res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
            res.end(readFileSync(filePath));
          } else {
            res.writeHead(404);
            res.end('Not Found');
          }
        });

        server.listen(PORT, () => {
          console.log(`[Cypress] Static file server running at http://localhost:${PORT}`);
        });
        serverStarted = true;
      }

      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.name === 'electron' || browser.family === 'chromium') {
          launchOptions.args.push('--no-sandbox');
          launchOptions.args.push('--disable-gpu');
          launchOptions.args.push('--disable-dev-shm-usage');
          launchOptions.args.push('--disable-software-rasterizer');
        }
        return launchOptions;
      });

      return config;
    },
  },
});
