import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateOrderbookQuality,
  ORDERBOOK_QUALITY_THRESHOLDS,
  CIRCUIT_BREAKER_COOLDOWNS_MS,
  CIRCUIT_BREAKER_ESCALATION_WINDOW_MS,
  DUST_COOLDOWN_MS,
  type OrderbookQualityStatus,
  type OrderbookQualityResult,
} from "../../src/strategies/scalp-take-profit";

// === ORDERBOOK QUALITY VALIDATION TESTS ===

describe("Orderbook Quality Validation", () => {
  describe("INVALID_BOOK detection", () => {
    test("bestBid=0.01, bestAsk=0.99 => INVALID_BOOK (extreme spread)", () => {
      const result = validateOrderbookQuality(0.01, 0.99);

      assert.equal(result.status, "INVALID_BOOK");
      assert.ok(result.reason?.includes("Extreme spread"));
      assert.ok(result.reason?.includes("bestBid=1.0¢"));
      assert.ok(result.reason?.includes("bestAsk=99.0¢"));
    });

    test("bestBid=0.01, bestAsk=0.99 with dataApiPrice=0.62 => INVALID_BOOK", () => {
      // Even with data API price showing 62¢, the extreme spread indicates corrupted book
      const result = validateOrderbookQuality(0.01, 0.99, 0.62);

      assert.equal(result.status, "INVALID_BOOK");
      assert.ok(result.diagnostics?.bestBid === 0.01);
      assert.ok(result.diagnostics?.bestAsk === 0.99);
      assert.ok(result.diagnostics?.dataApiPrice === 0.62);
    });

    test("bestBid=0.04, bestAsk=0.96 => INVALID_BOOK (below/above thresholds)", () => {
      // Both conditions met: bid < 5¢ AND ask > 95¢
      const result = validateOrderbookQuality(0.04, 0.96);

      assert.equal(result.status, "INVALID_BOOK");
    });

    test("bestBid=0.05, bestAsk=0.96 => VALID (bid at threshold)", () => {
      // bid = 5¢ (at threshold, not below), ask > 95¢
      // Does not meet BOTH conditions, so not INVALID_BOOK
      const result = validateOrderbookQuality(0.05, 0.96);

      assert.equal(result.status, "VALID");
    });

    test("bestBid=0.04, bestAsk=0.95 => VALID (ask at threshold)", () => {
      // bid < 5¢, ask = 95¢ (at threshold, not above)
      // Does not meet BOTH conditions, so not INVALID_BOOK
      const result = validateOrderbookQuality(0.04, 0.95);

      assert.equal(result.status, "VALID");
    });
  });

  describe("EXEC_PRICE_UNTRUSTED detection", () => {
    test("dataApiPrice=0.62, bestBid=0.01 => EXEC_PRICE_UNTRUSTED (deviation > 30¢)", () => {
      // This scenario: Data-API says position is at 62¢, but CLOB shows bestBid=1¢
      // This 61¢ deviation is clearly untrusted
      // Note: This test doesn't trigger INVALID_BOOK because bestAsk is null
      const result = validateOrderbookQuality(0.01, null, 0.62);

      assert.equal(result.status, "EXEC_PRICE_UNTRUSTED");
      assert.ok(result.reason?.includes("deviates from dataApiPrice"));
      assert.ok(result.diagnostics?.priceDeviation !== undefined);
      assert.ok(result.diagnostics!.priceDeviation! > 0.30);
    });

    test("dataApiPrice=0.60, bestBid=0.25 => EXEC_PRICE_UNTRUSTED (35¢ deviation)", () => {
      const result = validateOrderbookQuality(0.25, 0.30, 0.60);

      assert.equal(result.status, "EXEC_PRICE_UNTRUSTED");
      assert.ok(Math.abs(result.diagnostics!.priceDeviation! - 0.35) < 0.001);
    });

    test("dataApiPrice=0.60, bestBid=0.35 => VALID (25¢ deviation, within threshold)", () => {
      const result = validateOrderbookQuality(0.35, 0.40, 0.60);

      assert.equal(result.status, "VALID");
    });

    test("dataApiPrice=0.62, bestBid=0.62 => VALID (no deviation)", () => {
      const result = validateOrderbookQuality(0.62, 0.64, 0.62);

      assert.equal(result.status, "VALID");
      assert.equal(result.diagnostics?.priceDeviation, 0);
    });
  });

  describe("NO_EXECUTION_PRICE detection", () => {
    test("bestBid=null => NO_EXECUTION_PRICE", () => {
      const result = validateOrderbookQuality(null, 0.65);

      assert.equal(result.status, "NO_EXECUTION_PRICE");
      assert.ok(result.reason?.includes("No bestBid available"));
    });

    test("bestBid=0 => NO_EXECUTION_PRICE", () => {
      const result = validateOrderbookQuality(0, 0.65);

      assert.equal(result.status, "NO_EXECUTION_PRICE");
    });
  });

  describe("VALID orderbook", () => {
    test("normal book bestBid=0.63, bestAsk=0.64 => VALID", () => {
      const result = validateOrderbookQuality(0.63, 0.64);

      assert.equal(result.status, "VALID");
    });

    test("normal book with dataApiPrice matching => VALID", () => {
      const result = validateOrderbookQuality(0.63, 0.65, 0.64);

      assert.equal(result.status, "VALID");
    });

    test("wide spread but not extreme: bestBid=0.30, bestAsk=0.70 => VALID", () => {
      // 40¢ spread is wide but doesn't trigger INVALID_BOOK
      // (bid not < 5¢, ask not > 95¢)
      const result = validateOrderbookQuality(0.30, 0.70);

      assert.equal(result.status, "VALID");
    });

    test("low bid only (no extreme ask): bestBid=0.02, bestAsk=0.10 => VALID", () => {
      // Low bid but ask is also low, not INVALID_BOOK
      const result = validateOrderbookQuality(0.02, 0.10);

      assert.equal(result.status, "VALID");
    });

    test("high ask only (no extreme bid): bestBid=0.90, bestAsk=0.98 => VALID", () => {
      // High ask but bid is also high, not INVALID_BOOK
      const result = validateOrderbookQuality(0.90, 0.98);

      assert.equal(result.status, "VALID");
    });
  });
});

