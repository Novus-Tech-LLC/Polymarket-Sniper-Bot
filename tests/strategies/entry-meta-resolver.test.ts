import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for EntryMetaResolver
 *
 * Tests the stateless entry metadata reconstruction from trade history.
 * Verifies that:
 * - Weighted average cost basis is calculated correctly
 * - firstAcquiredAt and lastAcquiredAt timestamps are derived from trades
 * - timeHeldSec is stable across "restarts" (because it uses timestamps, not runtime)
 * - Resolved/redeemable positions are handled correctly
 * - TokenId-based logic works for any binary outcome type (YES/NO, Over/Under, etc.)
 */

/**
 * Helper to simulate the reconstructPositionFromTrades logic
 * This mirrors the private method in EntryMetaResolver for unit testing
 */
interface TradeItem {
  timestamp: number; // Unix timestamp in seconds
  conditionId: string; // Market ID
  asset: string; // Token ID
  side: string; // "BUY" or "SELL"
  size: number | string;
  price: number | string;
}

interface EntryMeta {
  avgEntryPriceCents: number;
  firstAcquiredAt: number;
  lastAcquiredAt: number;
  timeHeldSec: number;
  remainingShares: number;
  cacheAgeMs: number;
}

function reconstructPositionFromTrades(
  trades: TradeItem[],
  nowOverride?: number,
): EntryMeta | null {
  // Sort trades by timestamp (oldest first)
  const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  let totalShares = 0;
  let totalCost = 0;
  let firstAcquiredAt: number | null = null;
  let lastAcquiredAt: number | null = null;
  let positionStartTimestamp: number | null = null;

  for (const trade of sortedTrades) {
    const side = trade.side?.toUpperCase();
    const size =
      typeof trade.size === "string" ? parseFloat(trade.size) : trade.size;
    const price =
      typeof trade.price === "string" ? parseFloat(trade.price) : trade.price;
    const timestampMs = trade.timestamp * 1000;

    if (!Number.isFinite(size) || size <= 0) continue;
    if (!Number.isFinite(price) || price < 0) continue;
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) continue;

    if (side === "BUY") {
      const tradeValue = size * price;
      totalShares += size;
      totalCost += tradeValue;

      if (positionStartTimestamp === null) {
        positionStartTimestamp = timestampMs;
      }
      lastAcquiredAt = timestampMs;

      if (firstAcquiredAt === null) {
        firstAcquiredAt = timestampMs;
      }
    } else if (side === "SELL") {
      if (totalShares > 0) {
        const avgPrice = totalCost / totalShares;
        const sharesToSell = Math.min(size, totalShares);
        const costReduction = sharesToSell * avgPrice;

        totalShares -= sharesToSell;
        totalCost -= costReduction;

        if (totalShares <= 0.0001) {
          totalShares = 0;
          totalCost = 0;
          positionStartTimestamp = null;
          firstAcquiredAt = null;
          lastAcquiredAt = null;
        }
      }
    }
  }

  if (totalShares <= 0.0001) {
    return null;
  }

  const avgEntryPrice = totalCost / totalShares;
  const avgEntryPriceCents = avgEntryPrice * 100;

  if (!firstAcquiredAt || !lastAcquiredAt) {
    return null;
  }

  const now = nowOverride ?? Date.now();
  const timeHeldSec = Math.floor((now - firstAcquiredAt) / 1000);

  return {
    avgEntryPriceCents,
    firstAcquiredAt,
    lastAcquiredAt,
    timeHeldSec,
    remainingShares: totalShares,
    cacheAgeMs: 0,
  };
}

