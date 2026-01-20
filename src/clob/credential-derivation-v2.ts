/**
 * CLOB Credential Derivation with Fallback System v2
 *
 * This module implements credential derivation with a hard-coded fallback ladder.
 * It tries different combinations of signature types and L1 auth addresses until
 * one works, then caches the successful configuration.
 *
 * Key Fix (2025-01-19):
 * - Now uses createOrDeriveApiKey() method (official/recommended approach)
 * - Previous approach: separate deriveApiKey() → createApiKey() calls (caused 401s)
 * - Matches working implementation from Polymarket's official agents repo
 *
 * Features:
 * - Single-flight derivation (prevents concurrent derivation attempts)
 * - Exponential backoff on failures (30s, 60s, 2m, 5m, 10m max)
 * - Rate-limited auth failure logging (prevents log spam)
 */

import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import crypto from "node:crypto";
import { Wallet } from "ethers";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { Logger } from "../utils/logger.util";
import {
  type StructuredLogger,
  generateAttemptId,
} from "../utils/structured-logger";
import type { AuthStoryBuilder, AuthAttempt } from "./auth-story";
import {
  resolveOrderIdentity,
  resolveL1AuthIdentity,
  logAuthIdentity,
  type IdentityResolverParams,
  type OrderIdentity,
  type L1AuthIdentity,
} from "./identity-resolver";
import {
  FALLBACK_LADDER,
  isInvalidL1HeadersError,
  isCouldNotCreateKeyError,
  extractStatusCode,
  extractErrorMessage,
  logFallbackAttempt,
  logFallbackResult,
  generateFailureSummary,
  type CredentialAttemptResult,
  type FallbackAttempt,
} from "./auth-fallback";
import {
  loadCachedCreds,
  saveCachedCreds,
  clearCachedCreds,
} from "../utils/credential-storage.util";
import { asClobSigner } from "../utils/clob-signer.util";
import {
  getAuthFailureRateLimiter,
  type AuthFailureKey,
} from "../utils/auth-failure-rate-limiter";
import { getSingleFlightDerivation } from "../utils/single-flight-derivation";
import { buildSignedPath } from "../utils/query-string.util";

/**
 * Helper to log with either structured or legacy logger
 */
function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  params: {
    logger?: Logger;
    structuredLogger?: StructuredLogger;
    context?: Record<string, unknown>;
    legacyPrefix?: string;
  },
): void {
  if (params.structuredLogger) {
    params.structuredLogger[level](message, params.context ?? {});
  } else if (params.logger) {
    const prefix = params.legacyPrefix ?? "[CredDerive]";
    params.logger[level](`${prefix} ${message}`);
  }
}

/**
 * Convert a fallback attempt result to an AuthAttempt for the auth story
 */
function createAuthAttemptFromResult(
  attemptId: string,
  attempt: FallbackAttempt,
  result: CredentialAttemptResult,
  orderIdentity: OrderIdentity,
  l1AuthIdentity: L1AuthIdentity,
): AuthAttempt {
  // Map SignatureType enum values to mode names
  const modeMap: { [key: number]: "EOA" | "SAFE" | "PROXY" } = {
    [SignatureType.EOA]: "EOA",
    [SignatureType.POLY_PROXY]: "PROXY",
    [SignatureType.POLY_GNOSIS_SAFE]: "SAFE",
  };
  const l1Auth = attempt.useEffectiveForL1
    ? orderIdentity.effectiveAddress
    : l1AuthIdentity.signingAddress;

  return {
    attemptId,
    mode: modeMap[attempt.signatureType] ?? "EOA",
    sigType: attempt.signatureType,
    l1Auth,
    maker: orderIdentity.makerAddress,
    funder: orderIdentity.funderAddress ?? orderIdentity.effectiveAddress,
    verifyEndpoint: "/balance-allowance",
    signedPath: "/balance-allowance",
    usedAxiosParams: false,
    httpStatus: result.statusCode,
    errorTextShort: result.error?.slice(0, 100),
    success: result.success,
  };
}

