/**
 * Parallel Execution Utilities
 *
 * Provides utilities for efficient parallel execution with:
 * - Batch processing with concurrency limits
 * - Result caching with TTL
 * - Error handling with partial results
 */

import type { Logger } from "./logger.util";

export interface BatchResult<T> {
  results: T[];
  errors: Error[];
  totalTime: number;
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Execute promises in parallel with a concurrency limit
 * Uses batching to prevent overwhelming the system
 */
export async function parallelBatch<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: {
    concurrency?: number;
    logger?: Logger;
    label?: string;
  } = {},
): Promise<BatchResult<R>> {
  const { concurrency = 6, logger, label = "batch" } = options;
  const startTime = Date.now();
  const results: R[] = [];
  const errors: Error[] = [];

  // Process items in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchPromises = batch.map((item, batchIndex) => {
      const globalIndex = i + batchIndex;
      return fn(item, globalIndex)
        .then((result) => ({ success: true as const, result, index: globalIndex }))
        .catch((error) => ({
          success: false as const,
          error: error instanceof Error ? error : new Error(String(error)),
          index: globalIndex,
        }));
    });

    const batchResults = await Promise.all(batchPromises);

    for (const res of batchResults) {
      if (res.success) {
        results[res.index] = res.result;
      } else {
        errors.push(res.error);
        logger?.debug(
          `[${label}] Item ${res.index} failed: ${res.error.message}`,
        );
      }
    }
  }

  const totalTime = Date.now() - startTime;
  logger?.debug(
    `[${label}] Processed ${items.length} items in ${totalTime}ms (${errors.length} errors)`,
  );

  return { results: results.filter(Boolean), errors, totalTime };
}

/**
 * Execute multiple independent promises in parallel
 * Useful for fetching multiple resources simultaneously
 */
export async function parallelFetch<T extends Record<string, Promise<unknown>>>(
  promises: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> | null }> {
  const keys = Object.keys(promises) as (keyof T)[];
  const values = await Promise.allSettled(Object.values(promises));

  const result = {} as { [K in keyof T]: Awaited<T[K]> | null };
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = values[i];
    result[key] = value.status === "fulfilled" ? (value.value as Awaited<T[typeof key]>) : null;
  }
  return result;
}

/**
 * TTL-based cache for expensive operations
 */
export class TTLCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 30_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Get or fetch with automatic caching
   */
  async getOrFetch(
    key: K,
    fetcher: () => Promise<V>,
    ttlMs?: number,
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await fetcher();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Get current cache size
   */
  get size(): number {
    // Clean expired entries first
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
    return this.cache.size;
  }
}

/**
 * Debounce multiple calls to the same function within a time window
 * Only the last call's result is returned to all waiters
 */
export class DebouncedExecutor<K, V> {
  private pending = new Map<K, Promise<V>>();
  private readonly delayMs: number;

  constructor(delayMs: number = 100) {
    this.delayMs = delayMs;
  }

  async execute(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      // Small delay to collect concurrent calls
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      try {
        return await fn();
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, promise);
    return promise;
  }
}

/**
 * Combine multiple balance/allowance checks into a single batch
 */
export async function batchBalanceChecks<T>(
  addresses: string[],
  checkFn: (address: string) => Promise<T>,
  options: {
    concurrency?: number;
    logger?: Logger;
  } = {},
): Promise<Map<string, T>> {
  const { concurrency = 4, logger } = options;
  const results = new Map<string, T>();

  const batchResult = await parallelBatch(
    addresses,
    async (address) => {
      const result = await checkFn(address);
      return { address, result };
    },
    { concurrency, logger, label: "balance-check" },
  );

  for (const item of batchResult.results) {
    if (item) {
      results.set(item.address, item.result);
    }
  }

  return results;
}
