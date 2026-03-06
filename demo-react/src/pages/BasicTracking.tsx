/**
 * Basic Tracking — demonstrates track() + state_change event subscription.
 *
 * React pattern: subscribe to an event inside useEffect, use the cleanup
 * return to unsubscribe so no listener leaks occur across re-renders.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';

const FUNNEL = [
  '/home',
  '/products',
  '/product/headphones-pro',
  '/cart',
  '/checkout/shipping',
  '/checkout/payment',
  '/thank-you',
];

interface LastChange {
  from: string;
  to: string;
  probability: number;
}

export default function BasicTracking() {
  const { track, on } = useIntent();
  const [customState, setCustomState] = useState('/checkout/payment');
  const [lastChange, setLastChange] = useState<LastChange | null>(null);
  const [stepIndex, setStepIndex] = useState(0);

  // Subscribe to state_change and surface it in the UI
  useEffect(() => {
    return on('state_change', (payload) => {
      const p = payload as LastChange;
      setLastChange(p);
    });
  }, [on]);

  const handleCustomTrack = useCallback(() => {
    if (customState.trim()) track(customState.trim());
  }, [track, customState]);

  const handleNextStep = useCallback(() => {
    if (stepIndex < FUNNEL.length) {
      track(FUNNEL[stepIndex]);
      setStepIndex((i) => i + 1);
    }
  }, [track, stepIndex]);

  const handleReset = useCallback(() => setStepIndex(0), []);

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ usePassiveIntent() — track() + on()</div>
        <h2 className="demo-title">Basic Tracking</h2>
        <p className="demo-description">
          Every <strong>track(state)</strong> call records a Markov transition and fires
          <strong> state_change</strong>. The event subscription below uses the idiomatic React
          pattern — subscribe in <code>useEffect</code>, return the unsubscribe function as cleanup.
        </p>
      </div>

      {lastChange && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>
          state_change: <code style={{ fontFamily: 'var(--font-mono)' }}>{lastChange.from}</code>
          {' → '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>{lastChange.to}</code>
          {'  '}
          <strong>({(lastChange.probability * 100).toFixed(1)}%)</strong>
        </div>
      )}

      <div className="two-col">
        <div className="card">
          <div className="card-title">Track a custom state</div>
          <div className="input-row">
            <input
              type="text"
              value={customState}
              onChange={(e) => setCustomState(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomTrack()}
              placeholder="/your-route"
            />
            <button className="btn btn-primary" onClick={handleCustomTrack}>
              Track
            </button>
          </div>
        </div>
        <div className="card">
          <div className="card-title">Walk checkout funnel step-by-step</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Step {stepIndex}/{FUNNEL.length}:{' '}
            <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-h)' }}>
              {FUNNEL[stepIndex] ?? '✓ complete'}
            </code>
          </p>
          <div className="btn-row">
            <button
              className="btn btn-primary"
              onClick={handleNextStep}
              disabled={stepIndex >= FUNNEL.length}
            >
              {stepIndex >= FUNNEL.length ? '✓ Done' : `Track ${FUNNEL[stepIndex]}`}
            </button>
            <button className="btn btn-ghost" onClick={handleReset}>
              Reset
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Auto-normalization</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          States are normalized before being stored — UUIDs, ObjectIDs, query strings, and trailing
          slashes are stripped automatically.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Raw input</th>
              <th>Stored as</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['/product/e3b0c44298fc1c149afb', '/product/:id'],
              ['/user/507f1f77bcf86?tab=orders', '/user/:id'],
              ['/order/abc123def456789012345678', '/order/:id'],
            ].map(([raw, norm]) => (
              <tr key={raw}>
                <td>
                  <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    {raw}
                  </code>
                </td>
                <td>
                  <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>
                    {norm}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CodeBlock
        label="Idiomatic React event subscription"
        code={`<span class="kw">const</span> { track, on } = <span class="fn">usePassiveIntent</span>(config);

<span class="cmt">// ✓ subscribe in useEffect, return cleanup to unsubscribe</span>
<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'state_change'</span>, ({ <span class="prop">from</span>, <span class="prop">to</span>, <span class="prop">probability</span> }) => {
    <span class="fn">setState</span>({ from, to, probability });
  });
}, [on]); <span class="cmt">// 'on' is stable — effect runs exactly once</span>

<span class="cmt">// Track on pathname change (Next.js App Router)</span>
<span class="fn">useEffect</span>(() => { <span class="fn">track</span>(pathname); }, [pathname, track]);`}
      />
    </>
  );
}
