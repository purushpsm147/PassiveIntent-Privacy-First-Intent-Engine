/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 * 
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

const clickRoute = (route: string) => {
  cy.contains('button', route).click();
};

// Named UUID constants used in Route Normalization tests for clarity
const SAMPLE_UUID_1 = '550e8400-e29b-41d4-a716-446655440000';
const SAMPLE_UUID_2 = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

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

      // PR 28/29: baselineStatus must be 'active' or 'drifted'
      expect(t.baselineStatus).to.be.oneOf(['active', 'drifted']);

      // PR 29: assignmentGroup must be 'treatment' or 'control'
      expect(t.assignmentGroup).to.be.oneOf(['treatment', 'control']);
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

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Counter API (PR #29)
// ─────────────────────────────────────────────────────────────────────────────
describe('Deterministic Counter API', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test K: getCounter returns 0 before any increment', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      expect(mgr.getCounter('articles_read')).to.equal(0);
    });
  });

  it('Test L: incrementCounter starts at 1 and increments by 1 each call', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      expect(mgr.incrementCounter('articles_read')).to.equal(1);
      expect(mgr.incrementCounter('articles_read')).to.equal(2);
      expect(mgr.getCounter('articles_read')).to.equal(2);
    });
  });

  it('Test M: incrementCounter with custom by parameter', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      expect(mgr.incrementCounter('cart_items', 3)).to.equal(3);
      expect(mgr.incrementCounter('cart_items', 2)).to.equal(5);
      expect(mgr.getCounter('cart_items')).to.equal(5);
    });
  });

  it('Test N: resetCounter resets the counter to 0', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      mgr.incrementCounter('views');
      mgr.incrementCounter('views');
      expect(mgr.getCounter('views')).to.equal(2);
      mgr.resetCounter('views');
      expect(mgr.getCounter('views')).to.equal(0);
    });
  });

  it('Test O: multiple independent counters do not interfere with each other', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      mgr.incrementCounter('counter_a', 5);
      mgr.incrementCounter('counter_b', 3);
      expect(mgr.getCounter('counter_a')).to.equal(5);
      expect(mgr.getCounter('counter_b')).to.equal(3);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route Normalization (PR #29)
// ─────────────────────────────────────────────────────────────────────────────
describe('Route Normalization', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test P: track() strips query strings so only the path is stored', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const states: string[] = [];
      mgr.on('state_change', ({ to }: { to: string }) => states.push(to));

      mgr.track('/search?q=shoes');

      expect(states[states.length - 1]).to.equal('/search');
      expect(mgr.hasSeen('/search')).to.be.true;
      expect(mgr.hasSeen('/search?q=shoes')).to.be.false;
    });
  });

  it('Test Q: track() strips hash fragments from the URL', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const states: string[] = [];
      mgr.on('state_change', ({ to }: { to: string }) => states.push(to));

      mgr.track('/about#team');

      expect(states[states.length - 1]).to.equal('/about');
      expect(mgr.hasSeen('/about')).to.be.true;
      expect(mgr.hasSeen('/about#team')).to.be.false;
    });
  });

  it('Test R: track() removes trailing slashes (except root /)', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      mgr.track('/checkout/');
      expect(mgr.hasSeen('/checkout')).to.be.true;
      expect(mgr.hasSeen('/checkout/')).to.be.false;
    });
  });

  it('Test S: track() replaces v4 UUID path segments with :id', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const states: string[] = [];
      mgr.on('state_change', ({ to }: { to: string }) => states.push(to));

      mgr.track(`/users/${SAMPLE_UUID_1}/profile`);

      expect(states[states.length - 1]).to.equal('/users/:id/profile');
      expect(mgr.hasSeen('/users/:id/profile')).to.be.true;
    });
  });

  it('Test T: two different UUIDs on the same route map to the same canonical state', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const states: string[] = [];
      mgr.on('state_change', ({ to }: { to: string }) => states.push(to));

      mgr.track(`/users/${SAMPLE_UUID_1}/settings`);
      mgr.track(`/users/${SAMPLE_UUID_2}/settings`);

      expect(states[0]).to.equal('/users/:id/settings');
      expect(states[1]).to.equal('/users/:id/settings');
      expect(mgr.hasSeen('/users/:id/settings')).to.be.true;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Predictive Prefetch Hints (PR #31)
// ─────────────────────────────────────────────────────────────────────────────
describe('Predictive Prefetch Hints', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test U: predictNextStates() returns an empty array before any navigation', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const hints = mgr.predictNextStates(0.1);
      expect(hints).to.deep.equal([]);
    });
  });

  it('Test V: predictNextStates() returns candidates after repeated navigation patterns', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      // Build enough transitions so /home → /search reaches the minimum sample threshold
      for (let i = 0; i < 12; i++) {
        mgr.track('/home');
        mgr.track('/search');
      }

      const hints = mgr.predictNextStates(0.1);
      const states = hints.map((h: { state: string; probability: number }) => h.state);
      expect(states).to.include('/search');
    });
  });

  it('Test W: predictNextStates() results are sorted by probability descending', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      // /home → /search more often than /home → /product
      for (let i = 0; i < 8; i++) {
        mgr.track('/home');
        mgr.track('/search');
      }
      for (let i = 0; i < 4; i++) {
        mgr.track('/home');
        mgr.track('/product');
      }

      const hints = mgr.predictNextStates(0.0);
      for (let i = 1; i < hints.length; i++) {
        expect(hints[i].probability).to.be.at.most(hints[i - 1].probability,
          'hints must be sorted by probability descending');
      }
    });
  });

  it('Test X: predictNextStates() sanitize predicate excludes filtered states', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      for (let i = 0; i < 12; i++) {
        mgr.track('/home');
        mgr.track('/search');
      }

      const hints = mgr.predictNextStates(0.1, (state: string) => state !== '/search');
      const states = hints.map((h: { state: string; probability: number }) => h.state);
      expect(states).not.to.include('/search');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Baseline Drift Protection (PR #28 / #29)
// ─────────────────────────────────────────────────────────────────────────────
describe('Baseline Drift Protection', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test Y: getTelemetry().baselineStatus is "active" for a fresh session', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      expect(mgr.getTelemetry().baselineStatus).to.equal('active');
    });
  });

  it('Test Z: baselineStatus remains "active" during normal navigation', () => {
    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');
    clickRoute('/cart');
    clickRoute('/checkout');

    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      expect(mgr.getTelemetry().baselineStatus).to.equal('active');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A/B Holdout Assignment (PR #29)
// ─────────────────────────────────────────────────────────────────────────────
describe('A/B Holdout Assignment', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test AA: getTelemetry().assignmentGroup is either "treatment" or "control"', () => {
    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      const { assignmentGroup } = mgr.getTelemetry();
      expect(assignmentGroup).to.be.oneOf(['treatment', 'control']);
    });
  });

  it('Test AB: assignmentGroup remains stable throughout a session', () => {
    let firstGroup: string;

    cy.window().then((win) => {
      firstGroup = (win as any).__intentManager.getTelemetry().assignmentGroup;
    });

    clickRoute('/home');
    clickRoute('/search');
    clickRoute('/product');

    cy.window().then((win) => {
      const currentGroup = (win as any).__intentManager.getTelemetry().assignmentGroup;
      expect(currentGroup).to.equal(firstGroup, 'assignmentGroup must not change within a session');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Tab Sync (PR #31)
// ─────────────────────────────────────────────────────────────────────────────
describe('Cross-Tab Sync (BroadcastSync)', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test AC: IntentManager with crossTabSync:true initializes and tracks correctly', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__EdgeSignalSDK;
      const mgr = new IntentManager({
        storageKey: 'cross-tab-test',
        botProtection: false,
        crossTabSync: true,
      });
      mgr.track('/home');
      mgr.track('/search');
      expect(mgr.hasSeen('/home')).to.be.true;
      expect(mgr.hasSeen('/search')).to.be.true;
      expect(mgr.getTelemetry().transitionsEvaluated).to.equal(1);
      mgr.destroy();
    });
  });

  it('Test AD: BroadcastSync.applyRemote() updates the graph and Bloom filter', () => {
    cy.window().then((win) => {
      const { BloomFilter, MarkovGraph, BroadcastSync } = (win as any).__EdgeSignalSDK;

      const bloom = new BloomFilter();
      const graph = new MarkovGraph();
      const counters = new Map<string, number>();
      const sync = new BroadcastSync('test-channel', graph, bloom, counters);

      // applyRemote must update bloom and graph without re-broadcasting
      sync.applyRemote('/home', '/search');
      expect(bloom.check('/home')).to.be.true;
      expect(bloom.check('/search')).to.be.true;

      sync.close();
    });
  });

  it('Test AE: BroadcastSync.applyRemoteCounter() updates the shared counters Map', () => {
    cy.window().then((win) => {
      const { BloomFilter, MarkovGraph, BroadcastSync } = (win as any).__EdgeSignalSDK;

      const bloom = new BloomFilter();
      const graph = new MarkovGraph();
      const counters = new Map<string, number>();
      const sync = new BroadcastSync('test-counter-direct', graph, bloom, counters);

      sync.applyRemoteCounter('articles_read', 3);
      sync.applyRemoteCounter('articles_read', 2);

      expect(counters.get('articles_read')).to.equal(5);
      expect(counters.get('videos_watched')).to.be.undefined;

      sync.close();
    });
  });

  it('Test AF: incrementCounter broadcasts counter messages when crossTabSync:true', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__EdgeSignalSDK;

      // Capture all messages on the channel IntentManager will use
      const received: any[] = [];
      const listener = new win.BroadcastChannel('edgesignal-sync:counter-broadcast-test');
      listener.onmessage = (e: MessageEvent) => received.push(e.data);
      (win as any).__testListenerAF = listener;

      const mgr = new IntentManager({
        storageKey: 'counter-broadcast-test',
        botProtection: false,
        crossTabSync: true,
      });
      (win as any).__testMgrAF = mgr;
      (win as any).__testReceivedAF = received;

      // Broadcast two increments: by=1 and by=4, total=5
      mgr.incrementCounter('articles_read');
      mgr.incrementCounter('articles_read', 4);
    });

    // Give the BroadcastChannel messages time to arrive
    cy.wait(150);

    cy.window().then((win) => {
      const received: any[] = (win as any).__testReceivedAF;
      const counterMsgs = received.filter((m: any) => m.type === 'counter' && m.key === 'articles_read');
      expect(counterMsgs).to.have.length(2, 'exactly 2 counter messages must be broadcast (one per incrementCounter call)');
      const total = counterMsgs.reduce((sum: number, m: any) => sum + m.by, 0);
      expect(total).to.equal(5, 'broadcast increments must sum to 5 (1 + 4)');

      (win as any).__testListenerAF.close();
      (win as any).__testMgrAF.destroy();
    });
  });

  it('Test AG: remote counter increment is reflected in getCounter() on the receiving tab', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__EdgeSignalSDK;

      // "Tab A" — the receiver
      const mgrA = new IntentManager({
        storageKey: 'counter-receive-test',
        botProtection: false,
        crossTabSync: true,
      });
      (win as any).__testMgrAG = mgrA;

      // "Tab B" — simulate by posting directly to the channel
      const channelName = 'edgesignal-sync:counter-receive-test';
      const sender = new win.BroadcastChannel(channelName);
      sender.postMessage({ type: 'counter', key: 'articles_read', by: 7 });
      (win as any).__testSenderAG = sender;
    });

    cy.wait(150);

    cy.window().then((win) => {
      expect((win as any).__testMgrAG.getCounter('articles_read')).to.equal(7,
        'getCounter() must reflect the remotely-broadcast increment');
      (win as any).__testSenderAG.close();
      (win as any).__testMgrAG.destroy();
    });
  });
});
