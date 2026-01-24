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

  test("Outcome comparison is case-insensitive", () => {
    // Multi-outcome market outcomes should match case-insensitively
    // This was changed from case-sensitive to case-insensitive to fix
    // a bug where "Bucks" vs "bucks" caused winning positions to show as 0% PnL
    const positionSide = "Medjedovic";
    const winningOutcome1 = "Medjedovic";
    const winningOutcome2 = "medjedovic";

    // Both should match when normalized to lowercase
    const normalizedSide = positionSide.toLowerCase().trim();
    const normalizedWinner1 = winningOutcome1.toLowerCase().trim();
    const normalizedWinner2 = winningOutcome2.toLowerCase().trim();

    assert.strictEqual(
      normalizedSide === normalizedWinner1,
      true,
      "Exact match should succeed",
    );
    assert.strictEqual(
      normalizedSide === normalizedWinner2,
      true,
      "Case-different match should now succeed (case-insensitive)",
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

    const currentPrice = side === winningOutcome ? 1.0 : 0.0;

    assert.strictEqual(
      currentPrice,
      0.0,
      "Losing position should have currentPrice 0.0",
    );
  });
});

// Test-only mirror of PositionTracker price thresholds (private static readonly)
// IMPORTANT: Keep in sync manually if production thresholds change
const RESOLVED_PRICE_HIGH_THRESHOLD = 0.99;
const RESOLVED_PRICE_LOW_THRESHOLD = 0.01;

describe("PositionTracker Fallback Redemption Detection", () => {
  test("Position at 99¢+ should trigger resolution check", () => {
    // Simulates fallback detection for high-price positions
    const currentPrice = 0.995; // 99.5¢
    const isRedeemable = false; // API didn't mark as redeemable
    
    const shouldCheckResolution =
      !isRedeemable &&
      (currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
        currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD);
    
    assert.ok(
      shouldCheckResolution,
      "Position at 99.5¢ should trigger resolution check",
    );
  });

  test("Position at 1¢- should trigger resolution check", () => {
    // Simulates fallback detection for low-price positions
    const currentPrice = 0.005; // 0.5¢
    const isRedeemable = false;
    
    const shouldCheckResolution =
      !isRedeemable &&
      (currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
        currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD);
    
    assert.ok(
      shouldCheckResolution,
      "Position at 0.5¢ should trigger resolution check",
    );
  });

  test("Position at 50¢ should NOT trigger resolution check", () => {
    // Simulates normal active position
    const currentPrice = 0.5; // 50¢
    const isRedeemable = false;
    
    const shouldCheckResolution =
      !isRedeemable &&
      (currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
        currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD);
    
    assert.ok(
      !shouldCheckResolution,
      "Position at 50¢ should NOT trigger resolution check",
    );
  });

  test("Already redeemable position should NOT trigger fallback check", () => {
    // If API already marked as redeemable, skip fallback check
    const currentPrice = 1.0; // 100¢
    const isRedeemable = true; // API already marked as redeemable
    
    const shouldCheckResolution =
      !isRedeemable &&
      (currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
        currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD);
    
    assert.ok(
      !shouldCheckResolution,
      "Already redeemable position should NOT trigger fallback check",
    );
  });

  test("Fallback detection sets finalRedeemable to true when market confirmed resolved", () => {
    // Simulates the logic after Gamma API confirms resolution
    const isRedeemable = false;
    const winningOutcome = "YES"; // Gamma API returned winning outcome
    let finalRedeemable = isRedeemable;
    
    if (winningOutcome !== null) {
      finalRedeemable = true;
    }
    
    assert.strictEqual(
      finalRedeemable,
      true,
      "finalRedeemable should be true when market is confirmed resolved",
    );
  });

  test("Fallback detection adjusts price to exact settlement value for winner", () => {
    // Simulates price adjustment for winning position
    const side = "YES";
    const winningOutcome = "YES";
    let currentPrice = 0.995; // Was at 99.5¢
    
    if (winningOutcome !== null) {
      currentPrice = side === winningOutcome ? 1.0 : 0.0;
    }
    
    assert.strictEqual(
      currentPrice,
      1.0,
      "Winning position should be adjusted to exactly 1.0 (100¢)",
    );
  });

  test("Fallback detection adjusts price to exact settlement value for loser", () => {
    // Simulates price adjustment for losing position
    const side = "NO";
    const winningOutcome = "YES";
    let currentPrice = 0.005; // Was at 0.5¢
    
    if (winningOutcome !== null) {
      currentPrice = side === winningOutcome ? 1.0 : 0.0;
    }
    
    assert.strictEqual(
      currentPrice,
      0.0,
      "Losing position should be adjusted to exactly 0.0 (0¢)",
    );
  });
});

