/**
 * Bring Your Own Baseline (BYOB) — Interactive calibration playground.
 *
 * Demonstrates two deployment modes:
 *   1. Start from Zero  → let the engine learn in real-time from live sessions.
 *   2. Inject Historical Data → supply a pre-compiled baseline on day one.
 *
 * Users can toggle between site archetypes (E-commerce / SaaS / Media),
 * adjust calibration parameters with sliders and toggles, and see how the
 * engine responds to those different configurations in real time.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkovGraph } from '@passiveintent/core';
import type { SerializedMarkovGraph } from '@passiveintent/core';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import MetricCard from '../components/MetricCard';

// ─── Site archetype definitions ───────────────────────────────────────────────

interface SiteArchetype {
  key: string;
  label: string;
  emoji: string;
  description: string;
  states: string[];
  perfectPath: string[];
  funnels: string[][];
  sessionsToSimulate: number;
  defaultMeanLL: number;
  defaultStdLL: number;
  defaultZThreshold: number;
  idleThresholdMs: number;
  varianceProfile: 'low' | 'moderate' | 'high';
}

const ARCHETYPES: SiteArchetype[] = [
  {
    key: 'ecommerce',
    label: 'E-commerce Checkout',
    emoji: '🛒',
    description:
      'Linear converging funnel. Users move from browse → product → cart → payment. Low tolerance for deviation.',
    states: ['/home', '/products', '/product/item', '/cart', '/checkout', '/thank-you'],
    perfectPath: ['/home', '/products', '/product/item', '/cart', '/checkout', '/thank-you'],
    funnels: [
      ['/home', '/products', '/product/item', '/cart', '/checkout', '/thank-you'],
      ['/home', '/products', '/cart', '/checkout', '/thank-you'],
      ['/products', '/product/item', '/cart', '/checkout', '/thank-you'],
    ],
    sessionsToSimulate: 200,
    defaultMeanLL: -1.4,
    defaultStdLL: 0.35,
    defaultZThreshold: -1.8,
    idleThresholdMs: 20_000,
    varianceProfile: 'moderate',
  },
  {
    key: 'saas',
    label: 'SaaS Dashboard',
    emoji: '📊',
    description:
      'Cyclical hub-and-spoke. Users orbit between dashboard, reports, settings. Billing visits signal upgrade intent.',
    states: ['/dashboard', '/reports', '/settings', '/billing', '/upgrade', '/docs'],
    perfectPath: ['/dashboard', '/billing', '/upgrade'],
    funnels: [
      ['/dashboard', '/reports', '/settings', '/dashboard', '/billing', '/upgrade'],
      ['/dashboard', '/reports', '/dashboard', '/reports', '/settings'],
      ['/dashboard', '/docs', '/dashboard', '/billing', '/upgrade'],
      ['/dashboard', '/settings', '/billing', '/dashboard'],
    ],
    sessionsToSimulate: 300,
    defaultMeanLL: -2.8,
    defaultStdLL: 0.52,
    defaultZThreshold: -2.0,
    idleThresholdMs: 120_000,
    varianceProfile: 'low',
  },
  {
    key: 'media',
    label: 'Media / Editorial',
    emoji: '📰',
    description:
      'High-variance exploration. Users browse articles freely. Predictable next-article transitions enable prefetching.',
    states: [
      '/home',
      '/article/tech',
      '/article/sports',
      '/article/politics',
      '/article/opinion',
      '/search',
      '/subscribe',
    ],
    perfectPath: ['/home', '/article/tech', '/subscribe'],
    funnels: [
      ['/home', '/article/tech', '/article/sports', '/article/opinion', '/home'],
      ['/home', '/article/politics', '/article/tech', '/search', '/article/sports'],
      ['/home', '/search', '/article/tech', '/article/opinion', '/subscribe'],
      ['/article/sports', '/article/tech', '/article/politics', '/home', '/article/opinion'],
      ['/home', '/article/tech', '/article/sports', '/home', '/subscribe'],
    ],
    sessionsToSimulate: 500,
    defaultMeanLL: -3.47,
    defaultStdLL: 2.1,
    defaultZThreshold: -1.5,
    idleThresholdMs: 180_000,
    varianceProfile: 'high',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildBaselineGraph(archetype: SiteArchetype): SerializedMarkovGraph {
  const g = new MarkovGraph({ maxStates: 100 });
  for (let i = 0; i < archetype.sessionsToSimulate; i++) {
    const funnel = archetype.funnels[i % archetype.funnels.length];
    for (let j = 0; j < funnel.length - 1; j++) {
      g.incrementTransition(funnel[j], funnel[j + 1]);
    }
  }
  return g.toJSON() as SerializedMarkovGraph;
}

function computeCalibration(
  archetype: SiteArchetype,
  graph: SerializedMarkovGraph,
): { meanLL: number; stdLL: number; sampleSize: number; p5: number; p95: number } {
  // Simulate session log-likelihoods by computing per-session LL from the graph
  const lls: number[] = [];
  const totalByState: Record<number, number> = {};
  for (const row of graph.rows) {
    let total = 0;
    for (const [, count] of row[2]) total += count;
    totalByState[row[0]] = total;
  }

  for (let s = 0; s < archetype.sessionsToSimulate; s++) {
    const funnel = archetype.funnels[s % archetype.funnels.length];
    let sessionLL = 0;
    let steps = 0;
    for (let j = 0; j < funnel.length - 1; j++) {
      const fromIdx = graph.states.indexOf(funnel[j]);
      const toIdx = graph.states.indexOf(funnel[j + 1]);
      if (fromIdx === -1 || toIdx === -1) continue;
      const row = graph.rows.find((r) => r[0] === fromIdx);
      if (!row) continue;
      const trans = row[2].find(([ti]) => ti === toIdx);
      const count = trans ? trans[1] : 0;
      const total = totalByState[fromIdx] || 1;
      const p = count / total;
      sessionLL += p > 0 ? Math.log(p) : -10;
      steps++;
    }
    if (steps > 0) lls.push(sessionLL / steps);
  }

  if (lls.length === 0) {
    return {
      meanLL: archetype.defaultMeanLL,
      stdLL: archetype.defaultStdLL,
      sampleSize: 0,
      p5: archetype.defaultMeanLL - 2 * archetype.defaultStdLL,
      p95: archetype.defaultMeanLL + 1.5 * archetype.defaultStdLL,
    };
  }

  const mean = lls.reduce((a, b) => a + b, 0) / lls.length;
  const variance = lls.reduce((a, b) => a + (b - mean) ** 2, 0) / lls.length;
  const std = Math.sqrt(variance) || 0.01;
  const sorted = [...lls].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)] ?? mean - 2 * std;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? mean + 2 * std;

  return { meanLL: mean, stdLL: std, sampleSize: lls.length, p5, p95 };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BYOBaseline() {
  const { track, on } = useIntent();

  // Deployment mode toggle
  const [persona, setPersona] = useState<'indie' | 'enterprise'>('enterprise');

  // Archetype selector
  const [archetypeKey, setArchetypeKey] = useState('ecommerce');
  const archetype = ARCHETYPES.find((a) => a.key === archetypeKey)!;

  // Calibration parameters (editable)
  const [meanLL, setMeanLL] = useState(archetype.defaultMeanLL);
  const [stdLL, setStdLL] = useState(archetype.defaultStdLL);
  const [zThreshold, setZThreshold] = useState(archetype.defaultZThreshold);
  const [idleMs, setIdleMs] = useState(archetype.idleThresholdMs);
  const [useBaseline, setUseBaseline] = useState(true);

  // Generated baseline state
  const [generatedGraph, setGeneratedGraph] = useState<SerializedMarkovGraph | null>(null);
  const [calibrationResult, setCalibrationResult] = useState<ReturnType<
    typeof computeCalibration
  > | null>(null);

  // Live demo results
  const [anomalies, setAnomalies] = useState<string[]>([]);
  const [trackedSteps, setTrackedSteps] = useState(0);

  // Subscribe to anomaly events
  useEffect(() => {
    const unsubs = [
      on('trajectory_anomaly', (p: unknown) => {
        const payload = p as {
          stateTo?: string;
          zScore?: number;
          confidence?: string;
          sampleSize?: number;
        };
        setAnomalies((prev) =>
          [
            `🚨 Trajectory anomaly → ${payload.stateTo} (z=${payload.zScore?.toFixed(2)}, ${payload.confidence ?? '?'}, n=${payload.sampleSize ?? '?'})`,
            ...prev,
          ].slice(0, 10),
        );
      }),
      on('high_entropy', (p: unknown) => {
        const payload = p as { state?: string; normalizedEntropy?: number };
        setAnomalies((prev) =>
          [
            `⚡ High entropy at ${payload.state} (H=${payload.normalizedEntropy?.toFixed(3)})`,
            ...prev,
          ].slice(0, 10),
        );
      }),
      on('dwell_time_anomaly', (p: unknown) => {
        const payload = p as {
          state?: string;
          zScore?: number;
          confidence?: string;
          sampleSize?: number;
        };
        setAnomalies((prev) =>
          [
            `⏱ Dwell anomaly at ${payload.state} (z=${payload.zScore?.toFixed(2)}, ${payload.confidence ?? '?'}, n=${payload.sampleSize ?? '?'})`,
            ...prev,
          ].slice(0, 10),
        );
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [on]);

  // Reset parameters when archetype changes
  useEffect(() => {
    setMeanLL(archetype.defaultMeanLL);
    setStdLL(archetype.defaultStdLL);
    setZThreshold(archetype.defaultZThreshold);
    setIdleMs(archetype.idleThresholdMs);
    setGeneratedGraph(null);
    setCalibrationResult(null);
    setAnomalies([]);
    setTrackedSteps(0);
  }, [archetype]);

  // Generate baseline
  const handleGenerate = useCallback(() => {
    const graph = buildBaselineGraph(archetype);
    const cal = computeCalibration(archetype, graph);
    setGeneratedGraph(graph);
    setCalibrationResult(cal);
    setMeanLL(parseFloat(cal.meanLL.toFixed(2)));
    setStdLL(parseFloat(cal.stdLL.toFixed(2)));
  }, [archetype]);

  // Walk the perfect path (should be normal)
  const walkPerfect = useCallback(() => {
    archetype.perfectPath.forEach((s) => track(s));
    setTrackedSteps((c) => c + archetype.perfectPath.length);
  }, [archetype, track]);

  // Walk an anomalous path
  const walkAnomalous = useCallback(() => {
    const anomPath = [
      archetype.states[archetype.states.length - 1],
      archetype.states[0],
      '/404',
      '/error',
      archetype.states[2] ?? archetype.states[0],
      '/support',
      archetype.states[0],
      '/404',
    ];
    anomPath.forEach((s) => track(s));
    setTrackedSteps((c) => c + anomPath.length);
  }, [archetype, track]);

  // Walk random (noisy)
  const walkRandom = useCallback(() => {
    const allStates = [...archetype.states, '/random-1', '/random-2', '/unknown'];
    for (let i = 0; i < 12; i++) {
      const s = allStates[Math.floor(Math.random() * allStates.length)];
      track(s);
    }
    setTrackedSteps((c) => c + 12);
  }, [archetype, track]);

  // Config code preview
  const configCode = useMemo(() => {
    if (persona === 'indie') {
      return `<span class="cmt">// Zero-baseline mode: engine learns purely from live traffic</span>
<span class="kw">const</span> engine = <span class="kw">new</span> <span class="fn">IntentManager</span>({
  storageKey: <span class="str">'my-app'</span>,
  <span class="cmt">// No baseline — engine learns from live sessions</span>
  graph: {
    highEntropyThreshold: <span class="num">0.72</span>,
    divergenceThreshold: <span class="num">2.5</span>,
  },
  dwellTime: { enabled: <span class="kw">true</span>, minSamples: <span class="num">3</span> },
});`;
    }
    return `<span class="cmt">// Inject-baseline mode: pre-trained graph loaded at initialization</span>
<span class="kw">import</span> baseline <span class="kw">from</span> <span class="str">'./baseline.json'</span>;

<span class="kw">const</span> engine = <span class="kw">new</span> <span class="fn">IntentManager</span>({
  storageKey: <span class="str">'my-app'</span>,
  baseline,${useBaseline ? '' : `                <span class="cmt">// ← disabled</span>`}
  baselineMeanLL: <span class="num">${meanLL}</span>,
  baselineStdLL:  <span class="num">${stdLL}</span>,
  graph: {
    highEntropyThreshold: <span class="num">0.72</span>,
    divergenceThreshold:  <span class="num">${Math.abs(zThreshold).toFixed(1)}</span>,
  },
  dwellTime: {
    enabled: <span class="kw">true</span>,
    minSamples: <span class="num">3</span>,
    zScoreThreshold: <span class="num">2.0</span>,
  },
});`;
  }, [persona, meanLL, stdLL, zThreshold, useBaseline]);

  const varianceColor =
    archetype.varianceProfile === 'high'
      ? 'var(--yellow)'
      : archetype.varianceProfile === 'low'
        ? 'var(--green)'
        : 'var(--accent-h)';

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">🎯 Bring Your Own Baseline (BYOB)</div>
        <h2 className="demo-title">Enterprise Calibration Playground</h2>
        <p className="demo-description">
          Start from zero and let the engine learn in real-time — or inject 5 years of historical
          analytics data so anomaly detection is accurate from session one.
          <strong> This playground lets you explore both approaches.</strong>
        </p>
      </div>

      {/* ── Deployment Mode Toggle ──────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Deployment Mode</div>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button
            className={`btn ${persona === 'indie' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPersona('indie')}
            title="The engine starts with an empty Markov graph. Transition probabilities are learned purely from live user sessions. Anomaly detection becomes reliable after ~50–100 sessions. No configuration required — ideal for MVPs and early-stage products."
          >
            🚀 Start from Zero
          </button>
          <button
            className={`btn ${persona === 'enterprise' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPersona('enterprise')}
            title='Compile historical session data (Mixpanel, GA4, Amplitude) into a pre-trained Markov graph and inject it at initialization. The engine knows your "normal" path from day one — no cold-start period. Required for high-stakes funnels where day-1 accuracy matters.'
          >
            📦 Inject Historical Data
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
          {persona === 'indie' ? (
            <>
              <strong>Start from Zero:</strong> No baseline graph is loaded. The engine starts with
              an empty Markov model and learns transition probabilities in real-time from live user
              sessions. Anomaly detection becomes reliable after ~50–100 sessions build a
              representative graph. Perfect for MVPs and early-stage products.
            </>
          ) : (
            <>
              <strong>Inject Historical Data:</strong> Compile historical analytics data into a
              pre-trained baseline graph and inject it at initialization. The engine knows your
              &quot;normal&quot; path from day one — anomaly detection is accurate from the very
              first session. No cold-start period.
            </>
          )}
        </p>
      </div>

      {/* ── Site Archetype Selector ──────────────────────────────────────── */}
      {persona === 'enterprise' && (
        <>
          <div className="card">
            <div className="card-title">Site Archetype</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
              Select your site type to see how the calibration parameters change:
            </p>
            <div className="btn-row">
              {ARCHETYPES.map((a) => (
                <button
                  key={a.key}
                  className={`btn ${archetypeKey === a.key ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setArchetypeKey(a.key)}
                >
                  {a.emoji} {a.label}
                </button>
              ))}
            </div>
            <div
              style={{
                marginTop: 14,
                padding: '12px 16px',
                background: 'var(--bg-3)',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              <strong>
                {archetype.emoji} {archetype.label}
              </strong>
              <br />
              {archetype.description}
              <br />
              <span style={{ color: varianceColor }}>
                Variance profile: <strong>{archetype.varianceProfile}</strong>
              </span>
              {' · '}
              Idle threshold: <strong>{(archetype.idleThresholdMs / 1000).toFixed(0)}s</strong>
              {' · '}
              Perfect path:{' '}
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {archetype.perfectPath.join(' → ')}
              </code>
            </div>
          </div>

          {/* ── Calibration Controls ───────────────────────────────────────── */}
          <div className="card">
            <div
              className="card-title"
              title="These four parameters control the engine's sensitivity. Run the calibration script against your real session data to extract the correct values for your site. Using the wrong values is the #1 cause of false positives."
            >
              Calibration Parameters ⓘ
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
              Adjust these values to see how the engine adapts. In production, extract them from a
              calibration script run against real session data — not guessed manually.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
              {/* baselineMeanLL */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginBottom: 4,
                  }}
                  title='The average log-likelihood of a "normal" session path through your Markov graph. Computed by running your most common user journeys through the trained graph and averaging their per-step log probs. More negative = users follow less-probable paths on average. E-commerce funnels are tight (-1.4); media sites are loose (-3.47).'
                >
                  baselineMeanLL ⓘ: <strong style={{ color: 'var(--accent-h)' }}>{meanLL}</strong>
                </label>
                <input
                  type="range"
                  min={-6}
                  max={0}
                  step={0.01}
                  value={meanLL}
                  onChange={(e) => setMeanLL(parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                  title="Average log-likelihood of a normal session. Drag left for stricter funnels, right for exploratory/high-variance sites."
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>-6.0 (strict funnel)</span>
                  <span>0.0 (permissive)</span>
                </div>
              </div>

              {/* baselineStdLL */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginBottom: 4,
                  }}
                  title="Standard deviation of log-likelihoods across baseline sessions. Low stdLL (e.g. 0.35) means your users follow a tight, predictable path — any deviation is significant. High stdLL (e.g. 2.1) means exploration is normal and the anomaly bar must be wider to avoid alert storms. Used as the denominator in the Z-score formula."
                >
                  baselineStdLL ⓘ: <strong style={{ color: 'var(--accent-h)' }}>{stdLL}</strong>
                </label>
                <input
                  type="range"
                  min={0.05}
                  max={4}
                  step={0.01}
                  value={stdLL}
                  onChange={(e) => setStdLL(parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                  title="Standard deviation of session log-likelihoods. Low = tight funnel, high = exploratory site. The engine divides (sessionLL - meanLL) / stdLL to compute the Z-score."
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>0.05 (tight funnel)</span>
                  <span>4.0 (high variance)</span>
                </div>
              </div>

              {/* zScoreThreshold */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginBottom: 4,
                  }}
                  title="Z = (sessionLL - baselineMeanLL) / baselineStdLL. When Z drops below this threshold the session is flagged as anomalous. -1.8 ≈ bottom 3.6% of sessions. -2.0 ≈ bottom 2.3%. Too close to 0 = alert storm; too far negative = misses real anomalies. Tune with your P5 percentile as a starting point."
                >
                  zScoreThreshold ⓘ:{' '}
                  <strong style={{ color: 'var(--yellow)' }}>{zThreshold}</strong>
                </label>
                <input
                  type="range"
                  min={-4}
                  max={-0.5}
                  step={0.1}
                  value={zThreshold}
                  onChange={(e) => setZThreshold(parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                  title="Anomaly trigger threshold. Formula: Z = (sessionLL - meanLL) / stdLL. Fire when Z < this value. Start at your P5 calibration output, then tighten if too noisy."
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>-4.0 (rarely fires)</span>
                  <span>-0.5 (hair-trigger)</span>
                </div>
              </div>

              {/* idleThresholdMs */}
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginBottom: 4,
                  }}
                  title="How long without any tracked event before the engine considers a session idle and emits an idle_detected event. Short for checkout funnels (20s of inactivity = hesitation signal). Long for media/editorial (users read articles for minutes). Set based on your median time-on-page from analytics."
                >
                  idleThresholdMs ⓘ:{' '}
                  <strong style={{ color: 'var(--accent-h)' }}>
                    {(idleMs / 1000).toFixed(0)}s
                  </strong>
                </label>
                <input
                  type="range"
                  min={5000}
                  max={300000}
                  step={5000}
                  value={idleMs}
                  onChange={(e) => setIdleMs(parseInt(e.target.value))}
                  style={{ width: '100%' }}
                  title="Milliseconds of inactivity before idle_detected fires. Set to your site's median time-on-page. Too short = false positives; too long = misses real hesitation."
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>5s (checkout)</span>
                  <span>300s (media / docs)</span>
                </div>
              </div>
            </div>

            {/* Baseline toggle */}
            <div
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <button
                className={`btn btn-sm ${useBaseline ? 'btn-green' : 'btn-ghost'}`}
                onClick={() => setUseBaseline(!useBaseline)}
                title={
                  useBaseline
                    ? 'The pre-compiled baseline graph is passed to IntentManager at init. Anomaly detection is immediately calibrated — no warm-up period needed. Toggle OFF to simulate a cold-start (blank graph).'
                    : 'Baseline is disabled. The engine starts with an empty graph and must observe real sessions before anomaly detection becomes meaningful. Click to re-enable.'
                }
              >
                {useBaseline ? '✓ Baseline ON' : '✗ Baseline OFF'}
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {useBaseline
                  ? 'Pre-trained graph injected — anomaly detection active from session 1.'
                  : 'No baseline — engine must learn from scratch (cold-start).'}
              </span>
            </div>
          </div>

          {/* ── Generate Baseline ──────────────────────────────────────────── */}
          <div className="card">
            <div className="card-title">Generate Baseline from Simulated History</div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
              Simulates <strong>{archetype.sessionsToSimulate}</strong> historical sessions through
              the <strong>{archetype.label}</strong> funnels and computes calibration parameters. In
              production, you&apos;d run this against a Mixpanel / Amplitude / GA4 export.
            </p>
            <button className="btn btn-primary" onClick={handleGenerate}>
              ⚙️ Generate Baseline ({archetype.sessionsToSimulate} sessions)
            </button>

            {calibrationResult && (
              <div className="metrics-grid" style={{ marginTop: 14 }}>
                <MetricCard value={calibrationResult.meanLL.toFixed(3)} label="baselineMeanLL" />
                <MetricCard value={calibrationResult.stdLL.toFixed(3)} label="baselineStdLL" />
                <MetricCard value={calibrationResult.sampleSize} label="Sample Sessions" />
                <MetricCard value={calibrationResult.p5.toFixed(3)} label="P5 (floor)" />
                <MetricCard value={calibrationResult.p95.toFixed(3)} label="P95 (ceiling)" />
                <MetricCard
                  value={
                    generatedGraph
                      ? `${generatedGraph.states.length} states / ${generatedGraph.rows.reduce((sum, r) => sum + r[2].length, 0)} edges`
                      : '—'
                  }
                  label="Graph Size"
                />
              </div>
            )}

            {generatedGraph && (
              <div style={{ marginTop: 12 }}>
                <div className="card-title" style={{ fontSize: 13 }}>
                  Top transitions in generated baseline
                </div>
                {generatedGraph.rows.slice(0, 6).map(([fromIdx, , transitions]) => {
                  const from = generatedGraph.states[fromIdx];
                  if (!from) return null;
                  const top = [...transitions].sort(([, a], [, b]) => b - a).slice(0, 3);
                  const total = transitions.reduce((s, [, c]) => s + c, 0);
                  return (
                    <div key={from} className="progress-row">
                      <span
                        className="progress-label"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
                      >
                        {from}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        →{' '}
                        {top
                          .map(([toIdx, c]) => {
                            const pct = total > 0 ? ((c / total) * 100).toFixed(0) : 0;
                            return `${generatedGraph.states[toIdx]}(${pct}%)`;
                          })
                          .join(', ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Live Simulation ────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">
          Live Simulation —{' '}
          {persona === 'indie' ? 'Real-Time Learning' : `${archetype.label} Traffic`}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          {persona === 'indie'
            ? 'Walk paths to build the Markov graph from scratch. Each click is a data point — the engine has no prior knowledge and learns only from what you do here.'
            : 'Walk paths against the pre-trained baseline. The engine immediately scores each transition against the historical distribution and fires anomaly events when the Z-score drops below your threshold.'}
        </p>
        <div className="btn-row">
          <button
            className="btn btn-green"
            onClick={walkPerfect}
            title={`Tracks the ideal conversion path: ${archetype.perfectPath.join(' → ')}. Should produce a normal Z-score (above your threshold) when a baseline is loaded.`}
          >
            ✅ Walk Perfect Path
          </button>
          <button
            className="btn btn-danger"
            onClick={walkAnomalous}
            title="Tracks a backwards / error path that is statistically improbable given the baseline. Should trigger a trajectory_anomaly event if your Z-score threshold is calibrated correctly."
          >
            🚨 Walk Anomalous Path
          </button>
          <button
            className="btn btn-secondary"
            onClick={walkRandom}
            title="Tracks 12 random state transitions. May or may not trigger anomalies depending on threshold — useful for exploring false-positive rate."
          >
            🎲 Random Navigation (12 steps)
          </button>
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {archetype.states.map((s) => (
            <span
              key={s}
              className="state-chip"
              onClick={() => {
                track(s);
                setTrackedSteps((c) => c + 1);
              }}
            >
              {s}
            </span>
          ))}
        </div>

        {trackedSteps > 0 && (
          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            Tracked <strong style={{ color: 'var(--accent-h)' }}>{trackedSteps}</strong> transitions
            this session.
          </p>
        )}
      </div>

      {/* ── Anomaly Feed ───────────────────────────────────────────────────── */}
      {anomalies.length > 0 && (
        <div className="card">
          <div className="card-title">Anomaly Feed</div>
          {anomalies.map((msg, i) => (
            <div
              key={i}
              className={`alert ${msg.startsWith('🚨') ? 'alert-error' : msg.startsWith('⚡') ? 'alert-warning' : 'alert-info'}`}
              style={{ marginBottom: 6, fontSize: 13 }}
            >
              {msg}
            </div>
          ))}
        </div>
      )}

      {/* ── Comparison Table ────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">
          Archetype Comparison — Why One Threshold Doesn&apos;t Fit All
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Dimension</th>
              {ARCHETYPES.map((a) => (
                <th key={a.key}>
                  {a.emoji} {a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Path Structure</td>
              <td>Linear, converging</td>
              <td>Cyclical, hub-and-spoke</td>
              <td>Free exploration</td>
            </tr>
            <tr>
              <td>baselineMeanLL</td>
              {ARCHETYPES.map((a) => (
                <td key={a.key}>
                  <code style={{ fontFamily: 'var(--font-mono)' }}>{a.defaultMeanLL}</code>
                </td>
              ))}
            </tr>
            <tr>
              <td>baselineStdLL</td>
              {ARCHETYPES.map((a) => (
                <td key={a.key}>
                  <code
                    style={{
                      fontFamily: 'var(--font-mono)',
                      color:
                        a.varianceProfile === 'high'
                          ? 'var(--yellow)'
                          : a.varianceProfile === 'low'
                            ? 'var(--green)'
                            : 'var(--accent-h)',
                    }}
                  >
                    {a.defaultStdLL}
                  </code>
                </td>
              ))}
            </tr>
            <tr>
              <td>Z-score threshold</td>
              {ARCHETYPES.map((a) => (
                <td key={a.key}>
                  <code style={{ fontFamily: 'var(--font-mono)' }}>{a.defaultZThreshold}</code>
                </td>
              ))}
            </tr>
            <tr>
              <td>Idle threshold</td>
              {ARCHETYPES.map((a) => (
                <td key={a.key}>{(a.idleThresholdMs / 1000).toFixed(0)}s</td>
              ))}
            </tr>
            <tr>
              <td>Variance profile</td>
              {ARCHETYPES.map((a) => (
                <td key={a.key}>
                  <strong
                    style={{
                      color:
                        a.varianceProfile === 'high'
                          ? 'var(--yellow)'
                          : a.varianceProfile === 'low'
                            ? 'var(--green)'
                            : 'var(--accent-h)',
                    }}
                  >
                    {a.varianceProfile}
                  </strong>
                </td>
              ))}
            </tr>
            <tr>
              <td>Fixed -2.0 threshold effect</td>
              <td style={{ color: 'var(--text-muted)' }}>Works coincidentally</td>
              <td style={{ color: 'var(--green)' }}>Almost never fires — misses anomalies</td>
              <td style={{ color: 'var(--yellow)' }}>Fires constantly — alert storm</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Config Code Preview ────────────────────────────────────────────── */}
      <CodeBlock
        label={
          persona === 'indie'
            ? 'Config — zero baseline (start from zero)'
            : 'Config — pre-trained baseline (inject historical data)'
        }
        code={configCode}
      />

      {persona === 'enterprise' && (
        <CodeBlock
          label="CLI ingestion (Enterprise Tooling Add-on)"
          code={`<span class="cmt"># Compile your Mixpanel export into a binary baseline payload</span>
npx @passiveintent/cli ingest \\
  --source mixpanel_export.csv \\
  --out baseline.bin

<span class="cmt"># Inspect the compiled baseline</span>
npx @passiveintent/cli inspect --file baseline.bin
<span class="cmt"># → baselineMeanLL: ${meanLL}  baselineStdLL: ${stdLL}  sampleSize: ${calibrationResult?.sampleSize ?? '...'}</span>`}
        />
      )}
    </>
  );
}
