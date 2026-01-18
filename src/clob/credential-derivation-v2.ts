/**
 * CLOB Credential Derivation with Fallback System v2
 * 
 * This module implements credential derivation with a hard-coded fallback ladder.
 * It tries different combinations of signature types and L1 auth addresses until
 * one works, then caches the successful configuration.
 */

import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { Logger } from "../utils/logger.util";
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
} from "../utils/credential-storage.util";

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
 */
async function verifyCredentials(params: {
  creds: ApiKeyCreds;
  wallet: Wallet;
  signatureType: number;
  logger?: Logger;
}): Promise<boolean> {
  try {
    const client = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      params.wallet,
      params.creds,
      params.signatureType,
    );

    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // Check for error response
    const errorResponse = response as { status?: number; error?: string };
    if (errorResponse.status === 401 || errorResponse.status === 403) {
      params.logger?.debug(
        `[CredDerive] Verification failed: ${errorResponse.status} ${errorResponse.error ?? "Unauthorized"}`,
      );
      return false;
    }

    if (errorResponse.error) {
      params.logger?.debug(
        `[CredDerive] Verification returned error: ${errorResponse.error}`,
      );
      return false;
    }

    params.logger?.debug("[CredDerive] Verification successful");
    return true;
  } catch (error) {
    const status = extractStatusCode(error);
    if (status === 401 || status === 403) {
      params.logger?.debug(
        `[CredDerive] Verification failed: ${status} Unauthorized`,
      );
      return false;
    }

    // Other errors might be transient (network issues, etc.)
    params.logger?.warn(
      `[CredDerive] Verification error (treating as invalid): ${extractErrorMessage(error)}`,
    );
    return false;
  }
}

/**
 * Attempt to derive credentials with a specific configuration
 */
