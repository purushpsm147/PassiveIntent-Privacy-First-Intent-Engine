/**
 * Exit Intent — smart exit-intent with likelyNext Markov prediction.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { ExitIntentPayload } from '@passiveintent/core';

export default function ExitIntent() {
  const { track, on, lifecycle } = useIntent();
  const [lastEvent, setLastEvent] = useState<ExitIntentPayload | null>(null);

  useEffect(() => {
    return on('exit_intent', (p) => setLastEvent(p as ExitIntentPayload));
  }, [on]);

  function buildGraph() {
    for (let i = 0; i < 10; i++) {
      track('/checkout/payment');
      track('/cart');
      track('/checkout/payment');
      track('/thank-you');
    }
  }

  function simulateExit() {
    lifecycle.triggerExitIntent();
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('exit_intent', handler)</div>
        <h2 className="demo-title">Smart Exit Intent</h2>
        <p className="demo-description">
          Fires when the pointer moves above the viewport <em>and</em> the Markov graph has at least
          one candidate with probability ≥ 0.4. <strong>No graph = no event</strong> — this prevents
          spammy overlays on accidental toolbar skims. The <code>likelyNext</code> field tells you
          exactly where the user was heading.
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">Browser-native</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            Build the graph first, then move your cursor to the very top of the viewport (above the
            page content, towards the browser address bar).
          </p>
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={buildGraph}>
              Build Graph (10 sessions)
            </button>
            <button className="btn btn-primary" onClick={() => track('/checkout/payment')}>
              📍 Track /checkout/payment
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Simulate programmatically</div>
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={buildGraph}>
              Build Graph
            </button>
            <button className="btn btn-danger" onClick={simulateExit}>
              🚪 Simulate Exit Intent
            </button>
          </div>
        </div>
      </div>

      {lastEvent && (
        <div className="alert alert-error" style={{ marginTop: 8 }}>
          <strong>exit_intent</strong> fired! state:{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>{lastEvent.state}</code> | likelyNext:{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>{lastEvent.likelyNext ?? 'none'}</code>
        </div>
      )}

      <CodeBlock
        label="exit_intent — last-chance offer gated on Markov confidence"
        code={`<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'exit_intent'</span>, ({ <span class="prop">state</span>, <span class="prop">likelyNext</span> }) => {
    <span class="kw">if</span> (state === <span class="str">'/checkout/payment'</span>) {
      <span class="fn">showModal</span>({
        title: <span class="str">'Wait — your cart expires in 10 min!'</span>,
        cta:   <span class="str">'Complete Purchase'</span>,
      });
    }
    <span class="cmt">// likelyNext: where they were heading → personalize the offer</span>
    console.<span class="fn">log</span>(<span class="str">'Would have gone to:'</span>, likelyNext);
  });
}, [on]);`}
      />
    </>
  );
}
