/**
 * Cross-Tab Sync — BroadcastSync + crossTabSync config option.
 *
 * React pattern: useEffect-managed BroadcastChannel listener, toggle state,
 * and an inline received-events log to prove cross-tab delivery.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';

const DEMO_CHANNEL = 'passiveintent-demo-cross-tab';

export default function CrossTabSync() {
  const { track } = useIntent();

  const [syncEnabled, setSyncEnabled] = useState(false);
  const [broadcastSupported] = useState(() => typeof BroadcastChannel !== 'undefined');
  const [receivedEvents, setReceivedEvents] = useState<string[]>([]);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Open / close listener channel when syncEnabled toggles
  useEffect(() => {
    if (!broadcastSupported || !syncEnabled) {
      channelRef.current?.close();
      channelRef.current = null;
      return;
    }
    const ch = new BroadcastChannel(DEMO_CHANNEL);
    channelRef.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      if (
        e.data &&
        typeof e.data === 'object' &&
        e.data.type === 'demo-transition' &&
        typeof e.data.state === 'string'
      ) {
        const ts = new Date().toLocaleTimeString();
        setReceivedEvents((prev) => [`[${ts}] Received: ${e.data.state}`, ...prev].slice(0, 20));
      }
    };
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [syncEnabled, broadcastSupported]);

  function handleBroadcast() {
    const state = '/checkout/payment';
    track(state);
    if (!broadcastSupported) return;
    const ch = new BroadcastChannel(DEMO_CHANNEL);
    ch.postMessage({ type: 'demo-transition', state });
    ch.close();
  }

  function handleToggleSync() {
    if (!broadcastSupported) return;
    setSyncEnabled((v) => !v);
    if (syncEnabled) setReceivedEvents([]);
  }

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ BroadcastSync + crossTabSync config</div>
        <h2 className="demo-title">Cross-Tab Sync</h2>
        <p className="demo-description">
          When <code>crossTabSync: true</code> is passed to <code>IntentManager</code>, verified
          transitions are broadcast to every other tab via <strong>BroadcastChannel</strong>. All
          tabs share the same Markov graph, keeping predictions consistent across a multi-tab
          session. No-op in SSR / environments without BroadcastChannel.
        </p>
      </div>

      <div className="card">
        <div className="card-title">How it works</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
          Set <code>crossTabSync: true</code> in the config. The engine creates a{' '}
          <strong>BroadcastChannel</strong> named <code>passiveintent-sync</code>. Only transition
          events are shared — never raw scores or payloads. Call <code>intent.destroy()</code> on
          unmount to close the channel and remove all listeners.
        </p>
      </div>

      <div className="card">
        <div className="card-title">Try it: open this demo in two tabs</div>
        <ol style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.8, paddingLeft: 20 }}>
          <li>Duplicate this browser tab</li>
          <li>
            Navigate to <strong>Cross-Tab Sync</strong> in both tabs
          </li>
          <li>
            Enable sync in <em>both</em> tabs (button below)
          </li>
          <li>
            Click <strong>Broadcast /checkout/payment</strong> in one tab
          </li>
          <li>Watch the received-events log update in the other tab</li>
        </ol>

        {!broadcastSupported && (
          <div className="alert alert-error" style={{ marginTop: 12 }}>
            BroadcastChannel is not supported in this environment. Use a modern browser.
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            className={`btn ${syncEnabled ? 'btn-secondary' : 'btn-primary'}`}
            onClick={handleToggleSync}
            disabled={!broadcastSupported}
          >
            {syncEnabled ? '✓ Sync Enabled — Click to Disable' : 'Enable Cross-Tab Sync'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleBroadcast}
            disabled={!broadcastSupported}
          >
            Broadcast /checkout/payment
          </button>
        </div>

        {syncEnabled && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Listening on channel <code>{DEMO_CHANNEL}</code>. Events broadcast from other tabs
              appear below.
            </div>
            <div
              style={{
                background: 'var(--bg-deep)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '10px 12px',
                minHeight: 60,
                fontFamily: 'monospace',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {receivedEvents.length === 0 ? (
                <span style={{ color: 'var(--text-muted)' }}>
                  No events received yet. Broadcast from another tab.
                </span>
              ) : (
                receivedEvents.map((e, i) => (
                  <div key={i} style={{ color: 'var(--color-green)' }}>
                    {e}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <CodeBlock
        label="crossTabSync config"
        code={[
          `<span class="kw">import</span> { <span class="type">IntentManager</span> } <span class="kw">from</span> <span class="str">'@passiveintent/core'</span>;`,
          ``,
          `<span class="kw">const</span> intent = <span class="kw">new</span> <span class="fn">IntentManager</span>({`,
          `  storageKey:   <span class="str">'my-app'</span>,`,
          `  crossTabSync: <span class="kw">true</span>,   <span class="cmt">// enables BroadcastChannel</span>`,
          `});`,
          ``,
          `<span class="cmt">// Transitions verified by EntropyGuard flow to every open tab.</span>`,
          `intent.<span class="fn">track</span>(<span class="str">'/products/widget'</span>);`,
          ``,
          `<span class="cmt">// Always destroy on SPA teardown:</span>`,
          `intent.<span class="fn">destroy</span>(); <span class="cmt">// closes BroadcastChannel + removes all listeners</span>`,
          ``,
          `<span class="cmt">// BroadcastSync can also be used standalone:</span>`,
          `<span class="kw">import</span> { <span class="type">BroadcastSync</span> } <span class="kw">from</span> <span class="str">'@passiveintent/core'</span>;`,
        ].join('\n')}
      />
    </>
  );
}
