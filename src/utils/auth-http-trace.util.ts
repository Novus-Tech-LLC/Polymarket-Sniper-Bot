/**
 * HTTP Request/Response Tracer for Auth Diagnostics
 *
 * Captures exact signing inputs and HTTP wire format for debugging auth failures
 */

import crypto from "node:crypto";
import { generateReqId } from "./structured-logger";
import type { StructuredLogger } from "./structured-logger";

export interface AuthRequestTrace {
  reqId: string;
  timestamp: number;

  // Request details
  method: string;
  url: string;
  signedPath: string; // What we signed
  actualPath: string; // What axios sends
  queryParams: Record<string, unknown>;

  // Headers (redacted)
  headers: Record<string, string>;

  // Signing details
  signatureInput: {
    timestamp: number;
    method: string;
    path: string;
    body?: string;
  };
  hmacSignature: string;

  // Response
  status?: number;
  errorMessage?: string;
}

/**
 * Create a new auth request trace
 */
export function traceAuthRequest(params: {
  method: string;
  url: string;
  endpoint: string;
  params?: Record<string, unknown>;
  signedPath: string;
  headers: Record<string, string>;
  signatureInput: {
    timestamp: number;
    method: string;
    path: string;
    body?: string;
  };
}): AuthRequestTrace {
  const reqId = generateReqId();

  return {
    reqId,
    timestamp: Date.now(),
    method: params.method,
    url: params.url,
    signedPath: params.signedPath,
    actualPath: params.endpoint,
    queryParams: params.params ?? {},
    headers: params.headers,
    signatureInput: params.signatureInput,
    hmacSignature: params.headers.POLY_SIGNATURE ?? "missing",
  };
}

/**
 * Record the response for a traced request
 */
export function recordAuthResponse(
  trace: AuthRequestTrace,
  response: { status: number; error?: string },
): void {
  trace.status = response.status;
  trace.errorMessage = response.error;
}

/**
 * Print auth trace to structured logger
 */
export function printAuthTrace(
  trace: AuthRequestTrace,
  logger: StructuredLogger,
): void {
  const pathMismatch = trace.signedPath !== trace.actualPath;

  logger.debug("HTTP Auth Request Trace", {
    category: "HTTP",
    reqId: trace.reqId,
    method: trace.method,
    url: trace.url,
    signedPath: trace.signedPath,
    actualPath: trace.actualPath,
    pathMismatch,
    queryParamCount: Object.keys(trace.queryParams).length,
    status: trace.status,
    errorMessage: trace.errorMessage,
  });

  // If there's a path mismatch, this is likely the root cause
  if (pathMismatch) {
    logger.warn("⚠️  Path mismatch detected (likely auth failure cause)", {
      category: "HTTP",
      reqId: trace.reqId,
      signedPath: trace.signedPath,
      actualPath: trace.actualPath,
      explanation:
        "Signature was computed for a different path than what was sent to server",
    });
  }

  // Print signing message components
  // Note: The concatenation format (timestamp + method + path + body) matches the
  // Polymarket HMAC signing specification - no delimiters are used by design.
  const message = `${trace.signatureInput.timestamp}${trace.signatureInput.method}${trace.signatureInput.path}${trace.signatureInput.body ?? ""}`;
  const messageHash = crypto
    .createHash("sha256")
    .update(message)
    .digest("hex")
    .slice(0, 16);

  logger.debug("HMAC Signature Input", {
    category: "SIGN",
    reqId: trace.reqId,
    messageLength: message.length,
    messageHash,
    timestamp: trace.signatureInput.timestamp,
    method: trace.signatureInput.method,
    path: trace.signatureInput.path,
    hasBody: !!trace.signatureInput.body,
    bodyLength: trace.signatureInput.body?.length ?? 0,
  });

  // Show truncated signature
  const sigPrefix = trace.hmacSignature.slice(0, 12);
  const sigSuffix = trace.hmacSignature.slice(-8);
  logger.debug("HMAC Signature", {
    category: "SIGN",
    reqId: trace.reqId,
    signature: `${sigPrefix}...${sigSuffix}`,
    signatureLength: trace.hmacSignature.length,
  });
}
