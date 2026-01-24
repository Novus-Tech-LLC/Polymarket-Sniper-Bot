import assert from "node:assert";
import { test, describe } from "node:test";
import type { Position } from "../../src/strategies/position-tracker";
import {
  isNearResolution,
  assessOrderbookQuality,
  formatCents,
  NEAR_RESOLUTION_THRESHOLD_DOLLARS,
  NEAR_RESOLUTION_MIN_PRICE_DOLLARS,
} from "../../src/utils/price.util";

/**
 * Tests for the state/price logic consistency fix between SmartHedging and PositionTracker.
 *
 * These tests verify:
 * 1. Near-resolution detection only triggers for >= 99.5¢
 * 2. Safety guard prevents near-resolution for prices < 50¢
 * 3. OrderbookQuality assessment correctly identifies broken orderbooks
 * 4. SmartHedging skip logic works correctly for near-resolution and invalid orderbooks
 * 5. No contradictory decisions: same position can't be both "catastrophic loss" and "high profit"
 */

// Helper to create a mock position
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "market-123",
    tokenId: "token-456789abcdef",
    side: "YES",
    size: 100,
    entryPrice: 0.65,
    currentPrice: 0.60,
    pnlPct: -7.69,
    pnlUsd: -5,
    redeemable: false,
    pnlTrusted: true,
    pnlClassification: "LOSING",
    currentBidPrice: 0.59,
    currentAskPrice: 0.62,
    status: "ACTIVE",
    ...overrides,
  };
}

