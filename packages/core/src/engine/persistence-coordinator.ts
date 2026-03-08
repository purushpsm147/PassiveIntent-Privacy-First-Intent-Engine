/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { AsyncStorageAdapter, StorageAdapter, TimerAdapter } from '../adapters.js';
import type { MarkovGraph } from '../core/markov.js';
import type { BloomFilter } from '../core/bloom.js';
import { BloomFilter as BloomFilterClass } from '../core/bloom.js';
import { MarkovGraph as MarkovGraphClass } from '../core/markov.js';
import { base64ToUint8 } from '../persistence/codec.js';
import type {
  MarkovGraphConfig,
  PassiveIntentError,
  PassiveIntentTelemetry,
} from '../types/events.js';

import { SyncPersistStrategy, AsyncPersistStrategy } from './persistence-strategies.js';
import type {
  PersistStrategy,
  PersistStrategyContext,
  PersistedPayload,
} from './persistence-strategies.js';

/**
 * Configuration for PersistenceCoordinator.
 * All values are resolved and defaulted by IntentManager before being passed in.
 */
export interface PersistenceCoordinatorConfig {
  storageKey: string;
  persistDebounceMs: number;
  persistThrottleMs: number;
  storage: StorageAdapter;
  asyncStorage: AsyncStorageAdapter | null;
  timer: TimerAdapter;
  onError?: (err: PassiveIntentError) => void;
}

/**
 * PersistenceCoordinator — owns all write/read/retry orchestration.
 *
 * Responsibilities:
 *   - `restore()` — deserialise Bloom filter + Markov graph from storage on startup
 *   - `persist()` — prune → serialize → write (sync or async path)
 *   - Dirty-flag short-circuit (no-op when nothing changed)
 *   - Throttle gate with trailing-flush timer
 *   - Async write guard (prevents overlapping `setItem` calls)
 *   - One-shot retry on first consecutive async write failure
 *   - `engineHealth` status flag exposed to telemetry
 *   - `flushNow()` — bypasses throttle for teardown/forced flush
 *
 * Call `attach(graph, bloom)` once after restoring/constructing the Markov graph
 * and Bloom filter so the coordinator can serialise them on each `persist()`.
 */
export class PersistenceCoordinator implements PersistStrategyContext {
  private readonly storageKey: string;
  private readonly persistDebounceMs: number;
  private readonly persistThrottleMs: number;
  private readonly storage: StorageAdapter;
  private readonly asyncStorage: AsyncStorageAdapter | null;
  private readonly timer: TimerAdapter;
  private readonly strategy: PersistStrategy;
  private readonly onErrorCb?: (err: PassiveIntentError) => void;

  /* Late-bound after attach() */
  private graphInstance: MarkovGraph | null = null;
  private bloomInstance: BloomFilter | null = null;

  /* Lifecycle */
  private isClosedFlag = false;

  /* Mutable coordination flags — internal only */
  private isDirtyFlag = false;
  private engineHealthInternal: PassiveIntentTelemetry['engineHealth'] = 'healthy';

  /** Signal that new state has been written and needs to be persisted. */
  markDirty(): void {
    this.isDirtyFlag = true;
  }

  constructor(config: PersistenceCoordinatorConfig) {
    this.storageKey = config.storageKey;
    this.persistDebounceMs = config.persistDebounceMs;
    this.persistThrottleMs = config.persistThrottleMs;
    this.storage = config.storage;
    this.asyncStorage = config.asyncStorage;
    this.timer = config.timer;
    this.onErrorCb = config.onError;

    if (this.asyncStorage) {
      this.strategy = new AsyncPersistStrategy(this);
    } else {
      this.strategy = new SyncPersistStrategy(this);
    }
  }

  // --- PersistStrategyContext implementation ---

  getStorageKey() {
    return this.storageKey;
  }
  getStorage() {
    return this.storage;
  }
  getAsyncStorage() {
    return this.asyncStorage;
  }
  getTimer() {
    return this.timer;
  }
  getThrottleMs() {
    return this.persistThrottleMs;
  }
  getDebounceMs() {
    return this.persistDebounceMs;
  }
  getGraphAndBloom() {
    if (!this.graphInstance || !this.bloomInstance) return null;
    return { graph: this.graphInstance, bloom: this.bloomInstance };
  }
  isClosed() {
    return this.isClosedFlag;
  }
  isDirty() {
    return this.isDirtyFlag;
  }
  clearDirty() {
    this.isDirtyFlag = false;
  }
  setEngineHealth(health: PassiveIntentTelemetry['engineHealth']) {
    this.engineHealthInternal = health;
  }
  reportError(code: PassiveIntentError['code'], message: string, err: unknown) {
    if (this.onErrorCb) {
      this.onErrorCb({ code, message, originalError: err });
    }
  }

  get engineHealth(): PassiveIntentTelemetry['engineHealth'] {
    return this.engineHealthInternal;
  }

  /**
   * Provide the live graph and bloom filter after they have been constructed.
   * Must be called before the first `persist()`.
   */
  attach(graph: MarkovGraph, bloom: BloomFilter): void {
    this.graphInstance = graph;
    this.bloomInstance = bloom;
  }

  /* ================================================================== */
  /*  Restore                                                             */
  /* ================================================================== */

  /**
   * Attempt to read and deserialise a previously persisted payload.
   * Returns `null` on first run (no stored data) or if the data is corrupt.
   * Never throws — all errors go to `onError`.
   */
  restore(graphConfig: MarkovGraphConfig): { bloom: BloomFilter; graph: MarkovGraph } | null {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (err) {
      if (this.onErrorCb) {
        this.onErrorCb({
          code: 'STORAGE_READ',
          message: err instanceof Error ? err.message : String(err),
          originalError: err,
        });
      }
      return null;
    }

    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as PersistedPayload;

      let graph: MarkovGraph;
      if (parsed.graphBinary) {
        const bytes = base64ToUint8(parsed.graphBinary);
        graph = MarkovGraphClass.fromBinary(bytes, graphConfig);
      } else if (parsed.graph) {
        // Legacy JSON format — predates the binary codec.
        graph = MarkovGraphClass.fromJSON(parsed.graph, graphConfig);
      } else {
        return null;
      }

      const bloom = parsed.bloomBase64
        ? BloomFilterClass.fromBase64(parsed.bloomBase64)
        : new BloomFilterClass();

      return { bloom, graph };
    } catch (err) {
      if (this.onErrorCb) {
        const payloadByteLength =
          typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(raw as string).length
            : (raw as string).length;
        this.onErrorCb({
          code: 'RESTORE_PARSE',
          message: err instanceof Error ? err.message : String(err),
          originalError: { cause: err, payloadLength: payloadByteLength },
        });
      }
      return null;
    }
  }

  persist(): void {
    this.strategy.persist();
  }
  flushNow(): void {
    this.strategy.flushNow();
  }
  close(): void {
    this.isClosedFlag = true;
    this.strategy.close();
  }
}
