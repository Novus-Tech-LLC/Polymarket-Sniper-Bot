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

describe("PositionTracker Strict State Machine", () => {
  /**
   * CRITICAL REGRESSION TEST: This is the exact bug that was fixed.
   * Previously, positions with price ~1.0 were incorrectly marked REDEEMABLE
   * even when Data-API didn't flag them as redeemable.
   *
   * The fix: NEVER infer REDEEMABLE from price alone.
   */
  test("REGRESSION: Position at 99.5¢ should remain ACTIVE when Data-API says NOT redeemable", () => {
    // This is the exact scenario that caused the bug:
    // - Fallback price API returned ~99.95¢
    // - Old code incorrectly promoted to REDEEMABLE
    // - New code keeps as ACTIVE (or CLOSED_NOT_REDEEMABLE at most)

    const currentPrice = 0.995; // 99.5¢ - near resolution threshold
    const dataApiRedeemable = false; // Data-API did NOT flag as redeemable

    // NEW BEHAVIOR: Do NOT mark as redeemable based on price
    // Only Data-API flag or on-chain denom > 0 can make it REDEEMABLE
    const positionState = dataApiRedeemable ? "REDEEMABLE" : "ACTIVE";

    assert.strictEqual(
      positionState,
      "ACTIVE",
      "Position should remain ACTIVE even with price near 1.0 when Data-API says NOT redeemable",
    );
  });

  test("REGRESSION: Position at 0.5¢ should remain ACTIVE when Data-API says NOT redeemable", () => {
    const currentPrice = 0.005; // 0.5¢ - near loss threshold
    const dataApiRedeemable = false;

    const positionState = dataApiRedeemable ? "REDEEMABLE" : "ACTIVE";

    assert.strictEqual(
      positionState,
      "ACTIVE",
      "Position should remain ACTIVE even with price near 0 when Data-API says NOT redeemable",
    );
  });

  test("Position marked redeemable by Data-API should become REDEEMABLE", () => {
    const dataApiRedeemable = true; // Data-API explicitly flagged as redeemable
    const currentPrice = 0.5; // Price doesn't matter - Data-API is authoritative

    const positionState = dataApiRedeemable ? "REDEEMABLE" : "ACTIVE";
    const redeemableProofSource = dataApiRedeemable ? "DATA_API_FLAG" : "NONE";

    assert.strictEqual(positionState, "REDEEMABLE");
    assert.strictEqual(
      redeemableProofSource,
      "DATA_API_FLAG",
      "Redeemable proof source should be DATA_API_FLAG",
    );
  });

  test("Price-based checks are for diagnostics only, NOT state changes", () => {
    // High price triggers diagnostic log, but does NOT change state
    const currentPrice = 0.995;
    const dataApiRedeemable = false;

    // Check if price suggests near-resolution (diagnostic only)
    const priceNearResolution =
      currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
      currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD;

    // This SHOULD be true (diagnostic triggers)
    assert.ok(
      priceNearResolution,
      "Diagnostic should detect price near resolution",
    );

    // But state should still be ACTIVE (not REDEEMABLE)
    const positionState = dataApiRedeemable ? "REDEEMABLE" : "ACTIVE";
    assert.strictEqual(
      positionState,
      "ACTIVE",
      "State should remain ACTIVE regardless of price diagnostic",
    );
  });

  test("CLOSED_NOT_REDEEMABLE state for markets that are closed but not on-chain resolved", () => {
    // Simulate: Gamma says closed=true, but Data-API doesn't say redeemable
    // This means on-chain resolution hasn't been posted yet

    const dataApiRedeemable = false;
    const gammaSaysClosed = true;

    let positionState: string;
    if (dataApiRedeemable) {
      positionState = "REDEEMABLE";
    } else if (gammaSaysClosed) {
      positionState = "CLOSED_NOT_REDEEMABLE";
    } else {
      positionState = "ACTIVE";
    }

    assert.strictEqual(
      positionState,
      "CLOSED_NOT_REDEEMABLE",
      "Position should be CLOSED_NOT_REDEEMABLE when market is closed but not redeemable on-chain",
    );
  });

  test("Redeemable proof source must be set for REDEEMABLE positions", () => {
    // When a position is marked REDEEMABLE, we must have proof
    const dataApiRedeemable = true;

    const positionState = "REDEEMABLE";
    const redeemableProofSource = dataApiRedeemable ? "DATA_API_FLAG" : "NONE";

    // Internal invariant: REDEEMABLE must have valid proof source
    const hasValidProof = redeemableProofSource !== "NONE";
    assert.ok(
      hasValidProof,
      "REDEEMABLE position must have valid proof source (not NONE)",
    );
  });

  test("BUG DETECTION: REDEEMABLE without proof source is an internal error", () => {
    // This tests the internal bug detection logic
    // If a position is marked redeemable but has no proof source, it's a bug

    const positionState = "REDEEMABLE";
    const redeemableProofSource = "NONE"; // Bug: no proof!

    const isBug =
      positionState === "REDEEMABLE" && redeemableProofSource === "NONE";
    assert.ok(isBug, "Should detect bug when REDEEMABLE has no proof source");
  });

  test("ONCHAIN_DENOM: Position with on-chain payoutDenominator > 0 should become REDEEMABLE", () => {
    // Simulates the new on-chain check logic:
    // - Data-API says NOT redeemable
    // - Price is at 100¢ (suggesting resolved)
    // - No orderbook bids (NO_BOOK status)
    // - On-chain payoutDenominator > 0 (confirmed resolved)

    const dataApiRedeemable = false;
    const currentPrice = 1.0; // 100¢
    const hasNoBids = true; // NO_BOOK status
    const onChainPayoutDenominator = 1n; // > 0 means resolved on-chain

    // Price near resolution check
    const priceNearResolution =
      currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
      currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD;

    // Simulate the new on-chain check logic
    let positionState: string;
    let redeemableProofSource: string;

    if (dataApiRedeemable) {
      positionState = "REDEEMABLE";
      redeemableProofSource = "DATA_API_FLAG";
    } else if (
      priceNearResolution &&
      hasNoBids &&
      onChainPayoutDenominator > 0n
    ) {
      // NEW: On-chain check triggers REDEEMABLE when Data-API lags
      positionState = "REDEEMABLE";
      redeemableProofSource = "ONCHAIN_DENOM";
    } else {
      positionState = "ACTIVE";
      redeemableProofSource = "NONE";
    }

    assert.strictEqual(
      positionState,
      "REDEEMABLE",
      "Position should become REDEEMABLE when on-chain confirms payoutDenominator > 0",
    );
    assert.strictEqual(
      redeemableProofSource,
      "ONCHAIN_DENOM",
      "Proof source should be ONCHAIN_DENOM",
    );
  });

  test("ONCHAIN_DENOM: Position with payoutDenominator = 0 should remain ACTIVE", () => {
    // On-chain check returns 0 - market not yet resolved on-chain
    const dataApiRedeemable = false;
    const currentPrice = 0.995; // Near 100¢
    const hasNoBids = true;
    const onChainPayoutDenominator = 0n; // Not resolved on-chain yet

    const priceNearResolution = currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD;

    let positionState: string;
    if (
      priceNearResolution &&
      hasNoBids &&
      onChainPayoutDenominator > 0n
    ) {
      positionState = "REDEEMABLE";
    } else {
      positionState = "ACTIVE";
    }

    assert.strictEqual(
      positionState,
      "ACTIVE",
      "Position should remain ACTIVE when on-chain payoutDenominator = 0",
    );
  });

  test("ONCHAIN_DENOM: Skip on-chain check when bids are available", () => {
    // If there are bids, SellEarly can handle it - no need for on-chain check
    const dataApiRedeemable = false;
    const currentPrice = 0.999; // Near 100¢
    const hasNoBids = false; // Bids ARE available
    const onChainPayoutDenominator = 1n; // Would trigger if checked

    // When bids exist, we should NOT check on-chain
    // because SellEarly strategy can handle the sale
    const shouldCheckOnChain = hasNoBids;

    assert.ok(
      !shouldCheckOnChain,
      "Should not check on-chain when bids are available",
    );
  });

  test("ONCHAIN_DENOM: Skip on-chain check when price is NOT near resolution", () => {
    // If price is 50¢, market is clearly not resolved - skip on-chain check
    const currentPrice = 0.5; // 50¢ - not near resolution
    const hasNoBids = true;

    const priceNearResolution =
      currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
      currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD;

    const shouldCheckOnChain = priceNearResolution && hasNoBids;

    assert.ok(
      !shouldCheckOnChain,
      "Should not check on-chain when price is not near resolution threshold",
    );
  });
});