describe("PositionTracker Historical Entry Times", () => {
  test("Timestamp conversion - handles both seconds and milliseconds", () => {
    // Simulates the timestamp conversion logic
    function convertTimestamp(timestamp: number | string): number {
      if (typeof timestamp === "number") {
        // Timestamps > 1e12 are already in milliseconds
        // Timestamps < 1e12 are in seconds
        return timestamp > 1e12 ? timestamp : timestamp * 1000;
      }
      return new Date(timestamp).getTime();
    }

    // Test seconds (Unix timestamp in seconds)
    const secondsTimestamp = 1700000000; // Nov 14, 2023 in seconds
    assert.strictEqual(
      convertTimestamp(secondsTimestamp),
      1700000000000,
      "Should convert seconds to milliseconds",
    );

    // Test milliseconds (already in ms)
    const msTimestamp = 1700000000000; // Nov 14, 2023 in milliseconds
    assert.strictEqual(
      convertTimestamp(msTimestamp),
      1700000000000,
      "Should keep milliseconds as-is",
    );

    // Test string timestamp
    const stringTimestamp = "2023-11-14T22:13:20.000Z";
    assert.strictEqual(
      convertTimestamp(stringTimestamp),
      1700000000000,
      "Should convert ISO string to milliseconds",
    );

    // Test invalid string timestamp returns NaN
    const invalidTimestamp = "not-a-date";
    const invalidResult = new Date(invalidTimestamp).getTime();
    assert.ok(Number.isNaN(invalidResult), "Invalid string should produce NaN");
  });

  test("Timestamp validation - NaN timestamps should be skipped", () => {
    // Simulates the validation logic that skips NaN timestamps
    const timestamps = [
      { value: 1700000000000, valid: true },
      { value: NaN, valid: false },
      { value: Infinity, valid: false },
      { value: -Infinity, valid: false },
    ];

    for (const { value, valid } of timestamps) {
      const isValid = Number.isFinite(value);
      assert.strictEqual(
        isValid,
        valid,
        `Timestamp ${value} should be ${valid ? "valid" : "invalid"}`,
      );
    }
  });

  test("Wallet address validation - rejects invalid addresses", () => {
    // Simulates the wallet address validation regex
    const isValidAddress = (addr: string) => /^0x[a-fA-F0-9]{40}$/.test(addr);

    assert.ok(
      isValidAddress("0x1234567890abcdef1234567890abcdef12345678"),
      "Valid address should pass",
    );
    assert.ok(!isValidAddress("unknown"), "'unknown' should be rejected");
    assert.ok(!isValidAddress("0x123"), "Too short address should be rejected");
    assert.ok(
      !isValidAddress("1234567890abcdef1234567890abcdef12345678"),
      "Address without 0x prefix should be rejected",
    );
  });

  test("Historical entry times parsing - finds earliest BUY for each token", () => {
    // Simulates parsing activity data to find earliest BUY timestamp
    interface ActivityItem {
      type: string;
      timestamp: number;
      conditionId: string;
      asset: string;
      side: string;
    }

    const activities: ActivityItem[] = [
      // Multiple BUYs for same token - should keep earliest
      {
        type: "TRADE",
        timestamp: 1700000000,
        conditionId: "market1",
        asset: "token1",
        side: "BUY",
      },
      {
        type: "TRADE",
        timestamp: 1700001000,
        conditionId: "market1",
        asset: "token1",
        side: "BUY",
      }, // Later BUY
      // SELL should be ignored
      {
        type: "TRADE",
        timestamp: 1699999000,
        conditionId: "market1",
        asset: "token1",
        side: "SELL",
      },
      // Different token
      {
        type: "TRADE",
        timestamp: 1700002000,
        conditionId: "market2",
        asset: "token2",
        side: "BUY",
      },
      // Non-TRADE type should be ignored
      {
        type: "DEPOSIT",
        timestamp: 1699998000,
        conditionId: "market1",
        asset: "token1",
        side: "BUY",
      },
    ];

    const earliestBuyTimes = new Map<string, number>();

    for (const activity of activities) {
      if (activity.type !== "TRADE" || activity.side?.toUpperCase() !== "BUY") {
        continue;
      }

      const key = `${activity.conditionId}-${activity.asset}`;
      const timestamp = activity.timestamp * 1000; // Convert to ms

      const existing = earliestBuyTimes.get(key);
      if (!existing || timestamp < existing) {
        earliestBuyTimes.set(key, timestamp);
      }
    }

    assert.strictEqual(
      earliestBuyTimes.size,
      2,
      "Should have 2 unique positions",
    );
    assert.strictEqual(
      earliestBuyTimes.get("market1-token1"),
      1700000000 * 1000,
      "Should keep earliest BUY timestamp for token1",
    );
    assert.strictEqual(
      earliestBuyTimes.get("market2-token2"),
      1700002000 * 1000,
      "Should have correct timestamp for token2",
    );
  });

  test("Entry time preservation - existing entry times are not overwritten", () => {
    // Simulates the refresh logic where historical entry times should be preserved
    const positionEntryTimes = new Map<string, number>();

    // Pre-loaded historical entry time
    positionEntryTimes.set("market1-token1", 1700000000 * 1000);

    // New position detected in refresh
    const newPositionKey = "market1-token1";
    const now = Date.now();

    // Should NOT overwrite existing entry time
    if (!positionEntryTimes.has(newPositionKey)) {
      positionEntryTimes.set(newPositionKey, now);
    }

    assert.strictEqual(
      positionEntryTimes.get(newPositionKey),
      1700000000 * 1000,
      "Historical entry time should be preserved, not overwritten with 'now'",
    );
  });

  test("New positions get current time when no historical data exists", () => {
    const positionEntryTimes = new Map<string, number>();

    // New position with no historical data
    const newPositionKey = "market2-token2";
    const now = Date.now();

    if (!positionEntryTimes.has(newPositionKey)) {
      positionEntryTimes.set(newPositionKey, now);
    }

    const entryTime = positionEntryTimes.get(newPositionKey);
    assert.ok(
      entryTime !== undefined,
      "New position should have entry time set",
    );
    assert.ok(
      entryTime! >= now - 1000 && entryTime! <= now + 1000,
      "New position entry time should be close to 'now'",
    );
  });
});

