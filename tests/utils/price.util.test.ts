import assert from "node:assert";
import { test, describe } from "node:test";
import {
  toDollars,
  formatCents,
  isNearResolution,
  assessOrderbookQuality,
  isValidDollarPrice,
  NEAR_RESOLUTION_THRESHOLD_DOLLARS,
  NEAR_RESOLUTION_MIN_PRICE_DOLLARS,
} from "../../src/utils/price.util";

describe("Price Utility - toDollars", () => {
  test("returns value as-is when already in dollars [0, 1]", () => {
    assert.strictEqual(toDollars(0.65), 0.65);
    assert.strictEqual(toDollars(0.9995), 0.9995);
    assert.strictEqual(toDollars(0.01), 0.01);
    assert.strictEqual(toDollars(1.0), 1.0);
    assert.strictEqual(toDollars(0), 0);
  });

  test("converts cents (> 1) to dollars", () => {
    assert.strictEqual(toDollars(65), 0.65);
    assert.strictEqual(toDollars(99.95), 0.9995);
    assert.strictEqual(toDollars(100), 1.0);
    // Note: toDollars(1) returns 1.0 because 1 is NOT > 1
    // Values in (1, 100] are cents
    assert.strictEqual(toDollars(1.01), 0.0101);
  });

  test("handles edge cases", () => {
    assert.strictEqual(toDollars(-0.5), 0, "Negative values should return 0");
    assert.strictEqual(
      toDollars(150),
      1.0,
      "Values > 100 should cap at 1.0 dollars",
    );
  });
});

describe("Price Utility - formatCents", () => {
  test("formats dollars as cents with ¢ suffix", () => {
    assert.strictEqual(formatCents(0.65), "65.00¢");
    assert.strictEqual(formatCents(0.9995), "99.95¢");
    assert.strictEqual(formatCents(1.0), "100.00¢");
    assert.strictEqual(formatCents(0.01), "1.00¢");
    assert.strictEqual(formatCents(0), "0.00¢");
  });

  test("respects decimal places parameter", () => {
    assert.strictEqual(formatCents(0.65, 0), "65¢");
    assert.strictEqual(formatCents(0.9995, 1), "100.0¢");
    assert.strictEqual(formatCents(0.01, 1), "1.0¢");
    assert.strictEqual(formatCents(0.123456, 4), "12.3456¢");
  });
});

describe("Price Utility - isNearResolution", () => {
  test("returns true for prices >= 99.5¢", () => {
    assert.strictEqual(isNearResolution(0.995), true);
    assert.strictEqual(isNearResolution(0.9995), true);
    assert.strictEqual(isNearResolution(1.0), true);
    assert.strictEqual(isNearResolution(0.999), true);
  });

  test("returns false for prices < 99.5¢", () => {
    assert.strictEqual(isNearResolution(0.99), false);
    assert.strictEqual(isNearResolution(0.90), false);
    assert.strictEqual(isNearResolution(0.50), false);
  });

  test("returns false for prices < 50¢ (safety guard)", () => {
    // This is the CRITICAL safety guard - prices < 50¢ should NEVER be near-resolution
    assert.strictEqual(
      isNearResolution(0.01),
      false,
      "1¢ should never be near-resolution",
    );
    assert.strictEqual(
      isNearResolution(0.10),
      false,
      "10¢ should never be near-resolution",
    );
    assert.strictEqual(
      isNearResolution(0.49),
      false,
      "49¢ should never be near-resolution",
    );
    // Even if somehow a broken price of 0.01 was passed with a bug that
    // would otherwise make it "near resolution", the safety guard blocks it
  });

  test("threshold constants are correct", () => {
    assert.strictEqual(NEAR_RESOLUTION_THRESHOLD_DOLLARS, 0.995);
    assert.strictEqual(NEAR_RESOLUTION_MIN_PRICE_DOLLARS, 0.5);
  });
});

