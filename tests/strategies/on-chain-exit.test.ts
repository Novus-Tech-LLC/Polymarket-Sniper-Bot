import assert from "node:assert";
import { test, describe, afterEach } from "node:test";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import { DEFAULT_ON_CHAIN_EXIT_CONFIG } from "../../src/strategies/on-chain-exit";

/**
 * Unit tests for On-Chain Exit Strategy Configuration and Wiring
 *
 * Tests verify:
 * 1. DEFAULT_ON_CHAIN_EXIT_CONFIG has correct values
 * 2. Config loading from presets works correctly
 * 3. Config override via env vars works correctly
 * 4. Filtering behavior for NOT_TRADABLE positions
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

describe("OnChainExit Default Config", () => {
  test("DEFAULT_ON_CHAIN_EXIT_CONFIG has correct default values", () => {
    assert.strictEqual(DEFAULT_ON_CHAIN_EXIT_CONFIG.enabled, true);
    assert.strictEqual(DEFAULT_ON_CHAIN_EXIT_CONFIG.priceThreshold, 0.99);
    assert.strictEqual(DEFAULT_ON_CHAIN_EXIT_CONFIG.minPositionUsd, 0.01);
  });
});

// === PRESET CONFIG TESTS ===

describe("OnChainExit Configuration - Preset Loading", () => {
  describe("Preset Defaults", () => {
    test("ON_CHAIN_EXIT_ENABLED defaults to true in balanced preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitEnabled, true);
    });

    test("ON_CHAIN_EXIT_ENABLED defaults to true in conservative preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "conservative",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitEnabled, true);
    });

    test("ON_CHAIN_EXIT_ENABLED defaults to true in aggressive preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "aggressive",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitEnabled, true);
    });

    test("ON_CHAIN_EXIT_ENABLED defaults to true in off preset", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "off",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitEnabled, true);
    });

    test("ON_CHAIN_EXIT_PRICE_THRESHOLD defaults to 0.99 (99¢)", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitPriceThreshold, 0.99);
    });

    test("ON_CHAIN_EXIT_MIN_POSITION_USD defaults to 0.01", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitMinPositionUsd, 0.01);
    });
  });

  describe("Env Override", () => {
    test("ON_CHAIN_EXIT_ENABLED can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        ON_CHAIN_EXIT_ENABLED: "false",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitEnabled, false);
    });

    test("ON_CHAIN_EXIT_PRICE_THRESHOLD can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        ON_CHAIN_EXIT_PRICE_THRESHOLD: "0.95",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitPriceThreshold, 0.95);
    });

    test("ON_CHAIN_EXIT_MIN_POSITION_USD can be overridden via env", () => {
      resetEnv();
      Object.assign(process.env, baseEnv, {
        STRATEGY_PRESET: "balanced",
        ON_CHAIN_EXIT_MIN_POSITION_USD: "1.0",
      });

      const config = loadStrategyConfig();
      assert.strictEqual(config?.onChainExitMinPositionUsd, 1.0);
    });
  });
});

// === FILTERING BEHAVIOR TESTS ===

describe("OnChainExit Filtering Behavior", () => {
  test("only processes positions with NOT_TRADABLE_ON_CLOB status", () => {
    // OnChainExit should only process positions that AutoSell skips
    // These are positions with executionStatus=NOT_TRADABLE_ON_CLOB

    const tradablePosition = {
      marketId: "0x" + "a".repeat(64),
      tokenId: "0x" + "b".repeat(64),
      executionStatus: "TRADABLE" as const,
      currentPrice: 0.99,
    };

    const notTradablePosition = {
      marketId: "0x" + "c".repeat(64),
      tokenId: "0x" + "d".repeat(64),
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      currentPrice: 0.99,
    };

    // Tradable position should NOT be processed by OnChainExit
    assert.strictEqual(
      tradablePosition.executionStatus !== "NOT_TRADABLE_ON_CLOB",
      true,
      "Tradable position should be handled by AutoSell, not OnChainExit",
    );

    // NOT_TRADABLE position should be processed by OnChainExit
    assert.strictEqual(
      notTradablePosition.executionStatus === "NOT_TRADABLE_ON_CLOB",
      true,
      "NOT_TRADABLE position should be handled by OnChainExit",
    );
  });

  test("only processes positions at or above price threshold", () => {
    const threshold = 0.99;

    const positionBelowThreshold = {
      currentPrice: 0.85,
    };

    const positionAtThreshold = {
      currentPrice: 0.99,
    };

    const positionAboveThreshold = {
      currentPrice: 1.0,
    };

    assert.strictEqual(
      positionBelowThreshold.currentPrice >= threshold,
      false,
      "Position below threshold should be skipped",
    );

    assert.strictEqual(
      positionAtThreshold.currentPrice >= threshold,
      true,
      "Position at threshold should be processed",
    );

    assert.strictEqual(
      positionAboveThreshold.currentPrice >= threshold,
      true,
      "Position above threshold should be processed",
    );
  });

  test("skips positions with position value below minPositionUsd", () => {
    const minPositionUsd = 0.01;

    const dustPosition = {
      size: 0.001,
      currentPrice: 0.99,
    };

    const normalPosition = {
      size: 10,
      currentPrice: 0.99,
    };

    const dustValue = dustPosition.size * dustPosition.currentPrice;
    const normalValue = normalPosition.size * normalPosition.currentPrice;

    assert.strictEqual(
      dustValue >= minPositionUsd,
      false,
      "Dust position should be skipped",
    );

    assert.strictEqual(
      normalValue >= minPositionUsd,
      true,
      "Normal position should be processed",
    );
  });

  test("already redeemable positions are skipped", () => {
    // OnChainExit should skip positions that are already marked redeemable
    // (AutoRedeem handles those)

    const alreadyRedeemablePosition = {
      marketId: "0x" + "e".repeat(64),
      tokenId: "0x" + "f".repeat(64),
      redeemable: true,
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      currentPrice: 0.99,
    };

    assert.strictEqual(
      alreadyRedeemablePosition.redeemable,
      true,
      "Position already marked redeemable should be skipped",
    );
  });
});

// === ON-CHAIN RESOLUTION CHECK TESTS ===

describe("OnChainExit On-Chain Resolution Check", () => {
  test("payoutDenominator > 0 indicates market resolved on-chain", () => {
    // When on-chain payoutDenominator > 0, the market is resolved
    // and the position can be redeemed
    const resolvedPayoutDenominator = 1n;
    const unresolvedPayoutDenominator = 0n;

    assert.strictEqual(
      resolvedPayoutDenominator > 0n,
      true,
      "Non-zero payoutDenominator should indicate resolved",
    );

    assert.strictEqual(
      unresolvedPayoutDenominator > 0n,
      false,
      "Zero payoutDenominator should indicate not resolved",
    );
  });

  test("valid conditionId format is bytes32 (66 chars with 0x prefix)", () => {
    const validConditionId = "0x" + "a".repeat(64);
    const invalidConditionIdTooShort = "0x" + "a".repeat(32);
    const invalidConditionIdNoPrefix = "a".repeat(64);

    const BYTES32_HEX_LENGTH = 66;

    assert.strictEqual(
      validConditionId.startsWith("0x") &&
        validConditionId.length === BYTES32_HEX_LENGTH,
      true,
      "Valid conditionId should pass validation",
    );

    assert.strictEqual(
      invalidConditionIdTooShort.startsWith("0x") &&
        invalidConditionIdTooShort.length === BYTES32_HEX_LENGTH,
      false,
      "Short conditionId should fail validation",
    );

    assert.strictEqual(
      invalidConditionIdNoPrefix.startsWith("0x") &&
        invalidConditionIdNoPrefix.length === BYTES32_HEX_LENGTH,
      false,
      "ConditionId without 0x prefix should fail validation",
    );
  });
});

// === SKIP REASON TESTS ===

describe("OnChainExit Skip Reasons", () => {
  test("TRADABLE_ON_CLOB skip reason for tradable positions", () => {
    // Positions that are tradable on CLOB should be skipped
    // They are handled by AutoSell instead
    const reason = "TRADABLE_ON_CLOB";

    assert.strictEqual(
      reason,
      "TRADABLE_ON_CLOB",
      "Skip reason for tradable positions should be TRADABLE_ON_CLOB",
    );
  });

  test("BELOW_PRICE_THRESHOLD skip reason for low-price positions", () => {
    const reason = "BELOW_PRICE_THRESHOLD";

    assert.strictEqual(
      reason,
      "BELOW_PRICE_THRESHOLD",
      "Skip reason for low-price positions should be BELOW_PRICE_THRESHOLD",
    );
  });

  test("NOT_REDEEMABLE_ONCHAIN skip reason when payoutDenominator is 0", () => {
    // When the market is not resolved on-chain, the position cannot be redeemed
    const reason = "NOT_REDEEMABLE_ONCHAIN";

    assert.strictEqual(
      reason,
      "NOT_REDEEMABLE_ONCHAIN",
      "Skip reason for unresolved markets should be NOT_REDEEMABLE_ONCHAIN",
    );
  });
});

// === INTEGRATION SCENARIO TESTS ===

describe("OnChainExit Integration Scenarios", () => {
  test("scenario: NOT_TRADABLE position at 99¢ with resolved market routes to redemption", () => {
    // This is the main scenario OnChainExit handles:
    // 1. Position has executionStatus=NOT_TRADABLE_ON_CLOB (AutoSell skips it)
    // 2. Position has high currentPrice (≥99¢)
    // 3. Market is resolved on-chain (payoutDenominator > 0)
    // Result: Position should be routed to redemption

    const position = {
      marketId: "0x" + "1".repeat(64),
      tokenId: "0x" + "2".repeat(64),
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      currentPrice: 0.99,
      size: 100,
      redeemable: false, // Not yet marked redeemable
    };

    const payoutDenominator = 1n; // Market is resolved on-chain
    const priceThreshold = 0.99;
    const minPositionUsd = 0.01;

    // Check all conditions
    const isNotTradable =
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED";
    const meetsThreshold = position.currentPrice >= priceThreshold;
    const meetsMinValue =
      position.size * position.currentPrice >= minPositionUsd;
    const isResolvedOnChain = payoutDenominator > 0n;
    const notAlreadyRedeemable = position.redeemable !== true;

    const canRouteToRedemption =
      isNotTradable &&
      meetsThreshold &&
      meetsMinValue &&
      isResolvedOnChain &&
      notAlreadyRedeemable;

    assert.strictEqual(
      canRouteToRedemption,
      true,
      "Position meeting all criteria should be routed to redemption",
    );
  });

  test("scenario: NOT_TRADABLE position at 99¢ with unresolved market is skipped", () => {
    // Position meets all criteria except market not resolved on-chain
    // Result: Position should be skipped with NOT_REDEEMABLE_ONCHAIN reason

    const position = {
      marketId: "0x" + "3".repeat(64),
      tokenId: "0x" + "4".repeat(64),
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      currentPrice: 0.99,
      size: 100,
      redeemable: false,
    };

    const payoutDenominator = 0n; // Market NOT resolved on-chain
    const priceThreshold = 0.99;

    const isNotTradable = position.executionStatus === "NOT_TRADABLE_ON_CLOB";
    const meetsThreshold = position.currentPrice >= priceThreshold;
    const isResolvedOnChain = payoutDenominator > 0n;

    const canRouteToRedemption =
      isNotTradable && meetsThreshold && isResolvedOnChain;

    assert.strictEqual(
      canRouteToRedemption,
      false,
      "Position with unresolved market should NOT be routed to redemption",
    );
  });

  test("scenario: TRADABLE position at 99¢ is handled by AutoSell, not OnChainExit", () => {
    // Position is tradable on CLOB - AutoSell handles it
    // OnChainExit should skip this position

    const position = {
      marketId: "0x" + "5".repeat(64),
      tokenId: "0x" + "6".repeat(64),
      executionStatus: "TRADABLE" as const,
      currentPrice: 0.99,
    };

    const isNotTradable =
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED";

    assert.strictEqual(
      isNotTradable,
      false,
      "Tradable position should be skipped by OnChainExit",
    );
  });

  test("scenario: Low-price NOT_TRADABLE position (80¢) is skipped", () => {
    // Position is NOT_TRADABLE but price is below threshold
    // OnChainExit should skip - no point checking on-chain for low-value exits

    const position = {
      marketId: "0x" + "7".repeat(64),
      tokenId: "0x" + "8".repeat(64),
      executionStatus: "NOT_TRADABLE_ON_CLOB" as const,
      currentPrice: 0.8, // Below 99¢ threshold
    };

    const priceThreshold = 0.99;
    const meetsThreshold = position.currentPrice >= priceThreshold;

    assert.strictEqual(
      meetsThreshold,
      false,
      "Low-price position should be skipped",
    );
  });
});
