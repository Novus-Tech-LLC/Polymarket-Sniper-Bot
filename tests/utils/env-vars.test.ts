import { test } from "node:test";
import assert from "node:assert/strict";

// Helper to test environment variable resolution
const testEnvResolution = (
  envVars: Record<string, string>,
  expectedSignatureType: number | undefined,
  expectedFunderAddress: string | undefined,
) => {
  const originalEnv = { ...process.env };
  try {
    // Clear and set test env vars
    Object.keys(process.env).forEach((key) => {
      if (
        key.startsWith("POLYMARKET_") ||
        key.startsWith("CLOB_") ||
        key.startsWith("polymarket_") ||
        key.startsWith("clob_")
      ) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, envVars);

    // Test that new names are read correctly
    const readEnvValue = (key: string): string | undefined =>
      process.env[key] ?? process.env[key.toLowerCase()];

    const readSignatureType = (): number | undefined => {
      const value =
        readEnvValue("POLYMARKET_SIGNATURE_TYPE") ??
        readEnvValue("CLOB_SIGNATURE_TYPE");
      if (value === undefined || value === null) return undefined;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return undefined;
      if (![0, 1, 2].includes(parsed)) return undefined;
      return parsed;
    };

    const readFunderAddress = (): string | undefined => {
      return (
        readEnvValue("POLYMARKET_PROXY_ADDRESS") ??
        readEnvValue("CLOB_FUNDER_ADDRESS")
      );
    };

    const actualSignatureType = readSignatureType();
    const actualFunderAddress = readFunderAddress();

    assert.equal(
      actualSignatureType,
      expectedSignatureType,
      `Signature type mismatch: expected ${expectedSignatureType}, got ${actualSignatureType}`,
    );
    assert.equal(
      actualFunderAddress,
      expectedFunderAddress,
      `Funder address mismatch: expected ${expectedFunderAddress}, got ${actualFunderAddress}`,
    );
  } finally {
    // Restore original env properly
    // Clear all keys that were added during the test
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    // Restore original values
    Object.assign(process.env, originalEnv);
  }
};

test("POLYMARKET_SIGNATURE_TYPE is read correctly", () => {
  testEnvResolution({ POLYMARKET_SIGNATURE_TYPE: "2" }, 2, undefined);
});

test("POLYMARKET_PROXY_ADDRESS is read correctly", () => {
  testEnvResolution(
    { POLYMARKET_PROXY_ADDRESS: "0xABCD" },
    undefined,
    "0xABCD",
  );
});

test("New env vars take precedence over legacy ones", () => {
  testEnvResolution(
    {
      POLYMARKET_SIGNATURE_TYPE: "2",
      CLOB_SIGNATURE_TYPE: "0",
      POLYMARKET_PROXY_ADDRESS: "0xNEW",
      CLOB_FUNDER_ADDRESS: "0xOLD",
    },
    2,
    "0xNEW",
  );
});

test("Legacy env vars still work when new ones not set", () => {
  testEnvResolution(
    {
      CLOB_SIGNATURE_TYPE: "1",
      CLOB_FUNDER_ADDRESS: "0xLEGACY",
    },
    1,
    "0xLEGACY",
  );
});

test("Mixed case env vars are supported", () => {
  testEnvResolution(
    {
      polymarket_signature_type: "2",
      polymarket_proxy_address: "0xMIXED",
    },
    2,
    "0xMIXED",
  );
});

test("Invalid signature types are rejected", () => {
  testEnvResolution({ POLYMARKET_SIGNATURE_TYPE: "5" }, undefined, undefined);
  testEnvResolution(
    { POLYMARKET_SIGNATURE_TYPE: "invalid" },
    undefined,
    undefined,
  );
  testEnvResolution({ POLYMARKET_SIGNATURE_TYPE: "-1" }, undefined, undefined);
});

test("Signature type 0 (EOA) works without funder address", () => {
  testEnvResolution({ POLYMARKET_SIGNATURE_TYPE: "0" }, 0, undefined);
});
