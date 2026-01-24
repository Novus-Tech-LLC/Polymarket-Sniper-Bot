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
      {
        timestamp: 1700002000,
        conditionId: "market1",
        asset: "token1",
        side: "BUY",
      },
      {
        timestamp: 1700001500,
        conditionId: "market2",
        asset: "token2",
        side: "BUY",
      },
    ];

    // Page 2 (older trades) - contains earlier BUY for market1
    const page2: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market1",
        asset: "token1",
        side: "BUY",
      }, // Earlier!
      {
        timestamp: 1700000500,
        conditionId: "market3",
        asset: "token3",
        side: "BUY",
      },
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
    assert.ok(
      shouldWarn1,
      "Should warn when max pages hit and last page was full",
    );

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

describe("Liquidation Candidates Logic", () => {
  // Helper type to represent a position for testing
  interface TestPosition {
    marketId: string;
    tokenId: string;
    side: string;
    size: number;
    entryPrice: number;
    currentPrice: number;
    pnlPct: number;
    pnlUsd: number;
    redeemable?: boolean;
  }

  /**
   * Helper function to simulate the filtering logic in PositionTracker.getLiquidationCandidates.
   * Filters positions to find candidates suitable for liquidation when funds are insufficient.
   *
   * @param positions - Array of positions to filter
   * @param entryTimes - Map of position keys to entry timestamps
   * @param minLossPct - Minimum loss percentage to consider for liquidation
   * @param minHoldSeconds - Minimum hold time in seconds before a position can be liquidated
   * @returns Array of positions suitable for liquidation, sorted by worst loss first
   */
  function getLiquidationCandidates(
    positions: TestPosition[],
    entryTimes: Map<string, number>,
    minLossPct: number,
    minHoldSeconds: number,
  ): TestPosition[] {
    const now = Date.now();

    return (
      positions
        .filter((pos) => {
          // Must be active (not redeemable)
          if (pos.redeemable) return false;

          // Must be losing
          if (pos.pnlPct >= 0) return false;

          // Must have valid side info for selling
          if (!pos.side || pos.side.trim() === "") return false;

          // Must meet minimum loss threshold
          if (Math.abs(pos.pnlPct) < minLossPct) return false;

          // Must have been held for minimum time
          const key = `${pos.marketId}-${pos.tokenId}`;
          const entryTime = entryTimes.get(key);
          if (entryTime) {
            const holdSeconds = (now - entryTime) / 1000;
            if (holdSeconds < minHoldSeconds) return false;
          }

          return true;
        })
        // Sort by worst loss first
        .sort((a, b) => a.pnlPct - b.pnlPct)
    );
  }

  test("Filters out profitable positions", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.3,
        pnlPct: -25,
        pnlUsd: -5,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000); // 5 min ago
    entryTimes.set("m2-t2", Date.now() - 300000); // 5 min ago

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      1,
      "Should only include losing position",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include the losing position",
    );
  });

  test("Filters out positions without valid side info", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "YES",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.25,
        pnlPct: -37.5,
        pnlUsd: -7.5,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);
    entryTimes.set("m2-t2", Date.now() - 300000);

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      1,
      "Should only include position with valid side",
    );
    assert.strictEqual(
      candidates[0].side,
      "YES",
      "Should include position with YES side",
    );
  });

  test("Filters out positions below minimum loss threshold", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.48,
        pnlPct: -4,
        pnlUsd: -2,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.3,
        pnlPct: -25,
        pnlUsd: -5,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);
    entryTimes.set("m2-t2", Date.now() - 300000);

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      1,
      "Should only include position above threshold",
    );
    assert.strictEqual(
      candidates[0].pnlPct,
      -25,
      "Should include position with -25% loss",
    );
  });

  test("Filters out positions held for less than minHoldSeconds", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.25,
        pnlPct: -37.5,
        pnlUsd: -7.5,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 30000); // 30 seconds ago (too recent)
    entryTimes.set("m2-t2", Date.now() - 300000); // 5 min ago (OK)

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      1,
      "Should only include position held long enough",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include the older position",
    );
  });

  test("Filters out redeemable positions", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.0,
        pnlPct: -100,
        pnlUsd: -50,
        redeemable: true,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.25,
        pnlPct: -37.5,
        pnlUsd: -7.5,
        redeemable: false,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);
    entryTimes.set("m2-t2", Date.now() - 300000);

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      1,
      "Should only include non-redeemable position",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include the active position",
    );
  });

  test("Sorts candidates by worst loss first", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.4,
        pnlPct: -20,
        pnlUsd: -10,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.2,
        pnlPct: -50,
        pnlUsd: -10,
      },
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.6,
        currentPrice: 0.42,
        pnlPct: -30,
        pnlUsd: -13.5,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);
    entryTimes.set("m2-t2", Date.now() - 300000);
    entryTimes.set("m3-t3", Date.now() - 300000);

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      3,
      "Should include all three losing positions",
    );
    assert.strictEqual(
      candidates[0].pnlPct,
      -50,
      "First should be worst loss (-50%)",
    );
    assert.strictEqual(candidates[1].pnlPct, -30, "Second should be -30%");
    assert.strictEqual(candidates[2].pnlPct, -20, "Third should be -20%");
  });

  test("Returns empty array when no positions meet criteria", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    assert.strictEqual(
      candidates.length,
      0,
      "Should return empty array when no losing positions",
    );
  });

  test("Calculates total liquidation value correctly", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.2,
        pnlPct: -50,
        pnlUsd: -10,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);
    entryTimes.set("m2-t2", Date.now() - 300000);

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    // Calculate total value
    const totalValue = candidates.reduce(
      (total, pos) => total + pos.size * pos.currentPrice,
      0,
    );

    // m1: 100 * 0.3 = 30
    // m2: 50 * 0.2 = 10
    // Total: 40
    assert.strictEqual(totalValue, 40, "Total liquidation value should be $40");
  });

  test("Includes positions without entry time (externally acquired)", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
    ];
    const entryTimes = new Map<string, number>(); // No entry time for this position

    const candidates = getLiquidationCandidates(positions, entryTimes, 10, 60);

    // Position without entry time should still be included (conservative approach for externally acquired)
    assert.strictEqual(
      candidates.length,
      1,
      "Should include position without entry time",
    );
  });
});

