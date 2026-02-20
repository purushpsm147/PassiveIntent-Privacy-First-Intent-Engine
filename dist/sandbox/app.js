import { IntentManager } from '../src/intent-sdk.js';
const baseline = {
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
const activeRoute = document.getElementById('active-route');
const routes = document.getElementById('routes');
const toastRegion = document.getElementById('toast-region');
const showToast = (message, kind) => {
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.dataset.cy = `${kind}-toast`;
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
routes.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-route]');
    if (!button)
        return;
    const route = button.dataset.route;
    if (!route)
        return;
    activeRoute.textContent = `Current Route: ${route}`;
    intentManager.track(route);
});
window.__intentManager = intentManager;
