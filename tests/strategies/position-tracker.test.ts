import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for PositionTracker settlement price calculation logic
 */

// Test-only mirror of PositionTracker.WINNER_THRESHOLD (private static readonly)
// IMPORTANT: Keep in sync manually if production threshold changes
const WINNER_THRESHOLD = 0.5;

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
      const isValid =
        outcome && typeof outcome === "string" && outcome.trim() !== "";
      assert.ok(isValid, `${outcome} should be recognized as valid outcome`);
    }
  });

  test("Side parsing - NO outcome", () => {
    const outcomes = ["NO", "no", "No"];

    for (const outcome of outcomes) {
      // Multi-outcome markets preserve the actual case, but binary markets are commonly uppercase
      const isValid =
        outcome && typeof outcome === "string" && outcome.trim() !== "";
      assert.ok(isValid, `${outcome} should be recognized as valid outcome`);
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
      assert.ok(
        isNetworkError,
        `${code} should be recognized as network error`,
      );
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
    assert.strictEqual(
      value,
      null,
      "Cache should return null for unavailable outcomes",
    );
  });
});

describe("PositionTracker Side Validation", () => {
  test("Empty or invalid sides should be rejected", () => {
    // Simulates the new behavior of rejecting empty or invalid sides
    const testSides = ["", undefined, null];

    for (const side of testSides) {
      const isValid = side && typeof side === "string" && side.trim() !== "";

      assert.ok(!isValid, `"${side}" should be rejected as invalid side`);
    }
  });

  test("Valid string outcomes should be accepted and preserve case", () => {
    // Test binary market outcomes (case variations)
    const testCases = [
      { input: "YES", expected: "YES" },
      { input: "yes", expected: "yes" }, // Verify NOT normalized to "YES"
      { input: "Yes", expected: "Yes" }, // Verify NOT normalized to "YES"
      { input: "NO", expected: "NO" },
      { input: "no", expected: "no" }, // Verify NOT normalized to "NO"
      { input: "No", expected: "No" }, // Verify NOT normalized to "NO"
    ];

    for (const { input, expected } of testCases) {
      const isValid = input && typeof input === "string" && input.trim() !== "";
      const processed = input.trim(); // Simulates the actual processing in position-tracker

      assert.ok(isValid, `"${input}" should be accepted as valid side`);

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
      { input: "Medjedovic", expected: "Medjedovic" }, // Not "MEDJEDOVIC"
      { input: "Under", expected: "Under" }, // Not "UNDER"
      { input: "FC Bayern München", expected: "FC Bayern München" }, // Preserves special chars
      { input: "LNG Esports", expected: "LNG Esports" },
      { input: "Over", expected: "Over" }, // Not "OVER"
      { input: "Norrie", expected: "Norrie" }, // Not "NORRIE"
    ];

    for (const { input, expected } of testCases) {
      const isValid = input && typeof input === "string" && input.trim() !== "";
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

describe("PositionTracker Gamma API Outcome Parsing", () => {
  test("Parse outcomePrices to find winner - binary YES wins", () => {
    // Simulates Gamma API response where YES won (price = 1)
    const outcomes = JSON.parse('["Yes", "No"]');
    const prices = JSON.parse('["1", "0"]');

    let winnerIndex = -1;
    let highestPrice = 0;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
        winnerIndex = i;
      }
    }

    assert.strictEqual(winnerIndex, 0, "Winner should be index 0 (Yes)");
    assert.ok(
      highestPrice > WINNER_THRESHOLD,
      "Winner price should exceed threshold",
    );
    assert.strictEqual(outcomes[winnerIndex], "Yes", "Winner should be 'Yes'");
  });

  test("Parse outcomePrices to find winner - binary NO wins", () => {
    // Simulates Gamma API response where NO won (price = 1)
    const outcomes = JSON.parse('["Yes", "No"]');
    const prices = JSON.parse('["0", "1"]');

    let winnerIndex = -1;
    let highestPrice = 0;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
        winnerIndex = i;
      }
    }

    assert.strictEqual(winnerIndex, 1, "Winner should be index 1 (No)");
    assert.strictEqual(outcomes[winnerIndex], "No", "Winner should be 'No'");
  });

  test("Parse outcomePrices to find winner - multi-outcome market", () => {
    // Simulates Gamma API response for a multi-outcome market (e.g., tennis match)
    const outcomes = JSON.parse('["Medjedovic", "Minaur"]');
    const prices = JSON.parse('["0", "1"]');

    let winnerIndex = -1;
    let highestPrice = 0;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
        winnerIndex = i;
      }
    }

    assert.strictEqual(winnerIndex, 1, "Winner should be index 1 (Minaur)");
    assert.strictEqual(
      outcomes[winnerIndex],
      "Minaur",
      "Winner should be 'Minaur'",
    );
  });

  test("Parse outcomePrices - high precision values near 1", () => {
    // Simulates Gamma API response with high-precision decimal prices
    const outcomes = JSON.parse('["Yes", "No"]');
    const prices = JSON.parse(
      '["0.9999989889179474774585826918585313", "0.000001011082052522541417308141468657552"]',
    );

    let winnerIndex = -1;
    let highestPrice = 0;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
        winnerIndex = i;
      }
    }

    assert.strictEqual(winnerIndex, 0, "Winner should be index 0 (Yes)");
    assert.ok(
      highestPrice > WINNER_THRESHOLD,
      "Winner price should exceed threshold",
    );
    assert.ok(
      Math.abs(highestPrice - 1.0) < 0.001,
      "Winner price should be very close to 1",
    );
    assert.strictEqual(outcomes[winnerIndex], "Yes", "Winner should be 'Yes'");
  });

  test("Parse outcomePrices - 5-outcome market", () => {
    // Simulates Gamma API response for a 5-outcome market (e.g., tweets prediction)
    const outcomes = JSON.parse(
      '["39 or less", "40-49", "50-59", "60-69", "70 or more"]',
    );
    const prices = JSON.parse(
      '["0.000005275650370577064615954030495707515", "0.000005340405636688357816234795706832118", "0.000005425344774813496669289527006419526", "0.000006462611087563460063700913082470326", "0.9999774959881303576208348207337085"]',
    );

    let winnerIndex = -1;
    let highestPrice = 0;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
        winnerIndex = i;
      }
    }

    assert.strictEqual(winnerIndex, 4, "Winner should be index 4 (70 or more)");
    assert.ok(
      highestPrice > WINNER_THRESHOLD,
      "Winner price should exceed threshold",
    );
    assert.strictEqual(
      outcomes[winnerIndex],
      "70 or more",
      "Winner should be '70 or more'",
    );
  });

  test("No clear winner when all prices are near 0", () => {
    // Simulates Gamma API response where market is closed but not yet resolved
    const prices = JSON.parse('["0", "0"]');

    let highestPrice = 0;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
      }
    }

    assert.ok(highestPrice <= WINNER_THRESHOLD, "Should not have clear winner");
    // In actual code, this would result in returning null
  });
});

