/**
 * Conversion Tracking — trackConversion() via IntentManager directly.
 * Shows how to combine usePassiveIntent with the raw IntentManager API
 * for methods not yet exposed by the hook.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { IntentManager } from '@passiveintent/core';
import { MemoryStorageAdapter } from '@passiveintent/core';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import { timerAdapter, lifecycleAdapter } from '../adapters';
import type { ConversionPayload } from '@passiveintent/core';

// Second IntentManager instance purely for the trackConversion demo
// so we don't pollute the shared engine's event log with conflicting listeners.
const convManager = new IntentManager({
  storageKey: 'pi-conv-demo',
  storage: new MemoryStorageAdapter(),
  timer: timerAdapter,
  lifecycleAdapter: lifecycleAdapter,
});

export default function Conversion() {
  const { on } = useIntent();
  const [type, setType] = useState('purchase');
  const [value, setValue] = useState(49.99);
  const [currency, setCurrency] = useState('USD');
  const [history, setHistory] = useState<ConversionPayload[]>([]);

  useEffect(() => {
    // Listen on the shared engine's conversion event too
    return on('conversion', (p) => {
      setHistory((h) => [p as ConversionPayload, ...h].slice(0, 10));
    });
  }, [on]);

  // Also listen on the local convManager
  useEffect(() => {
    return convManager.on('conversion', (p) => {
      setHistory((h) => [p as ConversionPayload, ...h].slice(0, 10));
    });
  }, []);

  const handleTrack = useCallback(() => {
    convManager.trackConversion({ type, value, currency });
  }, [type, value, currency]);

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ IntentManager.trackConversion()</div>
        <h2 className="demo-title">Conversion Tracking</h2>
        <p className="demo-description">
          <strong>trackConversion()</strong> emits a <strong>conversion</strong> event locally. The
          payload <em>never leaves the device</em> unless your listener explicitly sends it. Use it
          to correlate behavioral signals with revenue outcomes — entirely in-browser, fully
          GDPR-compliant. The hook doesn't expose this method yet; use <code>IntentManager</code>
          directly when you need it.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Fire a conversion event</div>
        <div className="input-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <label style={{ display: 'block', marginBottom: 4 }}>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="purchase">purchase</option>
              <option value="signup">signup</option>
              <option value="subscription">subscription</option>
              <option value="add_to_cart">add_to_cart</option>
              <option value="trial_start">trial_start</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 4 }}>Value</label>
            <input type="number" value={value} onChange={(e) => setValue(+e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 4 }}>Currency</label>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              style={{ minWidth: 0, width: 80 }}
            />
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-primary" onClick={handleTrack}>
            💰 Track Conversion
          </button>
        </div>
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="card-title">Conversion history (session only, never persisted)</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Value</th>
                <th>Currency</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c, i) => (
                <tr key={i}>
                  <td>
                    <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>
                      {c.type}
                    </code>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{c.value ?? '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{c.currency ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CodeBlock
        label="trackConversion — local-only revenue correlation"
        code={`<span class="kw">import</span> { <span class="type">IntentManager</span> } <span class="kw">from</span> <span class="str">'@passiveintent/core'</span>;

<span class="cmt">// Create a manager instance alongside usePassiveIntent</span>
<span class="kw">const</span> manager = <span class="kw">new</span> <span class="type">IntentManager</span>({ storageKey: <span class="str">'my-app'</span> });

manager.<span class="fn">on</span>(<span class="str">'conversion'</span>, ({ <span class="prop">type</span>, <span class="prop">value</span>, <span class="prop">currency</span> }) => {
  <span class="cmt">// You decide — the engine never sends this anywhere</span>
  <span class="kw">if</span> (type === <span class="str">'purchase'</span>) analytics.<span class="fn">revenue</span>({ value, currency });
});

manager.<span class="fn">trackConversion</span>({ type: <span class="str">'purchase'</span>, value: <span class="num">49.99</span>, currency: <span class="str">'USD'</span> });`}
      />
    </>
  );
}
