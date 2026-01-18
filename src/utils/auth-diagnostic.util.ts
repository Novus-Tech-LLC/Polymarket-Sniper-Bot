import type { Logger } from "./logger.util";

export type AuthFailureCause =
  | "WRONG_KEY_TYPE" // Using Builder keys as CLOB keys
  | "WALLET_NOT_ACTIVATED" // Wallet never traded on Polymarket
  | "WRONG_WALLET_BINDING" // Keys bound to different wallet
  | "WRONG_ENVIRONMENT" // Using test keys on prod or vice versa
  | "EXPIRED_CREDENTIALS" // Keys are expired or revoked
  | "DERIVE_FAILED" // Derive API key failed
  | "NETWORK_ERROR" // Network/connectivity issue
  | "UNKNOWN"; // Could not determine cause

export type AuthDiagnosticResult = {
  cause: AuthFailureCause;
  confidence: "high" | "medium" | "low";
  message: string;
  recommendations: string[];
};

/**
 * Diagnose auth failure based on error messages and context
 */
export function diagnoseAuthFailure(params: {
  userProvidedKeys: boolean;
  deriveEnabled: boolean;
  deriveFailed: boolean;
  deriveError?: string;
  verificationFailed: boolean;
  verificationError?: string;
  status?: number;
  walletAddress?: string;
  logger?: Logger;
}): AuthDiagnosticResult {
  const {
    userProvidedKeys,
    deriveEnabled,
    deriveFailed,
    deriveError,
    verificationFailed,
    verificationError,
    status,
  } = params;

  // Case 1: User provided keys but they fail verification with 401
  if (userProvidedKeys && verificationFailed && status === 401) {
    // Check if error message suggests wrong key type
    const errorLower = (verificationError ?? "").toLowerCase();
    if (
      errorLower.includes("invalid api key") ||
      errorLower.includes("unauthorized")
    ) {
      return {
        cause: "WRONG_KEY_TYPE",
        confidence: "high",
        message:
          "User-provided API credentials are invalid. Most common cause: using Builder API keys instead of CLOB API keys.",
        recommendations: [
          "Verify you are NOT using POLY_BUILDER_API_KEY credentials as POLYMARKET_API_KEY",
          "Builder keys (from https://docs.polymarket.com/developers/builders/builder-profile) are for gasless transactions ONLY",
          "CLOB keys must be obtained from https://polymarket.com/settings/api or derived automatically",
          "Try setting CLOB_DERIVE_CREDS=true and removing POLYMARKET_API_KEY/SECRET/PASSPHRASE",
        ],
      };
    }
    return {
      cause: "EXPIRED_CREDENTIALS",
      confidence: "medium",
      message:
        "User-provided API credentials failed verification. They may be expired, revoked, or bound to a different wallet.",
      recommendations: [
        "Check that POLYMARKET_API_KEY/SECRET/PASSPHRASE are current and not expired",
        "Verify the keys are bound to the wallet address in use (check PRIVATE_KEY matches the wallet that created the keys)",
        "Try regenerating keys at https://polymarket.com/settings/api",
        "Or switch to derived credentials: set CLOB_DERIVE_CREDS=true and remove explicit keys",
      ],
    };
  }

  // Case 2: Derive enabled but failed with 400 "Could not create api key"
  if (
    deriveEnabled &&
    deriveFailed &&
    (deriveError ?? "").toLowerCase().match(/could not create|cannot create/i)
  ) {
    return {
      cause: "WALLET_NOT_ACTIVATED",
      confidence: "high",
      message:
        'Derived credential creation failed with "Could not create api key". This occurs when the wallet has never traded on Polymarket.',
      recommendations: [
        "Visit https://polymarket.com and connect your wallet",
        "Make at least ONE small trade on any market (even $1)",
        "Wait for the transaction to confirm on-chain",
        "Restart the bot - it will automatically create API credentials",
        "This is a one-time setup requirement for new wallets",
      ],
    };
  }

  // Case 3: Neither user keys nor derive worked
  if (userProvidedKeys && verificationFailed && deriveEnabled && deriveFailed) {
    return {
      cause: "WRONG_WALLET_BINDING",
      confidence: "medium",
      message:
        "Both user-provided credentials AND derived credentials failed. The keys may be bound to a different wallet than PRIVATE_KEY.",
      recommendations: [
        "Verify PRIVATE_KEY matches the wallet that owns/created the API keys",
        "Check PUBLIC_KEY (if set) matches the derived address from PRIVATE_KEY",
        "Remove POLYMARKET_API_KEY/SECRET/PASSPHRASE and rely on CLOB_DERIVE_CREDS=true",
        "Or generate new keys for this specific wallet at https://polymarket.com/settings/api",
      ],
    };
  }

  // Case 4: Derive enabled but derived creds fail verification
  if (deriveEnabled && deriveFailed && verificationFailed) {
    return {
      cause: "DERIVE_FAILED",
      confidence: "high",
      message:
        "API credentials were derived but failed verification. This may indicate server-side issues or wallet configuration problems.",
      recommendations: [
        "Check if your wallet has the correct permissions on Polymarket",
        "Verify the wallet address matches your private key",
        "Try clearing the credential cache: rm -f /data/clob-creds.json",
        "Restart the bot to attempt credential derivation again",
        "If the issue persists, generate keys manually at https://polymarket.com/settings/api",
      ],
    };
  }

  // Case 5: Network/connectivity errors
  const errorText = (verificationError ?? "").toLowerCase();
  const networkPatterns = [
    /network/i,
    /timeout/i,
    /timed out/i,
    /connection/i,
    /econnrefused/i,
    /enotfound/i,
    /econnreset/i,
    /etimedout/i,
    /unreachable/i,
    /dns/i,
  ];
  if (networkPatterns.some((pattern) => pattern.test(errorText))) {
    return {
      cause: "NETWORK_ERROR",
      confidence: "high",
      message: "Network connectivity issue during authentication.",
      recommendations: [
        "Check your internet connection",
        "Verify RPC_URL is accessible and responding",
        "Check if Polymarket API (clob.polymarket.com) is reachable",
        "Retry in a few minutes",
      ],
    };
  }

  // Default: Unknown cause
  return {
    cause: "UNKNOWN",
    confidence: "low",
    message: "Authentication failed but the specific cause could not be determined.",
    recommendations: [
      "Enable detailed diagnostics: CLOB_PREFLIGHT_MATRIX=true",
      "Check logs for specific error messages",
      "Verify all required environment variables are set correctly",
      "Try the quickstart guide: https://github.com/telix5000/Polymarket-Sniper-Bot#quickstart",
    ],
  };
}

