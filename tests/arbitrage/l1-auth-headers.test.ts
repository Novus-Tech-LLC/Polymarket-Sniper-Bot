import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  buildL1Headers,
  loadL1AuthConfig,
  logL1AuthDiagnostics,
} from "../../src/utils/l1-auth-headers.util";

test("buildL1Headers creates correct header structure", async () => {
  const privateKey =
    "0x1234567890123456789012345678901234567890123456789012345678901234";
  const wallet = new Wallet(privateKey);
  const chainId = 137; // Polygon

  const headers = await buildL1Headers(
    wallet,
    chainId,
    {
      method: "GET",
      pathWithQuery: "/auth/derive-api-key",
    },
    {},
  );

  assert.ok(headers.POLY_ADDRESS, "POLY_ADDRESS should be present");
  assert.ok(headers.POLY_SIGNATURE, "POLY_SIGNATURE should be present");
  assert.ok(headers.POLY_TIMESTAMP, "POLY_TIMESTAMP should be present");
  assert.ok(headers.POLY_NONCE, "POLY_NONCE should be present");

  assert.equal(headers.POLY_ADDRESS, wallet.address);
  assert.equal(headers.POLY_NONCE, "0");

  // Timestamp should be a recent Unix timestamp
  const timestamp = parseInt(headers.POLY_TIMESTAMP, 10);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(timestamp >= now - 5 && timestamp <= now + 5);

  // Signature should be a hex string starting with 0x
  assert.ok(headers.POLY_SIGNATURE.startsWith("0x"));
  assert.ok(headers.POLY_SIGNATURE.length > 130); // EIP-712 signature is ~132 chars
});

test("buildL1Headers logs debug info when enabled", async () => {
  const privateKey =
    "0x1234567890123456789012345678901234567890123456789012345678901234";
  const wallet = new Wallet(privateKey);
  const chainId = 137;

  const logs: string[] = [];
  const logger = {
    info: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    error: (msg: string) => logs.push(msg),
    debug: (msg: string) => logs.push(msg),
  };

  await buildL1Headers(
    wallet,
    chainId,
    {
      method: "POST",
      pathWithQuery: "/auth/api-key",
      body: '{"test":"data"}',
    },
    { debugHttpHeaders: true },
    logger,
  );

  // Check that debug logs were created
  const debugLog = logs.join("\n");
  assert.ok(debugLog.includes("[L1Auth] HTTP Request Debug:"));
  assert.ok(debugLog.includes("Method: POST"));
  assert.ok(debugLog.includes("Path: /auth/api-key"));
  assert.ok(debugLog.includes("Body:"));
  assert.ok(debugLog.includes("[L1Auth] HTTP Headers (redacted):"));
  assert.ok(debugLog.includes("POLY_ADDRESS:"));
  assert.ok(debugLog.includes("POLY_SIGNATURE:"));
  assert.ok(debugLog.includes("POLY_TIMESTAMP:"));
  assert.ok(debugLog.includes("POLY_NONCE:"));

  // Check that signature is redacted
  assert.ok(
    debugLog.match(/POLY_SIGNATURE: \w{4}\.\.\.\w{4}/),
    "Signature should be redacted",
  );
});

test("loadL1AuthConfig loads from environment variables", () => {
  const originalEnv = { ...process.env };

  try {
    process.env.CLOB_L1_ADDRESS_MODE = "signer";
    process.env.CLOB_FORCE_SIGNATURE_TYPE = "2";
    process.env.DEBUG_HTTP_HEADERS = "true";

    const config = loadL1AuthConfig();

    assert.equal(config.addressMode, "signer");
    assert.equal(config.forceSignatureType, 2);
    assert.equal(config.debugHttpHeaders, true);
  } finally {
    // Restore environment
    process.env = originalEnv;
  }
});

test("loadL1AuthConfig handles missing environment variables", () => {
  const originalEnv = { ...process.env };

  try {
    delete process.env.CLOB_L1_ADDRESS_MODE;
    delete process.env.CLOB_FORCE_SIGNATURE_TYPE;
    delete process.env.DEBUG_HTTP_HEADERS;

    const config = loadL1AuthConfig();

    assert.equal(config.addressMode, undefined);
    assert.equal(config.forceSignatureType, undefined);
    assert.equal(config.debugHttpHeaders, undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("loadL1AuthConfig validates signature type values", () => {
  const originalEnv = { ...process.env };

  try {
    // Valid values
    process.env.CLOB_FORCE_SIGNATURE_TYPE = "0";
    assert.equal(loadL1AuthConfig().forceSignatureType, 0);

    process.env.CLOB_FORCE_SIGNATURE_TYPE = "1";
    assert.equal(loadL1AuthConfig().forceSignatureType, 1);

    process.env.CLOB_FORCE_SIGNATURE_TYPE = "2";
    assert.equal(loadL1AuthConfig().forceSignatureType, 2);

    // Invalid values
    process.env.CLOB_FORCE_SIGNATURE_TYPE = "3";
    assert.equal(loadL1AuthConfig().forceSignatureType, undefined);

    process.env.CLOB_FORCE_SIGNATURE_TYPE = "invalid";
    assert.equal(loadL1AuthConfig().forceSignatureType, undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("logL1AuthDiagnostics logs configuration", () => {
  const logs: string[] = [];
  const logger = {
    info: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    error: (msg: string) => logs.push(msg),
    debug: (msg: string) => logs.push(msg),
  };

  logL1AuthDiagnostics(
    {
      addressMode: "signer",
      forceSignatureType: 2,
      debugHttpHeaders: true,
    },
    "0x1234567890123456789012345678901234567890",
    "0x1234567890123456789012345678901234567890",
    logger,
  );

  const logOutput = logs.join("\n");
  assert.ok(logOutput.includes("[L1Auth] Configuration:"));
  assert.ok(logOutput.includes("addressMode: signer"));
  assert.ok(logOutput.includes("forceSignatureType: 2"));
  assert.ok(logOutput.includes("debugHttpHeaders: true"));
  assert.ok(logOutput.includes("signerAddress:"));
  assert.ok(logOutput.includes("effectiveAddress:"));
});

test("logL1AuthDiagnostics warns on address mismatch", () => {
  const logs: string[] = [];
  const logger = {
    info: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    error: (msg: string) => logs.push(msg),
    debug: (msg: string) => logs.push(msg),
  };

  logL1AuthDiagnostics(
    {},
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    logger,
  );

  const logOutput = logs.join("\n");
  assert.ok(logOutput.includes("WARNING"));
  assert.ok(logOutput.includes("differs from effectiveAddress"));
});
