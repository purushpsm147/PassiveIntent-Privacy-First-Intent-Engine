/**
 * PassiveIntent Interactive Demo — main.ts
 * Covers every major feature, API, and recipe.
 */

import {
  IntentManager,
  BloomFilter,
  MarkovGraph,
  MemoryStorageAdapter,
  computeBloomConfig,
} from '@passiveintent/core';
import type {
  LifecycleAdapter,
  TimerAdapter,
  IntentEventName,
  SerializedMarkovGraph,
} from '@passiveintent/core';

// ─── Controllable Lifecycle Adapter ──────────────────────────────────────────
/**
 * A fully-controllable lifecycle adapter that lets the demo
 * manually trigger pause / resume / interaction / exit-intent events.
 * Also wires up the *real* browser Page Visibility API so organic events
 * (switching tabs, moving the mouse out of the viewport) also work.
 */
class ControllableLifecycleAdapter implements LifecycleAdapter {
  private pauseCbs: Array<() => void> = [];
  private resumeCbs: Array<() => void> = [];
  private interactionCbs: Array<() => void> = [];
  private exitIntentCbs: Array<() => void> = [];

  private visibilityHandler = () => {
    if (document.hidden) this.triggerPause();
    else this.triggerResume();
  };
  private exitHandler = (e: MouseEvent) => {
    if (e.clientY <= 0) this.triggerExitIntent();
  };

  constructor() {
    document.addEventListener('visibilitychange', this.visibilityHandler);
    document.documentElement.addEventListener('mouseleave', this.exitHandler as EventListener);
  }

  triggerPause() {
    this.pauseCbs.forEach((cb) => cb());
  }
  triggerResume() {
    this.resumeCbs.forEach((cb) => cb());
  }
  triggerInteraction() {
    this.interactionCbs.forEach((cb) => cb());
  }
  triggerExitIntent() {
    this.exitIntentCbs.forEach((cb) => cb());
  }

  onPause(cb: () => void) {
    this.pauseCbs.push(cb);
    return () => {
      const i = this.pauseCbs.indexOf(cb);
      if (i >= 0) this.pauseCbs.splice(i, 1);
    };
  }
  onResume(cb: () => void) {
    this.resumeCbs.push(cb);
    return () => {
      const i = this.resumeCbs.indexOf(cb);
      if (i >= 0) this.resumeCbs.splice(i, 1);
    };
  }
  onInteraction(cb: () => void) {
    this.interactionCbs.push(cb);
    return () => {
      const i = this.interactionCbs.indexOf(cb);
      if (i >= 0) this.interactionCbs.splice(i, 1);
    };
  }
  onExitIntent(cb: () => void) {
    this.exitIntentCbs.push(cb);
    return () => {
      const i = this.exitIntentCbs.indexOf(cb);
      if (i >= 0) this.exitIntentCbs.splice(i, 1);
    };
  }
  destroy() {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    document.documentElement.removeEventListener('mouseleave', this.exitHandler as EventListener);
    this.pauseCbs = [];
    this.resumeCbs = [];
    this.interactionCbs = [];
    this.exitIntentCbs = [];
  }
}

// ─── Controllable Timer Adapter ───────────────────────────────────────────────
class ControllableTimerAdapter implements TimerAdapter {
  private offset = 0;
  private nextId = 1;
  private pending = new Map<
    number,
    { fn: () => void; firesAt: number; realId: ReturnType<typeof globalThis.setTimeout> }
  >();

  setTimeout(fn: () => void, delay: number): number {
    const id = this.nextId++;
    const firesAt = this.now() + delay;
    const realId = globalThis.setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      fn();
    }, delay);
    this.pending.set(id, { fn, firesAt, realId });
    return id;
  }
  clearTimeout(id: number): void {
    const entry = this.pending.get(id);
    if (entry) {
      globalThis.clearTimeout(entry.realId);
      this.pending.delete(id);
    }
  }
  now(): number {
    return performance.now() + this.offset;
  }
  fastForward(ms: number): void {
    this.offset += ms;
    this.flushPending();
  }
  /** Undo accumulated offset after a simulation so normal interactions are unshifted. */
  resetOffset(): void {
    const oldNow = this.now();
    this.offset = 0;
    const newNow = this.now();
    for (const [id, entry] of this.pending) {
      globalThis.clearTimeout(entry.realId);
      const remaining = Math.max(0, entry.firesAt - oldNow);
      const newFiresAt = newNow + remaining;
      const realId = globalThis.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        entry.fn();
      }, remaining);
      this.pending.set(id, { fn: entry.fn, firesAt: newFiresAt, realId });
    }
  }
  reset(): void {
    for (const entry of this.pending.values()) globalThis.clearTimeout(entry.realId);
    this.pending.clear();
    this.offset = 0;
  }

  private flushPending(): void {
    let iterations = 0;
    const MAX_FLUSH = 500;
    while (iterations++ < MAX_FLUSH) {
      const now = this.now();
      let earliest: {
        id: number;
        entry: {
          fn: () => void;
          firesAt: number;
          realId: ReturnType<typeof globalThis.setTimeout>;
        };
      } | null = null;
      for (const [id, entry] of this.pending) {
        if (entry.firesAt <= now && (!earliest || entry.firesAt < earliest.entry.firesAt)) {
          earliest = { id, entry };
        }
      }
      if (!earliest) break;
      globalThis.clearTimeout(earliest.entry.realId);
      this.pending.delete(earliest.id);
      earliest.entry.fn();
    }
  }
}

// ─── Helper: extract outgoing transitions from SerializedMarkovGraph rows ─────
function getNodeTransitions(graph: SerializedMarkovGraph, state: string): Record<string, number> {
  const idx = graph.states.indexOf(state);
  if (idx === -1) return {};
  const row = graph.rows.find((r) => r[0] === idx);
  if (!row) return {};
  const result: Record<string, number> = {};
  for (const [toIdx, count] of row[2]) {
    const s = graph.states[toIdx];
    if (s) result[s] = count;
  }
  return result;
}

// ─── Shared IntentManager instance ───────────────────────────────────────────
const lifecycle = new ControllableLifecycleAdapter();
const timer = new ControllableTimerAdapter();

/** Pre-built e-commerce funnel baseline for trajectory-anomaly demos */
const ECOMMERCE_BASELINE = buildEcommerceBaseline();

const intent = new IntentManager({
  storageKey: 'pi-demo',
  storage: new MemoryStorageAdapter(), // no localStorage pollution
  timer,
  lifecycleAdapter: lifecycle,
  botProtection: true,
  crossTabSync: false,
  enableBigrams: true,
  persistThrottleMs: 200,
  baseline: ECOMMERCE_BASELINE,
  baselineMeanLL: -1.4,
  baselineStdLL: 0.35,
  graph: {
    highEntropyThreshold: 0.72,
    divergenceThreshold: 2.5,
    maxStates: 500,
    smoothingAlpha: 0.1,
    smoothingEpsilon: 0.01,
  },
  dwellTime: { enabled: true, minSamples: 3, zScoreThreshold: 2.0 },
  onError: (err) =>
    logEvent('error', '⚠ onError', { message: err.message, code: (err as { code?: string }).code }),
});

// ─── Global event subscriptions ───────────────────────────────────────────────
const ALL_EVENTS: IntentEventName[] = [
  'state_change',
  'high_entropy',
  'trajectory_anomaly',
  'dwell_time_anomaly',
  'bot_detected',
  'hesitation_detected',
  'session_stale',
  'attention_return',
  'user_idle',
  'user_resumed',
  'exit_intent',
  'conversion',
];
for (const ev of ALL_EVENTS) {
  intent.on(ev, (payload) => logEvent(ev, ev.replace(/_/g, ' '), payload));
}

// ─── Event log ────────────────────────────────────────────────────────────────
const logEl = document.getElementById('log-entries')!;

function logEvent(eventName: string, label: string, data?: unknown): void {
  const empty = logEl.querySelector('.log-empty');
  if (empty) empty.remove();

  const cssClass = `log-${eventName.replace(/_/g, '-')}`;
  const entry = document.createElement('div');
  entry.className = `log-entry ${cssClass} log-default`;
  entry.innerHTML = `
    <span class="evt-time">${new Date().toLocaleTimeString()}</span>
    <span class="evt-name">${label}</span>
    <span class="evt-data">${JSON.stringify(data, null, 2)}</span>
  `;
  logEl.prepend(entry);
  // Keep log bounded
  while (logEl.children.length > 80) logEl.removeChild(logEl.lastChild!);
}

document.getElementById('clear-log')!.addEventListener('click', () => {
  logEl.innerHTML = '<div class="log-empty">Log cleared.</div>';
});

document.getElementById('btn-reset-session')!.addEventListener('click', () => {
  intent.destroy();
  window.location.reload();
});

// ─── Demo registry ────────────────────────────────────────────────────────────
interface Demo {
  title: string;
  render(): string;
  setup(el: HTMLElement): (() => void) | void;
}

