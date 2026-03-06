/**
 * Attention Return — comparison-shopper "Welcome Back" pattern.
 * Shows both browser-native (real tab switch) and simulated triggers.
 */
import React, { useEffect, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';
import type { AttentionReturnPayload } from '@passiveintent/core';

export default function AttentionReturn() {
  const { track, on, timer, lifecycle } = useIntent();
  const [lastEvent, setLastEvent] = useState<AttentionReturnPayload | null>(null);
  const [tracked, setTracked] = useState(false);

  useEffect(() => {
    return on('attention_return', (payload) => {
      setLastEvent(payload as AttentionReturnPayload);
    });
  }, [on]);

  function setupNative() {
    track('/pricing');
    setTracked(true);
  }

  function simulateHide() {
    track('/pricing');
    lifecycle.triggerPause();
    timer.fastForward(30_000); // 30 s virtual hide
    setTracked(true);
  }

  function simulateReturn() {
    lifecycle.triggerResume();
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ on('attention_return', handler)</div>
        <h2 className="demo-title">Attention Return</h2>
        <p className="demo-description">
          Fires when the user returns to the tab after being hidden for ≥{' '}
          <strong>15 seconds</strong>. Works independently of <code>dwellTime.enabled</code>. Use it
          for a personalized "Welcome Back" discount modal — the user was almost certainly
          comparison-shopping.
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">Browser-native (real tab switch)</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            Track a state, switch to another tab for more than 15 seconds, then come back.
          </p>
          <button className="btn btn-primary" onClick={setupNative}>
            📍 Track /pricing then switch tabs
          </button>
          {tracked && (
            <div className="alert alert-info" style={{ marginTop: 10 }}>
              ✓ Tracked. Switch to another tab for &gt;15s, then return here.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">Simulate (no tab switch needed)</div>
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={simulateHide}>
              👻 Simulate Hide (30s)
            </button>
            <button className="btn btn-green" onClick={simulateReturn}>
              👋 Simulate Return
            </button>
          </div>
        </div>
      </div>

      {lastEvent && (
        <div className="alert alert-success">
          <strong>attention_return</strong> fired! state:{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>{lastEvent.state}</code> | hidden for:{' '}
          <strong>{lastEvent.hiddenDuration.toLocaleString()} ms</strong>
        </div>
      )}

      <CodeBlock
        label="attention_return — Welcome Back offer"
        code={`<span class="fn">useEffect</span>(() => {
  <span class="kw">return</span> <span class="fn">on</span>(<span class="str">'attention_return'</span>, ({ <span class="prop">state</span>, <span class="prop">hiddenDuration</span> }) => {
    <span class="kw">if</span> (state === <span class="str">'/pricing'</span> || state === <span class="str">'/product'</span>) {
      <span class="fn">setBanner</span>({
        title:   <span class="str">'Welcome back! 👋'</span>,
        message: <span class="str">'Found a better deal? We\'ll match it + free shipping.'</span>,
        cta:     <span class="str">'Claim offer'</span>,
      });
    }
  });
}, [on]);`}
      />
    </>
  );
}