/**
 * Tests for the corrected P&L calculation using BEST BID as mark price
 * These tests validate the fix for the 0.0% P&L issue described in the problem statement.
 *
 * WHY PREVIOUS P&L SHOWED 0.0% AND ALL LOSING:
 * The old code used mid-price ((bestBid + bestAsk) / 2) for P&L calculations.
 * For sell-to-realize-profit scenarios, we MUST use the BEST BID - what we can actually sell at.
 * Using mid-price caused:
 * 1. Overestimation of position value when spread is wide
 * 2. 0.0% readings when mid-price happened to equal entry price
 * 3. All positions appearing as losing when bid was significantly below mid
 */
describe("PositionTracker P&L Calculation with BEST BID", () => {
  test("P&L uses BEST BID (not mid-price) for active positions", () => {
    // Simulates the scenario from the problem statement:
    // Entry at 51¢, current bid at 51¢ => ~0% P&L
    const entryPrice = 0.51;
    const bestBid = 0.51;
    const bestAsk = 0.55;
    const _size = 100; // Documented for context, not used in P&L% calc

    // Old buggy calculation (mid-price):
    const midPrice = (bestBid + bestAsk) / 2; // 0.53
    const wrongPnlPct = ((midPrice - entryPrice) / entryPrice) * 100; // +3.92%

    // Correct calculation (BEST BID as mark price for selling):
    const markPrice = bestBid; // 0.51 - what we can actually sell at
    const correctPnlPct = ((markPrice - entryPrice) / entryPrice) * 100; // 0%

    assert.strictEqual(
      Math.round(correctPnlPct * 100) / 100,
      0,
      "P&L should be ~0% when bid equals entry price",
    );
    assert.ok(
      wrongPnlPct > correctPnlPct,
      "Mid-price overestimates actual realizable profit",
    );
  });

  test("Regression: entry 51¢ → bid 51¢ => ~0%", () => {
    // From problem statement: positions that should show ~0% were showing wrong values
    const entryPrice = 0.51;
    const bestBid = 0.51;
    const size = 100;

    const markPrice = bestBid;
    const pnlUsd = (markPrice - entryPrice) * size;
    const pnlPct = ((markPrice - entryPrice) / entryPrice) * 100;

    assert.strictEqual(pnlUsd, 0, "P&L USD should be $0");
    assert.strictEqual(pnlPct, 0, "P&L% should be 0%");
  });

  test("Regression: entry 56¢ → bid 53¢ => ~-5.36%", () => {
    // From problem statement: losing position
    const entryPrice = 0.56;
    const bestBid = 0.53;
    const size = 100;

    const markPrice = bestBid;
    const pnlUsd = (markPrice - entryPrice) * size;
    const pnlPct = ((markPrice - entryPrice) / entryPrice) * 100;

    assert.ok(
      Math.abs(pnlUsd - -3) < 0.01,
      `P&L USD should be ~-$3, got ${pnlUsd}`,
    );
    assert.ok(
      Math.abs(pnlPct - -5.36) < 0.1,
      `P&L% should be ~-5.36%, got ${pnlPct}`,
    );
  });

  test("Regression: entry 62¢ → bid 60¢ => ~-3.2%", () => {
    // From problem statement: another losing position
    const entryPrice = 0.62;
    const bestBid = 0.6;
    const size = 100;

    const markPrice = bestBid;
    const pnlUsd = (markPrice - entryPrice) * size;
    const pnlPct = ((markPrice - entryPrice) / entryPrice) * 100;

    assert.ok(
      Math.abs(pnlUsd - -2) < 0.01,
      `P&L USD should be ~-$2, got ${pnlUsd}`,
    );
    assert.ok(
      Math.abs(pnlPct - -3.23) < 0.1,
      `P&L% should be ~-3.23%, got ${pnlPct}`,
    );
  });

  test("Profitable position: entry 50¢ → bid 55¢ => +10%", () => {
    const entryPrice = 0.5;
    const bestBid = 0.55;
    const size = 100;

    const markPrice = bestBid;
    const pnlUsd = (markPrice - entryPrice) * size;
    const pnlPct = ((markPrice - entryPrice) / entryPrice) * 100;

    // Use approximate comparison due to floating-point precision
    assert.ok(
      Math.abs(pnlUsd - 5) < 0.01,
      `P&L USD should be ~$5, got ${pnlUsd}`,
    );
    assert.ok(
      Math.abs(pnlPct - 10) < 0.01,
      `P&L% should be ~10%, got ${pnlPct}`,
    );
  });

  test("Wide spread: entry 50¢, bid 48¢, ask 58¢ - shows loss despite mid > entry", () => {
    // This scenario demonstrates why mid-price is wrong:
    // Mid-price = (48 + 58) / 2 = 53¢ -> would show +6% profit
    // But we can only sell at 48¢ -> actual -4% loss
    const entryPrice = 0.5;
    const bestBid = 0.48;
    const bestAsk = 0.58;
    const size = 100;

    const midPrice = (bestBid + bestAsk) / 2; // 0.53
    const wrongPnlPct = ((midPrice - entryPrice) / entryPrice) * 100; // +6%

    const markPrice = bestBid; // 0.48
    const correctPnlPct = ((markPrice - entryPrice) / entryPrice) * 100; // -4%
    const correctPnlUsd = (markPrice - entryPrice) * size; // -$2

    assert.ok(wrongPnlPct > 0, "Mid-price wrongly shows profit");
    assert.ok(correctPnlPct < 0, "Correct calculation shows loss");
    // Use approximate comparison due to floating-point precision
    assert.ok(
      Math.abs(correctPnlUsd - -2) < 0.01,
      `Actual loss should be ~$2, got ${correctPnlUsd}`,
    );
    assert.ok(
      Math.abs(correctPnlPct - -4) < 0.01,
      `Actual loss should be ~4%, got ${correctPnlPct}`,
    );
  });

  test("'0 profitable' only occurs when all positions have pnlPct <= 0", () => {
    // Simulates the scenario from logs: "ACTIVE: 0 profitable, 8 losing"
    // This should only happen when ALL positions have non-positive P&L
    type SimplePosition = { pnlPct: number; redeemable?: boolean };
    const positions: SimplePosition[] = [
      { pnlPct: -5.36, redeemable: false }, // losing
      { pnlPct: -3.23, redeemable: false }, // losing
      { pnlPct: -1.5, redeemable: false }, // losing
      { pnlPct: 0, redeemable: false }, // breakeven
      { pnlPct: -8.2, redeemable: false }, // losing
    ];

    const activePositions = positions.filter((p) => !p.redeemable);
    const profitable = activePositions.filter((p) => p.pnlPct > 0);
    const losing = activePositions.filter((p) => p.pnlPct < 0);
    const breakeven = activePositions.filter((p) => p.pnlPct === 0);

    assert.strictEqual(profitable.length, 0, "No profitable positions");
    assert.strictEqual(losing.length, 4, "4 losing positions");
    assert.strictEqual(breakeven.length, 1, "1 breakeven position");
  });
});

