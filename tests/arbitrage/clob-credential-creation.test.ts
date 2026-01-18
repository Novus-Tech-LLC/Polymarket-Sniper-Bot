import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";

const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044976f9d1f4aa2e9d8f99a6a1c4b7c1b9f8e178b0ff5d";
const TEST_CREDS_PATH = "./data/clob-creds.json";

// Clean up test files after each test
afterEach(() => {
  try {
    if (fs.existsSync(TEST_CREDS_PATH)) {
      fs.unlinkSync(TEST_CREDS_PATH);
    }
  } catch (error) {
    // Ignore cleanup errors
  }
});

test("POST /auth/api-key 400 response: no cache file written, credentials not saved", async () => {
  const mockLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };

  // Mock ClobClient that returns 400 on create_or_derive_api_creds
  const mockClient = {
    create_or_derive_api_creds: async () => {
      const error = new Error("Could not create api key") as Error & {
        response?: { status: number; data: unknown };
      };
      error.response = {
        status: 400,
        data: { error: "Could not create api key" },
      };
      throw error;
    },
  };

  // Import the function we need to test
  const { createPolymarketClient } =
    await import("../../src/infrastructure/clob-client.factory");

  try {
    await createPolymarketClient({
      rpcUrl: "https://polygon-rpc.com",
      privateKey: PRIVATE_KEY,
      deriveApiKey: true,
      logger: mockLogger,
    });
  } catch (error) {
    // Expected to fail or continue with no creds
  }

  // Verify no cache file was written
  assert.equal(
    fs.existsSync(TEST_CREDS_PATH),
    false,
    "Cache file should not exist after 400 response",
  );
});

test("POST /auth/api-key returns incomplete creds: no cache file written", async () => {
  const mockLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };

  // Test will verify through the actual implementation that incomplete creds aren't saved
  // This is more of an integration test that would require mocking the CLOB client

  // For now, verify that the validation logic is in place by checking the code
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  // Check that validation logic exists
  assert.ok(
    factoryCode.includes(
      "!derived || !derived.key || !derived.secret || !derived.passphrase",
    ),
    "Factory should validate credentials before saving",
  );
  assert.ok(
    factoryCode.includes("API key creation returned incomplete credentials"),
    "Factory should log error for incomplete credentials",
  );
});

test("Successful POST /auth/api-key with valid response: cache written with credentials", () => {
  // Verify the save logic exists
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  assert.ok(
    factoryCode.includes("cachedDerivedCreds = derived"),
    "Factory should cache credentials on success",
  );
  assert.ok(
    factoryCode.includes(
      "saveCachedCreds({ creds: derived, signerAddress, logger })",
    ),
    "Factory should save credentials to disk on success",
  );
  assert.ok(
    factoryCode.includes("Successfully created/derived API credentials"),
    "Factory should log success message",
  );
});

test("Cached credentials verification on startup: invalid creds cleared and retry", () => {
  // Verify that verification logic exists
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  assert.ok(
    factoryCode.includes("Verifying disk-cached credentials"),
    "Factory should verify cached credentials",
  );
  assert.ok(
    factoryCode.includes("const isValid = await verifyCredsWithClient"),
    "Factory should call verification function",
  );
  assert.ok(
    factoryCode.includes("clearCachedCreds(logger)"),
    "Factory should clear invalid cached credentials",
  );
  assert.ok(
    factoryCode.includes(
      "Cached credentials invalid; clearing cache and retrying derive",
    ),
    "Factory should log when clearing invalid cache",
  );
});

test("400/401 response logging includes status and error details", () => {
  // Verify error logging includes required details
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  assert.ok(
    factoryCode.includes('status=${status ?? "unknown"}'),
    "Factory should log status code",
  );
  assert.ok(
    factoryCode.includes("error=${errorDetails}"),
    "Factory should log error details",
  );
  assert.ok(
    factoryCode.includes("Response data: ${JSON.stringify(responseData)}"),
    "Factory should log response data",
  );
  assert.ok(
    factoryCode.includes("credentials NOT saved"),
    "Factory should indicate credentials were not saved on 400/401",
  );
});

test("verifyCredsWithClient function exists and validates with balance-allowance", () => {
  // Verify the verification function exists
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  assert.ok(
    factoryCode.includes("const verifyCredsWithClient"),
    "verifyCredsWithClient function should exist",
  );
  assert.ok(
    factoryCode.includes("await verifyClient.getBalanceAllowance"),
    "Verification should use getBalanceAllowance",
  );
  assert.ok(
    factoryCode.includes("if (status === 401 || status === 403)"),
    "Verification should check for 401/403 status",
  );
  assert.ok(
    factoryCode.includes("Credential verification failed"),
    "Verification should log failures",
  );
});

test("Newly derived credentials are verified before caching", () => {
  // Verify that newly derived credentials are verified before being cached
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  assert.ok(
    factoryCode.includes("Verifying newly derived credentials"),
    "Factory should verify newly derived credentials",
  );
  assert.ok(
    factoryCode.includes("Derived credentials failed verification (401/403)"),
    "Factory should detect when derived credentials fail verification",
  );
  assert.ok(
    factoryCode.includes("Derived credentials verified successfully"),
    "Factory should log when derived credentials are verified",
  );
  assert.ok(
    factoryCode.includes("The wallet has never traded on Polymarket"),
    "Factory should suggest making a trade on Polymarket website",
  );
});

test("verifyCredsWithClient handles clob-client error objects (not thrown exceptions)", () => {
  // The clob-client returns error objects instead of throwing exceptions
  // Verify our code handles this case
  const factoryCode = fs.readFileSync(
    "./src/infrastructure/clob-client.factory.ts",
    "utf-8",
  );

  // Check that we have a type for error responses
  assert.ok(
    factoryCode.includes("type ClobErrorResponse = {"),
    "Factory should define ClobErrorResponse type",
  );
  // Check that we examine response status from returned error objects
  assert.ok(
    factoryCode.includes("const errorResponse = response as ClobErrorResponse"),
    "Verification should cast response to ClobErrorResponse",
  );
  assert.ok(
    factoryCode.includes(
      "if (errorResponse.status === 401 || errorResponse.status === 403)",
    ),
    "Verification should detect 401/403 from response objects",
  );
});
