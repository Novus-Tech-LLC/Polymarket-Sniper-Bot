import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { buildL1Headers } from "../../src/utils/l1-auth-headers.util";
import { createL2Headers } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";

const TEST_PRIVATE_KEY =
  "0x1234567890123456789012345678901234567890123456789012345678901234";

test("L1 headers include only L1-specific headers", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
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

  // L1 headers MUST have these
  assert.ok(headers.POLY_ADDRESS, "POLY_ADDRESS must be present");
  assert.ok(headers.POLY_SIGNATURE, "POLY_SIGNATURE must be present");
  assert.ok(headers.POLY_TIMESTAMP, "POLY_TIMESTAMP must be present");
  assert.ok(headers.POLY_NONCE, "POLY_NONCE must be present");

  // L1 headers MUST NOT have these (L2-only)
  const headersAny = headers as Record<string, unknown>;
  assert.equal(
    headersAny.POLY_API_KEY,
    undefined,
    "POLY_API_KEY must NOT be present in L1 headers"
  );
  assert.equal(
    headersAny.POLY_PASSPHRASE,
    undefined,
    "POLY_PASSPHRASE must NOT be present in L1 headers"
  );

  // Verify header count (should be exactly 4)
  const headerKeys = Object.keys(headers);
  assert.equal(
    headerKeys.length,
    4,
    "L1 headers should have exactly 4 keys"
  );
});

test("L2 headers include both L1 and L2-specific headers", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: "test-api-key",
    secret: "dGVzdC1zZWNyZXQ=", // base64 encoded "test-secret"
    passphrase: "test-passphrase",
  };

  const headers = await createL2Headers(
    wallet,
    creds,
    {
      method: "GET",
      requestPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    },
    1700000000, // Fixed timestamp for determinism
  );

  // L2 headers MUST have all 5 headers
  assert.ok(headers.POLY_ADDRESS, "POLY_ADDRESS must be present");
  assert.ok(headers.POLY_SIGNATURE, "POLY_SIGNATURE must be present");
  assert.ok(headers.POLY_TIMESTAMP, "POLY_TIMESTAMP must be present");
  assert.ok(headers.POLY_API_KEY, "POLY_API_KEY must be present");
  assert.ok(headers.POLY_PASSPHRASE, "POLY_PASSPHRASE must be present");

  // L2 headers MUST NOT have POLY_NONCE
  const headersAny = headers as Record<string, unknown>;
  assert.equal(
    headersAny.POLY_NONCE,
    undefined,
    "POLY_NONCE must NOT be present in L2 headers"
  );

  // Verify specific values
  assert.equal(headers.POLY_API_KEY, creds.key);
  assert.equal(headers.POLY_PASSPHRASE, creds.passphrase);
  assert.equal(headers.POLY_TIMESTAMP, "1700000000");

  // Verify header count (should be exactly 5)
  const headerKeys = Object.keys(headers);
  assert.equal(
    headerKeys.length,
    5,
    "L2 headers should have exactly 5 keys"
  );
});

test("L1 signature is EIP-712 format (starts with 0x)", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const chainId = 137;

  const headers = await buildL1Headers(
    wallet,
    chainId,
    {
      method: "POST",
      pathWithQuery: "/auth/api-key",
    },
    {},
  );

  // EIP-712 signatures should start with 0x and be hex
  assert.ok(
    headers.POLY_SIGNATURE.startsWith("0x"),
    "L1 signature should start with 0x"
  );
  assert.ok(
    /^0x[0-9a-fA-F]+$/.test(headers.POLY_SIGNATURE),
    "L1 signature should be hex format"
  );
  assert.ok(
    headers.POLY_SIGNATURE.length > 130,
    "L1 signature should be ~132 chars (EIP-712)"
  );
});

test("L2 signature is HMAC format (base64url)", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: "test-api-key",
    secret: "dGVzdC1zZWNyZXQ=",
    passphrase: "test-passphrase",
  };

  const headers = await createL2Headers(
    wallet,
    creds,
    {
      method: "GET",
      requestPath: "/balance-allowance",
    },
    1700000000,
  );

  // HMAC signatures should be base64url (NOT start with 0x)
  assert.ok(
    !headers.POLY_SIGNATURE.startsWith("0x"),
    "L2 signature should NOT start with 0x"
  );

  // base64url uses [-_A-Za-z0-9=] characters
  assert.ok(
    /^[A-Za-z0-9_\-=]+$/.test(headers.POLY_SIGNATURE),
    "L2 signature should be base64url format"
  );

  // HMAC-SHA256 base64url signature is typically 43-44 chars
  assert.ok(
    headers.POLY_SIGNATURE.length >= 40 &&
      headers.POLY_SIGNATURE.length <= 50,
    "L2 signature should be typical HMAC length"
  );
});

test("L1 POLY_NONCE is always 0", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const chainId = 137;

  // Call multiple times to verify nonce doesn't increment
  for (let i = 0; i < 3; i++) {
    const headers = await buildL1Headers(
      wallet,
      chainId,
      {
        method: "GET",
        pathWithQuery: "/auth/derive-api-key",
      },
      {},
    );

    assert.equal(
      headers.POLY_NONCE,
      "0",
      "L1 POLY_NONCE should always be 0"
    );
  }
});

test("L1 and L2 use same POLY_ADDRESS for EOA mode", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const chainId = 137;
  const creds: ApiKeyCreds = {
    key: "test-api-key",
    secret: "dGVzdC1zZWNyZXQ=",
    passphrase: "test-passphrase",
  };

  const l1Headers = await buildL1Headers(
    wallet,
    chainId,
    {
      method: "GET",
      pathWithQuery: "/auth/derive-api-key",
    },
    {},
  );

  const l2Headers = await createL2Headers(
    wallet,
    creds,
    {
      method: "GET",
      requestPath: "/balance-allowance",
    },
    1700000000,
  );

  // In EOA mode, both should use the same address
  assert.equal(
    l1Headers.POLY_ADDRESS,
    l2Headers.POLY_ADDRESS,
    "L1 and L2 should use same address in EOA mode"
  );
  assert.equal(
    l1Headers.POLY_ADDRESS,
    wallet.address,
    "Address should match wallet address"
  );
});

test("L2 headers do not include undefined or null values", async () => {
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: "test-api-key",
    secret: "dGVzdC1zZWNyZXQ=",
    passphrase: "test-passphrase",
  };

  const headers = await createL2Headers(
    wallet,
    creds,
    {
      method: "GET",
      requestPath: "/balance-allowance",
    },
    1700000000,
  );

  // Check that no header value is undefined or null
  const headersAny = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(headersAny)) {
    assert.notEqual(value, undefined, `Header ${key} should not be undefined`);
    assert.notEqual(value, null, `Header ${key} should not be null`);
    assert.notEqual(
      value,
      "",
      `Header ${key} should not be empty string`
    );
  }
});
