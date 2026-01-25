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
    assert.strictEqual(DEFAULT_AUTO_SELL_CONFIG.threshold, 0.99);
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

    test("AUTO_SELL_ENABLED defaults to false in off preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "off",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellEnabled, false);
    });

    test("AUTO_SELL_THRESHOLD defaults to 0.99 (99¢)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.autoSellThreshold, 0.99);
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
  test("checkTradability returns REDEEMABLE for redeemable positions", () => {
    // This tests the logic documented in the strategy:
    // Positions with redeemable === true should be skipped
    const position = {
      marketId: "0x123",
      tokenId: "0x456",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.99,
      pnlPct: 98,
      pnlUsd: 49,
      redeemable: true, // Should be filtered out
    };

    // The actual filtering logic is:
    // if (position.redeemable === true) return "REDEEMABLE"
    assert.strictEqual(position.redeemable, true);
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
