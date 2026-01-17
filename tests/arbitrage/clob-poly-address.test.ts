import { test } from "node:test";
import assert from "node:assert/strict";
import { SignatureType } from "@polymarket/order-utils";
import {
  evaluatePublicKeyMismatch,
  resolveDerivedSignerAddress,
  resolveEffectivePolyAddress,
} from "../../src/clob/addressing";

const TEST_PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";

test("sigType=1 with funder => POLY_ADDRESS=funder", () => {
  const derivedSignerAddress = resolveDerivedSignerAddress(TEST_PRIVATE_KEY);
  const funderAddress = "0x1111111111111111111111111111111111111111";
  const result = resolveEffectivePolyAddress({
    derivedSignerAddress,
    signatureType: SignatureType.POLY_PROXY,
    funderAddress,
  });

  assert.equal(result.effectivePolyAddress, funderAddress);
});

test("sigType=0 => POLY_ADDRESS=derived signer", () => {
  const derivedSignerAddress = resolveDerivedSignerAddress(TEST_PRIVATE_KEY);
  const result = resolveEffectivePolyAddress({
    derivedSignerAddress,
    signatureType: SignatureType.EOA,
    funderAddress: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(result.effectivePolyAddress, derivedSignerAddress);
});

test("mismatch PUBLIC_KEY => execution disabled", () => {
  const result = evaluatePublicKeyMismatch({
    configuredPublicKey: "0x1111111111111111111111111111111111111111",
    derivedSignerAddress: "0x2222222222222222222222222222222222222222",
    forceMismatch: false,
  });

  assert.equal(result.mismatch, true);
  assert.equal(result.executionDisabled, true);
});