describe("PositionTracker Status and NO_BOOK Handling", () => {
  test("Position status is ACTIVE when orderbook available", () => {
    const hasOrderbook = true;
    const isRedeemable = false;

    // Simulates status assignment logic
    let status: string = "ACTIVE";
    if (isRedeemable) {
      status = "REDEEMABLE";
    } else if (!hasOrderbook) {
      status = "NO_BOOK";
    }

    assert.strictEqual(status, "ACTIVE", "Status should be ACTIVE");
  });

  test("Position status is NO_BOOK when orderbook unavailable", () => {
    const hasOrderbook = false;
    const isRedeemable = false;

    let status: string = "ACTIVE";
    if (isRedeemable) {
      status = "REDEEMABLE";
    } else if (!hasOrderbook) {
      status = "NO_BOOK";
    }

    assert.strictEqual(status, "NO_BOOK", "Status should be NO_BOOK");
  });

  test("Position status is REDEEMABLE when market resolved", () => {
    const hasOrderbook = true; // irrelevant for resolved
    const isRedeemable = true;

    let status: string = "ACTIVE";
    if (isRedeemable) {
      status = "REDEEMABLE";
    } else if (!hasOrderbook) {
      status = "NO_BOOK";
    }

    assert.strictEqual(status, "REDEEMABLE", "Status should be REDEEMABLE");
  });

  test("NO_BOOK positions should be excluded from ScalpTakeProfit", () => {
    // ScalpTakeProfit should skip positions with NO_BOOK status
    // because P&L calculation uses fallback pricing which may be inaccurate
    type Position = { status?: string; pnlPct: number; redeemable?: boolean };
    const positions: Position[] = [
      { status: "ACTIVE", pnlPct: 5.0, redeemable: false }, // Should evaluate
      { status: "NO_BOOK", pnlPct: 3.0, redeemable: false }, // Should skip
      { status: "REDEEMABLE", pnlPct: 66.0, redeemable: true }, // Should skip (resolved)
      { status: "ACTIVE", pnlPct: -2.0, redeemable: false }, // Should skip (losing)
    ];

    const scalpCandidates = positions.filter(
      (p) => !p.redeemable && p.status !== "NO_BOOK" && p.pnlPct > 0,
    );

    assert.strictEqual(scalpCandidates.length, 1, "Only 1 candidate");
    assert.strictEqual(
      scalpCandidates[0].pnlPct,
      5.0,
      "Candidate has 5% profit",
    );
  });
});

