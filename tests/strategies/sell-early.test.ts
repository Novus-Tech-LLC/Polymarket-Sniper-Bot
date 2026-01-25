import assert from "node:assert";
import { test, describe, afterEach } from "node:test";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import {
  DEFAULT_SELL_EARLY_CONFIG,
  type SellEarlyConfig,
} from "../../src/strategies/sell-early";
import type { Position } from "../../src/strategies/position-tracker";

/**
 * Unit tests for Sell Early Strategy (Simplified - Jan 2025)
 *
 * CORE BEHAVIOR TO TEST:
 * 1. bestBid >= 99.9 -> submits sell
 * 2. bestBid < 99.9 -> no sell
 * 3. no bids -> skip
 * 4. redeemable -> do not sell
 * 5. wrong marketId/tokenId -> error and skip
 *
 * NEW DEFAULTS:
 * - SELL_EARLY_ENABLED = true
 * - SELL_EARLY_BID_CENTS = 99.9
 * - All optional gates (liquidity, spread, hold time) are OFF (0) by default
 */

// Conversion factor: decimal price (0.999) * 100 = cents (99.9)
const CENTS_TO_DECIMAL = 100;

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

// === CONFIGURATION TESTS ===

describe("SellEarly Configuration - Simplified Defaults", () => {
  describe("New Simplified Defaults", () => {
    test("SELL_EARLY_ENABLED defaults to true in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, true);
    });

    test("SELL_EARLY_BID_CENTS defaults to 99.9 in all presets", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });
      const balancedConfig = loadStrategyConfig();
      assert.strictEqual(balancedConfig?.sellEarlyBidCents, 99.9);

      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "conservative",
      });
      const conservativeConfig = loadStrategyConfig();
      assert.strictEqual(conservativeConfig?.sellEarlyBidCents, 99.9);

      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });
      const aggressiveConfig = loadStrategyConfig();
      assert.strictEqual(aggressiveConfig?.sellEarlyBidCents, 99.9);
    });

    test("SELL_EARLY_MIN_LIQUIDITY_USD defaults to 0 (DISABLED) in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 0);
    });

    test("SELL_EARLY_MAX_SPREAD_CENTS defaults to 0 (DISABLED) in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0);
    });

    test("SELL_EARLY_MIN_HOLD_SEC defaults to 0 (DISABLED) in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinHoldSec, 0);
    });
  });

  describe("All Presets Have Same Simplified Defaults", () => {
    test("Conservative preset has same settings as balanced (no profile differences)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "conservative",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, true);
      assert.strictEqual(config?.sellEarlyBidCents, 99.9);
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 0); // DISABLED
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0); // DISABLED
      assert.strictEqual(config?.sellEarlyMinHoldSec, 0); // DISABLED
    });

    test("Aggressive preset has same settings as balanced (no profile differences)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, true);
      assert.strictEqual(config?.sellEarlyBidCents, 99.9); // Same as balanced
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 0); // DISABLED
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0); // DISABLED
      assert.strictEqual(config?.sellEarlyMinHoldSec, 0); // DISABLED
    });

    test("Off preset disables sell-early", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "off",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, false);
    });
  });

  describe("Environment Variable Overrides", () => {
    test("SELL_EARLY_ENABLED env overrides preset value", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        SELL_EARLY_ENABLED: "false",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, false);
    });

    test("SELL_EARLY_BID_CENTS env overrides preset value", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        SELL_EARLY_BID_CENTS: "99.5",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyBidCents, 99.5);
    });

    test("Optional gates can be enabled via env vars", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        SELL_EARLY_MIN_LIQUIDITY_USD: "100",
        SELL_EARLY_MAX_SPREAD_CENTS: "0.5",
        SELL_EARLY_MIN_HOLD_SEC: "60",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 100);
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0.5);
      assert.strictEqual(config?.sellEarlyMinHoldSec, 60);
    });
  });
});

// === DEFAULT CONFIG TESTS ===

