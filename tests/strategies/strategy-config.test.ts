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
  // Aggressive preset has MAX_POSITION_USD: 100
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
