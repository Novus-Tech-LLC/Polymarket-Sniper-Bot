/**
 * HMAC Signature Override for Diagnostics
 *
 * Wraps the official @polymarket/clob-client HMAC signing to:
 * 1. Log exact signing inputs
 * 2. Test alternative encodings
 * 3. Trace mismatches between signed path and HTTP request path
 */

import * as clobSigning from "@polymarket/clob-client/dist/signing";
import { trackHmacSigningInputs } from "./hmac-diagnostic-interceptor";

type BuildPolyHmacSignatureFn = (
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
) => string | Promise<string>;

let originalBuildPolyHmacSignature: BuildPolyHmacSignatureFn | null = null;
let overrideInstalled = false;

/**
 * Install diagnostic wrapper around buildPolyHmacSignature
 */
export function installHmacSignatureOverride(logger?: {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  if (overrideInstalled) {
    if (logger) {
      logger.debug("[HmacOverride] Already installed, skipping");
    }
    return;
  }

  if (typeof clobSigning.buildPolyHmacSignature !== "function") {
    if (logger) {
      logger.warn(
        "[HmacOverride] buildPolyHmacSignature not found in clob-client",
      );
    }
    return;
  }

  originalBuildPolyHmacSignature = clobSigning.buildPolyHmacSignature;

  // Monkey-patch the function
  (
    clobSigning as { buildPolyHmacSignature: BuildPolyHmacSignatureFn }
  ).buildPolyHmacSignature = async function wrappedBuildPolyHmacSignature(
    secret: string,
    timestamp: number,
    method: string,
    requestPath: string,
    body?: string,
  ): Promise<string> {
    // Track inputs for diagnostic correlation
    trackHmacSigningInputs(secret, timestamp, method, requestPath, body);

    // Log if enabled (secret is hashed for security)
    if (process.env.DEBUG_HMAC_SIGNING === "true" && logger) {
      const crypto = await import("crypto");
      const secretHash = crypto
        .createHash("sha256")
        .update(secret)
        .digest("hex")
        .slice(0, 16);
      logger.debug("[HmacOverride] Signing inputs:");
      logger.debug(`  timestamp: ${timestamp}`);
      logger.debug(`  method: ${method}`);
      logger.debug(`  requestPath: ${requestPath}`);
      logger.debug(`  body: ${body ? `<${body.length} bytes>` : "undefined"}`);
      logger.debug(`  secret: [HASH:${secretHash}] (len=${secret.length})`);
    }

    // Call original (handle both sync and async versions)
    if (!originalBuildPolyHmacSignature) {
      throw new Error("Original buildPolyHmacSignature not found");
    }

    const result = originalBuildPolyHmacSignature(
      secret,
      timestamp,
      method,
      requestPath,
      body,
    );
    
    // Handle both Promise and direct return
    const signature = await Promise.resolve(result);

    if (process.env.DEBUG_HMAC_SIGNING === "true" && logger) {
      logger.debug(
        `  signature: ${signature.slice(0, 12)}...${signature.slice(-8)}`,
      );
    }

    return signature;
  };

  overrideInstalled = true;

  if (logger) {
    logger.debug("[HmacOverride] Installed successfully");
  }
}

/**
 * Restore original buildPolyHmacSignature
 */
export function restoreHmacSignatureOriginal(): void {
  if (!overrideInstalled || !originalBuildPolyHmacSignature) {
    return;
  }

  (
    clobSigning as { buildPolyHmacSignature: BuildPolyHmacSignatureFn }
  ).buildPolyHmacSignature = originalBuildPolyHmacSignature;

  overrideInstalled = false;
  originalBuildPolyHmacSignature = null;
}
