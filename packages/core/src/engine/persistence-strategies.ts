/**
 * Copyright (c) 2026 Purushottam <purushottam@passiveintent.dev>
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
import { uint8ToBase64 } from '../persistence/codec.js';
import type { PassiveIntentError, PassiveIntentTelemetry } from '../types/events.js';

export interface PersistedPayload {
  bloomBase64: string;
  graphBinary?: string;
  graph?: SerializedMarkovGraph;
}

export interface PersistStrategyContext {
  getStorageKey(): string;
  getStorage(): StorageAdapter;
  getAsyncStorage(): AsyncStorageAdapter | null;
  getTimer(): TimerAdapter;
  getThrottleMs(): number;
  getDebounceMs(): number;
  getGraphAndBloom(): { graph: MarkovGraph; bloom: BloomFilter } | null;

  isClosed(): boolean;
  isDirty(): boolean;
  clearDirty(): void;
  markDirty(): void;

  setEngineHealth(health: PassiveIntentTelemetry['engineHealth']): void;
  reportError(code: PassiveIntentError['code'], message: string, err: unknown): void;
}

export interface PersistStrategy {
  persist(): void;
  flushNow(): void;
  close(): void;
}

export abstract class BasePersistStrategy implements PersistStrategy {
  protected lastPersistedAt = -Infinity;
  protected throttleTimer: TimerHandle | null = null;
  protected isClosedFlag = false;

  constructor(protected readonly ctx: PersistStrategyContext) {}

  abstract persist(): void;

  protected serialize(): string | null {
    const data = this.ctx.getGraphAndBloom();
    if (!data) return null;
    const { graph, bloom } = data;

    this.ctx.setEngineHealth('pruning_active');
    try {
      graph.prune();
    } finally {
      this.ctx.setEngineHealth('healthy');
    }

    let graphBinary: string;
    try {
      const graphBytes = graph.toBinary();
      graphBinary = uint8ToBase64(graphBytes);
    } catch (err) {
      this.ctx.reportError('SERIALIZE', err instanceof Error ? err.message : String(err), err);
      return null;
    }

    return JSON.stringify({
      bloomBase64: bloom.toBase64(),
      graphBinary,
    });
  }

  flushNow(): void {
    if (this.throttleTimer !== null) {
      this.ctx.getTimer().clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.lastPersistedAt = -Infinity;
    this.persist();
  }

  close(): void {
    this.isClosedFlag = true;
    if (this.throttleTimer !== null) {
      this.ctx.getTimer().clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  protected checkThrottle(): boolean {
    const throttleMs = this.ctx.getThrottleMs();
    if (throttleMs > 0 && !this.isClosedFlag) {
      const now = this.ctx.getTimer().now();
      const elapsed = now - this.lastPersistedAt;
      if (elapsed < throttleMs) {
        if (this.throttleTimer === null) {
          const remainingMs = throttleMs - elapsed;
          this.throttleTimer = this.ctx.getTimer().setTimeout(() => {
            this.throttleTimer = null;
            this.persist();
          }, remainingMs);
        }
        return true;
      }
    }
    return false;
  }
}

export class SyncPersistStrategy extends BasePersistStrategy {
  persist(): void {
    if (!this.ctx.isDirty() || !this.ctx.getGraphAndBloom()) return;

    if (this.checkThrottle()) return;

    const payload = this.serialize();
    if (!payload) return;

    try {
      this.ctx.getStorage().setItem(this.ctx.getStorageKey(), payload);
      this.ctx.clearDirty();
      this.lastPersistedAt = this.ctx.getTimer().now();
      this.ctx.setEngineHealth('healthy');
    } catch (err) {
      const isQuota =
        err instanceof Error &&
        (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota'));
      if (isQuota) {
        this.ctx.setEngineHealth('quota_exceeded');
      }
      this.ctx.reportError(
        isQuota ? 'QUOTA_EXCEEDED' : 'STORAGE_WRITE',
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }
}

export class AsyncPersistStrategy extends BasePersistStrategy {
  private isAsyncWriting = false;
  private hasPendingAsyncPersist = false;
  private asyncWriteFailCount = 0;
  private retryTimer: TimerHandle | null = null;

  persist(): void {
    if (!this.ctx.isDirty() || !this.ctx.getGraphAndBloom()) return;

    if (this.isAsyncWriting) {
      this.hasPendingAsyncPersist = true;
      return;
    }

    if (this.checkThrottle()) return;

    const payload = this.serialize();
    if (!payload) return;

    this.isAsyncWriting = true;
    this.hasPendingAsyncPersist = false;
    this.ctx.clearDirty();

    const asyncStorage = this.ctx.getAsyncStorage()!;
    let setItemPromise: Promise<void>;
    try {
      setItemPromise = asyncStorage.setItem(this.ctx.getStorageKey(), payload);
    } catch (err: unknown) {
      this.handleAsyncWriteError(err);
      return;
    }

    setItemPromise
      .then(() => {
        this.isAsyncWriting = false;
        this.asyncWriteFailCount = 0;
        this.lastPersistedAt = this.ctx.getTimer().now();
        this.ctx.setEngineHealth('healthy');
        if (this.hasPendingAsyncPersist || this.ctx.isDirty()) {
          this.hasPendingAsyncPersist = false;
          this.persist();
        }
      })
      .catch((err: unknown) => {
        this.handleAsyncWriteError(err);
      });
  }

  private handleAsyncWriteError(err: unknown): void {
    this.isAsyncWriting = false;
    this.ctx.markDirty();
    this.asyncWriteFailCount += 1;

    const isQuota =
      err instanceof Error &&
      (err.name === 'QuotaExceededError' || err.message.toLowerCase().includes('quota'));
    if (isQuota) {
      this.ctx.setEngineHealth('quota_exceeded');
    }
    this.ctx.reportError(
      isQuota ? 'QUOTA_EXCEEDED' : 'STORAGE_WRITE',
      err instanceof Error ? err.message : String(err),
      err,
    );

    this.hasPendingAsyncPersist = false;
    if (!this.isClosedFlag && this.asyncWriteFailCount === 1) {
      this.schedulePersist();
    }
  }

  private schedulePersist(): void {
    if (this.isClosedFlag) return;
    if (this.retryTimer !== null) {
      this.ctx.getTimer().clearTimeout(this.retryTimer);
    }
    this.retryTimer = this.ctx.getTimer().setTimeout(() => {
      this.retryTimer = null;
      this.persist();
    }, this.ctx.getDebounceMs());
  }

  override flushNow(): void {
    if (this.retryTimer !== null) {
      this.ctx.getTimer().clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    super.flushNow();
  }

  override close(): void {
    super.close();
    if (this.retryTimer !== null) {
      this.ctx.getTimer().clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
