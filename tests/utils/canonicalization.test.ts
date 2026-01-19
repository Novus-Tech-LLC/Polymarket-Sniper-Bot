/**
 * Tests for CLOB request canonicalization invariants
 *
 * These tests verify that the signed path matches the actual HTTP request path,
 * which is critical for authentication to succeed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalQuery,
  buildSignedPath,
} from "../../src/utils/query-string.util";

describe("CLOB Request Canonicalization", () => {
  describe("canonicalQuery", () => {
    it("should sort keys alphabetically", () => {
      const params = {
        signature_type: 0,
        asset_type: "COLLATERAL",
      };

      const { queryString, keys } = canonicalQuery(params);

      assert.deepEqual(keys, ["asset_type", "signature_type"]);
      assert.equal(queryString, "asset_type=COLLATERAL&signature_type=0");
    });

    it("should filter out undefined values", () => {
      const params = {
        asset_type: "COLLATERAL",
        signature_type: undefined,
        foo: "bar",
      };

      const { queryString, keys } = canonicalQuery(params);

      assert.deepEqual(keys, ["asset_type", "foo"]);
      assert.equal(queryString, "asset_type=COLLATERAL&foo=bar");
    });

    it("should URL-encode special characters", () => {
      const params = {
        key1: "value with spaces",
        key2: "value&with=special",
      };

      const { queryString } = canonicalQuery(params);

      assert.equal(
        queryString,
        "key1=value%20with%20spaces&key2=value%26with%3Dspecial",
      );
    });

    it("should return empty string for empty params", () => {
      const { queryString, keys } = canonicalQuery({});

      assert.equal(queryString, "");
      assert.deepEqual(keys, []);
    });

    it("should return empty string for undefined params", () => {
      const { queryString, keys } = canonicalQuery(undefined);

      assert.equal(queryString, "");
      assert.deepEqual(keys, []);
    });
  });

  describe("buildSignedPath", () => {
    it("should append query string to path", () => {
      const params = {
        asset_type: "COLLATERAL",
        signature_type: 0,
      };

      const { signedPath, paramsKeys } = buildSignedPath(
        "/balance-allowance",
        params,
      );

      assert.equal(
        signedPath,
        "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
      );
      assert.deepEqual(paramsKeys, ["asset_type", "signature_type"]);
    });

    it("should return path without query for empty params", () => {
      const { signedPath, paramsKeys } = buildSignedPath(
        "/balance-allowance",
        {},
      );

      assert.equal(signedPath, "/balance-allowance");
      assert.deepEqual(paramsKeys, []);
    });

    it("should handle path without leading slash", () => {
      const params = {
        asset_type: "COLLATERAL",
      };

      const { signedPath } = buildSignedPath("balance-allowance", params);

      assert.equal(signedPath, "balance-allowance?asset_type=COLLATERAL");
    });
  });

  describe("Canonicalization Invariant", () => {
    /**
     * The critical invariant: What we sign must match what we send.
     * This test verifies that the canonical query string is deterministic
     * and produces the same result every time for the same input.
     */
    it("should produce identical results for same params", () => {
      const params = {
        signature_type: 0,
        asset_type: "COLLATERAL",
      };

      const result1 = canonicalQuery(params);
      const result2 = canonicalQuery(params);

      assert.equal(result1.queryString, result2.queryString);
      assert.deepEqual(result1.keys, result2.keys);
    });

    /**
     * Verify that key order doesn't affect the canonical output.
     * Both objects should produce the same canonical query string.
     */
    it("should produce same result regardless of key order", () => {
      const params1 = {
        asset_type: "COLLATERAL",
        signature_type: 0,
      };

      const params2 = {
        signature_type: 0,
        asset_type: "COLLATERAL",
      };

      const result1 = canonicalQuery(params1);
      const result2 = canonicalQuery(params2);

      assert.equal(result1.queryString, result2.queryString);
      assert.deepEqual(result1.keys, result2.keys);
    });

    /**
     * Verify that signed paths are consistent for getBalanceAllowance params.
     * This is the exact use case that was causing 401 errors.
     */
    it("should produce consistent signed path for balance-allowance", () => {
      const params = {
        asset_type: "COLLATERAL",
        signature_type: 0,
      };

      const { signedPath: path1 } = buildSignedPath(
        "/balance-allowance",
        params,
      );
      const { signedPath: path2 } = buildSignedPath(
        "/balance-allowance",
        params,
      );

      assert.equal(path1, path2);
      assert.equal(
        path1,
        "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
      );
    });

    /**
     * Verify number values are converted to strings correctly.
     */
    it("should handle numeric values correctly", () => {
      const params = {
        signature_type: 0,
        token_id: 12345,
        price: 0.5,
      };

      const { queryString } = canonicalQuery(params);

      assert.equal(queryString, "price=0.5&signature_type=0&token_id=12345");
    });

    /**
     * Verify boolean values are converted to strings correctly.
     */
    it("should handle boolean values correctly", () => {
      const params = {
        active: true,
        closed: false,
      };

      const { queryString } = canonicalQuery(params);

      assert.equal(queryString, "active=true&closed=false");
    });
  });
});
