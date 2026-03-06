/**
 * Dwell Time Anomaly — shows dwell_time_anomaly + Welford's algorithm.
 *
 * React pattern: ControllableTimerAdapter accessed via context to simulate
 * time passing without real waiting.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { DwellTimeAnomalyPayload } from '@passiveintent/core';

export default function DwellTime() {
  const { track, on, timer } = useIntent();
  const [status, setStatus] = useState<{
    type: 'success' | 'warning' | 'info';
    msg: string;
  } | null>(null);
  const [lastEvent, setLastEvent] = useState<DwellTimeAnomalyPayload | null>(null);

  useEffect(() => {
    return on('dwell_time_anomaly', (payload) => {
      setLastEvent(payload as DwellTimeAnomalyPayload);
    });
  }, [on]);

  function buildBaseline() {
    timer.reset();
    for (let i = 0; i < 10; i++) {
      track('/products');
      timer.fastForward(2500 + Math.random() * 1500);
      track('/checkout/payment');
      timer.fastForward(3000 + Math.random() * 1000);
    }
    setStatus({
      type: 'success',
      msg: 'Baseline built: 10 quick visits avg ~3s on /checkout/payment. Now simulate hesitation →',
    });
  }

  function simulateHesitation() {
    track('/checkout/payment');
    timer.fastForward(5 * 60 * 1000); // 5 minutes — way above baseline
    track('/checkout/confirm');
    setStatus({
      type: 'warning',
      msg: 'Simulated 5-minute dwell on /checkout/payment. Check the event log for dwell_time_anomaly.',
    });
  }

  function resetTimer() {
    timer.reset();
    setStatus({ type: 'info', msg: 'Timer offset reset to 0.' });
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('dwell_time_anomaly', handler)</div>
        <h2 className="demo-title">Dwell Time Anomaly</h2>
        <p className="demo-description">
          Uses <strong>Welford's online algorithm</strong> to maintain running mean/variance per
          state — no raw timestamps are ever stored. When the z-score of the current dwell exceeds
          the threshold, the event fires. The controllable timer adapter lets you simulate hours of
          dwell in a click.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Simulate hesitation</div>
        <ol
          style={{
            color: 'var(--text-muted)',
            fontSize: 13,
            lineHeight: 1.9,
            paddingLeft: 20,
            marginBottom: 14,
          }}
        >
          <li>Build a baseline of normal visit durations (3–4 s each)</li>
          <li>Simulate a user taking 5 minutes — the z-score spikes</li>
        </ol>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={buildBaseline}>
            1️⃣ Build Baseline (10 visits)
          </button>
          <button className="btn btn-primary" onClick={simulateHesitation}>
            2️⃣ Simulate Hesitation (+5 min)
          </button>
          <button className="btn btn-ghost" onClick={resetTimer}>
            ↩ Reset Timer
          </button>
        </div>
        {status && (
          <div className={`alert alert-${status.type}`} style={{ marginTop: 12 }}>
            {status.msg}
          </div>
        )}
      </div>

      {lastEvent && (
        <div className="card">
          <div className="card-title">Last dwell_time_anomaly payload</div>
          <table className="data-table" style={{ fontSize: 13 }}>
            <tbody>
              {(
                [
                  ['state', lastEvent.state],
                  ['dwellMs', `${lastEvent.dwellMs.toFixed(0)} ms`],
                  ['zScore', lastEvent.zScore.toFixed(3)],
                  ['mean', `${lastEvent.meanMs.toFixed(0)} ms`],
                  ['stdDev', `${lastEvent.stdMs?.toFixed(0) ?? '—'} ms`],
                ] as [string, string][]
              ).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ color: 'var(--text-muted)', width: 100 }}>{k}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-h)' }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CodeBlock
        label="dwell_time_anomaly — hesitation discount"
        code={`<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'dwell_time_anomaly'</span>, ({ <span class="prop">state</span>, <span class="prop">zScore</span>, <span class="prop">dwellMs</span> }) => {
    <span class="kw">if</span> (state === <span class="str">'/checkout/payment'</span> &amp;&amp; zScore > <span class="num">2.0</span>) {
      <span class="fn">showOffer</span>({ discount: <span class="str">'10%'</span>, msg: <span class="str">'Free shipping today only!'</span> });
    }
  });
}, [on]);

<span class="cmt">// Config:</span>
<span class="fn">usePassiveIntent</span>({
  dwellTime: { enabled: <span class="kw">true</span>, minSamples: <span class="num">3</span>, zScoreThreshold: <span class="num">2.0</span> },
});`}
      />
    </>
  );
}