/**
 * Extended parameters with structured logger support
 */
export type ExtendedIdentityResolverParams = IdentityResolverParams & {
  /** Structured logger (if available) */
  structuredLogger?: StructuredLogger;
  /** Auth story builder (if available) */
  authStoryBuilder?: AuthStoryBuilder;
};

/**
 * Result of credential derivation
 */
export type DerivationResult = {
  /** Whether derivation succeeded */
  success: boolean;
  /** Credentials if successful */
  creds?: ApiKeyCreds;
  /** Signature type used */
  signatureType?: number;
  /** Whether effective address was used for L1 auth */
  usedEffectiveForL1?: boolean;
  /** Order identity */
  orderIdentity?: OrderIdentity;
  /** L1 auth identity */
  l1AuthIdentity?: L1AuthIdentity;
  /** Error message if failed */
  error?: string;
};

/**
 * Verify credentials by calling /balance-allowance
 * Uses rate limiter to prevent log spam on repeated failures
 */
async function verifyCredentials(params: {
  creds: ApiKeyCreds;
  wallet: Wallet;
  signatureType: number;
  funderAddress?: string;
  logger?: Logger;
  structuredLogger?: StructuredLogger;
  attemptId?: string;
}): Promise<boolean> {
  const rateLimiter = getAuthFailureRateLimiter();

  /**
   * Helper to log auth failure with rate limiting
   */
  const logAuthFailure = (status: number, errorMsg: string): void => {
    const failureKey: AuthFailureKey = {
      endpoint: "/balance-allowance",
      status,
      signerAddress: params.wallet.address,
      signatureType: params.signatureType,
    };

    const {
      shouldLogFull,
      shouldLogSummary,
      suppressedCount,
      nextFullLogMinutes,
    } = rateLimiter.shouldLog(failureKey);

    if (shouldLogFull) {
      log("debug", `Verification failed: ${status} ${errorMsg}`, {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: {
          category: "CRED_DERIVE",
          attemptId: params.attemptId,
          status,
          error: errorMsg,
        },
      });
      logAuthDiagnostics(params);
    } else if (shouldLogSummary) {
      // Emit a single-line summary instead of full details
      log(
        "debug",
        `Auth still failing (${status} ${errorMsg}) — suppressed ${suppressedCount} repeats (next full log in ${Math.ceil(nextFullLogMinutes)}m)`,
        {
          logger: params.logger,
          structuredLogger: params.structuredLogger,
          context: {
            category: "CRED_DERIVE",
            attemptId: params.attemptId,
            status,
            suppressedCount,
          },
        },
      );
    }
  };

  try {
    // Build query parameters
    const queryParams = {
      asset_type: AssetType.COLLATERAL,
      signature_type: params.signatureType,
    };

    // Build signed path with canonical query string
    const { signedPath } = buildSignedPath("/balance-allowance", queryParams);

    // Log what we're about to verify
    if (params.structuredLogger) {
      params.structuredLogger.debug("Verifying credentials", {
        category: "CRED_DERIVE",
        attemptId: params.attemptId,
        endpoint: "/balance-allowance",
        signedPath,
        queryParams,
        signatureType: params.signatureType,
        funderAddress: params.funderAddress,
      });
    }

    const client = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      asClobSigner(params.wallet),
      params.creds,
      params.signatureType,
      params.funderAddress,
    );

    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // Check for error response
    const errorResponse = response as { status?: number; error?: string };
    if (errorResponse.status === 401 || errorResponse.status === 403) {
      logAuthFailure(
        errorResponse.status,
        errorResponse.error ?? "Unauthorized",
      );
      return false;
    }

    if (errorResponse.error) {
      log("debug", `Verification returned error: ${errorResponse.error}`, {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: {
          category: "CRED_DERIVE",
          attemptId: params.attemptId,
          error: errorResponse.error,
        },
      });
      logAuthDiagnostics(params);
      return false;
    }

    log("debug", "Verification successful", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: {
        category: "CRED_DERIVE",
        attemptId: params.attemptId,
      },
    });
    return true;
  } catch (error) {
    const status = extractStatusCode(error);
    if (status === 401 || status === 403) {
      logAuthFailure(status, "Unauthorized");
      return false;
    }

    // Other errors might be transient (network issues, etc.)
    log(
      "warn",
      `Verification error (treating as invalid): ${extractErrorMessage(error)}`,
      {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: {
          category: "CRED_DERIVE",
          attemptId: params.attemptId,
          error: extractErrorMessage(error),
        },
      },
    );
    return false;
  }
}

