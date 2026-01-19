/**
 * Tests for Auth Story
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuthStoryBuilder,
  createCredentialFingerprint,
  initAuthStory,
  getAuthStory,
  resetAuthStory,
} from "../../src/clob/auth-story";
import type { OrderIdentity, L1AuthIdentity } from "../../src/clob/identity-resolver";

describe("Auth Story", () => {
  it("should create credential fingerprint", () => {
    const creds = {
      key: "sk_test_1234567890abcdef",
      secret: "base64EncodedSecret+/==",
      passphrase: "my-passphrase-123",
    };

    const fingerprint = createCredentialFingerprint(creds);

    assert.equal(fingerprint.apiKeySuffix.length, 6);
    assert.equal(fingerprint.secretLen, creds.secret.length);
    assert.equal(fingerprint.passphraseLen, creds.passphrase.length);
    assert.equal(fingerprint.secretEncodingGuess, "base64");
  });

  it("should detect base64url encoding", () => {
    const creds = {
      key: "test",
      secret: "base64UrlEncoded-_",
      passphrase: "pass",
    };

    const fingerprint = createCredentialFingerprint(creds);
    assert.equal(fingerprint.secretEncodingGuess, "base64url");
  });

  it("should detect raw encoding", () => {
    const creds = {
      key: "test",
      secret: "plain!text@secret#",
      passphrase: "pass",
    };

    const fingerprint = createCredentialFingerprint(creds);
    assert.equal(fingerprint.secretEncodingGuess, "raw");
  });

  it("should create auth story builder", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    const story = builder.getStory();
    assert.equal(story.runId, "test_run_123");
    assert.equal(story.signerAddress, "0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(story.clobHost, "https://clob.polymarket.com");
    assert.equal(story.chainId, 137);
    assert.equal(story.attempts.length, 0);
  });

  it("should set identity on auth story", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    const orderIdentity: OrderIdentity = {
      signatureTypeForOrders: 0,
      makerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      funderAddress: "0x1234567890abcdef1234567890abcdef12345678",
      effectiveAddress: "0x1234567890abcdef1234567890abcdef12345678",
    };

    const l1AuthIdentity: L1AuthIdentity = {
      signatureTypeForAuth: 0,
      l1AuthAddress: "0x1234567890abcdef1234567890abcdef12345678",
      signingAddress: "0x1234567890abcdef1234567890abcdef12345678",
    };

    builder.setIdentity({ orderIdentity, l1AuthIdentity });

    const story = builder.getStory();
    assert.equal(story.selectedMode, "EOA");
    assert.equal(story.selectedSignatureType, 0);
    assert.equal(story.makerAddress, "0x1234567890abcdef1234567890abcdef12345678");
  });

  it("should add attempts to auth story", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    builder.addAttempt({
      attemptId: "A",
      mode: "EOA",
      sigType: 0,
      l1Auth: "0x1234567890abcdef1234567890abcdef12345678",
      maker: "0x1234567890abcdef1234567890abcdef12345678",
      funder: "0x1234567890abcdef1234567890abcdef12345678",
      verifyEndpoint: "/balance-allowance",
      signedPath: "/balance-allowance?asset_type=COLLATERAL",
      usedAxiosParams: false,
      httpStatus: 200,
      success: true,
    });

    const story = builder.getStory();
    assert.equal(story.attempts.length, 1);
    assert.equal(story.attempts[0]!.attemptId, "A");
    assert.equal(story.attempts[0]!.success, true);
    assert.equal(story.attempts[0]!.httpStatus, 200);
  });

  it("should set final result", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    builder.setFinalResult({
      authOk: true,
      readyToTrade: true,
      reason: "All checks passed",
    });

    const story = builder.getStory();
    assert.equal(story.finalResult.authOk, true);
    assert.equal(story.finalResult.readyToTrade, true);
    assert.equal(story.finalResult.reason, "All checks passed");
  });

  it("should export as JSON", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    const json = builder.toJSON();
    const parsed = JSON.parse(json);

    assert.equal(parsed.runId, "test_run_123");
    assert.equal(parsed.signerAddress, "0x1234567890abcdef1234567890abcdef12345678");
  });

  it("should initialize and get global auth story", () => {
    resetAuthStory();

    const builder = initAuthStory({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    assert.ok(builder);

    const retrieved = getAuthStory();
    assert.ok(retrieved);
    assert.strictEqual(builder, retrieved);

    resetAuthStory();
  });

  it("should return null when no global auth story", () => {
    resetAuthStory();
    const story = getAuthStory();
    assert.equal(story, null);
  });

  it("should handle SAFE mode", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    const orderIdentity: OrderIdentity = {
      signatureTypeForOrders: 2, // SAFE
      makerAddress: "0xsafeaddress",
      funderAddress: "0xsafeaddress",
      effectiveAddress: "0xsafeaddress",
    };

    const l1AuthIdentity: L1AuthIdentity = {
      signatureTypeForAuth: 2,
      l1AuthAddress: "0xsafeaddress",
      signingAddress: "0x1234567890abcdef1234567890abcdef12345678",
    };

    builder.setIdentity({ orderIdentity, l1AuthIdentity });

    const story = builder.getStory();
    assert.equal(story.selectedMode, "SAFE");
    assert.equal(story.selectedSignatureType, 2);
  });

  it("should handle PROXY mode", () => {
    const builder = new AuthStoryBuilder({
      runId: "test_run_123",
      signerAddress: "0x1234567890abcdef1234567890abcdef12345678",
      clobHost: "https://clob.polymarket.com",
      chainId: 137,
    });

    const orderIdentity: OrderIdentity = {
      signatureTypeForOrders: 1, // PROXY
      makerAddress: "0xproxyaddress",
      funderAddress: "0xproxyaddress",
      effectiveAddress: "0xproxyaddress",
    };

    const l1AuthIdentity: L1AuthIdentity = {
      signatureTypeForAuth: 1,
      l1AuthAddress: "0xproxyaddress",
      signingAddress: "0x1234567890abcdef1234567890abcdef12345678",
    };

    builder.setIdentity({ orderIdentity, l1AuthIdentity });

    const story = builder.getStory();
    assert.equal(story.selectedMode, "PROXY");
    assert.equal(story.selectedSignatureType, 1);
  });
});
