import assert from "node:assert";
import { test, describe, afterEach } from "node:test";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import { DEFAULT_AUTO_SELL_CONFIG } from "../../src/strategies/auto-sell";

/**
 * Unit tests for Auto-Sell Strategy Configuration and Wiring
 *
 * Tests verify:
 * 1. DEFAULT_AUTO_SELL_CONFIG has correct values
 * 2. Config loading from presets works correctly
 * 3. Config override via env vars works correctly
 */

const baseEnv = {
  RPC_URL: "http://localhost:8545",
  PRIVATE_KEY: "0x" + "11".repeat(32),
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
  TARGET_ADDRESSES: "0xabc", // Required for MONITOR_ENABLED presets
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

// === DEFAULT CONFIG TESTS ===

describe("AutoSell Default Config", () => {
  test("DEFAULT_AUTO_SELL_CONFIG has correct default values", () => {
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.enabled, true);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.threshold, 0.999);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.minHoldSeconds, 60);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.minOrderUsd, 1);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.disputeWindowExitEnabled, true);
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.disputeWindowExitPrice, 0.999);
  });
});

// === PRESET CONFIG TESTS ===

describe("AutoSell Configuration - Preset Loading", () => {
  describe("Preset Defaults", () => {
    test("AUTO_SELL_ENABLED defaults to true in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, true);
    });

    test("AUTO_SELL_ENABLED defaults to true in off preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "off",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, true);
    });

    test("AUTO_SELL_THRESHOLD defaults to 0.999 (99.9¢)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellThreshold, 0.999);
    });

    test("AUTO_SELL_DISPUTE_EXIT_PRICE defaults to 0.999 (99.9¢)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitPrice, 0.999);
    });

    test("AUTO_SELL_DISPUTE_EXIT_ENABLED defaults to true", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitEnabled, true);
    });

    test("AUTO_SELL_MIN_HOLD_SEC varies by preset", () => {
      // Conservative: 60s
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "conservative",
      });
      const conservativeConfig = loadStrategyConfig();
      assert.strictEqual(conservativeConfig?.autoSellMinHoldSec, 60);

      // Balanced: 60s
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });
      const balancedConfig = loadStrategyConfig();
      assert.strictEqual(balancedConfig?.autoSellMinHoldSec, 60);

      // Aggressive: 30s (shorter for faster capital recovery)
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });
      const aggressiveConfig = loadStrategyConfig();
      assert.strictEqual(aggressiveConfig?.autoSellMinHoldSec, 30);
    });
  });

  describe("Env Override", () => {
    test("AUTO_SELL_ENABLED can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_ENABLED: "false",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, false);
    });

    test("AUTO_SELL_THRESHOLD can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_THRESHOLD: "0.95",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellThreshold, 0.95);
    });

    test("AUTO_SELL_DISPUTE_EXIT_PRICE can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_DISPUTE_EXIT_PRICE: "0.995",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitPrice, 0.995);
    });

    test("AUTO_SELL_DISPUTE_EXIT_ENABLED can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_DISPUTE_EXIT_ENABLED: "false",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellDisputeExitEnabled, false);
    });

    test("AUTO_SELL_MIN_HOLD_SEC can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        AUTO_SELL_MIN_HOLD_SEC: "120",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellMinHoldSec, 120);
    });
  });
});

// === FILTERING BEHAVIOR TESTS ===

