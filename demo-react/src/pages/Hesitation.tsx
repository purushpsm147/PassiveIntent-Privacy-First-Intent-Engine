/**
 * Hesitation Detection — combined trajectory + dwell signal.
 * Shows the intervention ladder recipe in React.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { HesitationDetectedPayload } from '@passiveintent/core';

export default function Hesitation() {
  const { track, on, timer } = useIntent();
  const [status, setStatus] = useState<string | null>(null);
  const [primed, setPrimed] = useState(false);
  const [lastEvent, setLastEvent] = useState<HesitationDetectedPayload | null>(null);

  useEffect(() => {
    return on('hesitation_detected', (payload) => {
      setLastEvent(payload as HesitationDetectedPayload);
    });
  }, [on]);

  function primeEngine() {
    timer.reset();
    for (let i = 0; i < 5; i++) {
      track('/products');
      timer.fastForward(1500);
      track('/checkout/payment');
      timer.fastForward(3000);
      track('/products');
      timer.fastForward(2000);
    }
    setPrimed(true);
    setStatus('Engine primed with 5 quick visits. Now trigger the hesitation →');
  }

  function triggerHesitation() {
    track('/support');
    timer.fastForward(7 * 60 * 1000); // 7 min — very abnormal
    track('/faq');
    setStatus('Triggered: anomalous path + long dwell. Check log for hesitation_detected.');
  }

  const severity = lastEvent
    ? ((lastEvent.dwellZScore ?? 0) + (lastEvent.trajectoryZScore ?? 0)) / 2
    : null;

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('hesitation_detected', handler)</div>
        <h2 className="demo-title">Hesitation Detection</h2>
        <p className="demo-description">
          The highest-confidence signal: fires only when <em>both</em>{' '}
          <strong>trajectory_anomaly</strong> and a positive <strong>dwell_time_anomaly</strong>{' '}
          occur within the correlation window. Use it to drive an <em>Intervention Ladder</em> —
          escalate from a tooltip to a modal to live chat based on combined severity.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Trigger combined hesitation signal</div>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={primeEngine}>
            1️⃣ Prime engine (5 normal visits)
          </button>
          <button className="btn btn-primary" onClick={triggerHesitation} disabled={!primed}>
            2️⃣ Trigger Hesitation Signal
          </button>
        </div>
        {status && (
          <div
            className={`alert alert-${lastEvent ? 'warning' : 'success'}`}
            style={{ marginTop: 12 }}
          >
            {status}
          </div>
        )}
      </div>

      {lastEvent && severity !== null && (
        <div className="card">
          <div className="card-title">Intervention Ladder — live severity</div>
          <div className="progress-row" style={{ marginBottom: 14 }}>
            <span className="progress-label">Severity score</span>
            <div className="progress-track">
              <div
                className="prob-fill"
                style={{ width: `${Math.min((severity / 5) * 100, 100)}%`, height: '100%' }}
              />
            </div>
            <span className="progress-value">{severity.toFixed(2)}</span>
          </div>
          <div
            className={`alert alert-${severity < 2.5 ? 'info' : severity < 3.5 ? 'warning' : 'error'}`}
          >
            {severity < 2.5
              ? '💬 Severity LOW → show a tooltip'
              : severity < 3.5
                ? '🪟 Severity MED → show a modal discount'
                : '🎧 Severity HIGH → open proactive live chat'}
          </div>
        </div>
      )}

      <CodeBlock
        label="Intervention Ladder recipe"
        code={`<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'hesitation_detected'</span>, ({ <span class="prop">zScoreDwell</span>, <span class="prop">zScoreTrajectory</span> }) => {
    <span class="kw">const</span> severity = (zScoreDwell + zScoreTrajectory) / <span class="num">2</span>;
    <span class="kw">if</span>      (severity < <span class="num">2.5</span>) <span class="fn">setTooltip</span>(<span class="str">'Free shipping today!'</span>);
    <span class="kw">else if</span> (severity < <span class="num">3.5</span>) <span class="fn">setModal</span>({ discount: <span class="str">'10%'</span> });
    <span class="kw">else</span>               <span class="fn">openLiveChat</span>(<span class="str">'Hi! Can I help you complete your order?'</span>);
  });
}, [on]);`}
      />
    </>
  );
}
