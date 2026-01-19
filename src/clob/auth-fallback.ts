/**
 * CLOB Authentication Fallback Ladder
 *
 * This module implements a hard-coded fallback ladder for credential derivation
 * and verification. It tries different combinations of signature types and
 * L1 auth addresses until one works.
 */

import type { ApiKeyCreds, ClobClient } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { Wallet } from "ethers";
import type { Logger } from "../utils/logger.util";
import type { OrderIdentity, L1AuthIdentity } from "./identity-resolver";

/**
 * Fallback attempt configuration
 */
export type FallbackAttempt = {
  /** Signature type to try */
  signatureType: number;
  /** Whether to use effective address (true) or signer (false) for L1 auth */
  useEffectiveForL1: boolean;
  /** Human-readable label */
  label: string;
};

/**
 * Result of a credential derivation/verification attempt
 */
export type CredentialAttemptResult = {
  /** Whether the attempt succeeded */
  success: boolean;
  /** Credentials if successful */
  creds?: ApiKeyCreds;
  /** Signature type used */
  signatureType?: number;
  /** Whether effective address was used for L1 auth */
  usedEffectiveForL1?: boolean;
  /** Error message if failed */
  error?: string;
  /** HTTP status code if available */
  statusCode?: number;
};

/**
 * Hard-coded fallback ladder for L1 authentication
 *
 * Order rationale:
 * A) sigType=0, l1Auth=signer - Most common: EOA wallet
 * B) sigType=2, l1Auth=signer - Browser wallet (Safe) with signer auth
 * C) sigType=2, l1Auth=effective - Browser wallet (Safe) with proxy auth
 * D) sigType=1, l1Auth=signer - Legacy proxy with signer auth
 * E) sigType=1, l1Auth=effective - Legacy proxy with proxy auth
 */
export const FALLBACK_LADDER: readonly FallbackAttempt[] = [
  {
    signatureType: SignatureType.EOA,
    useEffectiveForL1: false,
    label: "A) EOA + signer auth",
  },
  {
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    useEffectiveForL1: false,
    label: "B) Safe + signer auth",
  },
  {
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    useEffectiveForL1: true,
    label: "C) Safe + effective auth",
  },
  {
    signatureType: SignatureType.POLY_PROXY,
    useEffectiveForL1: false,
    label: "D) Proxy + signer auth",
  },
  {
    signatureType: SignatureType.POLY_PROXY,
    useEffectiveForL1: true,
    label: "E) Proxy + effective auth",
  },
] as const;

/**
 * Check if an error is a 401 "Invalid L1 Request headers" error
 */
export function isInvalidL1HeadersError(error: unknown): boolean {
  const errObj = error as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };

  const status = errObj?.response?.status;
  if (status !== 401) {
    return false;
  }

  const message = errObj?.message?.toLowerCase() ?? "";

  // Cache the stringified data for efficiency
  const dataStr = errObj?.response?.data
    ? typeof errObj.response.data === "string"
      ? errObj.response.data.toLowerCase()
      : JSON.stringify(errObj.response.data).toLowerCase()
    : "";

  return (
    message.includes("invalid l1 request headers") ||
    dataStr.includes("invalid l1 request headers")
  );
}

/**
 * Check if an error is a 400 "Could not create api key" error
 */
export function isCouldNotCreateKeyError(error: unknown): boolean {
  const errObj = error as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };

  const status = errObj?.response?.status;
  if (status !== 400) {
    return false;
  }

  const message = errObj?.message?.toLowerCase() ?? "";

  // Cache the stringified data for efficiency
  const dataStr = errObj?.response?.data
    ? typeof errObj.response.data === "string"
      ? errObj.response.data.toLowerCase()
      : JSON.stringify(errObj.response.data).toLowerCase()
    : "";

  return (
    message.includes("could not create api key") ||
    dataStr.includes("could not create api key")
  );
}

/**
 * Extract HTTP status code from error
 */
export function extractStatusCode(error: unknown): number | undefined {
  const errObj = error as { response?: { status?: number }; status?: number };
  return errObj?.response?.status ?? errObj?.status;
}

/**
 * Extract error message from error object
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  const errObj = error as {
    message?: string;
    response?: { data?: unknown };
  };

  if (errObj?.message) {
    return errObj.message;
  }

  if (errObj?.response?.data) {
    if (typeof errObj.response.data === "string") {
      return errObj.response.data;
    }
    return JSON.stringify(errObj.response.data);
  }

  return "Unknown error";
}

/**
 * Signature type label for logging
 */
export function signatureTypeLabel(sigType: number): string {
  switch (sigType) {
    case SignatureType.EOA:
      return "EOA";
    case SignatureType.POLY_PROXY:
      return "Proxy";
    case SignatureType.POLY_GNOSIS_SAFE:
      return "Safe";
    default:
      return `Unknown(${sigType})`;
  }
}

/**
 * Log fallback attempt details
 */
export function logFallbackAttempt(params: {
  attempt: FallbackAttempt;
  attemptIndex: number;
  totalAttempts: number;
  orderIdentity: OrderIdentity;
  l1AuthIdentity: L1AuthIdentity;
  logger?: Logger;
}): void {
  if (!params.logger) return;

  const l1Auth = params.attempt.useEffectiveForL1
    ? params.orderIdentity.effectiveAddress
    : params.l1AuthIdentity.signingAddress;

  params.logger.info(
    `[AuthFallback] Attempt ${params.attemptIndex + 1}/${params.totalAttempts}: ${params.attempt.label}`,
  );
  params.logger.debug(
    `[AuthFallback]   sigType=${params.attempt.signatureType} (${signatureTypeLabel(params.attempt.signatureType)}) ` +
      `l1Auth=${l1Auth} ` +
      `signer=${params.l1AuthIdentity.signingAddress}`,
  );
}

