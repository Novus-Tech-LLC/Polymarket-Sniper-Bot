import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validatePriceProtection,
  type PriceProtectionResult,
  ABSOLUTE_MIN_TRADEABLE_PRICE,
} from "../../src/utils/post-order.util";

describe("ABSOLUTE_MIN_TRADEABLE_PRICE constant", () => {
  test("ABSOLUTE_MIN_TRADEABLE_PRICE is set to 0.001 (0.1¢)", () => {
    // This constant is the hard floor for all orders - you can't trade at $0
    // It's intentionally very low (0.1¢) to only catch truly invalid prices
    assert.equal(ABSOLUTE_MIN_TRADEABLE_PRICE, 0.001);
  });

  test("ABSOLUTE_MIN_TRADEABLE_PRICE is greater than zero", () => {
    // The constant must be positive to prevent $0 orders
    assert.ok(ABSOLUTE_MIN_TRADEABLE_PRICE > 0);
  });
});

describe("validatePriceProtection", () => {
  // === SELL PROTECTION TESTS (floor check - don't dump too cheap) ===

  describe("SELL orders (floor protection)", () => {
    test("SELL: bestBid >= minAcceptablePrice => OK", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0.64, // 64¢
        bestAsk: 0.65,
        minAcceptablePrice: 0.637, // 63.7¢ floor
      });

      assert.equal(result.valid, true);
      assert.equal(result.error, undefined);
      assert.equal(result.diagnostics?.side, "SELL");
      assert.equal(result.diagnostics?.priceUnits, "dollars");
    });

    test("SELL: bestBid < minAcceptablePrice => FAIL below-min (not 'exceeds max')", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0.01, // 1¢ - way below minimum
        bestAsk: 0.02,
        minAcceptablePrice: 0.637, // 63.7¢ floor
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      // Must NOT say "exceeds max" - this is a SELL, should say "blocked"
      assert.ok(
        !result.error.includes("exceeds"),
        `Error should not mention 'exceeds' for SELL: ${result.error}`,
      );
      // Plain English message should mention sale being blocked and the price difference
      assert.ok(
        result.error.includes("Sale blocked") || result.error.includes("blocked"),
        `Error should mention sale being blocked: ${result.error}`,
      );
      assert.ok(
        result.error.includes("minimum acceptable"),
        `Error should mention minimum acceptable price: ${result.error}`,
      );
    });

    test("SELL: bestBid exactly equals minAcceptablePrice => OK", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0.637,
        bestAsk: 0.65,
        minAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, true);
    });

    test("SELL: no bestBid (null) => FAIL with NO_BOOK message", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: null,
        bestAsk: 0.65,
        minAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      // Plain English message should mention no buyers or bids
      assert.ok(
        result.error.includes("no buyers") || result.error.includes("no bids"),
        `Error should mention no buyers/bids: ${result.error}`,
      );
    });

    test("SELL: no minAcceptablePrice => OK (no protection requested)", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0.01,
        bestAsk: 0.65,
        minAcceptablePrice: undefined,
      });

      assert.equal(result.valid, true);
    });
  });

  // === BUY PROTECTION TESTS (cap check - don't overpay) ===

  describe("BUY orders (cap protection)", () => {
    test("BUY: bestAsk <= maxAcceptablePrice => OK", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 0.635, // 63.5¢
        maxAcceptablePrice: 0.64, // 64¢ cap
      });

      assert.equal(result.valid, true);
      assert.equal(result.error, undefined);
      assert.equal(result.diagnostics?.side, "BUY");
    });

    test("BUY: bestAsk > maxAcceptablePrice => FAIL above-max", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 0.65, // 65¢
        maxAcceptablePrice: 0.637, // 63.7¢ cap
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("exceeds"),
        `Error should mention 'exceeds' for BUY: ${result.error}`,
      );
      assert.ok(
        result.error.includes("BUY"),
        `Error should mention 'BUY': ${result.error}`,
      );
    });

    test("BUY: bestAsk exactly equals maxAcceptablePrice => OK", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 0.637,
        maxAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, true);
    });

    test("BUY: no bestAsk (null) => FAIL with NO_BOOK message", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: null,
        maxAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("no bestAsk") || result.error.includes("NO_BOOK"),
        `Error should mention no bestAsk: ${result.error}`,
      );
    });

    test("BUY: no maxAcceptablePrice => OK (no protection requested)", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 0.99,
        maxAcceptablePrice: undefined,
      });

      assert.equal(result.valid, true);
    });
  });

  // === PRICE UNITS VALIDATION TESTS ===

  describe("Price units validation (must be in [0,1] dollars)", () => {
    test("Rejects bestBid > 1 (likely cents confusion)", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 63.7, // Cents instead of dollars!
        bestAsk: 64.5,
        minAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("PRICE_UNITS_ERROR"),
        `Error should mention PRICE_UNITS_ERROR: ${result.error}`,
      );
    });

    test("Rejects bestAsk > 1 (likely cents confusion)", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 64.5, // Cents instead of dollars!
        maxAcceptablePrice: 0.64,
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("PRICE_UNITS_ERROR"),
        `Error should mention PRICE_UNITS_ERROR: ${result.error}`,
      );
    });

    test("Rejects minAcceptablePrice > 1 (likely cents confusion)", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0.64,
        bestAsk: 0.65,
        minAcceptablePrice: 63.7, // Cents instead of dollars!
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("PRICE_UNITS_ERROR"),
        `Error should mention PRICE_UNITS_ERROR: ${result.error}`,
      );
    });

    test("Rejects maxAcceptablePrice > 1 (likely cents confusion)", () => {
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 0.64,
        maxAcceptablePrice: 64.0, // Cents instead of dollars!
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("PRICE_UNITS_ERROR"),
        `Error should mention PRICE_UNITS_ERROR: ${result.error}`,
      );
    });

    test("Rejects negative prices", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: -0.5,
        bestAsk: 0.65,
        minAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, false);
      assert.ok(result.error !== undefined);
      assert.ok(
        result.error.includes("PRICE_UNITS_ERROR"),
        `Error should mention PRICE_UNITS_ERROR: ${result.error}`,
      );
    });

    test("Accepts prices at boundaries [0, 1]", () => {
      // Price at 0 (unlikely but valid)
      const resultZero = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0,
        bestAsk: 0.01,
        minAcceptablePrice: 0,
      });
      assert.equal(resultZero.valid, true);

      // Price at 1 (certain outcome)
      const resultOne = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.99,
        bestAsk: 1,
        maxAcceptablePrice: 1,
      });
      assert.equal(resultOne.valid, true);
    });
  });

  // === DIAGNOSTICS TESTS ===

  describe("Diagnostics logging", () => {
    test("Includes all relevant fields in diagnostics", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "test-token-id-12345",
        bestBid: 0.64,
        bestAsk: 0.65,
        minAcceptablePrice: 0.637,
        maxAcceptablePrice: 0.7,
      });

      assert.ok(result.diagnostics !== undefined);
      assert.equal(result.diagnostics.side, "SELL");
      assert.equal(result.diagnostics.tokenId, "test-token-id-12345");
      assert.equal(result.diagnostics.bestBid, 0.64);
      assert.equal(result.diagnostics.bestAsk, 0.65);
      assert.equal(result.diagnostics.minAcceptablePrice, 0.637);
      assert.equal(result.diagnostics.maxAcceptablePrice, 0.7);
      assert.equal(result.diagnostics.priceUnits, "dollars");
    });

    test("Includes diagnostics even on validation failure", () => {
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "failing-token",
        bestBid: 0.01,
        bestAsk: 0.02,
        minAcceptablePrice: 0.637,
      });

      assert.equal(result.valid, false);
      assert.ok(result.diagnostics !== undefined);
      assert.equal(result.diagnostics.tokenId, "failing-token");
      assert.equal(result.diagnostics.bestBid, 0.01);
      assert.equal(result.diagnostics.minAcceptablePrice, 0.637);
    });
  });

  // === EDGE CASES ===

  describe("Edge cases", () => {
    test("SELL with only maxAcceptablePrice (wrong param) is ignored", () => {
      // SELL should use minAcceptablePrice, not maxAcceptablePrice
      // If only maxAcceptablePrice is provided, no SELL protection is applied
      const result = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: 0.01, // Very low bid
        bestAsk: 0.02,
        maxAcceptablePrice: 0.637, // Wrong param for SELL
      });

      // Should be valid because minAcceptablePrice is undefined
      assert.equal(result.valid, true);
    });

    test("BUY with only minAcceptablePrice (wrong param) is ignored", () => {
      // BUY should use maxAcceptablePrice, not minAcceptablePrice
      // If only minAcceptablePrice is provided, no BUY protection is applied
      const result = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: 0.63,
        bestAsk: 0.99, // Very high ask
        minAcceptablePrice: 0.637, // Wrong param for BUY
      });

      // Should be valid because maxAcceptablePrice is undefined
      assert.equal(result.valid, true);
    });

    test("Both null bid and ask (completely empty book)", () => {
      const resultSell = validatePriceProtection({
        side: "SELL",
        tokenId: "token123",
        bestBid: null,
        bestAsk: null,
        minAcceptablePrice: 0.637,
      });

      assert.equal(resultSell.valid, false);
      // Plain English message should mention no buyers or bids
      assert.ok(resultSell.error?.includes("no buyers") || resultSell.error?.includes("no bids"));

      const resultBuy = validatePriceProtection({
        side: "BUY",
        tokenId: "token123",
        bestBid: null,
        bestAsk: null,
        maxAcceptablePrice: 0.637,
      });

      assert.equal(resultBuy.valid, false);
      assert.ok(resultBuy.error?.includes("no bestAsk"));
    });
  });
});
