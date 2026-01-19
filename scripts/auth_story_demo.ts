#!/usr/bin/env ts-node

/**
 * Auth Story Demo - Shows expected output format
 *
 * This demo creates a sample Auth Story to demonstrate
 * the expected output format for successful and failed auth.
 */

// Sample Auth Story for SUCCESS
const successStory = {
  runId: "run_1737316800_a1b2c3",
  timestamp: "2026-01-19T18:00:00.000Z",
  success: true,
  signerAddress: "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  signatureType: 0,
  funderAddress: undefined,
  clobHost: "https://clob.polymarket.com",
  chainId: 137,
  credentialsObtained: true,
  derivedCredFingerprint: {
    apiKeySuffix: "...8031",
    secretLen: 64,
    secretEncodingGuess: "base64url",
  },
  verificationPassed: true,
  attempts: [
    {
      attemptId: "A",
      mode: "EOA",
      sigType: 0,
      httpStatus: 200,
      success: true,
    },
  ],
  durationMs: 1234,
};

// Sample Auth Story for FAILURE
const failureStory = {
  runId: "run_1737316800_x9y8z7",
  timestamp: "2026-01-19T18:00:00.000Z",
  success: false,
  signerAddress: "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  signatureType: 0,
  funderAddress: undefined,
  clobHost: "https://clob.polymarket.com",
  chainId: 137,
  credentialsObtained: true,
  derivedCredFingerprint: {
    apiKeySuffix: "...8031",
    secretLen: 64,
    secretEncodingGuess: "base64url",
  },
  verificationPassed: false,
  attempts: [
    {
      attemptId: "A",
      mode: "EOA",
      sigType: 0,
      httpStatus: 401,
      errorTextShort: "Unauthorized/Invalid api key",
      success: false,
    },
  ],
  errorMessage: "Verification failed: 401 Unauthorized",
  durationMs: 1234,
};

// Sample Auth Story for MULTI-ATTEMPT FAILURE
const multiAttemptFailureStory = {
  runId: "run_1737316800_z1y2x3",
  timestamp: "2026-01-19T18:00:00.000Z",
  success: false,
  signerAddress: "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  signatureType: 0,
  funderAddress: undefined,
  clobHost: "https://clob.polymarket.com",
  chainId: 137,
  credentialsObtained: true,
  derivedCredFingerprint: {
    apiKeySuffix: "...8031",
    secretLen: 64,
    secretEncodingGuess: "base64url",
  },
  verificationPassed: false,
  attempts: [
    {
      attemptId: "A",
      mode: "EOA",
      sigType: 0,
      httpStatus: 401,
      errorTextShort: "Unauthorized/Invalid api key",
      success: false,
    },
    {
      attemptId: "B",
      mode: "SAFE",
      sigType: 2,
      httpStatus: 401,
      errorTextShort: "Unauthorized/Invalid api key",
      success: false,
    },
    {
      attemptId: "C",
      mode: "PROXY",
      sigType: 1,
      httpStatus: 401,
      errorTextShort: "Unauthorized/Invalid api key",
      success: false,
    },
  ],
  errorMessage: "All 3 fallback attempts failed: 401 Unauthorized",
  durationMs: 3456,
};

console.log("========================================");
console.log("AUTH STORY OUTPUT EXAMPLES");
console.log("========================================\n");

console.log("1. SUCCESS (EOA Mode)");
console.log("----------------------");
console.log(JSON.stringify(successStory, null, 2));
console.log("");

console.log("2. FAILURE (Single Attempt)");
console.log("----------------------------");
console.log(JSON.stringify(failureStory, null, 2));
console.log("");

console.log("3. FAILURE (Multiple Attempts)");
console.log("--------------------------------");
console.log(JSON.stringify(multiAttemptFailureStory, null, 2));
console.log("");

console.log("========================================");
console.log("KEY FEATURES");
console.log("========================================");
console.log("✅ Single JSON block per run");
console.log("✅ One line per attempt in attempts array");
console.log("✅ Secrets redacted (apiKeySuffix, secretLen only)");
console.log("✅ Correlation ID (runId) for tracing");
console.log("✅ HTTP status codes for debugging");
console.log("✅ Total duration in milliseconds");
console.log("✅ CI-friendly (exit 0 on success, 1 on failure)");
console.log("");

console.log("USAGE:");
console.log("  npm run auth:probe                    # JSON output");
console.log("  AUTH_STORY_FORMAT=pretty npm run auth:probe  # Pretty output");
console.log("  npm run auth:probe | jq '.success'    # Parse JSON");
console.log("");
