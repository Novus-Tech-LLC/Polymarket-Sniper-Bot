import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  buildAuthMessageString,
  classifyAuthFailure,
  detectSecretDecodingMode,
  deriveSignerAddress,
  publicKeyMatchesDerived,
} from "../../src/clob/diagnostics";

const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044976f9d1f4aa2e9d8f99a6a1c4b7c1b9f8e178b0ff5d";

test("deriveSignerAddress matches ethers Wallet derivation", () => {
  const expected = new Wallet(PRIVATE_KEY).address;
  assert.equal(deriveSignerAddress(PRIVATE_KEY), expected);
});

test("publicKeyMatchesDerived detects mismatches", () => {
  const derived = deriveSignerAddress(PRIVATE_KEY);
  assert.equal(publicKeyMatchesDerived(derived, derived), true);
  assert.equal(
    publicKeyMatchesDerived(
      "0x0000000000000000000000000000000000000000",
      derived,
    ),
    false,
  );
});

test("detectSecretDecodingMode detects raw/base64/base64url", () => {
  assert.equal(detectSecretDecodingMode("not-base64!"), "raw");
  assert.equal(detectSecretDecodingMode("YWJjMTIz"), "base64");
  assert.equal(detectSecretDecodingMode("YWJjLXI_"), "base64url");
});

test("buildAuthMessageString includes query string when present", () => {
  const message = buildAuthMessageString({
    timestamp: 1700000000,
    method: "GET",
    path: "/auth/api-keys?foo=bar&baz=1",
  });
  assert.ok(message.includes("/auth/api-keys?foo=bar&baz=1"));
});

test("classifyAuthFailure chooses MISMATCHED_ADDRESS when applicable", () => {
  const reason = classifyAuthFailure({
    configuredPublicKey: "0x0000000000000000000000000000000000000000",
    derivedSignerAddress: deriveSignerAddress(PRIVATE_KEY),
    signatureType: 0,
    privateKeyPresent: true,
    secretFormat: "raw",
    secretDecodingUsed: "base64",
    expectedBodyIncluded: false,
    bodyIncluded: false,
    expectedQueryPresent: false,
    pathIncludesQuery: false,
  });
  assert.equal(reason, "MISMATCHED_ADDRESS");
});