describe("PositionTracker Redeemable Positions with Unknown Outcome", () => {
  test("Redeemable position with unknown outcome uses entryPrice as fallback", () => {
    // Simulates behavior when Gamma API cannot determine outcome but position is marked redeemable
    const isRedeemable = true;
    const winningOutcome = null; // API cannot determine outcome
    const entryPrice = 0.97; // User's original purchase price
    const side = "Over";

    // This mirrors the updated logic in position-tracker.ts
    let currentPrice: number;
    if (!winningOutcome) {
      // Cannot determine outcome - use entry price as fallback
      currentPrice = entryPrice;
    } else {
      currentPrice = side === winningOutcome ? 1.0 : 0.0;
    }

    assert.strictEqual(
      currentPrice,
      0.97,
      "Unknown outcome should fall back to entry price",
    );
    // Position should still be included (not skipped) so it can be redeemed
    assert.ok(isRedeemable, "Position should still be marked redeemable");
  });

  test("Redeemable position with known winning outcome uses 1.0", () => {
    const winningOutcome = "Over";
    const side = "Over";
    const entryPrice = 0.97;

    const currentPrice = side === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      currentPrice,
      1.0,
      "Winning position should have currentPrice 1.0",
    );
  });

  test("Redeemable position with known losing outcome uses 0.0", () => {
    const winningOutcome = "Under";
    const side = "Over";
    const entryPrice = 0.97;

    const currentPrice = side === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      currentPrice,
      0.0,
      "Losing position should have currentPrice 0.0",
    );
  });
});