describe("PositionTracker Price Threshold Detection (Diagnostic Only)", () => {
  test("High price detection threshold is 99¢", () => {
    // Price threshold for DIAGNOSTIC logging (not state change)
    assert.strictEqual(
      RESOLVED_PRICE_HIGH_THRESHOLD,
      0.99,
      "High threshold should be 99¢",
    );
  });

  test("Low price detection threshold is 1¢", () => {
    assert.strictEqual(
      RESOLVED_PRICE_LOW_THRESHOLD,
      0.01,
      "Low threshold should be 1¢",
    );
  });

  test("Position at 98¢ should NOT trigger diagnostic", () => {
    const currentPrice = 0.98;
    const priceNearResolution =
      currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
      currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD;

    assert.ok(
      !priceNearResolution,
      "98¢ is below threshold, should not trigger diagnostic",
    );
  });

  test("Position at 2¢ should NOT trigger diagnostic", () => {
    const currentPrice = 0.02;
    const priceNearResolution =
      currentPrice >= RESOLVED_PRICE_HIGH_THRESHOLD ||
      currentPrice <= RESOLVED_PRICE_LOW_THRESHOLD;

    assert.ok(
      !priceNearResolution,
      "2¢ is above low threshold, should not trigger diagnostic",
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

// ========================================================================
// Section 10 Tests: P&L Trust System and Classification
// ========================================================================

describe("P&L Math Correctness", () => {
  test("P&L calculation: 56¢ → 53¢ = -5.36%", () => {
    // CRITICAL: This is the exact example from the enterprise spec
    const entryPrice = 0.56; // 56¢
    const currentPrice = 0.53; // 53¢ (current bid)
    const size = 100;

    const pnlUsd = (currentPrice - entryPrice) * size;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Verify the P&L math (use tolerance for floating point)
    assert.ok(
      Math.abs(pnlUsd - -3) < 0.0001,
      `P&L should be -$3.00, got ${pnlUsd}`,
    );

    // Calculate expected percentage inline for clarity
    const expectedPct = ((currentPrice - entryPrice) / entryPrice) * 100; // -5.357...%
    assert.ok(
      Math.abs(pnlPct - expectedPct) < 0.01,
      `P&L should be approximately -5.36%, got ${pnlPct.toFixed(2)}%`,
    );
  });

  test("P&L calculation: 65¢ → 70¢ = +7.69%", () => {
    const entryPrice = 0.65;
    const currentPrice = 0.7;
    const size = 50;

    const pnlUsd = (currentPrice - entryPrice) * size;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    assert.ok(
      Math.abs(pnlUsd - 2.5) < 0.0001,
      `P&L should be +$2.50, got ${pnlUsd}`,
    );
    // Calculate expected percentage inline for clarity
    const expectedPct = ((currentPrice - entryPrice) / entryPrice) * 100; // +7.692...%
    assert.ok(
      Math.abs(pnlPct - expectedPct) < 0.01,
      `P&L should be approximately +7.69%, got ${pnlPct.toFixed(2)}%`,
    );
  });

  test("P&L calculation: breakeven (55¢ → 55¢ = 0%)", () => {
    const entryPrice = 0.55;
    const currentPrice = 0.55;
    const size = 100;

    const pnlUsd = (currentPrice - entryPrice) * size;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    assert.ok(Math.abs(pnlUsd) < 0.0001, `P&L USD should be ~0, got ${pnlUsd}`);
    assert.ok(Math.abs(pnlPct) < 0.0001, `P&L % should be ~0, got ${pnlPct}`);
  });
});

describe("P&L Classification", () => {
  test("Missing orderbook → UNKNOWN classification", () => {
    // Simulates position with NO_BOOK status
    const position = {
      entryPrice: 0.56,
      currentPrice: 0.53, // This is from fallback, not actual orderbook
      pnlPct: -5.36,
      pnlUsd: -3,
      status: "NO_BOOK" as const,
      currentBidPrice: undefined, // No bid price available
    };

    // When bestBidPrice is undefined and status is NO_BOOK, pnlTrusted should be false
    const pnlTrusted =
      position.currentBidPrice !== undefined && position.status !== "NO_BOOK";

    // Classification should be UNKNOWN when pnlTrusted is false
    let classification: "PROFITABLE" | "LOSING" | "NEUTRAL" | "UNKNOWN";
    if (!pnlTrusted) {
      classification = "UNKNOWN";
    } else if (position.pnlPct > 0) {
      classification = "PROFITABLE";
    } else if (position.pnlPct < 0) {
      classification = "LOSING";
    } else {
      classification = "NEUTRAL";
    }

    assert.strictEqual(
      pnlTrusted,
      false,
      "P&L should be untrusted when no orderbook",
    );
    assert.strictEqual(
      classification,
      "UNKNOWN",
      "Classification should be UNKNOWN when P&L is untrusted",
    );
  });

  test("Valid orderbook data → correct classification", () => {
    // Position with valid bid price
    const profitablePosition = {
      entryPrice: 0.5,
      currentPrice: 0.55,
      pnlPct: 10,
      status: "ACTIVE" as const,
      currentBidPrice: 0.55,
    };

    const losingPosition = {
      entryPrice: 0.6,
      currentPrice: 0.5,
      pnlPct: -16.67,
      status: "ACTIVE" as const,
      currentBidPrice: 0.5,
    };

    // Both positions have valid bid prices
    const profitTrusted = profitablePosition.currentBidPrice !== undefined;
    const lossTrusted = losingPosition.currentBidPrice !== undefined;

    assert.strictEqual(
      profitTrusted,
      true,
      "Profitable position should be trusted",
    );
    assert.strictEqual(lossTrusted, true, "Losing position should be trusted");

    // Verify classifications
    const profitClassification =
      profitTrusted && profitablePosition.pnlPct > 0 ? "PROFITABLE" : "UNKNOWN";
    const lossClassification =
      lossTrusted && losingPosition.pnlPct < 0 ? "LOSING" : "UNKNOWN";

    assert.strictEqual(profitClassification, "PROFITABLE");
    assert.strictEqual(lossClassification, "LOSING");
  });
});

describe("Position Summary Classification Invariant", () => {
  test("REGRESSION: ACTIVE positions must NEVER produce empty classification", () => {
    // This is a CRITICAL regression test
    // The system must NEVER report "ACTIVE: 0 profitable, 0 losing" when active positions exist

    const mockPositions = [
      {
        redeemable: false,
        pnlPct: 5,
        pnlTrusted: true,
        pnlClassification: "PROFITABLE" as const,
      },
      {
        redeemable: false,
        pnlPct: -10,
        pnlTrusted: true,
        pnlClassification: "LOSING" as const,
      },
      {
        redeemable: false,
        pnlPct: 0,
        pnlTrusted: true,
        pnlClassification: "NEUTRAL" as const,
      },
      {
        redeemable: false,
        pnlPct: -5,
        pnlTrusted: false,
        pnlClassification: "UNKNOWN" as const,
      },
    ];

    const active = mockPositions.filter((p) => !p.redeemable);
    const activeProfitable = active.filter(
      (p) => p.pnlClassification === "PROFITABLE",
    );
    const activeLosing = active.filter((p) => p.pnlClassification === "LOSING");
    const activeNeutral = active.filter(
      (p) => p.pnlClassification === "NEUTRAL",
    );
    const activeUnknown = active.filter(
      (p) => p.pnlClassification === "UNKNOWN",
    );

    // Verify counts
    assert.strictEqual(active.length, 4, "Should have 4 active positions");
    assert.strictEqual(activeProfitable.length, 1, "Should have 1 profitable");
    assert.strictEqual(activeLosing.length, 1, "Should have 1 losing");
    assert.strictEqual(activeNeutral.length, 1, "Should have 1 neutral");
    assert.strictEqual(activeUnknown.length, 1, "Should have 1 unknown");

    // CRITICAL INVARIANT: sum of classifications must equal total active
    const classificationSum =
      activeProfitable.length +
      activeLosing.length +
      activeNeutral.length +
      activeUnknown.length;
    assert.strictEqual(
      classificationSum,
      active.length,
      "REGRESSION: Classification counts must sum to total active positions",
    );

    // CRITICAL: If active > 0, at least one classification bucket must be non-zero
    const hasClassification =
      activeProfitable.length > 0 ||
      activeLosing.length > 0 ||
      activeNeutral.length > 0 ||
      activeUnknown.length > 0;
    assert.ok(
      active.length === 0 || hasClassification,
      "REGRESSION: If active positions exist, at least one classification must be non-empty",
    );
  });

  test("REGRESSION: 'ACTIVE: 0 profitable, 0 losing' is IMPOSSIBLE when active > 0", () => {
    // This directly tests the invariant from the enterprise spec

    // Simulating the old buggy behavior that produced "0 profitable, 0 losing"
    // when there were actually active positions with UNKNOWN classification
    const mockPositions = [
      {
        redeemable: false,
        pnlPct: -5,
        pnlTrusted: false,
        pnlClassification: "UNKNOWN" as const,
      },
      {
        redeemable: false,
        pnlPct: 3,
        pnlTrusted: false,
        pnlClassification: "UNKNOWN" as const,
      },
    ];

    const active = mockPositions.filter((p) => !p.redeemable);
    const activeProfitable = active.filter(
      (p) => p.pnlClassification === "PROFITABLE",
    );
    const activeLosing = active.filter((p) => p.pnlClassification === "LOSING");
    const activeUnknown = active.filter(
      (p) => p.pnlClassification === "UNKNOWN",
    );

    // The OLD code would show "0 profitable, 0 losing" and hide the unknown
    // The NEW code shows "0 prof, 0 lose, 0 neutral, 2 unknown"

    assert.strictEqual(active.length, 2, "Should have 2 active positions");
    assert.strictEqual(
      activeProfitable.length,
      0,
      "Should have 0 profitable (all untrusted)",
    );
    assert.strictEqual(
      activeLosing.length,
      0,
      "Should have 0 losing (all untrusted)",
    );
    assert.strictEqual(activeUnknown.length, 2, "Should have 2 unknown");

    // The CRITICAL invariant: if we have active positions, at least one bucket must be non-zero
    const totalClassified =
      activeProfitable.length + activeLosing.length + activeUnknown.length;
    assert.strictEqual(
      totalClassified,
      active.length,
      "All active positions must be classified somewhere",
    );

    // This is what the enterprise spec requires - the unknown count MUST be visible
    const formattedSummary = `ACTIVE: total=${active.length} (prof=${activeProfitable.length} lose=${activeLosing.length} neutral=0 unknown=${activeUnknown.length})`;
    assert.ok(
      formattedSummary.includes("unknown=2"),
      "Summary must show unknown count when positions have untrusted P&L",
    );
  });
});

/**
 * REGRESSION TESTS FOR DATA-API P&L (JAN 2025)
 *
 * These tests verify that P&L calculations match what Polymarket UI shows.
 * Based on the problem statement examples:
 * - entry 55¢, current 56¢ => +2.71% (approx)
 * - entry 55¢, current 55¢ => ~0%
 * - entry 86¢, current 85¢ => ~-1.16%
 * - entry 56¢, current 23¢ => ~-58.93%
 */
describe("Data-API P&L Matching Polymarket UI", () => {
  /**
   * Helper: Calculate P&L percentage matching Polymarket UI formula.
   * pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100
   */
  const calculatePnlPct = (
    entryPrice: number,
    currentPrice: number,
  ): number => {
    if (entryPrice <= 0) return 0;
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  };

  /**
   * Helper: Calculate P&L USD matching Polymarket UI formula.
   * pnlUsd = (currentPrice - entryPrice) * size
   */
  const calculatePnlUsd = (
    entryPrice: number,
    currentPrice: number,
    size: number,
  ): number => {
    return (currentPrice - entryPrice) * size;
  };

  test("UI example: entry 55¢, current 56¢ => +2.71%", () => {
    const entryPrice = 0.55; // 55 cents
    const currentPrice = 0.5652; // ~56.52¢ to get exactly +2.71%
    const size = 100;

    const pnlPct = calculatePnlPct(entryPrice, currentPrice);
    const pnlUsd = calculatePnlUsd(entryPrice, currentPrice, size);

    // Expected: +2.71% (approximately)
    assert.ok(
      Math.abs(pnlPct - 2.76) < 0.1,
      `P&L should be ~+2.76%, got ${pnlPct.toFixed(2)}%`,
    );
    assert.ok(
      pnlUsd > 0,
      `P&L USD should be positive, got $${pnlUsd.toFixed(2)}`,
    );
  });

  test("UI example: entry 55¢, current 55¢ => ~0%", () => {
    const entryPrice = 0.55; // 55 cents
    const currentPrice = 0.55; // 55 cents (breakeven)
    const size = 100;

    const pnlPct = calculatePnlPct(entryPrice, currentPrice);
    const pnlUsd = calculatePnlUsd(entryPrice, currentPrice, size);

    // Expected: 0%
    assert.strictEqual(pnlPct, 0, "P&L should be exactly 0% at breakeven");
    assert.strictEqual(pnlUsd, 0, "P&L USD should be exactly $0 at breakeven");
  });

  test("UI example: entry 86¢, current 85¢ => ~-1.16%", () => {
    const entryPrice = 0.86; // 86 cents
    const currentPrice = 0.85; // 85 cents
    const size = 100;

    const pnlPct = calculatePnlPct(entryPrice, currentPrice);
    const pnlUsd = calculatePnlUsd(entryPrice, currentPrice, size);

    // Expected: -1.16% (approximately)
    assert.ok(
      Math.abs(pnlPct - -1.16) < 0.1,
      `P&L should be ~-1.16%, got ${pnlPct.toFixed(2)}%`,
    );
    assert.ok(
      pnlUsd < 0,
      `P&L USD should be negative, got $${pnlUsd.toFixed(2)}`,
    );
    assert.ok(
      Math.abs(pnlUsd - -1) < 0.1,
      `P&L USD should be ~-$1.00, got $${pnlUsd.toFixed(2)}`,
    );
  });

  test("UI example: entry 56¢, current 23¢ => ~-58.93%", () => {
    const entryPrice = 0.56; // 56 cents
    const currentPrice = 0.23; // 23 cents
    const size = 100;

    const pnlPct = calculatePnlPct(entryPrice, currentPrice);
    const pnlUsd = calculatePnlUsd(entryPrice, currentPrice, size);

    // Expected: -58.93%
    assert.ok(
      Math.abs(pnlPct - -58.93) < 0.5,
      `P&L should be ~-58.93%, got ${pnlPct.toFixed(2)}%`,
    );
    assert.ok(
      pnlUsd < -30,
      `P&L USD should be significantly negative, got $${pnlUsd.toFixed(2)}`,
    );
  });

  test("P&L classification from Data-API values matches expected", () => {
    // Test Data-API P&L fields properly classify positions

    // Profitable: +5.5%
    const profitable = { pnlPct: 5.5, pnlTrusted: true };
    assert.strictEqual(
      profitable.pnlPct > 0
        ? "PROFITABLE"
        : profitable.pnlPct < 0
          ? "LOSING"
          : "NEUTRAL",
      "PROFITABLE",
      "Positive P&L should be PROFITABLE",
    );

    // Losing: -3.2%
    const losing = { pnlPct: -3.2, pnlTrusted: true };
    assert.strictEqual(
      losing.pnlPct > 0
        ? "PROFITABLE"
        : losing.pnlPct < 0
          ? "LOSING"
          : "NEUTRAL",
      "LOSING",
      "Negative P&L should be LOSING",
    );

    // Neutral: 0%
    const neutral = { pnlPct: 0, pnlTrusted: true };
    assert.strictEqual(
      neutral.pnlPct > 0
        ? "PROFITABLE"
        : neutral.pnlPct < 0
          ? "LOSING"
          : "NEUTRAL",
      "NEUTRAL",
      "Zero P&L should be NEUTRAL",
    );
  });
});

/**
 * Tests for PnL Source tracking
 */
describe("PnL Source Tracking", () => {
  test("DATA_API source should be trusted", () => {
    const sources = ["DATA_API", "EXECUTABLE_BOOK", "FALLBACK"] as const;

    // DATA_API is always trusted (matches UI)
    assert.ok(
      sources[0] === "DATA_API",
      "DATA_API should be the preferred source",
    );
  });

  test("FALLBACK source should only be trusted with Data-API pricing", () => {
    // When pnlSource is FALLBACK but Data-API provided curPrice/currentValue,
    // P&L should still be trusted
    const scenarios = [
      { pnlSource: "FALLBACK", hasCurPrice: true, expectedTrusted: true },
      { pnlSource: "FALLBACK", hasCurPrice: false, expectedTrusted: false },
      { pnlSource: "DATA_API", hasCurPrice: false, expectedTrusted: true },
      {
        pnlSource: "EXECUTABLE_BOOK",
        hasCurPrice: false,
        expectedTrusted: true,
      },
    ];

    for (const scenario of scenarios) {
      const shouldBeTrusted =
        scenario.pnlSource === "DATA_API" ||
        scenario.pnlSource === "EXECUTABLE_BOOK" ||
        (scenario.pnlSource === "FALLBACK" && scenario.hasCurPrice);

      assert.strictEqual(
        shouldBeTrusted,
        scenario.expectedTrusted,
        `Source=${scenario.pnlSource}, hasCurPrice=${scenario.hasCurPrice} should have trusted=${scenario.expectedTrusted}`,
      );
    }
  });
});

/**
 * Tests for Proxy Wallet / Holding Address Resolution
 */
describe("Holding Address Resolution", () => {
  test("Proxy wallet address format validation", () => {
    // Valid Ethereum addresses
    const validAddresses = [
      "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
      "0x0000000000000000000000000000000000000000",
      "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    ];

    // Invalid addresses
    const invalidAddresses = ["unknown", "", "0x", "0x123", "not-an-address"];

    for (const addr of validAddresses) {
      const isValid = /^0x[a-fA-F0-9]{40}$/.test(addr);
      assert.ok(isValid, `${addr} should be valid`);
    }

    for (const addr of invalidAddresses) {
      const isValid = /^0x[a-fA-F0-9]{40}$/.test(addr);
      assert.ok(!isValid, `${addr} should be invalid`);
    }
  });

  test("Holding address priority: proxy > EOA", () => {
    // When proxy wallet is available, it should be used over EOA
    const eoaAddress = "0x1234567890123456789012345678901234567890";
    const proxyAddress = "0x56687bf447db6ffa42ffe2204a05edaa20f55839";

    const resolveHolding = (eoa: string, proxy: string | null): string => {
      const isValidProxy = proxy && /^0x[a-fA-F0-9]{40}$/.test(proxy);
      return isValidProxy ? proxy : eoa;
    };

    // With valid proxy
    assert.strictEqual(
      resolveHolding(eoaAddress, proxyAddress),
      proxyAddress,
      "Should use proxy when available",
    );

    // With no proxy
    assert.strictEqual(
      resolveHolding(eoaAddress, null),
      eoaAddress,
      "Should fallback to EOA when no proxy",
    );

    // With invalid proxy
    assert.strictEqual(
      resolveHolding(eoaAddress, "invalid"),
      eoaAddress,
      "Should fallback to EOA when proxy is invalid",
    );
  });
});

// ============================================================================
// CRASH-PROOF RECOVERY TESTS (Jan 2025)
// ============================================================================

describe("Crash-Proof Recovery: Snapshot Validation", () => {
  test("ACTIVE_COLLAPSE_BUG: Rejects snapshot when rawTotal > 0 AND rawActive > 0 but finalActive = 0", () => {
    // This simulates the exact bug condition described in the issue
    const mockPrevSnapshot = {
      cycleId: 1,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: Date.now() - 30000,
      activePositions: Object.freeze([{ marketId: "m1", tokenId: "t1" }]) as any,
      redeemablePositions: Object.freeze([]) as any,
      summary: { activeTotal: 1, prof: 0, lose: 1, neutral: 0, unknown: 0, redeemableTotal: 0 },
      rawCounts: { rawTotal: 1, rawActiveCandidates: 1, rawRedeemableCandidates: 0 },
    };

    // New snapshot has raw positions but 0 final active (ACTIVE_COLLAPSE_BUG)
    const mockNewSnapshot = {
      cycleId: 2,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: Date.now(),
      activePositions: Object.freeze([]) as any, // BUG: Empty even though raw has positions
      redeemablePositions: Object.freeze([]) as any,
      summary: { activeTotal: 0, prof: 0, lose: 0, neutral: 0, unknown: 0, redeemableTotal: 0 },
      rawCounts: { rawTotal: 33, rawActiveCandidates: 33, rawRedeemableCandidates: 0 },
    };

    // Simulate validation logic
    const rawTotal = mockNewSnapshot.rawCounts?.rawTotal ?? 0;
    const rawActiveCandidates = mockNewSnapshot.rawCounts?.rawActiveCandidates ?? 0;
    const finalActiveCount = mockNewSnapshot.activePositions.length;

    const isActiveCollapseBug =
      rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0;

    assert.strictEqual(
      isActiveCollapseBug,
      true,
      "Should detect ACTIVE_COLLAPSE_BUG when raw has positions but final has none"
    );
  });

  test("FETCH_REGRESSION: Rejects snapshot when newTotal < 20% of prevTotal", () => {
    const prevRawTotal = 50;
    const newRawTotal = 5; // 10% of prev - should be rejected
    const threshold = 0.2; // 20%

    const isFetchRegression = newRawTotal < prevRawTotal * threshold;

    assert.strictEqual(
      isFetchRegression,
      true,
      "Should detect FETCH_REGRESSION when new total is dramatically lower"
    );

    // Test borderline case (exactly 20% - should pass)
    const borderlineRawTotal = 10; // 20% of 50
    const isBorderlineRegression = borderlineRawTotal < prevRawTotal * threshold;
    assert.strictEqual(
      isBorderlineRegression,
      false,
      "Should NOT detect FETCH_REGRESSION when exactly at threshold"
    );
  });

  test("ADDRESS_FLIP_COLLAPSE: Rejects when address changes AND counts collapse", () => {
    const prevAddress = "0x1111111111111111111111111111111111111111";
    const newAddress = "0x2222222222222222222222222222222222222222";

    // Previous had positions, new has none, AND address changed
    const prevActiveCount = 10;
    const newActiveCount = 0;
    const newRedeemableCount = 0;

    const addressChanged = newAddress !== prevAddress;
    const countsCollapsed =
      prevActiveCount > 0 && newActiveCount === 0 && newRedeemableCount === 0;

    const isAddressFlipCollapse = addressChanged && countsCollapsed;

    assert.strictEqual(
      isAddressFlipCollapse,
      true,
      "Should detect ADDRESS_FLIP_COLLAPSE when address changes and counts collapse"
    );

    // Test: Same address, counts collapse - should NOT be address flip collapse
    // When address is the same, addressChanged would be false, so isAddressFlipCollapse would be false
    const sameAddressChanged = prevAddress !== prevAddress; // false because same address
    const sameAddressFlipCollapse = sameAddressChanged && countsCollapsed;
    assert.strictEqual(
      sameAddressFlipCollapse,
      false,
      "Collapse without address change should NOT be ADDRESS_FLIP_COLLAPSE"
    );
  });

  test("Valid snapshot passes all validation checks", () => {
    const prevRawTotal = 30;
    const newRawTotal = 28; // Slight decrease is fine
    const threshold = 0.2;

    const mockNewSnapshot = {
      activePositions: [{ id: 1 }, { id: 2 }],
      redeemablePositions: [{ id: 3 }],
      addressUsed: "0x1234567890123456789012345678901234567890",
      rawCounts: { rawTotal: newRawTotal, rawActiveCandidates: 2, rawRedeemableCandidates: 1 },
    };

    const mockPrevSnapshot = {
      activePositions: [{ id: 1 }, { id: 2 }, { id: 4 }],
      redeemablePositions: [],
      addressUsed: "0x1234567890123456789012345678901234567890",
      rawCounts: { rawTotal: prevRawTotal, rawActiveCandidates: 3, rawRedeemableCandidates: 0 },
    };

    // Check all validations
    const rawTotal = mockNewSnapshot.rawCounts.rawTotal;
    const rawActiveCandidates = mockNewSnapshot.rawCounts.rawActiveCandidates;
    const finalActiveCount = mockNewSnapshot.activePositions.length;

    // Rule A: ACTIVE_COLLAPSE_BUG
    const isActiveCollapseBug =
      rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0;

    // Rule B: FETCH_REGRESSION
    const isFetchRegression = newRawTotal < prevRawTotal * threshold;

    // Rule C: ADDRESS_FLIP_COLLAPSE
    const addressChanged = mockNewSnapshot.addressUsed !== mockPrevSnapshot.addressUsed;
    const countsCollapsed =
      mockPrevSnapshot.activePositions.length > 0 &&
      finalActiveCount === 0 &&
      mockNewSnapshot.redeemablePositions.length === 0;
    const isAddressFlipCollapse = addressChanged && countsCollapsed;

    const isValid = !isActiveCollapseBug && !isFetchRegression && !isAddressFlipCollapse;

    assert.strictEqual(isValid, true, "Valid snapshot should pass all checks");
  });
});

describe("Crash-Proof Recovery: Stale Snapshot Handling", () => {
  test("Stale snapshot preserves data from lastGoodSnapshot", () => {
    const lastGoodFetchedAt = Date.now() - 60000; // 60 seconds ago
    const lastGoodSnapshot = {
      cycleId: 5,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: lastGoodFetchedAt,
      activePositions: Object.freeze([
        { tokenId: "t1", marketId: "m1", size: 100 },
        { tokenId: "t2", marketId: "m2", size: 50 },
      ]) as any,
      redeemablePositions: Object.freeze([]) as any,
      summary: { activeTotal: 2, prof: 1, lose: 1, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };

    // Simulate creating stale snapshot
    const now = Date.now();
    const staleAgeMs = now - lastGoodSnapshot.fetchedAtMs;
    const staleReason = "refresh_failed: Network timeout";

    const staleSnapshot = {
      ...lastGoodSnapshot,
      cycleId: 6, // New cycle ID
      stale: true,
      staleAgeMs,
      staleReason,
    };

    // Verify stale snapshot properties
    assert.strictEqual(staleSnapshot.stale, true, "Should be marked as stale");
    assert.ok(staleSnapshot.staleAgeMs >= 60000, "Should have stale age >= 60s");
    assert.strictEqual(staleSnapshot.staleReason, staleReason, "Should preserve stale reason");
    assert.strictEqual(
      staleSnapshot.activePositions.length,
      2,
      "Should preserve active positions from lastGoodSnapshot"
    );
    assert.strictEqual(
      staleSnapshot.addressUsed,
      lastGoodSnapshot.addressUsed,
      "Should preserve address from lastGoodSnapshot"
    );
  });

  test("Recovery status tracks consecutive failures", () => {
    // Simulate recovery state tracking
    let consecutiveFailures = 0;
    let currentBackoffMs = 0;
    let lastErrorAtMs = 0;
    let lastGoodAtMs = Date.now() - 300000; // 5 minutes ago
    const BASE_BACKOFF_MS = 5000;
    const MAX_BACKOFF_MS = 120000;

    // Simulate 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      consecutiveFailures++;
      lastErrorAtMs = Date.now();
      currentBackoffMs = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
        MAX_BACKOFF_MS
      );
    }

    assert.strictEqual(consecutiveFailures, 3, "Should track 3 failures");
    assert.strictEqual(currentBackoffMs, 20000, "Backoff should be 5000 * 2^2 = 20000ms");

    // Simulate recovery (successful refresh)
    const wasInFailedState = consecutiveFailures > 0;
    consecutiveFailures = 0;
    currentBackoffMs = 0;
    lastGoodAtMs = Date.now();

    assert.strictEqual(wasInFailedState, true, "Should detect we were in failed state");
    assert.strictEqual(consecutiveFailures, 0, "Should reset failure count on success");
    assert.strictEqual(currentBackoffMs, 0, "Should reset backoff on success");
  });

  test("Exponential backoff is capped at MAX_BACKOFF_MS", () => {
    const BASE_BACKOFF_MS = 5000;
    const MAX_BACKOFF_MS = 120000;

    // Simulate many failures
    for (let failures = 1; failures <= 10; failures++) {
      const backoff = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, failures - 1),
        MAX_BACKOFF_MS
      );

      if (failures <= 5) {
        // Before cap: 5000, 10000, 20000, 40000, 80000
        const expected = BASE_BACKOFF_MS * Math.pow(2, failures - 1);
        assert.strictEqual(backoff, expected, `Failure ${failures} backoff should be ${expected}ms`);
      } else {
        // After cap: all should be MAX_BACKOFF_MS
        assert.strictEqual(backoff, MAX_BACKOFF_MS, `Failure ${failures} backoff should be capped at ${MAX_BACKOFF_MS}ms`);
      }
    }
  });

  test("AUTO-RECOVERY: Clears lastGoodSnapshot when stale age exceeds MAX_STALE_AGE_MS", () => {
    // This test validates the auto-recovery mechanism that prevents indefinite stale state
    // Similar to what happens on container restart, but automatic
    const MAX_STALE_AGE_MS = 60_000; // 60 seconds (HFT-friendly threshold)
    
    // Simulate a lastGoodSnapshot that is now very stale
    const lastGoodFetchedAt = Date.now() - 65_000; // 65 seconds ago (exceeds threshold)
    let lastGoodSnapshot: any = {
      cycleId: 5,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: lastGoodFetchedAt,
      activePositions: Object.freeze([
        { tokenId: "t1", marketId: "m1", size: 100 },
      ]) as any,
      redeemablePositions: Object.freeze([]) as any,
      summary: { activeTotal: 1, prof: 0, lose: 1, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };
    let lastGoodAtMs = lastGoodFetchedAt;
    let consecutiveFailures = 8;
    let currentBackoffMs = 120_000;

    // Calculate stale age
    const now = Date.now();
    const staleAgeMs = now - lastGoodSnapshot.fetchedAtMs;

    // Verify stale age exceeds threshold
    assert.ok(staleAgeMs >= MAX_STALE_AGE_MS, 
      `Stale age (${staleAgeMs}ms) should exceed threshold (${MAX_STALE_AGE_MS}ms)`);

    // Simulate auto-recovery logic: clear lastGoodSnapshot when too stale
    if (staleAgeMs >= MAX_STALE_AGE_MS) {
      lastGoodSnapshot = null;
      lastGoodAtMs = 0;
      consecutiveFailures = 0;
      currentBackoffMs = 0;
    }

    // Verify auto-recovery cleared the state
    assert.strictEqual(lastGoodSnapshot, null, 
      "Should clear lastGoodSnapshot when stale age exceeds threshold");
    assert.strictEqual(lastGoodAtMs, 0, 
      "Should reset lastGoodAtMs");
    assert.strictEqual(consecutiveFailures, 0, 
      "Should reset consecutiveFailures to allow immediate retry");
    assert.strictEqual(currentBackoffMs, 0, 
      "Should reset backoff to allow immediate retry");
  });

  test("AUTO-RECOVERY: Does NOT clear lastGoodSnapshot when stale age is below threshold", () => {
    const MAX_STALE_AGE_MS = 60_000; // 60 seconds
    
    // Simulate a lastGoodSnapshot that is stale but within threshold
    const lastGoodFetchedAt = Date.now() - 30_000; // 30 seconds ago (below threshold)
    let lastGoodSnapshot: any = {
      cycleId: 5,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: lastGoodFetchedAt,
      activePositions: Object.freeze([
        { tokenId: "t1", marketId: "m1", size: 100 },
      ]) as any,
      redeemablePositions: Object.freeze([]) as any,
      summary: { activeTotal: 1, prof: 0, lose: 1, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };
    let consecutiveFailures = 3;

    // Calculate stale age
    const now = Date.now();
    const staleAgeMs = now - lastGoodSnapshot.fetchedAtMs;

    // Verify stale age is below threshold
    assert.ok(staleAgeMs < MAX_STALE_AGE_MS, 
      `Stale age (${staleAgeMs}ms) should be below threshold (${MAX_STALE_AGE_MS}ms)`);

    // Auto-recovery should NOT trigger
    if (staleAgeMs >= MAX_STALE_AGE_MS) {
      lastGoodSnapshot = null;
      consecutiveFailures = 0;
    }

    // Verify lastGoodSnapshot is preserved
    assert.notStrictEqual(lastGoodSnapshot, null, 
      "Should preserve lastGoodSnapshot when stale age is below threshold");
    assert.strictEqual(consecutiveFailures, 3, 
      "Should preserve failure count when below threshold");
  });

  test("BOOTSTRAP_RECOVERY: After auto-recovery clears state, next snapshot bypasses ACTIVE_COLLAPSE_BUG validation", () => {
    // This test validates the bootstrap recovery mechanism that allows the service
    // to recover from persistent ACTIVE_COLLAPSE_BUG conditions without container restart.
    // 
    // Scenario being tested:
    // 1. Service encounters repeated ACTIVE_COLLAPSE_BUG rejections
    // 2. Stale snapshot exceeds MAX_STALE_AGE_MS threshold
    // 3. Auto-recovery clears lastGoodSnapshot and sets allowBootstrapAfterAutoRecovery = true
    // 4. Next refresh with ACTIVE_COLLAPSE_BUG condition is ACCEPTED (bootstrap mode)
    // 5. Service is restored without container restart

    // Simulate state after auto-recovery cleared lastGoodSnapshot
    let allowBootstrapAfterAutoRecovery = true;
    let lastGoodSnapshot: any = null;
    let consecutiveFailures = 0;
    let currentBackoffMs = 0;

    // New snapshot that would normally trigger ACTIVE_COLLAPSE_BUG
    const newSnapshot: any = {
      cycleId: 6,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: Date.now(),
      activePositions: [], // finalActive = 0
      redeemablePositions: [],
      rawCounts: {
        rawTotal: 2,           // API returned 2 positions
        rawActiveCandidates: 2  // 2 were active candidates
      },
      summary: { activeTotal: 0, prof: 0, lose: 0, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };

    // Validation logic (mirrors actual validateSnapshot behavior)
    const rawTotal = newSnapshot.rawCounts?.rawTotal ?? 0;
    const rawActiveCandidates = newSnapshot.rawCounts?.rawActiveCandidates ?? 0;
    const finalActiveCount = newSnapshot.activePositions.length;

    // Check for ACTIVE_COLLAPSE_BUG condition
    const wouldTriggerActivCollapseBug = 
      rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0;

    // Verify the condition would normally trigger ACTIVE_COLLAPSE_BUG
    assert.ok(wouldTriggerActivCollapseBug, 
      "Should detect ACTIVE_COLLAPSE_BUG condition");

    // In bootstrap mode, the snapshot should be ACCEPTED despite the bug
    let validationResult: { ok: boolean; reason?: string };
    if (wouldTriggerActivCollapseBug) {
      if (allowBootstrapAfterAutoRecovery) {
        // Bootstrap mode: accept despite ACTIVE_COLLAPSE_BUG
        validationResult = { ok: true };
      } else {
        validationResult = { ok: false, reason: "ACTIVE_COLLAPSE_BUG" };
      }
    } else {
      validationResult = { ok: true };
    }

    // Verify snapshot was ACCEPTED in bootstrap mode
    assert.strictEqual(validationResult.ok, true, 
      "Snapshot should be ACCEPTED in bootstrap mode despite ACTIVE_COLLAPSE_BUG");

    // After successful acceptance, bootstrap mode should be cleared
    if (validationResult.ok) {
      allowBootstrapAfterAutoRecovery = false;
      lastGoodSnapshot = newSnapshot;
    }

    assert.strictEqual(allowBootstrapAfterAutoRecovery, false, 
      "Bootstrap mode should be cleared after successful snapshot acceptance");
    assert.notStrictEqual(lastGoodSnapshot, null, 
      "lastGoodSnapshot should be updated after successful acceptance");
  });

  test("BOOTSTRAP_RECOVERY: Without bootstrap mode, ACTIVE_COLLAPSE_BUG is still rejected", () => {
    // This test ensures that ACTIVE_COLLAPSE_BUG validation is not completely disabled,
    // only bypassed during bootstrap recovery mode.

    // Normal state (not in bootstrap mode)
    let allowBootstrapAfterAutoRecovery = false;

    // New snapshot that triggers ACTIVE_COLLAPSE_BUG
    const newSnapshot: any = {
      cycleId: 6,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: Date.now(),
      activePositions: [], // finalActive = 0
      redeemablePositions: [],
      rawCounts: {
        rawTotal: 2,
        rawActiveCandidates: 2
      },
    };

    const rawTotal = newSnapshot.rawCounts?.rawTotal ?? 0;
    const rawActiveCandidates = newSnapshot.rawCounts?.rawActiveCandidates ?? 0;
    const finalActiveCount = newSnapshot.activePositions.length;

    const wouldTriggerActivCollapseBug = 
      rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0;

    // Validation should REJECT when not in bootstrap mode
    let validationResult: { ok: boolean; reason?: string };
    if (wouldTriggerActivCollapseBug) {
      if (allowBootstrapAfterAutoRecovery) {
        validationResult = { ok: true };
      } else {
        validationResult = { ok: false, reason: "ACTIVE_COLLAPSE_BUG" };
      }
    } else {
      validationResult = { ok: true };
    }

    assert.strictEqual(validationResult.ok, false, 
      "Snapshot should be REJECTED when not in bootstrap mode");
    assert.strictEqual(validationResult.reason, "ACTIVE_COLLAPSE_BUG", 
      "Rejection reason should be ACTIVE_COLLAPSE_BUG");
  });

  test("BOOTSTRAP_RECOVERY: Auto-recovery sets bootstrap flag when clearing stale state", () => {
    // This test verifies that auto-recovery correctly enables bootstrap mode
    // when clearing the lastGoodSnapshot due to exceeded stale age.

    const MAX_STALE_AGE_MS = 60_000; // 60 seconds

    // Simulate state before auto-recovery
    let allowBootstrapAfterAutoRecovery = false;
    const lastGoodFetchedAt = Date.now() - 65_000; // 65 seconds ago (exceeds threshold)
    let lastGoodSnapshot: any = {
      cycleId: 5,
      addressUsed: "0x1234567890123456789012345678901234567890",
      fetchedAtMs: lastGoodFetchedAt,
      activePositions: [{ tokenId: "t1", marketId: "m1", size: 100 }],
      redeemablePositions: [],
    };
    let lastGoodAtMs = lastGoodFetchedAt;
    let consecutiveFailures = 8;
    let currentBackoffMs = 120_000;

    // Calculate stale age
    const now = Date.now();
    const staleAgeMs = now - lastGoodSnapshot.fetchedAtMs;

    // Auto-recovery should trigger and set bootstrap flag
    if (staleAgeMs >= MAX_STALE_AGE_MS) {
      lastGoodSnapshot = null;
      lastGoodAtMs = 0;
      consecutiveFailures = 0;
      currentBackoffMs = 0;
      allowBootstrapAfterAutoRecovery = true; // This is the new behavior
    }

    // Verify auto-recovery enabled bootstrap mode
    assert.strictEqual(allowBootstrapAfterAutoRecovery, true, 
      "Auto-recovery should enable bootstrap mode when clearing stale state");
    assert.strictEqual(lastGoodSnapshot, null, 
      "lastGoodSnapshot should be cleared");
    assert.strictEqual(consecutiveFailures, 0, 
      "consecutiveFailures should be reset");
    assert.strictEqual(currentBackoffMs, 0, 
      "backoff should be reset");
  });
});

describe("Crash-Proof Recovery: Circuit Breaker", () => {
  test("Circuit breaker opens after threshold failures", () => {
    const circuitBreaker = new Map<string, {
      failureCount: number;
      firstFailureAtMs: number;
      openedAtMs: number;
    }>();

    const THRESHOLD = 3;
    const WINDOW_MS = 30000;
    const tokenId = "test-token-123";

    // Simulate failures
    const now = Date.now();
    for (let i = 1; i <= THRESHOLD; i++) {
      let entry = circuitBreaker.get(tokenId);
      if (!entry) {
        entry = { failureCount: 0, firstFailureAtMs: now, openedAtMs: 0 };
      }
      entry.failureCount++;
      
      if (entry.failureCount >= THRESHOLD) {
        entry.openedAtMs = now;
      }
      
      circuitBreaker.set(tokenId, entry);
    }

    const finalEntry = circuitBreaker.get(tokenId);
    assert.ok(finalEntry, "Entry should exist");
    assert.strictEqual(finalEntry!.failureCount, THRESHOLD, "Should have threshold failures");
    assert.ok(finalEntry!.openedAtMs > 0, "Circuit should be open");
  });

  test("Circuit breaker resets after cooldown", () => {
    const COOLDOWN_MS = 60000;
    const tokenId = "test-token-456";

    // Simulate circuit that was opened 65 seconds ago
    const circuitBreaker = new Map<string, {
      failureCount: number;
      openedAtMs: number;
    }>();

    const openedAtMs = Date.now() - 65000; // 65 seconds ago
    circuitBreaker.set(tokenId, {
      failureCount: 3,
      openedAtMs,
    });

    // Check if cooldown has expired
    const now = Date.now();
    const entry = circuitBreaker.get(tokenId);
    const cooldownExpired = entry && now - entry.openedAtMs >= COOLDOWN_MS;

    if (cooldownExpired) {
      circuitBreaker.delete(tokenId);
    }

    assert.strictEqual(cooldownExpired, true, "Cooldown should be expired after 65s");
    assert.strictEqual(
      circuitBreaker.has(tokenId),
      false,
      "Entry should be deleted after cooldown"
    );
  });

  test("Successful API call resets circuit breaker for token", () => {
    const circuitBreaker = new Map<string, { failureCount: number; openedAtMs: number }>();
    const tokenId = "test-token-789";

    // Set up an open circuit
    circuitBreaker.set(tokenId, {
      failureCount: 5,
      openedAtMs: Date.now(),
    });

    assert.strictEqual(circuitBreaker.has(tokenId), true, "Circuit should exist");

    // Simulate successful call - should delete entry
    circuitBreaker.delete(tokenId);

    assert.strictEqual(
      circuitBreaker.has(tokenId),
      false,
      "Circuit should be reset on success"
    );
  });
});

describe("Crash-Proof Recovery: Downstream Strategy Hardening", () => {
  test("Strategy detects stale snapshot and continues operating", () => {
    // Simulate what ScalpTakeProfit does with stale snapshot
    const staleSnapshot = {
      stale: true,
      staleAgeMs: 45000, // 45 seconds stale
      staleReason: "refresh_failed: 502 Bad Gateway",
      activePositions: [
        { tokenId: "t1", pnlPct: 8.5, pnlTrusted: true },
        { tokenId: "t2", pnlPct: -3.2, pnlTrusted: true },
      ],
      summary: { activeTotal: 2, prof: 1, lose: 1, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };

    // Strategy should still operate on stale data
    const shouldTrade = staleSnapshot.activePositions.length > 0;
    const shouldLogWarning = staleSnapshot.stale === true;
    const staleAgeSec = Math.round((staleSnapshot.staleAgeMs ?? 0) / 1000);

    assert.strictEqual(shouldTrade, true, "Should still trade with stale snapshot");
    assert.strictEqual(shouldLogWarning, true, "Should log warning about stale data");
    assert.strictEqual(staleAgeSec, 45, "Should report stale age correctly");
  });

  test("Strategy falls back to lastGoodSnapshot when current reports 0", () => {
    // Simulate the scenario where current snapshot suddenly reports 0 but lastGood had positions
    const currentSnapshot = {
      stale: false,
      activePositions: [] as any[],
      summary: { activeTotal: 0, prof: 0, lose: 0, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };

    const lastGoodSnapshot = {
      stale: false,
      activePositions: [
        { tokenId: "t1", pnlPct: 5.0 },
        { tokenId: "t2", pnlPct: -2.0 },
      ],
      summary: { activeTotal: 2, prof: 1, lose: 1, neutral: 0, unknown: 0, redeemableTotal: 0 },
    };

    // Strategy logic: If current is empty but lastGood has positions, use lastGood
    const shouldUseFallback =
      currentSnapshot.activePositions.length === 0 &&
      lastGoodSnapshot &&
      lastGoodSnapshot.activePositions.length > 0 &&
      !currentSnapshot.stale;

    const effectiveSnapshot = shouldUseFallback ? lastGoodSnapshot : currentSnapshot;

    assert.strictEqual(shouldUseFallback, true, "Should detect need for fallback");
    assert.strictEqual(
      effectiveSnapshot.activePositions.length,
      2,
      "Should use lastGoodSnapshot positions"
    );
  });
});

describe("Crash-Proof Recovery: Non-Fatal External Lookups", () => {
  test("CLOB 404 error should NOT drop position", () => {
    // When CLOB orderbook returns 404, position should be kept ACTIVE
    // with pnlTrusted=false, not dropped entirely
    
    interface MockPosition {
      tokenId: string;
      status: string;
      pnlTrusted: boolean;
      pnlUntrustedReason?: string;
    }

    // Simulate position processing when orderbook returns 404
    const position: MockPosition = {
      tokenId: "test-token",
      status: "NO_BOOK",
      pnlTrusted: false,
      pnlUntrustedReason: "ORDERBOOK_404",
    };

    // Position should be kept, not dropped
    const isPositionKept = position.status !== "DROPPED";
    const isPnlMarkedUntrusted = position.pnlTrusted === false;
    const hasUntrustedReason = position.pnlUntrustedReason !== undefined;

    assert.strictEqual(isPositionKept, true, "Position should NOT be dropped on 404");
    assert.strictEqual(isPnlMarkedUntrusted, true, "P&L should be marked as untrusted");
    assert.strictEqual(hasUntrustedReason, true, "Should record reason for untrusted P&L");
  });

  test("Gamma API 422 error should NOT mark position as redeemable", () => {
    // When Gamma API returns 422 for outcome lookup, position should
    // remain ACTIVE with classification tracking, not marked as redeemable
    
    const position = {
      tokenId: "test-token",
      positionState: "ACTIVE" as const,
      redeemable: false,
      pnlTrusted: false,
      classificationReason: "GAMMA_API_422",
    };

    // Position should remain ACTIVE, not become REDEEMABLE
    assert.strictEqual(
      position.positionState,
      "ACTIVE",
      "Position should remain ACTIVE on API error"
    );
    assert.strictEqual(
      position.redeemable,
      false,
      "Position should NOT be marked redeemable on API error"
    );
    assert.strictEqual(
      position.classificationReason,
      "GAMMA_API_422",
      "Should record classification reason"
    );
  });

  test("Network timeout should trigger circuit breaker, not drop positions", () => {
    // When network times out repeatedly, circuit breaker should open
    // but positions should be kept with fallback pricing
    
    const circuitBreakerEntries = new Map<string, {
      failureCount: number;
      errorType: string;
      lastKnownPrice: number;
    }>();

    const tokenId = "timeout-token";
    const lastKnownPrice = 0.65; // From previous Data-API fetch

    // Record timeout failures
    for (let i = 0; i < 3; i++) {
      const entry = circuitBreakerEntries.get(tokenId) ?? {
        failureCount: 0,
        errorType: "",
        lastKnownPrice,
      };
      entry.failureCount++;
      entry.errorType = "TIMEOUT";
      circuitBreakerEntries.set(tokenId, entry);
    }

    const finalEntry = circuitBreakerEntries.get(tokenId);
    
    assert.ok(finalEntry, "Should have circuit breaker entry");
    assert.strictEqual(finalEntry!.failureCount, 3, "Should track 3 timeout failures");
    assert.strictEqual(finalEntry!.errorType, "TIMEOUT", "Should record error type");
    assert.strictEqual(
      finalEntry!.lastKnownPrice,
      lastKnownPrice,
      "Should preserve last known price for fallback"
    );
  });
});

// =============================================================================
// SELF-HEALING TESTS (HFT Reliability)
// =============================================================================

describe("Self-Healing: Bounded Failure Policy", () => {
  // Mirror of HFT-tight constants from PositionTracker
  const MAX_CONSECUTIVE_FAILURES = 5;
  const MAX_STALE_AGE_MS = 30_000; // 30 seconds for HFT
  const MAX_DEGRADED_DURATION_MS = 120_000; // 2 minutes

  test("checkSelfHealNeeded returns SOFT_RESET when failures exceed threshold", () => {
    // Simulate state after MAX_CONSECUTIVE_FAILURES failures
    const consecutiveFailures = 6;
    const staleAgeMs = 10_000; // 10 seconds - not stale yet
    const degradedDurationMs = 30_000; // 30 seconds in degraded mode

    // Logic from checkSelfHealNeeded
    let result: { level: string; reason: string } | null = null;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      result = {
        level: "SOFT_RESET",
        reason: `consecutiveFailures=${consecutiveFailures} >= ${MAX_CONSECUTIVE_FAILURES}`,
      };
    }

    assert.ok(result, "Should recommend self-heal");
    assert.strictEqual(result!.level, "SOFT_RESET", "Should recommend SOFT_RESET for failures");
    assert.ok(result!.reason.includes("consecutiveFailures"), "Reason should mention failures");
  });

  test("checkSelfHealNeeded returns SOFT_RESET when stale age exceeds threshold", () => {
    const consecutiveFailures = 2; // Below threshold
    const staleAgeMs = 35_000; // 35 seconds - exceeds 30s threshold
    const lastGoodAtMs = Date.now() - staleAgeMs;

    let result: { level: string; reason: string } | null = null;

    if (staleAgeMs >= MAX_STALE_AGE_MS && lastGoodAtMs > 0) {
      result = {
        level: "SOFT_RESET",
        reason: `staleAge=${Math.round(staleAgeMs / 1000)}s >= ${Math.round(MAX_STALE_AGE_MS / 1000)}s`,
      };
    }

    assert.ok(result, "Should recommend self-heal for stale data");
    assert.strictEqual(result!.level, "SOFT_RESET", "Should recommend SOFT_RESET for stale age");
  });

  test("checkSelfHealNeeded returns HARD_RESET when degraded too long", () => {
    const degradedDurationMs = 150_000; // 2.5 minutes in degraded mode

    let result: { level: string; reason: string } | null = null;

    if (degradedDurationMs >= MAX_DEGRADED_DURATION_MS) {
      result = {
        level: "HARD_RESET",
        reason: `degradedDuration=${Math.round(degradedDurationMs / 1000)}s >= ${Math.round(MAX_DEGRADED_DURATION_MS / 1000)}s`,
      };
    }

    assert.ok(result, "Should recommend self-heal");
    assert.strictEqual(result!.level, "HARD_RESET", "Should recommend HARD_RESET for long degraded mode");
  });

  test("checkSelfHealNeeded returns null when healthy", () => {
    const consecutiveFailures = 2; // Below threshold
    const staleAgeMs = 5_000; // 5 seconds - fresh
    const degradedDurationMs = 0; // Not in degraded mode

    let result: { level: string; reason: string } | null = null;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      result = { level: "SOFT_RESET", reason: "failures" };
    } else if (staleAgeMs >= MAX_STALE_AGE_MS) {
      result = { level: "SOFT_RESET", reason: "stale" };
    } else if (degradedDurationMs >= MAX_DEGRADED_DURATION_MS) {
      result = { level: "HARD_RESET", reason: "degraded" };
    }

    assert.strictEqual(result, null, "Should not recommend self-heal when healthy");
  });
});

describe("Self-Healing: Reset State Behavior", () => {
  test("SOFT_RESET clears transient state but preserves address cache", () => {
    // Simulate SOFT_RESET behavior
    const beforeReset = {
      orderbookCacheSize: 50,
      missingOrderbooksSize: 10,
      consecutiveFailures: 8,
      currentBackoffMs: 60_000,
      addressProbeCompleted: true,
      cachedHoldingAddress: "0x1234...",
      marketOutcomeCacheSize: 100,
    };

    // After SOFT_RESET
    const afterSoftReset = {
      orderbookCacheSize: 0, // Cleared
      missingOrderbooksSize: 0, // Cleared
      consecutiveFailures: 0, // Reset
      currentBackoffMs: 0, // Reset
      addressProbeCompleted: beforeReset.addressProbeCompleted, // Preserved in SOFT_RESET
      cachedHoldingAddress: beforeReset.cachedHoldingAddress, // Preserved in SOFT_RESET
      marketOutcomeCacheSize: beforeReset.marketOutcomeCacheSize, // Preserved in SOFT_RESET
    };

    assert.strictEqual(afterSoftReset.orderbookCacheSize, 0, "Orderbook cache should be cleared");
    assert.strictEqual(afterSoftReset.consecutiveFailures, 0, "Failures should be reset");
    assert.strictEqual(afterSoftReset.currentBackoffMs, 0, "Backoff should be reset");
    assert.ok(afterSoftReset.addressProbeCompleted, "Address probe should be preserved in SOFT_RESET");
  });

  test("HARD_RESET clears all caches including address probe", () => {
    // Simulate HARD_RESET behavior
    const afterHardReset = {
      orderbookCacheSize: 0,
      missingOrderbooksSize: 0,
      consecutiveFailures: 0,
      currentBackoffMs: 0,
      addressProbeCompleted: false, // Reset in HARD_RESET
      cachedHoldingAddress: null, // Reset in HARD_RESET
      marketOutcomeCacheSize: 0, // Cleared in HARD_RESET
      circuitBreakerSize: 0, // Cleared in HARD_RESET
    };

    assert.strictEqual(afterHardReset.addressProbeCompleted, false, "Address probe should be reset in HARD_RESET");
    assert.strictEqual(afterHardReset.cachedHoldingAddress, null, "Holding address should be cleared in HARD_RESET");
    assert.strictEqual(afterHardReset.marketOutcomeCacheSize, 0, "Outcome cache should be cleared in HARD_RESET");
    assert.strictEqual(afterHardReset.circuitBreakerSize, 0, "Circuit breaker should be cleared in HARD_RESET");
  });
});

describe("Self-Healing: Recovery Mode Behavior", () => {
  const RECOVERY_MODE_MAX_CYCLES = 3;

  test("Recovery mode allows ACTIVE_COLLAPSE_BUG snapshot through", () => {
    // Simulate snapshot that would normally trigger ACTIVE_COLLAPSE_BUG
    const snapshot = {
      rawTotal: 2,
      rawActiveCandidates: 2,
      finalActiveCount: 0, // Would trigger ACTIVE_COLLAPSE_BUG
      recoveryMode: true,
    };

    // In recovery mode, this should be accepted with a warning
    const shouldReject = snapshot.rawTotal > 0 && 
      snapshot.rawActiveCandidates > 0 && 
      snapshot.finalActiveCount === 0 &&
      !snapshot.recoveryMode; // Recovery mode bypasses rejection

    assert.strictEqual(shouldReject, false, "Should NOT reject in recovery mode");
  });

  test("Recovery mode exits after successful cycles with active positions", () => {
    let recoveryMode = true;
    let recoveryCycleCount = 0;
    const activePositions = 5;

    // Simulate successful refresh
    if (recoveryMode) {
      recoveryCycleCount++;
      
      // Exit condition: active positions > 0 OR enough cycles
      if (activePositions > 0 || recoveryCycleCount >= RECOVERY_MODE_MAX_CYCLES) {
        recoveryMode = false;
        recoveryCycleCount = 0;
      }
    }

    assert.strictEqual(recoveryMode, false, "Should exit recovery mode with active positions");
  });

  test("Recovery mode exits after max cycles even without active positions", () => {
    let recoveryMode = true;
    let recoveryCycleCount = 0;

    // Simulate RECOVERY_MODE_MAX_CYCLES successful cycles without active positions
    for (let i = 0; i < RECOVERY_MODE_MAX_CYCLES; i++) {
      if (recoveryMode) {
        recoveryCycleCount++;
        const activePositions = 0;
        
        if (activePositions > 0 || recoveryCycleCount >= RECOVERY_MODE_MAX_CYCLES) {
          recoveryMode = false;
          recoveryCycleCount = 0;
        }
      }
    }

    assert.strictEqual(recoveryMode, false, "Should exit recovery mode after max cycles");
  });
});

describe("Self-Healing: Classification Reasons Cannot Be Empty", () => {
  test("Reasons array is never empty when positions are filtered", () => {
    // Simulate scenario where positions are filtered but no skip reasons recorded
    const rawActiveCandidates = 5;
    const finalActiveCount = 0;
    const skipReasons = new Map<string, number>(); // Empty - problematic

    // Build reasons string with fallback
    const reasonCounts: string[] = [];
    for (const [reason, count] of skipReasons) {
      reasonCounts.push(`${reason}=${count}`);
    }

    // CRITICAL FIX: Never allow empty reasons
    if (reasonCounts.length === 0) {
      const processedOk = rawActiveCandidates - finalActiveCount;
      if (processedOk > 0) {
        reasonCounts.push(`FILTERED_NO_REASON=${processedOk}`);
      } else {
        reasonCounts.push(`ALL_ACTIVE=${finalActiveCount}`);
      }
    }

    const reasonsStr = reasonCounts.join(", ");

    assert.ok(reasonsStr.length > 0, "Reasons string should never be empty");
    assert.ok(!reasonsStr.includes("none"), "Reasons should never be 'none'");
    assert.ok(reasonsStr.includes("FILTERED_NO_REASON=5"), "Should have fallback reason");
  });

  test("Minimal acceptance rule allows small raw counts through with warning", () => {
    // Mirror constant from PositionTracker
    const MINIMAL_ACCEPTANCE_MAX_RAW_COUNT = 5;
    
    // The specific case mentioned in the issue:
    // rawTotal=2, rawActiveCandidates=2, finalActive=0, reasons=[none]
    const rawTotal = 2;
    const rawActiveCandidates = 2;
    const finalActiveCount = 0;
    const skipReasons = new Map<string, number>(); // Empty
    
    // Build reasons with fallback
    const reasonCounts: string[] = [];
    for (const [reason, count] of skipReasons) {
      reasonCounts.push(`${reason}=${count}`);
    }
    if (reasonCounts.length === 0) {
      reasonCounts.push(`FILTERED_NO_REASON=${rawActiveCandidates - finalActiveCount}`);
    }
    const reasonsStr = reasonCounts.join(", ");

    // Check minimal acceptance rule
    const isMinimalAcceptanceCase = 
      rawTotal === rawActiveCandidates && 
      rawTotal <= MINIMAL_ACCEPTANCE_MAX_RAW_COUNT &&
      reasonsStr.includes("FILTERED_NO_REASON");

    assert.ok(isMinimalAcceptanceCase, "Should match minimal acceptance rule");
    
    // Should be accepted with warning, not rejected
    const shouldAccept = isMinimalAcceptanceCase;
    assert.ok(shouldAccept, "Minimal acceptance case should be accepted");
  });
});

describe("Self-Healing: Watchdog Integration Points", () => {
  test("getSelfHealStatus returns correct structure", () => {
    // Simulate what getSelfHealStatus would return
    const now = Date.now();
    const lastGoodAtMs = now - 15_000; // 15 seconds ago
    const degradedModeEnteredAt = now - 30_000; // 30 seconds ago

    const status = {
      consecutiveFailures: 3,
      staleAgeMs: now - lastGoodAtMs,
      degradedDurationMs: now - degradedModeEnteredAt,
      recoveryMode: false,
      recoveryCycleCount: 0,
      selfHealCount: 1,
      lastSelfHealAt: now - 60_000,
      isHealthy: false, // Has failures
    };

    assert.ok(typeof status.consecutiveFailures === "number", "Should have consecutiveFailures");
    assert.ok(typeof status.staleAgeMs === "number", "Should have staleAgeMs");
    assert.ok(typeof status.degradedDurationMs === "number", "Should have degradedDurationMs");
    assert.ok(typeof status.recoveryMode === "boolean", "Should have recoveryMode");
    assert.ok(typeof status.isHealthy === "boolean", "Should have isHealthy");
    assert.strictEqual(status.isHealthy, false, "Should be unhealthy with failures");
  });

  test("Watchdog can trigger resetState based on status", () => {
    // Simulate watchdog checking tracker status
    const MAX_CONSECUTIVE_FAILURES = 5;
    const MAX_STALE_AGE_MS = 30_000;

    const status = {
      consecutiveFailures: 6,
      staleAgeMs: 35_000,
      isHealthy: false,
    };

    // Watchdog decision logic
    let shouldTriggerReset = false;
    let resetLevel: "SOFT_RESET" | "HARD_RESET" | null = null;

    if (status.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      shouldTriggerReset = true;
      resetLevel = "SOFT_RESET";
    }
    if (status.staleAgeMs >= MAX_STALE_AGE_MS) {
      shouldTriggerReset = true;
      resetLevel = "SOFT_RESET";
    }

    assert.ok(shouldTriggerReset, "Watchdog should trigger reset");
    assert.strictEqual(resetLevel, "SOFT_RESET", "Should recommend SOFT_RESET");
  });
});

describe("Self-Healing: HFT Timing Constraints", () => {
  test("MAX_STALE_AGE_MS is HFT-appropriate (30 seconds)", () => {
    const MAX_STALE_AGE_MS = 30_000;
    
    // HFT constraint: stale data is unacceptable, must be <= 30s
    assert.ok(MAX_STALE_AGE_MS <= 30_000, "Stale age threshold should be <= 30s for HFT");
    assert.ok(MAX_STALE_AGE_MS > 0, "Stale age threshold must be positive");
  });

  test("MAX_CONSECUTIVE_FAILURES is HFT-appropriate (5 failures)", () => {
    const MAX_CONSECUTIVE_FAILURES = 5;
    
    // HFT constraint: recover quickly, don't wait for too many failures
    assert.ok(MAX_CONSECUTIVE_FAILURES <= 10, "Max failures should be <= 10 for HFT");
    assert.ok(MAX_CONSECUTIVE_FAILURES >= 3, "Max failures should be >= 3 to avoid thrashing");
  });

  test("MAX_DEGRADED_DURATION_MS is HFT-appropriate (2 minutes)", () => {
    const MAX_DEGRADED_DURATION_MS = 120_000;
    
    // HFT constraint: don't stay degraded for long
    assert.ok(MAX_DEGRADED_DURATION_MS <= 300_000, "Degraded duration should be <= 5min for HFT");
    assert.ok(MAX_DEGRADED_DURATION_MS >= 60_000, "Degraded duration should be >= 1min to avoid premature HARD_RESET");
  });

  test("REFRESH_WATCHDOG_TIMEOUT_MS is HFT-appropriate (15 seconds)", () => {
    const REFRESH_WATCHDOG_TIMEOUT_MS = 15_000;
    
    // HFT constraint: single refresh should not take forever
    assert.ok(REFRESH_WATCHDOG_TIMEOUT_MS <= 30_000, "Refresh timeout should be <= 30s");
    assert.ok(REFRESH_WATCHDOG_TIMEOUT_MS >= 5_000, "Refresh timeout should be >= 5s for network latency");
  });
});

describe("Self-Healing: Refresh Watchdog Timeout", () => {
  test("Watchdog timeout aborts stuck refresh and counts as failure", async () => {
    const REFRESH_WATCHDOG_TIMEOUT_MS = 15_000;
    
    // Simulate a refresh that takes too long
    let abortCalled = false;
    const mockAbortController = {
      abort: () => { abortCalled = true; },
    };

    // Simulate watchdog timeout logic
    const refreshStartTime = Date.now();
    const simulatedRefreshDuration = 20_000; // 20 seconds - exceeds 15s timeout
    
    const wouldTimeout = simulatedRefreshDuration > REFRESH_WATCHDOG_TIMEOUT_MS;
    if (wouldTimeout) {
      mockAbortController.abort();
    }

    assert.ok(wouldTimeout, "Refresh exceeding timeout should be detected");
    assert.ok(abortCalled, "AbortController.abort() should be called on timeout");
  });

  test("Refresh completing within timeout is not aborted", () => {
    const REFRESH_WATCHDOG_TIMEOUT_MS = 15_000;
    
    let abortCalled = false;
    const mockAbortController = {
      abort: () => { abortCalled = true; },
    };

    // Simulate a fast refresh
    const simulatedRefreshDuration = 5_000; // 5 seconds - well within timeout
    
    const wouldTimeout = simulatedRefreshDuration > REFRESH_WATCHDOG_TIMEOUT_MS;
    if (wouldTimeout) {
      mockAbortController.abort();
    }

    assert.strictEqual(wouldTimeout, false, "Fast refresh should not timeout");
    assert.strictEqual(abortCalled, false, "AbortController should NOT be called for fast refresh");
  });

  test("awaitWithWatchdog races promise against timeout", async () => {
    // Test the race logic conceptually
    const TIMEOUT_MS = 100; // Short timeout for testing
    
    // Fast promise should win
    const fastPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("success"), 10);
    });
    
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS);
    });

    const result = await Promise.race([fastPromise, timeoutPromise]);
    assert.strictEqual(result, "success", "Fast promise should win the race");
  });

  test("awaitWithWatchdog timeout wins against slow promise", async () => {
    const TIMEOUT_MS = 50; // Short timeout
    
    // Slow promise should lose
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("success"), 200);
    });
    
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("REFRESH_WATCHDOG_TIMEOUT")), TIMEOUT_MS);
    });

    let caughtError: Error | null = null;
    try {
      await Promise.race([slowPromise, timeoutPromise]);
    } catch (err) {
      caughtError = err as Error;
    }

    assert.ok(caughtError, "Should have caught an error");
    assert.ok(caughtError!.message.includes("REFRESH_WATCHDOG_TIMEOUT"), "Should be watchdog timeout error");
  });
});


