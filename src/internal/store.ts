/**
 * WHY: stores retain semantic snapshots and isolate untrusted subscribers so
 * one callback cannot wedge publication to the host-facing UI (2026-08-27).
 */
import type { ReadonlyStore } from "../store.js";

export function createReadonlyStore<T>(
  initial: T,
): { update(value: T): void } & ReadonlyStore<T> {
  let value = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (active) {
          active = false;
          listeners.delete(listener);
        }
      };
    },
    update(next) {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of Array.from(listeners)) {
        try {
          listener(value);
        } catch (cause) {
          console.warn("App store subscriber failed", cause);
        }
      }
    },
  };
}
