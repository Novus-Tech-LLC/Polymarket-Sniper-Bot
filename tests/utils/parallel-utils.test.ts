import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parallelBatch,
  parallelFetch,
  TTLCache,
  DebouncedExecutor,
} from "../../src/utils/parallel-utils";

describe("parallelBatch", () => {
  it("should process all items with default concurrency", async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await parallelBatch(items, async (n) => n * 2);

    assert.strictEqual(result.results.length, 5);
    assert.deepStrictEqual(result.results, [2, 4, 6, 8, 10]);
    assert.strictEqual(result.errors.length, 0);
  });

  it("should respect concurrency limit", async () => {
    const startTimes: number[] = [];
    const items = [1, 2, 3, 4];

    await parallelBatch(
      items,
      async (n) => {
        startTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
        return n;
      },
      { concurrency: 2 },
    );

    // With concurrency 2 and 4 items, we should have 2 batches
    // First batch: items 0,1 start together
    // Second batch: items 2,3 start together after ~50ms
    assert.strictEqual(startTimes.length, 4);
    // Items 0 and 1 should start at nearly the same time
    assert.ok(Math.abs(startTimes[0] - startTimes[1]) < 20);
    // Items 2 and 3 should start at nearly the same time, but after items 0,1
    assert.ok(Math.abs(startTimes[2] - startTimes[3]) < 20);
  });

  it("should collect errors without failing the batch", async () => {
    const items = [1, 2, 3];
    const result = await parallelBatch(items, async (n) => {
      if (n === 2) throw new Error("test error");
      return n;
    });

    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].message, "test error");
    // Results should still contain successful items
    assert.ok(result.results.includes(1));
    assert.ok(result.results.includes(3));
  });
});

describe("parallelFetch", () => {
  it("should fetch multiple promises in parallel", async () => {
    const result = await parallelFetch({
      a: Promise.resolve(1),
      b: Promise.resolve("hello"),
      c: Promise.resolve(true),
    });

    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, "hello");
    assert.strictEqual(result.c, true);
  });

  it("should return null for rejected promises", async () => {
    const result = await parallelFetch({
      success: Promise.resolve(42),
      failure: Promise.reject(new Error("test")),
    });

    assert.strictEqual(result.success, 42);
    assert.strictEqual(result.failure, null);
  });
});

describe("TTLCache", () => {
  it("should store and retrieve values", () => {
    const cache = new TTLCache<string, number>(1000);
    cache.set("key1", 42);
    assert.strictEqual(cache.get("key1"), 42);
  });

  it("should return undefined for expired values", async () => {
    const cache = new TTLCache<string, number>(50);
    cache.set("key1", 42);
    assert.strictEqual(cache.get("key1"), 42);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(cache.get("key1"), undefined);
  });

  it("should respect custom TTL per entry", async () => {
    const cache = new TTLCache<string, number>(1000);
    cache.set("short", 1, 50);
    cache.set("long", 2, 200);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(cache.get("short"), undefined);
    assert.strictEqual(cache.get("long"), 2);
  });

  it("getOrFetch should cache fetch results", async () => {
    const cache = new TTLCache<string, number>(1000);
    let fetchCount = 0;

    const fetcher = async () => {
      fetchCount++;
      return 42;
    };

    const result1 = await cache.getOrFetch("key", fetcher);
    const result2 = await cache.getOrFetch("key", fetcher);

    assert.strictEqual(result1, 42);
    assert.strictEqual(result2, 42);
    assert.strictEqual(fetchCount, 1); // Fetcher should only be called once
  });

  it("should track size correctly", () => {
    const cache = new TTLCache<string, number>(1000);
    assert.strictEqual(cache.size, 0);

    cache.set("a", 1);
    cache.set("b", 2);
    assert.strictEqual(cache.size, 2);

    cache.delete("a");
    assert.strictEqual(cache.size, 1);

    cache.clear();
    assert.strictEqual(cache.size, 0);
  });
});

describe("DebouncedExecutor", () => {
  it("should dedupe concurrent calls with same key", async () => {
    const executor = new DebouncedExecutor<string, number>(10);
    let callCount = 0;

    const fn = async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 42;
    };

    // Start 3 concurrent calls with the same key
    const results = await Promise.all([
      executor.execute("key", fn),
      executor.execute("key", fn),
      executor.execute("key", fn),
    ]);

    // All should get the same result
    assert.deepStrictEqual(results, [42, 42, 42]);
    // But the function should only be called once
    assert.strictEqual(callCount, 1);
  });

  it("should handle different keys separately", async () => {
    const executor = new DebouncedExecutor<string, string>(10);
    let callCount = 0;

    const results = await Promise.all([
      executor.execute("a", async () => {
        callCount++;
        return "result-a";
      }),
      executor.execute("b", async () => {
        callCount++;
        return "result-b";
      }),
    ]);

    assert.ok(results.includes("result-a"));
    assert.ok(results.includes("result-b"));
    assert.strictEqual(callCount, 2);
  });
});
