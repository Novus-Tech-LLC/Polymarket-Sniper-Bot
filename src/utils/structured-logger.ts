/**
 * Structured Logging System
 *
 * Provides JSON and human-readable logging with:
 * - Correlation IDs (RUN_ID, REQ_ID, ATTEMPT_ID)
 * - Log categories/tags for filtering
 * - Deduplication (5 second window)
 * - Secret redaction
 * - Suppression counters
 */

import crypto from "node:crypto";
import chalk from "chalk";

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogCategory =
  | "STARTUP"
  | "IDENTITY"
  | "CRED_DERIVE"
  | "SIGN"
  | "HTTP"
  | "PREFLIGHT"
  | "SUMMARY";

export interface LogContext {
  runId?: string;
  reqId?: string;
  attemptId?: string;
  category?: LogCategory;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
}

type LogFormat = "json" | "pretty";

interface DeduplicationEntry {
  message: string;
  category?: LogCategory;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

const DEDUP_WINDOW_MS = 5000; // 5 seconds
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Generate a unique run ID
 */
export function generateRunId(): string {
  return `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Generate a unique request ID
 */
export function generateReqId(): string {
  return `req_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Generate an attempt ID (A, B, C, D, E)
 */
export function generateAttemptId(index: number): string {
  return String.fromCharCode(65 + index); // A, B, C, D, E
}

/**
 * Redact sensitive data from log context
 */
function redactSecrets(context: LogContext): LogContext {
  const redacted = { ...context };

  // Redact private keys
  if (typeof redacted.privateKey === "string") {
    redacted.privateKey = `[REDACTED len=${redacted.privateKey.length}]`;
  }

  // Redact API keys - show last 6 chars only
  if (typeof redacted.apiKey === "string") {
    const key = redacted.apiKey;
    redacted.apiKey =
      key.length >= 6 ? `***${key.slice(-6)}` : `[REDACTED len=${key.length}]`;
  }

  // Redact secrets - show length and first/last 4 chars
  if (typeof redacted.secret === "string") {
    const secret = redacted.secret;
    if (secret.length >= 12) {
      redacted.secret = `${secret.slice(0, 4)}...${secret.slice(-4)} [len=${secret.length}]`;
    } else {
      redacted.secret = `[REDACTED len=${secret.length}]`;
    }
  }

  // Redact passphrases - show first/last 4 chars
  if (typeof redacted.passphrase === "string") {
    const passphrase = redacted.passphrase;
    if (passphrase.length >= 12) {
      redacted.passphrase = `${passphrase.slice(0, 4)}...${passphrase.slice(-4)}`;
    } else {
      redacted.passphrase = `[REDACTED len=${passphrase.length}]`;
    }
  }

  // Redact full signatures - only show hash prefix
  if (typeof redacted.signature === "string") {
    const sig = redacted.signature;
    const hash = crypto.createHash("sha256").update(sig).digest("hex");
    redacted.signature = `hash:${hash.slice(0, 8)}`;
  }

  // Recursively redact nested objects
  for (const key in redacted) {
    if (
      redacted[key] &&
      typeof redacted[key] === "object" &&
      !Array.isArray(redacted[key])
    ) {
      redacted[key] = redactSecrets(redacted[key] as LogContext);
    }
  }

  return redacted;
}

/**
 * Structured Logger with deduplication
 */
export class StructuredLogger {
  private format: LogFormat;
  private level: LogLevel;
  private baseContext: LogContext;
  private deduplicationMap: Map<string, DeduplicationEntry>;
  private deduplicationTimer?: NodeJS.Timeout;

  constructor(options?: {
    format?: LogFormat;
    level?: LogLevel;
    baseContext?: LogContext;
  }) {
    this.format = this.parseFormat(
      options?.format ?? process.env.LOG_FORMAT ?? "json",
    );
    this.level = this.parseLevel(
      options?.level ?? process.env.LOG_LEVEL ?? "info",
    );
    this.baseContext = options?.baseContext ?? {};
    this.deduplicationMap = new Map();

    // Start deduplication cleanup timer
    this.startDeduplicationCleanup();
  }

  private parseFormat(value: string): LogFormat {
    const normalized = value.toLowerCase().trim();
    return normalized === "pretty" ? "pretty" : "json";
  }

  private parseLevel(value: string): LogLevel {
    const normalized = value.toLowerCase().trim();
    if (
      normalized === "error" ||
      normalized === "warn" ||
      normalized === "info" ||
      normalized === "debug"
    ) {
      return normalized;
    }
    return "info";
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.level];
  }

  private startDeduplicationCleanup(): void {
    this.deduplicationTimer = setInterval(() => {
      this.flushDeduplication();
    }, DEDUP_WINDOW_MS);

    // Don't prevent Node.js from exiting
    if (this.deduplicationTimer.unref) {
      this.deduplicationTimer.unref();
    }
  }

  private flushDeduplication(): void {
    const now = Date.now();

    for (const [key, entry] of this.deduplicationMap.entries()) {
      // If entry hasn't been seen in the last window, emit suppression message
      if (now - entry.lastSeen >= DEDUP_WINDOW_MS) {
        if (entry.count > 1) {
          // Emit suppression message without deduplication (to avoid recursive dedup)
          const context: LogContext = {
            ...this.baseContext,
            category: entry.category,
            suppressedCount: entry.count - 1,
            suppressedMessage: entry.message.slice(0, 80), // Truncate to 80 chars
          };
          // Emit directly to avoid re-entering dedup logic
          this.emitLog(
            "debug",
            `(suppressed ${entry.count - 1} identical log messages)`,
            context,
          );
        }
        this.deduplicationMap.delete(key);
      }
    }
  }

  private emitSuppressionMessage(entry: DeduplicationEntry): void {
    const context: LogContext = {
      ...this.baseContext,
      category: entry.category,
      suppressedCount: entry.count - 1,
    };

    this.emitLog("info", `(suppressed ${entry.count - 1} repeats)`, context);
  }

  private getDedupKey(message: string, category?: LogCategory): string | null {
    // Only deduplicate messages with a category
    if (!category) return null;
    return `${category}:${message}`;
  }

  private checkDeduplication(message: string, context: LogContext): boolean {
    const key = this.getDedupKey(message, context.category);
    if (!key) return false; // Don't deduplicate

    const now = Date.now();
    const existing = this.deduplicationMap.get(key);

    if (existing) {
      // Within dedup window?
      if (now - existing.firstSeen < DEDUP_WINDOW_MS) {
        existing.lastSeen = now;
        existing.count++;
        return true; // Suppress this log
      } else {
        // Outside window, emit suppression and reset
        if (existing.count > 1) {
          this.emitSuppressionMessage(existing);
        }
        this.deduplicationMap.set(key, {
          message,
          category: context.category,
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
        category: context.category,
        firstSeen: now,
        lastSeen: now,
        count: 1,
      });
      return false; // Don't suppress
    }
  }

  private emitLog(level: LogLevel, message: string, context: LogContext): void {
    const timestamp = new Date().toISOString();
    const redactedContext = redactSecrets(context);

    if (this.format === "json") {
      const entry: LogEntry = {
        timestamp,
        level,
        message,
        context: redactedContext,
      };
      // eslint-disable-next-line no-console -- Structured logger output to stdout
      console.log(JSON.stringify(entry));
    } else {
      // Pretty format
      const levelColor =
        level === "error"
          ? chalk.red
          : level === "warn"
            ? chalk.yellow
            : level === "info"
              ? chalk.cyan
              : chalk.gray;

      const levelStr = levelColor(`[${level.toUpperCase()}]`);
      const categoryStr = context.category
        ? chalk.magenta(`[${context.category}]`)
        : "";
      const runIdStr = context.runId ? chalk.dim(`[${context.runId}]`) : "";
      const reqIdStr = context.reqId ? chalk.dim(`[${context.reqId}]`) : "";
      const attemptIdStr = context.attemptId
        ? chalk.dim(`[attempt:${context.attemptId}]`)
        : "";

      const prefix = [levelStr, categoryStr, runIdStr, reqIdStr, attemptIdStr]
        .filter(Boolean)
        .join(" ");

      // Format context keys (except standard ones)
      const contextKeys = Object.keys(redactedContext).filter(
        (k) =>
          k !== "runId" &&
          k !== "reqId" &&
          k !== "attemptId" &&
          k !== "category",
      );

      if (contextKeys.length > 0) {
        const contextStr = contextKeys
          .map((k) => {
            const v = redactedContext[k];
            const value = typeof v === "object" ? JSON.stringify(v) : String(v);
            return `${k}=${value}`;
          })
          .join(" ");
        // eslint-disable-next-line no-console -- Structured logger output to stdout
        console.log(`${prefix} ${message} ${chalk.dim(contextStr)}`);
      } else {
        // eslint-disable-next-line no-console -- Structured logger output to stdout
        console.log(`${prefix} ${message}`);
      }
    }
  }

  /**
   * Log a message
   */
  log(level: LogLevel, message: string, context: LogContext = {}): void {
    if (!this.shouldLog(level)) return;

    const fullContext = { ...this.baseContext, ...context };

    // Check deduplication
    if (this.checkDeduplication(message, fullContext)) {
      return; // Suppressed
    }

    this.emitLog(level, message, fullContext);
  }

  /**
   * Log with context
   */
  child(context: LogContext): StructuredLogger {
    return new StructuredLogger({
      format: this.format,
      level: this.level,
      baseContext: { ...this.baseContext, ...context },
    });
  }

  /**
   * Error log
   */
  error(message: string, context: LogContext = {}): void {
    this.log("error", message, context);
  }

  /**
   * Warn log
   */
  warn(message: string, context: LogContext = {}): void {
    this.log("warn", message, context);
  }

  /**
   * Info log
   */
  info(message: string, context: LogContext = {}): void {
    this.log("info", message, context);
  }

  /**
   * Debug log
   */
  debug(message: string, context: LogContext = {}): void {
    this.log("debug", message, context);
  }

  /**
   * Cleanup on shutdown
   */
  shutdown(): void {
    this.flushDeduplication();
    if (this.deduplicationTimer) {
      clearInterval(this.deduplicationTimer);
    }
  }
}

// Global logger instance
let globalLogger: StructuredLogger | null = null;

/**
 * Get or create global logger instance
 */
export function getLogger(): StructuredLogger {
  if (!globalLogger) {
    const runId = generateRunId();
    globalLogger = new StructuredLogger({
      baseContext: { runId },
    });
  }
  return globalLogger;
}

/**
 * Reset global logger (for testing)
 */
export function resetLogger(): void {
  if (globalLogger) {
    globalLogger.shutdown();
  }
  globalLogger = null;
}