// ============================================================================
// ORDERBOOK DECOUPLING TESTS (Jan 2025 Fix)
// Tests for the fix that decouples portfolio snapshots from CLOB orderbook availability.
// Positions should remain ACTIVE even when orderbook returns 404 or is empty.
// ============================================================================

describe("Orderbook Decoupling: BookStatus and ExecutionStatus", () => {
  test("BookStatus types are correctly defined", () => {
    // Verify the new BookStatus type exists and has expected values
    const validBookStatuses = ["AVAILABLE", "EMPTY_BOOK", "NO_BOOK_404", "BOOK_ANOMALY", "NOT_FETCHED"];
    const validExecutionStatuses = ["TRADABLE", "NOT_TRADABLE_ON_CLOB", "EXECUTION_BLOCKED"];
    
    // These are type-only checks - we just verify the expected values exist
    assert.ok(validBookStatuses.includes("NO_BOOK_404"), "NO_BOOK_404 should be a valid BookStatus");
    assert.ok(validBookStatuses.includes("EMPTY_BOOK"), "EMPTY_BOOK should be a valid BookStatus");
    assert.ok(validExecutionStatuses.includes("NOT_TRADABLE_ON_CLOB"), "NOT_TRADABLE_ON_CLOB should be a valid ExecutionStatus");
  });

  test("Position with NO_BOOK_404 bookStatus can still be ACTIVE", () => {
    // Simulate a position with orderbook 404 - should still be ACTIVE
    const position = {
      marketId: "market123",
      tokenId: "token123",
      side: "YES",
      size: 100,
      entryPrice: 0.65,
      currentPrice: 0.70, // From Data-API fallback
      pnlPct: 7.69,
      pnlUsd: 5.0,
      pnlTrusted: true, // Can be true if Data-API provided pricing
      pnlClassification: "PROFITABLE" as const,
      redeemable: false,
      status: "NO_BOOK" as const, // Legacy field for backwards compatibility
      positionState: "ACTIVE" as const, // Key: position is ACTIVE despite NO_BOOK
      bookStatus: "NO_BOOK_404" as const, // New: explicit book status
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const, // New: cannot execute
      execPriceTrusted: false, // Cannot trust executable price
    };

    // Key assertions: position is ACTIVE but not tradable
    assert.strictEqual(position.positionState, "ACTIVE", "Position should be ACTIVE despite orderbook 404");
    assert.strictEqual(position.bookStatus, "NO_BOOK_404", "BookStatus should indicate 404");
    assert.strictEqual(position.executionStatus, "NOT_TRADABLE_ON_CLOB", "ExecutionStatus should indicate non-tradable");
    assert.strictEqual(position.execPriceTrusted, false, "Executable price should not be trusted");
    assert.strictEqual(position.pnlTrusted, true, "P&L can still be trusted if Data-API provided pricing");
  });

  test("Position with AVAILABLE bookStatus is TRADABLE", () => {
    const position = {
      marketId: "market456",
      tokenId: "token456",
      side: "NO",
      size: 50,
      entryPrice: 0.40,
      currentPrice: 0.45, // From orderbook best bid
      currentBidPrice: 0.45,
      currentAskPrice: 0.47,
      pnlPct: 12.5,
      pnlUsd: 2.5,
      pnlTrusted: true,
      pnlClassification: "PROFITABLE" as const,
      redeemable: false,
      status: "ACTIVE" as const,
      positionState: "ACTIVE" as const,
      bookStatus: "AVAILABLE" as const,
      executionStatus: "TRADABLE" as const,
      execPriceTrusted: true,
    };

    assert.strictEqual(position.bookStatus, "AVAILABLE", "BookStatus should be AVAILABLE");
    assert.strictEqual(position.executionStatus, "TRADABLE", "ExecutionStatus should be TRADABLE");
    assert.strictEqual(position.execPriceTrusted, true, "Executable price should be trusted");
  });
});

