const clickRoute = (route: string) => {
  cy.contains('button', route).click();
};

describe('Privacy-First Intent Sandbox', () => {
  beforeEach(() => {
    cy.visit('sandbox/index.html', {
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
    clickRoute('/home');
    clickRoute('/help');
    clickRoute('/home');
    clickRoute('/return-policy');
    clickRoute('/home');

    cy.get('[data-cy="entropy-toast"]', { timeout: 4000 })
      .should('be.visible')
      .and('contain', 'Rage Click Detected');
  });

  it('Test C: The Hesitation Discount (Trajectory Anomaly)', () => {
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');
    clickRoute('/help');

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

    cy.wait(2000);
    cy.window().then((win) => {
      const payload = win.localStorage.getItem('ui-telepathy');
      expect(payload).to.not.equal(null);
    });
  });
});
