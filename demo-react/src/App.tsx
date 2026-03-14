import React, { useState } from 'react';
import { PassiveIntentProvider, MemoryStorageAdapter } from '@passiveintent/react';
import { timerAdapter, lifecycleAdapter } from './adapters';
import { ECOMMERCE_BASELINE } from './baseline';
import Shell from './Shell';
import Overview from './pages/Overview';
import BasicTracking from './pages/BasicTracking';
import HighEntropy from './pages/HighEntropy';
import DwellTime from './pages/DwellTime';
import Trajectory from './pages/Trajectory';
import Hesitation from './pages/Hesitation';
import AttentionReturn from './pages/AttentionReturn';
import IdleDetection from './pages/IdleDetection';
import ExitIntent from './pages/ExitIntent';
import BloomFilterPage from './pages/BloomFilter';
import MarkovPredictions from './pages/MarkovPredictions';
import BotDetection from './pages/BotDetection';
import Conversion from './pages/Conversion';
import Counters from './pages/Counters';
import AmazonPlayground from './pages/AmazonPlayground';
import BYOBaseline from './pages/BYOBaseline';
import CrossTabSync from './pages/CrossTabSync';
import PropensityScore from './pages/PropensityScore';

export type DemoKey =
  | 'overview'
  | 'basic-tracking'
  | 'high-entropy'
  | 'dwell-time'
  | 'trajectory'
  | 'hesitation'
  | 'attention-return'
  | 'idle-detection'
  | 'exit-intent'
  | 'bloom-filter'
  | 'markov-graph'
  | 'bot-detection'
  | 'conversion'
  | 'counters'
  | 'propensity-score'
  | 'amazon-playground'
  | 'byob'
  | 'cross-tab';

const PAGE_MAP: Record<DemoKey, React.ComponentType> = {
  overview: Overview,
  'basic-tracking': BasicTracking,
  'high-entropy': HighEntropy,
  'dwell-time': DwellTime,
  trajectory: Trajectory,
  hesitation: Hesitation,
  'attention-return': AttentionReturn,
  'idle-detection': IdleDetection,
  'exit-intent': ExitIntent,
  'bloom-filter': BloomFilterPage,
  'markov-graph': MarkovPredictions,
  'bot-detection': BotDetection,
  conversion: Conversion,
  counters: Counters,
  'propensity-score': PropensityScore,
  'amazon-playground': AmazonPlayground,
  byob: BYOBaseline,
  'cross-tab': CrossTabSync,
};

// Module-level singleton — avoids polluting localStorage during the demo.
// Shared across session resets (same behaviour as the old IntentContext).
const memStorage = new MemoryStorageAdapter();

export default function App() {
  const [active, setActive] = useState<DemoKey>('overview');
  const [sessionKey, setSessionKey] = useState(0);
  const ActivePage = PAGE_MAP[active];

  return (
    <PassiveIntentProvider
      key={sessionKey}
      config={{
        storageKey: 'pi-react-demo',
        botProtection: true,
        crossTabSync: false,
        enableBigrams: true,
        persistThrottleMs: 200,
        baseline: ECOMMERCE_BASELINE,
        baselineMeanLL: -1.4,
        baselineStdLL: 0.35,
        graph: {
          highEntropyThreshold: 0.72,
          divergenceThreshold: 2.5,
          maxStates: 500,
          smoothingAlpha: 0.1,
        },
        dwellTime: { enabled: true, minSamples: 3, zScoreThreshold: 2.0 },
      }}
      adapters={{
        storage: memStorage,
        timer: timerAdapter,
        lifecycle: lifecycleAdapter,
      }}
    >
      <Shell active={active} onNavigate={setActive} onReset={() => setSessionKey((k) => k + 1)}>
        <ActivePage />
      </Shell>
    </PassiveIntentProvider>
  );
}
