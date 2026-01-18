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

// Compile regex patterns once for efficiency
const DERIVE_CREATE_ERROR_PATTERN = /could not create|cannot create/i;
const NETWORK_ERROR_PATTERNS = [
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
    walletAddress,
  } = params;

  // Case 1: User provided keys but they fail verification with 401
  if (userProvidedKeys && verificationFailed && status === 401) {
    // Check if error message suggests wrong key type
    const errorLower = (verificationError ?? "").toLowerCase();
    if (
      errorLower.includes("invalid api key") ||
      errorLower.includes("unauthorized")
    ) {
      // 401 "Invalid api key" can mean several things:
      // 1. Using Builder keys as CLOB keys (common mistake)
      // 2. Keys bound to different wallet than PRIVATE_KEY
      // 3. Keys are expired/revoked
      // 4. Keys are from wrong environment (test vs prod)
      // 
      // We can't determine which with certainty, so provide comprehensive guidance
      return {
        cause: "WRONG_KEY_TYPE",
        confidence: "medium",
        message:
          "User-provided API credentials are being rejected by Polymarket API (401 Unauthorized). This typically means one of: (1) using Builder API keys instead of CLOB API keys, (2) keys bound to a different wallet, (3) keys are expired/revoked, or (4) using test keys on production.",
        recommendations: [
          "First, verify you're using CLOB API keys from CLOB_DERIVE_CREDS=true (there is no web UI to manually generate CLOB API keys) (NOT Builder keys from the Developer profile)",
          "Verify the API keys were generated for THIS wallet address (check the wallet address matches PRIVATE_KEY)",
          "Check that keys are not expired - clear cache (rm /data/clob-creds.json) and restart to regenerate",
          "Ensure you're not using test/sandbox keys on production environment",
          "Try setting CLOB_DERIVE_CREDS=true and removing POLYMARKET_API_KEY/SECRET/PASSPHRASE to use auto-derived credentials",
          "For detailed debugging, enable CLOB_PREFLIGHT_MATRIX=true to test all auth combinations",
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
        "Try clearing credential cache (rm /data/clob-creds.json) and restarting to regenerate keys",
        "Or switch to derived credentials: set CLOB_DERIVE_CREDS=true and remove explicit keys",
      ],
    };
  }

  // Case 2: Derive enabled but failed with 400 "Could not create api key"
  if (
    deriveEnabled &&
    deriveFailed &&
    DERIVE_CREATE_ERROR_PATTERN.test(deriveError ?? "")
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
        "Or generate new keys for this specific wallet at CLOB_DERIVE_CREDS=true (there is no web UI to manually generate CLOB API keys)",
      ],
    };
  }

  // Case 4: Derive enabled but derived creds fail verification
  if (deriveEnabled && deriveFailed && verificationFailed) {
    return {
      cause: "DERIVE_FAILED",
      confidence: "high",
      message:
        "API credentials were derived but failed verification. This usually indicates: (1) the wallet has never traded on Polymarket, or (2) there's a mismatch between the derived credentials and the wallet.",
      recommendations: [
        "If this is a NEW wallet: Visit https://polymarket.com, connect this wallet, and make at least ONE trade",
        "The wallet must have trading history before the API can create/derive credentials",
        "After making a trade, clear the credential cache: rm -f /data/clob-creds.json",
        "Restart the bot to attempt credential derivation again",
        "Alternative: Generate keys manually at CLOB_DERIVE_CREDS=true (there is no web UI to manually generate CLOB API keys) and use POLYMARKET_API_KEY/SECRET/PASSPHRASE",
        "Verify the wallet address matches your PRIVATE_KEY (check logs for signer address)",
      ],
    };
  }

  // Case 5: Network/connectivity errors
  const errorText = verificationError ?? "";
  if (NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
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
      "Enable detailed diagnostics: set CLOB_PREFLIGHT_MATRIX=true in your .env file and restart",
      "The matrix mode will test all auth combinations and show exactly which configuration works",
      "Check logs for specific error messages and status codes",
      "Verify all required environment variables are set correctly (.env file)",
      "Try the quickstart guide: https://github.com/telix5000/Polymarket-Sniper-Bot#quickstart",
      "If using manual API keys, try switching to auto-derive: CLOB_DERIVE_CREDS=true",
    ],
  };
}

/**
 * Log auth diagnostic results in a user-friendly format
 */
export function logAuthDiagnostic(
  diagnostic: AuthDiagnosticResult,
  logger: Logger,
  walletAddress?: string,
): void {
  logger.error("=================================================================");
  logger.error("🔍 AUTHENTICATION FAILURE DIAGNOSTIC");
  logger.error("=================================================================");
  logger.error(`Cause: ${diagnostic.cause} (confidence: ${diagnostic.confidence})`);
  if (walletAddress) {
    logger.error(`Wallet Address: ${walletAddress}`);
  }
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
