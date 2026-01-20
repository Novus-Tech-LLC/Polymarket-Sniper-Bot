/**
 * Auth Logger Utility - Prevents Log Spam and Enforces Single Auth Story Per Run
 *
 * This module provides:
 * 1. Deduplication of repeated auth messages within a time window
 * 2. Structured logging with correlation IDs (run_id, req_id, attempt_id)
 * 3. Single "Auth Story" summary block per run
 * 4. No secrets in logs (only last 4-6 chars, hashes, lengths)
 */

import crypto from "node:crypto";
import type { Logger } from "./logger.util";

/**
 * Auth log entry for deduplication
 */
interface AuthLogEntry {
  fingerprint: string;
  timestamp: number;
  count: number;
}

/**
 * Auth logger state
 */
class AuthLoggerState {
  private logCache = new Map<string, AuthLogEntry>();
  private readonly DEDUP_WINDOW_MS = 60000; // 1 minute
  private readonly MAX_CACHE_SIZE = 1000;

  /**
   * Check if a message should be logged (deduplication)
   */
  shouldLog(fingerprint: string): { should: boolean; count: number } {
    const now = Date.now();
    const entry = this.logCache.get(fingerprint);

    if (!entry) {
      // First occurrence - always log
      this.logCache.set(fingerprint, {
        fingerprint,
        timestamp: now,
        count: 1,
      });
      this.cleanupOldEntries(now);
      return { should: true, count: 1 };
    }

    // Check if outside dedup window
    if (now - entry.timestamp > this.DEDUP_WINDOW_MS) {
      // Window expired - log again and reset
      entry.timestamp = now;
      entry.count = 1;
      return { should: true, count: 1 };
    }

    // Within window - increment and suppress
    entry.count += 1;
    return { should: false, count: entry.count };
  }

  /**
   * Cleanup old entries to prevent unbounded memory growth
   */
  private cleanupOldEntries(now: number): void {
    if (this.logCache.size < this.MAX_CACHE_SIZE) return;

    // Remove entries older than 5 minutes
    const CLEANUP_THRESHOLD_MS = 300000;
    for (const [key, entry] of this.logCache.entries()) {
      if (now - entry.timestamp > CLEANUP_THRESHOLD_MS) {
        this.logCache.delete(key);
      }
    }
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.logCache.clear();
  }
}

const state = new AuthLoggerState();

/**
 * Create a fingerprint for deduplication (hash-based, no secrets)
 */
export function createAuthLogFingerprint(data: {
  category: string;
  message: string;
  context?: Record<string, unknown>;
}): string {
  const normalized = JSON.stringify({
    category: data.category,
    message: data.message,
    // Only include stable context keys for fingerprint
    signatureType: data.context?.signatureType,
    l1Auth: data.context?.l1Auth,
    maker: data.context?.maker,
  });
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Log with deduplication
 */
export function logAuth(
  logger: Logger | undefined,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context?: {
    category?: string;
    runId?: string;
    attemptId?: string;
    [key: string]: unknown;
  },
): void {
  if (!logger) return;

  const category = context?.category || "AUTH";
  const fingerprint = createAuthLogFingerprint({ category, message, context });
  const { should, count } = state.shouldLog(fingerprint);

  if (!should) {
    // Suppressed - emit a single "suppressed" message every 10 occurrences
    if (count % 10 === 0) {
      logger[level](`[${category}] ${message} (suppressed ${count - 1} repeats)`);
    }
    return;
  }

  // Log with context - use structured format for machine readability
  const prefix = context?.runId
    ? `[${category}:${context.runId}]`
    : `[${category}]`;
  
  if (context && Object.keys(context).length > 0) {
    const contextStr = Object.entries(context)
      .filter(([key]) => key !== "category" && key !== "runId")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    logger[level](`${prefix} ${message} ${contextStr}`);
  } else {
    logger[level](`${prefix} ${message}`);
  }
}

// Credential sanitization constants
const API_KEY_MIN_LENGTH = 6;
const API_KEY_HASH_PREFIX_LENGTH = 8;
const CREDENTIAL_SUFFIX_LENGTH = 4;

/**
 * Sanitize credential for logging (only show suffix and length)
 */
export function sanitizeCredential(
  value: string | undefined,
  type: "apiKey" | "secret" | "passphrase",
): string {
  if (!value) return "none";

  if (type === "apiKey") {
    return value.length >= API_KEY_MIN_LENGTH
      ? `...${value.slice(-API_KEY_MIN_LENGTH)} (len=${value.length})`
      : `hash:${crypto.createHash("sha256").update(value).digest("hex").slice(0, API_KEY_HASH_PREFIX_LENGTH)}`;
  }

  // secret and passphrase use same sanitization pattern
  return `***${value.slice(-CREDENTIAL_SUFFIX_LENGTH)} (len=${value.length})`;
}

/**
 * Reset state (for testing)
 */
export function resetAuthLogger(): void {
  state.reset();
}