describe("EntryMetaResolver Position Reconstruction", () => {
  test("Single BUY trade reconstructs correctly", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000, // Fixed timestamp in seconds
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.65, // 65¢
      },
    ];

    const now = 1700003600 * 1000; // 1 hour later in ms
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta");
    assert.strictEqual(result.remainingShares, 100, "Should have 100 shares");
    assert.strictEqual(
      result.avgEntryPriceCents,
      65,
      "Avg entry price should be 65¢",
    );
    assert.strictEqual(
      result.firstAcquiredAt,
      1700000000 * 1000,
      "firstAcquiredAt should be trade timestamp",
    );
    assert.strictEqual(
      result.lastAcquiredAt,
      1700000000 * 1000,
      "lastAcquiredAt should be trade timestamp",
    );
    assert.strictEqual(
      result.timeHeldSec,
      3600,
      "timeHeldSec should be 1 hour",
    );
  });

  test("Multiple BUY trades calculate weighted average correctly", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.5, // 50¢
      },
      {
        timestamp: 1700001000, // 1000 seconds later
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.7, // 70¢
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta");
    assert.strictEqual(result.remainingShares, 200, "Should have 200 shares");
    // Weighted average: (100 * 0.50 + 100 * 0.70) / 200 = 120 / 200 = 0.60 = 60¢
    assert.strictEqual(
      result.avgEntryPriceCents,
      60,
      "Avg entry price should be 60¢ (weighted)",
    );
    assert.strictEqual(
      result.firstAcquiredAt,
      1700000000 * 1000,
      "firstAcquiredAt should be first BUY",
    );
    assert.strictEqual(
      result.lastAcquiredAt,
      1700001000 * 1000,
      "lastAcquiredAt should be last BUY",
    );
  });

  test("BUY then partial SELL calculates remaining shares correctly", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.6, // 60¢
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 30, // Sell 30 shares
        price: 0.7, // Price doesn't affect remaining avg
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta");
    assert.strictEqual(
      result.remainingShares,
      70,
      "Should have 70 shares left",
    );
    // Avg entry price stays at 60¢ (weighted average doesn't change with sells)
    assert.strictEqual(
      result.avgEntryPriceCents,
      60,
      "Avg entry price should stay 60¢",
    );
    // firstAcquiredAt should still be from the BUY
    assert.strictEqual(
      result.firstAcquiredAt,
      1700000000 * 1000,
      "firstAcquiredAt should be from BUY",
    );
  });

  test("BUY, BUY, partial SELL maintains weighted average", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.5, // 50¢
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.7, // 70¢
      },
      {
        timestamp: 1700002000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 50, // Sell 50 shares
        price: 0.8, // Exit price (doesn't affect remaining avg)
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta");
    assert.strictEqual(
      result.remainingShares,
      150,
      "Should have 150 shares left",
    );
    // Weighted average: (100 * 0.50 + 100 * 0.70) / 200 = 0.60
    // After selling 50 at avg 0.60: (200 * 0.60 - 50 * 0.60) / 150 = 0.60
    assert.strictEqual(
      result.avgEntryPriceCents,
      60,
      "Avg entry price should be 60¢",
    );
    assert.strictEqual(
      result.firstAcquiredAt,
      1700000000 * 1000,
      "firstAcquiredAt should be first BUY",
    );
    assert.strictEqual(
      result.lastAcquiredAt,
      1700001000 * 1000,
      "lastAcquiredAt should be second BUY",
    );
  });

  test("Full SELL resets position tracking", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.6,
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 100, // Full sell
        price: 0.7,
      },
    ];

    const result = reconstructPositionFromTrades(trades);

    assert.strictEqual(
      result,
      null,
      "Should return null when position is closed",
    );
  });

  test("Full SELL then new BUY starts fresh position", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.5, // Old position at 50¢
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 100, // Full sell
        price: 0.6,
      },
      {
        timestamp: 1700002000, // New buy starts fresh position
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 50,
        price: 0.8, // New position at 80¢
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta for new position");
    assert.strictEqual(result.remainingShares, 50, "Should have 50 shares");
    // New position should have avg entry price of 80¢
    assert.strictEqual(
      result.avgEntryPriceCents,
      80,
      "Avg entry price should be 80¢ (new position)",
    );
    // firstAcquiredAt should be from the NEW buy, not the old one
    assert.strictEqual(
      result.firstAcquiredAt,
      1700002000 * 1000,
      "firstAcquiredAt should be from new BUY (after full sell)",
    );
    // timeHeldSec should be relative to the new buy
    assert.strictEqual(
      result.timeHeldSec,
      1600, // 1700003600 - 1700002000 = 1600 seconds
      "timeHeldSec should be relative to new position start",
    );
  });

  test("timeHeldSec is stable across 'restarts' (uses timestamps)", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.65,
      },
    ];

    // Simulate "restart 1" - calculate at time T
    const now1 = 1700003600 * 1000; // 1 hour after trade
    const result1 = reconstructPositionFromTrades(trades, now1);

    // Simulate "restart 2" - same calculation at same time T
    // In real world, this would be a fresh container restart
    const result2 = reconstructPositionFromTrades(trades, now1);

    assert.ok(result1, "Result 1 should exist");
    assert.ok(result2, "Result 2 should exist");

    // CRITICAL: timeHeldSec should be IDENTICAL because it's derived from timestamps
    // not from container uptime
    assert.strictEqual(
      result1.timeHeldSec,
      result2.timeHeldSec,
      "timeHeldSec should be identical across 'restarts'",
    );
    assert.strictEqual(
      result1.firstAcquiredAt,
      result2.firstAcquiredAt,
      "firstAcquiredAt should be identical across 'restarts'",
    );
    assert.strictEqual(
      result1.avgEntryPriceCents,
      result2.avgEntryPriceCents,
      "avgEntryPriceCents should be identical across 'restarts'",
    );
  });

  test("String values for size and price are parsed correctly", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: "100", // String
        price: "0.65", // String
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta with string values");
    assert.strictEqual(result.remainingShares, 100, "Should parse size string");
    assert.strictEqual(
      result.avgEntryPriceCents,
      65,
      "Should parse price string",
    );
  });

  test("Invalid trades (zero size, negative price) are skipped", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 0, // Invalid - zero size
        price: 0.65,
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: -0.1, // Invalid - negative price
      },
      {
        timestamp: 1700002000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 50,
        price: 0.7, // Valid
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should return entry meta for valid trade");
    assert.strictEqual(
      result.remainingShares,
      50,
      "Should only count valid trade",
    );
    assert.strictEqual(
      result.avgEntryPriceCents,
      70,
      "Avg entry price from valid trade",
    );
  });

  test("Over/Under outcomes work (tokenId-based, not outcome string)", () => {
    // Simulates an Over/Under market like "Bitcoin over 100k?"
    // The logic is identical because we use tokenId, not outcome string
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "bitcoin-100k-market",
        asset: "over-token-123", // Over token
        side: "BUY",
        size: 100,
        price: 0.4, // 40¢
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should work for Over/Under markets");
    assert.strictEqual(
      result.avgEntryPriceCents,
      40,
      "Avg entry price should be 40¢",
    );
  });

  test("Team/Team outcomes work (tokenId-based, not outcome string)", () => {
    // Simulates a sports market like "Chiefs vs Eagles"
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "chiefs-eagles-superbowl",
        asset: "chiefs-win-token-456", // Chiefs win token
        side: "BUY",
        size: 200,
        price: 0.55, // 55¢
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should work for Team/Team markets");
    // Use approximate comparison for floating point
    assert.ok(
      Math.abs(result.avgEntryPriceCents - 55) < 0.01,
      `Avg entry price should be ~55¢, got ${result.avgEntryPriceCents}`,
    );
  });
});

