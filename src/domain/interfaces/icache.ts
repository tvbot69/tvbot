/**
 * The cache capability the lower layers are allowed to depend on.
 *
 * `lastFmRepository` is under `src/`, and it was importing `CacheService` from
 * `@bot/*` to call two methods. This interface exists so it can ask for the
 * capability instead of the implementation - the plan's 3.2 rule that lower
 * layers must not import `@bot/*`.
 *
 * SCOPED DELIBERATELY NARROW. `CacheService` exposes fifteen public methods
 * (lists, sets, counters, sweeps, disconnect). This port declares the two the
 * consumer actually calls. A port that mirrors the whole class is not a port,
 * it is an alias - and it would keep the inversion nominal rather than real.
 * Add a method here when a real caller needs it, not before.
 *
 * The binding is made once in the composition root: `CacheService` is
 * registered under the `ICACHE` token, so the implementation is chosen in
 * `startup.ts` and nowhere else.
 */

/** Injection token for {@link ICache}. A string so `src/` need not import the class. */
export const ICACHE = 'ICache';

export interface ICache {
  /** Returns the cached value, or null when absent or on any cache failure. */
  get<T>(key: string): Promise<T | null>;
  /** Stores a value. `ttlSeconds` omitted means the backend's default. */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}