// === THRESHOLD CONSTANTS TESTS ===

describe("Orderbook Quality Thresholds", () => {
  test("INVALID_BID_THRESHOLD is 0.05 (5¢)", () => {
    assert.equal(ORDERBOOK_QUALITY_THRESHOLDS.INVALID_BID_THRESHOLD, 0.05);
  });

  test("INVALID_ASK_THRESHOLD is 0.95 (95¢)", () => {
    assert.equal(ORDERBOOK_QUALITY_THRESHOLDS.INVALID_ASK_THRESHOLD, 0.95);
  });

  test("MAX_PRICE_DEVIATION is 0.30 (30¢)", () => {
    assert.equal(ORDERBOOK_QUALITY_THRESHOLDS.MAX_PRICE_DEVIATION, 0.30);
  });
});

// === CIRCUIT BREAKER COOLDOWN TESTS ===

describe("Circuit Breaker Cooldowns", () => {
  test("cooldown escalation ladder: 1m -> 5m -> 15m -> 60m", () => {
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS.length, 4);
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[0], 60_000); // 1 minute
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[1], 300_000); // 5 minutes
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[2], 900_000); // 15 minutes
    assert.equal(CIRCUIT_BREAKER_COOLDOWNS_MS[3], 3_600_000); // 60 minutes
  });

  test("first failure gets 1 minute cooldown", () => {
    const failureCount = 1;
    const cooldownMs = CIRCUIT_BREAKER_COOLDOWNS_MS[Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)];
    assert.equal(cooldownMs, 60_000);
  });

  test("second failure gets 5 minute cooldown", () => {
    const failureCount = 2;
    const cooldownMs = CIRCUIT_BREAKER_COOLDOWNS_MS[Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)];
    assert.equal(cooldownMs, 300_000);
  });

  test("third failure gets 15 minute cooldown", () => {
    const failureCount = 3;
    const cooldownMs = CIRCUIT_BREAKER_COOLDOWNS_MS[Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)];
    assert.equal(cooldownMs, 900_000);
  });

  test("fourth+ failure gets 60 minute cooldown (max)", () => {
    const failureCount = 4;
    const cooldownMs = CIRCUIT_BREAKER_COOLDOWNS_MS[Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)];
    assert.equal(cooldownMs, 3_600_000);

    // Higher failure counts still get max
    const failureCount10 = 10;
    const cooldownMs10 = CIRCUIT_BREAKER_COOLDOWNS_MS[Math.min(failureCount10 - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)];
    assert.equal(cooldownMs10, 3_600_000);
  });

  test("escalation window is 2 hours", () => {
    // Consecutive failures within this window will escalate cooldown
    assert.equal(CIRCUIT_BREAKER_ESCALATION_WINDOW_MS, 7_200_000); // 2 hours
  });
});

// === DUST COOLDOWN TESTS ===

describe("Dust Cooldown", () => {
  test("DUST_COOLDOWN_MS is 10 minutes", () => {
    assert.equal(DUST_COOLDOWN_MS, 600_000);
  });
});

// === EDGE CASE TESTS ===

describe("Edge Cases", () => {
  test("bestAsk=null with valid bestBid => VALID (no INVALID_BOOK check possible)", () => {
    const result = validateOrderbookQuality(0.50, null);
    assert.equal(result.status, "VALID");
  });

  test("bestAsk=0 with valid bestBid => VALID (zero ask treated as no ask)", () => {
    const result = validateOrderbookQuality(0.50, 0);
    assert.equal(result.status, "VALID");
  });

  test("dataApiPrice=0 is ignored for deviation check", () => {
    const result = validateOrderbookQuality(0.50, 0.55, 0);
    assert.equal(result.status, "VALID");
  });

  test("dataApiPrice=undefined skips deviation check", () => {
    const result = validateOrderbookQuality(0.01, 0.10, undefined);
    // bestBid=1¢ with no dataApiPrice for comparison
    // Not INVALID_BOOK (ask not > 95¢), not EXEC_PRICE_UNTRUSTED (no reference)
    assert.equal(result.status, "VALID");
  });
});
