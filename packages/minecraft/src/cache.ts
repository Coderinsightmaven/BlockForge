/**
 * Small in-memory TTL cache with in-flight de-duplication, intended for catalogue lookups in the
 * control plane. Bounded by `maxEntries` (oldest insertion evicted first). Failed loads are not
 * cached. Pure: time comes from an injectable clock.
 */
export interface TtlCacheOptions {
  defaultTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: TtlCacheOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
    if (this.defaultTtlMs <= 0) throw new RangeError("defaultTtlMs must be > 0");
    if (this.maxEntries < 1) throw new RangeError("maxEntries must be >= 1");
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: K, value: V, ttlMs: number = this.defaultTtlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Returns the cached value or runs `load` once even when called concurrently. */
  async getOrLoad(key: K, load: () => Promise<V>, ttlMs: number = this.defaultTtlMs): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await load();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
