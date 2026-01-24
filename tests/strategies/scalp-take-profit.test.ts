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

// === SCALP_TAKE_PROFIT_ENABLED Tests ===

test("SCALP_TAKE_PROFIT_ENABLED is true by default in balanced preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpTakeProfitEnabled, true);
});

test("SCALP_TAKE_PROFIT_ENABLED is true in aggressive preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpTakeProfitEnabled, true);
});

test("SCALP_TAKE_PROFIT_ENABLED is true in conservative preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpTakeProfitEnabled, true);
});

test("SCALP_TAKE_PROFIT_ENABLED is false in off preset", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "off",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpTakeProfitEnabled, false);
});

test("SCALP_TAKE_PROFIT_ENABLED env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_TAKE_PROFIT_ENABLED: "false",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpTakeProfitEnabled, false);
});

// === SCALP Profit Thresholds Tests ===

test("Balanced preset has meaningful profit thresholds (5%+ to clear fees)", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  // Balanced: 5% min, 8% target - high enough to clear transaction costs
  assert.equal(config?.scalpMinProfitPct, 5.0);
  assert.equal(config?.scalpTargetProfitPct, 8.0);
  assert.equal(config?.scalpMinProfitUsd, 1.0); // $1 minimum profit
});

test("Conservative preset has higher profit thresholds", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  // Conservative: 8% min, 12% target - patient, larger profits
  assert.equal(config?.scalpMinProfitPct, 8.0);
  assert.equal(config?.scalpTargetProfitPct, 12.0);
  assert.equal(config?.scalpMinProfitUsd, 2.0); // $2 minimum profit
});

test("Aggressive preset has lower but still meaningful profit thresholds", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  // Aggressive: 4% min, 6% target - still above transaction costs!
  assert.equal(config?.scalpMinProfitPct, 4.0);
  assert.equal(config?.scalpTargetProfitPct, 6.0);
  assert.equal(config?.scalpMinProfitUsd, 0.5); // $0.50 minimum profit
});

// === SCALP Hold Time Tests ===

test("Balanced preset has 45-90 minute hold windows", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMinHoldMinutes, 45);
  assert.equal(config?.scalpMaxHoldMinutes, 90);
});

test("Aggressive preset has shorter 30-60 minute hold windows", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMinHoldMinutes, 30);
  assert.equal(config?.scalpMaxHoldMinutes, 60);
});

test("Conservative preset has longer 60-120 minute hold windows", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMinHoldMinutes, 60);
  assert.equal(config?.scalpMaxHoldMinutes, 120);
});

// === SCALP Resolution Exclusion Tests ===

test("Resolution exclusion price is 60¢ by default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  // Never time-exit positions with entry ≤60¢ that reach 90¢+
  assert.equal(config?.scalpResolutionExclusionPrice, 0.6);
});

test("Resolution exclusion price can be overridden via env", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_RESOLUTION_EXCLUSION_PRICE: "0.5",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpResolutionExclusionPrice, 0.5);
});

// === SCALP Sudden Spike Detection Tests ===

test("Sudden spike detection is enabled by default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpSuddenSpikeEnabled, true);
});

test("Balanced preset uses 15% spike threshold", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpSuddenSpikeThresholdPct, 15.0);
  assert.equal(config?.scalpSuddenSpikeWindowMinutes, 10);
});

test("Aggressive preset uses lower 12% spike threshold with shorter window", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "aggressive",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpSuddenSpikeThresholdPct, 12.0);
  assert.equal(config?.scalpSuddenSpikeWindowMinutes, 5);
});

test("Conservative preset uses higher 20% spike threshold", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "conservative",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpSuddenSpikeThresholdPct, 20.0);
});

// === SCALP Env Override Tests ===

test("SCALP_MIN_PROFIT_PCT env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_MIN_PROFIT_PCT: "7.5",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMinProfitPct, 7.5);
});

test("SCALP_TARGET_PROFIT_PCT env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_TARGET_PROFIT_PCT: "10.0",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpTargetProfitPct, 10.0);
});

test("SCALP_MIN_HOLD_MINUTES env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_MIN_HOLD_MINUTES: "60",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMinHoldMinutes, 60);
});

test("SCALP_MAX_HOLD_MINUTES env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_MAX_HOLD_MINUTES: "120",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMaxHoldMinutes, 120);
});

test("SCALP_MIN_PROFIT_USD env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_MIN_PROFIT_USD: "2.0",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpMinProfitUsd, 2.0);
});

test("SCALP_SUDDEN_SPIKE_THRESHOLD_PCT env variable overrides preset value", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_SUDDEN_SPIKE_THRESHOLD_PCT: "18.0",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpSuddenSpikeThresholdPct, 18.0);
});

// === SCALP Low-Price Threshold Tests ===

test("SCALP_LOW_PRICE_THRESHOLD defaults to 0 (disabled)", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpLowPriceThreshold, 0);
});

test("SCALP_LOW_PRICE_THRESHOLD env variable enables low-price scalping", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_LOW_PRICE_THRESHOLD: "0.20",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpLowPriceThreshold, 0.2);
});

test("SCALP_LOW_PRICE_MAX_HOLD_MINUTES defaults to 3 (quick scalps)", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpLowPriceMaxHoldMinutes, 3);
});

test("SCALP_LOW_PRICE_MAX_HOLD_MINUTES env variable overrides default", () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    STRATEGY_PRESET: "balanced",
    SCALP_LOW_PRICE_MAX_HOLD_MINUTES: "5",
  });

  const config = loadStrategyConfig();
  assert.equal(config?.scalpLowPriceMaxHoldMinutes, 5);
});