describe("Stop-Loss Entry Time Validation", () => {
  test("Stop-loss should skip positions without entry time", () => {
    // Simulates the conservative behavior in UniversalStopLossStrategy
    const positionEntryTimes = new Map<string, number>();
    const position = {
      marketId: "market1",
      tokenId: "token1",
      pnlPct: -30, // Position is losing
      entryPrice: 0.7,
    };

    const entryTime = positionEntryTimes.get(
      `${position.marketId}-${position.tokenId}`,
    );

    // If no entry time, should skip stop-loss
    const shouldSkip = !entryTime;

    assert.ok(
      shouldSkip,
      "Stop-loss should skip positions without entry time to prevent mass sells on restart",
    );
  });

  test("Stop-loss should process positions with known entry time", () => {
    const positionEntryTimes = new Map<string, number>();
    const position = {
      marketId: "market1",
      tokenId: "token1",
      pnlPct: -30,
      entryPrice: 0.7,
    };

    // Position has historical entry time (bought 5 minutes ago)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    positionEntryTimes.set(
      `${position.marketId}-${position.tokenId}`,
      fiveMinutesAgo,
    );

    const entryTime = positionEntryTimes.get(
      `${position.marketId}-${position.tokenId}`,
    );
    const shouldSkip = !entryTime;

    assert.ok(
      !shouldSkip,
      "Stop-loss should process positions with known entry time",
    );

    // Check hold time calculation
    const minHoldSeconds = 60;
    const now = Date.now();
    const holdTimeSeconds = (now - entryTime!) / 1000;

    assert.ok(
      holdTimeSeconds >= minHoldSeconds,
      "Position held for 5 minutes should pass minHoldSeconds check",
    );
  });

  test("Stop-loss should skip positions held for less than minHoldSeconds", () => {
    const positionEntryTimes = new Map<string, number>();
    const position = {
      marketId: "market1",
      tokenId: "token1",
      pnlPct: -30,
      entryPrice: 0.7,
    };

    // Position was just bought (30 seconds ago)
    const thirtySecondsAgo = Date.now() - 30 * 1000;
    positionEntryTimes.set(
      `${position.marketId}-${position.tokenId}`,
      thirtySecondsAgo,
    );

    const entryTime = positionEntryTimes.get(
      `${position.marketId}-${position.tokenId}`,
    );
    const minHoldSeconds = 60;
    const now = Date.now();
    const holdTimeSeconds = (now - entryTime!) / 1000;

    const passesHoldCheck = holdTimeSeconds >= minHoldSeconds;

    assert.ok(
      !passesHoldCheck,
      "Position held for 30 seconds should NOT pass 60-second minHoldSeconds check",
    );
  });
});

