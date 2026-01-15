export class TtlLruSet {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly entries: Map<string, number>;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  has(key: string, now: number): boolean {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    if (expiry < now) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    this.entries.set(key, expiry);
    return true;
  }

  add(key: string, now: number): void {
    this.entries.set(key, now + this.ttlMs);
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
  }

  prune(now: number): void {
    for (const [key, expiry] of this.entries) {
      if (expiry < now) this.entries.delete(key);
      else break;
    }
  }
}
