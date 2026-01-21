/**
 * Parallel Execution Utilities
 *
 * Provides utilities for efficient parallel execution with:
 * - Batch processing with concurrency limits
 * - Result caching with TTL
 * - Error handling with partial results
 */

import type { Logger } from "./logger.util";

/** Sentinel value to distinguish "no result" from "undefined result" */
const NO_RESULT = Symbol("NO_RESULT");

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
  // Use sentinel value to distinguish "no result" from "undefined result"
  const results: (R | typeof NO_RESULT)[] = new Array(items.length).fill(
    NO_RESULT,
  );
  const errors: Error[] = [];

  // Process items in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchPromises = batch.map((item, batchIndex) => {
      const globalIndex = i + batchIndex;
      return fn(item, globalIndex)
        .then((result) => ({
          success: true as const,
          result,
          index: globalIndex,
        }))
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

  // Filter out sentinel values but keep legitimate undefined results
  const filteredResults = results.filter((r): r is R => r !== NO_RESULT);
  return { results: filteredResults, errors, totalTime };
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
    result[key] =
      value.status === "fulfilled"
        ? (value.value as Awaited<T[typeof key]>)
        : null;
  }
  return result;
}

/**
 * TTL-based cache for expensive operations
 */
export class TTLCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private pendingFetches = new Map<K, Promise<V>>();
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
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Get or fetch with automatic caching.
   * Protects against concurrent fetches - if multiple callers request the same
   * uncached key simultaneously, only one fetch will occur.
   */
  async getOrFetch(
    key: K,
    fetcher: () => Promise<V>,
    ttlMs?: number,
  ): Promise<V> {
    // Check cache first
    if (this.has(key)) {
      return this.cache.get(key)!.value;
    }

    // Check if there's already a pending fetch for this key
    const pendingFetch = this.pendingFetches.get(key);
    if (pendingFetch) {
      return pendingFetch;
    }

    // Start a new fetch and track it
    const fetchPromise = (async () => {
      try {
        const value = await fetcher();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.pendingFetches.delete(key);
      }
    })();

    this.pendingFetches.set(key, fetchPromise);
    return fetchPromise;
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
 * Coalesce concurrent calls for the same key.
 * All concurrent callers for the same key share the result of the first execution.
 * No artificial delay is added - deduplication only occurs for truly concurrent calls.
 */
export class RequestCoalescer<K, V> {
  private pending = new Map<K, Promise<V>>();

  async execute(key: K, fn: () => Promise<V>): Promise<V> {
    // If there's already a pending request for this key, return its promise
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    // Start a new request and track it
    const promise = (async () => {
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
 * @deprecated Use RequestCoalescer instead. DebouncedExecutor is kept for backwards compatibility.
 */
export const DebouncedExecutor = RequestCoalescer;

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