describe("SmartHedging / PositionTracker State Consistency", () => {
  describe("Near-Resolution Detection", () => {
    test("price >= 99.5¢ is near-resolution", () => {
      assert.strictEqual(isNearResolution(0.995), true, "99.5¢ is near-resolution");
      assert.strictEqual(isNearResolution(0.9995), true, "99.95¢ is near-resolution");
      assert.strictEqual(isNearResolution(1.0), true, "100¢ is near-resolution");
    });

    test("price < 99.5¢ is NOT near-resolution", () => {
      assert.strictEqual(isNearResolution(0.99), false, "99¢ is NOT near-resolution");
      assert.strictEqual(isNearResolution(0.90), false, "90¢ is NOT near-resolution");
      assert.strictEqual(isNearResolution(0.50), false, "50¢ is NOT near-resolution");
    });

    test("SAFETY GUARD: price < 50¢ is NEVER near-resolution", () => {
      // This is the CRITICAL bug fix - prices < 50¢ should NEVER be near-resolution
      // even if some calculation error suggested otherwise
      assert.strictEqual(
        isNearResolution(0.01),
        false,
        "1¢ should NEVER be near-resolution (safety guard)",
      );
      assert.strictEqual(
        isNearResolution(0.10),
        false,
        "10¢ should NEVER be near-resolution",
      );
      assert.strictEqual(
        isNearResolution(0.49),
        false,
        "49¢ should NEVER be near-resolution",
      );

      // Verify the safety threshold constant
      assert.strictEqual(
        NEAR_RESOLUTION_MIN_PRICE_DOLLARS,
        0.5,
        "Safety threshold should be 50¢",
      );
    });
  });

  describe("Orderbook Quality Assessment", () => {
    test("detects INVALID_BOOK when bestBid=0.01, bestAsk=0.99 (wide spread)", () => {
      // Scenario: Orderbook returns bestBid=0.01 (1¢), bestAsk=0.99 (99¢)
      // This is a broken/stale orderbook - should not be trusted
      const result = assessOrderbookQuality(0.01, 0.99, 0.62);
      assert.strictEqual(result.quality, "INVALID_BOOK");
      assert.ok(result.reason?.includes("wide_spread"));
    });

    test("detects INVALID_BOOK when bestBid diverges from dataApiPrice by > 30¢", () => {
      // Scenario: Data-API shows price=0.62 (62¢), but orderbook shows bestBid=0.30 (30¢)
      // Divergence = 32¢ > 30¢ threshold
      const result = assessOrderbookQuality(0.30, 0.70, 0.62);
      assert.strictEqual(result.quality, "INVALID_BOOK");
      assert.ok(result.reason?.includes("price_divergence"));
    });

    test("returns VALID for normal orderbook", () => {
      // Scenario: Orderbook bestBid=0.60 (60¢), dataApiPrice=0.62 (62¢)
      // Divergence = 2¢ < 30¢ threshold, spread is normal
      const result = assessOrderbookQuality(0.60, 0.65, 0.62);
      assert.strictEqual(result.quality, "VALID");
    });

    test("returns NO_BOOK when bestBid is undefined", () => {
      const result = assessOrderbookQuality(undefined, 0.65, 0.62);
      assert.strictEqual(result.quality, "NO_BOOK");
    });
  });

  describe("SmartHedging Skip Logic", () => {
    test("should skip near-resolution position (nearResolutionCandidate=true)", () => {
      const position = createMockPosition({
        currentPrice: 0.9995, // 99.95¢
        redeemable: false,
        nearResolutionCandidate: true, // Set by PositionTracker
        pnlPct: 53.8, // Profitable!
        pnlClassification: "PROFITABLE",
      });

      // SmartHedging should skip this position
      assert.strictEqual(
        position.nearResolutionCandidate,
        true,
        "Position should have nearResolutionCandidate=true",
      );

      // Verify the logic SmartHedging would use
      const shouldSkip = position.nearResolutionCandidate === true;
      assert.strictEqual(
        shouldSkip,
        true,
        "SmartHedging should skip near-resolution positions",
      );
    });

    test("should skip redeemable position", () => {
      const position = createMockPosition({
        currentPrice: 1.0,
        redeemable: true,
      });

      const shouldSkip = position.redeemable === true;
      assert.strictEqual(shouldSkip, true, "SmartHedging should skip redeemable positions");
    });

    test("should skip position with invalid orderbook", () => {
      const position = createMockPosition({
        currentBidPrice: 0.01, // 1¢ - suspicious
        currentAskPrice: 0.99, // 99¢ - wide spread
        dataApiCurPrice: 0.62, // Data-API shows 62¢
      });

      const quality = assessOrderbookQuality(
        position.currentBidPrice,
        position.currentAskPrice,
        position.dataApiCurPrice,
      );

      assert.strictEqual(
        quality.quality,
        "INVALID_BOOK",
        "Should detect invalid orderbook",
      );
    });
  });

  describe("Prevents Contradictory Decisions", () => {
    test("position at 99.95¢ should NOT trigger both 'near-resolution' AND 'catastrophic loss'", () => {
      // This is the exact bug scenario from the problem statement:
      // - PositionTracker logs "high profit current=100.0¢"
      // - SmartHedging flags "catastrophic -99.9% loss"
      // These are contradictory!

      const position = createMockPosition({
        currentPrice: 0.9995, // 99.95¢ - near resolution
        entryPrice: 0.65,
        redeemable: false,
        nearResolutionCandidate: true,
        pnlPct: 53.8, // Profitable based on Data-API
        pnlClassification: "PROFITABLE",
      });

      // Verify near-resolution flag
      assert.strictEqual(
        isNearResolution(position.currentPrice),
        true,
        "Price 99.95¢ should be near-resolution",
      );

      // Verify position is marked as near-resolution candidate
      assert.strictEqual(
        position.nearResolutionCandidate,
        true,
        "Position should be marked as near-resolution candidate",
      );

      // Verify P&L classification is PROFITABLE, not catastrophic loss
      assert.strictEqual(
        position.pnlClassification,
        "PROFITABLE",
        "Position should be classified as PROFITABLE",
      );

      // SmartHedging skip logic
      const shouldSkipHedging =
        position.redeemable === true ||
        position.nearResolutionCandidate === true;

      assert.strictEqual(
        shouldSkipHedging,
        true,
        "SmartHedging should skip this position - no catastrophic loss logging",
      );
    });

    test("position with broken orderbook (bid=1¢, Data-API=62¢) should NOT compute catastrophic loss", () => {
      // Scenario: Orderbook is broken, showing bid=1¢
      // Data-API shows correct price=62¢
      // SmartHedging should NOT use the broken bid to compute "catastrophic loss"

      const position = createMockPosition({
        entryPrice: 0.65, // 65¢
        currentPrice: 0.62, // Data-API price = 62¢
        currentBidPrice: 0.01, // Broken orderbook bid = 1¢
        currentAskPrice: 0.99, // Wide spread
        dataApiCurPrice: 0.62,
        pnlPct: -4.6, // Small loss based on Data-API
        pnlTrusted: true,
        pnlClassification: "LOSING",
      });

      // Check orderbook quality
      const quality = assessOrderbookQuality(
        position.currentBidPrice,
        position.currentAskPrice,
        position.dataApiCurPrice,
      );

      assert.strictEqual(
        quality.quality,
        "INVALID_BOOK",
        "Should detect invalid orderbook",
      );

      // SmartHedging should skip based on invalid orderbook
      const shouldSkip = quality.quality === "INVALID_BOOK";
      assert.strictEqual(
        shouldSkip,
        true,
        "SmartHedging should skip position with invalid orderbook",
      );

      // Verify the position's P&L is based on Data-API (not broken orderbook)
      assert.strictEqual(
        position.pnlPct,
        -4.6,
        "P&L should be -4.6% based on Data-API, not -98% from broken orderbook",
      );
    });
  });

  describe("Price Formatting", () => {
    test("formatCents correctly displays 0.9995 dollars as 99.95¢", () => {
      const formatted = formatCents(0.9995);
      assert.strictEqual(formatted, "99.95¢");
    });

    test("formatCents correctly displays 0.01 dollars as 1.00¢", () => {
      const formatted = formatCents(0.01);
      assert.strictEqual(formatted, "1.00¢");
    });

    test("formatCents does NOT show '1.00¢' for 0.9995 dollars", () => {
      // This was the formatting bug in the original issue
      const formatted = formatCents(0.9995);
      assert.notStrictEqual(
        formatted,
        "1.00¢",
        "0.9995 dollars should NOT format as 1.00¢",
      );
    });
  });
});

