import type { JsonRpcSigner, Wallet } from "ethers";
import type { Logger } from "./logger.util";

/**
 * Configuration for L1 authentication
 */
export type L1AuthConfig = {
  /** Force a specific signature type (overrides auto-detection) */
  forceSignatureType?: 0 | 1 | 2;
  /** Enable debug logging of HTTP headers (redacted) */
  debugHttpHeaders?: boolean;
};

/**
 * L1 authentication headers returned by buildL1Headers
 */
export type L1AuthHeaders = {
  POLY_ADDRESS: string;
  POLY_SIGNATURE: string;
  POLY_TIMESTAMP: string;
  POLY_NONCE: string;
};

/**
 * Request details for L1 authentication
 */
export type L1RequestDetails = {
  method: "GET" | "POST" | "DELETE";
  pathWithQuery: string;
  body?: string;
};

/**
 * Redact a header value, showing only first/last 4 characters
 */
const redactHeaderValue = (value: string): string => {
  if (!value || value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

/**
 * Build L1 authentication headers for CLOB API requests
 *
 * This function creates the headers required for L1 (signer-based) authentication
 * when calling endpoints like /auth/derive-api-key and /auth/api-key.
 *
 * @param signer - Ethers wallet/signer to use for signing
 * @param chainId - Chain ID (137 for Polygon mainnet)
 * @param request - Request details (method, path, optional body)
 * @param config - Optional configuration for L1 auth
 * @param logger - Optional logger for debug output
 * @returns L1 authentication headers
 */
export async function buildL1Headers(
  signer: Wallet | JsonRpcSigner,
  chainId: number,
  request: L1RequestDetails,
  config?: L1AuthConfig,
  logger?: Logger,
): Promise<L1AuthHeaders> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 0; // Default nonce is 0 for L1 auth

  // Get the address to use for authentication
  const signerAddress = await signer.getAddress();
  const effectiveAddress = signerAddress; // Always use signer for L1 auth

  // Build EIP-712 signature for L1 auth
  // The signature is over: address, timestamp, nonce, and a fixed message
  const domain = {
    name: "ClobAuthDomain",
    version: "1",
    chainId,
  };

  const types = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  };

  const value = {
    address: effectiveAddress,
    timestamp: `${timestamp}`,
    nonce,
    message: "This message attests that I control the given wallet",
  };

  // Sign the typed data - use proper type checking
  let signature: string;
  if ("signTypedData" in signer && typeof signer.signTypedData === "function") {
    signature = await signer.signTypedData(domain, types, value);
  } else if (
    "_signTypedData" in signer &&
    typeof signer._signTypedData === "function"
  ) {
    signature = await signer._signTypedData(domain, types, value);
  } else {
    // Fall back to public method if available (JsonRpcSigner)
    throw new Error(
      "L1 auth requires a Wallet instance with _signTypedData support",
    );
  }

  const headers: L1AuthHeaders = {
    POLY_ADDRESS: effectiveAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: `${timestamp}`,
    POLY_NONCE: `${nonce}`,
  };

  // Debug logging if enabled
  if (config?.debugHttpHeaders && logger) {
    logger.debug("[L1Auth] HTTP Request Debug:");
    logger.debug(`  Method: ${request.method}`);
    logger.debug(`  Path: ${request.pathWithQuery}`);
    if (request.body) {
      // Hash the body instead of logging raw content
      const bodyHash = `<${request.body.length} bytes>`;
      logger.debug(`  Body: ${bodyHash}`);
    }
    logger.debug("[L1Auth] HTTP Headers (redacted):");
    logger.debug(`  POLY_ADDRESS: ${headers.POLY_ADDRESS}`);
    logger.debug(
      `  POLY_SIGNATURE: ${redactHeaderValue(headers.POLY_SIGNATURE)}`,
    );
    logger.debug(`  POLY_TIMESTAMP: ${headers.POLY_TIMESTAMP}`);
    logger.debug(`  POLY_NONCE: ${headers.POLY_NONCE}`);
  }

  return headers;
}

/**
 * Load L1 auth configuration from environment variables
 */
export function loadL1AuthConfig(): L1AuthConfig {
  const config: L1AuthConfig = {};

  const forceSignatureType = process.env.CLOB_FORCE_SIGNATURE_TYPE;
  if (forceSignatureType !== undefined) {
    const parsed = parseInt(forceSignatureType, 10);
    if ([0, 1, 2].includes(parsed)) {
      config.forceSignatureType = parsed as 0 | 1 | 2;
    }
  }

  const debugHttpHeaders = process.env.DEBUG_HTTP_HEADERS?.toLowerCase();
  if (debugHttpHeaders === "true" || debugHttpHeaders === "1") {
    config.debugHttpHeaders = true;
  }

  return config;
}

/**
 * Log L1 authentication diagnostics
 */
export function logL1AuthDiagnostics(
  config: L1AuthConfig,
  signerAddress: string,
  effectiveAddress: string,
  logger?: Logger,
): void {
  if (!logger) return;

  logger.info("[L1Auth] Configuration:");
  logger.info(
    `  forceSignatureType: ${config.forceSignatureType ?? "auto-detect"}`,
  );
  logger.info(`  debugHttpHeaders: ${config.debugHttpHeaders ?? false}`);
  logger.info(`  signerAddress: ${signerAddress}`);
  logger.info(`  effectiveAddress: ${effectiveAddress}`);

  if (signerAddress !== effectiveAddress) {
    logger.warn(
      `[L1Auth] WARNING: signerAddress (${signerAddress}) differs from effectiveAddress (${effectiveAddress})`,
    );
  }
}
