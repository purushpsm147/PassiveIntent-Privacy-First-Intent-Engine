/**
 * Copyright (c) 2026 Purushottam <purushpsm147@yahoo.co.in>
 *
 * This source code is licensed under the AGPL-3.0-only license found in the
 * LICENSE file in the root directory of this source tree.
 */

type Listener<T> = (payload: T) => void;

/**
 * Minimal, generic typed event emitter used by IntentManager to decouple
 * event production from consumption.
 *
 * - `on()` returns an unsubscribe function for clean teardown in SPA lifecycles.
 * - `emit()` iterates the listener set synchronously; listeners are called in
 *   insertion order.
 * - `removeAll()` is used by `IntentManager.destroy()` to prevent memory leaks
 *   when the instance is torn down.
 *
 * The class is intentionally kept framework-agnostic and dependency-free so it
 * can be extracted or tested in isolation without any engine context.
 */
export class EventEmitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener<Events[K]>>();
    set.add(listener);
    this.listeners.set(event, set as Set<Listener<any>>);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach((listener) => listener(payload));
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
