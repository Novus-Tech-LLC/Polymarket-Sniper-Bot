/**
 * Tests for identity resolver
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectWalletMode,
  resolveOrderIdentity,
  resolveL1AuthIdentity,
} from "../../src/clob/identity-resolver";
import { SignatureType } from "@polymarket/order-utils";

// Test private key (not a real wallet, for testing purposes only)
// This key has no associated funds and is only used for unit testing
const TEST_PRIVATE_KEY =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
// Note: TEST_SIGNER_ADDRESS would be derived from TEST_PRIVATE_KEY in actual usage
// For these tests, we're testing the logic flow, not actual address derivation
const TEST_FUNDER_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1";

test("detectWalletMode - EOA with no config", () => {
  const mode = detectWalletMode({
    signatureType: undefined,
    funderAddress: undefined,
  });
  assert.equal(mode, "eoa");
});

test("detectWalletMode - EOA with signatureType=0", () => {
  const mode = detectWalletMode({
    signatureType: SignatureType.EOA,
    funderAddress: undefined,
  });
  assert.equal(mode, "eoa");
});

test("detectWalletMode - Safe with signatureType=2 and funder", () => {
  const mode = detectWalletMode({
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    funderAddress: TEST_FUNDER_ADDRESS,
  });
  assert.equal(mode, "safe");
});

test("detectWalletMode - Proxy with signatureType=1 and funder", () => {
  const mode = detectWalletMode({
    signatureType: SignatureType.POLY_PROXY,
    funderAddress: TEST_FUNDER_ADDRESS,
  });
  assert.equal(mode, "proxy");
});

test("detectWalletMode - Safe without funder falls back to EOA", () => {
  const mode = detectWalletMode({
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    funderAddress: undefined,
  });
  assert.equal(mode, "eoa");
});

test("detectWalletMode - forced mode overrides detection", () => {
  const mode = detectWalletMode({
    signatureType: SignatureType.EOA,
    funderAddress: undefined,
    forceWalletMode: "safe",
  });
  assert.equal(mode, "safe");
});

test("resolveOrderIdentity - EOA mode", () => {
  const identity = resolveOrderIdentity({
    privateKey: TEST_PRIVATE_KEY,
    signatureType: SignatureType.EOA,
  });

  assert.equal(identity.signatureTypeForOrders, SignatureType.EOA);
  assert.ok(identity.makerAddress.startsWith("0x"));
  assert.equal(identity.makerAddress, identity.funderAddress);
  assert.equal(identity.makerAddress, identity.effectiveAddress);
});

test("resolveOrderIdentity - Safe mode", () => {
  const identity = resolveOrderIdentity({
    privateKey: TEST_PRIVATE_KEY,
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    funderAddress: TEST_FUNDER_ADDRESS,
  });

  assert.equal(identity.signatureTypeForOrders, SignatureType.POLY_GNOSIS_SAFE);
  assert.equal(identity.makerAddress, TEST_FUNDER_ADDRESS);
  assert.equal(identity.funderAddress, TEST_FUNDER_ADDRESS);
  assert.equal(identity.effectiveAddress, TEST_FUNDER_ADDRESS);
});

test("resolveOrderIdentity - Proxy mode", () => {
  const identity = resolveOrderIdentity({
    privateKey: TEST_PRIVATE_KEY,
    signatureType: SignatureType.POLY_PROXY,
    funderAddress: TEST_FUNDER_ADDRESS,
  });

  assert.equal(identity.signatureTypeForOrders, SignatureType.POLY_PROXY);
  assert.equal(identity.makerAddress, TEST_FUNDER_ADDRESS);
  assert.equal(identity.funderAddress, TEST_FUNDER_ADDRESS);
  assert.equal(identity.effectiveAddress, TEST_FUNDER_ADDRESS);
});

test("resolveL1AuthIdentity - EOA mode, prefer signer", () => {
  const identity = resolveL1AuthIdentity(
    {
      privateKey: TEST_PRIVATE_KEY,
      signatureType: SignatureType.EOA,
    },
    false, // prefer signer
  );

  assert.equal(identity.signatureTypeForAuth, SignatureType.EOA);
  assert.ok(identity.signingAddress.startsWith("0x"));
  assert.equal(identity.l1AuthAddress, identity.signingAddress);
});

test("resolveL1AuthIdentity - Safe mode, prefer signer", () => {
  const identity = resolveL1AuthIdentity(
    {
      privateKey: TEST_PRIVATE_KEY,
      signatureType: SignatureType.POLY_GNOSIS_SAFE,
      funderAddress: TEST_FUNDER_ADDRESS,
    },
    false, // prefer signer
  );

  assert.equal(identity.signatureTypeForAuth, SignatureType.POLY_GNOSIS_SAFE);
  assert.ok(identity.signingAddress.startsWith("0x"));
  assert.equal(identity.l1AuthAddress, identity.signingAddress);
  assert.notEqual(identity.l1AuthAddress, TEST_FUNDER_ADDRESS);
});

test("resolveL1AuthIdentity - Safe mode, prefer effective", () => {
  const identity = resolveL1AuthIdentity(
    {
      privateKey: TEST_PRIVATE_KEY,
      signatureType: SignatureType.POLY_GNOSIS_SAFE,
      funderAddress: TEST_FUNDER_ADDRESS,
    },
    true, // prefer effective
  );

  assert.equal(identity.signatureTypeForAuth, SignatureType.POLY_GNOSIS_SAFE);
  assert.ok(identity.signingAddress.startsWith("0x"));
  assert.equal(identity.l1AuthAddress, TEST_FUNDER_ADDRESS);
  assert.notEqual(identity.l1AuthAddress, identity.signingAddress);
});

test("resolveL1AuthIdentity - forced signer", () => {
  const identity = resolveL1AuthIdentity(
    {
      privateKey: TEST_PRIVATE_KEY,
      signatureType: SignatureType.POLY_GNOSIS_SAFE,
      funderAddress: TEST_FUNDER_ADDRESS,
      forceL1Auth: "signer",
    },
    true, // prefer effective (but will be overridden)
  );

  assert.equal(identity.l1AuthAddress, identity.signingAddress);
  assert.notEqual(identity.l1AuthAddress, TEST_FUNDER_ADDRESS);
});

test("resolveL1AuthIdentity - forced effective", () => {
  const identity = resolveL1AuthIdentity(
    {
      privateKey: TEST_PRIVATE_KEY,
      signatureType: SignatureType.POLY_GNOSIS_SAFE,
      funderAddress: TEST_FUNDER_ADDRESS,
      forceL1Auth: "effective",
    },
    false, // prefer signer (but will be overridden)
  );

  assert.equal(identity.l1AuthAddress, TEST_FUNDER_ADDRESS);
  assert.notEqual(identity.l1AuthAddress, identity.signingAddress);
});
