/**
 * Identity Resolution for CLOB Authentication
 *
 * This module handles auto-detection and resolution of wallet identities
 * for both order signing and L1 authentication endpoints.
 */

import { SignatureType } from "@polymarket/order-utils";
import { Wallet } from "ethers";
import type { Logger } from "../utils/logger.util";
import type { StructuredLogger } from "../utils/structured-logger";

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
  },
): void {
  if (params.structuredLogger) {
    params.structuredLogger[level](message, {
      category: "IDENTITY",
      ...params.context,
    });
  } else if (params.logger) {
    params.logger[level](`[Identity] ${message}`);
  }
}

/**
 * Wallet mode detected or forced
 */
export type WalletMode = "eoa" | "safe" | "proxy";

// Deduplication flags for log suppression
// Note: These are module-level flags for single-threaded Node.js logging deduplication.
// In concurrent scenarios, the worst case is a duplicate log (harmless for diagnostics).
let walletModeLogged = false;
let orderIdentityLogged = false;
let l1AuthIdentityLogged = false;

/**
 * Reset logging deduplication flags (for testing)
 */
export function resetIdentityLogging(): void {
  walletModeLogged = false;
  orderIdentityLogged = false;
  l1AuthIdentityLogged = false;
}

/**
 * Identity configuration for order signing and submission
 */
export type OrderIdentity = {
  /** Signature type for orders (0=EOA, 1=PROXY, 2=SAFE) */
  signatureTypeForOrders: number;
  /** Maker address (who places the order) */
  makerAddress: string;
  /** Funder address (who pays for the order) */
  funderAddress: string;
  /** Effective address (for POLY_ADDRESS header) */
  effectiveAddress: string;
};

/**
 * Identity configuration for L1 authentication endpoints
 */
export type L1AuthIdentity = {
  /** Signature type for L1 auth (0=EOA, 1=PROXY, 2=SAFE) */
  signatureTypeForAuth: number;
  /** Address used in L1 auth headers (POLY_ADDRESS) */
  l1AuthAddress: string;
  /** Address used for signing (actual private key owner) */
  signingAddress: string;
};

/**
 * Parameters for identity resolution
 */
export type IdentityResolverParams = {
  /** Private key (required) */
  privateKey: string;
  /** Configured signature type (optional, will auto-detect if not provided) */
  signatureType?: number;
  /** Funder/proxy address (required for PROXY/SAFE modes) */
  funderAddress?: string;
  /** Force specific wallet mode (optional override) */
  forceWalletMode?: "auto" | "eoa" | "safe" | "proxy";
  /** Force specific L1 auth address (optional override) */
  forceL1Auth?: "auto" | "signer" | "effective";
  /** Logger for diagnostics (legacy) */
  logger?: Logger;
  /** Structured logger (preferred) */
  structuredLogger?: StructuredLogger;
};

/**
 * Auto-detect wallet mode based on configuration
 */
export function detectWalletMode(params: {
  signatureType?: number;
  funderAddress?: string;
  forceWalletMode?: "auto" | "eoa" | "safe" | "proxy";
  logger?: Logger;
  structuredLogger?: StructuredLogger;
}): WalletMode {
  // Check for forced override
  if (params.forceWalletMode && params.forceWalletMode !== "auto") {
    log(
      "info",
      `Wallet mode forced to: ${params.forceWalletMode.toUpperCase()}`,
      {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: { walletMode: params.forceWalletMode },
      },
    );
    return params.forceWalletMode;
  }

  // Auto-detect based on signature type
  if (params.signatureType === SignatureType.POLY_GNOSIS_SAFE) {
    if (!params.funderAddress) {
      log(
        "warn",
        "signatureType=2 (SAFE) but no funderAddress configured; defaulting to EOA",
        {
          logger: params.logger,
          structuredLogger: params.structuredLogger,
          context: { signatureType: params.signatureType },
        },
      );
      return "eoa";
    }
    if (!walletModeLogged) {
      log("debug", "Auto-detected wallet mode: SAFE", {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: { walletMode: "safe", signatureType: 2 },
      });
      walletModeLogged = true;
    }
    return "safe";
  }

  if (params.signatureType === SignatureType.POLY_PROXY) {
    if (!params.funderAddress) {
      log(
        "warn",
        "signatureType=1 (PROXY) but no funderAddress configured; defaulting to EOA",
        {
          logger: params.logger,
          structuredLogger: params.structuredLogger,
          context: { signatureType: params.signatureType },
        },
      );
      return "eoa";
    }
    if (!walletModeLogged) {
      log("debug", "Auto-detected wallet mode: PROXY", {
        logger: params.logger,
        structuredLogger: params.structuredLogger,
        context: { walletMode: "proxy", signatureType: 1 },
      });
      walletModeLogged = true;
    }
    return "proxy";
  }

  // Default to EOA
  if (!walletModeLogged) {
    log("debug", "Auto-detected wallet mode: EOA", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: { walletMode: "eoa", signatureType: params.signatureType ?? 0 },
    });
    walletModeLogged = true;
  }
  return "eoa";
}

/**
 * Resolve order identity (for order signing and submission)
 *
 * This determines:
 * - signatureTypeForOrders: Which signature type to use for orders
 * - makerAddress: Who is placing the order
 * - funderAddress: Who is funding the order
 * - effectiveAddress: What goes in POLY_ADDRESS header for orders
 */