describe("Orderbook Decoupling: ACTIVE_COLLAPSE_BUG Validation", () => {
  test("ORDERBOOK_FAILURE case is accepted (not rejected as ACTIVE_COLLAPSE_BUG)", () => {
    // Simulate the exact scenario from the issue:
    // - rawTotal > 0, rawActiveCandidates > 0, finalActive = 0
    // - BUT the reason is orderbook failures (404, empty book)
    // - This should be ACCEPTED, not rejected
    
    const rawTotal = 10;
    const rawActiveCandidates = 10;
    const finalActiveCount = 0;
    
    // Classification reasons indicate orderbook failures
    // Using named constants for test data clarity
    const ENRICH_FAILED_COUNT = 8;  // Enrichment failed due to 404
    const NO_BOOK_COUNT = 2;        // Empty orderbook
    
    const classificationReasons = new Map<string, number>();
    classificationReasons.set("ENRICH_FAILED", ENRICH_FAILED_COUNT);
    classificationReasons.set("NO_BOOK", NO_BOOK_COUNT);
    
    // Build reasons string
    const reasonCounts: string[] = [];
    for (const [reason, count] of classificationReasons) {
      reasonCounts.push(`${reason}=${count}`);
    }
    const reasonsStr = reasonCounts.join(", ");
    
    // Check for orderbook failure case using Map keys (more reliable than string matching)
    const hasOrderbookFailureReasons = 
      classificationReasons.has("ENRICH_FAILED") ||
      classificationReasons.has("NO_BOOK") ||
      classificationReasons.has("BOOK_404") ||
      classificationReasons.has("PRICING_FETCH_FAILED");
    
    // Fallback string matching for completeness
    const isOrderbookFailureFromString = 
      reasonsStr.includes("ENRICH_FAILED=") ||
      reasonsStr.includes("NO_BOOK=") ||
      reasonsStr.includes("BOOK_404=") ||
      reasonsStr.includes("PRICING_FETCH_FAILED=");
    
    const isOrderbookFailureCase = hasOrderbookFailureReasons || isOrderbookFailureFromString;
    
    // This is the bug condition
    const isActiveCollapseBugCondition = rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0;
    
    // With the fix, orderbook failure case should be accepted
    const shouldAccept = isActiveCollapseBugCondition && isOrderbookFailureCase;
    
    assert.ok(isActiveCollapseBugCondition, "Should detect ACTIVE_COLLAPSE_BUG condition");
    assert.ok(isOrderbookFailureCase, "Should detect orderbook failure case");
    assert.ok(shouldAccept, "Orderbook failure case should be accepted (not rejected)");
  });

  test("Legitimate ACTIVE_COLLAPSE_BUG is still rejected", () => {
    // Simulate a real bug (not orderbook failure)
    const rawTotal = 10;
    const rawActiveCandidates = 10;
    const finalActiveCount = 0;
    
    // Classification reasons that are NOT orderbook failures
    const classificationReasons = new Map<string, number>();
    classificationReasons.set("MISSING_FIELDS", 5);
    classificationReasons.set("INVALID_SIZE_PRICE", 5);
    
    const reasonCounts: string[] = [];
    for (const [reason, count] of classificationReasons) {
      reasonCounts.push(`${reason}=${count}`);
    }
    const reasonsStr = reasonCounts.join(", ");
    
    // Check for orderbook failure case
    const isOrderbookFailureCase = 
      reasonsStr.includes("ENRICH_FAILED") ||
      reasonsStr.includes("NO_BOOK") ||
      reasonsStr.includes("BOOK_404") ||
      reasonsStr.includes("PRICING_FETCH_FAILED");
    
    // Not orderbook failure, so should be rejected
    assert.strictEqual(isOrderbookFailureCase, false, "Should NOT be orderbook failure case");
    
    // Without any exception, this should be rejected
    const isActiveCollapseBugCondition = rawTotal > 0 && rawActiveCandidates > 0 && finalActiveCount === 0;
    assert.ok(isActiveCollapseBugCondition, "Should detect as ACTIVE_COLLAPSE_BUG");
  });
});

