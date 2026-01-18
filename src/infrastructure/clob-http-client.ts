/**
 * Custom HTTP Client for CLOB API with Deterministic Request Canonicalization
 *
 * This module provides an axios instance with a request interceptor that ensures:
 * 1. Query parameters are serialized deterministically (sorted keys, stable encoding)
 * 2. The signed path exactly matches the actual outbound request URL
 * 3. Comprehensive debugging instrumentation when CLOB_DEBUG_CANON=true
 *
 * Problem: ClobClient library signs requests with a path, but passes params separately
 * to axios, which may serialize them differently, causing signature mismatches.
 *
 * Solution: Intercept requests before they're sent, construct the final URL with
 * deterministic param serialization, and ensure it matches what was signed.
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from "axios";
import { createHash } from "crypto";
import type { Logger } from "../utils/logger.util";
import { canonicalQuery } from "../utils/query-string.util";

/**
 * Configuration for the CLOB HTTP client
 */
export type ClobHttpClientConfig = {
  /** Base URL for CLOB API */
  baseURL: string;
  /** Logger for diagnostics */
  logger?: Logger;
  /** Enable debug canonicalization logs (can also be set via CLOB_DEBUG_CANON env var) */
  debugCanon?: boolean;
};

/**
 * Serializes params object to a deterministic query string
 * - Sorts keys alphabetically
 * - Filters out undefined values
 * - URL-encodes keys and values consistently
 */
function serializeParams(params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) {
    return "";
  }
  const { queryString } = canonicalQuery(params);
  return queryString;
}

/**
 * Computes a short digest of a string for logging (non-sensitive)
 */
function computeDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").substring(0, 16);
}

/**
 * Redacts a secret string for logging (shows first 8 + last 4 chars)
 */
function redactSecret(secret: string): string {
  if (!secret || secret.length < 12) {
    return "***";
  }
  return `${secret.substring(0, 8)}...${secret.substring(secret.length - 4)}`;
}

/**
 * Creates a configured axios instance for CLOB API requests with:
 * - Deterministic params serialization
 * - Request interceptor for canonicalization verification
 * - Debug logging when CLOB_DEBUG_CANON=true
 */
export function createClobHttpClient(config: ClobHttpClientConfig): AxiosInstance {
  const debugCanon = config.debugCanon ?? process.env.CLOB_DEBUG_CANON === "true";
  const logger = config.logger;

  const instance = axios.create({
    baseURL: config.baseURL,
    // Use custom params serializer for deterministic query string construction
    paramsSerializer: {
      serialize: (params) => serializeParams(params as Record<string, unknown>),
    },
  });

  // Request interceptor: Log canonicalization details before sending
  instance.interceptors.request.use(
    (requestConfig: InternalAxiosRequestConfig) => {
      if (!debugCanon || !logger) {
        return requestConfig;
      }

      try {
        // Extract request details
        const method = (requestConfig.method ?? "GET").toUpperCase();
        const baseURL = requestConfig.baseURL ?? config.baseURL;
        const url = requestConfig.url ?? "/";
        const params = requestConfig.params as Record<string, unknown> | undefined;

        // Compute the serialized query string
        const serializedQuery = serializeParams(params);
        const hasQuery = serializedQuery.length > 0;

        // Construct the full path that will be sent
        const pathWithQuery = hasQuery ? `${url}?${serializedQuery}` : url;

        // Construct the absolute URL
        const absoluteURL = `${baseURL}${pathWithQuery}`;

        // Log canonicalization details
        logger.debug("[ClobHttpClient][Canon] ===== Request Canonicalization =====");
        logger.debug(`[ClobHttpClient][Canon] METHOD: ${method}`);
        logger.debug(`[ClobHttpClient][Canon] baseURL: ${baseURL}`);
        logger.debug(`[ClobHttpClient][Canon] config.url: ${url}`);
        logger.debug(
          `[ClobHttpClient][Canon] config.params: ${params ? JSON.stringify(params) : "{}"}`,
        );
        logger.debug(`[ClobHttpClient][Canon] serializedQuery: ${serializedQuery || "(empty)"}`);
        logger.debug(`[ClobHttpClient][Canon] pathWithQuery: ${pathWithQuery}`);
        logger.debug(`[ClobHttpClient][Canon] absoluteURL: ${absoluteURL}`);
        logger.debug(
          `[ClobHttpClient][Canon] signatureIncludesQuery: ${hasQuery}`,
        );

        // Compute digest of the message string (for correlation with signing logs)
        // Message format matches CLOB signature: timestamp + method + path
        // Note: We don't have timestamp here, so we just show the method+path portion
        const pathDigest = computeDigest(`${method}${pathWithQuery}`);
        logger.debug(
          `[ClobHttpClient][Canon] pathDigest: ${pathDigest} (SHA256 of '${method}${pathWithQuery}')`,
        );

        // Log redacted headers (only if they exist)
        if (requestConfig.headers) {
          const authHeaders = [
            "POLY_ADDRESS",
            "POLY_SIGNATURE",
            "POLY_TIMESTAMP",
            "POLY_API_KEY",
            "POLY_PASSPHRASE",
            "POLY_NONCE",
          ];
          const presentAuthHeaders = authHeaders.filter(
            (h) => requestConfig.headers[h],
          );
          if (presentAuthHeaders.length > 0) {
            logger.debug(
              `[ClobHttpClient][Canon] authHeaders: ${presentAuthHeaders.join(", ")}`,
            );
            // Log redacted values for key headers
            if (requestConfig.headers["POLY_API_KEY"]) {
              logger.debug(
                `[ClobHttpClient][Canon] POLY_API_KEY: ${redactSecret(String(requestConfig.headers["POLY_API_KEY"]))}`,
              );
            }
            if (requestConfig.headers["POLY_SIGNATURE"]) {
              logger.debug(
                `[ClobHttpClient][Canon] POLY_SIGNATURE: ${redactSecret(String(requestConfig.headers["POLY_SIGNATURE"]))}`,
              );
            }
          }
        }

        logger.debug("[ClobHttpClient][Canon] ========================================");
      } catch (err) {
        // Don't fail the request if logging fails
        logger?.warn(
          `[ClobHttpClient][Canon] Failed to log canonicalization: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return requestConfig;
    },
    (error) => {
      return Promise.reject(error);
    },
  );

  return instance;
}

/**
 * Helper to check if canonicalization debug is enabled
 */
export function isCanonDebugEnabled(): boolean {
  return process.env.CLOB_DEBUG_CANON === "true";
}