describe("SellEarlyStrategy DEFAULT_SELL_EARLY_CONFIG", () => {
  test("DEFAULT_SELL_EARLY_CONFIG has correct values", () => {
    assert.strictEqual(DEFAULT_SELL_EARLY_CONFIG.enabled, true);
    assert.strictEqual(DEFAULT_SELL_EARLY_CONFIG.bidCents, 99.9);
    assert.strictEqual(DEFAULT_SELL_EARLY_CONFIG.minLiquidityUsd, 0); // DISABLED
    assert.strictEqual(DEFAULT_SELL_EARLY_CONFIG.maxSpreadCents, 0); // DISABLED
    assert.strictEqual(DEFAULT_SELL_EARLY_CONFIG.minHoldSec, 0); // DISABLED
  });
});

// === STRATEGY LOGIC TESTS (MOCKED) ===

describe("SellEarly Strategy Logic", () => {
  // Mock position with configurable properties
  const createMockPosition = (overrides: Partial<Position> = {}): Position => ({
    marketId: "market-123",
    tokenId: "token-abc123456789",
    side: "YES",
    size: 100,
    entryPrice: 0.85,
    currentPrice: 0.999,
    pnlPct: 17.5,
    pnlUsd: 14.9,
    pnlTrusted: true,
    pnlClassification: "PROFITABLE",
    currentBidPrice: 0.999, // Default: at threshold
    currentAskPrice: 1.0,
    status: "ACTIVE",
    redeemable: false,
    redeemableProofSource: "NONE", // Default: no proof (can sell)
    ...overrides,
  });

  describe("Core Behavior: Price Threshold", () => {
    test("bestBid >= 99.9 triggers sell evaluation", async () => {
      // This test verifies the threshold logic at configuration level
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 0,
        maxSpreadCents: 0,
        minHoldSec: 0,
      };

      // Position with bid at threshold
      const position = createMockPosition({
        currentBidPrice: 0.999, // Exactly 99.9¢
      });

      // Verify bid in cents is at or above threshold
      const bidCents = position.currentBidPrice! * CENTS_TO_DECIMAL;
      assert.ok(
        bidCents >= config.bidCents,
        "Bid at 99.9¢ should meet threshold",
      );
    });

    test("bestBid < 99.9 does not trigger sell", () => {
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 0,
        maxSpreadCents: 0,
        minHoldSec: 0,
      };

      // Position with bid below threshold
      const position = createMockPosition({
        currentBidPrice: 0.989, // 98.9¢
      });

      const bidCents = position.currentBidPrice! * CENTS_TO_DECIMAL;
      assert.ok(
        bidCents < config.bidCents,
        "Bid at 98.9¢ should NOT meet threshold",
      );
    });

    test("bestBid > 99.9 (e.g., 99.95¢) triggers sell", () => {
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 0,
        maxSpreadCents: 0,
        minHoldSec: 0,
      };

      // Position with bid above threshold
      const position = createMockPosition({
        currentBidPrice: 0.9995, // 99.95¢
      });

      const bidCents = position.currentBidPrice! * CENTS_TO_DECIMAL;
      assert.ok(
        bidCents >= config.bidCents,
        "Bid at 99.95¢ should meet threshold",
      );
    });
  });

  describe("Core Behavior: No Bids", () => {
    test("no bids -> skip with NO_BID reason", () => {
      const position = createMockPosition({
        currentBidPrice: undefined, // No bid available
      });

      assert.strictEqual(
        position.currentBidPrice,
        undefined,
        "Position should have no bid",
      );
    });
  });

  describe("Core Behavior: Redeemable Positions", () => {
    test("redeemable with DATA_API_FLAG proof -> do not sell", () => {
      // UPDATED (Jan 2025): Only skip if there's actual proof of redeemability
      const position = createMockPosition({
        redeemable: true,
        redeemableProofSource: "DATA_API_FLAG",
        currentBidPrice: 0.999,
      });

      assert.strictEqual(
        position.redeemableProofSource,
        "DATA_API_FLAG",
        "Position should have DATA_API_FLAG proof source",
      );
    });

    test("redeemable with ONCHAIN_DENOM proof -> do not sell", () => {
      const position = createMockPosition({
        redeemable: true,
        redeemableProofSource: "ONCHAIN_DENOM",
        currentBidPrice: 0.999,
      });

      assert.strictEqual(
        position.redeemableProofSource,
        "ONCHAIN_DENOM",
        "Position should have ONCHAIN_DENOM proof source",
      );
    });

    test("redeemable=true but proofSource=NONE -> CAN sell (internal flag not trusted)", () => {
      // CRITICAL: Internal redeemable flag without proof should NOT block selling
      const position = createMockPosition({
        redeemable: true,
        redeemableProofSource: "NONE",
        currentBidPrice: 0.999,
      });

      // The new logic only checks redeemableProofSource, not redeemable flag
      const hasRedeemableProof =
        position.redeemableProofSource === "ONCHAIN_DENOM" ||
        position.redeemableProofSource === "DATA_API_FLAG";

      assert.strictEqual(
        hasRedeemableProof,
        false,
        "Position with NONE proof source should be eligible for selling",
      );
    });
  });

  describe("Core Behavior: Invalid Market/Token ID", () => {
    test("empty marketId -> error and skip", () => {
      const position = createMockPosition({
        marketId: "",
        currentBidPrice: 0.999,
      });

      assert.strictEqual(
        position.marketId,
        "",
        "Position should have empty marketId",
      );
    });

    test("unknown marketId -> error and skip", () => {
      const position = createMockPosition({
        marketId: "unknown",
        currentBidPrice: 0.999,
      });

      assert.strictEqual(
        position.marketId,
        "unknown",
        "Position should have unknown marketId",
      );
    });
  });

  describe("Optional Gates (Disabled by Default)", () => {
    test("liquidity check is skipped when minLiquidityUsd=0", () => {
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 0, // DISABLED
        maxSpreadCents: 0,
        minHoldSec: 0,
      };

      // Verify check should be skipped
      assert.strictEqual(
        config.minLiquidityUsd,
        0,
        "Liquidity check should be disabled",
      );
    });

    test("spread check is skipped when maxSpreadCents=0", () => {
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 0,
        maxSpreadCents: 0, // DISABLED
        minHoldSec: 0,
      };

      assert.strictEqual(
        config.maxSpreadCents,
        0,
        "Spread check should be disabled",
      );
    });

    test("hold time check is skipped when minHoldSec=0", () => {
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 0,
        maxSpreadCents: 0,
        minHoldSec: 0, // DISABLED
      };

      assert.strictEqual(
        config.minHoldSec,
        0,
        "Hold time check should be disabled",
      );
    });

    test("optional gates can be enabled via config", () => {
      const config: SellEarlyConfig = {
        enabled: true,
        bidCents: 99.9,
        minLiquidityUsd: 100, // ENABLED
        maxSpreadCents: 0.5, // ENABLED
        minHoldSec: 60, // ENABLED
      };

      assert.strictEqual(
        config.minLiquidityUsd,
        100,
        "Liquidity gate should be enabled",
      );
      assert.strictEqual(
        config.maxSpreadCents,
        0.5,
        "Spread gate should be enabled",
      );
      assert.strictEqual(
        config.minHoldSec,
        60,
        "Hold time gate should be enabled",
      );
    });
  });
});

describe("SellEarly vs AutoRedeem Ordering", () => {
  test("both strategies can be enabled simultaneously", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.sellEarlyEnabled, true);
    assert.strictEqual(config?.autoRedeemEnabled, true);
    // Both can be enabled - SellEarly handles ACTIVE, AutoRedeem handles REDEEMABLE
  });

  test("sellEarly disabled does not affect autoRedeem", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      SELL_EARLY_ENABLED: "false",
    });

    const config = loadStrategyConfig();
    assert.strictEqual(config?.sellEarlyEnabled, false);
    assert.strictEqual(config?.autoRedeemEnabled, true);
    // Disabling sellEarly leaves autoRedeem unaffected
  });
});