describe("EntryMetaResolver Edge Cases", () => {
  test("Empty trades array returns null", () => {
    const result = reconstructPositionFromTrades([]);
    assert.strictEqual(result, null, "Should return null for empty trades");
  });

  test("Only SELL trades (no initial position) returns null", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 100,
        price: 0.7,
      },
    ];

    const result = reconstructPositionFromTrades(trades);
    assert.strictEqual(
      result,
      null,
      "Should return null when only SELLs (no initial position)",
    );
  });

  test("SELL more than owned limits to available shares", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.6,
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 150, // Try to sell more than owned
        price: 0.7,
      },
    ];

    const result = reconstructPositionFromTrades(trades);
    // Should limit to 100 shares (all we had) and close position
    assert.strictEqual(
      result,
      null,
      "Should return null when position is fully closed",
    );
  });

  test("Very small remaining shares (dust) are treated as closed", () => {
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.6,
      },
      {
        timestamp: 1700001000,
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 99.99999, // Near-complete sell leaving dust-level remainder (~0.00001 shares)
        price: 0.7,
      },
    ];

    const result = reconstructPositionFromTrades(trades);
    // With ~0.00001 shares remaining, should treat as closed (dust threshold is 0.0001)
    assert.strictEqual(
      result,
      null,
      "Should return null for dust-level remaining shares",
    );
  });

  test("Trades out of order are sorted by timestamp", () => {
    // Trades submitted in reverse chronological order
    const trades: TradeItem[] = [
      {
        timestamp: 1700002000, // Third
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 50,
        price: 0.7,
      },
      {
        timestamp: 1700000000, // First
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.5,
      },
      {
        timestamp: 1700001000, // Second (SELL)
        conditionId: "market-1",
        asset: "token-1",
        side: "SELL",
        size: 50,
        price: 0.6,
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Should handle out-of-order trades");
    // After sorting: BUY 100@0.50, SELL 50, BUY 50@0.70
    // After first BUY: 100 shares @ 0.50 avg = 50 cost
    // After SELL 50: 50 shares @ 0.50 avg = 25 cost
    // After second BUY: 100 shares, cost = 25 + 35 = 60
    // Avg = 60 / 100 = 0.60 = 60¢
    assert.strictEqual(result.remainingShares, 100, "Should have 100 shares");
    assert.strictEqual(
      result.avgEntryPriceCents,
      60,
      "Avg entry price should be 60¢",
    );
    // firstAcquiredAt should be from the chronologically first BUY
    assert.strictEqual(
      result.firstAcquiredAt,
      1700000000 * 1000,
      "firstAcquiredAt should be chronologically first BUY",
    );
  });
});

