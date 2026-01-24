import assert from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";
import {
  LogDeduper,
  SkipReasonAggregator,
  getLogDeduper,
  resetLogDeduper,
  SKIP_LOG_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "../../src/utils/log-deduper.util";

describe("LogDeduper", () => {
  let deduper: LogDeduper;

  beforeEach(() => {
    deduper = new LogDeduper();
  });

  describe("shouldLog", () => {
    test("returns true on first call for a key", () => {
      const result = deduper.shouldLog("test:key");
      assert.strictEqual(result, true, "First call should return true");
    });

    test("returns false on immediate second call (within TTL)", () => {
      deduper.shouldLog("test:key");
      const result = deduper.shouldLog("test:key");
      assert.strictEqual(
        result,
        false,
        "Second immediate call should return false",
      );
    });

    test("returns true after TTL expires", async () => {
      const shortTtl = 50; // 50ms for testing
      deduper.shouldLog("test:key", shortTtl);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, shortTtl + 10));

      const result = deduper.shouldLog("test:key", shortTtl);
      assert.strictEqual(result, true, "Should return true after TTL expires");
    });

    test("returns true immediately when fingerprint changes", () => {
      deduper.shouldLog("test:key", 120_000, "fingerprint-1");
      const result = deduper.shouldLog("test:key", 120_000, "fingerprint-2");
      assert.strictEqual(
        result,
        true,
        "Should return true when fingerprint changes",
      );
    });

    test("returns false when fingerprint is unchanged within TTL", () => {
      deduper.shouldLog("test:key", 120_000, "same-fingerprint");
      const result = deduper.shouldLog("test:key", 120_000, "same-fingerprint");
      assert.strictEqual(
        result,
        false,
        "Should return false for same fingerprint within TTL",
      );
    });

    test("different keys are independent", () => {
      deduper.shouldLog("key1");
      deduper.shouldLog("key2");

      // Second calls should both be false
      assert.strictEqual(deduper.shouldLog("key1"), false);
      assert.strictEqual(deduper.shouldLog("key2"), false);

      // But a new key should be true
      assert.strictEqual(deduper.shouldLog("key3"), true);
    });
  });

  describe("shouldLogDetailed", () => {
    test("returns first_time reason on first call", () => {
      const result = deduper.shouldLogDetailed("test:key");
      assert.strictEqual(result.shouldLog, true);
      assert.strictEqual(result.reason, "first_time");
      assert.strictEqual(result.suppressedCount, 0);
    });

    test("returns suppressed reason on second immediate call", () => {
      deduper.shouldLogDetailed("test:key");
      const result = deduper.shouldLogDetailed("test:key");
      assert.strictEqual(result.shouldLog, false);
      assert.strictEqual(result.reason, "suppressed");
    });

    test("tracks suppressed count correctly", () => {
      deduper.shouldLogDetailed("test:key");
      deduper.shouldLogDetailed("test:key");
      deduper.shouldLogDetailed("test:key");
      const result = deduper.shouldLogDetailed("test:key");

      assert.strictEqual(result.shouldLog, false);
      assert.strictEqual(result.reason, "suppressed");
      assert.strictEqual(
        result.suppressedCount,
        3,
        "Should count 3 suppressed calls",
      );
    });

    test("returns fingerprint_changed reason when fingerprint changes", () => {
      deduper.shouldLogDetailed("test:key", 120_000, "fp1");
      const result = deduper.shouldLogDetailed("test:key", 120_000, "fp2");
      assert.strictEqual(result.shouldLog, true);
      assert.strictEqual(result.reason, "fingerprint_changed");
    });

    test("returns ttl_expired reason after TTL", async () => {
      const shortTtl = 50;
      deduper.shouldLogDetailed("test:key", shortTtl);
      await new Promise((resolve) => setTimeout(resolve, shortTtl + 10));

      const result = deduper.shouldLogDetailed("test:key", shortTtl);
      assert.strictEqual(result.shouldLog, true);
      assert.strictEqual(result.reason, "ttl_expired");
    });

    test("includes suppressed count when fingerprint changes", () => {
      deduper.shouldLogDetailed("test:key", 120_000, "fp1");
      deduper.shouldLogDetailed("test:key", 120_000, "fp1"); // suppressed 1
      deduper.shouldLogDetailed("test:key", 120_000, "fp1"); // suppressed 2

      const result = deduper.shouldLogDetailed("test:key", 120_000, "fp2");
      assert.strictEqual(result.shouldLog, true);
      assert.strictEqual(result.suppressedCount, 2);
    });
  });

  describe("shouldLogSkip", () => {
    test("creates correct key format", () => {
      const result1 = deduper.shouldLogSkip(
        "Hedging",
        "token123",
        "redeemable",
      );
      assert.strictEqual(result1, true, "First call should return true");

      const result2 = deduper.shouldLogSkip(
        "Hedging",
        "token123",
        "redeemable",
      );
      assert.strictEqual(
        result2,
        false,
        "Second call with same args should return false",
      );

      // Different token should be true
      const result3 = deduper.shouldLogSkip(
        "Hedging",
        "token456",
        "redeemable",
      );
      assert.strictEqual(result3, true, "Different token should return true");

      // Different reason should be true
      const result4 = deduper.shouldLogSkip("Hedging", "token123", "no_book");
      assert.strictEqual(result4, true, "Different reason should return true");
    });
  });

  describe("shouldLogSummary", () => {
    test("logs on fingerprint change", () => {
      const fp1 = JSON.stringify({ skipped: 5 });
      const fp2 = JSON.stringify({ skipped: 6 });

      assert.strictEqual(deduper.shouldLogSummary("Hedging", fp1), true);
      assert.strictEqual(deduper.shouldLogSummary("Hedging", fp1), false);
      assert.strictEqual(deduper.shouldLogSummary("Hedging", fp2), true);
    });
  });

  describe("reset", () => {
    test("reset clears specific key", () => {
      deduper.shouldLog("key1");
      deduper.shouldLog("key2");

      deduper.reset("key1");

      assert.strictEqual(
        deduper.shouldLog("key1"),
        true,
        "Reset key should return true",
      );
      assert.strictEqual(
        deduper.shouldLog("key2"),
        false,
        "Non-reset key should return false",
      );
    });

    test("resetAll clears all keys", () => {
      deduper.shouldLog("key1");
      deduper.shouldLog("key2");

      deduper.resetAll();

      assert.strictEqual(deduper.shouldLog("key1"), true);
      assert.strictEqual(deduper.shouldLog("key2"), true);
    });
  });

  describe("memory management", () => {
    test("evicts old entries when over max", () => {
      const smallDeduper = new LogDeduper(3); // Max 3 entries

      smallDeduper.shouldLog("key1");
      smallDeduper.shouldLog("key2");
      smallDeduper.shouldLog("key3");

      assert.strictEqual(smallDeduper.getEntryCount(), 3);

      // Adding a 4th should evict the oldest
      smallDeduper.shouldLog("key4");

      assert.strictEqual(smallDeduper.getEntryCount(), 3);
      // key1 was oldest and should be evicted
      assert.strictEqual(
        smallDeduper.shouldLog("key1"),
        true,
        "Evicted key should return true on next call",
      );
    });
  });

  describe("getSuppressedCount", () => {
    test("returns 0 for unknown key", () => {
      assert.strictEqual(deduper.getSuppressedCount("unknown"), 0);
    });

    test("returns correct count after suppressions", () => {
      deduper.shouldLog("test:key");
      deduper.shouldLog("test:key"); // +1
      deduper.shouldLog("test:key"); // +2

      assert.strictEqual(deduper.getSuppressedCount("test:key"), 2);
    });
  });
});

