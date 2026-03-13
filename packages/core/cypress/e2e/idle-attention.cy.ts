/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * E2E tests for:
 * 1. Idle-State Detector  (user_idle / user_resumed events)
 * 2. Comparison Shopper   (attention_return event)
 *
 * Both features live inside the LifecycleCoordinator and rely on the
 * LifecycleAdapter for pause/resume and interaction tracking.  E2E tests
 * use a fake lifecycle adapter with controllable time so we can simulate
 * inactivity thresholds without real wall-clock waits.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Comparison Shopper — attention_return
// ─────────────────────────────────────────────────────────────────────────────
describe('Comparison Shopper — attention_return', () => {
  beforeEach(() => {
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test AL: attention_return fires when tab is hidden ≥ 15 seconds and user was on a state', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      // Controllable clock
      let mockTime = 1000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      // Fake lifecycle adapter with controllable pause / resume
      let pauseCb: (() => void) | null = null;
      let resumeCb: (() => void) | null = null;
      const fakeAdapter = {
        onPause: (cb: () => void) => {
          pauseCb = cb;
          return () => {
            pauseCb = null;
          };
        },
        onResume: (cb: () => void) => {
          resumeCb = cb;
          return () => {
            resumeCb = null;
          };
        },
        destroy: () => {},
      };

      const attentionEvents: any[] = [];
      const mgr = new IntentManager({
        storageKey: 'e2e-attention-return-test',
        botProtection: false,
        lifecycleAdapter: fakeAdapter,
        dwellTime: { enabled: true },
      });
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));

      // Navigate so there is a current state
      mgr.track('/product/42');

      // Simulate tab hide for 20 seconds (above the 15 s threshold)
      pauseCb?.();
      mockTime += 20_000;
      resumeCb?.();

      expect(attentionEvents).to.have.length(1, 'exactly one attention_return must fire');
      expect(attentionEvents[0].state).to.equal(
        '/product/42',
        'state must be the normalized route the user was viewing (plain numeric IDs are not replaced)',
      );
      expect(attentionEvents[0].hiddenDuration).to.be.at.least(
        15_000,
        'hiddenDuration must be at least 15 s',
      );

      mgr.destroy();

      // Restore clock
      win.performance.now = originalNow;
    });
  });

  it('Test AM: attention_return does NOT fire when tab is hidden < 15 seconds', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 1000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      let pauseCb: (() => void) | null = null;
      let resumeCb: (() => void) | null = null;
      const fakeAdapter = {
        onPause: (cb: () => void) => {
          pauseCb = cb;
          return () => {
            pauseCb = null;
          };
        },
        onResume: (cb: () => void) => {
          resumeCb = cb;
          return () => {
            resumeCb = null;
          };
        },
        destroy: () => {},
      };

      const attentionEvents: any[] = [];
      const mgr = new IntentManager({
        storageKey: 'e2e-attention-under-threshold',
        botProtection: false,
        lifecycleAdapter: fakeAdapter,
        dwellTime: { enabled: true },
      });
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));

      mgr.track('/pricing');

      // Hide for only 10 seconds (below threshold)
      pauseCb?.();
      mockTime += 10_000;
      resumeCb?.();

      expect(attentionEvents).to.have.length(
        0,
        'attention_return must NOT fire when hidden < 15 s',
      );

      mgr.destroy();
      win.performance.now = originalNow;
    });
  });

  it('Test AN: attention_return does NOT fire when no state has been tracked', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 1000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      let pauseCb: (() => void) | null = null;
      let resumeCb: (() => void) | null = null;
      const fakeAdapter = {
        onPause: (cb: () => void) => {
          pauseCb = cb;
          return () => {
            pauseCb = null;
          };
        },
        onResume: (cb: () => void) => {
          resumeCb = cb;
          return () => {
            resumeCb = null;
          };
        },
        destroy: () => {},
      };

      const attentionEvents: any[] = [];
      const mgr = new IntentManager({
        storageKey: 'e2e-attention-no-state',
        botProtection: false,
        lifecycleAdapter: fakeAdapter,
        dwellTime: { enabled: true },
      });
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));

      // Don't track any state — no previousState

      // Hide for 30 seconds
      pauseCb?.();
      mockTime += 30_000;
      resumeCb?.();

      expect(attentionEvents).to.have.length(
        0,
        'attention_return must NOT fire without a tracked state',
      );

      mgr.destroy();
      win.performance.now = originalNow;
    });
  });

  it('Test AO: multiple attention_return events can fire across separate hide/show cycles', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 1000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      let pauseCb: (() => void) | null = null;
      let resumeCb: (() => void) | null = null;
      const fakeAdapter = {
        onPause: (cb: () => void) => {
          pauseCb = cb;
          return () => {
            pauseCb = null;
          };
        },
        onResume: (cb: () => void) => {
          resumeCb = cb;
          return () => {
            resumeCb = null;
          };
        },
        destroy: () => {},
      };

      const attentionEvents: any[] = [];
      const mgr = new IntentManager({
        storageKey: 'e2e-attention-multiple',
        botProtection: false,
        lifecycleAdapter: fakeAdapter,
        dwellTime: { enabled: true },
      });
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));

      mgr.track('/checkout');

      // First hide/show: 20 seconds
      pauseCb?.();
      mockTime += 20_000;
      resumeCb?.();

      // Second hide/show: 60 seconds
      pauseCb?.();
      mockTime += 60_000;
      resumeCb?.();

      expect(attentionEvents).to.have.length(2, 'two attention_return events must fire');
      expect(attentionEvents[0].hiddenDuration).to.be.at.least(20_000);
      expect(attentionEvents[1].hiddenDuration).to.be.at.least(60_000);

      mgr.destroy();
      win.performance.now = originalNow;
    });
  });

  it('Test AP: attention_return fires independently of session_stale for very long hides', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 1000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      let pauseCb: (() => void) | null = null;
      let resumeCb: (() => void) | null = null;
      const fakeAdapter = {
        onPause: (cb: () => void) => {
          pauseCb = cb;
          return () => {
            pauseCb = null;
          };
        },
        onResume: (cb: () => void) => {
          resumeCb = cb;
          return () => {
            resumeCb = null;
          };
        },
        destroy: () => {},
      };

      const attentionEvents: any[] = [];
      const staleEvents: any[] = [];
      const mgr = new IntentManager({
        storageKey: 'e2e-attention-and-stale',
        botProtection: false,
        lifecycleAdapter: fakeAdapter,
        dwellTime: { enabled: true },
      });
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));
      mgr.on('session_stale', (e: any) => staleEvents.push(e));

      mgr.track('/billing');

      // Simulate 2-hour OS sleep (exceeds both thresholds)
      pauseCb?.();
      mockTime += 7_200_000;
      resumeCb?.();

      // Both events should fire — they are independent
      expect(attentionEvents).to.have.length(
        1,
        'attention_return must fire even for very long hides',
      );
      expect(staleEvents).to.have.length(1, 'session_stale must also fire for > 30 min hides');
      expect(staleEvents[0].reason).to.equal('hidden_duration_exceeded');

      mgr.destroy();
      win.performance.now = originalNow;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idle-State Detector — user_idle / user_resumed