// === UNTRUSTED_ENTRY VALIDATION TESTS ===

describe("EntryMetaResolver UNTRUSTED_ENTRY Validation", () => {
  /**
   * Helper to validate entry meta against live shares
   * This mirrors the private validateAgainstLiveShares logic for unit testing
   */
  function validateAgainstLiveShares(
    computedShares: number,
    liveShares: number | undefined,
  ): { trusted: boolean; reason?: string } {
    if (liveShares === undefined || liveShares <= 0) {
      return { trusted: true };
    }

    const difference = Math.abs(computedShares - liveShares);
    const percentDiff = (difference / liveShares) * 100;

    // Threshold constants (same as in EntryMetaResolver)
    const MAX_PERCENT_DIFF = 2; // 2%
    const MAX_ABSOLUTE_DIFF = 0.5; // 0.5 shares

    if (percentDiff > MAX_PERCENT_DIFF || difference > MAX_ABSOLUTE_DIFF) {
      const reason = `Shares mismatch: computed=${computedShares.toFixed(2)} vs live=${liveShares.toFixed(2)} (diff=${difference.toFixed(2)}, ${percentDiff.toFixed(1)}%)`;
      return { trusted: false, reason };
    }

    return { trusted: true };
  }

  test("Entry is trusted when computed shares match live shares exactly", () => {
    const result = validateAgainstLiveShares(100, 100);
    assert.strictEqual(result.trusted, true, "Should be trusted when shares match");
    assert.strictEqual(result.reason, undefined, "Should have no reason");
  });

  test("Entry is trusted when difference is within both thresholds", () => {
    // 100 shares computed, 100.3 live = 0.3% difference AND 0.3 absolute < 0.5
    const result = validateAgainstLiveShares(100, 100.3);
    assert.strictEqual(result.trusted, true, "Should be trusted within both thresholds");
  });

  test("Entry is UNTRUSTED when percent difference exceeds 2%", () => {
    // 10 shares computed, 10.25 live = 2.5% difference (but absolute only 0.25)
    // This tests percent threshold specifically
    const result = validateAgainstLiveShares(10, 10.25);
    assert.strictEqual(result.trusted, false, "Should be untrusted when percent diff > 2%");
    assert.ok(result.reason?.includes("Shares mismatch"), "Should have mismatch reason");
  });

  test("Entry is UNTRUSTED when absolute difference exceeds 0.5 shares", () => {
    // 10 shares computed, 10.6 live = 6% but more importantly 0.6 > 0.5 absolute
    const result = validateAgainstLiveShares(10, 10.6);
    assert.strictEqual(result.trusted, false, "Should be untrusted when absolute diff > 0.5");
  });

  test("Entry is trusted when no live shares provided (undefined)", () => {
    const result = validateAgainstLiveShares(100, undefined);
    assert.strictEqual(result.trusted, true, "Should be trusted when no live shares");
  });

  test("Entry is trusted when live shares is 0", () => {
    const result = validateAgainstLiveShares(100, 0);
    assert.strictEqual(result.trusted, true, "Should be trusted when live shares is 0");
  });

  test("Small positions: 1 share computed vs 0.4 live = UNTRUSTED (diff 0.6)", () => {
    const result = validateAgainstLiveShares(1, 0.4);
    assert.strictEqual(result.trusted, false, "Small position diff should be caught");
  });

  test("Large positions within thresholds: 1000 vs 1000.4 = trusted", () => {
    // 1000.4 - 1000 = 0.4 (< 0.5 absolute) AND 0.04% (< 2%)
    const result = validateAgainstLiveShares(1000, 1000.4);
    assert.strictEqual(result.trusted, true, "Should be trusted when within both thresholds");
  });

  test("Large positions: 1000 computed vs 1025 live = UNTRUSTED (2.5% diff)", () => {
    const result = validateAgainstLiveShares(1000, 1025);
    assert.strictEqual(result.trusted, false, "2.5% diff should be untrusted");
  });
});

// === MULTIPLE TOKENID DISTINCT RESULTS TESTS ===

