/**
 * Markov Predictions — predictNextStates() + standalone MarkovGraph.
 *
 * React pattern: controlled form state, derived prediction results rendered
 * as a sortable table.
 */
import React, { useState } from 'react';
import { MarkovGraph } from '@passiveintent/core';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';

export default function MarkovPredictions() {
  const { track, predictNextStates } = useIntent();

  // predictNextStates panel
  const [threshold, setThreshold] = useState(0.05);
  const [predictions, setPredictions] = useState<{ state: string; probability: number }[]>([]);

  // Standalone MarkovGraph panel
  const [graph] = useState(() => new MarkovGraph({ maxStates: 50 }));
  const [graphBuilt, setGraphBuilt] = useState(false);
  const [serialized, setSerialized] = useState<string | null>(null);
  const [binaryInfo, setBinaryInfo] = useState<string | null>(null);

  function buildTrafficAndPredict() {
    // seed the shared engine with some transitions first
    const paths = [
      ['/home', '/products', '/cart', '/checkout/payment', '/thank-you'],
      ['/home', '/pricing', '/checkout/payment', '/thank-you'],
      ['/products', '/checkout/payment', '/cart', '/checkout/payment'],
    ];
    paths.forEach((path) => {
      for (let i = 0; i < 5; i++) path.forEach((s) => track(s));
    });
    const preds = predictNextStates(threshold, (s) => !s.startsWith('/admin'));
    setPredictions(preds);
  }

  function buildStandaloneGraph() {
    const paths = [
      ['/home', '/products', '/cart', '/checkout/payment', '/thank-you'],
      ['/home', '/pricing', '/checkout/payment', '/thank-you'],
      ['/home', '/products', '/product/widget', '/cart', '/checkout/payment', '/thank-you'],
    ];
    paths.forEach((path) => {
      for (let i = 0; i < path.length - 1; i++) {
        graph.incrementTransition(path[i], path[i + 1]);
      }
    });
    setGraphBuilt(true);
    setSerialized(null);
    setBinaryInfo(null);
  }

  function serializeJSON() {
    const json = JSON.stringify(graph.toJSON(), null, 2);
    setSerialized(json.slice(0, 1000) + (json.length > 1000 ? '\n...' : ''));
  }

  function binarySize() {
    const bin = graph.toBinary();
    const json = JSON.stringify(graph.toJSON());
    setBinaryInfo(
      `Binary: ${bin.byteLength} B | JSON: ${json.length} B | Savings: ${(((json.length - bin.byteLength) / json.length) * 100).toFixed(0)}%`,
    );
    setSerialized(null);
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ predictNextStates() + MarkovGraph</div>
        <h2 className="demo-title">Markov Graph — Predictions</h2>
        <p className="demo-description">
          <strong>predictNextStates()</strong> returns the top-N destinations from the current state
          above a probability threshold. Use the <code>sanitize</code> guard to exclude sensitive
          routes in production. The standalone <strong>MarkovGraph</strong> class lets you build,
          serialize, and restore graphs independently.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Live predictions from the shared engine</div>
        <div className="input-row">
          <label>Threshold:</label>
          <input
            type="number"
            step={0.01}
            min={0}
            max={1}
            value={threshold}
            onChange={(e) => setThreshold(+e.target.value)}
          />
          <button className="btn btn-primary" onClick={buildTrafficAndPredict}>
            Seed traffic + Predict
          </button>
        </div>

        {predictions.length > 0 && (
          <table className="data-table" style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>State</th>
                <th>Probability</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {predictions.map(({ state, probability }) => (
                <tr key={state}>
                  <td>
                    <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-h)' }}>
                      {state}
                    </code>
                  </td>
                  <td>
                    <strong style={{ fontFamily: 'var(--font-mono)' }}>
                      {(probability * 100).toFixed(1)}%
                    </strong>
                  </td>
                  <td>
                    <div
                      className="progress-track"
                      style={{
                        width: 140,
                        height: 6,
                        display: 'inline-block',
                        borderRadius: 3,
                        overflow: 'hidden',
                        background: 'var(--bg-3)',
                      }}
                    >
                      <div
                        className="prob-fill"
                        style={{ width: `${Math.round(probability * 100)}%`, height: '100%' }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {predictions.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>
            Click "Seed traffic + Predict" to populate the graph and run predictions.
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-title">Standalone MarkovGraph</div>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={buildStandaloneGraph}>
            Build sample graph
          </button>
          <button className="btn btn-primary" onClick={serializeJSON} disabled={!graphBuilt}>
            Serialize JSON
          </button>
          <button className="btn btn-ghost" onClick={binarySize} disabled={!graphBuilt}>
            Binary vs JSON size
          </button>
        </div>
        {graphBuilt && !serialized && !binaryInfo && (
          <div className="alert alert-success" style={{ marginTop: 10 }}>
            Graph built: {graph.stateCount()} states, {graph.totalTransitions()} transitions.
          </div>
        )}
        {binaryInfo && (
          <div className="alert alert-info" style={{ marginTop: 10 }}>
            {binaryInfo}
          </div>
        )}
        {serialized && (
          <div className="code-block" style={{ marginTop: 10 }}>
            <div className="code-label">MarkovGraph.toJSON()</div>
            <pre
              style={{
                padding: 16,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text)',
              }}
            >
              {serialized}
            </pre>
          </div>
        )}
      </div>

      <CodeBlock
        label="predictNextStates() — prefetch next page"
        code={`<span class="kw">const</span> { predictNextStates } = <span class="fn">usePassiveIntent</span>(config);

<span class="cmt">// Prefetch the most likely next pages</span>
<span class="kw">const</span> predictions = <span class="fn">predictNextStates</span>(
  <span class="num">0.3</span>,                             <span class="cmt">// only ≥ 30% probability</span>
  (s) => !s.<span class="fn">startsWith</span>(<span class="str">'/admin'</span>)  <span class="cmt">// sanitize guard</span>
);

<span class="kw">for</span> (<span class="kw">const</span> { <span class="prop">state</span> } <span class="kw">of</span> predictions) {
  router.<span class="fn">prefetch</span>(state); <span class="cmt">// proactively load the bundle</span>
}`}
      />
    </>
  );
}
