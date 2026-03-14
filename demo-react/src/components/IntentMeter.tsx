/**
 * IntentMeter — A compact docked utility that visualises live intent signals
 * (rage, anxiety, hesitation, bot likelihood, idle, exit intent) in real-time.
 * It stays out of the main canvas until opened.
 *
 * Each gauge has a small ⚡ button that fires a targeted simulation through
 * the real engine so stakeholders can verify every signal path end-to-end.
 *
 * After a simulation completes a **cooldown** period kicks in — gauges decay
 * back to 0 at an accelerated rate so the meter visibly "settles".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIntent } from '../IntentContext';
import type {
  HighEntropyPayload,
  DwellTimeAnomalyPayload,
  HesitationDetectedPayload,
  TrajectoryAnomalyPayload,
} from '@passiveintent/react';

interface Gauge {
  label: string;
  emoji: string;
  value: number; // 0–100
  color: string;
  onSimulate: () => void;
}

const DECAY_INTERVAL = 200; // ms between decay ticks
const DECAY_AMOUNT = 0.5; // % to subtract per tick (normal)
const COOLDOWN_DECAY_AMOUNT = 3; // % to subtract per tick during cooldown
const COOLDOWN_DURATION = 8_000; // ms — how long accelerated decay lasts
const CLAMP = (v: number) => Math.max(0, Math.min(100, v));

/** Yield to the browser so React can flush a render. */
const yieldFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// Product states for rage simulation
const RAGE_STATES = [
  '/sim/rage/a',
  '/sim/rage/b',
  '/sim/rage/c',
  '/sim/rage/d',
  '/sim/rage/e',
  '/sim/rage/f',
];