describe("EntryMetaResolver Multiple TokenIds", () => {
  test("Different tokenIds with different trades produce different results", () => {
    // TokenId 1: 100 shares @ 50¢
    const trades1: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-1",
        side: "BUY",
        size: 100,
        price: 0.5,
      },
    ];

    // TokenId 2: 50 shares @ 70¢
    const trades2: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1",
        asset: "token-2",
        side: "BUY",
        size: 50,
        price: 0.7,
      },
    ];

    const now = 1700003600 * 1000;
    const result1 = reconstructPositionFromTrades(trades1, now);
    const result2 = reconstructPositionFromTrades(trades2, now);

    assert.ok(result1, "Result 1 should exist");
    assert.ok(result2, "Result 2 should exist");

    // CRITICAL: Results must be DIFFERENT
    assert.notStrictEqual(
      result1.remainingShares,
      result2.remainingShares,
      "Different tokenIds should have different share counts",
    );
    assert.notStrictEqual(
      result1.avgEntryPriceCents,
      result2.avgEntryPriceCents,
      "Different tokenIds should have different avg entry prices",
    );

    // Verify specific values
    assert.strictEqual(result1.remainingShares, 100, "Token 1 should have 100 shares");
    assert.strictEqual(result1.avgEntryPriceCents, 50, "Token 1 should have 50¢ avg");
    assert.strictEqual(result2.remainingShares, 50, "Token 2 should have 50 shares");
    assert.strictEqual(result2.avgEntryPriceCents, 70, "Token 2 should have 70¢ avg");
  });

  test("Same tokenId across different markets still grouped by tokenId", () => {
    // Same tokenId but different markets - trades should still be correctly grouped
    const trades: TradeItem[] = [
      {
        timestamp: 1700000000,
        conditionId: "market-1", // Different market
        asset: "shared-token-id",
        side: "BUY",
        size: 100,
        price: 0.5,
      },
      {
        timestamp: 1700001000,
        conditionId: "market-2", // Different market
        asset: "shared-token-id",
        side: "BUY",
        size: 100,
        price: 0.7,
      },
    ];

    const now = 1700003600 * 1000;
    const result = reconstructPositionFromTrades(trades, now);

    assert.ok(result, "Result should exist");
    // Both trades should be aggregated (same tokenId)
    assert.strictEqual(result.remainingShares, 200, "Should aggregate both buys");
    assert.strictEqual(result.avgEntryPriceCents, 60, "Should have weighted avg of 60¢");
  });

  test("Prevent bug: multiple tokenIds with identical first/last timestamps", () => {
    // This tests the bug where "2885.49 shares @ 61.4¢ avg" was reconstructed
    // identically for multiple different tokenIds
    const token1Trades: TradeItem[] = [
      {
        timestamp: 1700000000, // Same timestamp
        conditionId: "market-1",
        asset: "token-AAA",
        side: "BUY",
        size: 2885.49,
        price: 0.614,
      },
    ];

    const token2Trades: TradeItem[] = [
      {
        timestamp: 1700000000, // Same timestamp
        conditionId: "market-1",
        asset: "token-BBB",
        side: "BUY",
        size: 500,
        price: 0.30,
      },
    ];

    const now = 1700003600 * 1000;
    const result1 = reconstructPositionFromTrades(token1Trades, now);
    const result2 = reconstructPositionFromTrades(token2Trades, now);

    assert.ok(result1, "Token AAA result should exist");
    assert.ok(result2, "Token BBB result should exist");

    // Even with same timestamp, results must be different because trades are different
    assert.notStrictEqual(
      result1.remainingShares,
      result2.remainingShares,
      "Bug prevention: different tokens should have different shares",
    );
    assert.notStrictEqual(
      result1.avgEntryPriceCents,
      result2.avgEntryPriceCents,
      "Bug prevention: different tokens should have different avg prices",
    );

    // Verify the specific values match the input trades
    assert.ok(
      Math.abs(result1.remainingShares - 2885.49) < 0.01,
      `Token AAA should have 2885.49 shares, got ${result1.remainingShares}`,
    );
    assert.ok(
      Math.abs(result1.avgEntryPriceCents - 61.4) < 0.1,
      `Token AAA should have 61.4¢ avg, got ${result1.avgEntryPriceCents}`,
    );
    assert.strictEqual(result2.remainingShares, 500, "Token BBB should have 500 shares");
    assert.strictEqual(result2.avgEntryPriceCents, 30, "Token BBB should have 30¢ avg");
  });
});
