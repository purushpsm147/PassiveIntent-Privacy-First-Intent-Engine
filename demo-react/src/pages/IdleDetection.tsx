/**
 * Idle Detection — user_idle + user_resumed with simulation buttons.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { UserIdlePayload, UserResumedPayload } from '@passiveintent/core';

export default function IdleDetection() {
  const { track, on, timer, lifecycle } = useIntent();
  const [idleEvent, setIdleEvent] = useState<UserIdlePayload | null>(null);
  const [resumeEvent, setResumeEvent] = useState<UserResumedPayload | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    return on('user_idle', (p) => setIdleEvent(p as UserIdlePayload));
  }, [on]);

  useEffect(() => {
    return on('user_resumed', (p) => setResumeEvent(p as UserResumedPayload));
  }, [on]);

  function simulateIdle() {
    track('/checkout/payment');
    timer.fastForward(3 * 60 * 1000); // 3 min — past 2-min threshold
    setStatus("Fast-forwarded 3 minutes. user_idle will fire if the engine's idle timer ticks.");
  }

  function simulateResume() {
    lifecycle.triggerInteraction();
    setStatus('Interaction triggered — user_resumed fires after an idle period.');
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('user_idle') + on('user_resumed')</div>
        <h2 className="demo-title">Idle Detection</h2>
        <p className="demo-description">
          <strong>user_idle</strong> fires after 2 minutes of no interaction (mouse, keyboard,
          scroll, touch).
          <strong> user_resumed</strong> fires on the next interaction, with total{' '}
          <code>idleMs</code>. The dwell-time baseline is adjusted to exclude the idle gap
          automatically — keeping your Welford accumulator clean.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Simulate idle cycle</div>
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={simulateIdle}>
            💤 Simulate Idle (3-min timeout)
          </button>
          <button className="btn btn-primary" onClick={simulateResume}>
            🖱 Simulate Interaction (resume)
          </button>
        </div>
        {status && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            {status}
          </div>
        )}
      </div>

      <div className="two-col">
        {idleEvent && (
          <div className="card">
            <div className="card-title">user_idle payload</div>
            <div
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}
            >
              state: <span style={{ color: 'var(--accent-h)' }}>{idleEvent.state}</span>
            </div>
          </div>
        )}
        {resumeEvent && (
          <div className="card">
            <div className="card-title">user_resumed payload</div>
            <div
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-muted)' }}
            >
              <div>
                state: <span style={{ color: 'var(--accent-h)' }}>{resumeEvent.state}</span>
              </div>
              <div>
                idleMs:{' '}
                <span style={{ color: 'var(--green)' }}>
                  {resumeEvent.idleMs?.toLocaleString() ?? '—'} ms
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <CodeBlock
        label="user_idle + user_resumed — dim UI + refresh stale content"
        code={`<span class="fn">useEffect</span>(() => <span class="fn">on</span>(<span class="str">'user_idle'</span>, ({ <span class="prop">state</span> }) => {
  <span class="fn">setOverlay</span>(<span class="kw">true</span>); <span class="cmt">// dim the screen</span>
  VideoPlayer.<span class="fn">pause</span>();
}), [on]);

<span class="fn">useEffect</span>(() => <span class="fn">on</span>(<span class="str">'user_resumed'</span>, ({ <span class="prop">idleMs</span> }) => {
  <span class="fn">setOverlay</span>(<span class="kw">false</span>);
  <span class="kw">if</span> (idleMs > <span class="num">300_000</span>) <span class="fn">refetch</span>(); <span class="cmt">// data might be stale after 5+ min</span>
}), [on]);`}
      />
    </>
  );
}
