/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Amazon Clone - Intent Engine Integration
 *
 * This demo showcases the PassiveIntent SDK in an
 * e-commerce context, tracking user journeys through a realistic
 * shopping flow to detect:
 * - Rage clicks (high entropy)
 * - Hesitation patterns (trajectory anomalies)
 */

import { IntentManager, SerializedMarkovGraph } from '../../src/intent-sdk.js';

// ============================================
// BASELINE GRAPH
// ============================================
// Represents the "ideal" shopping funnel that most users follow
const baseline: SerializedMarkovGraph = {
  states: ['/home', '/search', '/product', '/cart', '/checkout', '/order-confirmation'],
  rows: [
    [
      0,
      5,
      [
        [1, 3],
        [2, 2],
      ],
    ], // /home -> /search (60%), /product (40%)
    [
      1,
      5,
      [
        [2, 4],
        [0, 1],
      ],
    ], // /search -> /product (80%), /home (20%)
    [
      2,
      10,
      [
        [3, 7],
        [1, 2],
        [0, 1],
      ],
    ], // /product -> /cart (70%), /search (20%), /home (10%)
    [
      3,
      5,
      [
        [4, 4],
        [2, 1],
      ],
    ], // /cart -> /checkout (80%), /product (20%)
    [4, 5, [[5, 5]]], // /checkout -> /order-confirmation (100%)
  ],
  freedIndices: [],
};

// ============================================
// INTENT MANAGER SETUP
// ============================================
const intentManager = new IntentManager({
  storageKey: 'amazon-intent-demo',
  persistDebounceMs: 500,
  graph: {
    highEntropyThreshold: 0.75,
    divergenceThreshold: 0.8,
  },
  baseline,
  // Disable bot protection for E2E testing (Cypress behaves like a bot)
  botProtection: false,
});

// ============================================
// DOM REFERENCES
// ============================================
const toastRegion = document.getElementById('toast-region') as HTMLDivElement;
const debugRoute = document.querySelector('[data-cy="debug-route"]') as HTMLSpanElement;
const debugTransitions = document.querySelector('[data-cy="debug-transitions"]') as HTMLSpanElement;
const debugStates = document.querySelector('[data-cy="debug-states"]') as HTMLSpanElement;
const cartCount = document.querySelector('[data-cy="cart-count"]') as HTMLSpanElement;

// State
let currentView = 'home';
let transitionCount = 0;
let cartItems = 0;
const visitedStates = new Set<string>();

// ============================================
// VIEW MANAGEMENT
// ============================================
function showView(viewId: string): void {
  // Hide all views
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.remove('active');
  });

  // Show target view
  const targetView = document.getElementById(`view-${viewId}`);
  if (targetView) {
    targetView.classList.add('active');
    currentView = viewId;
  }
}

function parseRoute(route: string): string {
  // Extract base view from route
  const cleanRoute = route.startsWith('/') ? route.slice(1) : route;

  // Map routes to views
  const routeMap: Record<string, string> = {
    home: 'home',
    search: 'search',
    product: 'product',
    cart: 'cart',
    checkout: 'checkout',
    'order-confirmation': 'order-confirmation',
    help: 'help',
    'customer-service': 'help',
    returns: 'help',
    deals: 'search',
    categories: 'home',
    account: 'home',
    orders: 'cart',
  };

  // Handle parameterized routes
  if (cleanRoute.startsWith('product/')) return 'product';
  if (cleanRoute.startsWith('category/')) return 'search';
  if (cleanRoute.startsWith('help/')) return 'help';

  return routeMap[cleanRoute] || 'home';
}

function normalizeRoute(route: string): string {
  // Normalize routes for tracking (strip IDs)
  if (route.startsWith('/product/')) return '/product';
  if (route.startsWith('/category/')) return '/category';
  if (route.startsWith('/help/')) return '/help';
  return route;
}

// ============================================
// NAVIGATION HANDLER
// ============================================
function navigate(route: string): void {
  const viewId = parseRoute(route);
  const normalizedRoute = normalizeRoute(route);

  // Update view
  showView(viewId);

  // Track with intent engine
  intentManager.track(normalizedRoute);

  // Update debug panel
  transitionCount++;
  visitedStates.add(normalizedRoute);

  if (debugRoute) debugRoute.textContent = normalizedRoute;
  if (debugTransitions) debugTransitions.textContent = String(transitionCount);
  if (debugStates) debugStates.textContent = String(visitedStates.size);

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message: string, kind: 'entropy' | 'anomaly'): void {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.dataset.cy = `${kind}-toast`;
  toast.setAttribute('role', kind === 'entropy' ? 'alert' : 'status');
  toast.textContent = message;
  toastRegion.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 4000);
}

// ============================================
// CART ACTIONS
// ============================================
function addToCart(): void {
  cartItems++;
  if (cartCount) cartCount.textContent = String(cartItems);

  // Show confirmation toast
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.background = '#067D62';
  toast.textContent = '✓ Added to cart';
  toast.dataset.cy = 'cart-add-toast';
  toastRegion.appendChild(toast);

  window.setTimeout(() => toast.remove(), 2500);
}

function deleteCartItem(): void {
  cartItems = Math.max(0, cartItems - 1);
  if (cartCount) cartCount.textContent = String(cartItems);
}

// ============================================
// EVENT LISTENERS
// ============================================

// Intent Engine Events
intentManager.on('high_entropy', (payload) => {
  showToast(`🆘 Struggling to find what you need? Chat with us!`, 'entropy');
  console.log('[Intent Engine] High entropy detected:', payload);
});

intentManager.on('trajectory_anomaly', (payload) => {
  showToast(`💡 Still deciding? Here's 10% off your order!`, 'anomaly');
  console.log('[Intent Engine] Trajectory anomaly detected:', payload);
});

intentManager.on('state_change', (payload) => {
  console.log('[Intent Engine] State change:', payload);
});

// Global click handler for navigation
document.addEventListener('click', (event: MouseEvent) => {
  const target = event.target as HTMLElement;

  // Handle route navigation
  const routeElement = target.closest('[data-route]') as HTMLElement | null;
  if (routeElement) {
    event.preventDefault();
    const route = routeElement.dataset.route;
    if (route) {
      navigate(route);
    }
    return;
  }

  // Handle actions
  const actionElement = target.closest('[data-action]') as HTMLElement | null;
  if (actionElement) {
    const action = actionElement.dataset.action;
    switch (action) {
      case 'add-to-cart':
        addToCart();
        break;
      case 'delete-item':
        deleteCartItem();
        break;
    }
  }
});

// Search form handler
const searchInput = document.querySelector('.header-search-input') as HTMLInputElement;
const searchBtn = document.querySelector('.header-search-btn') as HTMLButtonElement;

searchInput?.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    navigate('/search');
  }
});

// ============================================
// INITIALIZATION
// ============================================
navigate('/home');

// Expose for testing and debugging
(
  window as typeof window & {
    __intentManager?: IntentManager;
    __navigate?: (route: string) => void;
    __getCartCount?: () => number;
  }
).__intentManager = intentManager;

(window as typeof window & { __navigate?: (route: string) => void }).__navigate = navigate;
(window as typeof window & { __getCartCount?: () => number }).__getCartCount = () => cartItems;

console.log('[Amazon Clone] Intent Engine initialized. Happy shopping! 🛒');
