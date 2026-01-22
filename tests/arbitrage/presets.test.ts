import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadArbConfig, loadMonitorConfig } from "../../src/config/loadConfig";

const baseArbEnv = {
  RPC_URL: "http://localhost:8545",
  PRIVATE_KEY: "0x" + "11".repeat(32),
  MODE: "arb",
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
};

const baseMonitorEnv = {
  TARGET_ADDRESSES: "0xabc",
  PUBLIC_KEY: "0x" + "22".repeat(20),
  PRIVATE_KEY: "0x" + "33".repeat(32),
  RPC_URL: "http://localhost:8545",
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

test("ARB_PRESET=micro loads expected defaults", () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "micro",
  });

  const config = loadArbConfig();
  assert.equal(config.scanIntervalMs, 250);
  assert.equal(config.minEdgeBps, 20);
  assert.equal(config.minProfitUsd, 0.05);
  assert.equal(config.maxTradesPerHour, 20000);
});

test("allowlisted override applies for arb presets", () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "safe_small",
    ARB_MAX_WALLET_EXPOSURE_USD: "40",
  });

  const config = loadArbConfig();
  assert.equal(config.maxWalletExposureUsd, 40);
});

test("ARB_MAX_SPREAD_BPS override applies for arb presets", () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "safe_small",
    ARB_MAX_SPREAD_BPS: "180",
  });

  const config = loadArbConfig();
  assert.equal(config.maxSpreadBps, 180);
});

test("non-allowlisted arb override is ignored unless unsafe overrides enabled", () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "safe_small",
    ARB_MIN_EDGE_BPS: "999",
  });

  const safeConfig = loadArbConfig();
  assert.equal(safeConfig.minEdgeBps, 120);

  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "safe_small",
    ARB_MIN_EDGE_BPS: "999",
    ARB_ALLOW_UNSAFE_OVERRIDES: "true",
  });
  const unsafeConfig = loadArbConfig();
  assert.equal(unsafeConfig.minEdgeBps, 999);
});

test("MONITOR_PRESET=active changes min trade threshold (eligibility mocked)", () => {
  resetEnv();
  Object.assign(process.env, baseMonitorEnv, {
    MONITOR_PRESET: "active",
  });

  const config = loadMonitorConfig();
  assert.equal(config.minTradeSizeUsd, 25);
  assert.equal(20 >= config.minTradeSizeUsd, false);
  assert.equal(30 >= config.minTradeSizeUsd, true);
});

test("legacy monitor vars trigger custom preset behavior", () => {
  resetEnv();
  Object.assign(process.env, baseMonitorEnv, {
    MIN_TRADE_SIZE: "75",
  });

  const config = loadMonitorConfig();
  assert.equal(config.presetName, "custom");
  assert.equal(config.minTradeSizeUsd, 75);
});

test("print-effective-config includes preset and key subset", () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "classic",
    PRINT_EFFECTIVE_CONFIG: "true",
  });

  const originalInfo = console.info;
  const lines: string[] = [];
  console.info = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    loadArbConfig();
  } finally {
    console.info = originalInfo;
  }

  const output = lines.join("\n");
  assert.match(output, /"preset":\s*"classic"/);
  assert.match(output, /scanIntervalMs/);
});

test("API credentials are used even when CLOB_DERIVE_CREDS=true (arb)", () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: "micro",
    CLOB_DERIVE_CREDS: "true",
  });

  const config = loadArbConfig();
  // Credentials should be loaded and marked as complete
  assert.equal(config.polymarketApiKey, "key");
  assert.equal(config.polymarketApiSecret, "secret");
  assert.equal(config.polymarketApiPassphrase, "passphrase");
  assert.equal(config.clobCredsComplete, true);
  assert.equal(config.clobDeriveEnabled, true);
  // With credentials provided, clobCredsChecklist should show them as present
  assert.equal(config.clobCredsChecklist.key.present, true);
  assert.equal(config.clobCredsChecklist.secret.present, true);
  assert.equal(config.clobCredsChecklist.passphrase.present, true);
});

test("API credentials are used even when CLOB_DERIVE_CREDS=true (monitor)", () => {
  resetEnv();
  Object.assign(process.env, baseMonitorEnv, {
    MONITOR_PRESET: "active",
    CLOB_DERIVE_CREDS: "true",
  });

  const config = loadMonitorConfig();
  // Credentials should be loaded and marked as complete
  assert.equal(config.polymarketApiKey, "key");
  assert.equal(config.polymarketApiSecret, "secret");
  assert.equal(config.polymarketApiPassphrase, "passphrase");
  assert.equal(config.clobCredsComplete, true);
  assert.equal(config.clobDeriveEnabled, true);
  // With credentials provided, clobCredsChecklist should show them as present
  assert.equal(config.clobCredsChecklist.key.present, true);
  assert.equal(config.clobCredsChecklist.secret.present, true);
  assert.equal(config.clobCredsChecklist.passphrase.present, true);
});

test("credentials marked as ignored only when derive=true AND no credentials provided", () => {
  resetEnv();
  Object.assign(process.env, {
    RPC_URL: "http://localhost:8545",
    PRIVATE_KEY: "0x" + "11".repeat(32),
    MODE: "arb",
    ARB_PRESET: "micro",
    CLOB_DERIVE_CREDS: "true",
    // No API credentials provided
  });

  const config = loadArbConfig();
  // Without credentials, clobCredsComplete should be false
  assert.equal(config.clobCredsComplete, false);
  // And checklist should show not present
  assert.equal(config.clobCredsChecklist.key.present, false);
  assert.equal(config.clobCredsChecklist.secret.present, false);
  assert.equal(config.clobCredsChecklist.passphrase.present, false);
  // deriveEnabled should be true
  assert.equal(config.clobCredsChecklist.deriveEnabled, true);
});
