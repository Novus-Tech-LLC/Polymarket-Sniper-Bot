# Performance Optimization Guide

This document describes the performance optimizations implemented in the Polymarket Sniper Bot codebase.

## Summary of Improvements

### 1. Parallel Address Checking (Mempool Monitor)
**File:** `src/services/mempool-monitor.service.ts`

**Problem:** The mempool monitor was checking target addresses sequentially, causing delays when monitoring multiple addresses.

**Solution:** Implemented parallel batch processing using the new `parallelBatch` utility with configurable concurrency (default: 4 concurrent requests).

**Impact:** Monitoring time for N addresses reduced from `N * request_time` to approximately `ceil(N/4) * request_time`.

### 2. Parallel Balance Checks (Trade Executor)
**File:** `src/services/trade-executor.service.ts`

**Problem:** USDC and POL balance checks were performed sequentially, adding unnecessary latency to trade execution.

**Solution:** 
- Implemented `parallelFetch` to fetch both balances simultaneously
- Added a TTL cache (5 seconds) to avoid redundant RPC calls within the same trade cycle

**Impact:** Balance check time reduced by ~50% (from 2 sequential RPC calls to 1 parallel call).

### 3. Market Data Caching (Arbitrage Provider)
**File:** `src/arbitrage/provider/polymarket.provider.ts`

**Problem:** 
- Orderbooks were fetched repeatedly during the same scan cycle
- Active markets list was fetched on every scan even though it doesn't change frequently

**Solution:**
- Added 2-second TTL cache for orderbook data to avoid redundant API calls within the same scan
- Added 30-second TTL cache for active markets list

**Impact:** Reduced API calls during arbitrage scans, especially beneficial for markets with multiple token pairs.

## New Utilities

### TTLCache
A generic time-to-live cache implementation for expensive operations.

```typescript
import { TTLCache } from "../utils/parallel-utils";

const cache = new TTLCache<string, number>(30000); // 30 second default TTL

// Manual set/get
cache.set("key", 42);
const value = cache.get("key");

// Automatic fetch-on-miss
const result = await cache.getOrFetch("key", async () => {
  return await expensiveOperation();
});
```

### parallelBatch
Execute promises in parallel with a concurrency limit, collecting results and errors.

```typescript
import { parallelBatch } from "../utils/parallel-utils";

const result = await parallelBatch(
  items,
  async (item) => processItem(item),
  { concurrency: 4 }
);
// result.results: successful results
// result.errors: collected errors
// result.totalTime: total execution time
```

### parallelFetch
Execute multiple independent promises in parallel, returning null for failures.

```typescript
import { parallelFetch } from "../utils/parallel-utils";

const balances = await parallelFetch({
  usdc: getUsdcBalance(),
  pol: getPolBalance(),
});
// balances.usdc and balances.pol will be the values or null on error
```

### DebouncedExecutor
Dedupe concurrent calls to the same operation within a time window.

```typescript
import { DebouncedExecutor } from "../utils/parallel-utils";

const executor = new DebouncedExecutor<string, Result>(100);
// Multiple calls with same key within 100ms will share the same result
const result = await executor.execute("key", async () => expensiveOp());
```

## Configuration

### Cache TTLs

| Cache | Default TTL | Environment Variable |
|-------|-------------|---------------------|
| Orderbook | 2s | Not configurable |
| Active Markets | 30s | Not configurable |
| Balance Check | 5s | Not configurable |

### Concurrency Limits

| Operation | Default Concurrency | Notes |
|-----------|-------------------|-------|
| Address Monitoring | 4 | Parallel checks per polling cycle |
| Orderbook Fetching | 6 | Per scan cycle (existing limiter) |

## Best Practices

1. **Use TTL caching** for data that doesn't change frequently but is accessed multiple times
2. **Use parallel fetching** when multiple independent API calls can be made simultaneously
3. **Set appropriate concurrency limits** to avoid overwhelming APIs (Polymarket has rate limits)
4. **Keep cache TTLs short** for trading-critical data to ensure freshness
5. **Handle cache misses gracefully** - always have a fallback fetch strategy
