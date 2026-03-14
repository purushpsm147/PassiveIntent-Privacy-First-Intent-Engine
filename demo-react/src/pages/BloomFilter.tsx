/**
 * Bloom Filter — hasSeen() membership test + standalone BloomFilter class.
 *
 * React pattern: controlled input + local state for the standalone filter demo.
 */
import React, { useCallback, useState } from 'react';
import { BloomFilter, computeBloomConfig } from '@passiveintent/react';
import { useIntent } from '../IntentContext';
import CodeBlock from '../components/CodeBlock';

function getBits(bf: BloomFilter): boolean[] {
  const b64 = bf.toBase64();
  const bytes = atob(b64);
  const bits: boolean[] = [];
  for (let i = 0; i < Math.min(bytes.length, 32); i++) {
    const byte = bytes.charCodeAt(i);
    for (let k = 7; k >= 0; k--) bits.push(!!((byte >> k) & 1));
  }
  return bits;
}

export default function BloomFilterPage() {
  const { hasSeen } = useIntent();

  // hasSeen() panel
  const [checkInput, setCheckInput] = useState('/checkout/payment');
  const [checkResult, setCheckResult] = useState<boolean | null>(null);

  // Standalone BloomFilter panel
  const [bf] = useState(() => new BloomFilter({ bitSize: 512, hashCount: 4 }));
  const [bfInput, setBfInput] = useState('user@example.com');
  const [bfItems, setBfItems] = useState(0);
  const [bfResult, setBfResult] = useState<string | null>(null);
  const [bits, setBits] = useState<boolean[]>(() => getBits(bf));

  // computeBloomConfig panel
  const [cfgItems, setCfgItems] = useState(1000);
  const [cfgFpr, setCfgFpr] = useState(0.01);
  const [cfgResult, setCfgResult] = useState<{
    bitSize: number;
    hashCount: number;
    estimatedFpRate: number;
  } | null>(null);

  const handleCheck = useCallback(() => {
    setCheckResult(hasSeen(checkInput.trim()));
  }, [hasSeen, checkInput]);

  const handleAdd = useCallback(() => {
    bf.add(bfInput);
    setBfItems((n) => n + 1);
    setBits(getBits(bf));
    setBfResult(
      `Added "${bfInput}". Estimated FPR: ${(bf.estimateCurrentFPR(bfItems + 1) * 100).toFixed(3)}%`,
    );
  }, [bf, bfInput, bfItems]);

  const handleTest = useCallback(() => {
    const r = bf.check(bfInput);
    setBfResult(`"${bfInput}" → ${r ? '✓ Probably in set' : '✗ Definitely not in set'}`);
  }, [bf, bfInput]);

  const handleComputeCfg = useCallback(() => {
    setCfgResult(computeBloomConfig(cfgItems, cfgFpr));
  }, [cfgItems, cfgFpr]);

  return (
    <>
      <div className="demo-header">
        <div className="hook-callout">⚛️ hasSeen() + standalone BloomFilter</div>
        <h2 className="demo-title">Bloom Filter API</h2>
        <p className="demo-description">
          <strong>hasSeen(route)</strong> is an O(k) membership test on the engine's internal Bloom
          filter — useful to check if a user has ever visited a page without storing a list. Use{' '}
          <strong>BloomFilter</strong> standalone for your own deduplication needs, and
          <strong> computeBloomConfig()</strong> to size it optimally.
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">intent.hasSeen() — O(k) lookup</div>
          <div className="input-row">
            <input
              type="text"
              value={checkInput}
              onChange={(e) => setCheckInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
            />
            <button className="btn btn-primary" onClick={handleCheck}>
              Check
            </button>
          </div>
          {checkResult !== null && (
            <div
              className={`alert alert-${checkResult ? 'warning' : 'info'}`}
              style={{ marginTop: 10 }}
            >
              <code style={{ fontFamily: 'var(--font-mono)' }}>{checkInput}</code> →{' '}
              <strong>{checkResult ? '✓ Probably seen' : '✗ Definitely not seen'}</strong>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">Standalone BloomFilter</div>
          <div className="input-row">
            <input type="text" value={bfInput} onChange={(e) => setBfInput(e.target.value)} />
            <button className="btn btn-secondary" onClick={handleAdd}>
              Add
            </button>
            <button className="btn btn-primary" onClick={handleTest}>
              Test
            </button>
          </div>
          {bfResult && (
            <div className="alert alert-info" style={{ marginTop: 10 }}>
              {bfResult}
            </div>
          )}
          <div className="bit-viz" style={{ marginTop: 12 }}>
            {bits.map((on, i) => (
              <div key={i} className={`bit${on ? ' on' : ''}`} />
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            First 256 bits of the filter (lit = set)
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">computeBloomConfig() — optimal sizing</div>
        <div className="input-row">
          <label>Expected items:</label>
          <input type="number" value={cfgItems} onChange={(e) => setCfgItems(+e.target.value)} />
          <label>Target FPR:</label>
          <input
            type="number"
            value={cfgFpr}
            step={0.001}
            onChange={(e) => setCfgFpr(+e.target.value)}
            style={{ width: 80 }}
          />
          <button className="btn btn-secondary" onClick={handleComputeCfg}>
            Compute
          </button>
        </div>
        {cfgResult && (
          <div className="alert alert-success" style={{ marginTop: 10 }}>
            bitSize: <strong>{cfgResult.bitSize}</strong> (
            {(cfgResult.bitSize / 8 / 1024).toFixed(1)} KB)
            {' | '}hashCount: <strong>{cfgResult.hashCount}</strong>
            {' | '}actual FPR: <strong>{(cfgResult.estimatedFpRate * 100).toFixed(3)}%</strong>
          </div>
        )}
      </div>

      <CodeBlock
        label="BloomFilter API"
        code={`<span class="kw">import</span> { <span class="type">BloomFilter</span>, <span class="fn">computeBloomConfig</span> } <span class="kw">from</span> <span class="str">'@passiveintent/react'</span>;

<span class="kw">const</span> cfg = <span class="fn">computeBloomConfig</span>(<span class="num">1_000</span>, <span class="num">0.01</span>);
<span class="kw">const</span> bf  = <span class="kw">new</span> <span class="type">BloomFilter</span>(cfg.bitSize, cfg.hashCount);

bf.<span class="fn">add</span>(<span class="str">'user@example.com'</span>);
bf.<span class="fn">check</span>(<span class="str">'user@example.com'</span>);  <span class="cmt">// true  — probably seen (no false negatives)</span>
bf.<span class="fn">check</span>(<span class="str">'other@example.com'</span>); <span class="cmt">// false — definitely not seen</span>

<span class="cmt">// Compact serialization for cross-tab / server transport</span>
<span class="kw">const</span> snap = bf.<span class="fn">toBase64</span>();
<span class="kw">const</span> back = <span class="type">BloomFilter</span>.<span class="fn">fromBase64</span>(snap, cfg.hashCount);

<span class="cmt">// Via usePassiveIntent</span>
<span class="kw">const</span> { hasSeen } = <span class="fn">usePassiveIntent</span>(config);
hasSeen(<span class="str">'/checkout/payment'</span>); <span class="cmt">// O(k), no false negatives</span>`}
      />
    </>
  );
}
