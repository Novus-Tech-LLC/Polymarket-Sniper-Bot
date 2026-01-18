import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthMessageString } from "../../src/clob/diagnostics";
import { buildSignedPath } from "../../src/utils/query-string.util";

test("L2 signature message includes query string for GET requests", () => {
  const timestamp = 1700000000;
  const method = "GET";
  const endpoint = "/balance-allowance";
  const params = {
    asset_type: "COLLATERAL",
    signature_type: 0,
  };

  // Build signed path with query params
  const { signedPath } = buildSignedPath(endpoint, params);

  // Build auth message
  const message = buildAuthMessageString({
    timestamp,
    method,
    path: signedPath,
  });

  // Verify query string is included
  assert.ok(
    signedPath.includes("?"),
    "Signed path should include query string"
  );
  assert.ok(
    signedPath.includes("asset_type="),
    "Signed path should include asset_type parameter"
  );
  assert.ok(
    signedPath.includes("signature_type="),
    "Signed path should include signature_type parameter"
  );

  // Verify message format: timestamp + method + path (with query)
  const expectedMessage = `${timestamp}${method}${signedPath}`;
  assert.equal(message, expectedMessage);

  // Verify no body is appended for GET
  assert.ok(!message.endsWith("undefined"));
  assert.ok(!message.endsWith("null"));
});

test("L2 signature message includes body for POST requests", () => {
  const timestamp = 1700000000;
  const method = "POST";
  const path = "/auth/api-key";
  const body = JSON.stringify({ nonce: 0 });

  const message = buildAuthMessageString({
    timestamp,
    method,
    path,
    body,
  });

  // Verify message format: timestamp + method + path + body
  const expectedMessage = `${timestamp}${method}${path}${body}`;
  assert.equal(message, expectedMessage);
});

test("L2 signature message excludes body when undefined", () => {
  const timestamp = 1700000000;
  const method = "GET";
  const path = "/trades";

  const message = buildAuthMessageString({
    timestamp,
    method,
    path,
    body: undefined,
  });

  // Verify message format: timestamp + method + path (no body)
  const expectedMessage = `${timestamp}${method}${path}`;
  assert.equal(message, expectedMessage);
  assert.ok(!message.includes("undefined"));
});

test("buildSignedPath sorts query parameters alphabetically", () => {
  const endpoint = "/balance-allowance";
  const params = {
    signature_type: 2,
    asset_type: "COLLATERAL",
    zzz_last: "value",
    aaa_first: "value",
  };

  const { signedPath, paramsKeys } = buildSignedPath(endpoint, params);

  // Verify keys are sorted
  assert.deepEqual(paramsKeys, [
    "aaa_first",
    "asset_type",
    "signature_type",
    "zzz_last",
  ]);

  // Verify query string is in sorted order
  const expectedQuery =
    "aaa_first=value&asset_type=COLLATERAL&signature_type=2&zzz_last=value";
  assert.equal(signedPath, `${endpoint}?${expectedQuery}`);
});

test("buildSignedPath handles special characters in query params", () => {
  const endpoint = "/endpoint";
  const params = {
    param1: "value with spaces",
    param2: "value&with=special",
  };

  const { signedPath } = buildSignedPath(endpoint, params);

  // Verify URL encoding
  assert.ok(signedPath.includes("value%20with%20spaces"));
  assert.ok(signedPath.includes("value%26with%3Dspecial"));
});

test("buildSignedPath handles empty params", () => {
  const endpoint = "/endpoint";
  const params = {};

  const { signedPath, paramsKeys } = buildSignedPath(endpoint, params);

  // Verify no query string is added
  assert.equal(signedPath, endpoint);
  assert.deepEqual(paramsKeys, []);
});

test("buildSignedPath filters out undefined values", () => {
  const endpoint = "/endpoint";
  const params = {
    defined: "value",
    undefined: undefined,
    null: null, // null is converted to string "null"
  };

  const { signedPath, paramsKeys } = buildSignedPath(endpoint, params);

  // Verify undefined is filtered out but null is included (as "null" string)
  assert.ok(signedPath.includes("defined=value"));
  assert.ok(!signedPath.includes("undefined="));
  assert.ok(signedPath.includes("null=null"));
  assert.deepEqual(paramsKeys, ["defined", "null"]);
});