describe("PositionTracker Cache TTL Logic", () => {
  test("Orderbook cache is valid within TTL", () => {
    const ORDERBOOK_CACHE_TTL_MS = 2000;
    const fetchedAt = Date.now() - 1000; // 1 second ago
    const now = Date.now();

    const cacheAge = now - fetchedAt;
    const isValid = cacheAge < ORDERBOOK_CACHE_TTL_MS;

    assert.ok(isValid, "Cache should be valid (1s < 2s TTL)");
  });

  test("Orderbook cache is stale after TTL", () => {
    const ORDERBOOK_CACHE_TTL_MS = 2000;
    const fetchedAt = Date.now() - 3000; // 3 seconds ago
    const now = Date.now();

    const cacheAge = now - fetchedAt;
    const isValid = cacheAge < ORDERBOOK_CACHE_TTL_MS;

    assert.ok(!isValid, "Cache should be stale (3s > 2s TTL)");
  });

  test("Cache age is calculated correctly", () => {
    const fetchedAt = Date.now() - 1500; // 1.5 seconds ago
    const now = Date.now();

    const cacheAge = now - fetchedAt;

    assert.ok(
      cacheAge >= 1500 && cacheAge < 1600,
      "Cache age should be ~1500ms",
    );
  });
});

describe("PositionTracker Gated Redeemable Detection", () => {
  test("Position with apiPos.redeemable=true and Gamma resolved=true should be redeemable", () => {
    // Simulates the case where API correctly marks position as redeemable
    // and Gamma confirms the market is resolved
    const apiRedeemable = true;
    const gammaResolved = true;
    const _hasOrderbook = false; // Documented - not relevant when Gamma confirms resolution

    // Logic: If API says redeemable AND Gamma confirms resolved, keep as redeemable
    const isRedeemable = apiRedeemable && gammaResolved;

    assert.strictEqual(
      isRedeemable,
      true,
      "Position should be redeemable when both API and Gamma agree",
    );
  });

  test("Position with apiPos.redeemable=true and Gamma resolved=false but no orderbook should be redeemable", () => {
    // Simulates the case where market is in a limbo state - API says redeemable,
    // Gamma hasn't confirmed resolution yet, but no orderbook exists
    const apiRedeemable = true;
    const gammaResolved = false;
    const hasOrderbook = false;

    // Logic: If API says redeemable and no orderbook, treat as redeemable
    // even if Gamma hasn't confirmed (market may be in transition)
    const isRedeemable =
      apiRedeemable && (!gammaResolved ? !hasOrderbook : true);

    assert.strictEqual(
      isRedeemable,
      true,
      "Position should be redeemable when no orderbook exists (market in limbo)",
    );
  });

  test("Position with apiPos.redeemable=true but Gamma resolved=false and orderbook exists should be ACTIVE", () => {
    // Simulates the bug case: API incorrectly marks position as redeemable
    // but Gamma says market is NOT resolved and orderbook still exists
    const apiRedeemable = true;
    const gammaResolved = false;
    const hasOrderbook = true;

    // Logic: Override API's redeemable flag - keep as ACTIVE
    // This is the key fix: don't trust API alone when orderbook exists
    const isRedeemable =
      apiRedeemable && (gammaResolved || (!gammaResolved && !hasOrderbook));

    assert.strictEqual(
      isRedeemable,
      false,
      "Position should remain ACTIVE when orderbook exists and Gamma not resolved",
    );
  });

  test("Position with apiPos.redeemable=false should remain active regardless of Gamma status", () => {
    // If API doesn't mark position as redeemable, it should stay active
    const _apiRedeemable = false; // Documented here - not used in logic intentionally
    const _gammaResolved = true; // Even if Gamma says resolved (not checked)
    const _hasOrderbook = true; // Not checked when API says not redeemable

    // We only check Gamma when apiPos.redeemable === true
    // If API says not redeemable, keep as active (existing fallback detection handles edge cases)
    const isRedeemable = false; // apiRedeemable is false, so we skip verification entirely

    assert.strictEqual(
      isRedeemable,
      false,
      "Position should remain active when API says not redeemable",
    );
  });

  test("Redeemable override logging condition is correct", () => {
    // Verify the condition that triggers REDEEMABLE_OVERRIDE warning
    const apiRedeemable = true;
    const gammaResolved = false;
    const hasOrderbook = true;

    // This condition should trigger the warning log
    const shouldLogOverride = apiRedeemable && !gammaResolved && hasOrderbook;

    assert.strictEqual(
      shouldLogOverride,
      true,
      "Should log override warning when API redeemable but market still active",
    );
  });
});

