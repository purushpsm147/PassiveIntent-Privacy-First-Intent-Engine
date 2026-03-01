/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  AsyncStorageAdapter,
  StorageAdapter,
  TimerAdapter,
  TimerHandle,
} from '../adapters.js';
import type { MarkovGraph, SerializedMarkovGraph } from '../core/markov.js';
import type { BloomFilter } from '../core/bloom.js';
import { BloomFilter as BloomFilterClass } from '../core/bloom.js';
import { MarkovGraph as MarkovGraphClass } from '../core/markov.js';
import { base64ToUint8, uint8ToBase64 } from '../persistence/codec.js';
import type {
  MarkovGraphConfig,
  PassiveIntentError,
  PassiveIntentTelemetry,
} from '../types/events.js';

/**
 * Persisted envelope format.
 * `graphBinary` is a base64-encoded Uint8Array produced by MarkovGraph.toBinary().
 */
interface PersistedPayload {
  bloomBase64: string;
  graphBinary?: string;
  graph?: SerializedMarkovGraph;
}

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
export class PersistenceCoordinator {
  private readonly storageKey: string;
  private readonly persistDebounceMs: number;
  private readonly persistThrottleMs: number;
  private readonly storage: StorageAdapter;
  private readonly asyncStorage: AsyncStorageAdapter | null;
  private readonly timer: TimerAdapter;
  private readonly onError?: (err: PassiveIntentError) => void;

  /* Late-bound after attach() */
  private graph: MarkovGraph | null = null;
  private bloom: BloomFilter | null = null;

  /* Write-orchestration state */
  private isAsyncWriting = false;
  private hasPendingAsyncPersist = false;
  private asyncWriteFailCount = 0;
  private lastPersistedAt: number = -Infinity;
  private throttleTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;

  /* Lifecycle */
  private isClosed = false;

  /* Mutable coordination flags — internal only */
  private isDirty = false;
  private engineHealthInternal: PassiveIntentTelemetry['engineHealth'] = 'healthy';

  /** Signal that new state has been written and needs to be persisted. */
  markDirty(): void {
    this.isDirty = true;
  }

  constructor(config: PersistenceCoordinatorConfig) {
    this.storageKey = config.storageKey;
    this.persistDebounceMs = config.persistDebounceMs;
    this.persistThrottleMs = config.persistThrottleMs;
    this.storage = config.storage;
    this.asyncStorage = config.asyncStorage;
    this.timer = config.timer;
    this.onError = config.onError;
  }

  get engineHealth(): PassiveIntentTelemetry['engineHealth'] {
    return this.engineHealthInternal;
  }

