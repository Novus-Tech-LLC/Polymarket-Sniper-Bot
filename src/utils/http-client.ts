/**
 * HTTP Client Wrapper with Request Tracing
 *
 * Wraps axios to provide:
 * - Per-request correlation IDs (REQ_ID)
 * - Detailed logging of signed requests
 * - Response latency tracking
 * - Warning on axios params usage for signed requests
 */

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import crypto from "node:crypto";
import { getLogger, generateReqId, type LogContext } from "./structured-logger";

/**
 * Calculate SHA256 hash of a string or buffer
 */
export function hashSha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Extract query string from URL
 */
function extractQueryString(url: string): string | null {
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(qIndex + 1) : null;
}

/**
 * Check if this is a signed CLOB request
 */
function isSignedClobRequest(config: AxiosRequestConfig): boolean {
  const headers = config.headers as Record<string, unknown> | undefined;
  if (!headers) return false;

  // Check for POLY_SIGNATURE header (case-insensitive)
  const headerKeys = Object.keys(headers).map((k) => k.toUpperCase());
  return headerKeys.includes("POLY_SIGNATURE");
}

/**
 * Extract headers presence (boolean only)
 */
function getHeadersPresence(
  headers?: Record<string, unknown>,
): Record<string, boolean> {
  if (!headers) return {};

  const presence: Record<string, boolean> = {};
  const standardHeaders = [
    "POLY_SIGNATURE",
    "POLY_TIMESTAMP",
    "POLY_API_KEY",
    "POLY_PASSPHRASE",
    "POLY_ADDRESS",
    "POLY_NONCE",
  ];

  for (const key of standardHeaders) {
    const headerKey = Object.keys(headers).find((k) => k.toUpperCase() === key);
    presence[key] = !!headerKey;
  }

  return presence;
}

/**
 * Create traced axios instance
 */