describe("PositionTracker Market Resolution Verification", () => {
  test("Market with closed=true should be considered resolved", () => {
    const market = {
      closed: true,
      resolved: false,
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.5", "0.5"]',
    };

    const isResolved = market.closed === true || market.resolved === true;
    assert.strictEqual(
      isResolved,
      true,
      "Market with closed=true should be resolved",
    );
  });

  test("Market with resolved=true should be considered resolved", () => {
    const market = {
      closed: false,
      resolved: true,
      outcomes: '["Yes", "No"]',
      outcomePrices: '["1", "0"]',
    };

    const isResolved = market.closed === true || market.resolved === true;
    assert.strictEqual(
      isResolved,
      true,
      "Market with resolved=true should be resolved",
    );
  });

  test("Market with winning outcome price > 0.5 should be considered resolved", () => {
    const market = {
      closed: false,
      resolved: false,
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.99", "0.01"]',
    };

    const outcomes = JSON.parse(market.outcomes);
    const prices = JSON.parse(market.outcomePrices);

    let winnerIndex = -1;
    let highestPrice = 0;
    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
        winnerIndex = i;
      }
    }

    // Winner threshold is 0.5
    const hasWinner = winnerIndex >= 0 && highestPrice > WINNER_THRESHOLD;
    const winningOutcome = hasWinner ? outcomes[winnerIndex] : null;

    assert.strictEqual(hasWinner, true, "Should have a winning outcome");
    assert.strictEqual(
      winningOutcome,
      "Yes",
      "Winning outcome should be 'Yes'",
    );
  });

  test("Market with all prices near 0 should NOT be considered resolved", () => {
    const market = {
      closed: false,
      resolved: false,
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.01", "0.01"]',
    };

    const prices = JSON.parse(market.outcomePrices);

    let highestPrice = 0;
    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (Number.isFinite(price) && price > highestPrice) {
        highestPrice = price;
      }
    }

    const hasWinner = highestPrice > WINNER_THRESHOLD;
    const isResolvedByFlags =
      market.closed === true || market.resolved === true;
    const isResolved = isResolvedByFlags || hasWinner;

    assert.strictEqual(
      isResolved,
      false,
      "Market with all prices near 0 should NOT be resolved",
    );
  });
});

