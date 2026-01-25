import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadStrategyConfig } from "../../src/config/loadConfig";

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

test("STRATEGY_PRESET=aggressive uses preset MAX_POSITION_USD when no env override", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Aggressive preset has MAX_POSITION_USD: 100 (see presets.ts line 438)
  assert.equal(config.endgameMaxPositionUsd, 100);
});

test("MAX_POSITION_USD env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    MAX_POSITION_USD: "5",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence over preset's 100
  assert.equal(config.endgameMaxPositionUsd, 5);
});

test("MAX_POSITION_USD env variable overrides conservative preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
    MAX_POSITION_USD: "10",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence over preset's 15
  assert.equal(config.endgameMaxPositionUsd, 10);
});

test("STRATEGY_PRESET=balanced uses preset MAX_POSITION_USD when no override", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  // Balanced preset has MAX_POSITION_USD: 25
  assert.equal(config.endgameMaxPositionUsd, 25);
});

test("MAX_POSITION_USD defaults to 25 when preset has no value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "off",
  });

  const config = loadStrategyConfig();
  // Off preset has MAX_POSITION_USD: 25 (see presets.ts line 176)
  assert.equal(config.endgameMaxPositionUsd, 25);
});

test("AUTO_REDEEM_CHECK_INTERVAL_MS defaults to 30000", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  // Default check interval is 30 seconds
  assert.equal(config.autoRedeemCheckIntervalMs, 30000);
});

test("AUTO_REDEEM_CHECK_INTERVAL_MS env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    AUTO_REDEEM_CHECK_INTERVAL_MS: "10000",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence over default
  assert.equal(config.autoRedeemCheckIntervalMs, 10000);
});

test("AUTO_REDEEM_ENABLED is true by default in strategy presets", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config.autoRedeemEnabled, true);
});

test("AUTO_REDEEM_ENABLED can be disabled via env override", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    AUTO_REDEEM_ENABLED: "false",
  });

  const config = loadStrategyConfig();
  assert.equal(config.autoRedeemEnabled, false);
});

test("SMART_HEDGING settings from aggressive preset are loaded correctly", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Aggressive preset has these smart hedging settings (see presets.ts)
  assert.equal(config.smartHedgingEnabled, true);
  assert.equal(config.smartHedgingTriggerLossPct, 20);
  assert.equal(config.smartHedgingMaxHedgeUsd, 50); // SMART_HEDGING_MAX_HEDGE_USD: 50 in aggressive preset
  assert.equal(config.smartHedgingReservePct, 15);
});

test("SMART_HEDGING env variables override preset values", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_MAX_HEDGE_USD: "50",
    SMART_HEDGING_RESERVE_PCT: "10",
    SMART_HEDGING_ABSOLUTE_MAX_USD: "200",
  });

  const config = loadStrategyConfig();
  // Env overrides should take precedence
  assert.equal(config.smartHedgingMaxHedgeUsd, 50);
  assert.equal(config.smartHedgingReservePct, 10);
  assert.equal(config.smartHedgingAbsoluteMaxUsd, 200);
});

test("SMART_HEDGING_ALLOW_EXCEED_MAX env variable works", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_ALLOW_EXCEED_MAX: "false",
  });

  const config = loadStrategyConfig();
  // Default is true, env override should set to false
  assert.equal(config.smartHedgingAllowExceedMax, false);
});

test("SMART_HEDGING_ABSOLUTE_MAX_USD env variable works with aggressive preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_ABSOLUTE_MAX_USD: "25",
    SMART_HEDGING_ALLOW_EXCEED_MAX: "true",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence (aggressive preset default is 100)
  assert.equal(config.smartHedgingAbsoluteMaxUsd, 25);
  assert.equal(config.smartHedgingAllowExceedMax, true);
});

test("Smart hedging config respects absoluteMaxUsd over maxHedgeUsd when allowExceedMax is true", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    MAX_POSITION_USD: "5",
    SMART_HEDGING_MAX_HEDGE_USD: "10",
    SMART_HEDGING_ABSOLUTE_MAX_USD: "25",
    SMART_HEDGING_ALLOW_EXCEED_MAX: "true",
  });

  const config = loadStrategyConfig();
  // When allowExceedMax is true, absoluteMaxUsd should be the effective limit
  // for reserve calculations (not maxHedgeUsd)
  assert.equal(config.smartHedgingMaxHedgeUsd, 10);
  assert.equal(config.smartHedgingAbsoluteMaxUsd, 25);
  assert.equal(config.smartHedgingAllowExceedMax, true);
  // The reserve calculation should use absoluteMaxUsd (25) not maxHedgeUsd (10)
  // This is verified by the smart-hedging.ts logic, not just config loading
});

