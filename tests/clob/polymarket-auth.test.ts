import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import {
  PolymarketAuth,
  createPolymarketAuthFromEnv,
} from "../../src/clob/polymarket-auth";

// Test private key (DO NOT use in production - this is a throwaway test key)
const TEST_PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("PolymarketAuth", () => {
  describe("constructor", () => {
    it("initializes with a valid private key", () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
      });
      assert.ok(auth.getAddress());
      assert.strictEqual(auth.getSignatureType(), 0); // Default EOA
      assert.strictEqual(auth.hasCredentials(), false);
    });

    it("initializes with custom signature type", () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
        signatureType: 2,
      });
      assert.strictEqual(auth.getSignatureType(), 2);
    });

    it("throws error when private key is missing", () => {
      assert.throws(
        () =>
          new PolymarketAuth({
            privateKey: "",
          }),
        /requires a privateKey/,
      );
    });

    it("accepts private key without 0x prefix", () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY.slice(2), // Remove 0x prefix
      });
      assert.ok(auth.getAddress());
    });
  });

  describe("getApiCredentials", () => {
    it("uses provided credentials when available", async () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
        passphrase: "test-passphrase",
      });

      const creds = await auth.getApiCredentials();

      assert.strictEqual(creds.key, "test-api-key");
      assert.strictEqual(creds.secret, "test-api-secret");
      assert.strictEqual(creds.passphrase, "test-passphrase");
      assert.strictEqual(auth.hasCredentials(), true);
    });

    it("caches credentials after first fetch", async () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
        passphrase: "test-passphrase",
      });

      // First call
      const creds1 = await auth.getApiCredentials();
      assert.strictEqual(auth.hasCredentials(), true);

      // Second call should return cached credentials
      const creds2 = await auth.getApiCredentials();
      assert.deepStrictEqual(creds1, creds2);
    });
  });

  describe("reset", () => {
    it("clears cached credentials", async () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
        passphrase: "test-passphrase",
      });

      // Get credentials to cache them
      await auth.getApiCredentials();
      assert.strictEqual(auth.hasCredentials(), true);

      // Reset
      auth.reset();
      assert.strictEqual(auth.hasCredentials(), false);
    });
  });

  describe("authenticate", () => {
    it("returns success when credentials are provided", async () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
        passphrase: "test-passphrase",
      });

      const result = await auth.authenticate();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.derived, false); // Provided, not derived
      assert.ok(result.creds);
      assert.strictEqual(result.creds.key, "test-api-key");
      assert.strictEqual(result.signatureType, 0);
    });
  });

  describe("getAddress", () => {
    it("returns consistent address", () => {
      const auth = new PolymarketAuth({
        privateKey: TEST_PRIVATE_KEY,
      });

      const address1 = auth.getAddress();
      const address2 = auth.getAddress();

      assert.strictEqual(address1, address2);
      assert.ok(address1.startsWith("0x"));
      assert.strictEqual(address1.length, 42);
    });
  });
});

describe("createPolymarketAuthFromEnv", () => {
  beforeEach(() => {
    // Clean up env vars
    delete process.env.PRIVATE_KEY;
    delete process.env.POLYMARKET_API_KEY;
    delete process.env.POLYMARKET_API_SECRET;
    delete process.env.POLYMARKET_API_PASSPHRASE;
    delete process.env.POLYMARKET_SIGNATURE_TYPE;
    delete process.env.POLYMARKET_PROXY_ADDRESS;
    delete process.env.POLY_API_KEY;
    delete process.env.POLY_SECRET;
    delete process.env.POLY_PASSPHRASE;
    delete process.env.CLOB_API_KEY;
    delete process.env.CLOB_API_SECRET;
    delete process.env.CLOB_API_PASSPHRASE;
    delete process.env.CLOB_SIGNATURE_TYPE;
    delete process.env.CLOB_FUNDER_ADDRESS;
  });

  it("throws when PRIVATE_KEY is not set", () => {
    assert.throws(() => createPolymarketAuthFromEnv(), /PRIVATE_KEY/);
  });

  it("creates auth from PRIVATE_KEY env var", () => {
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;

    const auth = createPolymarketAuthFromEnv();

    assert.ok(auth.getAddress());
    assert.strictEqual(auth.getSignatureType(), 0);
  });

  it("reads POLYMARKET_API_KEY and friends", () => {
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.POLYMARKET_API_KEY = "poly-key";
    process.env.POLYMARKET_API_SECRET = "poly-secret";
    process.env.POLYMARKET_API_PASSPHRASE = "poly-pass";

    const auth = createPolymarketAuthFromEnv();

    // Should have credentials ready (not yet cached)
    assert.strictEqual(auth.hasCredentials(), false);
  });

  it("reads POLYMARKET_SIGNATURE_TYPE", () => {
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.POLYMARKET_SIGNATURE_TYPE = "2";

    const auth = createPolymarketAuthFromEnv();

    assert.strictEqual(auth.getSignatureType(), 2);
  });

  it("falls back to CLOB_* env vars", () => {
    process.env.PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.CLOB_SIGNATURE_TYPE = "1";

    const auth = createPolymarketAuthFromEnv();

    assert.strictEqual(auth.getSignatureType(), 1);
  });
});
