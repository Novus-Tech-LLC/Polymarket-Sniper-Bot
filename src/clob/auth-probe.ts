#!/usr/bin/env node
/**
 * auth:probe - Standalone Authentication Diagnostic Tool
 *
 * Usage: npm run auth:probe
 *
 * Produces:
 * 1. One Auth Story JSON per run
 * 2. Minimal HTTP trace for each attempt
 * 3. Single-line summary
 *
 * Exit codes:
 * 0 - Auth successful
 * 1 - Auth failed
 */

import { Wallet } from "ethers";
import { deriveCredentialsWithFallback } from "./credential-derivation-v2";
import { getLogger, generateRunId } from "../utils/structured-logger";
import { AuthStoryBuilder, createCredentialFingerprint } from "./auth-story";
import { POLYMARKET_API } from "../constants/polymarket.constants";

async function main(): Promise<void> {
  const logger = getLogger();
  const runId = generateRunId();

  logger.info("🔍 Running auth:probe diagnostic", {
    category: "STARTUP",
    runId,
  });

  // Read environment
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    logger.error("PRIVATE_KEY not set in environment", {
      category: "STARTUP",
      runId,
    });
    process.exit(1);
  }

  const wallet = new Wallet(privateKey);
  const signerAddress = wallet.address;

  logger.info("Configuration loaded", {
    category: "STARTUP",
    runId,
    signerAddress,
    funderAddress: process.env.POLYMARKET_PROXY_ADDRESS ?? "none",
    signatureType: process.env.POLYMARKET_SIGNATURE_TYPE ?? "auto-detect",
  });

  // Initialize auth story
  const authStory = new AuthStoryBuilder({
    runId,
    signerAddress,
    clobHost: POLYMARKET_API.BASE_URL,
    chainId: 137,
  });

  // Run credential derivation
  logger.info("Starting credential derivation with fallback", {
    category: "STARTUP",
    runId,
  });

  const result = await deriveCredentialsWithFallback({
    privateKey,
    signatureType: process.env.POLYMARKET_SIGNATURE_TYPE
      ? Number.parseInt(process.env.POLYMARKET_SIGNATURE_TYPE, 10)
      : undefined,
    funderAddress: process.env.POLYMARKET_PROXY_ADDRESS,
    structuredLogger: logger,
    authStoryBuilder: authStory,
  });

  // Add credential fingerprint if available
  if (result.success && result.creds) {
    const fingerprint = createCredentialFingerprint(result.creds);
    authStory.setCredentialFingerprint(fingerprint);
  }

  // Set final result
  authStory.setFinalResult({
    authOk: result.success,
    readyToTrade: result.success,
    reason: result.success
      ? "Credentials derived and verified"
      : (result.error ?? "Unknown error"),
  });

  // Print summary
  authStory.printSummary();

  // Print one-liner summary
  const summaryIcon = result.success ? "✅" : "❌";
  const summaryText = result.success
    ? "Auth successful - ready to trade"
    : `Auth failed: ${result.error ?? "unknown error"}`;

  logger.info(`${summaryIcon} ${summaryText}`, {
    category: "SUMMARY",
    runId,
    success: result.success,
  });

  // Exit with appropriate code
  process.exit(result.success ? 0 : 1);
}

// Fatal error handler - console.error is intentional here as the structured logger
// may not be available in all error scenarios (e.g., initialization failures)
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