test("SMART_HEDGING_MIN_HEDGE_USD defaults to 1", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Default min hedge USD is $1
  assert.equal(config.smartHedgingMinHedgeUsd, 1);
});

test("SMART_HEDGING_MIN_HEDGE_USD env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_MIN_HEDGE_USD: "5",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence
  assert.equal(config.smartHedgingMinHedgeUsd, 5);
});

// === STOP_LOSS_MIN_HOLD_SECONDS Tests ===

test("STOP_LOSS_MIN_HOLD_SECONDS defaults to 60 in off preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "off",
  });

  const config = loadStrategyConfig();
  // Off preset has STOP_LOSS_MIN_HOLD_SECONDS: 60
  assert.equal(config.stopLossMinHoldSeconds, 60);
});

test("STOP_LOSS_MIN_HOLD_SECONDS is 120 in conservative preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  // Conservative preset has STOP_LOSS_MIN_HOLD_SECONDS: 120
  assert.equal(config.stopLossMinHoldSeconds, 120);
});

test("STOP_LOSS_MIN_HOLD_SECONDS is 60 in balanced preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  // Balanced preset has STOP_LOSS_MIN_HOLD_SECONDS: 60
  assert.equal(config.stopLossMinHoldSeconds, 60);
});

test("STOP_LOSS_MIN_HOLD_SECONDS is 30 in aggressive preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Aggressive preset has STOP_LOSS_MIN_HOLD_SECONDS: 30
  assert.equal(config.stopLossMinHoldSeconds, 30);
});

test("STOP_LOSS_MIN_HOLD_SECONDS env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
    STOP_LOSS_MIN_HOLD_SECONDS: "90",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence over preset's 120
  assert.equal(config.stopLossMinHoldSeconds, 90);
});

// === SMART_HEDGING Near-Close Behavior Tests ===

test("SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES defaults to 15", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Default near-close window is 15 minutes
  assert.equal(config.smartHedgingNearCloseWindowMinutes, 15);
});

test("SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES: "10",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence
  assert.equal(config.smartHedgingNearCloseWindowMinutes, 10);
});

test("SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS defaults to 12", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Default near-close price drop threshold is 12 cents
  assert.equal(config.smartHedgingNearClosePriceDropCents, 12);
});

test("SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS: "15",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence
  assert.equal(config.smartHedgingNearClosePriceDropCents, 15);
});

test("SMART_HEDGING_NEAR_CLOSE_LOSS_PCT defaults to 30", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Default near-close loss threshold is 30%
  assert.equal(config.smartHedgingNearCloseLossPct, 30);
});

test("SMART_HEDGING_NEAR_CLOSE_LOSS_PCT env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_NEAR_CLOSE_LOSS_PCT: "25",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence
  assert.equal(config.smartHedgingNearCloseLossPct, 25);
});

test("SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES defaults to 3", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Default no-hedge window is 3 minutes
  assert.equal(config.smartHedgingNoHedgeWindowMinutes, 3);
});

test("SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES: "2",
  });

  const config = loadStrategyConfig();
  // Env override should take precedence
  assert.equal(config.smartHedgingNoHedgeWindowMinutes, 2);
});

// === SMART_HEDGING_HEDGE_UP_ANYTIME tests ===

test("SMART_HEDGING_HEDGE_UP_ANYTIME defaults to false", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Default is false (safer - only hedge up near close)
  assert.equal(config.smartHedgingHedgeUpAnytime, false);
});

test("SMART_HEDGING_HEDGE_UP_ANYTIME=true enables anytime hedge up", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_HEDGE_UP_ANYTIME: "true",
  });

  const config = loadStrategyConfig();
  assert.equal(config.smartHedgingHedgeUpAnytime, true);
});

test("SMART_HEDGING_HEDGE_UP_ANYTIME=1 enables anytime hedge up", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_HEDGE_UP_ANYTIME: "1",
  });

  const config = loadStrategyConfig();
  assert.equal(config.smartHedgingHedgeUpAnytime, true);
});

test("SMART_HEDGING_HEDGE_UP_ANYTIME=false disables anytime hedge up", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_HEDGE_UP_ANYTIME: "false",
  });

  const config = loadStrategyConfig();
  assert.equal(config.smartHedgingHedgeUpAnytime, false);
});

test("SMART_HEDGING_HEDGE_UP_ANYTIME=0 disables anytime hedge up", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
    SMART_HEDGING_HEDGE_UP_ANYTIME: "0",
  });

  const config = loadStrategyConfig();
  assert.equal(config.smartHedgingHedgeUpAnytime, false);
});
