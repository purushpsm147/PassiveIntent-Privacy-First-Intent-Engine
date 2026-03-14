import React, { useMemo, useState, type ReactNode } from 'react';
import { useEventLog } from '@passiveintent/react';
import type { LogEntry, IntentEventName } from '@passiveintent/react';
import IntentMeter from './components/IntentMeter';
import type { DemoKey } from './App';

interface NavItem {
  key: DemoKey;
  label: string;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Start Here',
    items: [
      { key: 'overview', label: '📊 Overview & Telemetry' },
      { key: 'basic-tracking', label: '📍 Basic Tracking' },
    ],
  },
  {
    section: 'Behavioral Signals',
    items: [
      { key: 'high-entropy', label: '⚡ High Entropy' },
      { key: 'dwell-time', label: '⏱ Dwell Time Anomaly' },
      { key: 'trajectory', label: '🛤 Trajectory Anomaly' },
      { key: 'hesitation', label: '🤔 Hesitation Detection' },
    ],
  },
  {
    section: 'Lifecycle Events',
    items: [
      { key: 'attention-return', label: '👁 Attention Return' },
      { key: 'idle-detection', label: '💤 Idle Detection' },
      { key: 'exit-intent', label: '🚪 Exit Intent' },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      { key: 'bloom-filter', label: '🌸 Bloom Filter' },
      { key: 'markov-graph', label: '🕸 Markov Predictions' },
      { key: 'bot-detection', label: '🤖 Bot Detection' },
      { key: 'cross-tab', label: '📡 Cross-Tab Sync' },
    ],
  },
  {
    section: 'Business Logic',
    items: [
      { key: 'conversion', label: '💰 Conversion Tracking' },
      { key: 'counters', label: '🔢 Session Counters' },
      { key: 'propensity-score', label: '📐 Propensity Score' },
    ],
  },
  {
    section: 'Calibration',
    items: [{ key: 'byob', label: '🎯 Bring Your Own Baseline' }],
  },
  {
    section: 'Playground',
    items: [{ key: 'amazon-playground', label: '🛒 E-commerce Playground' }],
  },
];

const QUICK_JUMPS: Array<{ key: DemoKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'basic-tracking', label: 'Tracking' },
  { key: 'high-entropy', label: 'Entropy' },
  { key: 'dwell-time', label: 'Dwell Time' },
  { key: 'trajectory', label: 'Trajectory' },
  { key: 'hesitation', label: 'Hesitation' },
  { key: 'exit-intent', label: 'Exit Intent' },
  { key: 'bot-detection', label: 'Bot Detection' },
  { key: 'propensity-score', label: 'Propensity' },
  { key: 'amazon-playground', label: 'Playground' },
  { key: 'byob', label: 'BYOB' },
];

const ALL_EVENTS: IntentEventName[] = [
  'state_change',
  'high_entropy',
  'trajectory_anomaly',
  'dwell_time_anomaly',
  'bot_detected',
  'hesitation_detected',
  'session_stale',
  'attention_return',
  'user_idle',
  'user_resumed',
  'exit_intent',
  'conversion',
];

interface Props {
  active: DemoKey;
  onNavigate: (key: DemoKey) => void;
  onReset: () => void;
  children: ReactNode;
}