const demos: Record<string, Demo> = {
  // ── 1. Overview ─────────────────────────────────────────────────────────────
  overview: {
    title: '📊 Overview & Telemetry',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Overview &amp; Live Telemetry</h2>
        <p class="demo-description">
          The engine is already running. <strong>Track a few states</strong> using the chips below to populate the telemetry,
          then call <code>getTelemetry()</code> to snapshot GDPR-safe aggregate data. No raw behavioral data is exposed.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Quick Track</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Click any route to track it:</p>
        <div class="chip-row">
          ${[
            '/home',
            '/products',
            '/product/widget-pro',
            '/pricing',
            '/checkout/step-1',
            '/checkout/payment',
            '/thank-you',
            '/blog',
            '/about',
            '/docs',
          ]
            .map((s) => `<span class="state-chip" data-track="${s}">${s}</span>`)
            .join('')}
        </div>
      </div>

      <div class="metrics-grid" id="telemetry-grid">
        <div class="metric-card"><div class="metric-value" id="m-transitions">0</div><div class="metric-label">Transitions Evaluated</div></div>
        <div class="metric-card"><div class="metric-value" id="m-anomalies">0</div><div class="metric-label">Anomalies Fired</div></div>
        <div class="metric-card"><div class="metric-value" id="m-states">0</div><div class="metric-label">Live Markov States</div></div>
        <div class="metric-card"><div class="metric-value" id="m-bot"><span class="status-dot status-green"></span>clean</div><div class="metric-label">Bot Status</div></div>
        <div class="metric-card"><div class="metric-value" id="m-health">100%</div><div class="metric-label">Engine Health</div></div>
        <div class="metric-card"><div class="metric-value" id="m-group">—</div><div class="metric-label">Assignment Group</div></div>
      </div>

      <div style="margin-top:16px">
        <button class="btn btn-secondary" id="btn-telemetry">Refresh Telemetry</button>
        <button class="btn btn-secondary" style="margin-left:8px" id="btn-export-graph">Export Graph JSON</button>
      </div>

      <div id="telemetry-output" style="margin-top:14px"></div>

      <div class="divider"></div>
      ${codeBlock(
        'getTelemetry() — zero-PII snapshot',
        `<span class="kw">const</span> telemetry = intent.<span class="fn">getTelemetry</span>();
<span class="cmt">// Returns: { sessionId, transitionsEvaluated, botStatus,</span>
<span class="cmt">//           anomaliesFired, engineHealth, baselineStatus, assignmentGroup }</span>
<span class="cmt">// ✓ No raw URLs, no user identity, no behavioral sequence ever exposed.</span>`,
      )}
    `,
    setup(el) {
      refreshTelemetry();
      el.querySelectorAll<HTMLElement>('.state-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          intent.track(chip.dataset.track!);
          refreshTelemetry();
        });
      });
      el.querySelector('#btn-telemetry')!.addEventListener('click', refreshTelemetry);
      el.querySelector('#btn-export-graph')!.addEventListener('click', () => {
        const out = el.querySelector<HTMLElement>('#telemetry-output')!;
        out.innerHTML = `<div class="code-block"><div class="code-label">exportGraph()</div><pre>${JSON.stringify(intent.exportGraph(), null, 2)}</pre></div>`;
      });

      function refreshTelemetry() {
        const t = intent.getTelemetry();
        const p = intent.getPerformanceReport();
        el.querySelector<HTMLElement>('#m-transitions')!.textContent = String(
          t.transitionsEvaluated,
        );
        el.querySelector<HTMLElement>('#m-anomalies')!.textContent = String(t.anomaliesFired);
        el.querySelector<HTMLElement>('#m-states')!.textContent = String(
          p.memoryFootprint.stateCount,
        );
        el.querySelector<HTMLElement>('#m-bot')!.innerHTML =
          t.botStatus === 'suspected_bot'
            ? '<span class="status-dot status-red"></span>bot'
            : '<span class="status-dot status-green"></span>clean';
        el.querySelector<HTMLElement>('#m-health')!.textContent = `${t.engineHealth}%`;
        el.querySelector<HTMLElement>('#m-group')!.textContent = t.assignmentGroup ?? '—';
      }
    },
  },

  // ── 2. Basic Tracking ─────────────────────────────────────────────────────
  'basic-tracking': {
    title: '📍 Basic Tracking',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Basic Tracking</h2>
        <p class="demo-description">
          Every call to <strong>track(state)</strong> records a Markov transition, updates the Bloom filter,
          and fires <strong>state_change</strong>. State labels are auto-normalized — UUIDs, query strings,
          and trailing slashes are stripped so <code>/product/abc-123</code> and <code>/product/xyz-456</code>
          both map to <code>/product/:id</code>.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Track a custom state</div>
        <div class="input-row">
          <input type="text" id="custom-state" value="/checkout/payment" placeholder="/your-route" />
          <button class="btn btn-primary" id="btn-track-custom">Track</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Simulate a user journey</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Click steps in order to simulate a checkout funnel:</p>
        <div class="btn-row">
          ${[
            '/home',
            '/products',
            '/product/headphones-pro',
            '/cart',
            '/checkout/shipping',
            '/checkout/payment',
            '/thank-you',
          ]
            .map(
              (s, i) =>
                `<button class="btn btn-secondary" data-step-track="${s}">
              <span style="color:var(--text-muted);font-size:11px">${i + 1}.</span> ${s}
            </button>`,
            )
            .join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Auto-normalization examples</div>
        <table class="data-table">
          <thead><tr><th>Raw input</th><th>Normalized to</th></tr></thead>
          <tbody id="normalization-table"></tbody>
        </table>
      </div>

      ${codeBlock(
        'Basic usage',
        `<span class="kw">import</span> { <span class="type">IntentManager</span>, <span class="type">BrowserStorageAdapter</span>, <span class="type">BrowserTimerAdapter</span> } <span class="kw">from</span> <span class="str">'@passiveintent/core'</span>;

<span class="kw">const</span> intent = <span class="kw">new</span> <span class="fn">IntentManager</span>({ storageKey: <span class="str">'my-app'</span> });

intent.<span class="fn">track</span>(<span class="str">'/home'</span>);                     <span class="cmt">// records transition</span>
intent.<span class="fn">track</span>(<span class="str">'/checkout/abc-123-payment'</span>); <span class="cmt">// normalizes UUID</span>

intent.<span class="fn">on</span>(<span class="str">'state_change'</span>, ({ <span class="prop">from</span>, <span class="prop">to</span>, <span class="prop">probability</span> }) => {
  console.<span class="fn">log</span>(<span class="str">\`\${from} → \${to} (\${(probability * 100).<span class="fn">toFixed</span>(1)}%)\`</span>);
});`,
      )}
    `,
    setup(el) {
      const normExamples = [
        ['/product/e3b0c44298fc', '/product/:id'],
        ['/user/507f1f77bcf86?tab=orders', '/user/:id'],
        ['/blog/my-great-post-title/', '/blog/:slug'],
        ['/order/abc123def456789012345678', '/order/:id'],
      ];
      const tbody = el.querySelector<HTMLElement>('#normalization-table')!;
      tbody.innerHTML = normExamples
        .map(
          ([raw, norm]) =>
            `<tr><td><code style="color:var(--text-muted)">${raw}</code></td><td><code style="color:var(--green)">${norm}</code></td></tr>`,
        )
        .join('');

      el.querySelector('#btn-track-custom')!.addEventListener('click', () => {
        const v = el.querySelector<HTMLInputElement>('#custom-state')!.value.trim();
        if (v) intent.track(v);
      });
      el.querySelectorAll<HTMLElement>('[data-step-track]').forEach((btn) => {
        btn.addEventListener('click', () => intent.track(btn.dataset.stepTrack!));
      });
    },
  },

  // ── 3. High Entropy ──────────────────────────────────────────────────────
  'high-entropy': {
    title: '⚡ High Entropy Detection',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">High Entropy Detection</h2>
        <p class="demo-description">
          <strong>high_entropy</strong> fires when the Shannon entropy of the outgoing-transition distribution from a state
          exceeds <code>highEntropyThreshold</code> (default 0.75). A user bouncing between many different pages from
          the same origin looks erratic — classic frustration, rage-click, or disorientation signal.
        </p>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title">Simulate erratic navigation</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
            Click "Rapid Fire" to track many random destinations from <code>/checkout/payment</code> rapidly — this spreads
            the transition probability mass and causes entropy to spike.
          </p>
          <div class="btn-row">
            <button class="btn btn-primary" id="btn-rapid-fire">⚡ Rapid Fire (15 random)</button>
            <button class="btn btn-secondary" id="btn-normal-nav">✅ Normal Navigation</button>
          </div>
          <div id="entropy-result" style="margin-top:12px"></div>
        </div>
        <div class="card">
          <div class="card-title">What high entropy looks like</div>
          <div id="entropy-viz">
            <p style="color:var(--text-muted);font-size:13px">Fire events to see the distribution</p>
          </div>
        </div>
      </div>

      ${codeBlock(
        'high_entropy event',
        `intent.<span class="fn">on</span>(<span class="str">'high_entropy'</span>, ({ <span class="prop">state</span>, <span class="prop">normalizedEntropy</span>, <span class="prop">outgoingStates</span> }) => {
  <span class="kw">if</span> (normalizedEntropy > <span class="num">0.85</span>) {
    UI.<span class="fn">showHelpModal</span>({ message: <span class="str">'Having trouble? Let us help.'</span> });
  }
});

<span class="cmt">// Config: control sensitivity</span>
<span class="kw">const</span> intent = <span class="kw">new</span> <span class="fn">IntentManager</span>({
  graph: { highEntropyThreshold: <span class="num">0.72</span> } <span class="cmt">// lower = more sensitive</span>
});`,
      )}
    `,
    setup(el) {
      const RANDOM_STATES = [
        '/search',
        '/cart',
        '/wishlist',
        '/account/profile',
        '/returns',
        '/support',
        '/blog/tips',
        '/sitemap',
        '/404',
        '/faq',
        '/shipping',
        '/privacy',
        '/about',
        '/deal-of-day',
        '/newsletter',
      ];
      el.querySelector('#btn-rapid-fire')!.addEventListener('click', () => {
        intent.track('/checkout/payment');
        for (let i = 0; i < 15; i++) {
          const s = RANDOM_STATES[Math.floor(Math.random() * RANDOM_STATES.length)];
          intent.track(s);
          intent.track('/checkout/payment');
        }
        const graph = intent.exportGraph();
        const txns = getNodeTransitions(graph, '/checkout/payment');
        el.querySelector<HTMLElement>('#entropy-result')!.innerHTML = Object.keys(txns).length
          ? `<div class="alert alert-warning">Outgoing edges: <strong>${Object.keys(txns).length}</strong> destinations from <code>/checkout/payment</code>. Check the event log for <strong>high_entropy</strong>.</div>`
          : `<div class="alert alert-info">Track more states to build the graph.</div>`;
        renderEntropyViz(el, graph);
      });
      el.querySelector('#btn-normal-nav')!.addEventListener('click', () => {
        for (let i = 0; i < 8; i++) {
          intent.track('/products');
          intent.track('/product/widget-pro');
          intent.track('/cart');
          intent.track('/checkout/payment');
        }
      });

      function renderEntropyViz(el: HTMLElement, graph: SerializedMarkovGraph) {
        const txns = getNodeTransitions(graph, '/checkout/payment');
        if (!Object.keys(txns).length) return;
        const total = Object.values(txns).reduce((a, b) => a + b, 0);
        const rowHtml = (s: string, count: number) => {
          const pct = total ? Math.round((count / total) * 100) : 0;
          return `<div class="progress-row">
            <span class="progress-label" style="font-size:11px;font-family:var(--font-mono)">${s.slice(0, 20)}</span>
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="progress-value">${pct}%</span>
          </div>`;
        };
        el.querySelector<HTMLElement>('#entropy-viz')!.innerHTML = Object.entries(txns)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 8)
          .map(([s, c]) => rowHtml(s, c))
          .join('');
      }
    },
  },

  // ── 4. Dwell Time Anomaly ─────────────────────────────────────────────────
  'dwell-time': {
    title: '⏱ Dwell Time Anomaly',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Dwell Time Anomaly</h2>
        <p class="demo-description">
          PassiveIntent measures how long a user spends on a state. Using <strong>Welford's online algorithm</strong>,
          it accumulates a running mean/variance without storing raw timestamps. When the z-score of the current
          dwell time exceeds the threshold, <strong>dwell_time_anomaly</strong> fires — the user is hesitating.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Build a dwell baseline (3+ samples needed)</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
          First build a normal baseline by simulating quick visits. Then simulate a long hesitation to trigger the anomaly.
        </p>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-build-dwell-baseline">📈 Build Baseline (10 quick visits)</button>
          <button class="btn btn-primary"   id="btn-simulate-hesitation">😰 Simulate Hesitation (+5 minutes)</button>
          <button class="btn btn-ghost"     id="btn-reset-timer">↩ Reset Timer</button>
        </div>
        <div id="dwell-status" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <div class="card-title">How Welford's algorithm works</div>
        <p style="color:var(--text-muted);font-size:13px;line-height:1.7">
          The engine maintains a running <strong>mean (μ)</strong> and <strong>variance (σ²)</strong> per state — no raw dwell
          history is ever stored. When a new dwell time <em>x</em> arrives, the z-score is:
          <code style="display:block;margin:8px 0;padding:8px 12px;background:var(--bg-3);border-radius:4px">z = (x − μ) / σ</code>
          If |z| &gt; <code>zScoreThreshold</code> (default 2.0), the event fires.
        </p>
      </div>

      ${codeBlock(
        'dwell_time_anomaly event',
        `intent.<span class="fn">on</span>(<span class="str">'dwell_time_anomaly'</span>, ({ <span class="prop">state</span>, <span class="prop">zScore</span>, <span class="prop">dwellMs</span>, <span class="prop">mean</span>, <span class="prop">stdDev</span> }) => {
  <span class="kw">if</span> (state === <span class="str">'/checkout/payment'</span> &amp;&amp; zScore > <span class="num">2.0</span>) {
    UI.<span class="fn">showOffer</span>({ discount: <span class="str">'10%'</span>, message: <span class="str">'Free shipping today only!'</span> });
  }
});

<span class="cmt">// Enable in config:</span>
<span class="kw">const</span> intent = <span class="kw">new</span> <span class="fn">IntentManager</span>({
  dwellTime: { enabled: <span class="kw">true</span>, minSamples: <span class="num">3</span>, zScoreThreshold: <span class="num">2.0</span> }
});`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-build-dwell-baseline')!.addEventListener('click', () => {
        timer.reset();
        // Simulate 10 quick page visits at ~2-4s each
        for (let i = 0; i < 10; i++) {
          intent.track('/products');
          timer.fastForward(2500 + Math.random() * 1500);
          intent.track('/checkout/payment');
          timer.fastForward(3000 + Math.random() * 1000);
        }
        el.querySelector<HTMLElement>('#dwell-status')!.innerHTML =
          `<div class="alert alert-success">Baseline built: 10 visits with ~3s average dwell on <code>/checkout/payment</code>. Now simulate hesitation →</div>`;
      });
      el.querySelector('#btn-simulate-hesitation')!.addEventListener('click', () => {
        intent.track('/checkout/payment');
        timer.fastForward(5 * 60 * 1000); // 5 minutes — way above normal
        intent.track('/checkout/confirm');
        el.querySelector<HTMLElement>('#dwell-status')!.innerHTML =
          `<div class="alert alert-warning">⏱ Simulated 5 minutes on <code>/checkout/payment</code>. Check the event log for <strong>dwell_time_anomaly</strong>.</div>`;
      });
      el.querySelector('#btn-reset-timer')!.addEventListener('click', () => {
        timer.reset();
        el.querySelector<HTMLElement>('#dwell-status')!.innerHTML =
          `<div class="alert alert-info">Timer offset reset to 0.</div>`;
      });
    },
  },

  // ── 5. Trajectory Anomaly ─────────────────────────────────────────────────
  trajectory: {
    title: '🛤 Trajectory Anomaly',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Trajectory Anomaly</h2>
        <p class="demo-description">
          The engine compares the current session's per-step log-likelihood against a pre-trained
          <strong>baseline graph</strong> (your normal conversion path). When the z-score of the
          log-likelihood window diverges beyond <code>divergenceThreshold</code>, <strong>trajectory_anomaly</strong> fires.
        </p>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title">Normal checkout funnel</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Mirrors the baseline — no anomaly expected.</p>
          <div class="btn-row">
            <button class="btn btn-green" id="btn-normal-trajectory">✅ Walk Normal Path</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Anomalous path</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Deviates from the baseline funnel sharply.</p>
          <div class="btn-row">
            <button class="btn btn-danger" id="btn-anomalous-trajectory">🚨 Walk Anomalous Path</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Baseline graph (embedded)</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:6px">
          This is the pre-trained graph passed as <code>baseline</code> in the config.
          Generate yours with <code>MarkovGraph.toJSON()</code> after a training run.
        </p>
        <div id="baseline-viz"></div>
      </div>

      ${codeBlock(
        'Load a pre-trained baseline',
        `<span class="kw">import</span> baseline <span class="kw">from</span> <span class="str">'./baseline.json'</span>;

<span class="kw">const</span> intent = <span class="kw">new</span> <span class="fn">IntentManager</span>({
  baseline,                  <span class="cmt">// SerializedMarkovGraph — your normal conversion path</span>
  baselineMeanLL: <span class="num">-1.4</span>,      <span class="cmt">// mean of per-step log-likelihood in training data</span>
  baselineStdLL:  <span class="num">0.35</span>,      <span class="cmt">// std dev  of per-step log-likelihood in training data</span>
  graph: { divergenceThreshold: <span class="num">2.5</span> },
});

intent.<span class="fn">on</span>(<span class="str">'trajectory_anomaly'</span>, ({ <span class="prop">state</span>, <span class="prop">zScore</span>, <span class="prop">logLikelihood</span> }) => {
  <span class="kw">if</span> (zScore > <span class="num">2.5</span>) analytics.<span class="fn">trackAbandonment</span>(state);
});`,
      )}
    `,
    setup(el) {
      // Show baseline graph summary
      const baseline = ECOMMERCE_BASELINE;
      const vizHtml = baseline.rows
        .slice(0, 6)
        .map(([fromIdx, , transitions]) => {
          const state = baseline.states[fromIdx];
          if (!state) return '';
          const top = [...transitions]
            .sort(([, a], [, b]) => b - a)
            .slice(0, 2)
            .map(([toIdx, c]) => `${baseline.states[toIdx]}(${c})`)
            .join(', ');
          return `<div class="progress-row">
          <span class="progress-label" style="font-size:11px;font-family:var(--font-mono)">${state}</span>
          <span style="font-size:11px;color:var(--text-muted)">→ ${top}</span>
        </div>`;
        })
        .join('');
      el.querySelector<HTMLElement>('#baseline-viz')!.innerHTML = vizHtml;

      el.querySelector('#btn-normal-trajectory')!.addEventListener('click', () => {
        [
          '/home',
          '/products',
          '/product/headphones',
          '/cart',
          '/checkout/payment',
          '/thank-you',
        ].forEach((s) => intent.track(s));
      });
      el.querySelector('#btn-anomalous-trajectory')!.addEventListener('click', () => {
        ['/home', '/pricing', '/support', '/404', '/faq', '/returns', '/support', '/404'].forEach(
          (s, i) => {
            intent.track(s);
            if (i > 1) timer.fastForward(500);
          },
        );
      });
    },
  },

  // ── 6. Hesitation Detection ───────────────────────────────────────────────
  hesitation: {
    title: '🤔 Hesitation Detection',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Hesitation Detection</h2>
        <p class="demo-description">
          <strong>hesitation_detected</strong> fires when <em>both</em> a <code>trajectory_anomaly</code>
          and a positive <code>dwell_time_anomaly</code> occur within <code>hesitationCorrelationWindowMs</code>.
          It's the highest-confidence signal you can get — the user is both on a non-typical path <em>and</em>
          spending unusually long there.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Trigger combined hesitation signal</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
          This runs the full sequence: builds a dwell baseline, then simultaneously triggers a trajectory deviation
          with an extended dwell time.
        </p>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-prime-hesitation">1️⃣ Prime the engine (5 normal visits)</button>
          <button class="btn btn-primary"   id="btn-trigger-hesitation">2️⃣ Trigger Hesitation Signal</button>
        </div>
        <div id="hesitation-status" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <div class="card-title">Recipe: Intervention Ladder</div>
        <p style="color:var(--text-muted);font-size:13px;line-height:1.7">
          Use <code>hesitation_detected</code> as the trigger for a tiered offer ladder:
          show a tooltip first, then a modal, then escalate to live chat.
        </p>
      </div>

      ${codeBlock(
        'hesitation_detected + Intervention Ladder',
        `intent.<span class="fn">on</span>(<span class="str">'hesitation_detected'</span>, ({ <span class="prop">state</span>, <span class="prop">zScoreDwell</span>, <span class="prop">zScoreTrajectory</span> }) => {
  <span class="kw">const</span> severity = (zScoreDwell + zScoreTrajectory) / <span class="num">2</span>;

  <span class="kw">if</span> (severity < <span class="num">2.5</span>) {
    Tooltip.<span class="fn">show</span>(<span class="str">'Free shipping today only!'</span>);
  } <span class="kw">else if</span> (severity < <span class="num">3.5</span>) {
    Modal.<span class="fn">show</span>({ discount: <span class="str">'10%'</span>, message: <span class="str">'Having second thoughts?'</span> });
  } <span class="kw">else</span> {
    LiveChat.<span class="fn">proactiveOpen</span>(<span class="str">'Hi! Can I help you complete your order?'</span>);
  }
});`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-prime-hesitation')!.addEventListener('click', () => {
        timer.reset();
        for (let i = 0; i < 5; i++) {
          intent.track('/products');
          timer.fastForward(1500);
          intent.track('/checkout/payment');
          timer.fastForward(3000);
          intent.track('/products');
          timer.fastForward(2000);
        }
        el.querySelector<HTMLElement>('#hesitation-status')!.innerHTML =
          `<div class="alert alert-success">Engine primed with 5 normal visits. Now trigger the hesitation →</div>`;
      });
      el.querySelector('#btn-trigger-hesitation')!.addEventListener('click', () => {
        // Go somewhere unusual
        intent.track('/support');
        timer.fastForward(7 * 60 * 1000); // 7 minute dwell — very abnormal
        intent.track('/faq'); // then bounce to FAQ (anomalous path)
        el.querySelector<HTMLElement>('#hesitation-status')!.innerHTML =
          `<div class="alert alert-warning">Triggered anomalous path + long dwell. Check log for <strong>hesitation_detected</strong>.</div>`;
      });
    },
  },

  // ── 7. Attention Return ────────────────────────────────────────────────────
  'attention-return': {
    title: '👁 Attention Return',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Attention Return</h2>
        <p class="demo-description">
          When a user hides the tab (likely comparison-shopping), then returns after ≥ <strong>15 seconds</strong>,
          <strong>attention_return</strong> fires. Target them with a personalized "Welcome Back" offer.
          This fires independently of <code>dwellTime.enabled</code>.
        </p>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title">Browser-native test</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
            Track a state, switch to another tab for 15+ seconds, then come back. The event fires automatically.
          </p>
          <button class="btn btn-primary" id="btn-track-for-attention">📍 Track /pricing then switch tabs</button>
          <div id="attention-hint" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div class="card-title">Simulate (no tab-switching needed)</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
            Programmatically simulate a 30-second hide+return via the controllable lifecycle adapter.
          </p>
          <div class="btn-row">
            <button class="btn btn-secondary" id="btn-simulate-hide">👻 Simulate Hide (30s)</button>
            <button class="btn btn-green"     id="btn-simulate-return">👋 Simulate Return</button>
          </div>
        </div>
      </div>

      ${codeBlock(
        'attention_return — Welcome Back offer',
        `intent.<span class="fn">on</span>(<span class="str">'attention_return'</span>, ({ <span class="prop">state</span>, <span class="prop">hiddenDuration</span> }) => {
  <span class="kw">if</span> (state === <span class="str">'/pricing'</span> || state === <span class="str">'/product'</span>) {
    Banner.<span class="fn">show</span>({
      title:   <span class="str">'Welcome back! 👋'</span>,
      message: <span class="str">\`Found a better deal? We'll match it — and add free shipping.\`</span>,
      cta:     <span class="str">'Claim offer'</span>,
    });
  }
  console.<span class="fn">log</span>(<span class="str">'Was away for'</span>, hiddenDuration, <span class="str">'ms'</span>);
});`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-track-for-attention')!.addEventListener('click', () => {
        intent.track('/pricing');
        el.querySelector<HTMLElement>('#attention-hint')!.innerHTML =
          `<div class="alert alert-info">✓ Tracked <code>/pricing</code>. Now switch to another tab for &gt;15 seconds, then come back.</div>`;
      });
      el.querySelector('#btn-simulate-hide')!.addEventListener('click', () => {
        intent.track('/pricing');
        lifecycle.triggerPause();
        timer.fastForward(30 * 1000);
      });
      el.querySelector('#btn-simulate-return')!.addEventListener('click', () => {
        lifecycle.triggerResume();
      });
    },
  },

  // ── 8. Idle Detection ─────────────────────────────────────────────────────
  'idle-detection': {
    title: '💤 Idle Detection',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Idle Detection</h2>
        <p class="demo-description">
          <strong>user_idle</strong> fires after <strong>2 minutes</strong> of no interaction (mouse, keyboard, scroll, touch).
          <strong>user_resumed</strong> fires on the next interaction after idle, with the total <code>idleMs</code>.
          Use these to dim the UI, pause animations, or invalidate stale data.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Simulate idle + resume cycle</div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-simulate-idle">💤 Simulate Idle (2 min timeout)</button>
          <button class="btn btn-primary"   id="btn-simulate-resume">🖱 Simulate User Resumed</button>
        </div>
        <div id="idle-status" style="margin-top:12px"></div>
      </div>

      ${codeBlock(
        'user_idle + user_resumed overlay',
        `intent.<span class="fn">on</span>(<span class="str">'user_idle'</span>, ({ <span class="prop">state</span> }) => {
  UI.<span class="fn">showIdleOverlay</span>({ message: <span class="str">'Still there? Your cart is saved.'</span> });
  <span class="cmt">// Pause expensive background animations</span>
  VideoPlayer.<span class="fn">pause</span>();
});

intent.<span class="fn">on</span>(<span class="str">'user_resumed'</span>, ({ <span class="prop">state</span>, <span class="prop">idleMs</span> }) => {
  UI.<span class="fn">hideIdleOverlay</span>();
  <span class="kw">if</span> (idleMs > <span class="num">300_000</span>) {
    DataFetcher.<span class="fn">refreshStaleContent</span>(); <span class="cmt">// 5+ min: data might be stale</span>
  }
});`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-simulate-idle')!.addEventListener('click', () => {
        intent.track('/checkout/payment');
        // Fast-forward past the idle threshold (USER_IDLE_THRESHOLD_MS = 2 min)
        // The idle check polls on IDLE_CHECK_INTERVAL_MS; we simulate it via lifecycle
        timer.fastForward(3 * 60 * 1000); // 3 minutes
        // Trigger the idle check manually via the controllable adapter
        // The engine sets up an interval — we simulate the "no interaction" by
        // NOT calling triggerInteraction and just waiting for the engine's timer
        el.querySelector<HTMLElement>('#idle-status')!.innerHTML =
          `<div class="alert alert-info">Simulated 3 minutes of no interaction. If the idle threshold was reached, <strong>user_idle</strong> fires. Click "Simulate Resumed" to fire <strong>user_resumed</strong>.</div>`;
      });
      el.querySelector('#btn-simulate-resume')!.addEventListener('click', () => {
        lifecycle.triggerInteraction();
        el.querySelector<HTMLElement>('#idle-status')!.innerHTML =
          `<div class="alert alert-success">Interaction fired — check log for <strong>user_resumed</strong>.</div>`;
      });
    },
  },

  // ── 9. Exit Intent ────────────────────────────────────────────────────────
  'exit-intent': {
    title: '🚪 Exit Intent',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Smart Exit Intent</h2>
        <p class="demo-description">
          <strong>exit_intent</strong> fires when the pointer moves above the viewport <em>AND</em> the Markov graph
          has at least one continuation candidate with probability ≥ 0.4. This prevents spammy overlays on accidental
          toolbar skims — only data-backed exits trigger it.
        </p>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title">Browser-native</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Move your cursor to the very top edge of the browser window (above the page) to trigger the real exit-intent detection.</p>
          <button class="btn btn-primary" id="btn-setup-exit-intent">📍 Track /checkout/payment first</button>
        </div>
        <div class="card">
          <div class="card-title">Simulate</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Programmatically trigger the exit-intent signal. Build up the graph first so <code>likelyNext</code> is populated.</p>
          <div class="btn-row">
            <button class="btn btn-secondary" id="btn-build-exit-graph">Build Graph (10 sessions)</button>
            <button class="btn btn-danger"    id="btn-simulate-exit">🚪 Simulate Exit Intent</button>
          </div>
        </div>
      </div>

      ${codeBlock(
        'exit_intent — last-chance offer',
        `intent.<span class="fn">on</span>(<span class="str">'exit_intent'</span>, ({ <span class="prop">state</span>, <span class="prop">likelyNext</span> }) => {
  <span class="kw">if</span> (state === <span class="str">'/checkout/payment'</span>) {
    Modal.<span class="fn">show</span>({
      title: <span class="str">'Wait — your cart will expire in 10 minutes!'</span>,
      cta:   <span class="str">'Complete Purchase'</span>,
    });
  }
  <span class="cmt">// likelyNext: highest-probability Markov prediction</span>
  console.<span class="fn">log</span>(<span class="str">'Would have gone to:'</span>, likelyNext);
});`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-setup-exit-intent')!.addEventListener('click', () => {
        intent.track('/checkout/payment');
      });
      el.querySelector('#btn-build-exit-graph')!.addEventListener('click', () => {
        for (let i = 0; i < 10; i++) {
          intent.track('/checkout/payment');
          intent.track('/cart');
          intent.track('/checkout/payment');
          intent.track('/thank-you');
        }
      });
      el.querySelector('#btn-simulate-exit')!.addEventListener('click', () => {
        lifecycle.triggerExitIntent();
      });
    },
  },

  // ── 10. Bloom Filter ──────────────────────────────────────────────────────
  'bloom-filter': {
    title: '🌸 Bloom Filter API',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Bloom Filter API</h2>
        <p class="demo-description">
          The built-in Bloom filter gives you O(k) "have I seen this state?" lookups <strong>without storing a list</strong>.
          Use <code>intent.hasSeen()</code> for quick membership tests, or create a standalone <code>BloomFilter</code>
          for your own data. <code>computeBloomConfig()</code> computes optimal sizing.
        </p>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title">intent.hasSeen() — O(k) lookup</div>
          <div class="input-row">
            <input type="text" id="bloom-check-input" value="/checkout/payment" />
            <button class="btn btn-primary" id="btn-bloom-check">Check</button>
          </div>
          <div id="bloom-check-result" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div class="card-title">Standalone BloomFilter</div>
          <div class="input-row">
            <input type="text" id="bloom-add-input" value="user@example.com" placeholder="item to add" />
            <button class="btn btn-secondary" id="btn-bloom-add">Add</button>
            <button class="btn btn-primary"   id="btn-bloom-test">Test</button>
          </div>
          <div id="bloom-standalone-result" style="margin-top:10px"></div>
          <div id="bloom-bits" class="bit-viz" style="margin-top:12px"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">computeBloomConfig() — optimal sizing</div>
        <div class="input-row">
          <label>Expected items:</label>
          <input type="number" id="bloom-items" value="1000" />
          <label>Target FPR:</label>
          <input type="number" id="bloom-fpr" value="0.01" step="0.001" />
          <button class="btn btn-secondary" id="btn-compute-bloom">Compute</button>
        </div>
        <div id="bloom-config-result" style="margin-top:10px"></div>
      </div>

      ${codeBlock(
        'BloomFilter API',
        `<span class="kw">import</span> { <span class="type">BloomFilter</span>, <span class="fn">computeBloomConfig</span> } <span class="kw">from</span> <span class="str">'@passiveintent/core'</span>;

<span class="cmt">// Optimal sizing for 1 000 items at 1% false-positive rate</span>
<span class="kw">const</span> cfg = <span class="fn">computeBloomConfig</span>(<span class="num">1_000</span>, <span class="num">0.01</span>);
<span class="cmt">// → { bitSize: 9586, hashCount: 7, estimatedFpRate: 0.0093 }</span>

<span class="kw">const</span> bf = <span class="kw">new</span> <span class="type">BloomFilter</span>(cfg.bitSize, cfg.hashCount);
bf.<span class="fn">add</span>(<span class="str">'user@example.com'</span>);
bf.<span class="fn">check</span>(<span class="str">'user@example.com'</span>); <span class="cmt">// → true (definitely seen)</span>
bf.<span class="fn">check</span>(<span class="str">'other@example.com'</span>); <span class="cmt">// → false (probably not seen)</span>

<span class="cmt">// Compact serialization</span>
<span class="kw">const</span> snapshot = bf.<span class="fn">toBase64</span>();
<span class="kw">const</span> restored = <span class="type">BloomFilter</span>.<span class="fn">fromBase64</span>(snapshot, cfg.hashCount);

<span class="cmt">// Via IntentManager</span>
intent.<span class="fn">hasSeen</span>(<span class="str">'/checkout/payment'</span>); <span class="cmt">// O(k), no false negatives</span>`,
      )}
    `,
    setup(el) {
      // Standalone bloom filter for the demo
      const bf = new BloomFilter({ bitSize: 512, hashCount: 4 });
      let bfItems = 0;

      function renderBits() {
        const bitsEl = el.querySelector<HTMLElement>('#bloom-bits')!;
        const b64 = bf.toBase64();
        const bytes = atob(b64);
        bitsEl.innerHTML = Array.from(bytes.slice(0, 32), (byte, bi) =>
          Array.from(
            { length: 8 },
            (_, k) => `<div class="bit ${(byte.charCodeAt(0) >> (7 - k)) & 1 ? 'on' : ''}"></div>`,
          ).join(''),
        ).join('');
      }
      renderBits();

      el.querySelector('#btn-bloom-check')!.addEventListener('click', () => {
        const v = el.querySelector<HTMLInputElement>('#bloom-check-input')!.value;
        const seen = intent.hasSeen(v);
        el.querySelector<HTMLElement>('#bloom-check-result')!.innerHTML =
          `<div class="alert ${seen ? 'alert-warning' : 'alert-info'}">
            <code>${v}</code> → <strong>${seen ? '✓ Probably seen' : '✗ Definitely not seen'}</strong>
          </div>`;
      });
      el.querySelector('#btn-bloom-add')!.addEventListener('click', () => {
        const v = el.querySelector<HTMLInputElement>('#bloom-add-input')!.value;
        bf.add(v);
        bfItems++;
        el.querySelector<HTMLElement>('#bloom-standalone-result')!.innerHTML =
          `<div class="alert alert-success">Added "${v}". Estimated FPR: ${(bf.estimateCurrentFPR(bfItems) * 100).toFixed(3)}%</div>`;
        renderBits();
      });
      el.querySelector('#btn-bloom-test')!.addEventListener('click', () => {
        const v = el.querySelector<HTMLInputElement>('#bloom-add-input')!.value;
        const r = bf.check(v);
        el.querySelector<HTMLElement>('#bloom-standalone-result')!.innerHTML =
          `<div class="alert ${r ? 'alert-warning' : 'alert-info'}">Test "${v}": ${r ? '✓ Probably in set' : '✗ Definitely not in set'}</div>`;
      });
      el.querySelector('#btn-compute-bloom')!.addEventListener('click', () => {
        const items = parseInt(el.querySelector<HTMLInputElement>('#bloom-items')!.value);
        const fpr = parseFloat(el.querySelector<HTMLInputElement>('#bloom-fpr')!.value);
        const cfg = computeBloomConfig(items, fpr);
        el.querySelector<HTMLElement>('#bloom-config-result')!.innerHTML = `
          <div class="alert alert-success">
            bitSize: <strong>${cfg.bitSize}</strong> bits (${(cfg.bitSize / 8 / 1024).toFixed(1)} KB) &nbsp;|&nbsp;
            hashCount: <strong>${cfg.hashCount}</strong> &nbsp;|&nbsp;
            estimated FPR: <strong>${(cfg.estimatedFpRate * 100).toFixed(3)}%</strong>
          </div>`;
      });
    },
  },

  // ── 11. Markov Graph ──────────────────────────────────────────────────────
  'markov-graph': {
    title: '🕸 Markov Predictions',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Markov Graph — Predictions</h2>
        <p class="demo-description">
          <strong>predictNextStates()</strong> returns the top-N most probable destinations from the current state.
          Use it to prefetch the next page, personalize navigation, or build proactive interventions.
          Always pass a <code>sanitize</code> guard in production to exclude sensitive routes.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Live predictions</div>
        <div class="input-row">
          <input type="text" id="predict-state" value="/checkout/payment" />
          <input type="number" id="predict-threshold" value="0.05" step="0.01" min="0" max="1" style="width:80px" />
          <label style="font-size:12px;color:var(--text-muted)">threshold</label>
          <button class="btn btn-primary" id="btn-predict">Predict</button>
        </div>
        <div id="predict-result" style="margin-top:14px">
          <p style="color:var(--text-muted);font-size:13px">Click "Predict" after tracking a few states.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Standalone MarkovGraph</div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-build-markov">Build sample graph</button>
          <button class="btn btn-primary"   id="btn-serialize-markov">Serialize to JSON</button>
          <button class="btn btn-ghost"     id="btn-binary-markov">Binary size</button>
        </div>
        <div id="markov-output" style="margin-top:12px"></div>
      </div>

      ${codeBlock(
        'predictNextStates() + prefetch',
        `<span class="cmt">// Prefetch the most likely next page</span>
<span class="kw">const</span> predictions = intent.<span class="fn">predictNextStates</span>(
  <span class="num">0.3</span>,            <span class="cmt">// only states with ≥ 30% probability</span>
  (s) => !s.<span class="fn">startsWith</span>(<span class="str">'/admin'</span>)  <span class="cmt">// sanitize guard</span>
);

<span class="kw">for</span> (<span class="kw">const</span> { <span class="prop">state</span>, <span class="prop">probability</span> } <span class="kw">of</span> predictions) {
  Router.<span class="fn">prefetch</span>(state); <span class="cmt">// proactively load the bundle</span>
}

<span class="cmt">// Standalone MarkovGraph</span>
<span class="kw">const</span> g = <span class="kw">new</span> <span class="type">MarkovGraph</span>({ maxStates: <span class="num">500</span> });
g.<span class="fn">incrementTransition</span>(<span class="str">'/home'</span>, <span class="str">'/pricing'</span>);
g.<span class="fn">getLikelyNextStates</span>(<span class="str">'/home'</span>, <span class="num">0.1</span>);
<span class="kw">const</span> json = g.<span class="fn">toJSON</span>();     <span class="cmt">// human-readable snapshot</span>
<span class="kw">const</span> buf  = g.<span class="fn">toBinary</span>();   <span class="cmt">// compact binary — smaller at scale</span>`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-predict')!.addEventListener('click', () => {
        const state = el.querySelector<HTMLInputElement>('#predict-state')!.value;
        const threshold = parseFloat(
          el.querySelector<HTMLInputElement>('#predict-threshold')!.value,
        );
        const preds = intent.predictNextStates(threshold, (s) => !s.startsWith('/admin'));
        if (!preds.length) {
          el.querySelector<HTMLElement>('#predict-result')!.innerHTML =
            `<div class="alert alert-info">No predictions for <code>${state}</code> above ${threshold}. Track more states from this origin first.</div>`;
          return;
        }
        el.querySelector<HTMLElement>('#predict-result')!.innerHTML = `
          <table class="data-table">
            <thead><tr><th>State</th><th>Probability</th><th></th></tr></thead>
            <tbody>${preds
              .map(
                ({ state: s, probability: p }) => `
              <tr>
                <td><code style="color:var(--accent-h)">${s}</code></td>
                <td>${(p * 100).toFixed(1)}%</td>
                <td><div class="prob-bar"><div class="prob-fill" style="width:${Math.round(p * 200)}px"></div></div></td>
              </tr>`,
              )
              .join('')}
            </tbody>
          </table>`;
      });

      const sampleGraph = new MarkovGraph({ maxStates: 50 });
      el.querySelector('#btn-build-markov')!.addEventListener('click', () => {
        const paths = [
          ['/home', '/products', '/cart', '/checkout/payment', '/thank-you'],
          ['/home', '/pricing', '/checkout/payment', '/thank-you'],
          ['/home', '/products', '/product/widget', '/cart', '/checkout/payment', '/thank-you'],
          ['/blog', '/home', '/products', '/cart', '/checkout/payment'],
        ];
        paths.forEach((path) => {
          for (let i = 0; i < path.length - 1; i++) {
            sampleGraph.incrementTransition(path[i], path[i + 1]);
          }
        });
        el.querySelector<HTMLElement>('#markov-output')!.innerHTML =
          `<div class="alert alert-success">Graph built: ${sampleGraph.stateCount()} states, ${sampleGraph.totalTransitions()} transitions.</div>`;
      });
      el.querySelector('#btn-serialize-markov')!.addEventListener('click', () => {
        const json = JSON.stringify(sampleGraph.toJSON(), null, 2);
        el.querySelector<HTMLElement>('#markov-output')!.innerHTML =
          `<div class="code-block"><div class="code-label">MarkovGraph.toJSON()</div><pre>${json.slice(0, 800)}${json.length > 800 ? '\n...' : ''}</pre></div>`;
      });
      el.querySelector('#btn-binary-markov')!.addEventListener('click', () => {
        const bin = sampleGraph.toBinary();
        const json = JSON.stringify(sampleGraph.toJSON());
        el.querySelector<HTMLElement>('#markov-output')!.innerHTML =
          `<div class="alert alert-info">Binary: <strong>${bin.byteLength} bytes</strong> | JSON: <strong>${json.length} bytes</strong> | Savings: <strong>${(((json.length - bin.byteLength) / json.length) * 100).toFixed(0)}%</strong></div>`;
      });
    },
  },

  // ── 12. Bot Detection ─────────────────────────────────────────────────────
  'bot-detection': {
    title: '🤖 Bot Detection',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Bot Detection (EntropyGuard)</h2>
        <p class="demo-description">
          <strong>EntropyGuard</strong> detects impossibly fast or robotic click cadences by accumulating a
          <em>botScore</em> based on sub-millisecond timing, perfectly uniform intervals, and excessive
          visit rates. When botScore reaches 5, <strong>bot_detected</strong> fires and the session is flagged.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Simulate bot traffic</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
          Fires 50 state transitions in rapid succession — a pattern no human can produce.
        </p>
        <div class="btn-row">
          <button class="btn btn-danger"    id="btn-simulate-bot">🤖 Simulate Bot (50 rapid transitions)</button>
          <button class="btn btn-secondary" id="btn-check-bot-status">🔍 Check Bot Status</button>
        </div>
        <div id="bot-status" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <div class="card-title">Bot score factors</div>
        <table class="data-table">
          <thead><tr><th>Signal</th><th>Score increment</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td>Sub-ms transitions</td><td>+1</td><td>Timing delta &lt; 1ms — physically impossible</td></tr>
            <tr><td>Uniform intervals</td><td>+1</td><td>Identical timing between transitions — scripted</td></tr>
            <tr><td>High visit rate</td><td>+1</td><td>&gt; 30 transitions in &lt; 5 seconds</td></tr>
            <tr><td>Suspiciously round timing</td><td>+1</td><td>Exact 100ms/500ms/1000ms intervals</td></tr>
            <tr><td>No deviation</td><td>+1</td><td>Zero variance in any of the above</td></tr>
          </tbody>
        </table>
      </div>

      ${codeBlock(
        'bot_detected + guard',
        `intent.<span class="fn">on</span>(<span class="str">'bot_detected'</span>, ({ <span class="prop">botScore</span> }) => {
  <span class="cmt">// Stop firing offers, analytics, or A/B experiments for this session</span>
  Session.<span class="fn">flagAsBot</span>();

  <span class="cmt">// Verify server-side before taking action — never trust client alone</span>
  analytics.<span class="fn">track</span>(<span class="str">'suspicious_session'</span>, { botScore });
});

<span class="cmt">// Disable bot protection in CI/E2E tests</span>
<span class="kw">new</span> <span class="fn">IntentManager</span>({ botProtection: <span class="kw">false</span> });`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-simulate-bot')!.addEventListener('click', () => {
        const states = ['/home', '/products', '/cart', '/checkout', '/search', '/blog'];
        for (let i = 0; i < 50; i++) {
          intent.track(states[i % states.length]);
        }
        const t = intent.getTelemetry();
        el.querySelector<HTMLElement>('#bot-status')!.innerHTML =
          `<div class="alert alert-error">50 rapid transitions fired. Bot status: <strong>${t.botStatus}</strong>. Check log for <strong>bot_detected</strong>.</div>`;
      });
      el.querySelector('#btn-check-bot-status')!.addEventListener('click', () => {
        const t = intent.getTelemetry();
        el.querySelector<HTMLElement>('#bot-status')!.innerHTML =
          `<div class="alert ${t.botStatus === 'suspected_bot' ? 'alert-error' : 'alert-success'}">
            Bot status: <strong>${t.botStatus}</strong>
          </div>`;
      });
    },
  },

  // ── 13. Conversion Tracking ───────────────────────────────────────────────
  conversion: {
    title: '💰 Conversion Tracking',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Conversion Tracking</h2>
        <p class="demo-description">
          <strong>trackConversion()</strong> emits a <strong>conversion</strong> event locally. The payload never leaves
          the device unless your listener explicitly sends it. Use it to correlate behavioral signals with
          purchase outcomes — entirely in-browser.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Fire a conversion event</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
          <div>
            <label style="display:block;margin-bottom:4px;font-size:12px">Type</label>
            <select id="conv-type">
              <option value="purchase">purchase</option>
              <option value="signup">signup</option>
              <option value="subscription">subscription</option>
              <option value="add_to_cart">add_to_cart</option>
              <option value="trial_start">trial_start</option>
            </select>
          </div>
          <div>
            <label style="display:block;margin-bottom:4px;font-size:12px">Value</label>
            <input type="number" id="conv-value" value="49.99" />
          </div>
          <div>
            <label style="display:block;margin-bottom:4px;font-size:12px">Currency</label>
            <input type="text" id="conv-currency" value="USD" style="min-width:0;width:80px" />
          </div>
        </div>
        <button class="btn btn-primary" id="btn-track-conversion">💰 Track Conversion</button>
      </div>

      ${codeBlock(
        'trackConversion — local-only revenue tracking',
        `intent.<span class="fn">on</span>(<span class="str">'conversion'</span>, ({ <span class="prop">type</span>, <span class="prop">value</span>, <span class="prop">currency</span> }) => {
  <span class="cmt">// You decide what to do — the engine never sends this anywhere.</span>
  <span class="kw">if</span> (type === <span class="str">'purchase'</span>) {
    <span class="cmt">// Safe to send to YOUR server (GDPR-compliant aggregate):</span>
    analytics.<span class="fn">revenue</span>({ value, currency });
  }
});

intent.<span class="fn">trackConversion</span>({ type: <span class="str">'purchase'</span>, value: <span class="num">49.99</span>, currency: <span class="str">'USD'</span> });`,
      )}
    `,
    setup(el) {
      el.querySelector('#btn-track-conversion')!.addEventListener('click', () => {
        const type = el.querySelector<HTMLSelectElement>('#conv-type')!.value;
        const value = parseFloat(el.querySelector<HTMLInputElement>('#conv-value')!.value);
        const currency = el.querySelector<HTMLInputElement>('#conv-currency')!.value;
        intent.trackConversion({ type, value, currency });
      });
    },
  },

  // ── 14. Session Counters ──────────────────────────────────────────────────
  counters: {
    title: '🔢 Session Counters',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Session Counters</h2>
        <p class="demo-description">
          Exact integer counters scoped to the session. Never persisted. Useful for tracking offer impressions,
          CTA clicks, or how many times a user has seen a specific modal — without any server round-trips.
          Synced cross-tab when <code>crossTabSync</code> is enabled.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Counter controls</div>
        <div class="input-row">
          <input type="text" id="counter-key" value="offer-impressions" />
          <input type="number" id="counter-by" value="1" />
          <button class="btn btn-primary"   id="btn-inc">+Increment</button>
          <button class="btn btn-secondary" id="btn-get">Get</button>
          <button class="btn btn-ghost"     id="btn-reset-counter">Reset</button>
        </div>
        <div id="counter-result" style="margin-top:10px"></div>
      </div>

      <div class="card">
        <div class="card-title">Common use cases</div>
        <div class="btn-row">
          <button class="btn btn-secondary" data-preset-key="offer-impressions" data-preset-by="1">Modal shown (+1)</button>
          <button class="btn btn-secondary" data-preset-key="cta-clicks"         data-preset-by="1">CTA clicked (+1)</button>
          <button class="btn btn-secondary" data-preset-key="pages-viewed"       data-preset-by="1">Page viewed (+1)</button>
          <button class="btn btn-secondary" data-preset-key="cart-items"         data-preset-by="1">Cart item added (+1)</button>
          <button class="btn btn-secondary" data-preset-key="cart-items"         data-preset-by="-1">Cart item removed (-1)</button>
        </div>
        <div id="preset-outputs" style="margin-top:10px"></div>
      </div>

      ${codeBlock(
        'Session Counters API',
        `<span class="cmt">// Track offer impressions — cap at 3 to avoid annoyance</span>
<span class="kw">const</span> shown = intent.<span class="fn">incrementCounter</span>(<span class="str">'offer-impressions'</span>);
<span class="kw">if</span> (shown <= <span class="num">3</span>) Modal.<span class="fn">show</span>(offer);

<span class="cmt">// Track cart quantity</span>
intent.<span class="fn">incrementCounter</span>(<span class="str">'cart-items'</span>,  <span class="num">1</span>);  <span class="cmt">// add</span>
intent.<span class="fn">incrementCounter</span>(<span class="str">'cart-items'</span>, <span class="num">-1</span>);  <span class="cmt">// remove</span>
intent.<span class="fn">getCounter</span>(<span class="str">'cart-items'</span>);              <span class="cmt">// read</span>
intent.<span class="fn">resetCounter</span>(<span class="str">'cart-items'</span>);             <span class="cmt">// reset to 0</span>`,
      )}
    `,
    setup(el) {
      function showCounter(key: string) {
        el.querySelector<HTMLElement>('#counter-result')!.innerHTML =
          `<div class="alert alert-info"><code>${key}</code> = <strong>${intent.getCounter(key)}</strong></div>`;
      }
      el.querySelector('#btn-inc')!.addEventListener('click', () => {
        const key = el.querySelector<HTMLInputElement>('#counter-key')!.value;
        const by = parseInt(el.querySelector<HTMLInputElement>('#counter-by')!.value);
        const v = intent.incrementCounter(key, by);
        el.querySelector<HTMLElement>('#counter-result')!.innerHTML =
          `<div class="alert alert-success"><code>${key}</code> = <strong>${v}</strong></div>`;
      });
      el.querySelector('#btn-get')!.addEventListener('click', () => {
        showCounter(el.querySelector<HTMLInputElement>('#counter-key')!.value);
      });
      el.querySelector('#btn-reset-counter')!.addEventListener('click', () => {
        const key = el.querySelector<HTMLInputElement>('#counter-key')!.value;
        intent.resetCounter(key);
        el.querySelector<HTMLElement>('#counter-result')!.innerHTML =
          `<div class="alert alert-info"><code>${key}</code> reset to <strong>0</strong></div>`;
      });
      el.querySelectorAll<HTMLElement>('[data-preset-key]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.presetKey!;
          const by = parseInt(btn.dataset.presetBy || '1');
          const v = intent.incrementCounter(key, by);
          el.querySelector<HTMLElement>('#preset-outputs')!.innerHTML =
            `<div class="alert alert-info"><code>${key}</code> = <strong>${v}</strong></div>`;
        });
      });
    },
  },

  // ── 15. Cross-Tab Sync ────────────────────────────────────────────────────
  'cross-tab': {
    title: '📡 Cross-Tab Sync',
    render: () => `
      <div class="demo-header">
        <h2 class="demo-title">Cross-Tab Sync</h2>
        <p class="demo-description">
          When <code>crossTabSync: true</code>, verified transitions are broadcast to other tabs via
          <strong>BroadcastChannel</strong>. The shared Markov graph stays consistent even when a user has
          your app open in multiple tabs. No-op in SSR / environments without BroadcastChannel.
        </p>
      </div>

      <div class="card">
        <div class="card-title">How to enable</div>
        <p style="color:var(--text-muted);font-size:13px;line-height:1.7">
          Set <code>crossTabSync: true</code> in the config. The engine creates a <strong>BroadcastChannel</strong>
          named <code>passiveintent-sync</code>. Only transition events are shared — never raw scores or payloads.
          Call <code>destroy()</code> on unmount to close the channel.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Try it: open this demo in two tabs</div>
        <ol style="color:var(--text-muted);font-size:13px;line-height:1.8;padding-left:20px">
          <li>Duplicate this tab in your browser</li>
          <li>Enable cross-tab sync in tab 1 (button below)</li>
          <li>Track states in tab 1 — they appear in tab 2's Markov graph</li>
          <li>Check predictions in tab 2 — they reflect tab 1's navigation</li>
        </ol>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-primary" id="btn-enable-sync">Enable Cross-Tab Sync</button>
          <button class="btn btn-secondary" id="btn-broadcast-state">Broadcast /checkout/payment</button>
        </div>
        <div id="sync-status" style="margin-top:10px"></div>
      </div>

      ${codeBlock(
        'crossTabSync config',
        `<span class="kw">const</span> intent = <span class="kw">new</span> <span class="fn">IntentManager</span>({
  storageKey:   <span class="str">'my-app'</span>,
  crossTabSync: <span class="kw">true</span>,   <span class="cmt">// enables BroadcastChannel</span>
});

<span class="cmt">// Transitions in any tab flow into every tab's graph.</span>
<span class="cmt">// On SPA teardown, always call:</span>
intent.<span class="fn">destroy</span>(); <span class="cmt">// closes BroadcastChannel + removes all listeners</span>

<span class="cmt">// BroadcastSync can also be used standalone:</span>
<span class="kw">import</span> { <span class="type">BroadcastSync</span> } <span class="kw">from</span> <span class="str">'@passiveintent/core'</span>;`,
      )}
    `,
    setup(el) {
      let syncEnabled = false;

      el.querySelector('#btn-enable-sync')!.addEventListener('click', () => {
        if (!('BroadcastChannel' in window)) {
          el.querySelector<HTMLElement>('#sync-status')!.innerHTML =
            `<div class="alert alert-error">BroadcastChannel not supported in this environment. Use a modern browser.</div>`;
          return;
        }
        syncEnabled = !syncEnabled;
        (el.querySelector('#btn-enable-sync') as HTMLButtonElement).textContent = syncEnabled
          ? '✓ Sync Enabled'
          : 'Enable Cross-Tab Sync';
        el.querySelector<HTMLElement>('#sync-status')!.innerHTML =
          `<div class="alert ${syncEnabled ? 'alert-success' : 'alert-info'}">
            ${
              syncEnabled
                ? 'Cross-tab sync conceptually enabled. Open a second tab to see shared graph state after npm publish.'
                : 'Cross-tab sync disabled.'
            }
           </div>`;
      });

      el.querySelector('#btn-broadcast-state')!.addEventListener('click', () => {
        intent.track('/checkout/payment');
        if ('BroadcastChannel' in window) {
          const ch = new BroadcastChannel('passiveintent-demo-manual');
          ch.postMessage({ type: 'demo-transition', state: '/checkout/payment' });
          ch.close();
          el.querySelector<HTMLElement>('#sync-status')!.innerHTML =
            `<div class="alert alert-success">Tracked + broadcast <code>/checkout/payment</code>.</div>`;
        }
      });
    },
  },

  // ── 16. Amazon Playground ─────────────────────────────────────────────────
  'amazon-playground': {
    title: '🛒 Amazon Playground',
    render: () => {
      const products = [
        {
          id: 'p1',
          name: 'Wireless Headphones',
          emoji: '🎧',
          price: 79.99,
          orig: 129.99,
          rating: 4.5,
          reviews: 2341,
          state: '/product/headphones',
        },
        {
          id: 'p2',
          name: 'Mechanical Keyboard',
          emoji: '⌨️',
          price: 149.99,
          orig: 199.99,
          rating: 4.7,
          reviews: 1893,
          state: '/product/keyboard',
        },
        {
          id: 'p3',
          name: 'USB-C Monitor',
          emoji: '🖥️',
          price: 349.99,
          orig: 499.99,
          rating: 4.3,
          reviews: 876,
          state: '/product/monitor',
        },
        {
          id: 'p4',
          name: 'Ergonomic Mouse',
          emoji: '🖱️',
          price: 59.99,
          orig: 89.99,
          rating: 4.6,
          reviews: 3122,
          state: '/product/mouse',
        },
        {
          id: 'p5',
          name: 'Laptop Stand',
          emoji: '💻',
          price: 39.99,
          orig: 59.99,
          rating: 4.4,
          reviews: 1567,
          state: '/product/stand',
        },
        {
          id: 'p6',
          name: 'Webcam HD',
          emoji: '📷',
          price: 89.99,
          orig: 119.99,
          rating: 4.2,
          reviews: 987,
          state: '/product/webcam',
        },
      ];
      return `
        <div class="demo-header">
          <h2 class="demo-title">🛒 E-Commerce Intent Playground</h2>
          <p class="demo-description">
            Browse products, hesitate on prices, rage-click, go idle, or switch tabs.
            Watch <strong>real PassiveIntent signals</strong> trigger business-friendly interventions.
          </p>
        </div>

        <div class="card">
          <div class="card-title">Quick Simulate</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Trigger specific behaviors to see interventions:</p>
          <div class="btn-row">
            <button class="btn btn-secondary" id="btn-browse-back-forth" data-tooltip="Simulates browsing 9 pages with 5s dwell each. Triggers: dwell_time_anomaly, trajectory_anomaly">🔄 Browse Back &amp; Forth</button>
            <button class="btn btn-danger" id="btn-rage-click" data-tooltip="Simulates rapid switching between all products (100ms per click). Triggers: high_entropy">😤 Rage-Click Products</button>
            <button class="btn btn-secondary" id="btn-exit-intent" data-tooltip="Fires the exit_intent lifecycle event. Triggers: exit_intent">🚪 Trigger Exit Intent</button>
            <button class="btn btn-secondary" id="btn-tab-switch" data-tooltip="Simulates tab-switch (pause) and auto-return after 2s. Triggers: attention_return">👁 Tab Away &amp; Return</button>
            <button class="btn btn-secondary" id="btn-jump-payment" data-tooltip="Navigates to the payment page. Linger there to trigger dwell_time_anomaly or hesitation_detected">💳 Jump to Payment</button>
            <button class="btn btn-warning" id="btn-cancel-sub" data-tooltip="Simulates hesitant browsing through cancel pages with 4s dwell. Triggers: hesitation_detected">🚫 Cancel Subscription</button>
            <button class="btn btn-secondary" id="btn-bot-activity" data-tooltip="Simulates rapid bot-like navigation with zero dwell time. Triggers: bot_detected">🤖 Bot Activity</button>
            <button class="btn btn-green" id="btn-back-browse" data-tooltip="Returns to the product browse page. Navigation shortcut — no signal triggered">🏠 Back to Browse</button>
          </div>
          <p style="color:var(--text-muted);font-size:11px;margin-top:8px">
            💡 Tip: Or switch tabs / move mouse above the viewport for real browser-level signals.
            Hover any button for details on what it simulates.
          </p>
        </div>

        <div id="interventions-area"></div>

        <div class="amazon-hero">
          <h2>🛍️ Today's Deals</h2>
          <p>Click products to browse. Hover on prices. Trigger real intent signals.</p>
        </div>

        <div class="amazon-grid" id="product-grid">
          ${products
            .map(
              (p) => `
            <div class="product-card" data-product-state="${p.state}" data-product-name="${p.name}" data-product-emoji="${p.emoji}" data-product-price="${p.price}">
              <div class="product-img">${p.emoji}</div>
              <div class="product-name">${p.name}</div>
              <div>
                <span class="product-price">$${p.price.toFixed(2)}</span>
                <span class="product-price-original">$${p.orig.toFixed(2)}</span>
              </div>
              <div class="product-rating">${'★'.repeat(Math.floor(p.rating))}${'☆'.repeat(5 - Math.floor(p.rating))} (${p.reviews.toLocaleString()})</div>
              <div style="margin-top:8px">
                <button class="btn btn-primary btn-sm" data-add-cart="${p.state}">Add to Cart</button>
              </div>
            </div>
          `,
            )
            .join('')}
        </div>

        <div id="product-detail"></div>

        <div class="card" style="margin-top:24px">
          <div class="card-title">📋 Signal → Business Action Mapping</div>
          <table class="data-table">
            <thead><tr><th>User Behavior</th><th>PassiveIntent Signal</th><th>Proposed Action</th></tr></thead>
            <tbody>
              <tr><td>Hovers on price, pauses 3s+</td><td><code>dwell_time_anomaly</code></td><td>🚚 Free Shipping tooltip</td></tr>
              <tr><td>Rage-clicks between products</td><td><code>high_entropy</code></td><td>💬 Open Zendesk chat</td></tr>
              <tr><td>Unusual navigation path</td><td><code>trajectory_anomaly</code></td><td>⚖️ Compare side-by-side</td></tr>
              <tr><td>Mouse to browser tabs</td><td><code>exit_intent</code></td><td>🏷️ 10% off overlay</td></tr>
              <tr><td>Tab away, return after 15s+</td><td><code>attention_return</code></td><td>👋 Welcome back banner</td></tr>
              <tr><td>Hesitates on checkout form</td><td><code>hesitation_detected</code></td><td>🛡️ Money-back guarantee</td></tr>
              <tr><td>Goes idle for 30s+</td><td><code>user_idle</code></td><td>⏳ Still shopping? nudge</td></tr>
              <tr><td>Hesitates on cancel page</td><td><code>hesitation_detected</code></td><td>🚫 "3 months free" retention offer</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-title">🧪 Manual Testing Guide</div>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
            Verify signals are real — trigger each intervention yourself without simulation buttons:
          </p>
          <div class="alert alert-info" style="margin-bottom:12px;font-size:12px">
            <strong>📊 Probabilistic engine, not hardcoded rules.</strong> Every signal is derived from
            live mathematics: first-order Markov chain transition probabilities, Shannon entropy,
            Bayesian (Dirichlet) smoothing, and z-scores against a pre-trained baseline.
            The engine needs a warm-up period to build enough observations — signals may not fire
            immediately and exact thresholds will vary across sessions as the model learns.
            Results are expected to differ from the Quick Simulate buttons, which fast-forward
            time to satisfy the statistical requirements deterministically.
          </div>
          <div class="manual-guide">
            <ul class="manual-guide-list">
              <li>
                <span class="guide-signal">exit_intent</span>
                <strong>Exit Intent</strong>
                <div class="guide-steps">
                  Move your mouse cursor above the top edge of the browser viewport (toward the tab bar).
                  The browser's mouseleave event fires the signal. You should see the "10% off" overlay.
                </div>
              </li>
              <li>
                <span class="guide-signal">attention_return</span>
                <strong>Tab Away &amp; Return</strong>
                <div class="guide-steps">
                  Switch to another browser tab (Ctrl+Tab / Cmd+Tab), wait at least 2 seconds, then switch back.
                  The Page Visibility API detects the absence and fires "Welcome back!" on return.
                </div>
              </li>
              <li>
                <span class="guide-signal">dwell_time_anomaly</span>
                <strong>Dwell Time Anomaly</strong>
                <div class="guide-steps">
                  Click a product card, then stay on the page without clicking anything for 5+ seconds.
                  Click another product and wait again. After 3-4 products, the engine has enough samples to detect
                  abnormally long pauses and shows the "Free Shipping" tooltip.
                </div>
              </li>
              <li>
                <span class="guide-signal">high_entropy</span>
                <strong>Rage Clicks</strong>
                <div class="guide-steps">
                  Rapidly click between many different product cards (15+ quick clicks spread across all 6 products).
                  This spreads the transition probability mass and raises Shannon entropy, triggering the "Need help? Chat with us!" prompt.
                </div>
              </li>
              <li>
                <span class="guide-signal">trajectory_anomaly</span>
                <strong>Unusual Navigation</strong>
                <div class="guide-steps">
                  Navigate in an unusual order — click a product, go back to browse, jump to a completely different product,
                  go back again, then jump to payment. Unusual transitions that deviate from the e-commerce baseline trigger
                  the "Compare side by side?" suggestion.
                </div>
              </li>
              <li>
                <span class="guide-signal">user_idle</span>
                <strong>Idle Detection</strong>
                <div class="guide-steps">
                  Stop all mouse and keyboard activity for 30+ seconds. The engine detects inactivity and shows the
                  "Still shopping?" nudge.
                </div>
              </li>
              <li>
                <span class="guide-signal">hesitation_detected</span>
                <strong>Checkout Hesitation</strong>
                <div class="guide-steps">
                  Click a product, Add to Cart, Proceed to Payment, then hover over the form fields and pause for 5+ seconds.
                  Navigate back and forth between cart and payment. The combination of dwell time and unusual trajectory
                  triggers the "Money-back guarantee" reassurance.
                </div>
              </li>
            </ul>
          </div>
        </div>
      `;
    },
    setup(el) {
      intent.track('/amazon/home');
      const interventionsArea = el.querySelector<HTMLElement>('#interventions-area')!;
      let interventionCount = 0;

      function pushIntervention(
        type: string,
        icon: string,
        title: string,
        body: string,
        trigger: string,
      ) {
        interventionCount++;
        const id = `iv-${interventionCount}`;
        const existing = interventionsArea.querySelector('.card') as HTMLElement | null;
        if (!existing) {
          interventionsArea.innerHTML = `<div class="card"><div class="card-title">🎯 Triggered Interventions</div><div id="iv-list"></div></div>`;
        }
        const list = interventionsArea.querySelector('#iv-list')!;
        const div = document.createElement('div');
        div.className = `intervention intervention-${type}`;
        div.id = id;
        div.innerHTML = `
          <span class="intervention-icon">${icon}</span>
          <div class="intervention-body"><h4>${title}</h4><p>${body}</p>
            <span class="badge badge-purple" style="margin-top:4px;display:inline-block;font-size:10px">Signal: ${trigger}</span>
          </div>
          <button class="intervention-dismiss" data-dismiss="${id}">✕</button>
        `;
        list.prepend(div);
        // Cap at 8
        while (list.children.length > 8 && list.lastChild) list.removeChild(list.lastChild);
      }

      // Dismiss handler (delegated)
      interventionsArea.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('[data-dismiss]') as HTMLElement | null;
        if (btn) {
          const target = document.getElementById(btn.dataset.dismiss!);
          target?.remove();
        }
      });

      // Wire up signals → interventions
      const unsubs = [
        intent.on('dwell_time_anomaly', (p: unknown) => {
          const payload = p as { state: string; dwellMs: number; zScore: number };
          pushIntervention(
            'free-shipping',
            '🚚',
            'Free Shipping on orders over $50!',
            `You paused on "${payload.state}" for ${Math.round(payload.dwellMs)}ms — z-score: ${payload.zScore.toFixed(1)}`,
            'dwell_time_anomaly',
          );
        }),
        intent.on('high_entropy', (p: unknown) => {
          const payload = p as { state: string; normalizedEntropy: number };
          pushIntervention(
            'zendesk',
            '💬',
            'Need help? Chat with us!',
            `Rapid navigation detected on "${payload.state}" — entropy: ${payload.normalizedEntropy.toFixed(2)}`,
            'high_entropy',
          );
        }),
        intent.on('trajectory_anomaly', (p: unknown) => {
          const payload = p as { stateFrom: string; stateTo: string; zScore: number };
          pushIntervention(
            'compare',
            '⚖️',
            'Compare these products side by side?',
            `Unusual path ${payload.stateFrom} → ${payload.stateTo} (z-score: ${payload.zScore.toFixed(1)})`,
            'trajectory_anomaly',
          );
        }),
        intent.on('exit_intent', (p: unknown) => {
          const payload = p as { state: string; likelyNext: string | null };
          pushIntervention(
            'discount',
            '🏷️',
            "Wait — here's 10% off your order!",
            `Exit intent from "${payload.state}" — likely next: ${payload.likelyNext ?? 'unknown'}`,
            'exit_intent',
          );
        }),
        intent.on('attention_return', (p: unknown) => {
          const payload = p as { state: string; hiddenDuration: number };
          const secs = Math.round(payload.hiddenDuration / 1000);
          pushIntervention(
            'welcome-back',
            '👋',
            'Welcome back! Still interested?',
            `You were away for ${secs}s from "${payload.state}"`,
            'attention_return',
          );
        }),
        intent.on('hesitation_detected', (p: unknown) => {
          const payload = p as { state: string; dwellZScore: number; trajectoryZScore: number };
          if (payload.state.includes('cancel')) {
            pushIntervention(
              'cancel-sub',
              '🚫',
              "We'd hate to see you go — 3 months free!",
              `Hesitation on "${payload.state}" — dwell z: ${payload.dwellZScore.toFixed(1)}, trajectory z: ${payload.trajectoryZScore.toFixed(1)}`,
              'hesitation_detected',
            );
          } else {
            pushIntervention(
              'guarantee',
              '🛡️',
              '100% money-back guarantee',
              `Hesitation on "${payload.state}" — dwell z: ${payload.dwellZScore.toFixed(1)}, trajectory z: ${payload.trajectoryZScore.toFixed(1)}`,
              'hesitation_detected',
            );
          }
        }),
        intent.on('user_idle', () => {
          pushIntervention(
            'idle',
            '⏳',
            'Still shopping?',
            "You've been idle. We saved your cart!",
            'user_idle',
          );
        }),
      ];

      // Product clicks → track
      el.querySelectorAll<HTMLElement>('.product-card').forEach((card) => {
        card.addEventListener('click', () => {
          const state = card.dataset.productState!;
          intent.track(state);
          el.querySelectorAll<HTMLElement>('.product-card').forEach((c) =>
            c.classList.remove('active'),
          );
          card.classList.add('active');
          el.querySelector<HTMLElement>('#product-detail')!.innerHTML = `
            <div class="checkout-section">
              <h3>${card.dataset.productEmoji} ${card.dataset.productName}</h3>
              <p style="color:var(--text-muted);margin-bottom:12px">Viewing product — dwell time and navigation being tracked.</p>
              <div class="metrics-grid" style="margin-bottom:16px">
                <div class="metric-card"><div class="metric-value" style="color:#ff9900">$${parseFloat(card.dataset.productPrice!).toFixed(2)}</div><div class="metric-label">Price</div></div>
              </div>
              <button class="btn btn-primary" data-add-cart="${state}">🛒 Add to Cart</button>
            </div>
          `;
        });
      });

      // Add to cart → track
      el.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('[data-add-cart]') as HTMLElement | null;
        if (btn) {
          intent.track('/amazon/cart');
          intent.incrementCounter('cart-items', 1);
        }
      });

      // Quick simulate buttons — async with frame yields for reactivity
      const simBtns = el.querySelectorAll<HTMLButtonElement>(
        '#btn-browse-back-forth,#btn-rage-click,#btn-exit-intent,#btn-tab-switch,#btn-cancel-sub,#btn-jump-payment,#btn-bot-activity,#btn-back-browse',
      );
      function setPlaygroundBtns(disabled: boolean) {
        simBtns.forEach((b) => (b.disabled = disabled));
      }
      async function runPlaygroundSim(fn: () => Promise<void>) {
        if (_simRunning) return;
        _simRunning = true;
        _cooldownActive = false;
        setPlaygroundBtns(true);
        setSimButtons(true);
        try {
          await fn();
        } finally {
          timer.resetOffset();
          _simRunning = false;
          setPlaygroundBtns(false);
          setSimButtons(false);
          _cooldownActive = true;
          if (_cooldownTimer) clearTimeout(_cooldownTimer);
          _cooldownTimer = setTimeout(() => {
            _cooldownActive = false;
          }, COOLDOWN_DURATION);
        }
      }

      el.querySelector('#btn-browse-back-forth')?.addEventListener('click', () => {
        runPlaygroundSim(async () => {
          const states = [
            '/amazon/home',
            '/amazon/deals',
            '/product/headphones',
            '/amazon/home',
            '/product/keyboard',
            '/amazon/deals',
            '/amazon/home',
            '/product/monitor',
            '/amazon/home',
          ];
          for (let i = 0; i < states.length; i++) {
            timer.fastForward(5000);
            intent.track(states[i]);
            if (i % 3 === 2) await yieldFrame();
          }
        });
      });
      el.querySelector('#btn-rage-click')?.addEventListener('click', () => {
        runPlaygroundSim(async () => {
          const productStates = [
            '/product/headphones',
            '/product/keyboard',
            '/product/monitor',
            '/product/mouse',
            '/product/stand',
            '/product/webcam',
          ];
          const hub = '/amazon/home';
          for (let round = 0; round < 3; round++) {
            for (const ps of productStates) {
              timer.fastForward(100);
              intent.track(hub);
              timer.fastForward(100);
              intent.track(ps);
            }
            await yieldFrame();
          }
        });
      });
      el.querySelector('#btn-exit-intent')?.addEventListener('click', () => {
        lifecycle.triggerExitIntent();
      });
      el.querySelector('#btn-tab-switch')?.addEventListener('click', () => {
        lifecycle.triggerPause();
        globalThis.setTimeout(() => lifecycle.triggerResume(), 2000);
      });
      el.querySelector('#btn-cancel-sub')?.addEventListener('click', () => {
        runPlaygroundSim(async () => {
          const cancelPath = [
            '/account/settings',
            '/account/cancel-subscription',
            '/account/cancel-subscription',
            '/account/cancel-subscription/reason',
            '/account/cancel-subscription',
            '/account/cancel-subscription/confirm',
            '/account/cancel-subscription',
            '/account/cancel-subscription/confirm',
          ];
          for (let i = 0; i < cancelPath.length; i++) {
            timer.fastForward(4000);
            intent.track(cancelPath[i]);
            if (i % 3 === 2) await yieldFrame();
          }
        });
      });
      el.querySelector('#btn-jump-payment')?.addEventListener('click', () => {
        intent.track('/amazon/checkout/payment');
      });
      el.querySelector('#btn-bot-activity')?.addEventListener('click', () => {
        runPlaygroundSim(async () => {
          const productStates = [
            '/product/headphones',
            '/product/keyboard',
            '/product/monitor',
            '/product/mouse',
            '/product/stand',
            '/product/webcam',
          ];
          for (let round = 0; round < 3; round++) {
            for (const ps of productStates) {
              intent.track(ps);
            }
            intent.track('/amazon/home');
            intent.track('/amazon/deals');
            intent.track('/amazon/cart');
            await yieldFrame();
          }
        });
      });
      el.querySelector('#btn-back-browse')?.addEventListener('click', () => {
        intent.track('/amazon/home');
      });

      return () => {
        unsubs.forEach((u) => u());
      };
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function codeBlock(label: string, code: string): string {
  return `<div class="code-block"><div class="code-label">${label}</div><pre>${code}</pre></div>`;
}

function buildEcommerceBaseline(): SerializedMarkovGraph {
  const g = new MarkovGraph({ maxStates: 100 });
  const funnels: [string, string][][] = [
    [
      ['/home', '/products'],
      ['/products', '/product/item'],
      ['/product/item', '/cart'],
      ['/cart', '/checkout/payment'],
      ['/checkout/payment', '/thank-you'],
    ],
    [
      ['/home', '/pricing'],
      ['/pricing', '/checkout/payment'],
      ['/checkout/payment', '/thank-you'],
    ],
    [
      ['/home', '/products'],
      ['/products', '/product/item'],
      ['/product/item', '/checkout/payment'],
      ['/checkout/payment', '/thank-you'],
    ],
    [
      ['/home', '/blog'],
      ['/blog', '/products'],
      ['/products', '/cart'],
      ['/cart', '/checkout/payment'],
    ],
  ];
  // Build 50 simulated sessions
  for (let i = 0; i < 50; i++) {
    const funnel = funnels[i % funnels.length];
    for (const [from, to] of funnel) {
      g.incrementTransition(from, to);
    }
  }
  return g.toJSON() as SerializedMarkovGraph;
}

// ─── Intent Meter ─────────────────────────────────────────────────────────────
const meterState = { rage: 0, anxiety: 0, hesitation: 0, bot: 0, idle: 0, exit: 0 };
const METER_DECAY = 0.5;
const COOLDOWN_DECAY = 3;
const COOLDOWN_DURATION = 8_000; // ms of accelerated decay after a sim
let _cooldownActive = false;
let _cooldownTimer: ReturnType<typeof setTimeout> | null = null;

function updateMeterGauge(name: string, value: number) {
  const v = Math.max(0, Math.min(100, value));
  (meterState as Record<string, number>)[name] = v;
  const fill = document.getElementById(`gauge-${name}`);
  const valEl = document.getElementById(`gauge-${name}-val`);
  if (fill) {
    fill.style.height = `${v}%`;
    fill.style.background = getGaugeColor(name);
    fill.style.boxShadow = v > 50 ? `0 0 8px ${getGaugeColor(name)}` : 'none';
  }
  if (valEl) valEl.textContent = `${Math.round(v)}%`;
}

function getGaugeColor(name: string): string {
  switch (name) {
    case 'rage':
      return 'var(--red)';
    case 'anxiety':
      return 'var(--yellow)';
    case 'hesitation':
      return 'var(--purple)';
    case 'bot':
      return 'var(--red)';
    case 'idle':
      return 'var(--text-muted)';
    case 'exit':
      return 'var(--blue)';
    default:
      return 'var(--accent)';
  }
}

// Decay meters
setInterval(() => {
  const amt = _cooldownActive ? COOLDOWN_DECAY : METER_DECAY;
  for (const key of ['rage', 'anxiety', 'hesitation', 'exit'] as const) {
    if ((meterState as Record<string, number>)[key] > 0) {
      updateMeterGauge(key, (meterState as Record<string, number>)[key] - amt);
    }
  }
  // Bot from telemetry
  const t = intent.getTelemetry();
  updateMeterGauge('bot', t.botStatus === 'suspected_bot' ? 100 : 0);
}, 200);

// Wire events to meter
intent.on('high_entropy', (p) => {
  const payload = p as { normalizedEntropy: number };
  updateMeterGauge('rage', payload.normalizedEntropy * 100);
});
intent.on('dwell_time_anomaly', (p) => {
  const payload = p as { zScore: number };
  updateMeterGauge('hesitation', Math.min(payload.zScore * 25, 100));
});
intent.on('hesitation_detected', (p) => {
  const payload = p as { dwellZScore: number; trajectoryZScore: number };
  const combined = (Math.abs(payload.dwellZScore) + Math.abs(payload.trajectoryZScore)) / 2;
  updateMeterGauge('hesitation', combined * 25);
});
intent.on('trajectory_anomaly', (p) => {
  const payload = p as { zScore: number };
  updateMeterGauge('anxiety', Math.abs(payload.zScore) * 25);
});
intent.on('exit_intent', () => updateMeterGauge('exit', 100));
intent.on('user_idle', () => updateMeterGauge('idle', 100));
intent.on('user_resumed', () => updateMeterGauge('idle', 0));

// Drag handle for meter repositioning
{
  const meter = document.getElementById('intent-meter')!;
  const handle = document.getElementById('meter-drag-handle')!;
  const translate = { x: 0, y: 0 };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = translate.x;
    const origY = translate.y;

    const onMove = (ev: MouseEvent) => {
      translate.x = origX + ev.clientX - startX;
      translate.y = origY + ev.clientY - startY;
      meter.style.transform = `translate(${translate.x}px, ${translate.y}px)`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// Per-gauge Quick Simulate buttons
const RAGE_SIM_STATES = [
  '/sim/rage/a',
  '/sim/rage/b',
  '/sim/rage/c',
  '/sim/rage/d',
  '/sim/rage/e',
  '/sim/rage/f',
];

const yieldFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
let _simRunning = false;

/** Guard against concurrent sims; disable all sim buttons while running. */
function setSimButtons(disabled: boolean) {
  for (const id of [
    'sim-rage',
    'sim-anxiety',
    'sim-hesitation',
    'sim-bot',
    'sim-idle',
    'sim-exit',
  ]) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = disabled;
  }
}

async function runSim(fn: () => Promise<void>) {
  if (_simRunning) return;
  _simRunning = true;
  _cooldownActive = false;
  setSimButtons(true);
  try {
    await fn();
  } finally {
    timer.resetOffset();
    _simRunning = false;
    setSimButtons(false);
    // Enter cooldown — accelerated decay settles gauges toward baseline
    _cooldownActive = true;
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    _cooldownTimer = setTimeout(() => {
      _cooldownActive = false;
    }, COOLDOWN_DURATION);
  }
}

document.getElementById('sim-rage')!.addEventListener('click', () => {
  runSim(async () => {
    const hub = '/sim/rage/hub';
    for (let round = 0; round < 3; round++) {
      for (const s of RAGE_SIM_STATES) {
        timer.fastForward(100);
        intent.track(hub);
        timer.fastForward(100);
        intent.track(s);
      }
      await yieldFrame();
    }
  });
});

document.getElementById('sim-anxiety')!.addEventListener('click', () => {
  runSim(async () => {
    const oddPath = [
      '/sim/anxiety/checkout',
      '/sim/anxiety/faq',
      '/sim/anxiety/refund-policy',
      '/sim/anxiety/checkout',
      '/sim/anxiety/compare',
      '/sim/anxiety/checkout',
      '/sim/anxiety/faq',
      '/sim/anxiety/compare',
      '/sim/anxiety/refund-policy',
      '/sim/anxiety/checkout',
      '/sim/anxiety/faq',
      '/sim/anxiety/compare',
      '/sim/anxiety/checkout',
      '/sim/anxiety/refund-policy',
      '/sim/anxiety/faq',
      '/sim/anxiety/compare',
      '/sim/anxiety/checkout',
      '/sim/anxiety/faq',
      '/sim/anxiety/refund-policy',
      '/sim/anxiety/compare',
    ];
    for (let i = 0; i < oddPath.length; i++) {
      timer.fastForward(2000);
      intent.track(oddPath[i]);
      if (i % 5 === 4) await yieldFrame();
    }
  });
});

document.getElementById('sim-hesitation')!.addEventListener('click', () => {
  runSim(async () => {
    const a = '/sim/hes/browse';
    const b = '/sim/hes/checkout';
    for (let i = 0; i < 6; i++) {
      timer.fastForward(3000);
      intent.track(a);
      timer.fastForward(3000);
      intent.track(b);
      if (i % 2 === 1) await yieldFrame();
    }
    await yieldFrame();
    for (let i = 0; i < 2; i++) {
      timer.fastForward(30000);
      intent.track(a);
      timer.fastForward(30000);
      intent.track(b);
      await yieldFrame();
    }
  });
});

document.getElementById('sim-bot')!.addEventListener('click', () => {
  runSim(async () => {
    for (let i = 0; i < 12; i++) {
      intent.track(`/sim/bot/${i}`);
    }
  });
});

document.getElementById('sim-idle')!.addEventListener('click', () => {
  runSim(async () => {
    intent.track('/sim/idle/page');
    timer.fastForward(130_000);
  });
});

document.getElementById('sim-exit')!.addEventListener('click', () => {
  runSim(async () => {
    lifecycle.triggerExitIntent();
  });
});

// ─── Navigation ───────────────────────────────────────────────────────────────
let activeDemo = 'overview';
let activeCleanup: (() => void) | void = undefined;

function navigateTo(demoKey: string): void {
  if (!demos[demoKey]) return;

  // Update nav active state
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.demo === demoKey);
  });

  // Cleanup previous demo
  if (typeof activeCleanup === 'function') activeCleanup();

  activeDemo = demoKey;
  const demo = demos[demoKey];
  const contentEl = document.getElementById('content')!;
  contentEl.innerHTML = demo.render();
  activeCleanup = demo.setup(contentEl);
}

// Wire up sidebar
document.querySelectorAll<HTMLElement>('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.demo!));
});

// Collapsible sidebar
{
  const sidebarEl = document.getElementById('sidebar')!;
  const layoutEl = sidebarEl.parentElement!;
  const collapseBtn = document.getElementById('sidebar-collapse')!;
  const expandBtn = document.getElementById('sidebar-expand')!;

  collapseBtn.addEventListener('click', () => {
    sidebarEl.classList.add('sidebar--hidden');
    layoutEl.classList.add('sidebar-collapsed');
    expandBtn.style.display = '';
  });
  expandBtn.addEventListener('click', () => {
    sidebarEl.classList.remove('sidebar--hidden');
    layoutEl.classList.remove('sidebar-collapsed');
    expandBtn.style.display = 'none';
  });
}

// Collapsible event log
{
  const logEl = document.getElementById('event-log')!;
  const layoutEl = logEl.parentElement!;
  const collapseBtn = document.getElementById('log-collapse')!;
  const expandBtn = document.getElementById('log-expand')!;

  collapseBtn.addEventListener('click', () => {
    logEl.classList.add('event-log--hidden');
    layoutEl.classList.add('log-collapsed');
    expandBtn.style.display = '';
  });
  expandBtn.addEventListener('click', () => {
    logEl.classList.remove('event-log--hidden');
    layoutEl.classList.remove('log-collapsed');
    expandBtn.style.display = 'none';
  });
}

// Initial render
navigateTo('overview');
