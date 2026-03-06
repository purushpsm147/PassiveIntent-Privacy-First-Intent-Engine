/**
 * Trajectory Anomaly — pre-trained baseline graph, walk normal vs. anomalous paths.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import { ECOMMERCE_BASELINE } from '../baseline';
import type { TrajectoryAnomalyPayload, SerializedMarkovGraph } from '@passiveintent/core';

const NORMAL_PATH = [
  '/home',
  '/products',
  '/product/headphones',
  '/cart',
  '/checkout/payment',
  '/thank-you',
];
const ANOMALOUS_PATH = [
  '/home',
  '/pricing',
  '/support',
  '/404',
  '/faq',
  '/returns',
  '/support',
  '/404',
];

export default function Trajectory() {
  const { track, on, timer } = useIntent();
  const [events, setEvents] = useState<TrajectoryAnomalyPayload[]>([]);

  useEffect(() => {
    return on('trajectory_anomaly', (payload) => {
      setEvents((prev) => [payload as TrajectoryAnomalyPayload, ...prev].slice(0, 5));
    });
  }, [on]);

  function walkNormal() {
    NORMAL_PATH.forEach((s) => track(s));
  }
  function walkAnomalous() {
    ANOMALOUS_PATH.forEach((s, i) => {
      track(s);
      if (i > 1) timer.fastForward(300);
    });
  }

  const stateList = (ECOMMERCE_BASELINE as SerializedMarkovGraph).states;
  const rows = (ECOMMERCE_BASELINE as SerializedMarkovGraph).rows;

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('trajectory_anomaly', handler)</div>
        <h2 className="demo-title">Trajectory Anomaly</h2>
        <p className="demo-description">
          Compares the current session's per-step log-likelihood against a
          <strong> pre-trained baseline graph</strong>. When the z-score diverges beyond
          <code>divergenceThreshold</code>, the event fires. Pass your own baseline via the
          <code>baseline</code> config field using <code>MarkovGraph.toJSON()</code>.
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">Normal funnel (matches baseline)</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            {NORMAL_PATH.join(' → ')}
          </p>
          <button className="btn btn-green" onClick={walkNormal}>
            ✅ Walk Normal Path
          </button>
        </div>
        <div className="card">
          <div className="card-title">Anomalous path (deviates sharply)</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            {ANOMALOUS_PATH.join(' → ')}
          </p>
          <button className="btn btn-danger" onClick={walkAnomalous}>
            🚨 Walk Anomalous Path
          </button>
        </div>
      </div>

      {events.length > 0 && (
        <div className="card">
          <div className="card-title">Recent trajectory_anomaly events</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Z-Score</th>
                <th>Log-Likelihood</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>
                    <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-h)' }}>
                      {e.stateTo}
                    </code>
                  </td>
                  <td>
                    <strong style={{ color: 'var(--yellow)' }}>{e.zScore.toFixed(3)}</strong>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    {e.realLogLikelihood?.toFixed(4) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-title">Embedded baseline graph — top transitions</div>
        {rows.slice(0, 5).map(([fromIdx, , transitions]) => {
          const state = stateList[fromIdx];
          if (!state) return null;
          const top = [...transitions].sort(([, a], [, b]) => b - a).slice(0, 2);
          return (
            <div key={state} className="progress-row">
              <span className="progress-label">{state}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                → {top.map(([toIdx, c]) => `${stateList[toIdx]}(${c})`).join(', ')}
              </span>
            </div>
          );
        })}
      </div>

      <CodeBlock
        label="Load a pre-trained baseline"
        code={`<span class="kw">import</span> baseline <span class="kw">from</span> <span class="str">'./baseline.json'</span>; <span class="cmt">// MarkovGraph.toJSON()</span>

<span class="fn">usePassiveIntent</span>({
  baseline,
  baselineMeanLL: <span class="num">-1.4</span>,   <span class="cmt">// mean log-likelihood from training run</span>
  baselineStdLL:  <span class="num">0.35</span>,   <span class="cmt">// std dev  log-likelihood from training run</span>
  graph: { divergenceThreshold: <span class="num">2.5</span> },
});

<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'trajectory_anomaly'</span>, ({ <span class="prop">state</span>, <span class="prop">zScore</span> }) => {
    <span class="kw">if</span> (zScore > <span class="num">2.5</span>) analytics.<span class="fn">trackAbandonment</span>(state);
  });
}, [on]);`}
      />
    </>
  );
}
