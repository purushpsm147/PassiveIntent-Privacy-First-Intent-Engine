/**
 * Session Counters — incrementCounter / getCounter / resetCounter.
 * Shows the controlled-component pattern: counter state derived on demand.
 */
import React, { useCallback, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';

const PRESETS: Array<{ label: string; key: string; by: number }> = [
  { label: 'Modal shown', key: 'offer-impressions', by: 1 },
  { label: 'CTA clicked', key: 'cta-clicks', by: 1 },
  { label: 'Page viewed', key: 'pages-viewed', by: 1 },
  { label: 'Cart item added', key: 'cart-items', by: 1 },
  { label: 'Cart item removed', key: 'cart-items', by: -1 },
];

export default function Counters() {
  const { incrementCounter, getCounter, resetCounter } = useIntent();
  const [key, setKey] = useState('offer-impressions');
  const [by, setBy] = useState(1);
  const [result, setResult] = useState<string | null>(null);

  const handleInc = useCallback(() => {
    const v = incrementCounter(key, by);
    setResult(`${key} = ${v}`);
  }, [incrementCounter, key, by]);

  const handleGet = useCallback(() => {
    setResult(`${key} = ${getCounter(key)}`);
  }, [getCounter, key]);

  const handleReset = useCallback(() => {
    resetCounter(key);
    setResult(`${key} reset to 0`);
  }, [resetCounter, key]);

  const handlePreset = useCallback(
    (p: (typeof PRESETS)[number]) => {
      const v = incrementCounter(p.key, p.by);
      setResult(`${p.key} = ${v}`);
      setKey(p.key);
    },
    [incrementCounter],
  );

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ incrementCounter / getCounter / resetCounter</div>
        <h2 className="demo-title">Session Counters</h2>
        <p className="demo-description">
          Exact integer counters scoped to the session. <strong>Never persisted.</strong> Ideal for
          tracking offer impressions, modal views, or cart quantity — without any server
          round-trips. Syncs cross-tab when <code>crossTabSync: true</code>.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Counter controls</div>
        <div className="input-row">
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="counter-key"
          />
          <input
            type="number"
            value={by}
            onChange={(e) => setBy(+e.target.value)}
            style={{ width: 70 }}
          />
          <button className="btn btn-primary" onClick={handleInc}>
            {' '}
            +Increment
          </button>
          <button className="btn btn-secondary" onClick={handleGet}>
            {' '}
            Get
          </button>
          <button className="btn btn-ghost" onClick={handleReset}>
            Reset
          </button>
        </div>
        {result && (
          <div
            className="alert alert-info"
            style={{ marginTop: 10, fontFamily: 'var(--font-mono)' }}
          >
            {result}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Common use cases</div>
        <div className="btn-row">
          {PRESETS.map((p) => (
            <button
              key={`${p.key}-${p.by}`}
              className="btn btn-secondary"
              onClick={() => handlePreset(p)}
            >
              {p.label} ({p.by > 0 ? '+' : ''}
              {p.by})
            </button>
          ))}
        </div>
      </div>

      <CodeBlock
        label="Session counters in a React component"
        code={`<span class="kw">const</span> { incrementCounter, getCounter, resetCounter } = <span class="fn">usePassiveIntent</span>(config);

<span class="cmt">// Cap offer impressions at 3 to avoid annoyance</span>
<span class="kw">function</span> <span class="fn">handleShowOffer</span>() {
  <span class="kw">const</span> shown = <span class="fn">incrementCounter</span>(<span class="str">'offer-impressions'</span>);
  <span class="kw">if</span> (shown <= <span class="num">3</span>) <span class="fn">setShowModal</span>(<span class="kw">true</span>);
}

<span class="cmt">// Track cart quantity</span>
<span class="kw">const</span> qty = <span class="fn">incrementCounter</span>(<span class="str">'cart-items'</span>,  <span class="num">1</span>);  <span class="cmt">// add</span>
<span class="fn">incrementCounter</span>(<span class="str">'cart-items'</span>, <span class="num">-1</span>);                       <span class="cmt">// remove</span>
<span class="fn">resetCounter</span>(<span class="str">'cart-items'</span>);                               <span class="cmt">// checkout complete</span>`}
      />
    </>
  );
}
