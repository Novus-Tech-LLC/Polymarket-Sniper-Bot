import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseAuthFailure,
  getContextAwareWarnings,
  isLiveTradingTheOnlyBlocker,
} from "../../src/utils/auth-diagnostic.util";

test("diagnoseAuthFailure identifies wrong key type", () => {
  const result = diagnoseAuthFailure({
    userProvidedKeys: true,
    deriveEnabled: false,
    deriveFailed: false,
    verificationFailed: true,
    verificationError: "Invalid api key",
    status: 401,
  });

  assert.equal(result.cause, "WRONG_KEY_TYPE");
  assert.equal(result.confidence, "high");
  assert.ok(
    result.message.includes("Builder API keys"),
    "Should mention Builder keys",
  );
  assert.ok(
    result.recommendations.some((r) => r.includes("POLY_BUILDER_API_KEY")),
    "Should recommend not using Builder keys",
  );
});

test("diagnoseAuthFailure identifies wallet not activated", () => {
  const result = diagnoseAuthFailure({
    userProvidedKeys: false,
    deriveEnabled: true,
    deriveFailed: true,
    deriveError: "Could not create api key",
    verificationFailed: false,
  });

  assert.equal(result.cause, "WALLET_NOT_ACTIVATED");
  assert.equal(result.confidence, "high");
  assert.ok(
    result.message.includes("never traded on Polymarket"),
    "Should mention trading requirement",
  );
  assert.ok(
    result.recommendations.some((r) => r.includes("polymarket.com")),
    "Should recommend visiting Polymarket",
  );
});

test("diagnoseAuthFailure identifies expired credentials", () => {
  const result = diagnoseAuthFailure({
    userProvidedKeys: true,
    deriveEnabled: false,
    deriveFailed: false,
    verificationFailed: true,
    verificationError: "Unauthorized",
    status: 401,
  });

  assert.equal(result.cause, "WRONG_KEY_TYPE");
  assert.equal(result.confidence, "high");
});

test("diagnoseAuthFailure identifies derive failed", () => {
  const result = diagnoseAuthFailure({
    userProvidedKeys: false,
    deriveEnabled: true,
    deriveFailed: true,
    deriveError: "Server error",
    verificationFailed: true,
    status: 401,
  });

  assert.equal(result.cause, "DERIVE_FAILED");
  assert.equal(result.confidence, "high");
  assert.ok(
    result.message.includes("derived but failed verification"),
    "Should mention derived credentials failed",
  );
});

test("diagnoseAuthFailure identifies wrong wallet binding", () => {
  const result = diagnoseAuthFailure({
    userProvidedKeys: true,
    deriveEnabled: true,
    deriveFailed: true,
    verificationFailed: true,
  });

  assert.equal(result.cause, "WRONG_WALLET_BINDING");
  assert.equal(result.confidence, "medium");
  assert.ok(
    result.message.includes("bound to a different wallet"),
    "Should mention wallet binding",
  );
  assert.ok(
    result.recommendations.some((r) => r.includes("PRIVATE_KEY")),
    "Should mention PRIVATE_KEY",
  );
});

test("diagnoseAuthFailure identifies network error with various patterns", () => {
  const networkErrors = [
    "Network timeout",
    "Connection refused",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "DNS lookup failed",
    "Host unreachable",
  ];

  networkErrors.forEach((error) => {
    const result = diagnoseAuthFailure({
      userProvidedKeys: true,
      deriveEnabled: false,
      deriveFailed: false,
      verificationFailed: true,
      verificationError: error,
    });

    assert.equal(
      result.cause,
      "NETWORK_ERROR",
      `Should identify network error for: ${error}`,
    );
    assert.equal(result.confidence, "high");
  });
});

test("diagnoseAuthFailure returns unknown for unclear cases", () => {
  const result = diagnoseAuthFailure({
    userProvidedKeys: false,
    deriveEnabled: false,
    deriveFailed: false,
    verificationFailed: false,
  });

  assert.equal(result.cause, "UNKNOWN");
  assert.equal(result.confidence, "low");
});

test("getContextAwareWarnings shows auth failure when auth not ok", () => {
  const warnings = getContextAwareWarnings({
    liveTradingEnabled: true,
    authOk: false,
    approvalsOk: true,
    geoblockPassed: true,
  });

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("credentials"), "Should mention credentials");
  assert.ok(
    !warnings[0].includes("ARB_LIVE_TRADING"),
    "Should not mention ARB_LIVE_TRADING when auth is the problem",
  );
});

test("getContextAwareWarnings shows approvals when approvals not ok", () => {
  const warnings = getContextAwareWarnings({
    liveTradingEnabled: true,
    authOk: true,
    approvalsOk: false,
    geoblockPassed: true,
  });

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("approvals"), "Should mention approvals");
});

test("getContextAwareWarnings shows geoblock when blocked", () => {
  const warnings = getContextAwareWarnings({
    liveTradingEnabled: true,
    authOk: true,
    approvalsOk: true,
    geoblockPassed: false,
  });

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("Geographic"), "Should mention geographic");
});

test("getContextAwareWarnings shows ARB_LIVE_TRADING only when it's the only blocker", () => {
  const warnings = getContextAwareWarnings({
    liveTradingEnabled: false,
    authOk: true,
    approvalsOk: true,
    geoblockPassed: true,
  });

  assert.equal(warnings.length, 1);
  assert.ok(
    warnings[0].includes("ARB_LIVE_TRADING"),
    "Should mention ARB_LIVE_TRADING when it's the only blocker",
  );
});

test("getContextAwareWarnings shows multiple blockers", () => {
  const warnings = getContextAwareWarnings({
    liveTradingEnabled: false,
    authOk: false,
    approvalsOk: false,
    geoblockPassed: true,
  });

  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("credentials")));
  assert.ok(warnings.some((w) => w.includes("approvals")));
  assert.ok(
    !warnings.some((w) => w.includes("ARB_LIVE_TRADING")),
    "Should not mention ARB_LIVE_TRADING when other blockers exist",
  );
});

test("isLiveTradingTheOnlyBlocker returns true only when it's the only issue", () => {
  assert.equal(
    isLiveTradingTheOnlyBlocker({
      liveTradingEnabled: false,
      authOk: true,
      approvalsOk: true,
      geoblockPassed: true,
    }),
    true,
    "Should be true when ARB_LIVE_TRADING is the only blocker",
  );

  assert.equal(
    isLiveTradingTheOnlyBlocker({
      liveTradingEnabled: false,
      authOk: false,
      approvalsOk: true,
      geoblockPassed: true,
    }),
    false,
    "Should be false when auth also fails",
  );

  assert.equal(
    isLiveTradingTheOnlyBlocker({
      liveTradingEnabled: true,
      authOk: true,
      approvalsOk: true,
      geoblockPassed: true,
    }),
    false,
    "Should be false when ARB_LIVE_TRADING is enabled",
  );
});