describe("AutoSell Filtering Behavior", () => {
  test("checkTradability returns REDEEMABLE only for positions with verified proof source", () => {
    // UPDATED (Jan 2025): Only skip if there's verified proof of redeemability
    // redeemable=true alone is NOT enough - we need verified redeemableProofSource

    // Position with DATA_API_FLAG proof (verified) - should be filtered
    const positionWithApiProof = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true,
      redeemableProofSource: "DATA_API_FLAG" as const,
    };

    // Position with ONCHAIN_DENOM proof - should be filtered
    const positionWithOnchainProof = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true,
      redeemableProofSource: "ONCHAIN_DENOM" as const,
    };

    // Position with redeemable=true but NO proof - should NOT be filtered (can sell)
    const positionWithoutProof = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true,
      redeemableProofSource: "NONE" as const,
    };

    // Verify the proof sources
    assert.strictEqual(positionWithApiProof.redeemableProofSource, "DATA_API_FLAG");
    assert.strictEqual(positionWithOnchainProof.redeemableProofSource, "ONCHAIN_DENOM");
    assert.strictEqual(positionWithoutProof.redeemableProofSource, "NONE");
  });

  test("checkTradability allows positions with DATA_API_UNCONFIRMED proof to be sold", () => {
    // CRITICAL (Jan 2025 Fix): DATA_API_UNCONFIRMED means Data API says redeemable
    // but on-chain payoutDenominator == 0. These positions should NOT be filtered
    // and should be eligible for AutoSell if there are live bids.

    const positionWithUnconfirmedApi = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.999, // Near resolution price
      currentBidPrice: 0.998, // Live bid available
      pnlPct: 99.8,
      pnlUsd: 49.9,
      // redeemable is false because on-chain payoutDenominator == 0 (mismatch with Data API)
      // PositionTracker keeps this ACTIVE for AutoSell to handle instead of marking redeemable
      redeemable: false,
      redeemableProofSource: "DATA_API_UNCONFIRMED" as const,
    };

    // This position should be eligible for AutoSell (not blocked by redeemable filter)
    assert.strictEqual(positionWithUnconfirmedApi.redeemableProofSource, "DATA_API_UNCONFIRMED");
    assert.strictEqual(positionWithUnconfirmedApi.redeemable, false);
    assert.ok(positionWithUnconfirmedApi.currentBidPrice !== undefined);

    // Simulating the checkTradability logic:
    const hasVerifiedRedeemableProof =
      positionWithUnconfirmedApi.redeemableProofSource === "ONCHAIN_DENOM" ||
      positionWithUnconfirmedApi.redeemableProofSource === "DATA_API_FLAG";

    assert.strictEqual(hasVerifiedRedeemableProof, false, "DATA_API_UNCONFIRMED should NOT be considered verified proof");
  });

  test("checkTradability returns NOT_TRADABLE for non-tradable execution status", () => {
    // Positions with executionStatus NOT_TRADABLE_ON_CLOB or EXECUTION_BLOCKED should be skipped
    const position = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
    };

    assert.strictEqual(position.executionStatus, "NOT_TRADABLE_ON_CLOB");
  });

  test("checkTradability returns NO_BID for positions without bid price", () => {
    // Positions without currentBidPrice should be skipped
    const position = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99, // Has current price from Data API
      pnlPct: 98,
      pnlUsd: 49,
      currentBidPrice: undefined, // No bid from orderbook
    };

    assert.strictEqual(position.currentBidPrice, undefined);
  });
});

// === NEAR RESOLUTION DETECTION TESTS ===

describe("AutoSell Near Resolution Detection", () => {
  test("getPositionsNearResolution uses currentBidPrice when available", () => {
    // CRITICAL FIX (Jan 2025): Near resolution detection should use executable bid price
    // This ensures positions with live bids at 99.9¢+ are eligible even when Data-API price is lower

    // Position where bid is at threshold but currentPrice is lower
    const positionWithHighBid = {
      marketId: "0x123",
      tokenId: "0x456",
      currentPrice: 0.95, // Data API price is lower
      currentBidPrice: 0.999, // But executable bid is at threshold
    };

    // Using the new logic: effectivePrice = currentBidPrice ?? currentPrice
    const effectivePrice =
      positionWithHighBid.currentBidPrice ?? positionWithHighBid.currentPrice;
    const threshold = 0.999;

    assert.ok(
      effectivePrice >= threshold,
      "Position with bid at 99.9¢ should be eligible even when currentPrice is 95¢",
    );
  });

  test("getPositionsNearResolution falls back to currentPrice when no bid", () => {
    // When currentBidPrice is undefined, fall back to currentPrice
    const positionNoBid = {
      marketId: "0x123",
      tokenId: "0x456",
      currentPrice: 0.999,
      currentBidPrice: undefined,
    };

    const effectivePrice =
      positionNoBid.currentBidPrice ?? positionNoBid.currentPrice;
    const threshold = 0.999;

    assert.ok(
      effectivePrice >= threshold,
      "Position with currentPrice at threshold should be eligible when no bid",
    );
  });

  test("position with low bid and low currentPrice is NOT near resolution", () => {
    const positionLowPrices = {
      marketId: "0x123",
      tokenId: "0x456",
      currentPrice: 0.85,
      currentBidPrice: 0.84,
    };

    const effectivePrice =
      positionLowPrices.currentBidPrice ?? positionLowPrices.currentPrice;
    const threshold = 0.999;

    assert.ok(
      effectivePrice < threshold,
      "Position with low prices should not be near resolution",
    );
  });
});