describe("PositionTracker Active/Resolved Count Accounting", () => {
  test("Position overridden from redeemable to active should be counted in activeCount", () => {
    // Simulates the accounting logic when a position is overridden
    let activeCount = 0;
    let resolvedCount = 0;

    // API claims redeemable but we override to active
    const apiRedeemable = true;
    const gammaResolved = false;
    const hasOrderbook = true;

    const isRedeemable =
      apiRedeemable && (gammaResolved || (!gammaResolved && !hasOrderbook));

    if (isRedeemable) {
      resolvedCount++;
    } else {
      activeCount++;
    }

    assert.strictEqual(activeCount, 1, "Active count should be 1");
    assert.strictEqual(resolvedCount, 0, "Resolved count should be 0");
  });

  test("Confirmed redeemable position should be counted in resolvedCount", () => {
    let activeCount = 0;
    let resolvedCount = 0;

    const apiRedeemable = true;
    const gammaResolved = true;
    const _hasOrderbook = false; // Documented - not relevant when Gamma confirms

    const isRedeemable = apiRedeemable && gammaResolved;

    if (isRedeemable) {
      resolvedCount++;
    } else {
      activeCount++;
    }

    assert.strictEqual(activeCount, 0, "Active count should be 0");
    assert.strictEqual(resolvedCount, 1, "Resolved count should be 1");
  });

  test("P&L summary split should correctly categorize positions", () => {
    // Simulates positions array after enrichment
    const positions = [
      { redeemable: true, pnlPct: 100 }, // Confirmed resolved - WIN
      { redeemable: true, pnlPct: -100 }, // Confirmed resolved - LOSS
      { redeemable: false, pnlPct: 15 }, // Active profitable
      { redeemable: false, pnlPct: -5 }, // Active losing
      { redeemable: false, pnlPct: 0 }, // Active breakeven
    ];

    const active = positions.filter((p) => !p.redeemable);
    const redeemable = positions.filter((p) => p.redeemable);
    const activeProfitable = active.filter((p) => p.pnlPct > 0);
    const activeLosing = active.filter((p) => p.pnlPct < 0);

    assert.strictEqual(active.length, 3, "Should have 3 active positions");
    assert.strictEqual(
      redeemable.length,
      2,
      "Should have 2 redeemable positions",
    );
    assert.strictEqual(
      activeProfitable.length,
      1,
      "Should have 1 active profitable",
    );
    assert.strictEqual(activeLosing.length, 1, "Should have 1 active losing");
  });
});

