import { IntentManager, SerializedMarkovGraph } from '../src/intent-sdk.js';

const baseline: SerializedMarkovGraph = {
  states: ['/home', '/search', '/product', '/cart', '/checkout'],
  rows: [
    [0, 1, [[1, 1]]],
    [1, 1, [[2, 1]]],
    [2, 1, [[3, 1]]],
    [3, 1, [[4, 1]]]
  ]
};

const intentManager = new IntentManager({
  storageKey: 'ui-telepathy',
  persistDebounceMs: 500,
  graph: {
    highEntropyThreshold: 0.8,
    divergenceThreshold: 6
  },
  baseline
});

const activeRoute = document.getElementById('active-route') as HTMLDivElement;
const routes = document.getElementById('routes') as HTMLDivElement;
const toastRegion = document.getElementById('toast-region') as HTMLDivElement;

const showToast = (message: string, kind: 'entropy' | 'anomaly') => {
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

routes.addEventListener('click', (event: Event) => {
  const button = (event.target as HTMLElement).closest('button[data-route]') as HTMLButtonElement | null;
  if (!button) return;

  const route = button.dataset.route;
  if (!route) return;

  // Only allow known routes from the baseline configuration to be displayed/tracked.
  if (!baseline.states.includes(route)) {
    // Ignore unexpected route values to avoid showing misleading content.
    return;
  }
  activeRoute.textContent = `Current Route: ${route}`;
  intentManager.track(route);
});

(window as typeof window & { __intentManager?: IntentManager }).__intentManager = intentManager;
