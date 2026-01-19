/**
 * Auth Logger - Centralized authentication logging with deduplication
 *
 * Provides:
 * - Correlation IDs (runId, reqId, attemptId)
 * - Deduplication (60s window)
 * - Secret redaction
 * - Single Auth Story JSON output per run
 * - Minimal noise
 */

import crypto from "node:crypto";
import {
  getLogger,
  type StructuredLogger,
  type LogCategory,
} from "./structured-logger";

/**
 * Auth log context with correlation IDs
 */
export interface AuthLogContext {
  runId: string;
  reqId?: string;
  attemptId?: string;
  category?: LogCategory;
  [key: string]: unknown;
}

/**
 * Deduplication entry for auth logs
 */
interface AuthDeduplicationEntry {
  message: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

/**
 * Auth logger with deduplication and correlation tracking
 */
export class AuthLogger {
  private logger: StructuredLogger;
  private runId: string;
  private deduplicationMap: Map<string, AuthDeduplicationEntry>;
  private readonly deduplicationWindowMs = 60000; // 60 seconds

  constructor(runId?: string) {
    this.runId = runId ?? this.generateRunId();
    this.logger = getLogger().child({ runId: this.runId });
    this.deduplicationMap = new Map();
  }

  /**
   * Generate a unique run ID
   */
  private generateRunId(): string {
    return `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * Get deduplication key for a message
   */
  private getDedupKey(message: string, category?: string): string {
    return category ? `${category}:${message}` : message;
  }

  /**
   * Check if message should be deduplicated
   */
  private shouldDeduplicate(message: string, category?: string): boolean {
    const key = this.getDedupKey(message, category);
    const now = Date.now();
    const existing = this.deduplicationMap.get(key);

    if (existing) {
      // Within dedup window?
      if (now - existing.firstSeen < this.deduplicationWindowMs) {
        existing.lastSeen = now;
        existing.count++;
        return true; // Suppress
      } else {
        // Outside window - emit suppression count and reset
        if (existing.count > 1) {
          this.logger.info(`(suppressed ${existing.count - 1} repeats)`, {
            category: category ?? "AUTH",
            suppressedMessage: message,
          });
        }
        this.deduplicationMap.set(key, {
          message,
          firstSeen: now,
          lastSeen: now,
          count: 1,
        });
        return false; // Don't suppress
      }
    } else {
      // First time seeing this message
      this.deduplicationMap.set(key, {
        message,
        firstSeen: now,
        lastSeen: now,
        count: 1,
      });
      return false; // Don't suppress
    }
  }

  /**
   * Flush deduplication (called at end of run)
   */
  flushDeduplication(): void {
    for (const [_key, entry] of this.deduplicationMap.entries()) {
      if (entry.count > 1) {
        this.logger.info(`(suppressed ${entry.count - 1} repeats)`, {
          category: "IDENTITY" as LogCategory,
          suppressedMessage: entry.message,
        });
      }
    }
    this.deduplicationMap.clear();
  }

  /**
   * Log info message
   */
  info(message: string, context?: Partial<AuthLogContext>): void {
    if (this.shouldDeduplicate(message, context?.category)) {
      return; // Suppressed
    }

    this.logger.info(message, {
      ...context,
      category: (context?.category ?? "IDENTITY") as LogCategory,
    });
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: Partial<AuthLogContext>): void {
    if (this.shouldDeduplicate(message, context?.category)) {
      return; // Suppressed
    }

    this.logger.debug(message, {
      ...context,
      category: (context?.category ?? "IDENTITY") as LogCategory,
    });
  }

  /**
   * Log warn message
   */
  warn(message: string, context?: Partial<AuthLogContext>): void {
    // Don't deduplicate warnings - they're important
    this.logger.warn(message, {
      ...context,
      category: (context?.category ?? "IDENTITY") as LogCategory,
    });
  }

  /**
   * Log error message
   */
  error(message: string, context?: Partial<AuthLogContext>): void {
    // Don't deduplicate errors - they're critical
    this.logger.error(message, {
      ...context,
      category: (context?.category ?? "IDENTITY") as LogCategory,
    });
  }

  /**
   * Get run ID
   */
  getRunId(): string {
    return this.runId;
  }

  /**
   * Create child logger with additional context
   */
  child(context: Partial<AuthLogContext>): AuthLogger {
    const child = new AuthLogger(this.runId);
    child.logger = this.logger.child(context);
    return child;
  }
}

/**
 * Redact API key (show only suffix)
 */
export function redactApiKey(apiKey: string): string {
  if (!apiKey) return "***";
  if (apiKey.length <= 8) return "***";
  return `***${apiKey.slice(-6)}`;
}

/**
 * Redact secret (show length only)
 */
export function redactSecret(secret: string): string {
  if (!secret) return "***";
  return `[REDACTED len=${secret.length}]`;
}

/**
 * Redact passphrase (show length only)
 */
export function redactPassphrase(passphrase: string): string {
  if (!passphrase) return "***";
  return `[REDACTED len=${passphrase.length}]`;
}

/**
 * Create credential fingerprint (safe to log)
 */
export function createCredentialFingerprint(creds: {
  key?: string;
  secret?: string;
  passphrase?: string;
}): {
  apiKeySuffix: string;
  secretLen: number;
  passphraseLen: number;
  secretEncodingGuess: "base64" | "base64url" | "raw" | "unknown";
} {
  const apiKeySuffix = creds.key
    ? creds.key.length >= 6
      ? creds.key.slice(-6)
      : crypto.createHash("sha256").update(creds.key).digest("hex").slice(0, 8)
    : "n/a";

  const secretLen = creds.secret?.length ?? 0;
  const passphraseLen = creds.passphrase?.length ?? 0;

  // Guess secret encoding
  let secretEncodingGuess: "base64" | "base64url" | "raw" | "unknown" =
    "unknown";
  if (creds.secret) {
    const secret = creds.secret;
    const hasBase64Chars = secret.includes("+") || secret.includes("/");
    const hasBase64UrlChars = secret.includes("-") || secret.includes("_");
    const hasPadding = secret.endsWith("=");

    if (hasBase64UrlChars) {
      secretEncodingGuess = "base64url";
    } else if (hasBase64Chars || hasPadding) {
      secretEncodingGuess = "base64";
    } else if (/^[A-Za-z0-9]+$/.test(secret)) {
      secretEncodingGuess = "base64"; // Probably base64 without special chars
    } else {
      secretEncodingGuess = "raw";
    }
  }

  return {
    apiKeySuffix,
    secretLen,
    passphraseLen,
    secretEncodingGuess,
  };
}
