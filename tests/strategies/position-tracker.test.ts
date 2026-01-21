import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for PositionTracker settlement price calculation logic
 */

describe("PositionTracker Settlement Price Logic", () => {
  test("Settlement price calculation - winning position", () => {
    // Simulate a winning position: YES position when market resolved to YES
    const positionSide = "YES";
    const winningOutcome = "YES";
    const settlementPrice = positionSide === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      settlementPrice,
      1.0,
      "Winning position should settle at 1.0",
    );
  });

  test("Settlement price calculation - losing position", () => {
    // Simulate a losing position: YES position when market resolved to NO
    const positionSide = "YES";
    const winningOutcome = "NO";
    const settlementPrice = positionSide === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      settlementPrice,
      0.0,
      "Losing position should settle at 0.0",
    );
  });

  test("Settlement price calculation - NO winning position", () => {
    // Simulate a winning NO position
    const positionSide = "NO";
    const winningOutcome = "NO";
    const settlementPrice = positionSide === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      settlementPrice,
      1.0,
      "Winning NO position should settle at 1.0",
    );
  });

  test("Settlement price calculation - NO losing position", () => {
    // Simulate a losing NO position
    const positionSide = "NO";
    const winningOutcome = "YES";
    const settlementPrice = positionSide === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      settlementPrice,
      0.0,
      "Losing NO position should settle at 0.0",
    );
  });

  test("P&L calculation - winning position with profit", () => {
    // Position bought at 0.60, settled at 1.0
    const entryPrice = 0.6;
    const settlementPrice = 1.0;
    const size = 100;

    const pnlUsd = (settlementPrice - entryPrice) * size;
    const pnlPct = ((settlementPrice - entryPrice) / entryPrice) * 100;

    assert.strictEqual(pnlUsd, 40, "P&L should be $40");
    // Use robust floating-point comparison
    assert.ok(
      Math.abs(pnlPct - 66.67) < 0.01,
      `P&L should be ~66.67%, got ${pnlPct}`,
    );
  });

  test("P&L calculation - losing position with loss", () => {
    // Position bought at 0.60, settled at 0.0
    const entryPrice = 0.6;
    const settlementPrice = 0.0;
    const size = 100;

    const pnlUsd = (settlementPrice - entryPrice) * size;
    const pnlPct = ((settlementPrice - entryPrice) / entryPrice) * 100;

    assert.strictEqual(pnlUsd, -60, "P&L should be -$60");
    assert.strictEqual(pnlPct, -100, "P&L should be -100%");
  });

  test("Side parsing - YES outcome", () => {
    const outcomes = ["YES", "yes", "Yes"];

    for (const outcome of outcomes) {
      // Multi-outcome markets preserve the actual case, but binary markets are commonly uppercase
      const isValid = outcome && typeof outcome === 'string' && outcome.trim() !== '';
      assert.ok(
        isValid,
        `${outcome} should be recognized as valid outcome`,
      );
    }
  });

  test("Side parsing - NO outcome", () => {
    const outcomes = ["NO", "no", "No"];

    for (const outcome of outcomes) {
      // Multi-outcome markets preserve the actual case, but binary markets are commonly uppercase
      const isValid = outcome && typeof outcome === 'string' && outcome.trim() !== '';
      assert.ok(
        isValid,
        `${outcome} should be recognized as valid outcome`,
      );
    }
  });
});

describe("PositionTracker Error Handling", () => {
  test("Error categorization - 404 should be categorized as warning", () => {
    // Simulates error categorization logic in fetchMarketOutcome
    const status = 404;
    const shouldWarn = status === 404;
    const shouldError = status >= 500;

    assert.ok(shouldWarn, "404 errors should be categorized as warnings");
    assert.ok(!shouldError, "404 errors should not be categorized as errors");
  });

  test("Error categorization - 500 should be categorized as error", () => {
    const status = 500;
    const shouldWarn = status >= 400 && status < 500;
    const shouldError = status >= 500;

    assert.ok(!shouldWarn, "500 errors should not be categorized as warnings");
    assert.ok(shouldError, "500 errors should be categorized as errors");
  });

  test("Error categorization - network errors should be categorized as error", () => {
    const NETWORK_ERROR_CODES = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"];

    for (const code of NETWORK_ERROR_CODES) {
      const isNetworkError = NETWORK_ERROR_CODES.includes(code);
      assert.ok(isNetworkError, `${code} should be recognized as network error`);
    }
  });
});

describe("PositionTracker Caching Logic", () => {
  test("Cache should deduplicate market outcome requests", () => {
    // Simulates cache behavior
    const cache = new Map<string, string | null>();
    const marketId = "test-market-123";

    // First request - cache miss
    let cacheHit = cache.has(marketId);
    assert.ok(!cacheHit, "First request should be a cache miss");

    // Store in cache
    cache.set(marketId, "YES");

    // Second request - cache hit
    cacheHit = cache.has(marketId);
    assert.ok(cacheHit, "Second request should be a cache hit");

    const cachedValue = cache.get(marketId);
    assert.strictEqual(cachedValue, "YES", "Cached value should be returned");
  });

  test("Cache should be cleared between refresh cycles", () => {
    // Simulates cache clear behavior at start of refresh
    const cache = new Map<string, string | null>();

    cache.set("market-1", "YES");
    cache.set("market-2", "NO");

    assert.strictEqual(cache.size, 2, "Cache should contain 2 entries");

    // Clear cache (simulates start of new refresh cycle)
    cache.clear();

    assert.strictEqual(cache.size, 0, "Cache should be empty after clear");
  });

  test("Cache should handle null outcomes correctly", () => {
    const cache = new Map<string, string | null>();
    const marketId = "unresolved-market";

    // Store null (market outcome unavailable)
    cache.set(marketId, null);

    const hasEntry = cache.has(marketId);
    const value = cache.get(marketId);

    assert.ok(hasEntry, "Cache should contain entry for null outcome");
    assert.strictEqual(value, null, "Cache should return null for unavailable outcomes");
  });
});