export default function IntentMeter() {
  const { on, getTelemetry, track, timer, lifecycle } = useIntent();

  const [rage, setRage] = useState(0);
  const [anxiety, setAnxiety] = useState(0);
  const [hesitation, setHesitation] = useState(0);
  const [botPct, setBotPct] = useState(0);
  const [idle, setIdle] = useState(0);
  const [exitIntent, setExitIntent] = useState(0);
  const [simulating, setSimulating] = useState(false);
  const [open, setOpen] = useState(false);
  const simRef = useRef(false); // mutable guard for async loops

  // Cooldown: faster decay after simulation ends
  const cooldownRef = useRef(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Decay — normal or cooldown (accelerated) ─────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const amt = cooldownRef.current ? COOLDOWN_DECAY_AMOUNT : DECAY_AMOUNT;
      setRage((v) => CLAMP(v - amt));
      setAnxiety((v) => CLAMP(v - amt));
      setHesitation((v) => CLAMP(v - amt));
      setExitIntent((v) => CLAMP(v - amt));
      // idle + bot don't decay — they are binary / telemetry-driven
    }, DECAY_INTERVAL);
    return () => clearInterval(id);
  }, []);

  // Bot status from telemetry (polled)
  useEffect(() => {
    const id = setInterval(() => {
      const t = getTelemetry();
      setBotPct(t.botStatus === 'suspected_bot' ? 100 : 0);
    }, 1000);
    return () => clearInterval(id);
  }, [getTelemetry]);

  // Subscribe to events
  useEffect(() => {
    const unsubs = [
      on('high_entropy', (p) => {
        const payload = p as HighEntropyPayload;
        setRage(CLAMP(payload.normalizedEntropy * 100));
      }),
      on('dwell_time_anomaly', (p) => {
        const payload = p as DwellTimeAnomalyPayload;
        setHesitation(CLAMP(Math.min(payload.zScore * 25, 100)));
      }),
      on('hesitation_detected', (p) => {
        const payload = p as HesitationDetectedPayload;
        const combined = (Math.abs(payload.dwellZScore) + Math.abs(payload.trajectoryZScore)) / 2;
        setHesitation(CLAMP(combined * 25));
      }),
      on('trajectory_anomaly', (p) => {
        const payload = p as TrajectoryAnomalyPayload;
        setAnxiety(CLAMP(Math.abs(payload.zScore) * 25));
      }),
      on('exit_intent', () => {
        setExitIntent(100);
      }),
      on('user_idle', () => setIdle(100)),
      on('user_resumed', () => setIdle(0)),
    ];
    return () => {
      unsubs.forEach((u) => {
        u();
      });
    };
  }, [on]);

  // ─── Per-signal simulation callbacks ───────────────────────────────────
  // Each sim is async and yields to the browser between chunks so React can
  // re-render intermediate gauge updates (reactive meter).

  /** Wrap a simulation so it guards against concurrency and resets the clock. */
  const runSim = useCallback(
    async (fn: () => Promise<void>) => {
      if (simRef.current) return;
      simRef.current = true;
      setSimulating(true);
      cooldownRef.current = false; // normal rate while sim runs
      try {
        await fn();
      } finally {
        timer.resetOffset();
        simRef.current = false;
        setSimulating(false);

        // Enter cooldown — accelerated decay settles gauges toward baseline
        cooldownRef.current = true;
        if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = setTimeout(() => {
          cooldownRef.current = false;
        }, COOLDOWN_DURATION);
      }
    },
    [timer],
  );

  const simRage = useCallback(
    () =>
      runSim(async () => {
        const hub = '/sim/rage/hub';
        for (let round = 0; round < 3; round++) {
          for (const s of RAGE_STATES) {
            timer.fastForward(100);
            track(hub);
            timer.fastForward(100);
            track(s);
          }
          await yieldFrame(); // let React render after each round
        }
      }),
    [runSim, track, timer],
  );

  const simAnxiety = useCallback(
    () =>
      runSim(async () => {
        const oddPath = [
          '/sim/anxiety/checkout',
          '/sim/anxiety/faq',
          '/sim/anxiety/refund-policy',
          '/sim/anxiety/checkout',
          '/sim/anxiety/compare',
          '/sim/anxiety/checkout',
          '/sim/anxiety/faq',
          '/sim/anxiety/compare',
          '/sim/anxiety/refund-policy',
          '/sim/anxiety/checkout',
          '/sim/anxiety/faq',
          '/sim/anxiety/compare',
          '/sim/anxiety/checkout',
          '/sim/anxiety/refund-policy',
          '/sim/anxiety/faq',
          '/sim/anxiety/compare',
          '/sim/anxiety/checkout',
          '/sim/anxiety/faq',
          '/sim/anxiety/refund-policy',
          '/sim/anxiety/compare',
        ];
        for (let i = 0; i < oddPath.length; i++) {
          timer.fastForward(2000);
          track(oddPath[i]);
          if (i % 5 === 4) await yieldFrame();
        }
      }),
    [runSim, track, timer],
  );

  const simHesitation = useCallback(
    () =>
      runSim(async () => {
        const a = '/sim/hes/browse';
        const b = '/sim/hes/checkout';
        for (let i = 0; i < 6; i++) {
          timer.fastForward(3000);
          track(a);
          timer.fastForward(3000);
          track(b);
          if (i % 2 === 1) await yieldFrame();
        }
        await yieldFrame();
        for (let i = 0; i < 2; i++) {
          timer.fastForward(30000);
          track(a);
          timer.fastForward(30000);
          track(b);
          await yieldFrame();
        }
      }),
    [runSim, track, timer],
  );

  const simBot = useCallback(
    () =>
      runSim(async () => {
        for (let i = 0; i < 12; i++) {
          track(`/sim/bot/${i}`);
        }
      }),
    [runSim, track],
  );

  const simIdle = useCallback(
    () =>
      runSim(async () => {
        track('/sim/idle/page');
        timer.fastForward(130_000);
      }),
    [runSim, track, timer],
  );

  const simExit = useCallback(
    () =>
      runSim(async () => {
        lifecycle.triggerExitIntent();
      }),
    [runSim, lifecycle],
  );

  const gauges: Gauge[] = [
    { label: 'Rage', emoji: '😤', value: rage, color: 'var(--red)', onSimulate: simRage },
    {
      label: 'Anxiety',
      emoji: '😰',
      value: anxiety,
      color: 'var(--yellow)',
      onSimulate: simAnxiety,
    },
    {
      label: 'Hesitation',
      emoji: '🤔',
      value: hesitation,
      color: 'var(--purple)',
      onSimulate: simHesitation,
    },
    { label: 'Bot', emoji: '🤖', value: botPct, color: 'var(--red)', onSimulate: simBot },
    { label: 'Idle', emoji: '💤', value: idle, color: 'var(--text-muted)', onSimulate: simIdle },
    { label: 'Exit', emoji: '🚪', value: exitIntent, color: 'var(--blue)', onSimulate: simExit },
  ];

  const topGauge = gauges.reduce(
    (best, gauge) => (gauge.value > best.value ? gauge : best),
    gauges[0],
  );
  const summary =
    topGauge.value < 12 ? 'Quiet' : `${topGauge.label} ${Math.round(topGauge.value)}%`;

  return (
    <div className={`intent-meter${open ? ' intent-meter--open' : ''}`}>
      <button
        className="intent-meter-toggle"
        type="button"
        aria-controls="intent-meter-body"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="intent-meter-toggle-label">Intent Meter</span>
        <span className="intent-meter-toggle-value">{summary}</span>
      </button>
      <div className="intent-meter-body" id="intent-meter-body" hidden={!open}>
        <div className="intent-meter-head">
          <span className="intent-meter-title">Live signal monitor</span>
          <button
            className="intent-meter-close"
            type="button"
            aria-label="Collapse intent meter"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="intent-meter-grid">
          {gauges.map((g) => (
            <div key={g.label} className="gauge-row">
              <span className="gauge-emoji">{g.emoji}</span>
              <span className="gauge-label">{g.label}</span>
              <button
                className="gauge-sim-btn"
                onClick={g.onSimulate}
                disabled={simulating}
                aria-label={`Simulate ${g.label}`}
                title={simulating ? 'Simulation running…' : `Simulate ${g.label}`}
              >
                ⚡
              </button>
              <div className="gauge-track">
                <div
                  className="gauge-fill"
                  style={{
                    width: `${g.value}%`,
                    background: g.color,
                    boxShadow: g.value > 50 ? `0 0 8px ${g.color}` : 'none',
                  }}
                />
              </div>
              <span className="gauge-value">{Math.round(g.value)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