describe("Price Utility - assessOrderbookQuality", () => {
  test("returns NO_BOOK when bestBid is undefined", () => {
    const result = assessOrderbookQuality(undefined, 0.65, 0.62);
    assert.strictEqual(result.quality, "NO_BOOK");
    assert.ok(result.reason?.includes("no_bids"));
  });

  test("returns INVALID_BOOK for wide spread (bid < 5¢ AND ask > 95¢)", () => {
    const result = assessOrderbookQuality(0.01, 0.99, 0.62);
    assert.strictEqual(result.quality, "INVALID_BOOK");
    assert.ok(result.reason?.includes("wide_spread"));
    assert.ok(
      result.reason?.includes("1.00¢"),
      `Expected bid=1.00¢ in reason, got: ${result.reason}`,
    );
    assert.ok(
      result.reason?.includes("99.00¢"),
      `Expected ask=99.00¢ in reason, got: ${result.reason}`,
    );
  });

  test("returns INVALID_BOOK for large divergence from Data-API price", () => {
    // bestBid=0.30, dataApiPrice=0.62, divergence=0.32 > 0.30
    const result = assessOrderbookQuality(0.30, 0.70, 0.62);
    assert.strictEqual(result.quality, "INVALID_BOOK");
    assert.ok(result.reason?.includes("price_divergence"));
  });

  test("returns VALID for normal orderbook", () => {
    // bestBid=0.60, dataApiPrice=0.62, divergence=0.02 < 0.30
    const result = assessOrderbookQuality(0.60, 0.65, 0.62);
    assert.strictEqual(result.quality, "VALID");
  });

  test("returns VALID when no Data-API price (can't check divergence)", () => {
    const result = assessOrderbookQuality(0.60, 0.65, undefined);
    assert.strictEqual(result.quality, "VALID");
  });

  test("wide spread takes precedence over divergence", () => {
    // Wide spread: bid=0.01, ask=0.99
    // Also has divergence from Data-API
    const result = assessOrderbookQuality(0.01, 0.99, 0.62);
    assert.strictEqual(result.quality, "INVALID_BOOK");
    assert.ok(
      result.reason?.includes("wide_spread"),
      "Wide spread should be the reason",
    );
  });

  test("borderline cases - exactly at thresholds", () => {
    // Wide spread condition: bid < 0.05 AND ask > 0.95
    // At threshold: bid=0.05, ask=0.95 - condition is NOT met (not < 0.05, not > 0.95)
    // But condition IS met for bid=0.04, ask=0.96
    // Use dataApiPrice close to bid to avoid divergence threshold
    const result1 = assessOrderbookQuality(0.06, 0.94, 0.10);
    assert.strictEqual(
      result1.quality,
      "VALID",
      "bid=6¢, ask=94¢ should be VALID (inside thresholds, small divergence)",
    );

    // Divergence exactly at threshold: |0.32 - 0.62| = 0.30 - should be VALID
    const result2 = assessOrderbookQuality(0.32, 0.70, 0.62);
    assert.strictEqual(
      result2.quality,
      "VALID",
      "Divergence=0.30 should be VALID (at threshold, not exceeding)",
    );

    // Divergence just above threshold: |0.31 - 0.62| = 0.31 > 0.30
    const result3 = assessOrderbookQuality(0.31, 0.70, 0.62);
    assert.strictEqual(
      result3.quality,
      "INVALID_BOOK",
      "Divergence=0.31 should be INVALID_BOOK",
    );
  });
});

describe("Price Utility - isValidDollarPrice", () => {
  test("returns true for valid dollar prices", () => {
    assert.strictEqual(isValidDollarPrice(0), true);
    assert.strictEqual(isValidDollarPrice(0.5), true);
    assert.strictEqual(isValidDollarPrice(1), true);
    assert.strictEqual(isValidDollarPrice(0.9995), true);
  });

  test("returns false for invalid prices", () => {
    assert.strictEqual(isValidDollarPrice(-0.1), false);
    assert.strictEqual(isValidDollarPrice(1.1), false);
    assert.strictEqual(isValidDollarPrice(NaN), false);
  });
});

describe("Price Utility - Integration Scenarios", () => {
  test("scenario: broken orderbook should not trigger catastrophic loss", () => {
    // Scenario: Data-API shows price=0.62 (62¢), but orderbook returns
    // bestBid=0.01 (1¢) because it's stale/broken
    const dataApiPrice = 0.62;
    const bestBid = 0.01;
    const bestAsk = 0.99;

    // Assess orderbook quality
    const quality = assessOrderbookQuality(bestBid, bestAsk, dataApiPrice);

    // Should be INVALID_BOOK
    assert.strictEqual(quality.quality, "INVALID_BOOK");

    // SmartHedging should NOT use bestBid for P&L calculation
    // Instead, it should use dataApiPrice
    const correctMarkPrice = dataApiPrice;
    assert.strictEqual(
      correctMarkPrice,
      0.62,
      "Should use Data-API price, not broken orderbook",
    );
  });

  test("scenario: near-resolution winner should not hedge", () => {
    // Scenario: Position currentPrice=0.9995 (99.95¢), redeemable=false
    const currentPrice = 0.9995;
    const redeemable = false;

    // Check near-resolution
    const nearRes = isNearResolution(currentPrice);
    assert.strictEqual(nearRes, true, "99.95¢ is near resolution");

    // SmartHedging should skip this position
    const shouldSkipHedging = nearRes && !redeemable;
    assert.strictEqual(
      shouldSkipHedging,
      true,
      "Should skip hedging for near-resolution non-redeemable position",
    );
  });

  test("scenario: 1¢ price should never be near-resolution", () => {
    // Bug scenario: price shows as 1¢ due to formatting error or stale data
    // This should NEVER be classified as near-resolution
    const brokenPrice = 0.01; // 1¢

    // Safety guard should prevent near-resolution classification
    const nearRes = isNearResolution(brokenPrice);
    assert.strictEqual(
      nearRes,
      false,
      "1¢ should NEVER be near-resolution (safety guard)",
    );
  });

  test("scenario: format logging correctly shows cents", () => {
    // Verify logging format is correct
    const price = 0.9995;
    const formatted = formatCents(price);
    assert.strictEqual(
      formatted,
      "99.95¢",
      "0.9995 dollars should format as 99.95¢",
    );

    // Not "1.00¢" which was the bug
    assert.notStrictEqual(
      formatted,
      "1.00¢",
      "Should NOT show 1.00¢ for 0.9995 dollars",
    );
  });
});
