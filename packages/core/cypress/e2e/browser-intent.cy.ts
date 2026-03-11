/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * E2E spec for createBrowserIntent() — Layer 3 factory.
 *
 * These tests verify that the factory correctly wires all four web plugins
 * into a live IntentEngine and that real browser events produce the expected
 * intent signals.  They complement the unit tests in microkernel.test.mjs,
 * which mock every adapter; here everything is real: actual DOM events,
 * actual localStorage, actual MouseKinematicsAdapter URL tracking.
 *
 * Sandbox: sandbox/browser-intent/index.html
 * Engine exposed at: window.__engine
 * DOM assertions target: [data-cy="event-log"] [data-event="<type>"]
 */

// Extend the Window type so TypeScript is happy accessing __engine
interface IntentEngineLike {
  track(state: string): void;
  destroy(): void;
}

declare global {
  interface Window {
    __engine: IntentEngineLike;
  }
}

describe('createBrowserIntent() — Layer 3 browser integration', () => {
  beforeEach(() => {
    cy.visit('/sandbox/browser-intent/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.removeItem('passive-intent-browser-test');
      },
    });

    // Wait until the ESM module has loaded and MouseKinematicsAdapter has
    // fired the initial state — this guarantees window.__engine is ready.
    cy.get('[data-cy="event-log"] [data-event="state_change"]').should('have.length.at.least', 1);
  });

  // =========================================================================
  // Factory wiring
  // =========================================================================

  it('emits an initial state_change via MouseKinematicsAdapter on page load', () => {
    // MouseKinematicsAdapter calls onState(window.location.pathname) on subscribe().
    // The initial pathname when visiting the sandbox is the sandbox's own path.
    cy.get('[data-cy="event-log"] [data-event="state_change"]')
      .first()
      .should('contain.text', '/sandbox/browser-intent');
  });

  // =========================================================================
  // Manual track() path
  // =========================================================================

  it('engine.track() emits a state_change for the given route', () => {
    cy.window().then((win) => {
      win.__engine.track('/products');
    });
    cy.get('[data-cy="event-log"] [data-event="state_change"]')
      .last()
      .should('contain.text', '/products');
  });

  it('engine.track() accumulates multiple state_change events', () => {
    cy.window().then((win) => {
      win.__engine.track('/search');
      win.__engine.track('/product/detail');
      win.__engine.track('/cart');
    });
    // Initial state from page load + 3 manual tracks = at least 4
    cy.get('[data-cy="event-log"] [data-event="state_change"]').should('have.length.at.least', 4);
    cy.get('[data-cy="event-log"] [data-event="state_change"]')
      .last()
      .should('contain.text', '/cart');
  });

  // =========================================================================
  // MouseKinematicsAdapter — navigation events
  // =========================================================================

  it('popstate event triggers a state_change via MouseKinematicsAdapter', () => {
    // history.pushState() does NOT fire popstate by itself; we dispatch it
    // manually so MouseKinematicsAdapter.handleNavigation() runs against the
    // updated window.location.pathname.
    cy.window().then((win) => {
      win.history.pushState({}, '', '/shop');
      win.dispatchEvent(new win.PopStateEvent('popstate'));
    });
    cy.get('[data-cy="event-log"] [data-event="state_change"]')
      .last()
      .should('contain.text', '/shop');
  });

  // =========================================================================
  // LocalStorageAdapter — persistence
  // =========================================================================

  it('persists state to localStorage after the first track()', () => {
    cy.window().then((win) => {
      win.__engine.track('/checkout');
    });
    cy.window().then((win) => {
      const stored = win.localStorage.getItem('passive-intent-browser-test');
      expect(stored).to.not.be.null;
      // Wire format: JSON with bloomBase64 + graphBinary keys
      expect(stored).to.include('bloomBase64');
      expect(stored).to.include('graphBinary');
    });
  });

  // =========================================================================
  // destroy() teardown
  // =========================================================================

  it('destroy() does not throw', () => {
    cy.window().then((win) => {
      expect(() => win.__engine.destroy()).to.not.throw();
    });
  });

  it('after destroy(), popstate events no longer add state_change entries', () => {
    cy.window().then((win) => {
      win.__engine.destroy();

      // Record the log length right after destroy.
      const countBefore = win.document.querySelectorAll('[data-event="state_change"]').length;

      // Trigger a navigation event — the unsubscribed listener must NOT fire.
      win.history.pushState({}, '', '/after-destroy');
      win.dispatchEvent(new win.PopStateEvent('popstate'));

      // dispatchEvent is synchronous so the count is stable immediately.
      const countAfter = win.document.querySelectorAll('[data-event="state_change"]').length;

      expect(countAfter).to.equal(countBefore);
    });
  });
});