export function createTracedAxiosClient(baseURL?: string): AxiosInstance {
  const client = axios.create({ baseURL });
  const logger = getLogger();

  // Request interceptor - log outgoing requests
  client.interceptors.request.use(
    (config) => {
      const reqId = generateReqId();
      const startTime = Date.now();

      // Attach metadata to config for response interceptor
      (
        config as AxiosRequestConfig & {
          metadata?: { reqId: string; startTime: number };
        }
      ).metadata = {
        reqId,
        startTime,
      };

      const isSigned = isSignedClobRequest(config);
      const method = (config.method ?? "GET").toUpperCase();
      const url = config.url ?? "";
      const fullUrl = config.baseURL ? `${config.baseURL}${url}` : url;

      // Extract signed path (without query params if they're in params object)
      let signedPath = url;
      if (config.params && Object.keys(config.params).length > 0) {
        // Remove query string from URL since params will be appended by axios
        const qIndex = url.indexOf("?");
        if (qIndex >= 0) {
          signedPath = url.slice(0, qIndex);
        }
      }

      // Check for query params in URL
      const queryString = extractQueryString(url);

      const context: LogContext = {
        category: "HTTP",
        reqId,
        method,
        fullUrl,
        signedPath,
        isSigned,
      };

      if (isSigned) {
        const headers = config.headers as Record<string, unknown> | undefined;
        const headersPresence = getHeadersPresence(headers);

        // Calculate body hash if present
        let bodyHash: string | null = null;
        if (config.data) {
          const bodyStr =
            typeof config.data === "string"
              ? config.data
              : JSON.stringify(config.data);
          bodyHash = hashSha256(bodyStr).slice(0, 12);
        }

        // Get timestamp from headers
        const timestamp =
          headers?.POLY_TIMESTAMP ?? headers?.["poly-timestamp"] ?? "unknown";

        // Get signature hash (don't log full signature!)
        const signature =
          headers?.POLY_SIGNATURE ?? headers?.["poly-signature"];
        const signatureHash = signature
          ? hashSha256(String(signature)).slice(0, 8)
          : "missing";

        // Check if axios params are used (this is wrong for signed requests!)
        const usedAxiosParams =
          config.params && Object.keys(config.params).length > 0;

        context.timestamp = timestamp;
        context.signatureHash = signatureHash;
        context.headersPresent = headersPresence;
        context.bodyHash = bodyHash;
        context.canonicalQueryString = queryString;
        context.usedAxiosParams = usedAxiosParams;

        if (usedAxiosParams) {
          logger.warn(
            "Signed request using axios params! This will cause signature mismatch. " +
              "Query params must be in the URL path for signature calculation.",
            {
              ...context,
              category: "HTTP",
              guidance:
                "Move params from config.params to the URL path before signing",
            },
          );
        }

        logger.debug("Outgoing signed request", context);
      } else {
        logger.debug("Outgoing request", context);
      }

      return config;
    },
    (error) => {
      const logger = getLogger();
      logger.error("Request interceptor error", {
        category: "HTTP",
        error: String(error),
      });
      return Promise.reject(error);
    },
  );

  // Response interceptor - log responses
  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const config = response.config as AxiosRequestConfig & {
        metadata?: { reqId: string; startTime: number };
      };
      const metadata = config.metadata;

      if (metadata) {
        const latencyMs = Date.now() - metadata.startTime;
        const status = response.status;
        const statusText = response.statusText;

        // Check for error in response body
        const responseError =
          typeof response.data === "object" && response.data
            ? (response.data as { error?: string }).error
            : undefined;

        const context: LogContext = {
          category: "HTTP",
          reqId: metadata.reqId,
          status,
          statusText,
          latencyMs,
        };

        if (responseError) {
          context.errorText = responseError;
        }

        if (status >= 400) {
          logger.warn("Response received (error)", context);
        } else {
          logger.debug("Response received (success)", context);
        }
      }

      return response;
    },
    (error) => {
      const config = error.config as
        | (AxiosRequestConfig & {
            metadata?: { reqId: string; startTime: number };
          })
        | undefined;
      const metadata = config?.metadata;

      if (metadata) {
        const latencyMs = Date.now() - metadata.startTime;
        const status = error.response?.status;
        const statusText = error.response?.statusText;

        // Extract error text
        let errorText = error.message;
        if (error.response?.data) {
          if (typeof error.response.data === "string") {
            errorText = error.response.data;
          } else if (typeof error.response.data === "object") {
            const errorObj = error.response.data as {
              error?: string;
              message?: string;
            };
            errorText =
              errorObj.error ??
              errorObj.message ??
              JSON.stringify(error.response.data);
          }
        }

        const context: LogContext = {
          category: "HTTP",
          reqId: metadata.reqId,
          status,
          statusText,
          errorText,
          latencyMs,
          errorCode: error.code,
        };

        logger.error("Response error", context);
      } else {
        // No metadata, log generic error
        logger.error("HTTP error", {
          category: "HTTP",
          error: error.message,
          errorCode: error.code,
        });
      }

      return Promise.reject(error);
    },
  );

  return client;
}

/**
 * Log HTTP request details manually (for non-axios requests)
 */
export function logHttpRequest(params: {
  reqId: string;
  method: string;
  url: string;
  signedPath?: string;
  isSigned?: boolean;
  timestamp?: number;
  headersPresent?: Record<string, boolean>;
  bodyHash?: string;
  signatureHash?: string;
}): void {
  const logger = getLogger();
  const context: LogContext = {
    category: "HTTP",
    reqId: params.reqId,
    method: params.method.toUpperCase(),
    url: params.url,
    isSigned: params.isSigned ?? false,
  };

  if (params.signedPath) {
    context.signedPath = params.signedPath;
  }
  if (params.timestamp) {
    context.timestamp = params.timestamp;
  }
  if (params.headersPresent) {
    context.headersPresent = params.headersPresent;
  }
  if (params.bodyHash) {
    context.bodyHash = params.bodyHash;
  }
  if (params.signatureHash) {
    context.signatureHash = params.signatureHash;
  }

  logger.debug("HTTP request", context);
}

/**
 * Log HTTP response details manually
 */
export function logHttpResponse(params: {
  reqId: string;
  status: number;
  statusText?: string;
  errorText?: string;
  latencyMs: number;
}): void {
  const logger = getLogger();
  const context: LogContext = {
    category: "HTTP",
    reqId: params.reqId,
    status: params.status,
    statusText: params.statusText,
    latencyMs: params.latencyMs,
  };

  if (params.errorText) {
    context.errorText = params.errorText;
  }

  if (params.status >= 400) {
    logger.warn("HTTP response (error)", context);
  } else {
    logger.debug("HTTP response (success)", context);
  }
}
