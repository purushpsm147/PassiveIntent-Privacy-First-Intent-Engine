import React, { useState } from 'react';
import { IntentProvider } from './IntentContext';
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

export default function App() {
  const [active, setActive] = useState<DemoKey>('overview');
  const [sessionKey, setSessionKey] = useState(0);
  const ActivePage = PAGE_MAP[active];

  return (
    <IntentProvider key={sessionKey}>
      <Shell active={active} onNavigate={setActive} onReset={() => setSessionKey((k) => k + 1)}>
        <ActivePage />
      </Shell>
    </IntentProvider>
  );
}