export function resolveOrderIdentity(
  params: IdentityResolverParams,
): OrderIdentity {
  const wallet = new Wallet(params.privateKey);
  const signerAddress = wallet.address;

  const walletMode = detectWalletMode({
    signatureType: params.signatureType,
    funderAddress: params.funderAddress,
    forceWalletMode: params.forceWalletMode,
    logger: params.logger,
    structuredLogger: params.structuredLogger,
  });

  let signatureTypeForOrders: number;
  let makerAddress: string;
  let funderAddress: string;
  let effectiveAddress: string;

  switch (walletMode) {
    case "safe":
      signatureTypeForOrders = SignatureType.POLY_GNOSIS_SAFE;
      makerAddress = params.funderAddress!;
      funderAddress = params.funderAddress!;
      effectiveAddress = params.funderAddress!;
      break;

    case "proxy":
      signatureTypeForOrders = SignatureType.POLY_PROXY;
      makerAddress = params.funderAddress!;
      funderAddress = params.funderAddress!;
      effectiveAddress = params.funderAddress!;
      break;

    case "eoa":
    default:
      signatureTypeForOrders = SignatureType.EOA;
      makerAddress = signerAddress;
      funderAddress = signerAddress;
      effectiveAddress = signerAddress;
      break;
  }

  if (!orderIdentityLogged) {
    log("debug", "Order identity resolved", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: {
        walletMode,
        signatureType: signatureTypeForOrders,
        makerAddress,
        funderAddress,
        effectiveAddress,
      },
    });
    orderIdentityLogged = true;
  }

  return {
    signatureTypeForOrders,
    makerAddress,
    funderAddress,
    effectiveAddress,
  };
}

/**
 * Resolve L1 authentication identity (for /auth/derive-api-key and /auth/api-key)
 *
 * This determines:
 * - signatureTypeForAuth: Which signature type to use for L1 auth
 * - l1AuthAddress: Which address to use in L1 auth headers
 * - signingAddress: Which address actually signs (EOA from private key)
 *
 * Note: L1 auth address may differ from order maker/effective address.
 * This is intentional and allows the fallback system to try different combinations.
 */
export function resolveL1AuthIdentity(
  params: IdentityResolverParams,
  preferEffective: boolean = false,
): L1AuthIdentity {
  const wallet = new Wallet(params.privateKey);
  const signerAddress = wallet.address;

  const orderIdentity = resolveOrderIdentity(params);

  // Check for forced override
  let useEffective = preferEffective;
  if (params.forceL1Auth === "signer") {
    useEffective = false;
    log("debug", "L1 auth forced to use signer address", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: { forceL1Auth: "signer" },
    });
  } else if (params.forceL1Auth === "effective") {
    useEffective = true;
    log("debug", "L1 auth forced to use effective address", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: { forceL1Auth: "effective" },
    });
  }

  // For L1 auth, we can try either signer or effective address
  const l1AuthAddress = useEffective
    ? orderIdentity.effectiveAddress
    : signerAddress;

  // Signature type follows the wallet mode
  const signatureTypeForAuth = orderIdentity.signatureTypeForOrders;

  if (!l1AuthIdentityLogged) {
    log("debug", "L1 auth identity resolved", {
      logger: params.logger,
      structuredLogger: params.structuredLogger,
      context: {
        signatureType: signatureTypeForAuth,
        l1AuthAddress,
        signingAddress: signerAddress,
      },
    });
    l1AuthIdentityLogged = true;
  }

  return {
    signatureTypeForAuth,
    l1AuthAddress,
    signingAddress: signerAddress,
  };
}

/**
 * Log comprehensive auth identity summary (ONCE via deduplication)
 */
export function logAuthIdentity(params: {
  orderIdentity: OrderIdentity;
  l1AuthIdentity: L1AuthIdentity;
  signerAddress: string;
  logger?: Logger;
  structuredLogger?: StructuredLogger;
}): void {
  // Use structured logger with deduplication if available
  if (params.structuredLogger) {
    params.structuredLogger.info("Auth identity configuration", {
      category: "IDENTITY",
      signerAddress: params.signerAddress,
      effectiveAddress: params.orderIdentity.effectiveAddress,
      makerAddress: params.orderIdentity.makerAddress,
      funderAddress: params.orderIdentity.funderAddress,
      signatureTypeForOrders: params.orderIdentity.signatureTypeForOrders,
      l1AuthAddress: params.l1AuthIdentity.l1AuthAddress,
      signatureTypeForAuth: params.l1AuthIdentity.signatureTypeForAuth,
    });
  } else if (params.logger) {
    // Legacy logger - log without deduplication
    params.logger.info(
      `[Auth Identity] ` +
        `signerAddress=${params.signerAddress} ` +
        `effectiveAddress=${params.orderIdentity.effectiveAddress} ` +
        `makerAddress=${params.orderIdentity.makerAddress} ` +
        `funderAddress=${params.orderIdentity.funderAddress} ` +
        `sigTypeForOrders=${params.orderIdentity.signatureTypeForOrders} ` +
        `l1AuthAddress=${params.l1AuthIdentity.l1AuthAddress} ` +
        `sigTypeForAuth=${params.l1AuthIdentity.signatureTypeForAuth}`,
    );
  }
}