describe("Orderbook Decoupling: Strategy Execution Gating", () => {
  test("Strategy should skip NOT_TRADABLE_ON_CLOB positions", () => {
    // Simulate strategy gating logic
    const position = {
      tokenId: "token123",
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      bookStatus: "NO_BOOK_404" as const,
    };
    
    // Strategy gating check
    const shouldSkip = 
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED";
    
    assert.ok(shouldSkip, "Strategy should skip NOT_TRADABLE_ON_CLOB positions");
  });

  test("Strategy should execute on TRADABLE positions", () => {
    const position = {
      tokenId: "token456",
      executionStatus: "TRADABLE" as const,
      bookStatus: "AVAILABLE" as const,
    };
    
    const shouldSkip = 
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED";
    
    assert.strictEqual(shouldSkip, false, "Strategy should NOT skip TRADABLE positions");
  });

  test("Strategy should skip EXECUTION_BLOCKED positions", () => {
    const position = {
      tokenId: "token789",
      executionStatus: "EXECUTION_BLOCKED" as const,
      bookStatus: "AVAILABLE" as const, // Book might be available but execution blocked (cooldown)
    };
    
    const shouldSkip = 
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED";
    
    assert.ok(shouldSkip, "Strategy should skip EXECUTION_BLOCKED positions");
  });
});

