/**
 * High Entropy — shows high_entropy event + live distribution visualization.
 *
 * React pattern: subscribe in useEffect, accumulate payload in useState.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { HighEntropyPayload } from '@passiveintent/core';

const RANDOM_STATES = [
  '/search',
  '/cart',
  '/wishlist',
  '/account/profile',
  '/returns',
  '/support',
  '/blog/tips',
  '/sitemap',
  '/faq',
  '/shipping',
  '/privacy',
  '/about',
  '/deal-of-day',
  '/newsletter',
  '/404',
];

export default function HighEntropy() {
  const { track, on } = useIntent();
  const [lastEvent, setLastEvent] = useState<HighEntropyPayload | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    return on('high_entropy', (payload) => {
      setLastEvent(payload as HighEntropyPayload);
      setCount((c) => c + 1);
    });
  }, [on]);

  function rapidFire() {
    track('/checkout/payment');
    for (let i = 0; i < 15; i++) {
      const s = RANDOM_STATES[Math.floor(Math.random() * RANDOM_STATES.length)];
      track(s);
      track('/checkout/payment');
    }
  }

  function normalNav() {
    for (let i = 0; i < 8; i++) {
      track('/products');
      track('/checkout/payment');
      track('/thank-you');
    }
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('high_entropy', handler)</div>
        <h2 className="demo-title">High Entropy Detection</h2>
        <p className="demo-description">
          Fires when the Shannon entropy of the outgoing-transition distribution from a state
          exceeds <code>highEntropyThreshold</code> (0.72 here). Rapid-firing many random
          destinations from the same origin spreads probability mass and spikes entropy — classic
          erratic navigation or frustration signal.
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">Simulate erratic navigation</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            "Rapid Fire" tracks 15 random destinations from{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>/checkout/payment</code>— this spreads
            transition mass across many edges and triggers the event.
          </p>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={rapidFire}>
              ⚡ Rapid Fire (15×)
            </button>
            <button className="btn btn-secondary" onClick={normalNav}>
              ✅ Normal Path
            </button>
          </div>
          {count > 0 && (
            <div className="alert alert-warning" style={{ marginTop: 12 }}>
              <strong>high_entropy</strong> fired <strong>{count}×</strong> this session.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">Last high_entropy payload</div>
          {lastEvent ? (
            <>
              <div style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>state: </span>
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-h)' }}>
                  {lastEvent.state}
                </code>
              </div>
              <div style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  normalizedEntropy:{' '}
                </span>
                <strong style={{ color: 'var(--yellow)', fontFamily: 'var(--font-mono)' }}>
                  {lastEvent.normalizedEntropy.toFixed(4)}
                </strong>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                outgoing entropy:{' '}
                <strong style={{ color: 'var(--text)' }}>
                  {lastEvent.entropy?.toFixed(4) ?? '—'}
                </strong>
              </div>
            </>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Fire "Rapid Fire" to see payload.
            </p>
          )}
        </div>
      </div>

      <CodeBlock
        label="high_entropy — offer help to frustrated users"
        code={`<span class="kw">const</span> { on } = <span class="fn">usePassiveIntent</span>(config);

<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'high_entropy'</span>, ({ <span class="prop">state</span>, <span class="prop">normalizedEntropy</span> }) => {
    <span class="kw">if</span> (state === <span class="str">'/checkout/payment'</span> &amp;&amp; normalizedEntropy > <span class="num">0.85</span>) {
      <span class="fn">showHelpModal</span>(<span class="str">'Having trouble? Let us help.'</span>);
    }
  });
}, [on]);

<span class="cmt">// Config: lower threshold for more sensitivity</span>
<span class="fn">usePassiveIntent</span>({
  graph: { highEntropyThreshold: <span class="num">0.72</span> },
});`}
      />
    </>
  );
}
