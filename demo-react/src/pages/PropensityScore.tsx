/**
 * PropensityScore — Interactive Real-Time Conversion Readiness Demo
 *
 * Demonstrates PropensityCalculator combining:
 *   1. Markov hitting probability (BFS over a live graph)
 *   2. Welford Z-score friction penalty  exp(−α × max(0, z))
 *
 * Into a single [0, 1] score: "How likely is this session to convert?"
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PropensityCalculator, MarkovGraph } from '@passiveintent/react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { TrajectoryAnomalyPayload } from '@passiveintent/react';

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET = '/thank-you';
const ALPHA = 0.2;

type FunnelPage = { route: string; label: string; icon: string };

const FUNNEL: FunnelPage[] = [
  { route: '/home', label: 'Home', icon: '🏠' },
  { route: '/products', label: 'Products', icon: '🛍' },
  { route: '/product/headphones', label: 'Product', icon: '🎧' },
  { route: '/cart', label: 'Cart', icon: '🛒' },
  { route: '/checkout/payment', label: 'Checkout', icon: '💳' },
  { route: '/thank-you', label: 'Thank You', icon: '🎉' },
];

const DETOURS: FunnelPage[] = [
  { route: '/support', label: 'Support', icon: '💬' },
  { route: '/faq', label: 'FAQ', icon: '❓' },
  { route: '/returns', label: 'Returns', icon: '↩' },
  { route: '/404', label: '404', icon: '🚫' },
];

const FRICTION_PRESETS = [
  { label: '✅ No friction', z: 0 },
  { label: '😐 Mild', z: 1.5 },
  { label: '😟 Diverging', z: 3.5 },
  { label: '😱 High', z: 6.0 },
  { label: '💀 Critical', z: 9.0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(s: number) {
  if (s >= 0.65) return 'var(--green)';
  if (s >= 0.35) return 'var(--yellow)';
  return 'var(--red)';
}

function tierInfo(s: number): { tier: string; action: string } {
  if (s >= 0.75)
    return { tier: 'High Propensity', action: '✅ On track — no intervention needed.' };
  if (s >= 0.55)
    return { tier: 'Moderate', action: '🎁 Show a free-shipping banner or social proof.' };
  if (s >= 0.35) return { tier: 'At Risk', action: '⏳ Trigger a limited-time 10 % discount.' };
  if (s >= 0.15)
    return { tier: 'Low Propensity', action: '💬 Open a live-chat prompt or money-back offer.' };
  return { tier: 'Critical', action: '🚪 Last-chance exit-intent overlay before they leave.' };
}

// ── IStateModel adapter — PropensityCalculator only calls getLikelyNext ────────

function makeStateModel(graph: MarkovGraph) {
  // Satisfies IStateModel structurally; only getLikelyNext is exercised by
  // PropensityCalculator.updateBaseline — the rest are required by the type.
  return {
    markSeen(_s: string): void {},
    hasSeen(_s: string): boolean {
      return false;
    },
    recordTransition(_f: string, _t: string): void {},
    getLikelyNext(state: string, threshold: number) {
      return graph.getLikelyNextStates(state, threshold);
    },
    evaluateEntropy(_s: string) {
      return { entropy: 0, normalizedEntropy: 0, isHigh: false } as const;
    },
    evaluateTrajectory(_f: string, _t: string, _traj: readonly string[]) {
      return null;
    },
    serialize(): string {
      return '';
    },
    restore(_d: string): void {},
  };
}

// ── Score arc (SVG) ───────────────────────────────────────────────────────────

function ScoreArc({ score, size = 160 }: { score: number; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - 18) / 2;
  const circ = 2 * Math.PI * r;
  const dash = score * circ;

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={12} />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={scoreColor(score)}
        strokeWidth={12}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        style={{ transition: 'stroke-dasharray 0.45s cubic-bezier(.4,0,.2,1), stroke 0.4s ease' }}
      />
    </svg>
  );
}

// ── Score history sparkline ───────────────────────────────────────────────────

function Sparkline({ history }: { history: number[] }) {
  if (history.length < 2) return null;
  const peak = Math.max(...history, 0.01);
  return (
    <div className="sparkline-wrap">
      <span className="sparkline-label">Score history</span>
      <div className="sparkline">
        {history.map((s, i) => (
          <div
            key={i}
            className="spark-bar"
            style={{
              height: `${(s / peak) * 100}%`,
              background: scoreColor(s),
              opacity: 0.35 + 0.65 * (i / history.length),
            }}
            title={`${Math.round(s * 100)}%`}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PropensityScore() {
  const { track, on } = useIntent();

  // Stable refs: graph + calculator are created once per component lifetime
  const graphRef = useRef<MarkovGraph | null>(null);
  const calcRef = useRef<PropensityCalculator | null>(null);

  if (!graphRef.current) {
    const g = new MarkovGraph({ maxStates: 200, smoothingAlpha: 0 });

    // Pre-train: 20 historical checkout sessions along the main funnel
    const mainPath: [string, string][] = [
      ['/home', '/products'],
      ['/products', '/product/headphones'],
      ['/product/headphones', '/cart'],
      ['/cart', '/checkout/payment'],
      ['/checkout/payment', '/thank-you'],
    ];
    for (let i = 0; i < 20; i++) {
      for (const [a, b] of mainPath) g.incrementTransition(a, b);
    }
    // Realistic alternative paths (add variety without swamping the main funnel)
    for (let i = 0; i < 4; i++) {
      g.incrementTransition('/home', '/pricing');
      g.incrementTransition('/products', '/cart'); // skip product page
      g.incrementTransition('/product/headphones', '/checkout/payment'); // skip cart
    }

    graphRef.current = g;
    calcRef.current = new PropensityCalculator(ALPHA, 0); // throttleMs=0 for demo
  }

  // ── Component state ───────────────────────────────────────────────────────
  const [currentRoute, setCurrentRoute] = useState('/home');
  const [navHistory, setNavHistory] = useState<string[]>(['/home']);
  const [pReach, setPReach] = useState(0);
  const [frictionPct, setFrictionPct] = useState(1);
  const [propensity, setPropensity] = useState(0);
  const [liveZ, setLiveZ] = useState(0);
  const [manualZ, setManualZ] = useState(0);
  const [useManual, setUseManual] = useState(false);
  const [scoreHist, setScoreHist] = useState<number[]>([]);

  const effectiveZ = useManual ? manualZ : liveZ;

  // ── Subscribe to live trajectory z-score ──────────────────────────────────
  useEffect(() => {
    return on('trajectory_anomaly', (p) => {
      const z = (p as Partial<TrajectoryAnomalyPayload> | null | undefined)?.zScore;
      setLiveZ(typeof z === 'number' && Number.isFinite(z) ? z : 0);
    });
  }, [on]);

  // ── Recompute score ───────────────────────────────────────────────────────
  const recompute = useCallback((route: string, z: number) => {
    const calc = calcRef.current!;
    const graph = graphRef.current!;

    // BFS — computes and caches P_reach for (route → TARGET)
    calc.updateBaseline(makeStateModel(graph), route, TARGET, 5);

    // P_reach = score with z=0  (exp(-α×0) = 1, so penalty is neutral)
    const reach = calc.getRealTimePropensity(0);
    // Friction factor computed directly for display (avoids second throttled call)
    const fr = Math.exp(-ALPHA * Math.max(0, z));
    const score = reach * fr;

    setPReach(reach);
    setFrictionPct(fr);
    setPropensity(score);
    setScoreHist((prev) => [...prev.slice(-23), score]);
  }, []);

  // Recompute whenever route or z-score changes (covers bootstrap, navigation, and slider)
  useEffect(() => {
    recompute(currentRoute, effectiveZ);
  }, [effectiveZ, recompute, currentRoute]);

  // ── Navigation handlers ───────────────────────────────────────────────────
  const navigateTo = useCallback(
    (page: FunnelPage) => {
      if (page.route === currentRoute) return;
      graphRef.current!.incrementTransition(currentRoute, page.route);
      track(page.route);
      setCurrentRoute(page.route);
      setNavHistory((prev) => [...prev, page.route]);
    },
    [currentRoute, track],
  );

  const resetJourney = useCallback(() => {
    setCurrentRoute('/home');
    setNavHistory(['/home']);
    setLiveZ(0);
    if (!useManual) setManualZ(0);
  }, [useManual]);

  const { tier, action } = tierInfo(propensity);
  const color = scoreColor(propensity);

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ─────────────────── Header ─────────────────────────────────── */}
      <div className="demo-header">
        <div className="hook-callout">📐 new PropensityCalculator(alpha?, throttleMs?)</div>
        <h2 className="demo-title">Propensity Score</h2>
        <p className="demo-description">
          Combines a <strong>Markov hitting-probability BFS</strong> — how structurally likely is
          the user to reach checkout? — with a <strong>Welford Z-score friction penalty</strong> —
          how much does their trajectory deviate from healthy baseline? Navigate the funnel and
          inject friction to see the score respond in real time.
        </p>
      </div>

      {/* ─────────────────── Score ring + formula ───────────────────── */}
      <div className="propensity-top-grid">
        {/* Left: score ring */}
        <div className="card propensity-score-card">
          <div className="card-title">Live Propensity Score</div>
          <div className="propensity-ring-wrap">
            <ScoreArc score={propensity} size={160} />
            <div className="propensity-ring-center">
              <span className="propensity-pct" style={{ color }}>
                {Math.round(propensity * 100)}%
              </span>
              <span className="propensity-tier-label" style={{ color }}>
                {tier}
              </span>
            </div>
          </div>
          <p className="propensity-action-text">{action}</p>
          <Sparkline history={scoreHist} />
        </div>

        {/* Right: formula decomposition */}
        <div className="card propensity-formula-card">
          <div className="card-title">Formula Breakdown</div>
          <div className="formula-row">
            <div className="formula-factor">
              <span className="formula-sym">
                P<sub>reach</sub>
              </span>
              <span className="formula-val" style={{ color: 'var(--blue)' }}>
                {(pReach * 100).toFixed(1)}%
              </span>
              <span className="formula-hint">
                Markov BFS hitting probability
                <br />
                <code>{currentRoute}</code> → <code>{TARGET}</code>
              </span>
            </div>

            <span className="formula-op">×</span>

            <div className="formula-factor">
              <span className="formula-sym">
                e<sup>−αz</sup>
              </span>
              <span
                className="formula-val"
                style={{ color: effectiveZ > 2 ? 'var(--yellow)' : 'var(--green)' }}
              >
                {(frictionPct * 100).toFixed(1)}%
              </span>
              <span className="formula-hint">
                Friction penalty
                <br />
                α={ALPHA}, z={effectiveZ.toFixed(2)}
              </span>
            </div>

            <span className="formula-op">=</span>

            <div className="formula-factor formula-factor--result">
              <span className="formula-sym">Score</span>
              <span className="formula-val" style={{ color }}>
                {(propensity * 100).toFixed(1)}%
              </span>
              <span className="formula-hint">
                Combined propensity
                <br />
                always in [0, 1]
              </span>
            </div>
          </div>

          {/* Reference table */}
          <table className="data-table" style={{ marginTop: 20 }}>
            <thead>
              <tr>
                <th>Z</th>
                <th>Penalty (α=0.2)</th>
                <th>Interpretation</th>
              </tr>
            </thead>
            <tbody>
              {[
                { z: 0, note: 'No anomaly — full propensity' },
                { z: 1.5, note: 'Minor deviation' },
                { z: 3.5, note: 'Divergence threshold — score halved' },
                { z: 6.9, note: 'Severe — score quartered' },
                { z: 10.0, note: 'Rage-quit territory' },
              ].map(({ z, note }) => (
                <tr
                  key={z}
                  style={
                    Math.abs(effectiveZ - z) < 0.5 ? { background: 'rgba(121,168,255,0.08)' } : {}
                  }
                >
                  <td>
                    <code>{z}</code>
                  </td>
                  <td style={{ color: scoreColor(Math.exp(-ALPHA * z)) }}>
                    {(Math.exp(-ALPHA * z) * 100).toFixed(1)}%
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────── Funnel navigator ───────────────────────── */}
      <div className="card">
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>Funnel Navigator</span>
          <button className="btn btn-ghost btn-sm" onClick={resetJourney}>
            ↺ Reset journey
          </button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          Current: <code style={{ color: 'var(--accent-h)' }}>{currentRoute}</code>
          {' → '}
          target: <code style={{ color: 'var(--green)' }}>{TARGET}</code>
        </p>

        {/* Funnel strip */}
        <div className="funnel-strip">
          {FUNNEL.map((page, idx) => {
            const isCurrent = currentRoute === page.route;
            const isVisited = navHistory.includes(page.route);
            return (
              <React.Fragment key={page.route}>
                {idx > 0 && (
                  <div className={`funnel-arrow${isVisited ? ' funnel-arrow--lit' : ''}`}>›</div>
                )}
                <button
                  className={[
                    'funnel-step',
                    isCurrent ? 'funnel-step--active' : '',
                    isVisited && !isCurrent ? 'funnel-step--visited' : '',
                    page.route === TARGET ? 'funnel-step--target' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => navigateTo(page)}
                  title={page.route}
                >
                  <span className="funnel-step-icon">{page.icon}</span>
                  <span className="funnel-step-label">{page.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Detour buttons */}
        <div style={{ marginTop: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Detour pages — visit these to introduce real trajectory friction via{' '}
            <code>trajectory_anomaly</code>:
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {DETOURS.map((page) => (
              <button
                key={page.route}
                className="btn btn-ghost btn-sm"
                onClick={() => navigateTo(page)}
              >
                {page.icon} {page.label}
              </button>
            ))}
          </div>
        </div>

        {/* Breadcrumb */}
        {navHistory.length > 1 && (
          <div className="nav-breadcrumb" style={{ marginTop: 14 }}>
            {navHistory.slice(-10).map((r, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="bc-sep">›</span>}
                <code className="bc-item">{r}</code>
              </React.Fragment>
            ))}
            {navHistory.length > 10 && (
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                +{navHistory.length - 10} more
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─────────────────── Friction / Z-score control ─────────────── */}
      <div className="card">
        <div className="card-title">Friction Control — Z-Score</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          In production the z-score comes from <code>trajectory_anomaly</code> events automatically.
          Enable manual override to explore how friction degrades the propensity score without
          navigating.
        </p>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={useManual}
            onChange={(e) => {
              setUseManual(e.target.checked);
              if (!e.target.checked) setManualZ(0);
            }}
          />
          <span style={{ fontSize: 13 }}>
            Manual override (live z-score: <strong>{liveZ.toFixed(2)}</strong>)
          </span>
        </label>

        {/* Quick presets */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {FRICTION_PRESETS.map(({ label, z }) => (
            <button
              key={z}
              className="btn btn-ghost btn-sm"
              style={
                useManual && Math.abs(manualZ - z) < 0.01
                  ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                  : {}
              }
              onClick={() => {
                setUseManual(true);
                setManualZ(z);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              minWidth: 52,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            z = {effectiveZ.toFixed(1)}
          </span>
          <input
            type="range"
            aria-label="Manual z-score override"
            min={0}
            max={10}
            step={0.1}
            value={effectiveZ}
            onChange={(e) => {
              setUseManual(true);
              setManualZ(parseFloat(e.target.value));
            }}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 76 }}>
            penalty {(frictionPct * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* ─────────────────── Code sample ────────────────────────────── */}
      <CodeBlock
        label="Wire PropensityCalculator into your app"
        code={`<span class="kw">import</span> { PropensityCalculator } <span class="kw">from</span> <span class="str">'@passiveintent/react'</span>;

<span class="kw">const</span> calc = <span class="kw">new</span> <span class="fn">PropensityCalculator</span>(<span class="num">0.2</span>, <span class="num">500</span>); <span class="cmt">// alpha=0.2, throttle=500ms</span>

<span class="cmt">// Re-baseline whenever the user changes page</span>
manager.<span class="fn">on</span>(<span class="str">'state_change'</span>, ({ <span class="prop">stateTo</span> }) => {
  calc.<span class="fn">updateBaseline</span>(stateModel, stateTo, <span class="str">'/thank-you'</span>, <span class="num">3</span>);
});

<span class="cmt">// Fold live friction into the score</span>
manager.<span class="fn">on</span>(<span class="str">'trajectory_anomaly'</span>, ({ <span class="prop">zScore</span> }) => {
  <span class="kw">const</span> p = calc.<span class="fn">getRealTimePropensity</span>(zScore);
  <span class="kw">if</span> (p < <span class="num">0.35</span>) showInterventionBanner();
  <span class="kw">if</span> (p < <span class="num">0.15</span>) showExitIntentOffer();
});`}
      />
    </>
  );
}
