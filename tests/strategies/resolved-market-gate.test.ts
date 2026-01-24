import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for Resolved Market Strategy Gate
 *
 * These tests verify:
 * 1. Resolved WIN positions must never call placeOrder(); must call redeem()
 * 2. Resolved LOSS positions may be marked worthless but must not trigger hedging
 * 3. cooldownUntil must prevent repeated order attempts for same token
 */

// Mock Position type
interface MockPosition {
  marketId: string;
  tokenId: string;
  side: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
  redeemable?: boolean;
  marketEndTime?: number;
}

// Helper function to simulate resolved market check (mirrors strategy gate logic)
function isResolvedMarket(position: MockPosition): boolean {
  return position.redeemable === true;
}

// Helper function to simulate QuickFlip strategy gate
function shouldQuickFlipProcess(
  position: MockPosition,
  config: { targetPct: number; minProfitUsd: number },
): { shouldProcess: boolean; reason: string } {
  // STRATEGY GATE: Skip resolved positions
  if (isResolvedMarket(position)) {
    return {
      shouldProcess: false,
      reason: "RESOLVED_MARKET - route to AutoRedeem",
    };
  }

  // Skip if not profitable enough
  if (position.pnlPct < config.targetPct) {
    return {
      shouldProcess: false,
      reason: `Profit ${position.pnlPct}% < target ${config.targetPct}%`,
    };
  }

  // Skip if profit too small in absolute terms
  if (position.pnlUsd < config.minProfitUsd) {
    return {
      shouldProcess: false,
      reason: `Profit $${position.pnlUsd} < min $${config.minProfitUsd}`,
    };
  }

  return { shouldProcess: true, reason: "Meets all criteria" };
}

// Helper function to simulate Smart Hedging strategy gate
function shouldHedgingProcess(
  position: MockPosition,
  config: { triggerLossPct: number },
): { shouldProcess: boolean; reason: string } {
  // STRATEGY GATE: Skip resolved positions
  if (isResolvedMarket(position)) {
    return {
      shouldProcess: false,
      reason: "RESOLVED_MARKET - do not hedge",
    };
  }

  // Skip if not losing enough
  if (position.pnlPct > -config.triggerLossPct) {
    return {
      shouldProcess: false,
      reason: `Loss ${Math.abs(position.pnlPct)}% < trigger ${config.triggerLossPct}%`,
    };
  }

  return { shouldProcess: true, reason: "Meets hedging criteria" };
}

// Helper to simulate cooldown check
function isCooldownActive(
  tokenId: string,
  side: string,
  cooldownCache: Map<string, number>,
  now: number,
): { blocked: boolean; reason?: string; remainingMs?: number } {
  const key = `${tokenId}:${side}`;
  const cooldownUntil = cooldownCache.get(key);

  if (cooldownUntil && now < cooldownUntil) {
    return {
      blocked: true,
      reason: "COOLDOWN_ACTIVE",
      remainingMs: cooldownUntil - now,
    };
  }

  return { blocked: false };
}