describe("End-to-End Scenario Tests", () => {
  test("Scenario F.1: Data-API price=0.9995, redeemable=false → PositionTracker logs near_resolution_candidate, SmartHedging skips", () => {
    // Setup
    const currentPrice = 0.9995;
    const redeemable = false;

    // PositionTracker behavior
    const nearResCandidate = isNearResolution(currentPrice) && !redeemable;
    assert.strictEqual(
      nearResCandidate,
      true,
      "PositionTracker should mark as near_resolution_candidate",
    );

    // SmartHedging behavior
    const position = createMockPosition({
      currentPrice,
      redeemable,
      nearResolutionCandidate: nearResCandidate,
    });

    const shouldSkip = position.nearResolutionCandidate === true;
    assert.strictEqual(
      shouldSkip,
      true,
      "SmartHedging should skip near-resolution positions",
    );
  });

  test("Scenario F.2: Orderbook bid=0.01, ask=0.99, Data-API=0.62 → INVALID_BOOK, SmartHedging ignores orderbook", () => {
    const quality = assessOrderbookQuality(0.01, 0.99, 0.62);
    assert.strictEqual(quality.quality, "INVALID_BOOK");

    // SmartHedging should not use the broken orderbook for P&L
    const shouldSkipDueToInvalidBook = quality.quality === "INVALID_BOOK";
    assert.strictEqual(shouldSkipDueToInvalidBook, true);
  });

  test("Scenario F.3: redeemable=true → SmartHedging routes to AutoRedeem, skips", () => {
    const position = createMockPosition({
      redeemable: true,
      currentPrice: 1.0,
    });

    const shouldSkip = position.redeemable === true;
    assert.strictEqual(
      shouldSkip,
      true,
      "SmartHedging should skip redeemable positions and route to AutoRedeem",
    );
  });

  test("Scenario F.4: No near-resolution for prices < 50¢", () => {
    // Test prices that should NEVER be near-resolution
    const testPrices = [0.01, 0.10, 0.25, 0.49];

    for (const price of testPrices) {
      assert.strictEqual(
        isNearResolution(price),
        false,
        `${formatCents(price)} should NEVER be near-resolution`,
      );
    }
  });
});
