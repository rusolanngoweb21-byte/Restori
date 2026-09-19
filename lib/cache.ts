/** Bounded LRU, absolute TTL, no stale-while-revalidate for security decisions. */
export class LruCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly max: number;
  private readonly now: () => number;
  constructor(max = 256, now = Date.now) {
    this.max = max;
    this.now = now;
  }
  get(key: string): T | undefined {
    const item = this.entries.get(key);
    if (!item) return;
    this.entries.delete(key);
    if (item.expires <= this.now()) return;
    this.entries.set(key, item);
    return item.value;
  }
  set(key: string, value: T, ttlMs: number) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + ttlMs });
    while (this.entries.size > this.max)
      this.entries.delete(this.entries.keys().next().value!);
  }
}
/** Coalesce identical concurrent misses within one isolate; always release on failure. */
export class SingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();
  private readonly maximum: number;
  constructor(maximum = 128) {
    this.maximum = maximum;
  }
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current;
    if (this.pending.size >= this.maximum)
      return Promise.reject(new Error("CAPACITY"));
    const work = Promise.resolve()
      .then(fn)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
}
