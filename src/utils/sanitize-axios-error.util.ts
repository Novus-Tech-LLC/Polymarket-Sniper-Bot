import axios from "axios";

const SENSITIVE_KEYS = [
  "POLY_API_KEY",
  "POLY_SECRET",
  "POLY_PASSPHRASE",
  "POLY_SIGNATURE",
  "POLYMARKET_API_KEY",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE",
  "CLOB_API_KEY",
  "CLOB_API_SECRET",
  "CLOB_API_PASSPHRASE",
  "X-API-KEY",
  "Authorization",
  "Cookie",
  "private_key",
  "privateKey",
  "secret",
  "passphrase",
];

export function redactSensitiveValues(value: string): string {
  let redacted = value;
  for (const key of SENSITIVE_KEYS) {
    const keyRegex = new RegExp(
      `(${key})\\s*[:=]\\s*(["']?)[^\\s"',;]+\\2`,
      "gi",
    );
    redacted = redacted.replace(keyRegex, "$1=<redacted>");
    const jsonRegex = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, "gi");
    redacted = redacted.replace(jsonRegex, '$1"<redacted>"');
  }
  redacted = redacted.replace(/headers\\s*[:=]\\s*\\{[^}]*\\}/gi, (match) => {
    return match.includes("authHeaderPresence") ? match : "headers=<redacted>";
  });
  redacted = redacted.replace(/"headers"\\s*:\\s*\\{[^}]*\\}/gi, (match) => {
    return match.includes("authHeaderPresence")
      ? match
      : '"headers":"<redacted>"';
  });
  return redacted;
}

/**
 * Compact structured representation of an Axios error
 * Only includes essential debugging info without giant config dumps
 */
export interface CompactAxiosError {
  status?: number;
  statusText?: string;
  method?: string;
  url?: string;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * Check if debug HTTP logging is enabled
 */
function isHttpDebugEnabled(): boolean {
  return (
    process.env.LOG_HTTP_DEBUG === "true" || process.env.LOG_HTTP_DEBUG === "1"
  );
}

/**
 * Extract a compact error summary from an Axios error
 * Avoids leaking sensitive data and giant config objects
 */
export function extractCompactAxiosError(error: unknown): CompactAxiosError {
  if (!axios.isAxiosError(error)) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const compact: CompactAxiosError = {};

  if (error.response?.status) {
    compact.status = error.response.status;
  }
  if (error.response?.statusText) {
    compact.statusText = error.response.statusText;
  }
  if (error.config?.method) {
    compact.method = error.config.method.toUpperCase();
  }
  if (error.config?.url) {
    // Only include path, not full URL with potential query params
    const url = error.config.url;
    const pathOnly = url.split("?")[0];
    compact.url = pathOnly;
  }
  if (error.code) {
    compact.errorCode = error.code;
  }

  // Extract error message from response data if available
  const responseData = error.response?.data;
  if (responseData) {
    if (typeof responseData === "string") {
      compact.errorMessage = redactSensitiveValues(responseData.slice(0, 200));
    } else if (typeof responseData === "object") {
      const data = responseData as { error?: string; message?: string };
      const errorText = data.error ?? data.message;
      if (errorText) {
        compact.errorMessage = redactSensitiveValues(
          String(errorText).slice(0, 200),
        );
      }
    }
  }

  // Fallback to error message
  if (!compact.errorMessage && error.message) {
    compact.errorMessage = redactSensitiveValues(error.message.slice(0, 200));
  }

  return compact;
}

/**
 * Format a compact error for logging
 */
export function formatCompactError(compact: CompactAxiosError): string {
  const parts: string[] = [];

  if (compact.status) {
    parts.push(`status=${compact.status}`);
  }
  if (compact.statusText) {
    parts.push(`statusText="${compact.statusText}"`);
  }
  if (compact.method) {
    parts.push(`method=${compact.method}`);
  }
  if (compact.url) {
    parts.push(`url=${compact.url}`);
  }
  if (compact.errorCode) {
    parts.push(`code=${compact.errorCode}`);
  }
  if (compact.errorMessage) {
    parts.push(`error="${compact.errorMessage}"`);
  }

  return parts.join(" ");
}

export function sanitizeAxiosError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    // Use compact format by default
    const compact = extractCompactAxiosError(error);
    const message = formatCompactError(compact);
    return new Error(message);
  }

  if (error instanceof Error) {
    return new Error(redactSensitiveValues(error.message));
  }

  return new Error(redactSensitiveValues(String(error)));
}

export function sanitizeErrorMessage(error: unknown): string {
  return sanitizeAxiosError(error).message;
}

/**
 * Get verbose error details (only when LOG_HTTP_DEBUG=true)
 * Returns undefined if debug mode is disabled
 */
export function getVerboseErrorDetails(error: unknown): string | undefined {
  if (!isHttpDebugEnabled()) {
    return undefined;
  }

  if (!axios.isAxiosError(error)) {
    return undefined;
  }

  // In debug mode, provide more details but still redact sensitive values
  const details: Record<string, unknown> = {};

  if (error.config) {
    details.config = {
      method: error.config.method,
      url: error.config.url,
      baseURL: error.config.baseURL,
      params: error.config.params,
      // Redact headers
      headers: "<redacted - set LOG_HTTP_DEBUG=true to see>",
    };
  }

  if (error.response) {
    details.response = {
      status: error.response.status,
      statusText: error.response.statusText,
      data: redactSensitiveValues(
        typeof error.response.data === "string"
          ? error.response.data
          : JSON.stringify(error.response.data ?? {}),
      ),
    };
  }

  return JSON.stringify(details, null, 2);
}