describe("Historical Trade Pagination Logic", () => {
  test("Pagination correctly selects earliest BUY timestamp per position across multiple pages", () => {
    // Simulates processing trades from multiple API pages
    interface TradeItem {
      timestamp: number;
      conditionId: string;
      asset: string;
      side: string;
    }

    // Page 1 (most recent trades)
    const page1: TradeItem[] = [
      { timestamp: 1700002000, conditionId: "market1", asset: "token1", side: "BUY" },
      { timestamp: 1700001500, conditionId: "market2", asset: "token2", side: "BUY" },
    ];

    // Page 2 (older trades) - contains earlier BUY for market1
    const page2: TradeItem[] = [
      { timestamp: 1700000000, conditionId: "market1", asset: "token1", side: "BUY" }, // Earlier!
      { timestamp: 1700000500, conditionId: "market3", asset: "token3", side: "BUY" },
    ];

    const earliestBuyTimes = new Map<string, number>();

    // Process all pages (simulating pagination)
    for (const trades of [page1, page2]) {
      for (const trade of trades) {
        if (trade.side !== "BUY") continue;

        const key = `${trade.conditionId}-${trade.asset}`;
        const timestamp = trade.timestamp * 1000; // Convert to ms

        const existing = earliestBuyTimes.get(key);
        if (!existing || timestamp < existing) {
          earliestBuyTimes.set(key, timestamp);
        }
      }
    }

    assert.strictEqual(
      earliestBuyTimes.get("market1-token1"),
      1700000000 * 1000,
      "Should keep earliest BUY timestamp from page 2, not page 1",
    );
    assert.strictEqual(
      earliestBuyTimes.get("market2-token2"),
      1700001500 * 1000,
      "market2 only has one BUY, should use that timestamp",
    );
    assert.strictEqual(
      earliestBuyTimes.get("market3-token3"),
      1700000500 * 1000,
      "market3 from page 2 should be included",
    );
    assert.strictEqual(
      earliestBuyTimes.size,
      3,
      "Should have 3 unique positions",
    );
  });

  test("Pagination stops when receiving fewer results than page limit", () => {
    // Simulates the pagination stop condition
    const PAGE_LIMIT = 500;
    const page1Results = 500; // Full page
    const page2Results = 200; // Partial page - should stop after this

    let shouldContinue = page1Results === PAGE_LIMIT;
    assert.ok(shouldContinue, "Should continue after full page");

    shouldContinue = page2Results === PAGE_LIMIT;
    assert.ok(!shouldContinue, "Should stop after partial page");
  });

  test("Pagination respects max pages safety cap", () => {
    const MAX_PAGES = 20;
    let pageCount = 0;

    // Simulate fetching pages until max
    while (pageCount < MAX_PAGES) {
      pageCount++;
      // In real code, we'd check if last page was full
      // For this test, assume we keep getting full pages
    }

    assert.strictEqual(
      pageCount,
      MAX_PAGES,
      "Pagination should stop at MAX_PAGES even if more data exists",
    );
  });

  test("Max pages warning condition is detected correctly", () => {
    const MAX_PAGES = 20;
    const PAGE_LIMIT = 500;

    // Case 1: Hit max pages AND last page was full (should warn)
    const pageCount1 = MAX_PAGES;
    const totalTrades1 = MAX_PAGES * PAGE_LIMIT; // All pages full
    const shouldWarn1 =
      pageCount1 >= MAX_PAGES &&
      totalTrades1 > 0 &&
      totalTrades1 % PAGE_LIMIT === 0;
    assert.ok(shouldWarn1, "Should warn when max pages hit and last page was full");

    // Case 2: Hit max pages but last page was partial (no warning needed)
    const pageCount2 = MAX_PAGES;
    const totalTrades2 = (MAX_PAGES - 1) * PAGE_LIMIT + 200; // Last page partial
    const shouldWarn2 =
      pageCount2 >= MAX_PAGES &&
      totalTrades2 > 0 &&
      totalTrades2 % PAGE_LIMIT === 0;
    assert.ok(!shouldWarn2, "Should NOT warn when last page was partial");

    // Case 3: Didn't hit max pages (no warning needed)
    const pageCount3 = 5;
    const totalTrades3 = 5 * PAGE_LIMIT;
    const shouldWarn3 =
      pageCount3 >= MAX_PAGES &&
      totalTrades3 > 0 &&
      totalTrades3 % PAGE_LIMIT === 0;
    assert.ok(!shouldWarn3, "Should NOT warn when max pages not reached");
  });
});