describe("SkipReasonAggregator", () => {
  let aggregator: SkipReasonAggregator;

  beforeEach(() => {
    aggregator = new SkipReasonAggregator();
  });

  describe("add and getCount", () => {
    test("tracks unique tokenIds per reason", () => {
      aggregator.add("token1", "redeemable");
      aggregator.add("token2", "redeemable");
      aggregator.add("token1", "redeemable"); // Duplicate - should not increase count

      assert.strictEqual(aggregator.getCount("redeemable"), 2);
    });

    test("tracks multiple reasons independently", () => {
      aggregator.add("token1", "redeemable");
      aggregator.add("token2", "no_book");
      aggregator.add("token3", "redeemable");

      assert.strictEqual(aggregator.getCount("redeemable"), 2);
      assert.strictEqual(aggregator.getCount("no_book"), 1);
      assert.strictEqual(aggregator.getCount("unknown_reason"), 0);
    });
  });

  describe("getTotalCount", () => {
    test("counts unique tokenIds across all reasons", () => {
      aggregator.add("token1", "redeemable");
      aggregator.add("token2", "redeemable");
      aggregator.add("token1", "no_book"); // Same token, different reason
      aggregator.add("token3", "spread_wide");

      // token1, token2, token3 = 3 unique
      assert.strictEqual(aggregator.getTotalCount(), 3);
    });
  });

  describe("getSummary", () => {
    test("returns empty string when no skips", () => {
      assert.strictEqual(aggregator.getSummary(), "");
    });

    test("returns formatted summary sorted by count", () => {
      aggregator.add("token1", "redeemable");
      aggregator.add("token2", "redeemable");
      aggregator.add("token3", "redeemable");
      aggregator.add("token4", "no_book");
      aggregator.add("token5", "spread_wide");
      aggregator.add("token6", "spread_wide");

      const summary = aggregator.getSummary();
      // Should be sorted by count descending
      assert.ok(
        summary.includes("redeemable=3"),
        "Should include redeemable=3",
      );
      assert.ok(
        summary.includes("spread_wide=2"),
        "Should include spread_wide=2",
      );
      assert.ok(summary.includes("no_book=1"), "Should include no_book=1");

      // redeemable should come first (highest count)
      const redeemableIdx = summary.indexOf("redeemable");
      const spreadIdx = summary.indexOf("spread_wide");
      const noBookIdx = summary.indexOf("no_book");
      assert.ok(
        redeemableIdx < spreadIdx,
        "redeemable should come before spread_wide",
      );
      assert.ok(
        spreadIdx < noBookIdx,
        "spread_wide should come before no_book",
      );
    });
  });

  describe("getFingerprint", () => {
    test("returns stable JSON fingerprint", () => {
      aggregator.add("token1", "redeemable");
      aggregator.add("token2", "no_book");

      const fp = aggregator.getFingerprint();
      const parsed = JSON.parse(fp);

      assert.deepStrictEqual(parsed, { no_book: 1, redeemable: 1 });
    });

    test("fingerprint is stable regardless of add order", () => {
      const agg1 = new SkipReasonAggregator();
      agg1.add("token1", "redeemable");
      agg1.add("token2", "no_book");

      const agg2 = new SkipReasonAggregator();
      agg2.add("token2", "no_book");
      agg2.add("token1", "redeemable");

      assert.strictEqual(agg1.getFingerprint(), agg2.getFingerprint());
    });
  });

  describe("hasSkips and clear", () => {
    test("hasSkips returns false when empty", () => {
      assert.strictEqual(aggregator.hasSkips(), false);
    });

    test("hasSkips returns true when has data", () => {
      aggregator.add("token1", "redeemable");
      assert.strictEqual(aggregator.hasSkips(), true);
    });

    test("clear resets all data", () => {
      aggregator.add("token1", "redeemable");
      aggregator.add("token2", "no_book");

      aggregator.clear();

      assert.strictEqual(aggregator.hasSkips(), false);
      assert.strictEqual(aggregator.getCount("redeemable"), 0);
    });
  });
});

