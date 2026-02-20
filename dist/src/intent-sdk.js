/**
 * Privacy-First Intent Engine ("UI Telepathy")
 * --------------------------------------------------------
 * Goals:
 * - Entirely local inference (no network/data egress)
 * - Tiny footprint + predictable runtime
 * - Sparse + quantized storage for state transitions
 */
/**
 * 32-bit FNV-1a hash.
 * Fast, deterministic, and non-cryptographic.
 */
function fnv1a(input, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        // hash *= 16777619 (expanded to shifts/adds for speed in JS engines)
        hash +=
            (hash << 1) +
                (hash << 4) +
                (hash << 7) +
                (hash << 8) +
                (hash << 24);
    }
    return hash >>> 0;
}
/**
 * Convert a probability [0..1] to uint8 [0..255].
 */
function quantizeProbability(probability) {
    if (probability <= 0)
        return 0;
    if (probability >= 1)
        return 255;
    return Math.round(probability * 255) & 0xff;
}
/**
 * Convert uint8 [0..255] back into [0..1].
 */
function dequantizeProbability(value) {
    return (value & 0xff) / 255;
}
/**
 * Bloom Filter backed by Uint8Array bitset.
 * Storage overhead is fixed and tiny.
 */
export class BloomFilter {
    constructor(config = {}, existingBits) {
        this.bitSize = config.bitSize ?? 2048;
        this.hashCount = config.hashCount ?? 4;
        const byteSize = Math.ceil(this.bitSize / 8);
        this.bits = existingBits && existingBits.length === byteSize
            ? existingBits
            : new Uint8Array(byteSize);
    }
    add(item) {
        for (let i = 0; i < this.hashCount; i += 1) {
            const index = this.getBitIndex(item, i);
            this.setBit(index);
        }
    }
    check(item) {
        for (let i = 0; i < this.hashCount; i += 1) {
            const index = this.getBitIndex(item, i);
            if (!this.getBit(index))
                return false;
        }
        // All bits are set => probably exists (allowing Bloom false positives).
        return true;
    }
    toBase64() {
        let binary = '';
        for (let i = 0; i < this.bits.length; i += 1) {
            binary += String.fromCharCode(this.bits[i]);
        }
        return btoa(binary);
    }
    static fromBase64(base64, config = {}) {
        const binary = atob(base64);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            arr[i] = binary.charCodeAt(i);
        }
        return new BloomFilter(config, arr);
    }
    getBitIndex(item, salt) {
        // "Double hashing" style derivation from two FNV variants.
        const h1 = fnv1a(item, 0x811c9dc5);
        const h2 = fnv1a(item, 0x01000193 ^ salt);
        return (h1 + salt * h2 + salt * salt) % this.bitSize;
    }
    setBit(bitIndex) {
        const byteIndex = bitIndex >> 3;
        const mask = 1 << (bitIndex & 7);
        this.bits[byteIndex] |= mask;
    }
    getBit(bitIndex) {
        const byteIndex = bitIndex >> 3;
        const mask = 1 << (bitIndex & 7);
        return (this.bits[byteIndex] & mask) !== 0;
    }
}
/**
 * Sparse Markov graph for transitions between states.
 * Uses nested Maps (sparse) and supports quantized probability export.
 */
