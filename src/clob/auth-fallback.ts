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
  const dataStr = JSON.stringify(errObj?.response?.data ?? "").toLowerCase();

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
  const dataStr = JSON.stringify(errObj?.response?.data ?? "").toLowerCase();

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
    params.logger.info(
      `[AuthFallback] ✅ Success: ${params.attempt.label}`,
    );
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
 * Generate a summary of all failed attempts
 */
export function generateFailureSummary(
  results: CredentialAttemptResult[],
  logger?: Logger,
): void {
  if (!logger) return;

  logger.error(
    "[AuthFallback] ========================================================",
  );
  logger.error(
    "[AuthFallback] ALL CREDENTIAL DERIVATION ATTEMPTS FAILED",
  );
  logger.error(
    "[AuthFallback] ========================================================",
  );

  results.forEach((result, index) => {
    const attempt = FALLBACK_LADDER[index];
    if (!attempt) return;

    const statusPart = result.statusCode ? ` [${result.statusCode}]` : "";
    logger.error(
      `[AuthFallback] ${attempt.label}${statusPart}: ${result.error ?? "unknown"}`,
    );
  });

  logger.error(
    "[AuthFallback] ========================================================",
  );
  logger.error(
    "[AuthFallback] POSSIBLE CAUSES:",
  );
  logger.error(
    "[AuthFallback]   1. Wallet has never traded on Polymarket",
  );
  logger.error(
    "[AuthFallback]   2. Incorrect funder/proxy address for Safe/Proxy mode",
  );
  logger.error(
    "[AuthFallback]   3. Private key doesn't match expected wallet",
  );
  logger.error(
    "[AuthFallback]   4. Network connectivity issues",
  );
  logger.error(
    "[AuthFallback] ========================================================",
  );
  logger.error(
    "[AuthFallback] TO FIX:",
  );
  logger.error(
    "[AuthFallback]   1. Visit https://polymarket.com and connect wallet",
  );
  logger.error(
    "[AuthFallback]   2. Make at least one small trade ($1+)",
  );
  logger.error(
    "[AuthFallback]   3. Wait for transaction confirmation (1-2 min)",
  );
  logger.error(
    "[AuthFallback]   4. Restart bot",
  );
  logger.error(
    "[AuthFallback] ========================================================",
  );
}