/**
 * Log fallback attempt result
 */
export function logFallbackResult(params: {
  result: CredentialAttemptResult;
  attempt: FallbackAttempt;
  logger?: Logger;
}): void {
  if (!params.logger) return;

  if (params.result.success) {
    params.logger.info(`[AuthFallback] ✅ Success: ${params.attempt.label}`);
  } else {
    const statusPart = params.result.statusCode
      ? ` (${params.result.statusCode})`
      : "";
    params.logger.warn(
      `[AuthFallback] ❌ Failed: ${params.attempt.label}${statusPart} - ${params.result.error ?? "unknown"}`,
    );
  }
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  const logLevel = (
    process.env.LOG_LEVEL ??
    process.env.log_level ??
    ""
  ).toLowerCase();
  return (
    logLevel === "debug" || logLevel === "trace" || process.env.DEBUG === "1"
  );
}

/**
 * Generate a summary of all failed attempts
 *
 * This function is now log-level aware:
 * - At LOG_LEVEL=debug: outputs full verbose failure summary
 * - Otherwise: outputs a single-line compact summary for the Auth Story
 */
export function generateFailureSummary(
  results: CredentialAttemptResult[],
  logger?: Logger,
): void {
  if (!logger) return;

  // Always log a single compact summary line (consumed by Auth Story)
  const failedCount = results.filter((r) => !r.success).length;
  const lastError = results[results.length - 1]?.error ?? "unknown";
  logger.error(
    `[AuthFallback] All ${failedCount} credential derivation attempts failed. Last error: ${lastError}`,
  );

  // Check if it's a 401 verification failure (credentials derived but rejected)
  const has401Verification = results.some(
    (r) => r.statusCode === 401 && r.error?.includes("verification"),
  );

  // Always show the most likely cause prominently
  logger.warn(
    "[AuthFallback] ========================================================",
  );
  logger.warn("[AuthFallback] 🔍 MOST LIKELY CAUSES (in order):");
  logger.warn(
    "[AuthFallback] ========================================================",
  );

  if (has401Verification) {
    // 401 during verification is almost always a signature type mismatch
    logger.warn(
      "[AuthFallback]   1. ⚠️  WRONG SIGNATURE TYPE - If you logged in via browser",
    );
    logger.warn(
      "[AuthFallback]      to Polymarket, you need POLYMARKET_SIGNATURE_TYPE=2",
    );
    logger.warn(
      "[AuthFallback]      AND POLYMARKET_PROXY_ADDRESS=<your-polymarket-deposit-address>",
    );
    logger.warn("[AuthFallback]");
    logger.warn(
      "[AuthFallback]   2. Missing proxy/funder address for Safe wallet mode",
    );
    logger.warn("[AuthFallback]");
    logger.warn(
      "[AuthFallback]   3. Wallet never traded (if none of the above apply)",
    );
  } else {
    logger.warn("[AuthFallback]   1. Wallet has never traded on Polymarket");
    logger.warn(
      "[AuthFallback]   2. Wrong signature type (need POLYMARKET_SIGNATURE_TYPE=2 for browser wallets)",
    );
    logger.warn(
      "[AuthFallback]   3. Missing POLYMARKET_PROXY_ADDRESS for Safe/Proxy wallets",
    );
  }

  logger.warn(
    "[AuthFallback] ========================================================",
  );
  logger.warn("[AuthFallback] 🛠️  TO FIX:");
  logger.warn(
    "[AuthFallback] ========================================================",
  );
  logger.warn(
    "[AuthFallback]   1. Run 'npm run wallet:detect' to identify your wallet type",
  );
  logger.warn(
    "[AuthFallback]   2. If browser login: Set POLYMARKET_SIGNATURE_TYPE=2",
  );
  logger.warn(
    "[AuthFallback]   3. Set POLYMARKET_PROXY_ADDRESS to your Polymarket deposit address",
  );
  logger.warn(
    "[AuthFallback]      (found in Polymarket UI under Profile/Wallet)",
  );
  logger.warn(
    "[AuthFallback]   4. Clear credential cache: rm -f /data/clob-creds.json",
  );
  logger.warn("[AuthFallback]   5. Restart the bot");
  logger.warn(
    "[AuthFallback] ========================================================",
  );

  // Verbose details only at debug level to prevent spam
  if (!isDebugEnabled()) {
    return;
  }

  logger.debug(
    "[AuthFallback] ========================================================",
  );
  logger.debug("[AuthFallback] CREDENTIAL DERIVATION ATTEMPT DETAILS");
  logger.debug(
    "[AuthFallback] ========================================================",
  );

  results.forEach((result, index) => {
    const attempt = FALLBACK_LADDER[index];
    if (!attempt) return;

    const statusPart = result.statusCode ? ` [${result.statusCode}]` : "";
    logger.debug(
      `[AuthFallback] ${attempt.label}${statusPart}: ${result.error ?? "unknown"}`,
    );
  });

  logger.debug(
    "[AuthFallback] ========================================================",
  );
}