export class MarkovGraph {
    constructor(config = {}) {
        this.rows = new Map();
        this.stateToIndex = new Map();
        this.indexToState = [];
        this.highEntropyThreshold = config.highEntropyThreshold ?? 0.75;
        this.divergenceThreshold = config.divergenceThreshold ?? 6;
    }
    ensureState(state) {
        const existing = this.stateToIndex.get(state);
        if (existing !== undefined)
            return existing;
        const index = this.indexToState.length;
        this.stateToIndex.set(state, index);
        this.indexToState.push(state);
        return index;
    }
    incrementTransition(fromState, toState) {
        const from = this.ensureState(fromState);
        const to = this.ensureState(toState);
        const row = this.rows.get(from) ?? { total: 0, toCounts: new Map() };
        const nextCount = (row.toCounts.get(to) ?? 0) + 1;
        row.toCounts.set(to, nextCount);
        row.total += 1;
        this.rows.set(from, row);
    }
    /**
     * P(to|from) from live counts.
     */
    getProbability(fromState, toState) {
        const from = this.stateToIndex.get(fromState);
        const to = this.stateToIndex.get(toState);
        if (from === undefined || to === undefined)
            return 0;
        const row = this.rows.get(from);
        if (!row || row.total === 0)
            return 0;
        return (row.toCounts.get(to) ?? 0) / row.total;
    }
    /**
     * Entropy H(i) = -Σ P(i->j) log P(i->j)
     * Returned entropy is in nats (natural log).
     */
    entropyForState(state) {
        const from = this.stateToIndex.get(state);
        if (from === undefined)
            return 0;
        const row = this.rows.get(from);
        if (!row || row.total === 0)
            return 0;
        let entropy = 0;
        row.toCounts.forEach((count) => {
            const p = count / row.total;
            if (p > 0)
                entropy -= p * Math.log(p);
        });
        return entropy;
    }
    /**
     * Normalized entropy in [0..1], dividing by max entropy ln(k)
     * where k is number of outgoing edges.
     */
    normalizedEntropyForState(state) {
        const from = this.stateToIndex.get(state);
        if (from === undefined)
            return 0;
        const row = this.rows.get(from);
        if (!row || row.total === 0 || row.toCounts.size <= 1)
            return 0;
        const entropy = this.entropyForState(state);
        const maxEntropy = Math.log(row.toCounts.size);
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }
    /**
     * Log-likelihood trajectory:
     *   log L = Σ log P_baseline(s_t+1 | s_t)
     *
     * To avoid -Infinity when a transition doesn't exist in baseline,
     * apply epsilon smoothing.
     */
    static logLikelihoodTrajectory(baseline, sequence, epsilon = 1e-6) {
        if (sequence.length < 2)
            return 0;
        let sum = 0;
        for (let i = 0; i < sequence.length - 1; i += 1) {
            const p = baseline.getProbability(sequence[i], sequence[i + 1]);
            sum += Math.log(p > 0 ? p : epsilon);
        }
        return sum;
    }
    /**
     * Quantized view of outgoing probabilities for a state as Uint8Array.
     * For edge e: q_e = round(P_e * 255)
     */
    getQuantizedRow(state) {
        const from = this.stateToIndex.get(state);
        if (from === undefined)
            return new Uint8Array(0);
        const row = this.rows.get(from);
        if (!row || row.total === 0)
            return new Uint8Array(0);
        const out = new Uint8Array(row.toCounts.size * 2);
        let offset = 0;
        row.toCounts.forEach((count, toIndex) => {
            const probability = count / row.total;
            out[offset] = toIndex & 0xff;
            out[offset + 1] = quantizeProbability(probability);
            offset += 2;
        });
        return out;
    }
    /**
     * Return dequantized transition probability by state labels.
     */
    getQuantizedProbability(fromState, toState) {
        const from = this.stateToIndex.get(fromState);
        const to = this.stateToIndex.get(toState);
        if (from === undefined || to === undefined)
            return 0;
        const row = this.rows.get(from);
        if (!row || row.total === 0)
            return 0;
        const count = row.toCounts.get(to) ?? 0;
        if (count === 0)
            return 0;
        return dequantizeProbability(quantizeProbability(count / row.total));
    }
    toJSON() {
        const rows = [];
        this.rows.forEach((row, fromIndex) => {
            const edges = [];
            row.toCounts.forEach((count, toIndex) => {
                edges.push([toIndex, count]);
            });
            rows.push([fromIndex, row.total, edges]);
        });
        return {
            states: [...this.indexToState],
            rows,
        };
    }
    static fromJSON(data, config = {}) {
        const graph = new MarkovGraph(config);
        for (let i = 0; i < data.states.length; i += 1) {
            graph.ensureState(data.states[i]);
        }
        for (let r = 0; r < data.rows.length; r += 1) {
            const [fromIndex, total, edges] = data.rows[r];
            const row = { total, toCounts: new Map() };
            for (let e = 0; e < edges.length; e += 1) {
                const [toIndex, count] = edges[e];
                row.toCounts.set(toIndex, count);
            }
            graph.rows.set(fromIndex, row);
        }
        return graph;
    }
}
/**
 * Tiny event emitter.
 */
