import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadMonitorConfig } from "../../src/config/loadConfig";

const baseEnv = {
  TARGET_ADDRESSES: "0xabc",
  PUBLIC_KEY: "0x" + "22".repeat(20),
  PRIVATE_KEY: "0x" + "33".repeat(32),
  RPC_URL: "http://localhost:8545",
  POLY_API_KEY: "key",
  POLY_PASSPHRASE: "passphrase",
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

test("missing secret with derive enabled (default) does NOT trigger detect-only mode", () => {
  // With clobDeriveEnabled=true (new default), missing credentials should
  // trigger auto-derivation, not detect-only mode (pmxt-style behavior)
  resetEnv();
  Object.assign(process.env, baseEnv);

  const config = loadMonitorConfig();
  assert.equal(config.clobCredsComplete, false);
  // Since clobDeriveEnabled defaults to true, detectOnly should be false
  assert.equal(config.clobDeriveEnabled, true);
  assert.equal(config.detectOnly, false);
});

test("missing secret with derive disabled triggers detect-only mode", () => {
  // Explicitly disabling derive with incomplete creds should trigger detect-only
  resetEnv();
  Object.assign(process.env, {
    ...baseEnv,
    CLOB_DERIVE_CREDS: "false",
  });

  const config = loadMonitorConfig();
  assert.equal(config.clobCredsComplete, false);
  assert.equal(config.clobDeriveEnabled, false);
  assert.equal(config.detectOnly, true);
});
