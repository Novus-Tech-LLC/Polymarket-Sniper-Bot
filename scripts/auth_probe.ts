#!/usr/bin/env ts-node

/**
 * CLOB Authentication Probe - Simple Auth Verification Tool
 *
 * This tool performs authentication verification using the pmxt-style methodology:
 * 1. Tries to derive existing credentials (deriveApiKey)
 * 2. Falls back to creating new credentials (createApiKey)
 * 3. Verifies credentials with a /balance-allowance call
 * 4. Prints a single Auth Story summary
 * 5. Exits 0 on success, 1 on failure
 *
 * Usage:
 *   ts-node scripts/auth_probe.ts
 *   npm run auth:probe
 *
 * Environment Variables:
 *   PRIVATE_KEY              - Required: Private key for authentication
 *   POLYMARKET_SIGNATURE_TYPE - Optional: Signature type (default: 0 for EOA)
 *   POLYMARKET_PROXY_ADDRESS - Optional: Proxy/funder address for Safe/Proxy modes
 */

import { AssetType } from "@polymarket/clob-client";
import {
  PolymarketAuth,
  createPolymarketAuthFromEnv,
} from "../src/clob/polymarket-auth";

// Simple console logger for the probe
const logger = {
  debug: (msg: string) => {
    if (process.env.LOG_LEVEL === "debug") console.log(`[DEBUG] ${msg}`);
  },
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
};

interface AuthStory {
  success: boolean;
  signerAddress: string;
  signatureType: number;
  credentialsObtained: boolean;
  credentialsDerived: boolean;
  verificationPassed: boolean;
  apiKeySuffix?: string;
  errorMessage?: string;
}

async function runAuthProbe(): Promise<number> {
  console.log("=".repeat(60));
  console.log("POLYMARKET AUTH PROBE");
  console.log("=".repeat(60));

  const story: AuthStory = {
    success: false,
    signerAddress: "",
    signatureType: 0,
    credentialsObtained: false,
    credentialsDerived: false,
    verificationPassed: false,
  };

  try {
    // Step 1: Initialize PolymarketAuth
    logger.info("Step 1: Initializing PolymarketAuth...");
    let auth: PolymarketAuth;

    try {
      auth = createPolymarketAuthFromEnv(logger);
      story.signerAddress = auth.getAddress();
      story.signatureType = auth.getSignatureType();
      logger.info(`Signer address: ${story.signerAddress}`);
      logger.info(`Signature type: ${story.signatureType}`);
    } catch (initError) {
      const msg =
        initError instanceof Error ? initError.message : String(initError);
      story.errorMessage = `Initialization failed: ${msg}`;
      logger.error(story.errorMessage);
      printAuthStory(story);
      return 1;
    }

    // Step 2: Authenticate (derive/create credentials)
    logger.info("Step 2: Authenticating (derive/create credentials)...");
    const authResult = await auth.authenticate();

    story.credentialsObtained = authResult.success;
    story.credentialsDerived = authResult.derived;

    if (!authResult.success || !authResult.creds) {
      story.errorMessage = authResult.error ?? "Authentication failed";
      logger.error(`Authentication failed: ${story.errorMessage}`);
      printAuthStory(story);
      return 1;
    }

    story.apiKeySuffix = authResult.creds.key.slice(-6);
    logger.info(`Credentials obtained: key=...${story.apiKeySuffix}`);
    logger.info(
      `Credentials were ${authResult.derived ? "derived" : "provided"}`,
    );

    // Step 3: Verify credentials with /balance-allowance
    logger.info("Step 3: Verifying credentials with /balance-allowance...");

    try {
      const client = await auth.getClobClient();
      const response = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });

      // Check for error response
      const errorResponse = response as { status?: number; error?: string };
      if (errorResponse.status === 401 || errorResponse.status === 403) {
        story.errorMessage = `Verification failed: ${errorResponse.status} ${errorResponse.error ?? "Unauthorized"}`;
        logger.error(story.errorMessage);
        printAuthStory(story);
        return 1;
      }

      if (errorResponse.error) {
        story.errorMessage = `Verification error: ${errorResponse.error}`;
        logger.error(story.errorMessage);
        printAuthStory(story);
        return 1;
      }

      story.verificationPassed = true;
      story.success = true;
      logger.info("Verification passed!");

      // Log balance info if available
      const balanceResponse = response as {
        balance?: string;
        allowance?: string;
      };
      if (balanceResponse.balance !== undefined) {
        logger.info(`Balance: ${balanceResponse.balance}`);
      }
      if (balanceResponse.allowance !== undefined) {
        logger.info(`Allowance: ${balanceResponse.allowance}`);
      }
    } catch (verifyError) {
      const msg =
        verifyError instanceof Error
          ? verifyError.message
          : String(verifyError);
      const status = (verifyError as { response?: { status?: number } })
        ?.response?.status;

      if (status === 401 || status === 403) {
        story.errorMessage = `Verification failed: ${status} Unauthorized`;
      } else {
        story.errorMessage = `Verification error: ${msg}`;
      }
      logger.error(story.errorMessage);
      printAuthStory(story);
      return 1;
    }

    // Success!
    printAuthStory(story);
    return 0;
  } catch (unexpectedError) {
    const msg =
      unexpectedError instanceof Error
        ? unexpectedError.message
        : String(unexpectedError);
    story.errorMessage = `Unexpected error: ${msg}`;
    logger.error(story.errorMessage);
    printAuthStory(story);
    return 1;
  }
}

function printAuthStory(story: AuthStory): void {
  console.log("\n" + "=".repeat(60));
  console.log("AUTH STORY SUMMARY");
  console.log("=".repeat(60));

  console.log(
    `
{
  "success": ${story.success},
  "signerAddress": "${story.signerAddress}",
  "signatureType": ${story.signatureType},
  "credentialsObtained": ${story.credentialsObtained},
  "credentialsDerived": ${story.credentialsDerived},
  "verificationPassed": ${story.verificationPassed},
  "apiKeySuffix": ${story.apiKeySuffix ? `"...${story.apiKeySuffix}"` : "null"},
  "errorMessage": ${story.errorMessage ? `"${story.errorMessage}"` : "null"}
}
`.trim(),
  );

  console.log("\n" + "=".repeat(60));

  if (story.success) {
    console.log("✅ AUTH PROBE PASSED - Ready to trade");
  } else {
    console.log("❌ AUTH PROBE FAILED");
    if (story.errorMessage) {
      console.log(`   Reason: ${story.errorMessage}`);
    }
    console.log("\nTroubleshooting:");
    if (!story.credentialsObtained) {
      console.log("  - Ensure PRIVATE_KEY is set correctly");
      console.log("  - Wallet may need to trade on Polymarket first");
      console.log("    Visit: https://polymarket.com");
    }
    if (story.credentialsObtained && !story.verificationPassed) {
      console.log("  - Check signature type configuration");
      console.log("  - For browser wallets, set POLYMARKET_SIGNATURE_TYPE=2");
      console.log("  - For Safe/Proxy, also set POLYMARKET_PROXY_ADDRESS");
    }
  }

  console.log("=".repeat(60));
}

// Main entry point
runAuthProbe()
  .then((exitCode) => process.exit(exitCode))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
