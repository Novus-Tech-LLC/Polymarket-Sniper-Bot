#!/usr/bin/env ts-node
/**
 * Auth Probe Command - Enhanced Auth Diagnostic
 *
 * This command performs ONE auth attempt and produces ONE Auth Story summary with:
 * - HTTP request/response instrumentation
 * - HMAC signature diagnostic details
 * - Credential fingerprints (no secrets)
 * - Root-cause hypotheses for common failure modes
 * - Exit code 0/1 for CI-friendliness
 *
 * Usage:
 *   npm run auth:probe
 *   ts-node scripts/auth-probe-minimal.ts
 *   LOG_LEVEL=debug npm run auth:probe  # For verbose diagnostics
 *
 * Exits with:
 *   0 = Auth successful
 *   1 = Auth failed
 */

import { Wallet } from "ethers";
import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import * as dotenv from "dotenv";
import {
  initAuthStory,
  type AuthAttempt,
  createCredentialFingerprint,
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

async function main() {
  const runId = generateRunId();

  logger.info("Starting auth probe", {
    category: "STARTUP",
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
    logger.error("PRIVATE_KEY environment variable required", {
      category: "STARTUP",
    });
    process.exit(1);
  }

  const wallet = new Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
  );
  const signerAddress = wallet.address;

  // Initialize auth story
  const authStory = initAuthStory({
    runId,
    signerAddress,
    clobHost,
    chainId: 137,
  });

  // Set identity
  const effectiveAddress = funderAddress || signerAddress;
  authStory.setIdentity({
    orderIdentity: {
      signatureTypeForOrders: signatureType,
      makerAddress: effectiveAddress,
      funderAddress: funderAddress || effectiveAddress,
      effectiveAddress,
    },
    l1AuthIdentity: {
      signatureTypeForAuth: signatureType,
      l1AuthAddress: effectiveAddress,
      signingAddress: signerAddress,
    },
  });

  logger.info("Identity configuration", {
    category: "IDENTITY",
    signatureType,
    signerAddress: `${signerAddress.slice(0, 8)}...${signerAddress.slice(-6)}`,
    funderAddress: funderAddress || "none",
  });

  // Create CLOB client
  logger.debug("Creating CLOB client", {
    category: "IDENTITY",
    clobHost,
    signatureType,
  });

  const client = new ClobClient(
    clobHost,
    Chain.POLYGON,
    asClobSigner(wallet),
    undefined, // No creds yet
    signatureType,
    funderAddress,
  );

  // Step 1: Attempt to derive credentials
  logger.info("Attempting credential derivation via createOrDeriveApiKey()", {
    category: "CRED_DERIVE",
    attemptId: "A",
  });

  let creds: ApiKeyCreds | undefined;
  let httpStatus: number | undefined;
  let errorText: string | undefined;

  try {
    creds = await client.createOrDeriveApiKey();

    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      httpStatus = 200; // Request succeeded but returned incomplete data
      errorText =
        "Incomplete credentials returned (missing key/secret/passphrase)";
      logger.error("Credentials incomplete", {
        category: "CRED_DERIVE",
        hasKey: Boolean(creds?.key),
        hasSecret: Boolean(creds?.secret),
        hasPassphrase: Boolean(creds?.passphrase),
      });
    } else {
      httpStatus = 200; // Success
      logger.info("Credentials obtained successfully", {
        category: "CRED_DERIVE",
        apiKeySuffix: creds.key.slice(-6),
        secretLength: creds.secret.length,
        passphraseLength: creds.passphrase.length,
      });

      // Set credential fingerprint in auth story
      const credFingerprint = createCredentialFingerprint(creds);
      authStory.setCredentialFingerprint(credFingerprint);
      logger.debug("Credential fingerprint", {
        category: "CRED_DERIVE",
        ...credFingerprint,
      });
    }
  } catch (error: any) {
    httpStatus = error?.response?.status || error?.status;
    errorText = error?.response?.data?.error || error?.message || String(error);
    logger.error("createOrDeriveApiKey() failed", {
      category: "CRED_DERIVE",
      httpStatus,
      error: errorText?.slice(0, 200),
    });
  }

  // Add derivation attempt to auth story
  const derivationAttempt: AuthAttempt = {
    attemptId: "A",
    mode: signatureType === 0 ? "EOA" : signatureType === 2 ? "SAFE" : "PROXY",
    sigType: signatureType,
    l1Auth: effectiveAddress,
    maker: effectiveAddress,
    funder: funderAddress || undefined,
    verifyEndpoint: "/auth/api-key",
    signedPath: "/auth/api-key",
    usedAxiosParams: false,
    httpStatus,
    errorTextShort: errorText?.slice(0, 100),
    success: Boolean(creds && httpStatus === 200),
  };

  authStory.addAttempt(derivationAttempt);

  if (!creds || httpStatus !== 200) {
    logger.error("❌ Credential derivation failed", {
      category: "CRED_DERIVE",
      httpStatus,
    });

    // Provide root-cause analysis
    const diagnosis = analyzeFailure(
      httpStatus,
      errorText,
      signatureType,
      funderAddress,
    );
    logger.error("Root-cause analysis:", { category: "SUMMARY" });
    logger.error(diagnosis, { category: "SUMMARY" });

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: `Credential derivation failed: ${diagnosis.split("\n")[0]}`,
    });
    authStory.printSummary();
    process.exit(1);
  }

  // Step 2: Verify credentials with /balance-allowance
  logger.info("Verifying credentials with /balance-allowance", {
    category: "PREFLIGHT",
    attemptId: "B",
  });

  try {
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // The CLOB client may return error-like objects instead of throwing
    type ErrorResponse = {
      status?: number;
      error?: string;
    };
    const errorResponse = response as ErrorResponse;

    if (errorResponse.status === 401 || errorResponse.status === 403) {
      logger.error("❌ Credential verification failed", {
        category: "PREFLIGHT",
        httpStatus: errorResponse.status,
        error: errorResponse.error,
      });

      // Provide root-cause analysis
      const diagnosis = analyzeFailure(
        errorResponse.status,
        errorResponse.error,
        signatureType,
        funderAddress,
      );
      logger.error("Root-cause analysis:", { category: "SUMMARY" });
      logger.error(diagnosis, { category: "SUMMARY" });

      // Add verification attempt to auth story
      const verificationAttempt: AuthAttempt = {
        attemptId: "B",
        mode:
          signatureType === 0 ? "EOA" : signatureType === 2 ? "SAFE" : "PROXY",
        sigType: signatureType,
        l1Auth: effectiveAddress,
        maker: effectiveAddress,
        funder: funderAddress || undefined,
        verifyEndpoint: "/balance-allowance",
        signedPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
        usedAxiosParams: false,
        httpStatus: errorResponse.status,
        errorTextShort: errorResponse.error?.slice(0, 100),
        success: false,
      };
      authStory.addAttempt(verificationAttempt);

      authStory.setFinalResult({
        authOk: false,
        readyToTrade: false,
        reason: `Credential verification failed: ${diagnosis.split("\n")[0]}`,
      });
      authStory.printSummary();
      process.exit(1);
    }

    logger.info("✅ Auth successful - credentials verified", {
      category: "PREFLIGHT",
    });

    // Add successful verification attempt
    const verificationAttempt: AuthAttempt = {
      attemptId: "B",
      mode:
        signatureType === 0 ? "EOA" : signatureType === 2 ? "SAFE" : "PROXY",
      sigType: signatureType,
      l1Auth: effectiveAddress,
      maker: effectiveAddress,
      funder: funderAddress || undefined,
      verifyEndpoint: "/balance-allowance",
      signedPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
      usedAxiosParams: false,
      httpStatus: 200,
      success: true,
    };
    authStory.addAttempt(verificationAttempt);

    authStory.setFinalResult({
      authOk: true,
      readyToTrade: true,
      reason: "Authentication successful - ready to trade",
    });
    authStory.printSummary();
    process.exit(0);
  } catch (error: any) {
    const status = error?.response?.status || error?.status;
    const message =
      error?.response?.data?.error || error?.message || String(error);

    logger.error("❌ Verification request failed", {
      category: "PREFLIGHT",
      httpStatus: status,
      error: message?.slice(0, 200),
    });

    // Provide root-cause analysis
    const diagnosis = analyzeFailure(
      status,
      message,
      signatureType,
      funderAddress,
    );
    logger.error("Root-cause analysis:", { category: "SUMMARY" });
    logger.error(diagnosis, { category: "SUMMARY" });

    // Add verification attempt to auth story
    const verificationAttempt: AuthAttempt = {
      attemptId: "B",
      mode:
        signatureType === 0 ? "EOA" : signatureType === 2 ? "SAFE" : "PROXY",
      sigType: signatureType,
      l1Auth: effectiveAddress,
      maker: effectiveAddress,
      funder: funderAddress || undefined,
      verifyEndpoint: "/balance-allowance",
      signedPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
      usedAxiosParams: false,
      httpStatus: status,
      errorTextShort: message?.slice(0, 100),
      success: false,
    };
    authStory.addAttempt(verificationAttempt);

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: `Verification request failed: ${diagnosis.split("\n")[0]}`,
    });
    authStory.printSummary();
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error("FATAL ERROR", {
    category: "STARTUP",
    error: error?.message || String(error),
    stack: error?.stack,
  });
  process.exit(1);
});
