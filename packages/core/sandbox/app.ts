/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  IntentManager,
  BloomFilter,
  MarkovGraph,
  BroadcastSync,
  normalizeRouteState,
  SerializedMarkovGraph,
} from '../src/intent-sdk.js';

const baseline: SerializedMarkovGraph = {
  states: ['/home', '/search', '/product', '/cart', '/checkout'],
  rows: [
    [0, 1, [[1, 1]]],
    [1, 1, [[2, 1]]],
    [2, 1, [[3, 1]]],
    [3, 1, [[4, 1]]],
  ],
  freedIndices: [],
};

const intentManager = new IntentManager({
  storageKey: 'passive-intent',
  persistDebounceMs: 500,
  graph: {
    highEntropyThreshold: 0.8,
    divergenceThreshold: 1.0,
  },
  baseline,
  // Disable bot protection for E2E testing (Cypress behaves like a bot)
  botProtection: false,
});

const activeRoute = document.getElementById('active-route') as HTMLDivElement;
const routes = document.getElementById('routes') as HTMLDivElement;
const toastRegion = document.getElementById('toast-region') as HTMLDivElement;

const showToast = (message: string, kind: 'entropy' | 'anomaly' | 'conversion') => {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.dataset.cy = `${kind}-toast`;
  toast.setAttribute('role', kind === 'entropy' ? 'alert' : 'status');
  toast.textContent = message;
  toastRegion.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3500);
};

intentManager.on('high_entropy', () => {
  showToast('Rage Click Detected -> Show Support Chat!', 'entropy');
});

intentManager.on('trajectory_anomaly', () => {
  showToast('Hesitation Detected -> Show 10% Discount!', 'anomaly');
});

intentManager.on('conversion', ({ type }) => {
  showToast(`Conversion Tracked: ${type}`, 'conversion');
});

const convertBtn = document.getElementById('convert-btn') as HTMLButtonElement;
convertBtn?.addEventListener('click', () => {
  intentManager.trackConversion({ type: 'purchase', value: 1, currency: 'USD' });
});

routes.addEventListener('click', (event: Event) => {
  const button = (event.target as HTMLElement).closest(
    'button[data-route]',
  ) as HTMLButtonElement | null;
  if (!button) return;

  const route = button.dataset.route;
  if (!route) return;

  activeRoute.textContent = `Current Route: ${route}`;
  intentManager.track(route);
});

(
  window as typeof window & {
    __intentManager?: IntentManager;
    __PassiveIntentSDK?: {
      IntentManager: typeof IntentManager;
      BloomFilter: typeof BloomFilter;
      MarkovGraph: typeof MarkovGraph;
      BroadcastSync: typeof BroadcastSync;
      normalizeRouteState: typeof normalizeRouteState;
    };
  }
).__intentManager = intentManager;

(window as any).__PassiveIntentSDK = {
  IntentManager,
  BloomFilter,
  MarkovGraph,
  BroadcastSync,
  normalizeRouteState,
};