/**
 * Log auth diagnostic results in a user-friendly format
 */
export function logAuthDiagnostic(
  diagnostic: AuthDiagnosticResult,
  logger: Logger,
): void {
  logger.error("=================================================================");
  logger.error("🔍 AUTHENTICATION FAILURE DIAGNOSTIC");
  logger.error("=================================================================");
  logger.error(`Cause: ${diagnostic.cause} (confidence: ${diagnostic.confidence})`);
  logger.error("");
  logger.error(diagnostic.message);
  logger.error("");
  logger.error("Recommended Actions:");
  diagnostic.recommendations.forEach((rec, idx) => {
    logger.error(`  ${idx + 1}. ${rec}`);
  });
  logger.error("=================================================================");
}

/**
 * Check if ARB_LIVE_TRADING is actually the blocker
 * Returns true if ARB_LIVE_TRADING is the ONLY reason trading is disabled
 */
export function isLiveTradingTheOnlyBlocker(params: {
  liveTradingEnabled: boolean;
  authOk: boolean;
  approvalsOk: boolean;
  geoblockPassed: boolean;
}): boolean {
  // ARB_LIVE_TRADING is only the blocker if everything else is OK
  return (
    !params.liveTradingEnabled &&
    params.authOk &&
    params.approvalsOk &&
    params.geoblockPassed
  );
}

/**
 * Get context-aware warning list for detect-only mode
 */
export function getContextAwareWarnings(params: {
  liveTradingEnabled: boolean;
  authOk: boolean;
  approvalsOk: boolean;
  geoblockPassed: boolean;
}): string[] {
  const warnings: string[] = [];

  if (!params.authOk) {
    warnings.push(
      "Invalid or missing CLOB API credentials (see diagnostic above)",
    );
  }

  if (!params.approvalsOk) {
    warnings.push("Required on-chain approvals are not satisfied");
  }

  if (!params.geoblockPassed) {
    warnings.push("Geographic restriction: trading not available in your region");
  }

  if (!params.liveTradingEnabled && warnings.length === 0) {
    // Only mention ARB_LIVE_TRADING if it's the only blocker
    warnings.push("ARB_LIVE_TRADING not set to 'I_UNDERSTAND_THE_RISKS'");
  }

  return warnings;
}
