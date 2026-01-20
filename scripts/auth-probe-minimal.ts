#!/usr/bin/env ts-node
/**
 * Auth Probe Command - Minimal Auth Diagnostic
 *
 * This command performs ONE auth attempt and produces ONE Auth Story summary.
 * No logs spam, no secrets, just structured diagnostics.
 *
 * Usage:
 *   npm run auth:probe
 *   ts-node scripts/auth-probe-minimal.ts
 *
 * Exits with:
 *   0 = Auth successful
 *   1 = Auth failed
 */

import { Wallet } from "ethers";
import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import * as dotenv from "dotenv";
import { logAuth, sanitizeCredential } from "../src/utils/auth-logger.util";
import { initAuthStory, type AuthAttempt } from "../src/clob/auth-story";
import { generateRunId } from "../src/utils/structured-logger";
import { asClobSigner } from "../src/utils/clob-signer.util";

dotenv.config();

// Minimal logger
const logger = {
  debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
};

async function main() {
  const runId = generateRunId();

  logAuth(logger, "info", "Starting auth probe", {
    category: "PROBE",
    runId,
  });

  // Load config
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL || "https://polygon-rpc.com";
  const clobHost = process.env.CLOB_HOST || "https://clob.polymarket.com";
  const signatureType = parseInt(
    process.env.POLYMARKET_SIGNATURE_TYPE || "0",
    10,
  );
  const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  if (!privateKey) {
    logAuth(logger, "error", "PRIVATE_KEY environment variable required", {
      category: "PROBE",
      runId,
    });
    process.exit(1);
  }

  const wallet = new Wallet(privateKey);
  const signerAddress = wallet.address;

  // Initialize auth story
  const authStory = initAuthStory({
    runId,
    signerAddress,
    clobHost,
    chainId: 137,
  });

  // Set identity
  authStory.setIdentity({
    orderIdentity: {
      signatureTypeForOrders: signatureType,
      makerAddress: funderAddress || signerAddress,
      funderAddress: funderAddress || signerAddress,
      effectiveAddress: funderAddress || signerAddress,
    },
    l1AuthIdentity: {
      signatureTypeForAuth: signatureType,
      l1AuthAddress: funderAddress || signerAddress,
      signingAddress: signerAddress,
    },
  });

  logAuth(logger, "info", "Identity configuration", {
    category: "PROBE",
    runId,
    signatureType,
    signerAddress,
    funderAddress: funderAddress || "none",
  });

  // Create CLOB client
  const client = new ClobClient(
    clobHost,
    Chain.POLYGON,
    asClobSigner(wallet),
    undefined, // No creds yet
    signatureType,
    funderAddress,
  );

  // Attempt to derive credentials
  logAuth(logger, "info", "Attempting credential derivation", {
    category: "PROBE",
    runId,
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
    } else {
      httpStatus = 200; // Success
    }
  } catch (error: any) {
    httpStatus = error?.response?.status || error?.status;
    errorText = error?.response?.data?.error || error?.message || String(error);
  }

  // Add attempt to auth story
  const attempt: AuthAttempt = {
    attemptId: "A",
    mode: signatureType === 0 ? "EOA" : signatureType === 2 ? "SAFE" : "PROXY",
    sigType: signatureType,
    l1Auth: funderAddress || signerAddress,
    maker: funderAddress || signerAddress,
    funder: funderAddress,
    verifyEndpoint: "/create-or-derive-api-key",
    signedPath: "/create-or-derive-api-key",
    usedAxiosParams: false,
    httpStatus,
    errorTextShort: errorText?.slice(0, 100),
    success: Boolean(creds && httpStatus === 200),
  };

  authStory.addAttempt(attempt);

  if (!creds || httpStatus !== 200) {
    logAuth(logger, "error", "❌ Credential derivation failed", {
      category: "PROBE",
      runId,
      httpStatus,
      error: errorText,
    });

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: "CREDENTIAL_DERIVATION_FAILED",
    });
    authStory.printSummary();
    process.exit(1);
  }

  // Verify credentials with /balance-allowance
  logAuth(logger, "info", "Verifying credentials", {
    category: "PROBE",
    runId,
    attemptId: "B",
    apiKey: sanitizeCredential(creds.key, "apiKey"),
  });

  try {
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // The CLOB client may return error-like objects instead of throwing
    // Check for status field that indicates an error response
    type ErrorResponse = {
      status?: number;
      error?: string;
    };
    const errorResponse = response as ErrorResponse;

    if (errorResponse.status === 401 || errorResponse.status === 403) {
      logAuth(logger, "error", "❌ Credential verification failed", {
        category: "PROBE",
        runId,
        httpStatus: errorResponse.status,
      });

      authStory.setFinalResult({
        authOk: false,
        readyToTrade: false,
        reason: "CREDENTIAL_VERIFICATION_FAILED",
      });
      authStory.printSummary();
      process.exit(1);
    }

    logAuth(logger, "info", "✅ Auth successful", {
      category: "PROBE",
      runId,
    });

    authStory.setFinalResult({
      authOk: true,
      readyToTrade: true,
      reason: "OK",
    });
    authStory.printSummary();
    process.exit(0);
  } catch (error: any) {
    const status = error?.response?.status || error?.status;
    logAuth(logger, "error", "❌ Verification request failed", {
      category: "PROBE",
      runId,
      httpStatus: status,
      error: error?.message,
    });

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: "VERIFICATION_REQUEST_FAILED",
    });
    authStory.printSummary();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
