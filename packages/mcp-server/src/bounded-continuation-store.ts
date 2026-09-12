export interface BoundedContinuationStoreOptions {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

interface StoredEntry<T> {
  readonly value: T;
  readonly createdAt: number;
}

export class BoundedContinuationStore<T> {
  private readonly entries = new Map<string, StoredEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: BoundedContinuationStoreOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.now = options.now ?? Date.now;
  }

  public set(token: string, value: T): void {
    this.pruneExpired();
    this.entries.delete(token);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(token, { value, createdAt: this.now() });
  }

  public take(token: string): T | undefined {
    this.pruneExpired();
    const entry = this.entries.get(token);
    if (entry === undefined) return undefined;
    this.entries.delete(token);
    return entry.value;
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, entry] of this.entries) {
      if (entry.createdAt > cutoff) continue;
      this.entries.delete(token);
    }
  }
}
