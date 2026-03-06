/**
 * Overview — Live telemetry via getTelemetry() and getPerformanceReport().
 *
 * React pattern: useEffect polling on a 1s interval to keep metrics fresh.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import MetricCard from '../components/MetricCard';
import CodeBlock from '../components/CodeBlock';
import type { PassiveIntentTelemetry } from '@passiveintent/core';

const QUICK_STATES = [
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
];

export default function Overview() {
  const { track, getTelemetry } = useIntent();
  const [telem, setTelem] = useState<PassiveIntentTelemetry | null>(null);
  const [stateCount, setStateCount] = useState(0);

  // Refresh telemetry every second
  useEffect(() => {
    const refresh = () => {
      setTelem(getTelemetry());
    };
    refresh();
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [getTelemetry]);

  const handleTrack = useCallback(
    (state: string) => {
      track(state);
      setStateCount((c) => c + 1);
    },
    [track],
  );

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ usePassiveIntent() — getTelemetry()</div>
        <h2 className="demo-title">Overview &amp; Live Telemetry</h2>
        <p className="demo-description">
          Track a few states below to populate the engine, then watch the metrics update live.{' '}
          <strong>getTelemetry()</strong> returns a GDPR-safe aggregate snapshot — no raw URLs, no
          PII, no behavioral sequences are ever exposed.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Quick Track</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          Click any route chip to call{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>track(route)</code>:
        </p>
        <div className="chip-row">
          {QUICK_STATES.map((s) => (
            <span key={s} className="state-chip" onClick={() => handleTrack(s)}>
              {s}
            </span>
          ))}
        </div>
        {stateCount > 0 && (
          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            Tracked <strong style={{ color: 'var(--accent-h)' }}>{stateCount}</strong> transitions
            this session.
          </p>
        )}
      </div>

      {telem ? (
        <div className="metrics-grid">
          <MetricCard value={telem.transitionsEvaluated} label="Transitions" />
          <MetricCard value={telem.anomaliesFired} label="Anomalies Fired" />
          <MetricCard
            label="Bot Status"
            value={
              <>
                <span
                  className={`status-dot ${telem.botStatus === 'suspected_bot' ? 'status-red' : 'status-green'}`}
                />
                {telem.botStatus}
              </>
            }
          />
          <MetricCard value={`${telem.engineHealth}%`} label="Engine Health" />
          <MetricCard value={telem.baselineStatus ?? '—'} label="Baseline Status" />
          <MetricCard value={telem.assignmentGroup ?? '—'} label="A/B Group" />
        </div>
      ) : (
        <div className="alert alert-info">Track a state to populate telemetry.</div>
      )}

      <CodeBlock
        label="getTelemetry() in a React component"
        code={`<span class="cmt">// Refresh every second — all methods are stable across re-renders</span>
<span class="kw">const</span> { track, getTelemetry } = <span class="fn">usePassiveIntent</span>(config);

<span class="fn">useEffect</span>(() => {
  <span class="kw">const</span> id = <span class="fn">setInterval</span>(() => <span class="fn">setTelem</span>(<span class="fn">getTelemetry</span>()), <span class="num">1_000</span>);
  <span class="kw">return</span> () => <span class="fn">clearInterval</span>(id);
}, [getTelemetry]);

<span class="cmt">// Snapshot shape (zero PII):</span>
<span class="cmt">// { sessionId, transitionsEvaluated, botStatus,</span>
<span class="cmt">//   anomaliesFired, engineHealth, baselineStatus, assignmentGroup }</span>`}
      />
    </>
  );
}