class EventEmitter {
    constructor() {
        this.listeners = new Map();
    }
    on(event, listener) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return () => {
            set.delete(listener);
            if (set.size === 0)
                this.listeners.delete(event);
        };
    }
    emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        set.forEach((listener) => listener(payload));
    }
}
/**
 * Intent manager orchestrates collection + modeling + interventions.
 */
export class IntentManager {
    constructor(config = {}) {
        this.emitter = new EventEmitter();
        this.persistTimer = null;
        this.previousState = null;
        this.recentTrajectory = [];
        this.storageKey = config.storageKey ?? 'ui-telepathy';
        this.persistDebounceMs = config.persistDebounceMs ?? 2000;
        const restored = this.restore();
        this.bloom = restored?.bloom ?? new BloomFilter(config.bloom);
        this.graph = restored?.graph ?? new MarkovGraph(config.graph);
        this.baseline = config.baseline ? MarkovGraph.fromJSON(config.baseline, config.graph) : null;
    }
    on(event, listener) {
        return this.emitter.on(event, listener);
    }
    /**
     * Track a page view or custom state transition.
     */
    track(state) {
        this.bloom.add(state);
        const from = this.previousState;
        this.previousState = state;
        this.recentTrajectory.push(state);
        // Keep a short tail to bound memory and compute costs.
        if (this.recentTrajectory.length > 32)
            this.recentTrajectory.shift();
        if (from) {
            this.graph.incrementTransition(from, state);
            this.evaluateEntropy(state);
            this.evaluateTrajectory(from, state);
        }
        this.emitter.emit('state_change', { from, to: state });
        this.schedulePersist();
    }
    hasSeen(state) {
        return this.bloom.check(state);
    }
    exportGraph() {
        return this.graph.toJSON();
    }
    flushNow() {
        if (this.persistTimer !== null) {
            window.clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.persist();
    }
    evaluateEntropy(state) {
        const entropy = this.graph.entropyForState(state);
        const normalizedEntropy = this.graph.normalizedEntropyForState(state);
        if (normalizedEntropy >= this.graph.highEntropyThreshold) {
            this.emitter.emit('high_entropy', {
                state,
                entropy,
                normalizedEntropy,
            });
        }
    }
    evaluateTrajectory(from, to) {
        if (!this.baseline)
            return;
        // Calculate real log-likelihood for the bounded window using the live graph.
        let realLogLikelihood = 0;
        for (let i = 0; i < this.recentTrajectory.length - 1; i++) {
            const fromNode = this.recentTrajectory[i];
            const toNode = this.recentTrajectory[i + 1];
            const p = this.graph.getProbability(fromNode, toNode);
            realLogLikelihood += Math.log(p > 0 ? p : 1e-6);
        }
        // Expected baseline likelihood for the same window.
        const expected = MarkovGraph.logLikelihoodTrajectory(this.baseline, this.recentTrajectory);
        const divergence = Math.abs(realLogLikelihood - expected);
        if (divergence >= this.graph.divergenceThreshold) {
            this.emitter.emit('trajectory_anomaly', {
                stateFrom: from,
                stateTo: to,
                realLogLikelihood,
                expectedBaselineLogLikelihood: expected,
                divergence,
            });
        }
    }
    schedulePersist() {
        if (this.persistTimer !== null) {
            window.clearTimeout(this.persistTimer);
        }
        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            this.persist();
        }, this.persistDebounceMs);
    }
    persist() {
        const payload = {
            bloomBase64: this.bloom.toBase64(),
            graph: this.graph.toJSON(),
        };
        localStorage.setItem(this.storageKey, JSON.stringify(payload));
    }
    restore() {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(raw);
            const bloom = BloomFilter.fromBase64(parsed.bloomBase64);
            const graph = MarkovGraph.fromJSON(parsed.graph);
            return { bloom, graph };
        }
        catch {
            return null;
        }
    }
}
