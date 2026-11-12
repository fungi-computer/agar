import type { ReadonlyStore } from "./store.js";

/** What an App's history can do right now; publish these as `canGoBack` and `canGoForward`. */
export type AppHistorySnapshot<Entry> = Readonly<{
  /** The place the App shows now. */
  current: Entry;
  canGoBack: boolean;
  canGoForward: boolean;
}>;

/**
 * An App's own history: a back stack and a forward stack around the current
 * entry. The browser's history is not available to an App because its iframe
 * shares the Hub tab, so an App that has no router of its own keeps this.
 */
export type AppHistory<Entry> = ReadonlyStore<AppHistorySnapshot<Entry>> & {
  /** Go to a new place; whatever Forward could reach is dropped. */
  push(entry: Entry): void;
  /** Swap the current place without adding a step. */
  replace(entry: Entry): void;
  /** Step back; `false` when there is nowhere to go. Fits `onBack`. */
  back(): boolean;
  /** Step forward; `false` when there is nowhere to go. Fits `onForward`. */
  forward(): boolean;
};

/** Start a history at `initial`; entries are held as given, so keep them immutable. */
export function createAppHistory<Entry>(initial: Entry): AppHistory<Entry> {
  const back: Entry[] = [];
  const forward: Entry[] = [];
  let current = initial;
  let snapshot = snapshotOf(current, back, forward);
  const listeners = new Set<(value: AppHistorySnapshot<Entry>) => void>();
  const commit = (): void => {
    snapshot = snapshotOf(current, back, forward);
    for (const listener of listeners) listener(snapshot);
  };
  return Object.freeze({
    get: () => snapshot,
    subscribe(listener: (value: AppHistorySnapshot<Entry>) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(entry: Entry) {
      back.push(current);
      forward.length = 0;
      current = entry;
      commit();
    },
    replace(entry: Entry) {
      current = entry;
      commit();
    },
    back() {
      const previous = back.pop();
      if (previous === undefined) return false;
      forward.push(current);
      current = previous;
      commit();
      return true;
    },
    forward() {
      const next = forward.pop();
      if (next === undefined) return false;
      back.push(current);
      current = next;
      commit();
      return true;
    },
  });
}

function snapshotOf<Entry>(
  current: Entry,
  back: readonly Entry[],
  forward: readonly Entry[],
): AppHistorySnapshot<Entry> {
  return Object.freeze({
    current,
    canGoBack: back.length > 0,
    canGoForward: forward.length > 0,
  });
}
