/**
 * HMAC Diagnostic Interceptor
 *
 * Instruments HTTP requests to trace HMAC signature inputs vs actual requests.
 * This is the highest-leverage diagnostic for 401 auth failures when credentials are valid.
 */

import type {
  AxiosInstance,
  InternalAxiosRequestConfig,
  AxiosResponse,
  AxiosError,
} from "axios";
import * as crypto from "node:crypto";

type HmacSigningInputs = {
  timestamp: string;
  method: string;
  requestPath: string;
  body?: string;
  secret: string; // Will be hashed for logging
};

type HmacDiagnosticResult = {
  signedPath: string; // What we signed
  actualPath: string; // What axios sent
  pathMatch: boolean;
  signedMethod: string;
  actualMethod: string;
  methodMatch: boolean;
  bodyHash: string | null;
  secretHash: string; // SHA256 hash of secret for correlation
  timestamp: string;
  signature: string; // First 8 chars
};

const ENABLE_HMAC_DIAGNOSTICS = process.env.ENABLE_HMAC_DIAGNOSTICS === "true";
const hmacSigningCache = new Map<string, HmacSigningInputs>();

/**
 * Hash a value for safe logging (no secrets exposed)
 */
function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Normalize a URL path for comparison
 */
function normalizePath(path: string): string {
  // Remove host if present
  const urlObj = path.startsWith("http") ? new URL(path) : null;
  if (urlObj) {
    return urlObj.pathname + urlObj.search;
  }
  return path;
}

/**
 * Build canonical query string from params object
 */
function buildCanonicalQueryString(params: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) {
    return "";
  }

  const filtered = Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );

  const keys = Object.keys(filtered).sort();
  if (keys.length === 0) {
    return "";
  }

  return keys
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(filtered[key]))}`,
    )
    .join("&");
}

/**
 * Hook for tracking HMAC signing inputs (called from clob-client patch)
 */
export function trackHmacSigningInputs(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): void {
  if (!ENABLE_HMAC_DIAGNOSTICS) return;

  const key = `${timestamp}_${method}_${requestPath}`;
  hmacSigningCache.set(key, {
    timestamp: String(timestamp),
    method: method.toUpperCase(),
    requestPath,
    body,
    secret,
  });

  // Cleanup old entries (keep last 100)
  if (hmacSigningCache.size > 100) {
    const firstKey = hmacSigningCache.keys().next().value;
    if (firstKey) hmacSigningCache.delete(firstKey);
  }
}

/**
 * Install axios interceptors for HMAC diagnostics
 */
export function installHmacDiagnosticInterceptor(
  axiosInstance: AxiosInstance,
  logger?: { debug: (msg: string) => void; warn: (msg: string) => void },
): void {
  if (!ENABLE_HMAC_DIAGNOSTICS) {
    if (logger) {
      logger.debug(
        "[HmacDiag] Skipping interceptor install (ENABLE_HMAC_DIAGNOSTICS=false)",
      );
    }
    return;
  }

  // Request interceptor: capture what's being sent
  axiosInstance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      const timestamp = config.headers?.["POLY_TIMESTAMP"] as
        | string
        | undefined;
      const signature = config.headers?.["POLY_SIGNATURE"] as
        | string
        | undefined;

      if (!timestamp || !signature) {
        return config; // Not a signed request
      }

      const method = (config.method || "GET").toUpperCase();
      const actualPath = normalizePath(config.url || "");

      // Try to find matching signing inputs
      for (const [, signingInputs] of hmacSigningCache.entries()) {
        if (signingInputs.timestamp === timestamp) {
          const signedPath = signingInputs.requestPath;
          const pathMatch = signedPath === actualPath;
          const methodMatch = signingInputs.method === method;

          const diagnostic: HmacDiagnosticResult = {
            signedPath,
            actualPath,
            pathMatch,
            signedMethod: signingInputs.method,
            actualMethod: method,
            methodMatch,
            bodyHash: config.data
              ? hashValue(JSON.stringify(config.data))
              : null,
            secretHash: hashValue(signingInputs.secret),
            timestamp,
            signature: signature.slice(0, 8) + "...",
          };

          // Attach to config for response interceptor
          (config as unknown as Record<string, unknown>).hmacDiagnostic =
            diagnostic;

          if (!pathMatch || !methodMatch) {
            if (logger) {
              logger.warn("[HmacDiag] MISMATCH DETECTED:");
              logger.warn(`  Signed path:  ${signedPath}`);
              logger.warn(`  Actual path:  ${actualPath}`);
              logger.warn(`  Signed method: ${signingInputs.method}`);
              logger.warn(`  Actual method: ${method}`);
            }
          }

          break;
        }
      }

      return config;
    },
    (error) => Promise.reject(error),
  );

  // Response interceptor: log on 401
  axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => response,
    (error: AxiosError) => {
      const config = error.config as InternalAxiosRequestConfig & {
        hmacDiagnostic?: HmacDiagnosticResult;
      };
      const diagnostic = config?.hmacDiagnostic;

      if (error.response?.status === 401 && diagnostic) {
        if (logger) {
          logger.warn("[HmacDiag] 401 Unauthorized with diagnostic data:");
          logger.warn(JSON.stringify(diagnostic, null, 2));
        } else {
          console.warn(
            "[HmacDiag] 401 Unauthorized:",
            JSON.stringify(diagnostic, null, 2),
          );
        }
      }

      return Promise.reject(error);
    },
  );

  if (logger) {
    logger.debug("[HmacDiag] Interceptor installed successfully");
  }
}

/**
 * Generate Auth Story diagnostic summary
 */
export function generateAuthStoryDiagnostic(
  timestamp: string,
  method: string,
  requestPath: string,
  statusCode: number,
  secretHash: string,
): string {
  return JSON.stringify({
    run_id: process.env.RUN_ID || "unknown",
    attempt: {
      timestamp,
      method,
      requestPath,
      statusCode,
      secretHash,
    },
  });
}