describe("Global LogDeduper singleton", () => {
  afterEach(() => {
    resetLogDeduper();
  });

  test("getLogDeduper returns same instance", () => {
    const instance1 = getLogDeduper();
    const instance2 = getLogDeduper();
    assert.strictEqual(instance1, instance2);
  });

  test("resetLogDeduper creates new instance", () => {
    const instance1 = getLogDeduper();
    instance1.shouldLog("test:key");

    resetLogDeduper();

    const instance2 = getLogDeduper();
    // New instance should return true for same key
    assert.strictEqual(instance2.shouldLog("test:key"), true);
  });
});

describe("Default TTL constants", () => {
  test("SKIP_LOG_TTL_MS has sensible default", () => {
    assert.ok(
      SKIP_LOG_TTL_MS >= 60_000,
      "SKIP_LOG_TTL_MS should be at least 60 seconds",
    );
    assert.ok(
      SKIP_LOG_TTL_MS <= 600_000,
      "SKIP_LOG_TTL_MS should be at most 10 minutes",
    );
  });

  test("HEARTBEAT_INTERVAL_MS has sensible default", () => {
    assert.ok(
      HEARTBEAT_INTERVAL_MS >= 60_000,
      "HEARTBEAT_INTERVAL_MS should be at least 60 seconds",
    );
    assert.ok(
      HEARTBEAT_INTERVAL_MS <= 600_000,
      "HEARTBEAT_INTERVAL_MS should be at most 10 minutes",
    );
  });
});
