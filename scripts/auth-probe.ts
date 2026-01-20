#!/usr/bin/env ts-node
/**
 * Auth Probe - High-Signal CLOB API Authentication Diagnostic
 *
 * Produces ONE Auth Story summary per run with:
 * - Correlation IDs (runId, reqId, attemptId)
 * - Deduplication (60s window)
 * - Secret redaction (only last 4-6 chars, hashes, lengths)
 * - HMAC signature diagnostic details
 * - Root-cause hypotheses for common failure modes
 * - Exit code 0/1 for CI-friendliness
 *
 * Usage:
 *   npm run auth:probe
 *   ts-node scripts/auth-probe.ts
 *   LOG_LEVEL=debug npm run auth:probe  # For verbose diagnostics
 *   ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe  # Enable HMAC trace
 *
 * Exits with:
 *   0 = Auth successful
 *   1 = Auth failed
 */

import { Wallet } from "ethers";
import { ClobClient, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import * as dotenv from "dotenv";
import {
  initAuthStory,
  getAuthStory,
  type AuthAttempt,
  createCredentialFingerprint,
  printAuthStorySummaryIfNeeded,
} from "../src/clob/auth-story";
import { getLogger, generateRunId } from "../src/utils/structured-logger";
import { asClobSigner } from "../src/utils/clob-signer.util";

dotenv.config();

// Use structured logger with deduplication
const logger = getLogger();

/**
 * Analyze failure and provide root-cause hypothesis
 */
function analyzeFailure(
  httpStatus: number | undefined,
  errorText: string | undefined,
  signatureType: number,
  funderAddress: string | undefined,
): string {
  if (httpStatus === 401) {
    return [
      "401 Unauthorized - MOST LIKELY CAUSES:",
      "1. HMAC signature mismatch (check secret encoding, message format, timestamp)",
      "   Set ENABLE_HMAC_DIAGNOSTICS=true to trace signing vs HTTP request",
      "2. Invalid API credentials (try deleting .polymarket-credentials-cache.json and re-derive)",
      "3. Wallet address mismatch (L1 auth header != actual wallet)",
      "4. Wrong signature type (browser wallets need POLYMARKET_SIGNATURE_TYPE=2 + POLYMARKET_PROXY_ADDRESS)",
      "Run: npm run wallet:detect  # to identify correct configuration",
    ].join("\n   ");
  }

  if (httpStatus === 403) {
    return [
      "403 Forbidden - POSSIBLE CAUSES:",
      "1. Account restricted or banned by Polymarket",
      "2. Geographic restrictions (VPN/geoblock issue)",
      "3. Rate limiting (too many failed auth attempts)",
    ].join("\n   ");
  }

  if (httpStatus === 400) {
    if (errorText?.toLowerCase().includes("could not create")) {
      return [
        "400 Bad Request - Wallet has not traded on Polymarket yet",
        "SOLUTION: Visit https://polymarket.com and make at least one trade",
        "The first trade creates your CLOB API credentials on-chain",
      ].join("\n   ");
    }
    return "400 Bad Request - Invalid request format or parameters";
  }

  if (!httpStatus) {
    return "Network error or connection timeout - Check internet connectivity and CLOB_HOST";
  }

  return `HTTP ${httpStatus} - Unexpected error`;
}

/**
 * Extract HTTP status from error
 */
function extractHttpStatus(error: unknown): number | undefined {
  const err = error as {
    response?: { status?: number };
    status?: number;
  };
  return err?.response?.status ?? err?.status;
}

/**
 * Extract error message from error
 */
function extractErrorMessage(error: unknown): string {
  const err = error as { message?: string; response?: { data?: unknown } };
  if (err?.message) return err.message;
  if (err?.response?.data) {
    return JSON.stringify(err.response.data).slice(0, 200);
  }
  return String(error).slice(0, 200);
}

async function main() {
  const runId = generateRunId();
  const startTime = Date.now();

  logger.info("Starting auth probe", {
    category: "STARTUP",
    runId,
  });

  // Load config
  const privateKey = process.env.PRIVATE_KEY;
  const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";
  const signatureType = parseInt(
    process.env.POLYMARKET_SIGNATURE_TYPE || "0",
    10,
  );
  const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  if (!privateKey) {
    logger.error("PRIVATE_KEY environment variable is required", {
      category: "STARTUP",
      runId,
    });
    process.exit(1);
  }

  // Create wallet
  const wallet = new Wallet(privateKey);
  const signerAddress = wallet.address;

  logger.info("Initializing auth probe", {
    category: "STARTUP",
    runId,
    signerAddress,
    clobHost,
    chainId: Chain.POLYGON,
    signatureType,
    funderAddress: funderAddress ?? "none",
  });

  // Initialize auth story
  const authStory = initAuthStory({
    runId,
    signerAddress,
    clobHost,
    chainId: Chain.POLYGON,
  });

  let success = false;
  let creds: ApiKeyCreds | undefined;

  try {
    // Create CLOB client
    const client = new ClobClient(
      clobHost,
      Chain.POLYGON,
      asClobSigner(wallet),
      signatureType,
      funderAddress,
    );

    logger.info("Deriving CLOB API credentials", {
      category: "CRED_DERIVE",
      runId,
    });

    // Attempt to create or derive credentials
    try {
      creds = await client.createOrDeriveApiKey();

      if (!creds || !creds.apiKey || !creds.secret || !creds.passphrase) {
        throw new Error("Invalid credentials returned from createOrDeriveApiKey");
      }

      // Set credential fingerprint
      const fingerprint = createCredentialFingerprint({
        key: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      });
      authStory.setCredentialFingerprint(fingerprint);

      logger.info("Credentials obtained", {
        category: "CRED_DERIVE",
        runId,
        apiKeySuffix: fingerprint.apiKeySuffix,
        secretLen: fingerprint.secretLen,
        passphraseLen: fingerprint.passphraseLen,
        secretEncodingGuess: fingerprint.secretEncodingGuess,
      });

      // Set credentials on client
      client.setApiCreds(creds);

      // Attempt verification (e.g., getBalanceAllowance)
      logger.info("Verifying credentials with API call", {
        category: "PREFLIGHT",
        runId,
      });

      const balanceAllowance = await client.getBalanceAllowance(signerAddress);

      logger.info("Verification successful", {
        category: "PREFLIGHT",
        runId,
        balance: balanceAllowance?.balance ?? "unknown",
      });

      // Record successful attempt
      const attempt: AuthAttempt = {
        attemptId: "A",
        mode: signatureType === 0 ? "EOA" : signatureType === 1 ? "PROXY" : "SAFE",
        sigType: signatureType,
        l1Auth: signerAddress,
        maker: signerAddress,
        funder: funderAddress,
        verifyEndpoint: "/balance-allowance",
        signedPath: "/balance-allowance",
        usedAxiosParams: false,
        httpStatus: 200,
        success: true,
      };
      authStory.addAttempt(attempt);

      success = true;
    } catch (error) {
      const httpStatus = extractHttpStatus(error);
      const errorMessage = extractErrorMessage(error);

      logger.error("Credential derivation or verification failed", {
        category: "PREFLIGHT",
        runId,
        httpStatus,
        errorMessage,
      });

      // Record failed attempt
      const attempt: AuthAttempt = {
        attemptId: "A",
        mode: signatureType === 0 ? "EOA" : signatureType === 1 ? "PROXY" : "SAFE",
        sigType: signatureType,
        l1Auth: signerAddress,
        maker: signerAddress,
        funder: funderAddress,
        verifyEndpoint: "/balance-allowance",
        signedPath: "/balance-allowance",
        usedAxiosParams: false,
        httpStatus,
        errorTextShort: errorMessage.slice(0, 100),
        success: false,
      };
      authStory.addAttempt(attempt);

      // Provide diagnostic analysis
      const analysis = analyzeFailure(
        httpStatus,
        errorMessage,
        signatureType,
        funderAddress,
      );
      logger.error("Root cause analysis", {
        category: "SUMMARY",
        runId,
        analysis,
      });
    }
  } catch (error) {
    logger.error("Fatal error during auth probe", {
      category: "STARTUP",
      runId,
      error: String(error),
    });
  }

  // Set final result
  const durationMs = Date.now() - startTime;
  authStory.setFinalResult({
    authOk: success,
    readyToTrade: success,
    reason: success
      ? "Authentication successful"
      : "Authentication failed - see attempts above",
  });

  // Print auth story summary (deduplicated, single output)
  printAuthStorySummaryIfNeeded(success);

  logger.info("Auth probe complete", {
    category: "SUMMARY",
    runId,
    success,
    durationMs,
  });

  // Exit with appropriate code
  process.exit(success ? 0 : 1);
}

// Fatal error handler
main().catch((err) => {
  // eslint-disable-next-line no-console -- Fatal error handler needs direct console.error
  console.error("Fatal error:", err);
  process.exit(1);
});