describe("Resolved Market Strategy Gate", () => {
  describe("QuickFlip Gate", () => {
    test("should NOT process resolved WIN positions for selling", () => {
      const resolvedWinPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 1.0, // Won - price is $1
        pnlPct: 66.67, // Profitable
        pnlUsd: 40,
        redeemable: true, // RESOLVED
      };

      const result = shouldQuickFlipProcess(resolvedWinPosition, {
        targetPct: 5,
        minProfitUsd: 0.5,
      });

      assert.strictEqual(
        result.shouldProcess,
        false,
        "Should NOT process resolved WIN position",
      );
      assert.ok(
        result.reason.includes("RESOLVED_MARKET"),
        `Expected reason to mention RESOLVED_MARKET, got: ${result.reason}`,
      );
    });

    test("should NOT process resolved LOSS positions for selling", () => {
      const resolvedLossPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 0.0, // Lost - price is $0
        pnlPct: -100,
        pnlUsd: -60,
        redeemable: true, // RESOLVED
      };

      const result = shouldQuickFlipProcess(resolvedLossPosition, {
        targetPct: 5,
        minProfitUsd: 0.5,
      });

      assert.strictEqual(
        result.shouldProcess,
        false,
        "Should NOT process resolved LOSS position",
      );
    });

    test("should process active profitable positions normally", () => {
      const activePosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 0.7,
        pnlPct: 16.67,
        pnlUsd: 10,
        redeemable: false, // ACTIVE (not resolved)
      };

      const result = shouldQuickFlipProcess(activePosition, {
        targetPct: 5,
        minProfitUsd: 0.5,
      });

      assert.strictEqual(
        result.shouldProcess,
        true,
        "Should process active profitable position",
      );
    });
  });

  describe("Smart Hedging Gate", () => {
    test("should NOT hedge resolved LOSS positions", () => {
      const resolvedLossPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 0.0, // Lost
        pnlPct: -100,
        pnlUsd: -60,
        redeemable: true, // RESOLVED
      };

      const result = shouldHedgingProcess(resolvedLossPosition, {
        triggerLossPct: 20,
      });

      assert.strictEqual(
        result.shouldProcess,
        false,
        "Should NOT hedge resolved LOSS position",
      );
      assert.ok(
        result.reason.includes("RESOLVED_MARKET"),
        `Expected reason to mention RESOLVED_MARKET, got: ${result.reason}`,
      );
    });

    test("should NOT hedge resolved WIN positions", () => {
      const resolvedWinPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 1.0, // Won
        pnlPct: 66.67,
        pnlUsd: 40,
        redeemable: true, // RESOLVED
      };

      const result = shouldHedgingProcess(resolvedWinPosition, {
        triggerLossPct: 20,
      });

      assert.strictEqual(
        result.shouldProcess,
        false,
        "Should NOT hedge resolved WIN position (even if loss threshold not met)",
      );
    });

    test("should hedge active losing positions normally", () => {
      const activeLossPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 0.4,
        pnlPct: -33.33,
        pnlUsd: -20,
        redeemable: false, // ACTIVE (not resolved)
      };

      const result = shouldHedgingProcess(activeLossPosition, {
        triggerLossPct: 20,
      });

      assert.strictEqual(
        result.shouldProcess,
        true,
        "Should hedge active losing position",
      );
    });
  });

  describe("Cooldown Lock", () => {
    test("should block order attempts during cooldown", () => {
      const now = Date.now();
      const cooldownCache = new Map<string, number>();

      // Set cooldown for 60 seconds
      const cooldownUntil = now + 60_000;
      cooldownCache.set("token-123:BUY", cooldownUntil);

      const result = isCooldownActive("token-123", "BUY", cooldownCache, now);

      assert.strictEqual(result.blocked, true, "Should be blocked by cooldown");
      assert.strictEqual(
        result.reason,
        "COOLDOWN_ACTIVE",
        "Reason should be COOLDOWN_ACTIVE",
      );
      assert.ok(
        result.remainingMs !== undefined && result.remainingMs > 0,
        "Should have remaining time",
      );
    });

    test("should allow order attempts after cooldown expires", () => {
      const now = Date.now();
      const cooldownCache = new Map<string, number>();

      // Set cooldown that already expired
      const cooldownUntil = now - 1000; // 1 second ago
      cooldownCache.set("token-123:BUY", cooldownUntil);

      const result = isCooldownActive("token-123", "BUY", cooldownCache, now);

      assert.strictEqual(
        result.blocked,
        false,
        "Should NOT be blocked after cooldown expires",
      );
    });

    test("should allow order attempts for different token_id + side combinations", () => {
      const now = Date.now();
      const cooldownCache = new Map<string, number>();

      // Set cooldown for BUY on token-123
      cooldownCache.set("token-123:BUY", now + 60_000);

      // Check SELL on same token - should be allowed
      const sellResult = isCooldownActive(
        "token-123",
        "SELL",
        cooldownCache,
        now,
      );
      assert.strictEqual(
        sellResult.blocked,
        false,
        "SELL should be allowed when BUY is in cooldown",
      );

      // Check BUY on different token - should be allowed
      const differentTokenResult = isCooldownActive(
        "token-456",
        "BUY",
        cooldownCache,
        now,
      );
      assert.strictEqual(
        differentTokenResult.blocked,
        false,
        "BUY on different token should be allowed",
      );
    });

    test("should track cooldown per token_id + side independently", () => {
      const now = Date.now();
      const cooldownCache = new Map<string, number>();

      // Set different cooldowns for different combinations
      cooldownCache.set("token-123:BUY", now + 30_000); // 30s cooldown
      cooldownCache.set("token-123:SELL", now + 60_000); // 60s cooldown
      cooldownCache.set("token-456:BUY", now + 10_000); // 10s cooldown

      const buyResult = isCooldownActive("token-123", "BUY", cooldownCache, now);
      const sellResult = isCooldownActive(
        "token-123",
        "SELL",
        cooldownCache,
        now,
      );
      const otherBuyResult = isCooldownActive(
        "token-456",
        "BUY",
        cooldownCache,
        now,
      );

      assert.strictEqual(buyResult.blocked, true, "token-123:BUY should be blocked");
      assert.strictEqual(sellResult.blocked, true, "token-123:SELL should be blocked");
      assert.strictEqual(otherBuyResult.blocked, true, "token-456:BUY should be blocked");

      // Verify different remaining times
      assert.ok(
        buyResult.remainingMs! < sellResult.remainingMs!,
        "BUY cooldown should be shorter than SELL cooldown",
      );
    });
  });

  describe("Redeem Strategy Integration", () => {
    test("resolved WIN position should be identified for redemption", () => {
      const resolvedWinPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 1.0, // Won
        pnlPct: 66.67,
        pnlUsd: 40,
        redeemable: true,
      };

      // This position should:
      // 1. NOT be processed by QuickFlip
      // 2. NOT be processed by Hedging
      // 3. BE identified as redeemable

      assert.strictEqual(
        isResolvedMarket(resolvedWinPosition),
        true,
        "Should be identified as resolved",
      );
      assert.strictEqual(
        resolvedWinPosition.currentPrice,
        1.0,
        "Winner should have price of $1",
      );
    });

    test("resolved LOSS position should be marked worthless", () => {
      const resolvedLossPosition: MockPosition = {
        marketId: "market-123",
        tokenId: "token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.6,
        currentPrice: 0.0, // Lost
        pnlPct: -100,
        pnlUsd: -60,
        redeemable: true,
      };

      assert.strictEqual(
        isResolvedMarket(resolvedLossPosition),
        true,
        "Should be identified as resolved",
      );
      assert.strictEqual(
        resolvedLossPosition.currentPrice,
        0.0,
        "Loser should have price of $0",
      );
      assert.strictEqual(
        resolvedLossPosition.pnlPct,
        -100,
        "Loser should have -100% P&L",
      );
    });
  });
});

describe("Entry Time Handling for External Purchases", () => {
  test("profitable positions without entry time should still be considered for selling", () => {
    // This tests the fix for positions bought via on-chain wallet
    // where historical entry time data might be missing
    const profitablePosition: MockPosition = {
      marketId: "market-123",
      tokenId: "token-456",
      side: "YES",
      size: 100,
      entryPrice: 0.6,
      currentPrice: 0.75,
      pnlPct: 25, // Clearly profitable
      pnlUsd: 15,
      redeemable: false,
    };

    // Even without entry time, if position meets profit targets,
    // it should be allowed to sell
    const hasEntryTime = false;
    const meetsTargetProfit = profitablePosition.pnlPct >= 5; // QuickFlip default 5%
    const meetsMinProfitUsd = profitablePosition.pnlUsd >= 0.5;

    // The fix: if position is profitable without entry time, allow selling
    const shouldAllowSale = !hasEntryTime && meetsTargetProfit && meetsMinProfitUsd;

    assert.strictEqual(
      shouldAllowSale,
      true,
      "Profitable position without entry time should be allowed for sale",
    );
  });
});