export default function Shell({ active, onNavigate, onReset, children }: Props) {
  const { log: logEntries, clear: clearLog } = useEventLog(ALL_EVENTS);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);

  const activeLabel = useMemo(
    () => NAV.flatMap((group) => group.items).find((item) => item.key === active)?.label ?? active,
    [active],
  );

  return (
    <div id="app">
      <header className="header">
        <div className="header-left">
          <span className="logo">⚛️</span>
          <div>
            <span className="header-kicker">Core library guided lab</span>
            <h1 className="header-title">PassiveIntent</h1>
            <span className="header-sub">React demo with feature-parity shell</span>
          </div>
        </div>
        <div className="header-right">
          <span className="badge badge-green">v1.1.0</span>
          <span className="badge badge-blue">React 18</span>
          <span className="badge badge-purple">@passiveintent/react</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onReset}
            title="Destroy the current IntentManager and start a completely fresh session — clears all learned transitions, bot state, trajectory, and gauges."
          >
            Reset Session
          </button>
          <a
            href="https://github.com/passiveintent/core"
            target="_blank"
            rel="noopener noreferrer"
            className="gh-link"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>
      </header>

      <div
        className={`layout${sidebarOpen ? '' : ' sidebar-collapsed'}${logOpen ? '' : ' log-collapsed'}`}
      >
        <nav className={`sidebar${sidebarOpen ? '' : ' sidebar--hidden'}`}>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(false)}
            title="Collapse sidebar"
          >
            ◀
          </button>
          <div className="sidebar-inner">
            {NAV.map(({ section, items }) => (
              <React.Fragment key={section}>
                <div className="nav-section-label">{section}</div>
                {items.map(({ key, label }) => (
                  <button
                    key={key}
                    className={`nav-item${active === key ? ' active' : ''}`}
                    onClick={() => onNavigate(key)}
                  >
                    {label}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </div>
        </nav>

        {!sidebarOpen && (
          <button
            className="sidebar-expand"
            onClick={() => setSidebarOpen(true)}
            title="Expand sidebar"
          >
            ▶
          </button>
        )}

        <main className="content">
          <div className="content-shell">
            <section className="lab-intro">
              <div className="lab-intro-copy">
                <p className="section-eyebrow">Guided lab</p>
                <h2 className="shell-title">
                  Explore the shipping core library through the scenarios that matter most.
                </h2>
                <p className="shell-copy">
                  The React experience keeps the full feature surface, but improves first-run flow
                  with clearer entry points, more breathable spacing, and the same shell, scenario
                  map, and quick-entry flow as the Vanilla demo.
                </p>
                <div className="quick-jump-bar">
                  {QUICK_JUMPS.map((jump) => (
                    <button
                      key={jump.key}
                      type="button"
                      className={`quick-jump${active === jump.key ? ' active' : ''}`}
                      onClick={() => onNavigate(jump.key)}
                    >
                      {jump.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="lab-intro-aside">
                <div className="shell-stat-grid">
                  <article className="shell-stat">
                    <span className="shell-stat-label">Coverage</span>
                    <strong>Full lab</strong>
                    <p>Telemetry, anomalies, lifecycle, business logic, and calibration.</p>
                  </article>
                  <article className="shell-stat">
                    <span className="shell-stat-label">Best entry points</span>
                    <strong>Overview, Exit, Playground</strong>
                    <p>
                      Start with the quick jumps, then use the sidebar for full scenario coverage.
                    </p>
                  </article>
                  <article className="shell-stat">
                    <span className="shell-stat-label">Shell parity</span>
                    <strong>Vanilla + React</strong>
                    <p>Both demos share the same layout, spacing, and guided-lab structure.</p>
                  </article>
                </div>
              </div>
            </section>

            <div className="page-heading-row">
              <div>
                <p className="section-eyebrow section-eyebrow-muted">Current module</p>
                <h2 className="page-heading">{activeLabel}</h2>
              </div>
              <p className="page-heading-copy">
                Use the sidebar for full coverage or jump directly into the core scenarios.
              </p>
            </div>

            <section className="page-surface">{children}</section>
          </div>
        </main>

        <IntentMeter />

        <aside className={`event-log${logOpen ? '' : ' event-log--hidden'}`}>
          <div className="event-log-header">
            <div>
              <span className="event-log-kicker">Background telemetry</span>
              <span>Live Event Log</span>
            </div>
            <div className="event-log-actions">
              <button className="btn btn-ghost btn-sm" onClick={clearLog}>
                Clear
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setLogOpen(false)}
                title="Collapse log"
              >
                ▶
              </button>
            </div>
          </div>
          <div className="event-log-entries">
            {logEntries.length === 0 ? (
              <div className="log-empty">Events appear here as you interact.</div>
            ) : (
              logEntries.map((entry, i) => <LogEntryRow key={i} entry={entry} />)
            )}
          </div>
        </aside>
        {!logOpen && (
          <button className="log-expand" onClick={() => setLogOpen(true)} title="Expand event log">
            ◀ Log
          </button>
        )}
      </div>
    </div>
  );
}

function safeSerialize(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return '<unserializable payload>';
  }
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const cssClass = `log-${entry.event.replace(/_/g, '-')}`;
  return (
    <div className={`log-entry ${cssClass} log-default`}>
      <span className="evt-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
      <span className="evt-name">{entry.event.replace(/_/g, ' ')}</span>
      <span className="evt-data">{safeSerialize(entry.payload)}</span>
    </div>
  );
}
