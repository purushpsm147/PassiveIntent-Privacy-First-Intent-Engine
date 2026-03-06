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
  | 'amazon-playground';

const PAGE_MAP: Record<DemoKey, React.ReactElement> = {
  overview: <Overview />,
const PAGE_MAP: Record<DemoKey, React.ComponentType> = {
  'overview':          Overview,
  'basic-tracking':    BasicTracking,
  'high-entropy':      HighEntropy,
  'dwell-time':        DwellTime,
  'trajectory':        Trajectory,
  'hesitation':        Hesitation,
  'attention-return':  AttentionReturn,
  'idle-detection':    IdleDetection,
  'exit-intent':       ExitIntent,
  'bloom-filter':      BloomFilterPage,
  'markov-graph':      MarkovPredictions,
  'bot-detection':     BotDetection,
  'conversion':        Conversion,
  'counters':          Counters,
};

export default function App() {
  const [active, setActive] = useState<DemoKey>('overview');
  const ActivePage = PAGE_MAP[active];

  return (
    <IntentProvider>
      <Shell active={active} onNavigate={setActive}>
        <ActivePage />
      </Shell>
    </IntentProvider>
  );
}