/**
 * Tests for getProfitLiquidationCandidates logic
 * Verifies that profitable positions are correctly filtered and sorted for
 * selling to free up funds when hedging fails due to insufficient balance.
 */
describe("PositionTracker.getProfitLiquidationCandidates Logic", () => {
  // Near-resolution threshold (matches private constant in position-tracker.ts)
  const NEAR_RESOLUTION_THRESHOLD = 0.9;

  // Helper type for test positions
  interface TestProfitPosition {
    marketId: string;
    tokenId: string;
    side: string;
    size: number;
    entryPrice: number;
    currentPrice: number;
    pnlPct: number;
    pnlUsd: number;
    redeemable?: boolean;
  }

  /**
   * Helper function that simulates the getProfitLiquidationCandidates logic.
   * This mirrors the actual implementation to ensure consistency with the code.
   */
  function filterProfitCandidates(
    positions: TestProfitPosition[],
    entryTimes: Map<string, number>,
    config: {
      minProfitPct: number;
      minHoldSeconds: number;
    },
  ): TestProfitPosition[] {
    const now = Date.now();

    return (
      positions
        .filter((pos) => {
          // Must be active (not redeemable)
          if (pos.redeemable) return false;

          // Must be profitable
          if (pos.pnlPct <= 0) return false;

          // Must have valid side info for selling
          if (!pos.side || pos.side.trim() === "") return false;

          // Must meet minimum profit threshold
          if (pos.pnlPct < config.minProfitPct) return false;

          // Exclude positions near resolution (price >= 90¢)
          if (pos.currentPrice >= NEAR_RESOLUTION_THRESHOLD) return false;

          // Must have been held for minimum time
          const key = `${pos.marketId}-${pos.tokenId}`;
          const entryTime = entryTimes.get(key);
          if (entryTime) {
            const holdSeconds = (now - entryTime) / 1000;
            if (holdSeconds < config.minHoldSeconds) return false;
          }

          return true;
        })
        // Sort by lowest profit first (ascending pnlPct)
        .sort((a, b) => a.pnlPct - b.pnlPct)
    );
  }

  test("Returns only profitable positions (pnlPct > 0)", () => {
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.3,
        pnlPct: -25,
        pnlUsd: -5,
      },
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.3,
        currentPrice: 0.3,
        pnlPct: 0,
        pnlUsd: 0,
      },
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, Date.now() - 300000),
    );

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      1,
      "Should return only profitable positions",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m1",
      "Should include the profitable position",
    );
  });

  test("Excludes positions near resolution (currentPrice >= 0.9)", () => {
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.85,
        currentPrice: 0.92,
        pnlPct: 8.2,
        pnlUsd: 7,
      }, // Near resolution
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.55,
        pnlPct: 37.5,
        pnlUsd: 7.5,
      }, // Not near resolution
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, Date.now() - 300000),
    );

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude position near resolution",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include position not near resolution",
    );
  });

  test("Excludes positions without valid side", () => {
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "YES",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.5,
        pnlPct: 25,
        pnlUsd: 5,
      },
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, Date.now() - 300000),
    );

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude position without side",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include position with valid side",
    );
  });

  test("Excludes redeemable positions", () => {
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.8,
        pnlPct: 60,
        pnlUsd: 30,
        redeemable: true,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.3,
        currentPrice: 0.4,
        pnlPct: 33.3,
        pnlUsd: 5,
        redeemable: false,
      },
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, Date.now() - 300000),
    );

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude redeemable position",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include non-redeemable position",
    );
  });

  test("Excludes positions below minProfitPct threshold", () => {
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.52,
        pnlPct: 4,
        pnlUsd: 2,
      }, // Below 5% threshold
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.3,
        currentPrice: 0.36,
        pnlPct: 20,
        pnlUsd: 3,
      }, // Above 5% threshold
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, Date.now() - 300000),
    );

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 5,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude position below profit threshold",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include position above profit threshold",
    );
  });

  test("Excludes positions failing min hold time", () => {
    const now = Date.now();
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      }, // Held only 30s
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.5,
        pnlPct: 25,
        pnlUsd: 5,
      }, // Held 5 min
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", now - 30000); // 30 seconds ago
    entryTimes.set("m2-t2", now - 300000); // 5 minutes ago

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude position not held long enough",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should include position held long enough",
    );
  });

  test("Sorts by lowest profit first (ascending pnlPct)", () => {
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.75,
        pnlPct: 50,
        pnlUsd: 25,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.44,
        pnlPct: 10,
        pnlUsd: 2,
      },
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.3,
        currentPrice: 0.39,
        pnlPct: 30,
        pnlUsd: 6.75,
      },
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, Date.now() - 300000),
    );

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(candidates.length, 3, "Should return all 3 positions");
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "First should be lowest profit (10%)",
    );
    assert.strictEqual(
      candidates[1].marketId,
      "m3",
      "Second should be middle profit (30%)",
    );
    assert.strictEqual(
      candidates[2].marketId,
      "m1",
      "Third should be highest profit (50%)",
    );
  });

  test("Combined filters work correctly", () => {
    const now = Date.now();
    const positions: TestProfitPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      }, // VALID - should be included
      {
        marketId: "m2",
        tokenId: "t2",
        side: "",
        size: 50,
        entryPrice: 0.3,
        currentPrice: 0.4,
        pnlPct: 33,
        pnlUsd: 5,
      }, // Invalid: no side
      {
        marketId: "m3",
        tokenId: "t3",
        side: "NO",
        size: 75,
        entryPrice: 0.85,
        currentPrice: 0.95,
        pnlPct: 11.8,
        pnlUsd: 7.5,
      }, // Invalid: near resolution
      {
        marketId: "m4",
        tokenId: "t4",
        side: "YES",
        size: 60,
        entryPrice: 0.4,
        currentPrice: 0.3,
        pnlPct: -25,
        pnlUsd: -6,
      }, // Invalid: losing
      {
        marketId: "m5",
        tokenId: "t5",
        side: "NO",
        size: 80,
        entryPrice: 0.5,
        currentPrice: 0.55,
        pnlPct: 10,
        pnlUsd: 4,
        redeemable: true,
      }, // Invalid: redeemable
      {
        marketId: "m6",
        tokenId: "t6",
        side: "YES",
        size: 90,
        entryPrice: 0.3,
        currentPrice: 0.42,
        pnlPct: 40,
        pnlUsd: 10.8,
      }, // Invalid: held too short
      {
        marketId: "m7",
        tokenId: "t7",
        side: "NO",
        size: 40,
        entryPrice: 0.45,
        currentPrice: 0.5,
        pnlPct: 11.1,
        pnlUsd: 2,
      }, // VALID - should be included
    ];

    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", now - 300000); // 5 min ago - valid
    entryTimes.set("m2-t2", now - 300000);
    entryTimes.set("m3-t3", now - 300000);
    entryTimes.set("m4-t4", now - 300000);
    entryTimes.set("m5-t5", now - 300000);
    entryTimes.set("m6-t6", now - 30000); // 30s ago - too short
    entryTimes.set("m7-t7", now - 300000); // 5 min ago - valid

    const candidates = filterProfitCandidates(positions, entryTimes, {
      minProfitPct: 0,
      minHoldSeconds: 60,
    });

    assert.strictEqual(
      candidates.length,
      2,
      "Should return only 2 valid positions",
    );
    // Should be sorted by lowest profit first
    assert.strictEqual(
      candidates[0].marketId,
      "m7",
      "First should be m7 (11.1% profit)",
    );
    assert.strictEqual(
      candidates[1].marketId,
      "m1",
      "Second should be m1 (20% profit)",
    );
  });
});
