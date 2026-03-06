/**
 * Bot Detection — EntropyGuard, bot_detected event.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { BotDetectedPayload, PassiveIntentTelemetry } from '@passiveintent/core';

const STATES = ['/home', '/products', '/cart', '/checkout', '/search', '/blog'];

export default function BotDetection() {
  const { track, on, getTelemetry } = useIntent();
  const [botEvent, setBotEvent] = useState<BotDetectedPayload | null>(null);
  const [telem, setTelem] = useState<PassiveIntentTelemetry | null>(null);

  useEffect(() => {
    return on('bot_detected', (p) => {
      setBotEvent(p as BotDetectedPayload);
      setTelem(getTelemetry());
    });
  }, [on, getTelemetry]);

  function simulateBot() {
    for (let i = 0; i < 50; i++) {
      track(STATES[i % STATES.length]);
    }
    setTelem(getTelemetry());
  }

  function checkStatus() {
    setTelem(getTelemetry());
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('bot_detected', handler)</div>
        <h2 className="demo-title">Bot Detection (EntropyGuard)</h2>
        <p className="demo-description">
          <strong>EntropyGuard</strong> detects impossibly fast or robotic click cadences by
          accumulating a <em>botScore</em>. When it reaches 5, <strong>bot_detected</strong> fires.
          Set <code>botProtection: false</code> in E2E/CI environments to prevent false positives.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Simulate bot traffic</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          Fires 50 state transitions in rapid succession — no human can produce sub-millisecond
          cadences this consistently.
        </p>
        <div className="btn-row">
          <button className="btn btn-danger" onClick={simulateBot}>
            🤖 Simulate Bot (50 rapid transitions)
          </button>
          <button className="btn btn-secondary" onClick={checkStatus}>
            🔍 Check Status
          </button>
        </div>
      </div>

      {telem && (
        <div className={`alert alert-${telem.botStatus === 'suspected_bot' ? 'error' : 'success'}`}>
          Bot status:{' '}
          <span
            className={`status-dot ${telem.botStatus === 'suspected_bot' ? 'status-red' : 'status-green'}`}
          />
          <strong>{telem.botStatus}</strong>
          {botEvent && ` — botScore: ${(botEvent as { botScore?: number }).botScore ?? '?'}`}
        </div>
      )}

      <div className="card">
        <div className="card-title">EntropyGuard score factors</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Signal</th>
              <th>+Score</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Sub-ms transitions', '+1', 'Δt < 1ms — physically impossible'],
              ['Uniform intervals', '+1', 'Identical timing — scripted'],
              ['High visit rate', '+1', '>30 transitions in <5 seconds'],
              ['Round timing', '+1', 'Exact 100ms/500ms/1000ms intervals'],
              ['Zero variance', '+1', 'No timing jitter whatsoever'],
            ].map(([s, sc, d]) => (
              <tr key={s}>
                <td>{s}</td>
                <td>
                  <strong style={{ color: 'var(--red)' }}>{sc}</strong>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CodeBlock
        label="bot_detected — flag the session"
        code={`<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'bot_detected'</span>, ({ <span class="prop">botScore</span> }) => {
    <span class="cmt">// Stop firing offers / A-B experiments for this session</span>
    Session.<span class="fn">flagAsBot</span>();
    <span class="cmt">// Verify server-side before acting — never trust client alone</span>
    analytics.<span class="fn">track</span>(<span class="str">'suspicious_session'</span>, { botScore });
  });
}, [on]);

<span class="cmt">// Disable in E2E / CI</span>
<span class="fn">usePassiveIntent</span>({ botProtection: <span class="kw">false</span> });`}
      />
    </>
  );
}