  /**
   * Provide the live graph and bloom filter after they have been constructed.
   * Must be called before the first `persist()`.
   */
  attach(graph: MarkovGraph, bloom: BloomFilter): void {
    this.graph = graph;
    this.bloom = bloom;
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
      if (this.onError) {
        this.onError({
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
      if (this.onError) {
        const payloadByteLength =
          typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(raw as string).length
            : (raw as string).length;
        this.onError({
          code: 'RESTORE_PARSE',
          message: err instanceof Error ? err.message : String(err),
          originalError: { cause: err, payloadLength: payloadByteLength },
        });
      }
      return null;
    }
  }

  /* ================================================================== */
  /*  Persist                                                             */
  /* ================================================================== */

  /**
   * Write the current Bloom filter + Markov graph to storage.
   *
   * Behaviour is identical to the original `IntentManager.persist()`:
   *   - No-op when `isDirty` is false.
   *   - No-op when an async write is already in-flight (sets `hasPendingAsyncPersist`).
   *   - Throttle gate: skip within `persistThrottleMs` window; schedule trailing flush.
   *   - Sync path: writes synchronously; surfaces errors via `onError`.
   *   - Async path: fire-and-forget with in-flight guard and one-shot retry.
   */
  persist(): void {
    if (!this.isDirty) return;
    if (!this.graph || !this.bloom) return;

    if (this.asyncStorage && this.isAsyncWriting) {
      this.hasPendingAsyncPersist = true;
      return;
    }

    if (this.persistThrottleMs > 0 && !this.isClosed) {
      const now = this.timer.now();
      const elapsed = now - this.lastPersistedAt;
      if (elapsed < this.persistThrottleMs) {
        if (this.throttleTimer === null) {
          const remainingMs = this.persistThrottleMs - elapsed;
          this.throttleTimer = this.timer.setTimeout(() => {
            this.throttleTimer = null;
            this.persist();
          }, remainingMs);
        }
        return;
      }
    }

    this.engineHealthInternal = 'pruning_active';
    try {
      this.graph.prune();
    } finally {
      this.engineHealthInternal = 'healthy';
    }

    let graphBinary: string;
    try {
      const graphBytes = this.graph.toBinary();
      graphBinary = uint8ToBase64(graphBytes);
    } catch (err) {
      if (this.onError) {
        this.onError({
          code: 'SERIALIZE',
          message: err instanceof Error ? err.message : String(err),
          originalError: err,
        });
      }
      return;
    }

    const payload: PersistedPayload = {
      bloomBase64: this.bloom.toBase64(),
      graphBinary,
    };

    if (this.asyncStorage) {
      this.isAsyncWriting = true;
      this.hasPendingAsyncPersist = false;
      this.isDirty = false;

      let setItemPromise: Promise<void>;
      try {
        setItemPromise = this.asyncStorage.setItem(this.storageKey, JSON.stringify(payload));
      } catch (err: unknown) {
        // Synchronous throw from setItem — treat identically to a promise rejection.
        this.handleAsyncWriteError(err);
        return;
      }

      setItemPromise
        .then(() => {
          this.isAsyncWriting = false;
          this.asyncWriteFailCount = 0;
          this.lastPersistedAt = this.timer.now();
          this.engineHealthInternal = 'healthy';
          if (this.hasPendingAsyncPersist || this.isDirty) {
            this.hasPendingAsyncPersist = false;
            this.persist();
          }
        })
        .catch((err: unknown) => {
          this.handleAsyncWriteError(err);
        });
    } else {
      try {
        this.storage.setItem(this.storageKey, JSON.stringify(payload));
        this.isDirty = false;
        this.lastPersistedAt = this.timer.now();
        this.engineHealthInternal = 'healthy';
      } catch (err) {
        const isQuota =
          err instanceof Error &&
          (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota'));
        if (isQuota) {
          this.engineHealthInternal = 'quota_exceeded';
        }
        if (this.onError) {
          this.onError({
            code: isQuota ? 'QUOTA_EXCEEDED' : 'STORAGE_WRITE',
            message: err instanceof Error ? err.message : String(err),
            originalError: err,
          });
        }
      }
    }
  }

  /* ================================================================== */
  /*  Flush / Cancel                                                      */
  /* ================================================================== */

  /**
   * Cancel pending throttle/retry timers and force an immediate persist,
   * bypassing the throttle gate.
   * Used by `IntentManager.flushNow()` and `destroy()`.
   */
  flushNow(): void {
    if (this.throttleTimer !== null) {
      this.timer.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    if (this.retryTimer !== null) {
      this.timer.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.lastPersistedAt = -Infinity;
    this.persist();
  }

  /**
   * Mark this coordinator as permanently closed.
   *
   * After this call:
   *   - No new throttle or retry timers will be scheduled.
   *   - Any in-flight async `setItem` that rejects cannot re-arm a retry timer.
   *   - Pending throttle/retry timers are cancelled immediately.
   *   - `persist()` itself remains callable — an in-flight async write's `.then()`
   *     may still invoke it to flush dirty state queued during the write.  What is
   *     prevented is any *timer-driven* follow-up after teardown.
   *
   * Call this from `IntentManager.destroy()` *after* `flushNow()` so the
   * best-effort final write is still attempted, but its failure cannot
   * schedule further work on the torn-down instance.
   */
  close(): void {
    this.isClosed = true;
    if (this.throttleTimer !== null) {
      this.timer.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    if (this.retryTimer !== null) {
      this.timer.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /* ================================================================== */
  /*  Retry                                                               */
  /* ================================================================== */

  private schedulePersist(): void {
    if (this.isClosed) return;
    if (this.retryTimer !== null) {
      this.timer.clearTimeout(this.retryTimer);
    }
    this.retryTimer = this.timer.setTimeout(() => {
      this.retryTimer = null;
      this.persist();
    }, this.persistDebounceMs);
  }

  /**
   * Shared error handler for both synchronous throws from `asyncStorage.setItem`
   * and promise rejections.  Keeps the two paths in sync without duplication.
   */
  private handleAsyncWriteError(err: unknown): void {
    this.isAsyncWriting = false;
    this.isDirty = true;
    this.asyncWriteFailCount += 1;
    const isQuota =
      err instanceof Error &&
      (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota'));
    if (isQuota) {
      this.engineHealthInternal = 'quota_exceeded';
    }
    if (this.onError) {
      this.onError({
        code: isQuota ? 'QUOTA_EXCEEDED' : 'STORAGE_WRITE',
        message: err instanceof Error ? err.message : String(err),
        originalError: err,
      });
    }
    this.hasPendingAsyncPersist = false;
    if (!this.isClosed && this.asyncWriteFailCount === 1) {
      this.schedulePersist();
    }
  }
}