async function attemptDerive(params: {
  wallet: Wallet;
  attempt: FallbackAttempt;
  orderIdentity: OrderIdentity;
  l1AuthIdentity: L1AuthIdentity;
  funderAddress?: string;
  logger?: Logger;
}): Promise<CredentialAttemptResult> {
  try {
    // Create a client with the specific signature type and funder address
    const client = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      params.wallet,
      undefined, // No creds yet
      params.attempt.signatureType,
      params.funderAddress,
    );

    const deriveFn = client as ClobClient & {
      deriveApiKey?: () => Promise<ApiKeyCreds>;
      createApiKey?: () => Promise<ApiKeyCreds>;
    };

    // Try deriveApiKey first (for existing wallets)
    let creds: ApiKeyCreds | undefined;
    let method = "";

    if (deriveFn.deriveApiKey) {
      try {
        params.logger?.debug("[CredDerive] Trying deriveApiKey...");
        method = "deriveApiKey";
        creds = await deriveFn.deriveApiKey();
      } catch (deriveError) {
        const status = extractStatusCode(deriveError);
        params.logger?.debug(
          `[CredDerive] deriveApiKey failed: ${status ?? "unknown"} - ${extractErrorMessage(deriveError)}`,
        );

        // If it's an "Invalid L1 Request headers" error, don't try createApiKey
        // because the issue is with the auth configuration, not whether the key exists
        if (isInvalidL1HeadersError(deriveError)) {
          return {
            success: false,
            error: "Invalid L1 Request headers",
            statusCode: 401,
          };
        }

        // Otherwise, continue to try createApiKey
      }
    }

    // If deriveApiKey didn't work, try createApiKey
    if (!creds && deriveFn.createApiKey) {
      try {
        params.logger?.debug("[CredDerive] Trying createApiKey...");
        method = "createApiKey";
        creds = await deriveFn.createApiKey();
      } catch (createError) {
        const status = extractStatusCode(createError);
        const message = extractErrorMessage(createError);

        // If it's "Could not create api key", this wallet hasn't traded yet
        if (isCouldNotCreateKeyError(createError)) {
          return {
            success: false,
            error: "Could not create api key (wallet needs to trade first)",
            statusCode: 400,
          };
        }

        // If it's "Invalid L1 Request headers", this auth config doesn't work
        if (isInvalidL1HeadersError(createError)) {
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
    }

    // Check if we got credentials
    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      return {
        success: false,
        error: "No credentials returned from API",
      };
    }

    // Verify credentials work
    params.logger?.debug(
      `[CredDerive] Verifying credentials from ${method}...`,
    );
    const isValid = await verifyCredentials({
      creds,
      wallet: params.wallet,
      signatureType: params.attempt.signatureType,
      logger: params.logger,
    });

    if (!isValid) {
      return {
        success: false,
        error: "Credentials failed verification",
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
 * 1. Checks for cached credentials first
 * 2. If no cache, tries each fallback combination in order
 * 3. Verifies credentials with /balance-allowance
 * 4. Caches the first working combination
 * 5. Returns the working credentials or undefined if all attempts fail
 */
export async function deriveCredentialsWithFallback(
  params: IdentityResolverParams,
): Promise<DerivationResult> {
  const wallet = new Wallet(params.privateKey);
  const signerAddress = wallet.address;

  params.logger?.info(
    "[CredDerive] ========================================================",
  );
  params.logger?.info(
    "[CredDerive] Starting credential derivation with fallback system",
  );
  params.logger?.info(
    "[CredDerive] ========================================================",
  );

  // Resolve identities
  const orderIdentity = resolveOrderIdentity(params);
  const l1AuthIdentity = resolveL1AuthIdentity(params, false);

  // Log auth identity
  logAuthIdentity({
    orderIdentity,
    l1AuthIdentity,
    signerAddress,
    logger: params.logger,
  });

  // Check for cached credentials first
  params.logger?.info("[CredDerive] Checking for cached credentials...");
  const cachedCreds = loadCachedCreds({
    signerAddress,
    signatureType: params.signatureType,
    funderAddress: params.funderAddress,
    logger: params.logger,
  });

  if (cachedCreds) {
    // Verify cached credentials
    params.logger?.info("[CredDerive] Verifying cached credentials...");
    const isValid = await verifyCredentials({
      creds: cachedCreds,
      wallet,
      signatureType: params.signatureType ?? orderIdentity.signatureTypeForOrders,
      logger: params.logger,
    });

    if (isValid) {
      params.logger?.info(
        "[CredDerive] ✅ Cached credentials verified successfully",
      );
      return {
        success: true,
        creds: cachedCreds,
        signatureType: params.signatureType ?? orderIdentity.signatureTypeForOrders,
        orderIdentity,
        l1AuthIdentity,
      };
    } else {
      params.logger?.warn(
        "[CredDerive] Cached credentials failed verification; will re-derive",
      );
      // Clear invalid cache
      const { clearCachedCreds } = await import(
        "../utils/credential-storage.util"
      );
      clearCachedCreds(params.logger);
    }
  } else {
    params.logger?.info("[CredDerive] No cached credentials found");
  }

  // Try each fallback combination
  params.logger?.info(
    `[CredDerive] Attempting ${FALLBACK_LADDER.length} fallback combinations...`,
  );

  const results: CredentialAttemptResult[] = [];

  for (let i = 0; i < FALLBACK_LADDER.length; i++) {
    const attempt = FALLBACK_LADDER[i]!;

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

    logFallbackAttempt({
      attempt,
      attemptIndex: i,
      totalAttempts: FALLBACK_LADDER.length,
      orderIdentity: attemptOrderIdentity,
      l1AuthIdentity: attemptL1Identity,
      logger: params.logger,
    });

    const result = await attemptDerive({
      wallet,
      attempt,
      orderIdentity: attemptOrderIdentity,
      l1AuthIdentity: attemptL1Identity,
      funderAddress: params.funderAddress,
      logger: params.logger,
    });

    results.push(result);
    logFallbackResult({ result, attempt, logger: params.logger });

    if (result.success && result.creds) {
      // Success! Save to cache and return
      params.logger?.info(
        "[CredDerive] ✅ Credential derivation successful!",
      );

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
      params.logger?.info(
        "[CredDerive] Got 'Invalid L1 Request headers' - immediately retrying with swapped L1 auth address",
      );

      const swappedAttempt: FallbackAttempt = {
        ...attempt,
        useEffectiveForL1: !attempt.useEffectiveForL1,
        label: `${attempt.label} (swapped)`,
      };

      const swappedL1Identity = resolveL1AuthIdentity(
        params,
        swappedAttempt.useEffectiveForL1,
      );

      logFallbackAttempt({
        attempt: swappedAttempt,
        attemptIndex: i,
        totalAttempts: FALLBACK_LADDER.length,
        orderIdentity: attemptOrderIdentity,
        l1AuthIdentity: swappedL1Identity,
        logger: params.logger,
      });

      const swappedResult = await attemptDerive({
        wallet,
        attempt: swappedAttempt,
        orderIdentity: attemptOrderIdentity,
        l1AuthIdentity: swappedL1Identity,
        funderAddress: params.funderAddress,
        logger: params.logger,
      });

      logFallbackResult({
        result: swappedResult,
        attempt: swappedAttempt,
        logger: params.logger,
      });

      if (swappedResult.success && swappedResult.creds) {
        params.logger?.info(
          "[CredDerive] ✅ Swapped attempt successful!",
        );

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
  generateFailureSummary(results, params.logger);

  return {
    success: false,
    error: "All credential derivation attempts failed",
    orderIdentity,
    l1AuthIdentity,
  };
}