// Track which credential fingerprints have already been logged to prevent duplicate diagnostics
// Uses a hash-based fingerprint to avoid exposing partial credential data
const loggedCredentialFingerprints = new Set<string>();
const MAX_FINGERPRINT_CACHE_SIZE = 100; // Prevent unbounded memory growth

/**
 * Create a hash-based fingerprint for credentials (safe to store, doesn't expose key data)
 * Uses SHA-256 truncated to 16 hex chars (64 bits) - acceptable collision probability
 * for deduplication within a single run (~1 in 2^64 for random inputs)
 */
function createCredentialFingerprint(
  key: string | undefined,
  secretLen: number,
  signatureType: number,
): string {
  const input = `${key ?? "no-key"}-${secretLen}-${signatureType}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Reset the logged credential fingerprints (for testing)
 */
export function resetLoggedCredentialFingerprints(): void {
  loggedCredentialFingerprints.clear();
}

/**
 * Log authentication diagnostics when verification fails
 * Only logs once per unique credential set to prevent spam
 */
function logAuthDiagnostics(params: {
  creds: ApiKeyCreds;
  wallet: Wallet;
  signatureType: number;
  logger?: Logger;
  structuredLogger?: StructuredLogger;
  attemptId?: string;
}): void {
  if (!params.logger && !params.structuredLogger) return;

  // Create a hash-based fingerprint to deduplicate repeated diagnostics for same credentials
  const fingerprint = createCredentialFingerprint(
    params.creds.key,
    params.creds.secret?.length ?? 0,
    params.signatureType,
  );
  if (loggedCredentialFingerprints.has(fingerprint)) {
    // Already logged diagnostics for these credentials, skip
    return;
  }

  // Enforce size limit to prevent memory leaks in long-running processes
  if (loggedCredentialFingerprints.size >= MAX_FINGERPRINT_CACHE_SIZE) {
    loggedCredentialFingerprints.clear();
  }
  loggedCredentialFingerprints.add(fingerprint);

  // Detect secret encoding (with null safety)
  const secret = params.creds.secret ?? "";
  const hasBase64Chars = secret.includes("+") || secret.includes("/");
  const hasBase64UrlChars = secret.includes("-") || secret.includes("_");
  const hasPadding = secret.endsWith("=");

  if (params.structuredLogger) {
    params.structuredLogger.debug("Auth diagnostics", {
      category: "CRED_DERIVE",
      attemptId: params.attemptId,
      signatureType: params.signatureType,
      walletAddress: params.wallet.address,
      apiKey: params.creds.key
        ? params.creds.key.slice(0, 8) + "..." + params.creds.key.slice(-4)
        : "missing",
      secret: params.creds.secret
        ? params.creds.secret.slice(0, 8) +
          "..." +
          params.creds.secret.slice(-4) +
          ` (len=${params.creds.secret.length})`
        : "missing",
      passphrase: params.creds.passphrase
        ? params.creds.passphrase.slice(0, 4) +
          "..." +
          params.creds.passphrase.slice(-4)
        : "missing",
      secretEncoding: hasBase64Chars
        ? "likely base64"
        : hasBase64UrlChars
          ? "likely base64url"
          : "unknown",
      hasBase64Chars,
      hasBase64UrlChars,
      hasPadding,
    });
  } else if (params.logger) {
    // Log header presence
    params.logger.debug("[CredDerive] Auth Diagnostics:");
    params.logger.debug(`  signatureType: ${params.signatureType}`);
    params.logger.debug(`  walletAddress: ${params.wallet.address}`);
    params.logger.debug(
      `  apiKey: ${params.creds.key ? params.creds.key.slice(0, 8) + "..." + params.creds.key.slice(-4) : "missing"}`,
    );
    params.logger.debug(
      `  secret: ${params.creds.secret ? params.creds.secret.slice(0, 8) + "..." + params.creds.secret.slice(-4) + ` (length=${params.creds.secret.length})` : "missing"}`,
    );
    params.logger.debug(
      `  passphrase: ${params.creds.passphrase ? params.creds.passphrase.slice(0, 4) + "..." + params.creds.passphrase.slice(-4) : "missing"}`,
    );

    params.logger.debug(
      `  secretEncoding: ${hasBase64Chars ? "likely base64" : hasBase64UrlChars ? "likely base64url" : "unknown"} (hasBase64Chars=${hasBase64Chars} hasBase64UrlChars=${hasBase64UrlChars} hasPadding=${hasPadding})`,
    );
  }
}

/**
 * Build effective signer proxy for L1 auth
 * When useEffectiveForL1=true, proxy the wallet to return the effective address for getAddress()
 */
function buildEffectiveSigner(
  wallet: Wallet,
  effectiveAddress: string,
): Wallet {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      // Intercept both getAddress() method and address property
      // getAddress() is the standard ethers method (returns Promise<string>)
      // address is a direct property access (returns string)
      // Both must be intercepted to ensure consistent behavior across different usage patterns
      if (prop === "getAddress") {
        return async () => effectiveAddress;
      }
      if (prop === "address") {
        return effectiveAddress;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

async function attemptDerive(params: {
  wallet: Wallet;
  attempt: FallbackAttempt;
  orderIdentity: OrderIdentity;
  l1AuthIdentity: L1AuthIdentity;
  funderAddress?: string;
  logger?: Logger;
  structuredLogger?: StructuredLogger;
  attemptId?: string;
}): Promise<CredentialAttemptResult> {
  try {
    // Determine the L1 auth address for this attempt
    const l1AuthAddress = params.attempt.useEffectiveForL1
      ? params.orderIdentity.effectiveAddress
      : params.l1AuthIdentity.signingAddress;

    // Build effective signer if needed (for L1 auth headers)
    const effectiveSigner = params.attempt.useEffectiveForL1
      ? buildEffectiveSigner(params.wallet, l1AuthAddress)
      : params.wallet;

    log("debug", "Creating CLOB client for credential derivation", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: {
        category: "CRED_DERIVE",
        attemptId: params.attemptId,
        signatureType: params.attempt.signatureType,
        l1AuthAddress,
        useEffectiveForL1: params.attempt.useEffectiveForL1,
      },
    });

    // Create a client with the specific signature type and funder address
    // CRITICAL FIX: Use effectiveSigner (not params.wallet) so L1 auth headers use correct address
    const client = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      asClobSigner(effectiveSigner),
      undefined, // No creds yet
      params.attempt.signatureType,
      params.funderAddress,
    );

    // Use createOrDeriveApiKey - the official recommended method
    // This handles both derive (if credentials exist) and create (if they don't) automatically
    // Matches the working implementation in Polymarket's official agents repo
    let creds: ApiKeyCreds | undefined;
    const method = "createOrDeriveApiKey";

    try {
      log("debug", "Using createOrDeriveApiKey (official method)", {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: {
          category: "CRED_DERIVE",
          attemptId: params.attemptId,
        },
      });

      creds = await client.createOrDeriveApiKey();
    } catch (error) {
      const status = extractStatusCode(error);
      const message = extractErrorMessage(error);

      log(
        "debug",
        `createOrDeriveApiKey failed: ${status ?? "unknown"} - ${message}`,
        {
          logger: params.logger,
          structuredLogger: params.structuredLogger,
          context: {
            category: "CRED_DERIVE",
            attemptId: params.attemptId,
            status: status ?? "unknown",
            error: message,
            signatureType: params.attempt.signatureType,
            l1AuthAddress: params.attempt.useEffectiveForL1
              ? params.orderIdentity.effectiveAddress
              : params.l1AuthIdentity.signingAddress,
            useEffectiveForL1: params.attempt.useEffectiveForL1,
          },
        },
      );

      // If it's "Could not create api key", this wallet hasn't traded yet
      if (isCouldNotCreateKeyError(error)) {
        return {
          success: false,
          error: "Could not create api key (wallet needs to trade first)",
          statusCode: 400,
        };
      }

      // If it's "Invalid L1 Request headers", this auth config doesn't work
      if (isInvalidL1HeadersError(error)) {
        return {
          success: false,
          error: "Invalid L1 Request headers",
          statusCode: 401,
        };
      }

      return {
        success: false,
        error: message,
        statusCode: status,
      };
    }

    // Check if we got credentials
    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      return {
        success: false,
        error: "No credentials returned from API",
      };
    }

    // Verify credentials work
    log("debug", `Verifying credentials from ${method}`, {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: {
        category: "CRED_DERIVE",
        attemptId: params.attemptId,
        method,
      },
    });
    const isValid = await verifyCredentials({
      creds,
      wallet: params.wallet,
      signatureType: params.attempt.signatureType,
      funderAddress: params.funderAddress,
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      attemptId: params.attemptId,
    });

    if (!isValid) {
      // Provide actionable error message with multiple possible causes
      // 401 verification failure can have several root causes, ordered by likelihood:
      // 1. Wrong signature type (very common - browser wallets need POLYMARKET_SIGNATURE_TYPE=2)
      // 2. Missing proxy/funder address (for Safe/Proxy wallets)
      // 3. Wallet never traded on Polymarket
      const errorDetails = [
        `Credentials derived but failed verification (401) with sigType=${params.attempt.signatureType}.`,
        "MOST LIKELY CAUSES (in order):",
        "(1) Wrong signature type - browser wallets need POLYMARKET_SIGNATURE_TYPE=2 AND POLYMARKET_PROXY_ADDRESS",
        "(2) Missing proxy address - Safe/Proxy wallets need POLYMARKET_PROXY_ADDRESS set to your Polymarket deposit address",
        "(3) Wallet not registered - if neither above applies, visit https://polymarket.com and make one trade",
        "Run 'npm run wallet:detect' to identify your correct wallet configuration.",
      ];
      return {
        success: false,
        error: errorDetails.join(" "),
        statusCode: 401,
      };
    }

    return {
      success: true,
      creds,
      signatureType: params.attempt.signatureType,
      usedEffectiveForL1: params.attempt.useEffectiveForL1,
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
      statusCode: extractStatusCode(error),
    };
  }
}

/**
 * Derive credentials with fallback ladder
 *
 * This function:
 * 1. Uses single-flight to prevent concurrent derivation attempts
 * 2. Implements exponential backoff on failures
 * 3. Checks for cached credentials first
 * 4. If no cache, tries each fallback combination in order
 * 5. Verifies credentials with /balance-allowance
 * 6. Caches the first working combination
 * 7. Returns the working credentials or undefined if all attempts fail
 */
export async function deriveCredentialsWithFallback(
  params: ExtendedIdentityResolverParams,
): Promise<DerivationResult> {
  const singleFlight = getSingleFlightDerivation(
    params.logger,
    params.structuredLogger,
  );

  // Check single-flight status before proceeding
  const { canRetry, reason } = singleFlight.shouldRetry();
  if (!canRetry && reason) {
    const sLogger = params.structuredLogger;
    if (sLogger) {
      sLogger.warn(`Derivation blocked: ${reason}`, {
        category: "CRED_DERIVE",
      });
    } else {
      params.logger?.warn(`[CredDerive] Derivation blocked: ${reason}`);
    }

    // Return cached result if available from single-flight
    const state = singleFlight.getState();
    if (state.hasCachedResult) {
      // Return the cached successful result
      return singleFlight.derive(async () => ({
        success: false,
        error: reason,
      }));
    }

    return {
      success: false,
      error: `Derivation blocked: ${reason}`,
    };
  }

  // Use single-flight to coordinate derivation
  return singleFlight.derive(() =>
    deriveCredentialsWithFallbackInternal(params),
  );
}

/**
 * Internal derivation function (called by single-flight coordinator)
 */
async function deriveCredentialsWithFallbackInternal(
  params: ExtendedIdentityResolverParams,
): Promise<DerivationResult> {
  const wallet = new Wallet(params.privateKey);
  const signerAddress = wallet.address;
  const sLogger = params.structuredLogger;

  // Start credential derivation logging
  if (sLogger) {
    sLogger.info("Starting credential derivation with fallback system", {
      category: "CRED_DERIVE",
    });
  } else {
    params.logger?.info(
      "[CredDerive] ========================================================",
    );
    params.logger?.info(
      "[CredDerive] Starting credential derivation with fallback system",
    );
    params.logger?.info(
      "[CredDerive] ========================================================",
    );
  }

  // Resolve identities (once at the beginning)
  const orderIdentity = resolveOrderIdentity(params);
  const l1AuthIdentity = resolveL1AuthIdentity(params, false);

  // Log auth identity once (deduplication happens in logAuthIdentity)
  logAuthIdentity({
    orderIdentity,
    l1AuthIdentity,
    signerAddress,
    logger: params.logger,
    structuredLogger: sLogger,
  });

  // Update auth story builder if available
  if (params.authStoryBuilder) {
    params.authStoryBuilder.setIdentity({ orderIdentity, l1AuthIdentity });
  }

  // Check for cached credentials first
  if (sLogger) {
    sLogger.info("Checking for cached credentials", {
      category: "CRED_DERIVE",
    });
  } else {
    params.logger?.info("[CredDerive] Checking for cached credentials...");
  }
  const cachedCreds = loadCachedCreds({
    signerAddress,
    signatureType: params.signatureType,
    funderAddress: params.funderAddress,
    logger: params.logger,
  });

  if (cachedCreds) {
    // Verify cached credentials
    if (sLogger) {
      sLogger.info("Verifying cached credentials", {
        category: "CRED_DERIVE",
      });
    } else {
      params.logger?.info("[CredDerive] Verifying cached credentials...");
    }
    const isValid = await verifyCredentials({
      creds: cachedCreds,
      wallet,
      signatureType:
        params.signatureType ?? orderIdentity.signatureTypeForOrders,
      funderAddress: params.funderAddress,
      logger: params.logger,
      structuredLogger: sLogger,
    });

    if (isValid) {
      if (sLogger) {
        sLogger.info("✅ Cached credentials verified successfully", {
          category: "CRED_DERIVE",
        });
      } else {
        params.logger?.info(
          "[CredDerive] ✅ Cached credentials verified successfully",
        );
      }
      return {
        success: true,
        creds: cachedCreds,
        signatureType:
          params.signatureType ?? orderIdentity.signatureTypeForOrders,
        orderIdentity,
        l1AuthIdentity,
      };
    } else {
      if (sLogger) {
        sLogger.warn("Cached credentials failed verification; will re-derive", {
          category: "CRED_DERIVE",
        });
      } else {
        params.logger?.warn(
          "[CredDerive] Cached credentials failed verification; will re-derive",
        );
      }
      // Clear invalid cache
      clearCachedCreds(params.logger);
    }
  } else {
    if (sLogger) {
      sLogger.info("No cached credentials found", {
        category: "CRED_DERIVE",
      });
    } else {
      params.logger?.info("[CredDerive] No cached credentials found");
    }
  }

  // Try each fallback combination
  if (sLogger) {
    sLogger.info("Attempting fallback combinations", {
      category: "CRED_DERIVE",
      totalAttempts: FALLBACK_LADDER.length,
    });
  } else {
    params.logger?.info(
      `[CredDerive] Attempting ${FALLBACK_LADDER.length} fallback combinations...`,
    );
  }

  const results: CredentialAttemptResult[] = [];

  for (let i = 0; i < FALLBACK_LADDER.length; i++) {
    const attempt = FALLBACK_LADDER[i]!;
    const attemptId = generateAttemptId(i);

    // Skip Safe/Proxy attempts when no funderAddress is configured
    // These signature types REQUIRE a funder address to work correctly
    const requiresFunder =
      attempt.signatureType === SignatureType.POLY_PROXY ||
      attempt.signatureType === SignatureType.POLY_GNOSIS_SAFE;

    if (requiresFunder && !params.funderAddress) {
      log("debug", `Skipping ${attempt.label}: no funderAddress configured`, {
        logger: params.logger,
        structuredLogger: sLogger,
        context: {
          category: "CRED_DERIVE",
          attemptId,
          signatureType: attempt.signatureType,
          reason: "missing_funder_address",
        },
      });
      results.push({
        success: false,
        error: "Skipped: Safe/Proxy requires funderAddress",
        signatureType: attempt.signatureType,
      });
      continue;
    }

    // Resolve L1 auth identity for this attempt
    const attemptL1Identity = resolveL1AuthIdentity(
      params,
      attempt.useEffectiveForL1,
    );

    // Update order identity if signature type changed
    const attemptOrderIdentity = resolveOrderIdentity({
      ...params,
      signatureType: attempt.signatureType,
    });

    if (sLogger) {
      sLogger.info("Attempting credential derivation", {
        category: "CRED_DERIVE",
        attemptId,
        attempt: i + 1,
        total: FALLBACK_LADDER.length,
        label: attempt.label,
        signatureType: attempt.signatureType,
        l1Auth: attempt.useEffectiveForL1
          ? attemptOrderIdentity.effectiveAddress
          : attemptL1Identity.signingAddress,
      });
    } else {
      logFallbackAttempt({
        attempt,
        attemptIndex: i,
        totalAttempts: FALLBACK_LADDER.length,
        orderIdentity: attemptOrderIdentity,
        l1AuthIdentity: attemptL1Identity,
        logger: params.logger,
      });
    }

    const result = await attemptDerive({
      wallet,
      attempt,
      orderIdentity: attemptOrderIdentity,
      l1AuthIdentity: attemptL1Identity,
      funderAddress: params.funderAddress,
      logger: params.logger,
      structuredLogger: sLogger,
      attemptId,
    });

    results.push(result);

    // Record this attempt in the auth story
    if (params.authStoryBuilder) {
      const authAttempt = createAuthAttemptFromResult(
        attemptId,
        attempt,
        result,
        attemptOrderIdentity,
        attemptL1Identity,
      );
      params.authStoryBuilder.addAttempt(authAttempt);
    }

    if (sLogger) {
      if (result.success) {
        sLogger.info("✅ Attempt succeeded", {
          category: "CRED_DERIVE",
          attemptId,
          label: attempt.label,
        });
      } else {
        sLogger.warn("❌ Attempt failed", {
          category: "CRED_DERIVE",
          attemptId,
          label: attempt.label,
          statusCode: result.statusCode,
          error: result.error,
        });
      }
    } else {
      logFallbackResult({ result, attempt, logger: params.logger });
    }

    if (result.success && result.creds) {
      // Success! Save to cache and return
      if (sLogger) {
        sLogger.info("✅ Credential derivation successful!", {
          category: "CRED_DERIVE",
          attemptId,
        });
      } else {
        params.logger?.info(
          "[CredDerive] ✅ Credential derivation successful!",
        );
      }

      saveCachedCreds({
        creds: result.creds,
        signerAddress,
        signatureType: result.signatureType,
        funderAddress: params.funderAddress,
        usedEffectiveForL1: result.usedEffectiveForL1,
        logger: params.logger,
      });

      return {
        success: true,
        creds: result.creds,
        signatureType: result.signatureType,
        usedEffectiveForL1: result.usedEffectiveForL1,
        orderIdentity: attemptOrderIdentity,
        l1AuthIdentity: attemptL1Identity,
      };
    }

    // If we got "Invalid L1 Request headers", immediately try swapping
    // the L1 auth address (as specified in requirements)
    if (
      result.statusCode === 401 &&
      result.error?.includes("Invalid L1 Request headers")
    ) {
      if (sLogger) {
        sLogger.info(
          "Got 'Invalid L1 Request headers' - retrying with swapped L1 auth",
          {
            category: "CRED_DERIVE",
            attemptId,
          },
        );
      } else {
        params.logger?.info(
          "[CredDerive] Got 'Invalid L1 Request headers' - immediately retrying with swapped L1 auth address",
        );
      }

      const swappedAttempt: FallbackAttempt = {
        ...attempt,
        useEffectiveForL1: !attempt.useEffectiveForL1,
        label: `${attempt.label} (swapped)`,
      };

      const swappedL1Identity = resolveL1AuthIdentity(
        params,
        swappedAttempt.useEffectiveForL1,
      );

      if (sLogger) {
        sLogger.info("Attempting swapped configuration", {
          category: "CRED_DERIVE",
          attemptId,
          label: swappedAttempt.label,
          l1Auth: swappedAttempt.useEffectiveForL1
            ? attemptOrderIdentity.effectiveAddress
            : swappedL1Identity.signingAddress,
        });
      } else {
        logFallbackAttempt({
          attempt: swappedAttempt,
          attemptIndex: i,
          totalAttempts: FALLBACK_LADDER.length,
          orderIdentity: attemptOrderIdentity,
          l1AuthIdentity: swappedL1Identity,
          logger: params.logger,
        });
      }

      const swappedResult = await attemptDerive({
        wallet,
        attempt: swappedAttempt,
        orderIdentity: attemptOrderIdentity,
        l1AuthIdentity: swappedL1Identity,
        funderAddress: params.funderAddress,
        logger: params.logger,
        structuredLogger: sLogger,
        attemptId: `${attemptId}-swap`,
      });

      // Record the swapped attempt in the auth story
      if (params.authStoryBuilder) {
        const swappedAuthAttempt = createAuthAttemptFromResult(
          `${attemptId}-swap`,
          swappedAttempt,
          swappedResult,
          attemptOrderIdentity,
          swappedL1Identity,
        );
        params.authStoryBuilder.addAttempt(swappedAuthAttempt);
      }

      if (sLogger) {
        if (swappedResult.success) {
          sLogger.info("✅ Swapped attempt succeeded", {
            category: "CRED_DERIVE",
            attemptId: `${attemptId}-swap`,
          });
        } else {
          sLogger.warn("❌ Swapped attempt failed", {
            category: "CRED_DERIVE",
            attemptId: `${attemptId}-swap`,
            statusCode: swappedResult.statusCode,
            error: swappedResult.error,
          });
        }
      } else {
        logFallbackResult({
          result: swappedResult,
          attempt: swappedAttempt,
          logger: params.logger,
        });
      }

      if (swappedResult.success && swappedResult.creds) {
        if (sLogger) {
          sLogger.info("✅ Swapped attempt successful!", {
            category: "CRED_DERIVE",
            attemptId: `${attemptId}-swap`,
          });
        } else {
          params.logger?.info("[CredDerive] ✅ Swapped attempt successful!");
        }

        saveCachedCreds({
          creds: swappedResult.creds,
          signerAddress,
          signatureType: swappedResult.signatureType,
          funderAddress: params.funderAddress,
          usedEffectiveForL1: swappedResult.usedEffectiveForL1,
          logger: params.logger,
        });

        return {
          success: true,
          creds: swappedResult.creds,
          signatureType: swappedResult.signatureType,
          usedEffectiveForL1: swappedResult.usedEffectiveForL1,
          orderIdentity: attemptOrderIdentity,
          l1AuthIdentity: swappedL1Identity,
        };
      }
    }
  }

  // All attempts failed
  if (sLogger) {
    sLogger.error("All credential derivation attempts failed", {
      category: "CRED_DERIVE",
      totalAttempts: FALLBACK_LADDER.length,
    });
  } else {
    generateFailureSummary(results, params.logger);
  }

  return {
    success: false,
    error: "All credential derivation attempts failed",
    orderIdentity,
    l1AuthIdentity,
  };
}
