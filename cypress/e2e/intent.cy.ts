const clickRoute = (route: string) => {
  cy.contains('button', route).click();
};

describe('Privacy-First Intent Sandbox', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      }
    });
  });

  it('Test A: The Perfect Buyer (No anomalies)', () => {
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');
    clickRoute('/cart');
    clickRoute('/checkout');

    cy.get('[data-cy="entropy-toast"]').should('not.exist');
    cy.get('[data-cy="anomaly-toast"]').should('not.exist');
  });

  it('Test B: The Rage-Click Healer (High Entropy)', () => {
    // Create enough transitions from /home to trigger high entropy detection
    // MIN_SAMPLE_TRANSITIONS = 10, so we need at least 10 outgoing transitions from /home
    // Alternate rapidly between multiple destinations from /home to build high entropy
    clickRoute('/home');
    clickRoute('/help');
    clickRoute('/home');
    clickRoute('/return-policy');
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/home');
    clickRoute('/product');
    clickRoute('/home');
    clickRoute('/cart');
    clickRoute('/home');
    clickRoute('/checkout');
    clickRoute('/home');
    clickRoute('/help');
    clickRoute('/home');
    clickRoute('/return-policy');
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/home');
    clickRoute('/product');
    clickRoute('/home');

    cy.get('[data-cy="entropy-toast"]', { timeout: 4000 })
      .should('be.visible')
      .and('contain', 'Rage Click Detected');
  });

  it('Test C: The Hesitation Discount (Trajectory Anomaly)', () => {
    // Build up enough trajectory for anomaly detection
    // MIN_WINDOW_LENGTH = 16, so we need at least 16 transitions
    // Follow baseline pattern first, then deviate to trigger anomaly
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');
    clickRoute('/cart');
    clickRoute('/checkout');
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');
    clickRoute('/cart');
    clickRoute('/checkout');
    // Now deviate from expected pattern (hesitation)
    clickRoute('/home');
    clickRoute('/help');
    clickRoute('/home');
    clickRoute('/return-policy');
    clickRoute('/home');
    clickRoute('/help');
    clickRoute('/home');
    clickRoute('/return-policy');

    cy.get('[data-cy="anomaly-toast"]', { timeout: 4000 })
      .should('be.visible')
      .and('contain', 'Hesitation Detected');
  });

  it('Test D: Persistence Debounce', () => {
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');
    clickRoute('/help');
    clickRoute('/return-policy');

    cy.wait(600);
    cy.window().then((win) => {
      const payload = win.localStorage.getItem('ui-telepathy');
      expect(payload, 'ui-telepathy should be written to localStorage').to.be.a('string');

      const parsed = JSON.parse(payload as string);
      expect(parsed).to.have.property('bloomBase64');
      // V2 format uses graphBinary (base64-encoded binary) instead of graph (JSON)
      expect(parsed).to.have.property('graphBinary');
    });
  });
});
