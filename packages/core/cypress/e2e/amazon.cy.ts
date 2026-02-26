/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Amazon Clone E2E Tests
 *
 * These tests verify the PassiveIntent SDK functionality
 * in a realistic e-commerce shopping context.
 */

describe('Amazon Clone - Intent Engine Integration', () => {
  beforeEach(() => {
    cy.visit('/sandbox/amazon/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  describe('Navigation & View Rendering', () => {
    it('should render the home view on initial load', () => {
      cy.get('[data-cy="view-home"]').should('be.visible');
      cy.get('[data-cy="debug-route"]').should('contain', '/home');
    });

    it('should navigate to search view when search button is clicked', () => {
      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');
      cy.get('[data-cy="debug-route"]').should('contain', '/search');
    });

    it('should navigate to product detail when product card is clicked', () => {
      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');
      cy.get('[data-cy="debug-route"]').should('contain', '/product');
    });

    it('should navigate to cart view when cart icon is clicked', () => {
      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');
      cy.get('[data-cy="debug-route"]').should('contain', '/cart');
    });

    it('should navigate to help view via customer service link', () => {
      cy.get('[data-cy="nav-customer-service"]').click();
      cy.get('[data-cy="view-help"]').should('be.visible');
    });
  });

  describe('Perfect Buyer Journey (No Anomalies)', () => {
    it('should complete a full purchase without triggering any anomaly toasts', () => {
      // Home -> Search
      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');

      // Search -> Product
      cy.get('[data-cy="search-result-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      // Add to cart
      cy.get('[data-cy="btn-add-cart"]').click();
      cy.get('[data-cy="cart-add-toast"]').should('be.visible');
      cy.get('[data-cy="cart-count"]').should('contain', '1');

      // Go to cart
      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');

      // Proceed to checkout
      cy.get('[data-cy="btn-proceed-checkout"]').click();
      cy.get('[data-cy="view-checkout"]').should('be.visible');

      // Place order
      cy.get('[data-cy="btn-place-order"]').click();
      cy.get('[data-cy="view-order-confirmation"]').should('be.visible');

      // No anomaly toasts should appear
      cy.get('[data-cy="entropy-toast"]').should('not.exist');
      cy.get('[data-cy="anomaly-toast"]').should('not.exist');
    });
  });

  describe('Rage Click Detection (High Entropy)', () => {
    it('should track rapid navigation transitions without triggering a false-positive entropy toast', () => {
      // A simple back-and-forth pattern between two states has low entropy (predictable),
      // so the engine should NOT fire high_entropy even after many transitions.
      cy.get('[data-cy="view-home"]').should('be.visible');

      // Extended rapid navigation back and forth (simulating confusion/frustration)
      for (let i = 0; i < 3; i++) {
        cy.get('[data-cy="nav-customer-service"]').click();
        cy.get('[data-cy="logo"]').click();
        cy.get('[data-cy="footer-help"]').click();
        cy.get('[data-cy="logo"]').click();
      }

      // Verify all transitions are being counted
      cy.get('[data-cy="debug-transitions"]')
        .invoke('text')
        .then((text) => {
          expect(parseInt(text)).to.be.greaterThan(12);
        });

      // A predictable back-and-forth pattern must not trigger a false-positive entropy alert
      cy.get('[data-cy="entropy-toast"]').should('not.exist');
    });

    it('should navigate between categories without errors', () => {
      // This test verifies the navigation works correctly even with rapid transitions
      cy.get('[data-cy="category-gaming"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');

      cy.get('[data-cy="logo"]').click();
      cy.get('[data-cy="view-home"]').should('be.visible');

      cy.get('[data-cy="category-deals"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');

      cy.get('[data-cy="logo"]').click();
      cy.get('[data-cy="category-toys"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');

      // Verify debug panel shows transitions
      cy.get('[data-cy="debug-transitions"]')
        .invoke('text')
        .then((text) => {
          expect(parseInt(text)).to.be.greaterThan(4);
        });
    });

    it('should fire the entropy toast when a user scatters navigation across many destinations from home', () => {
      // High entropy requires a SINGLE state to fan out to MANY different destinations.
      // Cycling home → [search, cart, help, product] × 3 produces 12 outgoing transitions
      // from /home across 4 unique destinations → normalized entropy ≈ 1.0, well above
      // the 0.75 threshold.  This is the positive-case complement of the false-positive test.
      cy.get('[data-cy="view-home"]').should('be.visible');

      for (let i = 0; i < 3; i++) {
        cy.get('[data-cy="search-btn"]').click();
        cy.get('[data-cy="logo"]').click();

        cy.get('[data-cy="nav-cart"]').click();
        cy.get('[data-cy="logo"]').click();

        cy.get('[data-cy="nav-customer-service"]').click();
        cy.get('[data-cy="logo"]').click();

        cy.get('[data-cy="product-card-1"]').click();
        cy.get('[data-cy="logo"]').click();
      }

      // The entropy toast must appear — the engine detected genuinely unpredictable navigation.
      cy.get('[data-cy="entropy-toast"]').should('be.visible');
    });
  });

  describe('Hesitation Detection (Trajectory Anomaly)', () => {
    it('should detect hesitation when user repeatedly goes back and forth during shopping', () => {
      // Start normal shopping flow
      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      cy.get('[data-cy="btn-add-cart"]').click();
      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');

      // Hesitate - go back to product multiple times
      cy.get('[data-cy="cart-item-1"] .cart-item-title').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');

      // Go to help from navbar
      cy.get('[data-cy="nav-customer-service"]').click();
      cy.get('[data-cy="view-help"]').should('be.visible');

      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');

      // More hesitation
      cy.get('[data-cy="nav-customer-service"]').click();
      cy.get('[data-cy="view-help"]').should('be.visible');

      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');

      // Even more hesitation to trigger the anomaly
      for (let i = 0; i < 10; i++) {
        cy.get('[data-cy="nav-customer-service"]').click();
        cy.get('[data-cy="view-help"]').should('be.visible');

        cy.get('[data-cy="nav-cart"]').click();
        cy.get('[data-cy="view-cart"]').should('be.visible');
      }

      // Check for anomaly toast or confirm transitions tracked
      cy.get('[data-cy="debug-transitions"]')
        .invoke('text')
        .then((text) => {
          expect(parseInt(text)).to.be.greaterThan(7);
        });

      // Verify that the anomaly toast appears
      cy.get('[data-cy="anomaly-toast"]').should('be.visible');
    });

    it('should track product browsing behavior correctly', () => {
      // Browse product, leave, come back (indecision pattern)
      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      cy.get('[data-cy="logo"]').click();
      cy.get('[data-cy="view-home"]').should('be.visible');

      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');

      cy.get('[data-cy="search-result-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      cy.get('[data-cy="nav-customer-service"]').click();
      cy.get('[data-cy="view-help"]').should('be.visible');

      // Verify states are being tracked
      cy.get('[data-cy="debug-states"]')
        .invoke('text')
        .then((text) => {
          expect(parseInt(text)).to.be.greaterThan(2);
        });
    });
  });

  describe('Cart Functionality', () => {
    it('should increment cart count when adding items', () => {
      cy.get('[data-cy="cart-count"]').should('contain', '0');

      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="btn-add-cart"]').click();
      cy.get('[data-cy="cart-count"]').should('contain', '1');

      cy.get('[data-cy="btn-add-cart"]').click();
      cy.get('[data-cy="cart-count"]').should('contain', '2');
    });

    it('should show add to cart toast confirmation', () => {
      cy.get('[data-cy="product-card-2"]').click();
      cy.get('[data-cy="btn-add-cart"]').click();

      cy.get('[data-cy="cart-add-toast"]').should('be.visible').and('contain', 'Added to cart');
    });
  });

  describe('Persistence & State Management', () => {
    it('should persist navigation state to localStorage', () => {
      // Perform some navigation
      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="search-result-1"]').click();
      cy.get('[data-cy="btn-add-cart"]').click();
      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="btn-proceed-checkout"]').click();

      // Wait for debounced persistence
      cy.wait(700);

      // Verify localStorage was written
      cy.window().then((win) => {
        const payload = win.localStorage.getItem('amazon-intent-demo');
        expect(payload).to.be.a('string');

        const parsed = JSON.parse(payload as string);
        expect(parsed).to.have.property('bloomBase64');
        // The engine uses graphBinary for compact storage
        expect(parsed).to.have.property('graphBinary');
      });
    });

    it('should track correct number of transitions in debug panel', () => {
      cy.get('[data-cy="debug-transitions"]').should('contain', '1'); // Initial /home

      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="debug-transitions"]').should('contain', '2');

      cy.get('[data-cy="search-result-1"]').click();
      cy.get('[data-cy="debug-transitions"]').should('contain', '3');

      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="debug-transitions"]').should('contain', '4');
    });

    it('should track unique states visited', () => {
      cy.get('[data-cy="debug-states"]').should('contain', '1'); // /home

      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="debug-states"]').should('contain', '2'); // + /search

      cy.get('[data-cy="search-result-1"]').click();
      cy.get('[data-cy="debug-states"]').should('contain', '3'); // + /product

      // Revisiting doesn't increase count
      cy.get('[data-cy="logo"]').click();
      cy.get('[data-cy="debug-states"]').should('contain', '3');
    });

    it('should restore Bloom filter and graph state from localStorage after a page reload', () => {
      // Navigate through several states to build a known history in the engine.
      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');

      cy.get('[data-cy="search-result-1"]').click();
      cy.get('[data-cy="view-product"]').should('be.visible');

      cy.get('[data-cy="nav-cart"]').click();
      cy.get('[data-cy="view-cart"]').should('be.visible');

      // Wait for the debounced persistence flush.
      cy.wait(700);

      // Sanity-check: Bloom filter knows about visited states before reload.
      cy.window().then((win) => {
        const mgr = (win as any).__intentManager;
        expect(mgr.hasSeen('/search')).to.be.true;
        expect(mgr.hasSeen('/product')).to.be.true;
        // A state never visited must not be in the filter.
        expect(mgr.hasSeen('/never-visited-state')).to.be.false;
      });

      // Reload WITHOUT clearing localStorage — simulates a returning visitor.
      // This exercises the restore() → fromBinary() deserialization code path.
      cy.reload();

      // After reload the engine must have reconstructed its Bloom filter from the
      // binary snapshot so previously-seen states are still recognised.
      cy.window().then((win) => {
        const mgr = (win as any).__intentManager;
        expect(mgr.hasSeen('/search')).to.be.true;
        expect(mgr.hasSeen('/product')).to.be.true;
        expect(mgr.hasSeen('/never-visited-state')).to.be.false;
      });

      // The app must remain fully functional after restoration.
      cy.get('[data-cy="view-home"]').should('be.visible');
      cy.get('[data-cy="search-btn"]').click();
      cy.get('[data-cy="view-search"]').should('be.visible');
    });
  });

  describe('UI Elements & Interactions', () => {
    it('should have all major UI components visible on home page', () => {
      cy.get('.header').should('be.visible');
      cy.get('.header-logo').should('be.visible');
      cy.get('.header-search').should('be.visible');
      cy.get('.header-cart').should('be.visible');
      cy.get('.sub-nav').should('be.visible');
      cy.get('.hero-banner').should('be.visible');
      cy.get('.product-grid').should('be.visible');
      cy.get('.footer').should('be.visible');
    });

    it('should display product details correctly', () => {
      cy.get('[data-cy="product-card-1"]').click();

      cy.get('[data-cy="product-title"]').should('be.visible');
      cy.get('[data-cy="btn-add-cart"]').should('be.visible');
      cy.get('[data-cy="btn-buy-now"]').should('be.visible');
      cy.get('[data-cy="product-qty"]').should('be.visible');
    });

    it('should display checkout form correctly', () => {
      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="btn-buy-now"]').click();

      cy.get('[data-cy="checkout-name"]').should('be.visible');
      cy.get('[data-cy="checkout-address"]').should('be.visible');
      cy.get('[data-cy="checkout-city"]').should('be.visible');
      cy.get('[data-cy="checkout-state"]').should('be.visible');
      cy.get('[data-cy="checkout-zip"]').should('be.visible');
      cy.get('[data-cy="checkout-card"]').should('be.visible');
      cy.get('[data-cy="btn-place-order"]').should('be.visible');
    });

    it('should allow filling checkout form fields', () => {
      cy.get('[data-cy="product-card-1"]').click();
      cy.get('[data-cy="btn-buy-now"]').click();

      cy.get('[data-cy="checkout-name"]').type('John Doe');
      cy.get('[data-cy="checkout-address"]').type('123 Main St');
      cy.get('[data-cy="checkout-city"]').type('New York');
      cy.get('[data-cy="checkout-state"]').select('New York');
      cy.get('[data-cy="checkout-zip"]').type('10001');
      cy.get('[data-cy="checkout-card"]').type('4111111111111111');
      cy.get('[data-cy="checkout-expiry"]').type('12/28');
      cy.get('[data-cy="checkout-cvv"]').type('123');

      // All fields should have values
      cy.get('[data-cy="checkout-name"]').should('have.value', 'John Doe');
      cy.get('[data-cy="checkout-zip"]').should('have.value', '10001');
    });
  });

  describe('Footer Navigation', () => {
    it('should navigate to home when clicking back to top', () => {
      cy.get('[data-cy="nav-customer-service"]').click();
      cy.get('[data-cy="view-help"]').should('be.visible');

      cy.get('[data-cy="footer-back-top"]').click();
      cy.get('[data-cy="view-home"]').should('be.visible');
    });

    it('should navigate to help from footer link', () => {
      cy.get('[data-cy="footer-help"]').click();
      cy.get('[data-cy="view-help"]').should('be.visible');
    });
  });

  describe('Search Functionality', () => {
    it('should navigate to search when pressing Enter in search input', () => {
      cy.get('[data-cy="search-input"]').type('headphones{enter}');
      cy.get('[data-cy="view-search"]').should('be.visible');
    });

    it('should display search results with proper elements', () => {
      cy.get('[data-cy="search-btn"]').click();

      cy.get('.search-results-header').should('be.visible');
      cy.get('.search-result-item').should('have.length.at.least', 4);
      cy.get('.search-result-title').first().should('be.visible');
      cy.get('.search-result-price').first().should('be.visible');
      cy.get('.search-result-rating').first().should('be.visible');
    });
  });

  describe('Help Center', () => {
    it('should display help topics correctly', () => {
      cy.get('[data-cy="nav-customer-service"]').click();

      cy.get('[data-cy="help-orders"]').should('be.visible');
      cy.get('[data-cy="help-returns"]').should('be.visible');
      cy.get('[data-cy="help-shipping"]').should('be.visible');
      cy.get('[data-cy="help-payments"]').should('be.visible');
      cy.get('[data-cy="help-account"]').should('be.visible');
      cy.get('[data-cy="help-contact"]').should('be.visible');
    });

    it('should have a working help search input', () => {
      cy.get('[data-cy="nav-customer-service"]').click();
      cy.get('[data-cy="help-search-input"]').type('return policy');
      cy.get('[data-cy="help-search-input"]').should('have.value', 'return policy');
    });
  });

  describe('Intent Manager Window Access', () => {
    it('should expose __intentManager on window for debugging', () => {
      cy.window().then((win) => {
        expect((win as any).__intentManager).to.exist;
        expect((win as any).__intentManager.track).to.be.a('function');
      });
    });

    it('should expose __navigate function for programmatic navigation', () => {
      cy.window().then((win) => {
        expect((win as any).__navigate).to.be.a('function');

        // Test programmatic navigation
        (win as any).__navigate('/checkout');
      });

      cy.get('[data-cy="view-checkout"]').should('be.visible');
    });
  });
});
