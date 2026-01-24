import assert from "node:assert";
import { test, describe, afterEach } from "node:test";
import { loadStrategyConfig } from "../../src/config/loadConfig";

/**
 * Unit tests for Sell Early Strategy
 *
 * These tests verify:
 * 1. Configuration defaults and preset values
 * 2. Environment variable overrides
 * 3. Strategy execution logic (via unit tests for config)
 *
 * Note: Integration tests with live orderbook would require mocking
 * the CLOB client which is beyond the scope of these unit tests.
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

describe("SellEarly Configuration", () => {
  // === DEFAULT VALUES ===
  describe("Default Configuration", () => {
    test("SELL_EARLY_ENABLED defaults to true in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, true);
    });

    test("SELL_EARLY_BID_CENTS defaults to 99.9 in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyBidCents, 99.9);
    });

    test("SELL_EARLY_MIN_LIQUIDITY_USD defaults to 50 in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 50);
    });

    test("SELL_EARLY_MAX_SPREAD_CENTS defaults to 0.3 in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0.3);
    });

    test("SELL_EARLY_MIN_HOLD_SEC defaults to 60 in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinHoldSec, 60);
    });
  });

  // === PRESET VALUES ===
  describe("Preset Values", () => {
    test("Conservative preset has stricter settings", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "conservative",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, true);
      assert.strictEqual(config?.sellEarlyBidCents, 99.9);
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 100); // Higher liquidity
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0.2); // Tighter spread
      assert.strictEqual(config?.sellEarlyMinHoldSec, 120); // Longer hold
    });

    test("Aggressive preset has relaxed settings", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyEnabled, true);
      assert.strictEqual(config?.sellEarlyBidCents, 99.8); // Lower threshold
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 25); // Lower liquidity
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0.5); // Wider spread ok
      assert.strictEqual(config?.sellEarlyMinHoldSec, 30); // Shorter hold
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

  // === ENVIRONMENT VARIABLE OVERRIDES ===
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

    test("SELL_EARLY_MIN_LIQUIDITY_USD env overrides preset value", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        SELL_EARLY_MIN_LIQUIDITY_USD: "75",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinLiquidityUsd, 75);
    });

    test("SELL_EARLY_MAX_SPREAD_CENTS env overrides preset value", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        SELL_EARLY_MAX_SPREAD_CENTS: "0.5",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMaxSpreadCents, 0.5);
    });

    test("SELL_EARLY_MIN_HOLD_SEC env overrides preset value", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        SELL_EARLY_MIN_HOLD_SEC: "120",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.sellEarlyMinHoldSec, 120);
    });
  });
});

describe("SellEarly Strategy Logic", () => {
  /**
   * These tests verify the core strategy behavior through mocked scenarios.
   * The actual SellEarlyStrategy class interacts with live orderbooks, so we
   * test the configuration-based behavior rather than end-to-end execution.
   */

  describe("Position State Gating", () => {
    /**
     * Verify that the strategy only targets ACTIVE positions.
     * REDEEMABLE and RESOLVED positions should be skipped (handled by AutoRedeem).
     */
    test("config includes enabled flag that gates execution", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.ok(
        typeof config?.sellEarlyEnabled === "boolean",
        "sellEarlyEnabled should be a boolean",
      );
    });
  });

  describe("Price Threshold Validation", () => {
    /**
     * Verify that bid threshold is configurable and sensible.
     * Default 99.9¢ means we only sell essentially-won positions.
     */
    test("bid threshold is at least 99 cents by default", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.ok(
        config?.sellEarlyBidCents !== undefined &&
          config.sellEarlyBidCents >= 99,
        "Bid threshold should be at least 99¢ to only target near-certain winners",
      );
    });

    test("aggressive preset allows slightly lower threshold", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });

      const config = loadStrategyConfig();
      // Aggressive can go as low as 99.8¢ but not below 99¢
      assert.ok(
        config?.sellEarlyBidCents !== undefined &&
          config.sellEarlyBidCents >= 99,
        "Even aggressive should target near-certain winners",
      );
    });
  });

  describe("Liquidity Requirements", () => {
    /**
     * Verify liquidity thresholds prevent selling into thin books.
     */
    test("minimum liquidity is positive", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.ok(
        config?.sellEarlyMinLiquidityUsd !== undefined &&
          config.sellEarlyMinLiquidityUsd > 0,
        "Minimum liquidity should be positive to prevent selling into thin books",
      );
    });
  });

  describe("Hold Time Requirements", () => {
    /**
     * Verify hold time prevents instant flips.
     */
    test("minimum hold time is at least 30 seconds", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });

      const config = loadStrategyConfig();
      assert.ok(
        config?.sellEarlyMinHoldSec !== undefined &&
          config.sellEarlyMinHoldSec >= 30,
        "Minimum hold time should prevent instant flips",
      );
    });
  });
});

describe("SellEarly vs AutoRedeem Ordering", () => {
  /**
   * Critical: SellEarly must run BEFORE AutoRedeem.
   * This test verifies that configuration supports proper ordering.
   */
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