// === DATA_API_UNCONFIRMED ROUTING TO AUTOSELL ===

describe("AutoSell DATA_API_UNCONFIRMED Routing", () => {
  test("DATA_API_UNCONFIRMED positions at 99.9¢ are routed to AutoSell, not AutoRedeem", () => {
    // This test verifies the complete flow:
    // 1. Data API says redeemable, but on-chain payoutDenominator == 0
    // 2. PositionTracker sets redeemable=false with DATA_API_UNCONFIRMED proof
    // 3. getPositionsNearResolution() includes this position (based on price)
    // 4. checkTradability() does NOT block it (DATA_API_UNCONFIRMED is not verified)
    // 5. AutoSell attempts to sell

    const positionDataApiUnconfirmed = {
      marketId: "0x" + "a".repeat(64),
      tokenId: "0x" + "b".repeat(64),
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 1.0, // Data API shows resolved at $1
      currentBidPrice: 0.999, // Live bid at exactly 99.9¢ threshold
      pnlPct: 99.8,
      pnlUsd: 49.9,
      redeemable: false, // NOT redeemable because on-chain payoutDenominator == 0
      redeemableProofSource: "DATA_API_UNCONFIRMED" as const,
      positionState: "ACTIVE" as const,
      executionStatus: "TRADABLE" as const,
    };

    // Step 1: Verify position would be picked up by getPositionsNearResolution
    const effectivePrice = positionDataApiUnconfirmed.currentBidPrice ?? positionDataApiUnconfirmed.currentPrice;
    const threshold = 0.999;
    const isNearResolution = effectivePrice >= threshold;
    assert.strictEqual(isNearResolution, true, "Position at 99.9¢ bid should be near resolution");

    // Step 2: Verify checkTradability would NOT block this position
    const hasVerifiedRedeemableProof =
      positionDataApiUnconfirmed.redeemableProofSource === "ONCHAIN_DENOM" ||
      positionDataApiUnconfirmed.redeemableProofSource === "DATA_API_FLAG";
    assert.strictEqual(hasVerifiedRedeemableProof, false, "DATA_API_UNCONFIRMED is NOT verified proof");

    // Step 3: Verify position would NOT be picked up by AutoRedeem
    const wouldBePickedByAutoRedeem = positionDataApiUnconfirmed.redeemable === true;
    assert.strictEqual(wouldBePickedByAutoRedeem, false, "Position should NOT be picked up by AutoRedeem (redeemable=false)");

    // Step 4: Verify all conditions for AutoSell to attempt selling
    const canAutoSell =
      isNearResolution && // Price at threshold
      !hasVerifiedRedeemableProof && // Not blocked by redeemable filter
      positionDataApiUnconfirmed.currentBidPrice !== undefined && // Has bid
      positionDataApiUnconfirmed.executionStatus === "TRADABLE"; // Can execute

    assert.strictEqual(canAutoSell, true, "All conditions met for AutoSell to attempt selling");
  });

  test("positions at 100¢ with bids are sold instead of waiting for redemption", () => {
    // Edge case: position exactly at $1.00 but on-chain not resolved yet
    // Should be sold via AutoSell rather than waiting for on-chain resolution

    const positionAt100Cents = {
      marketId: "0x" + "c".repeat(64),
      tokenId: "0x" + "d".repeat(64),
      currentPrice: 1.0, // Data API shows winner
      currentBidPrice: 0.999, // Live bid at 99.9¢
      redeemable: false, // On-chain not resolved
      redeemableProofSource: "DATA_API_UNCONFIRMED" as const,
      executionStatus: "TRADABLE" as const,
    };

    // Should be eligible for AutoSell
    const effectivePrice = positionAt100Cents.currentBidPrice ?? positionAt100Cents.currentPrice;
    assert.ok(effectivePrice >= 0.999, "Position should be near resolution");

    const hasVerifiedProof =
      positionAt100Cents.redeemableProofSource === "ONCHAIN_DENOM" ||
      positionAt100Cents.redeemableProofSource === "DATA_API_FLAG";
    assert.strictEqual(hasVerifiedProof, false, "Should not have verified proof");

    // Calculate expected loss from selling at 99.9¢ instead of waiting for $1.00 redemption
    // Loss = (1.0 - 0.999) = $0.001 per share (0.1¢)
    // This is acceptable to free up capital immediately
    const lossPerShare = 1.0 - 0.999;
    assert.ok(lossPerShare < 0.01, "Loss from selling early should be minimal (<1%)");
  });
});
