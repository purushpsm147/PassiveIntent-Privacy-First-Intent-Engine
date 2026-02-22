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
      const payload = win.localStorage.getItem('edge-signal');
      expect(payload, 'edge-signal should be written to localStorage').to.be.a('string');

      const parsed = JSON.parse(payload as string);
      expect(parsed).to.have.property('bloomBase64');
      // V2 format uses graphBinary (base64-encoded binary) instead of graph (JSON)
      expect(parsed).to.have.property('graphBinary');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry & Conversion Tracking API
// ─────────────────────────────────────────────────────────────────────────────
describe('Telemetry & Conversion Tracking API', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test E: getTelemetry() returns a GDPR-compliant snapshot with correct shape', () => {
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');

    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const t = mgr.getTelemetry();

      // sessionId: must be a non-empty string and must NOT look like a user identifier
      expect(t.sessionId).to.be.a('string').and.have.length.greaterThan(0);
      expect(t.sessionId).not.to.include('@');
      expect(t.sessionId).not.to.match(/^\d+$/, 'sessionId must not be a plain number');

      // /home→/search and /search→/product = 2 evaluated transitions
      expect(t.transitionsEvaluated).to.equal(2);

      // Sandbox uses botProtection:false, so botStatus must always be human
      expect(t.botStatus).to.equal('human');

      // anomaliesFired: non-negative integer
      expect(t.anomaliesFired).to.be.a('number').and.least(0);

      // Engine is not under storage pressure at this point
      expect(t.engineHealth).to.equal('healthy');
    });
  });

  it('Test F: trackConversion() emits a conversion event with the correct payload', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const received: any[] = [];
      mgr.on('conversion', (p: any) => received.push(p));

      mgr.trackConversion({ type: 'purchase', value: 49.99, currency: 'USD' });

      expect(received).to.have.length(1);
      expect(received[0]).to.deep.equal({ type: 'purchase', value: 49.99, currency: 'USD' });
    });
  });

  it('Test G: clicking the Track Conversion button shows a conversion toast', () => {
    clickRoute('/home');
    clickRoute('/search');

    cy.get('[data-cy="convert-btn"]').click();

    cy.get('[data-cy="conversion-toast"]', { timeout: 4000 })
      .should('be.visible')
      .and('contain', 'Conversion Tracked: purchase');
  });

  it('Test H: sessionId is stable within a session and changes across page reloads', () => {
    let firstId: string;

    cy.window().then((win) => {
      firstId = (win as any).__intentManager.getTelemetry().sessionId;
      expect(firstId).to.be.a('string').with.length.greaterThan(0);
    });

    // Navigate some routes — sessionId must not change within the same lifecycle
    clickRoute('/home');
    clickRoute('/search');

    cy.window().then((win) => {
      const currentId = (win as any).__intentManager.getTelemetry().sessionId;
      expect(currentId).to.equal(firstId, 'sessionId must stay the same throughout a single page lifecycle');
    });

    // Reload the page — a new IntentManager is constructed, so sessionId must differ
    cy.reload();

    cy.window().then((win) => {
      const reloadedId = (win as any).__intentManager.getTelemetry().sessionId;
      expect(reloadedId).to.be.a('string').with.length.greaterThan(0);
      expect(reloadedId).not.to.equal(firstId, 'sessionId must change after a page reload');
    });
  });

  it('Test I: transitionsEvaluated increments with each navigation step', () => {
    cy.window().then((win) => {
      expect((win as any).__intentManager.getTelemetry().transitionsEvaluated).to.equal(0);
    });

    clickRoute('/home');
    cy.window().then((win) => {
      // First track: no prior state, so transitionsEvaluated still 0
      expect((win as any).__intentManager.getTelemetry().transitionsEvaluated).to.equal(0);
    });

    clickRoute('/search');
    cy.window().then((win) => {
      expect((win as any).__intentManager.getTelemetry().transitionsEvaluated).to.equal(1);
    });

    clickRoute('/product');
    cy.window().then((win) => {
      expect((win as any).__intentManager.getTelemetry().transitionsEvaluated).to.equal(2);
    });
  });

  it('Test J: trackConversion() does not affect transitionsEvaluated or anomaliesFired', () => {
    clickRoute('/home');
    clickRoute('/search');

    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const before = mgr.getTelemetry();

      mgr.trackConversion({ type: 'test-event' });
      mgr.trackConversion({ type: 'test-event-2' });

      const after = mgr.getTelemetry();
      expect(after.transitionsEvaluated).to.equal(before.transitionsEvaluated,
        'trackConversion() must not increment transitionsEvaluated');
      expect(after.anomaliesFired).to.equal(before.anomaliesFired,
        'trackConversion() must not increment anomaliesFired');
    });
  });
});
