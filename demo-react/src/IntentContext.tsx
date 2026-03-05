/**
 * IntentContext — makes usePassiveIntent's returned methods available
 * to every page without prop-drilling, and hosts the live event log.
 *
 * Key React patterns demonstrated here:
 *  • Passing custom adapters (timer, lifecycleAdapter, storage) into the hook
 *  • useCallback-stable methods that never cause un-needed re-renders
 *  • useReducer event log that prepends new entries efficiently
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
} from 'react';
import { usePassiveIntent } from '@passiveintent/react';
import { MemoryStorageAdapter } from '@passiveintent/core';
import type { IntentEventName, PassiveIntentTelemetry } from '@passiveintent/core';
import { timerAdapter, lifecycleAdapter } from './adapters';
import { ECOMMERCE_BASELINE } from './baseline';

// ─── Event log ────────────────────────────────────────────────────────────────

export interface LogEntry {
  id: number;
  eventName: string;
  data: unknown;
  time: string;
}

type LogAction =
  | { type: 'ADD'; entry: Omit<LogEntry, 'id'> }
  | { type: 'CLEAR' };

let _logSeq = 0;

function logReducer(state: LogEntry[], action: LogAction): LogEntry[] {
  switch (action.type) {
    case 'ADD':
      return [{ ...action.entry, id: ++_logSeq }, ...state].slice(0, 100);
    case 'CLEAR':
      return [];
    default:
      return state;
  }
}

// ─── Context shape ────────────────────────────────────────────────────────────

interface IntentCtx {
  // From usePassiveIntent
  track:             (state: string) => void;
  on:                (event: IntentEventName, handler: (payload: unknown) => void) => () => void;
  getTelemetry:      () => PassiveIntentTelemetry;
  predictNextStates: (threshold?: number, sanitize?: (s: string) => boolean) => { state: string; probability: number }[];
  hasSeen:           (route: string) => boolean;
  incrementCounter:  (key: string, by?: number) => number;
  getCounter:        (key: string) => number;
  resetCounter:      (key: string) => void;

  // Controllable adapters (for demo simulation buttons)
  timer:     typeof timerAdapter;
  lifecycle: typeof lifecycleAdapter;

  // Event log
  logEntries: LogEntry[];
  clearLog:   () => void;
}

const IntentContext = createContext<IntentCtx | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

// MemoryStorageAdapter singleton — avoids polluting localStorage during demo
const memStorage = new MemoryStorageAdapter();

const ALL_EVENTS: IntentEventName[] = [
  'state_change', 'high_entropy', 'trajectory_anomaly', 'dwell_time_anomaly',
  'bot_detected', 'hesitation_detected', 'session_stale', 'attention_return',
  'user_idle', 'user_resumed', 'exit_intent', 'conversion',
];

export function IntentProvider({ children }: { children: ReactNode }) {
  const [logEntries, dispatch] = useReducer(logReducer, []);

  const {
    track, on, getTelemetry, predictNextStates, hasSeen,
    incrementCounter, getCounter, resetCounter,
  } = usePassiveIntent({
    storageKey:       'pi-react-demo',
    storage:          memStorage,
    timer:            timerAdapter,
    lifecycleAdapter: lifecycleAdapter,
    botProtection:    true,
    crossTabSync:     false,
    enableBigrams:    true,
    persistThrottleMs: 200,
    baseline:         ECOMMERCE_BASELINE,
    baselineMeanLL:   -1.4,
    baselineStdLL:    0.35,
    graph: {
      highEntropyThreshold: 0.72,
      divergenceThreshold:  2.5,
      maxStates:            500,
      smoothingAlpha:       0.1,
    },
    dwellTime: { enabled: true, minSamples: 3, zScoreThreshold: 2.0 },
  });

  // Subscribe to all events once, log them all
  useEffect(() => {
    const unsubs = ALL_EVENTS.map(ev =>
      on(ev as IntentEventName, (payload) => {
        dispatch({
          type: 'ADD',
          entry: {
            eventName: ev,
            data: payload,
            time: new Date().toLocaleTimeString(),
          },
        });
      }),
    );
    return () => unsubs.forEach(u => u());
  }, [on]);

  const clearLog = useCallback(() => dispatch({ type: 'CLEAR' }), []);

  return (
    <IntentContext.Provider
      value={{
        track, on, getTelemetry, predictNextStates, hasSeen,
        incrementCounter, getCounter, resetCounter,
        timer:     timerAdapter,
        lifecycle: lifecycleAdapter,
        logEntries,
        clearLog,
      }}
    >
      {children}
    </IntentContext.Provider>
  );
}

// ─── Consumer hook ────────────────────────────────────────────────────────────

export function useIntent(): IntentCtx {
  const ctx = useContext(IntentContext);
  if (!ctx) throw new Error('useIntent must be used inside <IntentProvider>');
  return ctx;
}