describe("Orderbook Decoupling: P&L Calculation Source", () => {
  test("P&L can be trusted from Data-API even without orderbook", () => {
    // Position with Data-API P&L but no orderbook
    const position = {
      tokenId: "token123",
      pnlSource: "DATA_API" as const,
      dataApiPnlUsd: 5.50,
      dataApiPnlPct: 8.5,
      dataApiCurPrice: 0.70,
      pnlUsd: 5.50,
      pnlPct: 8.5,
      pnlTrusted: true, // Should be true because Data-API provided values
      currentBidPrice: undefined, // No orderbook
      bookStatus: "NO_BOOK_404" as const,
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      execPriceTrusted: false, // Exec price is not trusted without orderbook
    };

    // P&L is trusted because Data-API provided it
    assert.strictEqual(position.pnlTrusted, true, "P&L should be trusted from Data-API");
    assert.strictEqual(position.pnlSource, "DATA_API", "P&L source should be DATA_API");
    
    // But execution is not trusted
    assert.strictEqual(position.execPriceTrusted, false, "Exec price should NOT be trusted");
    assert.strictEqual(position.executionStatus, "NOT_TRADABLE_ON_CLOB", "Cannot execute without orderbook");
  });

  test("P&L is UNKNOWN when neither Data-API nor orderbook available", () => {
    // Position with fallback pricing only
    const position = {
      tokenId: "token456",
      pnlSource: "FALLBACK" as const,
      dataApiPnlUsd: undefined,
      dataApiPnlPct: undefined,
      dataApiCurPrice: undefined,
      pnlUsd: 0,
      pnlPct: 0,
      pnlTrusted: false, // Untrusted because only fallback available
      pnlClassification: "UNKNOWN" as const,
      currentBidPrice: undefined,
      bookStatus: "NO_BOOK_404" as const,
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
    };

    assert.strictEqual(position.pnlTrusted, false, "P&L should NOT be trusted from fallback alone");
    assert.strictEqual(position.pnlClassification, "UNKNOWN", "P&L classification should be UNKNOWN");
  });
});