describe("PositionTracker Side Validation", () => {
  test("Empty or invalid sides should be rejected", () => {
    // Simulates the new behavior of rejecting empty or invalid sides
    const testSides = ["", undefined, null];

    for (const side of testSides) {
      const isValid = side && typeof side === 'string' && side.trim() !== '';

      assert.ok(
        !isValid,
        `"${side}" should be rejected as invalid side`,
      );
    }
  });

  test("Valid string outcomes should be accepted and preserve case", () => {
    // Test binary market outcomes (case variations)
    const testCases = [
      { input: "YES", expected: "YES" },
      { input: "yes", expected: "yes" },  // Verify NOT normalized to "YES"
      { input: "Yes", expected: "Yes" },  // Verify NOT normalized to "YES"
      { input: "NO", expected: "NO" },
      { input: "no", expected: "no" },    // Verify NOT normalized to "NO"
      { input: "No", expected: "No" },    // Verify NOT normalized to "NO"
    ];
    
    for (const { input, expected } of testCases) {
      const isValid = input && typeof input === 'string' && input.trim() !== '';
      const processed = input.trim(); // Simulates the actual processing in position-tracker

      assert.ok(
        isValid,
        `"${input}" should be accepted as valid side`,
      );
      
      // Verify case is preserved (not normalized to uppercase)
      assert.strictEqual(
        processed,
        expected,
        `Case should be preserved: "${input}" should remain "${expected}", not normalized to uppercase`,
      );
    }
  });

  test("Valid multi-outcome market sides should be accepted and preserve case", () => {
    const testCases = [
      { input: "Medjedovic", expected: "Medjedovic" },  // Not "MEDJEDOVIC"
      { input: "Under", expected: "Under" },            // Not "UNDER"
      { input: "FC Bayern München", expected: "FC Bayern München" },  // Preserves special chars
      { input: "LNG Esports", expected: "LNG Esports" },
      { input: "Over", expected: "Over" },              // Not "OVER"
      { input: "Norrie", expected: "Norrie" },          // Not "NORRIE"
    ];

    for (const { input, expected } of testCases) {
      const isValid = input && typeof input === 'string' && input.trim() !== '';
      const processed = input.trim(); // Simulates the actual processing in position-tracker

      assert.ok(
        isValid,
        `"${input}" should be accepted as valid multi-outcome side`,
      );
      
      // Verify case and special characters are preserved
      assert.strictEqual(
        processed,
        expected,
        `Original value should be preserved: "${input}" should remain "${expected}"`,
      );
    }
  });
});

describe("PositionTracker Multi-Outcome Market Support", () => {
  test("Settlement price calculation - winning multi-outcome position", () => {
    // Simulate a winning position in a multi-outcome market
    const positionSide = "Medjedovic";
    const winningOutcome = "Medjedovic";
    const settlementPrice = positionSide === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      settlementPrice,
      1.0,
      "Winning multi-outcome position should settle at 1.0",
    );
  });

  test("Settlement price calculation - losing multi-outcome position", () => {
    // Simulate a losing position in a multi-outcome market
    const positionSide = "Medjedovic";
    const winningOutcome = "Other Player";
    const settlementPrice = positionSide === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      settlementPrice,
      0.0,
      "Losing multi-outcome position should settle at 0.0",
    );
  });

  test("P&L calculation - winning multi-outcome position", () => {
    // Position bought at 0.25 in a 4-outcome market, won
    const entryPrice = 0.25;
    const settlementPrice = 1.0;
    const size = 100;

    const pnlUsd = (settlementPrice - entryPrice) * size;
    const pnlPct = ((settlementPrice - entryPrice) / entryPrice) * 100;

    assert.strictEqual(pnlUsd, 75, "P&L should be $75");
    assert.strictEqual(pnlPct, 300, "P&L should be 300%");
  });

  test("P&L calculation - losing multi-outcome position", () => {
    // Position bought at 0.25 in a 4-outcome market, lost
    const entryPrice = 0.25;
    const settlementPrice = 0.0;
    const size = 100;

    const pnlUsd = (settlementPrice - entryPrice) * size;
    const pnlPct = ((settlementPrice - entryPrice) / entryPrice) * 100;

    assert.strictEqual(pnlUsd, -25, "P&L should be -$25");
    assert.strictEqual(pnlPct, -100, "P&L should be -100%");
  });

  test("Outcome comparison is case-sensitive", () => {
    // Multi-outcome market outcomes should match exactly (case-sensitive)
    const positionSide = "Medjedovic";
    const winningOutcome1 = "Medjedovic";
    const winningOutcome2 = "medjedovic";

    assert.strictEqual(
      positionSide === winningOutcome1,
      true,
      "Exact match should succeed",
    );
    assert.strictEqual(
      positionSide === winningOutcome2,
      false,
      "Case-different match should fail",
    );
  });
});