// ─────────────────────────────────────────────────────────────────────────────
describe('Idle-State Detector — user_idle / user_resumed', () => {
  beforeEach(() => {
    // Install Cypress's fake clock BEFORE the page loads so that every
    // window.setTimeout call made by IntentManager / LifecycleCoordinator is
    // stubbed.  Tests can then drive time with cy.tick() instead of real waits.
    cy.clock();
    cy.visit('/sandbox/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  /**
   * Helper: build a fake lifecycle adapter that supports onInteraction
   * with a controllable clock.
   *
   * Returns an object with:
   *   - adapter: the fake LifecycleAdapter
   *   - simulateInteraction: triggers the interaction callback
   *   - pauseCb / resumeCb: getters to invoke pause / resume
   */
  function createFakeIdleAdapter(win: Window) {
    let pauseCb: (() => void) | null = null;
    let resumeCb: (() => void) | null = null;
    let interactionCb: (() => void) | null = null;

    const adapter = {
      onPause: (cb: () => void) => {
        pauseCb = cb;
        return () => {
          pauseCb = null;
        };
      },
      onResume: (cb: () => void) => {
        resumeCb = cb;
        return () => {
          resumeCb = null;
        };
      },
      onInteraction: (cb: () => void) => {
        interactionCb = cb;
        return () => {
          interactionCb = null;
        };
      },
      destroy: () => {
        pauseCb = null;
        resumeCb = null;
        interactionCb = null;
      },
    };

    return {
      adapter,
      simulateInteraction: () => interactionCb?.(),
      getPauseCb: () => pauseCb,
      getResumeCb: () => resumeCb,
    };
  }

  it('Test AQ: user_idle fires after 2 minutes of inactivity', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 5000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      // Use real setTimeout to allow the idle check timer to fire
      const idleEvents: any[] = [];

      const { adapter, simulateInteraction } = createFakeIdleAdapter(win);

      const mgr = new IntentManager({
        storageKey: 'e2e-idle-fires',
        botProtection: false,
        lifecycleAdapter: adapter,
        dwellTime: { enabled: true },
      });
      mgr.on('user_idle', (e: any) => idleEvents.push(e));

      // Track a state so hasPreviousState() returns true
      mgr.track('/dashboard');

      // Simulate an initial interaction
      simulateInteraction();

      (win as any).__testIdleEventsAQ = idleEvents;
      (win as any).__testMgrAQ = mgr;
      (win as any).__testMockTimeSetterAQ = (t: number) => {
        mockTime = t;
      };
      (win as any).__testOriginalNowAQ = originalNow;
    });

    // Advance mock time past the 2-minute idle threshold.
    cy.window().then((win) => {
      (win as any).__testMockTimeSetterAQ(5000 + 125_000); // 2 min + 5 s buffer
    });

    // Tick the stubbed clock by the full debounce window so the one-shot
    // USER_IDLE_THRESHOLD_MS timer fires (debounce replaced the 5 s poll).
    cy.tick(120_001);

    cy.window().then((win) => {
      const idleEvents: any[] = (win as any).__testIdleEventsAQ;
      expect(idleEvents.length).to.be.at.least(1, 'at least one user_idle must fire');
      expect(idleEvents[0].state).to.equal('/dashboard');
      expect(idleEvents[0].idleMs).to.be.a('number');

      (win as any).__testMgrAQ.destroy();
      win.performance.now = (win as any).__testOriginalNowAQ;
    });
  });

  it('Test AR: user_idle does NOT fire when user keeps interacting', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 5000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const idleEvents: any[] = [];
      const { adapter, simulateInteraction } = createFakeIdleAdapter(win);

      const mgr = new IntentManager({
        storageKey: 'e2e-idle-no-fire',
        botProtection: false,
        lifecycleAdapter: adapter,
        dwellTime: { enabled: true },
      });
      mgr.on('user_idle', (e: any) => idleEvents.push(e));

      mgr.track('/settings');

      // Keep interacting every 30 seconds
      for (let i = 0; i < 8; i++) {
        mockTime += 30_000;
        simulateInteraction();
      }

      (win as any).__testIdleEventsAR = idleEvents;
      (win as any).__testMgrAR = mgr;
      (win as any).__testOriginalNowAR = originalNow;
    });

    // Tick less than the debounce window — the last armIdleTimer() call reset
    // the one-shot to 120 s, so 6 s is not enough to fire it.
    cy.tick(6000);

    cy.window().then((win) => {
      const idleEvents: any[] = (win as any).__testIdleEventsAR;
      expect(idleEvents).to.have.length(
        0,
        'user_idle must NOT fire when user is actively interacting',
      );

      (win as any).__testMgrAR.destroy();
      win.performance.now = (win as any).__testOriginalNowAR;
    });
  });

  it('Test AS: user_resumed fires on first interaction after idle', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 5000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const idleEvents: any[] = [];
      const resumedEvents: any[] = [];
      const { adapter, simulateInteraction } = createFakeIdleAdapter(win);

      const mgr = new IntentManager({
        storageKey: 'e2e-idle-resumed',
        botProtection: false,
        lifecycleAdapter: adapter,
        dwellTime: { enabled: true },
      });
      mgr.on('user_idle', (e: any) => idleEvents.push(e));
      mgr.on('user_resumed', (e: any) => resumedEvents.push(e));

      mgr.track('/help');

      // Simulate interaction
      simulateInteraction();

      (win as any).__testIdleEventsAS = idleEvents;
      (win as any).__testResumedEventsAS = resumedEvents;
      (win as any).__testMgrAS = mgr;
      (win as any).__testSimulateInteractionAS = simulateInteraction;
      (win as any).__testMockTimeSetterAS = (t: number) => {
        mockTime = t;
      };
      (win as any).__testOriginalNowAS = originalNow;
    });

    // Advance past idle threshold
    cy.window().then((win) => {
      (win as any).__testMockTimeSetterAS(5000 + 130_000); // > 2 min
    });

    // Tick the full debounce window to fire the one-shot idle timer.
    cy.tick(120_001);

    // User interacts — should trigger user_resumed
    cy.window().then((win) => {
      (win as any).__testMockTimeSetterAS(5000 + 180_000); // 3 min mark
      (win as any).__testSimulateInteractionAS();
    });

    cy.window().then((win) => {
      const resumedEvents: any[] = (win as any).__testResumedEventsAS;
      expect(resumedEvents.length).to.be.at.least(1, 'at least one user_resumed must fire');
      expect(resumedEvents[0].state).to.equal('/help');
      expect(resumedEvents[0].idleMs).to.be.a('number').and.be.greaterThan(0);

      (win as any).__testMgrAS.destroy();
      win.performance.now = (win as any).__testOriginalNowAS;
    });
  });

  it('Test AT: user_idle does NOT fire when no state has been tracked', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 5000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const idleEvents: any[] = [];
      const { adapter } = createFakeIdleAdapter(win);

      const mgr = new IntentManager({
        storageKey: 'e2e-idle-no-state',
        botProtection: false,
        lifecycleAdapter: adapter,
        dwellTime: { enabled: true },
      });
      mgr.on('user_idle', (e: any) => idleEvents.push(e));

      // Do NOT track any state — hasPreviousState() returns false

      (win as any).__testIdleEventsAT = idleEvents;
      (win as any).__testMgrAT = mgr;
      (win as any).__testMockTimeSetterAT = (t: number) => {
        mockTime = t;
      };
      (win as any).__testOriginalNowAT = originalNow;
    });

    // Advance far past threshold
    cy.window().then((win) => {
      (win as any).__testMockTimeSetterAT(5000 + 300_000); // 5 minutes
    });

    // Tick the full debounce window so the one-shot timer fires — the guard
    // inside the callback (hasPreviousState() === false) must suppress emission.
    cy.tick(120_001);

    cy.window().then((win) => {
      const idleEvents: any[] = (win as any).__testIdleEventsAT;
      expect(idleEvents).to.have.length(
        0,
        'user_idle must NOT fire without a tracked state (hasPreviousState is false)',
      );

      (win as any).__testMgrAT.destroy();
      win.performance.now = (win as any).__testOriginalNowAT;
    });
  });

  it('Test AU: destroy() cleans up idle timers — no events fire after destruction', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 5000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const idleEvents: any[] = [];
      const { adapter } = createFakeIdleAdapter(win);

      const mgr = new IntentManager({
        storageKey: 'e2e-idle-destroy-cleanup',
        botProtection: false,
        lifecycleAdapter: adapter,
        dwellTime: { enabled: true },
      });
      mgr.on('user_idle', (e: any) => idleEvents.push(e));

      mgr.track('/account');

      // Destroy immediately
      mgr.destroy();

      // Advance past threshold
      mockTime += 200_000;

      (win as any).__testIdleEventsAU = idleEvents;
      (win as any).__testOriginalNowAU = originalNow;
    });

    // Tick past the full debounce window to prove destroy() cleared the
    // one-shot timer — no idle events must fire even after 120 s.
    cy.tick(120_001);

    cy.window().then((win) => {
      const idleEvents: any[] = (win as any).__testIdleEventsAU;
      expect(idleEvents).to.have.length(0, 'no idle events must fire after destroy()');

      win.performance.now = (win as any).__testOriginalNowAU;
    });
  });

  it('Test AV: attention_return and user_idle are independent features that can both fire', () => {
    cy.window().then((win) => {
      const { IntentManager } = (win as any).__PassiveIntentSDK;

      let mockTime = 5000;
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const attentionEvents: any[] = [];
      const idleEvents: any[] = [];

      let pauseCb: (() => void) | null = null;
      let resumeCb: (() => void) | null = null;
      let interactionCb: (() => void) | null = null;

      const fakeAdapter = {
        onPause: (cb: () => void) => {
          pauseCb = cb;
          return () => {
            pauseCb = null;
          };
        },
        onResume: (cb: () => void) => {
          resumeCb = cb;
          return () => {
            resumeCb = null;
          };
        },
        onInteraction: (cb: () => void) => {
          interactionCb = cb;
          return () => {
            interactionCb = null;
          };
        },
        destroy: () => {},
      };

      const mgr = new IntentManager({
        storageKey: 'e2e-both-features',
        botProtection: false,
        lifecycleAdapter: fakeAdapter,
        dwellTime: { enabled: true },
      });
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));
      mgr.on('user_idle', (e: any) => idleEvents.push(e));

      mgr.track('/pricing');

      // First: tab hidden for 30 s → attention_return
      pauseCb?.();
      mockTime += 30_000;
      resumeCb?.();

      expect(attentionEvents).to.have.length(1, 'attention_return must fire after 30 s hide');

      (win as any).__testIdleEventsAV = idleEvents;
      (win as any).__testAttentionEventsAV = attentionEvents;
      (win as any).__testMgrAV = mgr;
      (win as any).__testMockTimeSetterAV = (t: number) => {
        mockTime = t;
      };
      (win as any).__testOriginalNowAV = originalNow;
    });

    // Now advance mock time past idle threshold
    cy.window().then((win) => {
      (win as any).__testMockTimeSetterAV(5000 + 30_000 + 130_000); // past 2 min idle
    });

    // Tick the full debounce window to fire the one-shot idle timer.
    cy.tick(120_001);

    cy.window().then((win) => {
      const idleEvents: any[] = (win as any).__testIdleEventsAV;
      const attentionEvents: any[] = (win as any).__testAttentionEventsAV;

      expect(attentionEvents).to.have.length(1, 'attention_return count unchanged');
      expect(idleEvents.length).to.be.at.least(
        1,
        'user_idle must also fire independently of attention_return',
      );

      (win as any).__testMgrAV.destroy();
      win.performance.now = (win as any).__testOriginalNowAV;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Amazon Clone — Idle & Attention Return Integration
// ─────────────────────────────────────────────────────────────────────────────
describe('Amazon Clone — Idle & Attention Return Integration', () => {
  beforeEach(() => {
    cy.visit('/sandbox/amazon/index.html', {
      onBeforeLoad: (win) => {
        win.localStorage.clear();
      },
    });
  });

  it('Test AW: attention_return fires on real BrowserLifecycleAdapter via visibilitychange', () => {
    // Navigate to a product page first
    cy.get('[data-cy="product-card-1"]').click();
    cy.get('[data-cy="view-product"]').should('be.visible');

    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;

      // Override the clock to simulate a 20-second gap
      let mockTime = win.performance.now();
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const attentionEvents: any[] = [];
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));

      (win as any).__testAttentionEventsAW = attentionEvents;
      (win as any).__testOriginalNowAW = originalNow;
      (win as any).__testMockTimeSetterAW = (t: number) => {
        mockTime = t;
      };
      (win as any).__testMockTimeAW = mockTime;
    });

    // Simulate tab hidden
    cy.document().then((doc) => {
      Object.defineProperty(doc, 'hidden', { value: true, writable: true, configurable: true });
      doc.dispatchEvent(new Event('visibilitychange'));
    });

    // Advance clock by 25 seconds
    cy.window().then((win) => {
      (win as any).__testMockTimeSetterAW((win as any).__testMockTimeAW + 25_000);
    });

    // Simulate tab visible
    cy.document().then((doc) => {
      Object.defineProperty(doc, 'hidden', { value: false, writable: true, configurable: true });
      doc.dispatchEvent(new Event('visibilitychange'));
    });

    cy.window().then((win) => {
      const attentionEvents: any[] = (win as any).__testAttentionEventsAW;
      expect(attentionEvents).to.have.length(
        1,
        'attention_return must fire when user returns to the Amazon demo after ≥15 s',
      );
      expect(attentionEvents[0].state).to.equal('/product');
      expect(attentionEvents[0].hiddenDuration).to.be.at.least(15_000);

      win.performance.now = (win as any).__testOriginalNowAW;
    });
  });

  it('Test AX: the Intent Manager remains functional after attention_return fires', () => {
    cy.get('[data-cy="search-btn"]').click();
    cy.get('[data-cy="view-search"]').should('be.visible');

    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;

      let mockTime = win.performance.now();
      const originalNow = win.performance.now.bind(win.performance);
      win.performance.now = () => mockTime;

      const attentionEvents: any[] = [];
      mgr.on('attention_return', (e: any) => attentionEvents.push(e));

      // Simulate 20 s hide/show
      (win as any).__testOriginalNowAX = originalNow;
      (win as any).__testAttentionEventsAX = attentionEvents;

      // Trigger pause — must use win.document (the app iframe), not the Cypress runner's document
      Object.defineProperty(win.document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });
      win.document.dispatchEvent(new Event('visibilitychange'));

      mockTime += 20_000;

      Object.defineProperty(win.document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });
      win.document.dispatchEvent(new Event('visibilitychange'));

      win.performance.now = originalNow;
    });

    // Continue navigating — manager should still work
    cy.get('[data-cy="search-result-1"]').click();
    cy.get('[data-cy="view-product"]').should('be.visible');

    cy.get('[data-cy="btn-add-cart"]').click();
    cy.get('[data-cy="cart-add-toast"]').should('be.visible');
    cy.get('[data-cy="cart-count"]').should('contain', '1');

    cy.window().then((win) => {
      const mgr = (win as any).__intentManager;
      expect(mgr.hasSeen('/search')).to.be.true;
      expect(mgr.hasSeen('/product')).to.be.true;

      const attentionEvents: any[] = (win as any).__testAttentionEventsAX;
      expect(attentionEvents).to.have.length(1);
    });
  });
});
