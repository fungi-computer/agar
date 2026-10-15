/** Releases a subscription or other held resource. Call once; further
 * calls are a no-op. */
export type Disposer = () => void;

/** A retained SDK-owned snapshot. */
export type ReadonlyStore<T> = {
  /** The current value; always available, even before any subscription. */
  get(): T;
  /** Call `listener` on every change until the returned Disposer runs.
   * Does not emit the current value immediately on subscribe. */
  subscribe(listener: (value: T) => void): Disposer;
};
