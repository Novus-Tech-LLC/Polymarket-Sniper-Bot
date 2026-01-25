/**
 * Log Deduper Utility
 *
 * A shared utility for deduplicating and rate-limiting logs across the codebase.
 * Prevents log spam by tracking state and only logging when:
 * 1. The fingerprint (state) changes - log immediately
 * 2. A TTL has elapsed since the last log - heartbeat
 *
 * CORE PRINCIPLE: LOG ONLY ON STATE CHANGE OR AT A CONTROLLED HEARTBEAT INTERVAL.
 *
 * Usage:
 * ```typescript
 * const deduper = new LogDeduper();
 *
 * // Basic usage - log only once per TTL
 * if (deduper.shouldLog("Hedging:skip_summary")) {
 *   logger.info("Skipped 10 positions...");
 * }
 *
 * // With fingerprint - log immediately on state change
 * const fingerprint = JSON.stringify({ skipped: 10, reasons: ["redeemable"] });
 * if (deduper.shouldLog("Hedging:skip_summary", 120_000, fingerprint)) {
 *   logger.info("Skipped 10 positions...");
 * }
 * ```
 */

/**
 * Default TTL for skip logs (2 minutes)
 * Configurable via environment variable SKIP_LOG_TTL_MS
 */
const parseSkipLogTtl = (): number => {
  const envValue = process.env.SKIP_LOG_TTL_MS;
  if (!envValue) return 120_000;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `[LogDeduper] Invalid SKIP_LOG_TTL_MS value "${envValue}", using default 120000ms`,
    );
    return 120_000;
  }
  return parsed;
};

export const SKIP_LOG_TTL_MS = parseSkipLogTtl();

/**
 * Default heartbeat interval for summary logs (2 minutes)
 */
export const HEARTBEAT_INTERVAL_MS = 120_000;

/**
 * Default heartbeat interval for Monitor logs (1 minute)
 * Configurable via environment variable MONITOR_HEARTBEAT_MS
 */
const parseMonitorHeartbeat = (): number => {
  const envValue = process.env.MONITOR_HEARTBEAT_MS;
  if (!envValue) return 60_000;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `[LogDeduper] Invalid MONITOR_HEARTBEAT_MS value "${envValue}", using default 60000ms`,
    );
    return 60_000;
  }
  return parsed;
};

export const MONITOR_HEARTBEAT_MS = parseMonitorHeartbeat();

/**
 * Default heartbeat interval for Monitor detail logs (1 minute)
 * Configurable via environment variable MONITOR_DETAIL_HEARTBEAT_MS
 * This controls how often the detailed breakdown is logged even if fingerprint hasn't changed
 */
const parseMonitorDetailHeartbeat = (): number => {
  const envValue = process.env.MONITOR_DETAIL_HEARTBEAT_MS;
  if (!envValue) return 60_000;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `[LogDeduper] Invalid MONITOR_DETAIL_HEARTBEAT_MS value "${envValue}", using default 60000ms`,
    );
    return 60_000;
  }
  return parsed;
};

export const MONITOR_DETAIL_HEARTBEAT_MS = parseMonitorDetailHeartbeat();

/**
 * Default heartbeat interval for Monitor summary logs (1 minute)
 * Configurable via environment variable MONITOR_SUMMARY_HEARTBEAT_MS
 */
const parseMonitorSummaryHeartbeat = (): number => {
  const envValue = process.env.MONITOR_SUMMARY_HEARTBEAT_MS;
  if (!envValue) return 60_000;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `[LogDeduper] Invalid MONITOR_SUMMARY_HEARTBEAT_MS value "${envValue}", using default 60000ms`,
    );
    return 60_000;
  }
  return parsed;
};

export const MONITOR_SUMMARY_HEARTBEAT_MS = parseMonitorSummaryHeartbeat();

/**
 * Default heartbeat interval for PositionTracker logs (1 minute)
 * Configurable via environment variable TRACKER_HEARTBEAT_MS
 * Controls how often position processing logs are emitted even if counts haven't changed
 */
const parseTrackerHeartbeat = (): number => {
  const envValue = process.env.TRACKER_HEARTBEAT_MS;
  if (!envValue) return 60_000;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `[LogDeduper] Invalid TRACKER_HEARTBEAT_MS value "${envValue}", using default 60000ms`,
    );
    return 60_000;
  }
  return parsed;
};

export const TRACKER_HEARTBEAT_MS = parseTrackerHeartbeat();

/**
 * Standard truncation length for tokenIds in log messages
 * Provides enough characters to identify tokens while keeping logs readable
 */
export const TOKEN_ID_DISPLAY_LENGTH = 16;

/**
 * Price threshold (95¢) for elevated logging of NO_BID skips.
 * Positions at or above this price represent potentially stuck capital,
 * so we log at INFO level instead of DEBUG.
 */
export const HIGH_VALUE_PRICE_THRESHOLD = 0.95;

/**
 * Rate limit for high-value NO_BID logs.
 * Set shorter than the normal skip log TTL (SKIP_LOG_TTL_MS) to ensure visibility.
 */
export const HIGH_VALUE_NO_BID_LOG_TTL_MS = SKIP_LOG_TTL_MS / 4; // 30s when default SKIP_LOG_TTL_MS is 120s

/**
 * Cycle context passed to all strategies/modules for cycle-aware logging.
 * This ensures that each component logs at most ONCE per orchestrator cycle.
 */
export interface CycleContext {
  /** Unique identifier for the current orchestrator cycle */
  cycleId: number;
  /** Timestamp when the cycle started */
  startedAtMs: number;
}

/**
 * Entry stored for each tracked log key
 */
interface LogEntry {
  /** Timestamp of last log emission */
  lastLoggedAt: number;
  /** Fingerprint of last logged state (for change detection) */
  lastFingerprint: string | undefined;
  /** Number of suppressed logs since last emission */
  suppressedCount: number;
  /** Last cycleId for which this log was emitted (for cycle-aware deduplication) */
  lastCycleId?: number;
}

/**
 * Result of shouldLog check
 */
export interface ShouldLogResult {
  /** Whether the log should be emitted */
  shouldLog: boolean;
  /** Reason for the decision (for debugging) */
  reason: "first_time" | "fingerprint_changed" | "ttl_expired" | "suppressed";
  /** Number of logs suppressed since last emission */
  suppressedCount: number;
}

/**
 * Log Deduper class for rate-limiting and deduplicating logs
 */
export class LogDeduper {
  private entries: Map<string, LogEntry> = new Map();
  private maxEntries: number;

  /**
   * @param maxEntries Maximum number of tracked keys (prevents memory leaks)
   */
  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Check if a log should be emitted
   *
   * @param key Unique identifier for the log (e.g., "Hedging:skip:<tokenId>")
   * @param ttlMs Time-to-live before the same log can be emitted again (default: SKIP_LOG_TTL_MS)
   * @param fingerprint Optional state fingerprint. If provided and changed, log immediately
   * @returns Whether the log should be emitted
   */
  shouldLog(
    key: string,
    ttlMs: number = SKIP_LOG_TTL_MS,
    fingerprint?: string,
  ): boolean {
    return this.shouldLogDetailed(key, ttlMs, fingerprint).shouldLog;
  }

  /**
   * Check if a log should be emitted with detailed result
   *
   * @param key Unique identifier for the log
   * @param ttlMs Time-to-live before the same log can be emitted again
   * @param fingerprint Optional state fingerprint
   * @returns Detailed result including reason and suppression count
   */
  shouldLogDetailed(
    key: string,
    ttlMs: number = SKIP_LOG_TTL_MS,
    fingerprint?: string,
  ): ShouldLogResult {
    const now = Date.now();
    const entry = this.entries.get(key);

    // First time seeing this key - always log
    if (!entry) {
      this.setEntry(key, {
        lastLoggedAt: now,
        lastFingerprint: fingerprint,
        suppressedCount: 0,
      });
      return { shouldLog: true, reason: "first_time", suppressedCount: 0 };
    }

    // Fingerprint changed - log immediately
    if (fingerprint !== undefined && fingerprint !== entry.lastFingerprint) {
      const suppressedCount = entry.suppressedCount;
      this.setEntry(key, {
        lastLoggedAt: now,
        lastFingerprint: fingerprint,
        suppressedCount: 0,
      });
      return {
        shouldLog: true,
        reason: "fingerprint_changed",
        suppressedCount,
      };
    }

    // TTL expired - log as heartbeat
    const elapsed = now - entry.lastLoggedAt;
    if (elapsed >= ttlMs) {
      const suppressedCount = entry.suppressedCount;
      this.setEntry(key, {
        lastLoggedAt: now,
        lastFingerprint: fingerprint ?? entry.lastFingerprint,
        suppressedCount: 0,
      });
      return { shouldLog: true, reason: "ttl_expired", suppressedCount };
    }

    // Still within TTL and fingerprint unchanged - suppress
    entry.suppressedCount++;
    return {
      shouldLog: false,
      reason: "suppressed",
      suppressedCount: entry.suppressedCount,
    };
  }

  /**
   * Check if a log for a position skip should be emitted
   * Convenience method for per-position skip logs
   *
   * @param component Component name (e.g., "Hedging", "Scalp")
   * @param tokenId Token ID of the position
   * @param reason Skip reason
   * @param ttlMs Optional custom TTL
   * @returns Whether the log should be emitted
   */
  shouldLogSkip(
    component: string,
    tokenId: string,
    reason: string,
    ttlMs: number = SKIP_LOG_TTL_MS,
  ): boolean {
    const key = `${component}:skip:${tokenId}:${reason}`;
    return this.shouldLog(key, ttlMs);
  }

  /**
   * Check if a log should be emitted using a composite key.
   * This provides flexible deduplication keyed by multiple dimensions.
   *
   * Use this to prevent repeated identical spam lines by specifying:
   * - module: The module emitting the log (e.g., "Monitor", "Hedging", "PositionTracker")
   * - eventKey: The type of event (e.g., "skip_low_price", "batch_failure", "address_probe")
   * - marketId: Optional market/condition ID
   * - tokenId: Optional token ID (for position-specific logs)
   * - reason: Optional reason string
   * - priceBucket: Optional price bucket (e.g., "0-10", "10-50", "50+") for price-based grouping
   *
   * @param params Parameters for constructing the composite key
   * @param ttlMs Optional custom TTL (default: SKIP_LOG_TTL_MS)
   * @param fingerprint Optional fingerprint for change detection
   * @returns Whether the log should be emitted
   */
  shouldLogComposite(
    params: {
      module: string;
      eventKey: string;
      marketId?: string;
      tokenId?: string;
      reason?: string;
      priceBucket?: string;
    },
    ttlMs: number = SKIP_LOG_TTL_MS,
    fingerprint?: string,
  ): boolean {
    // Build composite key from provided dimensions
    const parts = [params.module, params.eventKey];
    if (params.marketId) parts.push(`m:${params.marketId.slice(0, 12)}`);
    if (params.tokenId) parts.push(`t:${params.tokenId.slice(0, 12)}`);
    if (params.reason) parts.push(`r:${params.reason}`);
    if (params.priceBucket) parts.push(`p:${params.priceBucket}`);
    const key = parts.join(":");
    return this.shouldLog(key, ttlMs, fingerprint);
  }

  // Price bucket threshold constants for priceToBucket()
  private static readonly PRICE_BUCKET_10C_THRESHOLD = 10; // < 10¢
  private static readonly PRICE_BUCKET_20C_THRESHOLD = 20; // < 20¢
  private static readonly PRICE_BUCKET_50C_THRESHOLD = 50; // < 50¢

  /**
   * Utility to bucket a price into ranges for deduplication.
   * Useful for grouping "Skipping low-price BUY" logs by price range.
   *
   * Bucket definitions:
   * - "0-10c": prices below 10 cents
   * - "10-20c": prices 10-19 cents
   * - "20-50c": prices 20-49 cents
   * - "50c+": prices at or above 50 cents
   *
   * @param price Price in 0-1 scale (e.g., 0.03 for 3¢)
   * @returns Price bucket string (e.g., "0-10c", "10-50c", "50c+")
   */
  static priceToBucket(price: number): string {
    const cents = price * 100;
    if (cents < LogDeduper.PRICE_BUCKET_10C_THRESHOLD) return "0-10c";
    if (cents < LogDeduper.PRICE_BUCKET_20C_THRESHOLD) return "10-20c";
    if (cents < LogDeduper.PRICE_BUCKET_50C_THRESHOLD) return "20-50c";
    return "50c+";
  }

  /**
   * Check if a summary log should be emitted
   * Logs immediately on state change (via fingerprint), otherwise rate-limited
   *
   * @param component Component name (e.g., "Hedging", "Scalp", "Monitor")
   * @param fingerprint State fingerprint (e.g., JSON of counts)
   * @param ttlMs Optional custom TTL (default: HEARTBEAT_INTERVAL_MS)
   * @returns Whether the log should be emitted
   */
  shouldLogSummary(
    component: string,
    fingerprint: string,
    ttlMs: number = HEARTBEAT_INTERVAL_MS,
  ): boolean {
    const key = `${component}:summary`;
    return this.shouldLog(key, ttlMs, fingerprint);
  }

  /**
   * Cycle-aware logging check.
   * Returns true at most ONCE per cycle, and only if:
   * - It's a new cycle (different cycleId) AND either:
   *   - Fingerprint changed, OR
   *   - Heartbeat interval has elapsed
   *
   * If called multiple times within the same cycle, always returns false
   * after the first true response.
   *
   * @param key Unique identifier for the log
   * @param cycleId Current orchestrator cycle ID
   * @param ttlMs Time-to-live for heartbeat (default: 60s)
   * @param fingerprint Optional state fingerprint for change detection
   * @returns Whether the log should be emitted
   */
  shouldLogForCycle(
    key: string,
    cycleId: number,
    ttlMs: number = 60_000,
    fingerprint?: string,
  ): boolean {
    const now = Date.now();
    const entry = this.entries.get(key);

    // First time seeing this key - always log
    if (!entry) {
      this.setEntry(key, {
        lastLoggedAt: now,
        lastFingerprint: fingerprint,
        suppressedCount: 0,
        lastCycleId: cycleId,
      });
      return true;
    }

    // CRITICAL: If called in the same cycle, always suppress
    // This ensures at most ONE log per cycle
    if (entry.lastCycleId === cycleId) {
      entry.suppressedCount++;
      return false;
    }

    // New cycle - check if we should log
    const fingerprintChanged =
      fingerprint !== undefined && fingerprint !== entry.lastFingerprint;
    const heartbeatElapsed = now - entry.lastLoggedAt >= ttlMs;

    // Log if fingerprint changed OR heartbeat elapsed
    if (fingerprintChanged || heartbeatElapsed) {
      this.setEntry(key, {
        lastLoggedAt: now,
        lastFingerprint: fingerprint ?? entry.lastFingerprint,
        suppressedCount: 0,
        lastCycleId: cycleId,
      });
      return true;
    }

    // Update cycleId but don't log
    entry.lastCycleId = cycleId;
    entry.suppressedCount++;
    return false;
  }

  /**
   * Get the last cycle ID for a given key (for testing)
   */
  getLastCycleId(key: string): number | undefined {
    return this.entries.get(key)?.lastCycleId;
  }

  /**
   * Reset state for a specific key
   * Useful when a condition is cleared and we want to log again on recurrence
   */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Reset all tracked state
   */
  resetAll(): void {
    this.entries.clear();
  }

  /**
   * Get number of tracked entries (for monitoring)
   */
  getEntryCount(): number {
    return this.entries.size;
  }

  /**
   * Get suppressed count for a key (for testing/monitoring)
   */
  getSuppressedCount(key: string): number {
    return this.entries.get(key)?.suppressedCount ?? 0;
  }

  /**
   * Set an entry with LRU-style eviction if over max
   */
  private setEntry(key: string, entry: LogEntry): void {
    // Evict oldest entries if over limit
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, entry);
  }
}

/**
 * Skip reason aggregator for creating summary logs
 *
 * Usage:
 * ```typescript
 * const aggregator = new SkipReasonAggregator();
 * for (const position of positions) {
 *   if (shouldSkip) aggregator.add(position.tokenId, "redeemable");
 * }
 * console.log(aggregator.getSummary()); // "redeemable=5, no_book=2, ..."
 * console.log(aggregator.getFingerprint()); // For change detection
 * ```
 */
export class SkipReasonAggregator {
  private reasons: Map<string, Set<string>> = new Map();

  /**
   * Add a skip reason for a position
   */
  add(tokenId: string, reason: string): void {
    if (!this.reasons.has(reason)) {
      this.reasons.set(reason, new Set());
    }
    this.reasons.get(reason)!.add(tokenId);
  }

  /**
   * Get the count for a specific reason
   */
  getCount(reason: string): number {
    return this.reasons.get(reason)?.size ?? 0;
  }

  /**
   * Get total number of skipped positions (unique tokenIds)
   */
  getTotalCount(): number {
    const allTokenIds = new Set<string>();
    for (const tokenIds of this.reasons.values()) {
      for (const tokenId of tokenIds) {
        allTokenIds.add(tokenId);
      }
    }
    return allTokenIds.size;
  }

  /**
   * Get a human-readable summary of skip reasons
   * Format: "redeemable=5, no_book=2, spread_wide=1"
   */
  getSummary(): string {
    const parts: string[] = [];
    // Sort by count (descending) for consistent output
    const sorted = Array.from(this.reasons.entries()).sort(
      (a, b) => b[1].size - a[1].size,
    );
    for (const [reason, tokenIds] of sorted) {
      parts.push(`${reason}=${tokenIds.size}`);
    }
    return parts.join(", ");
  }

  /**
   * Get a stable fingerprint for change detection
   * Returns a JSON string of sorted reason counts
   */
  getFingerprint(): string {
    const counts: Record<string, number> = {};
    for (const [reason, tokenIds] of this.reasons) {
      counts[reason] = tokenIds.size;
    }
    // Sort keys for stable fingerprint
    const sortedKeys = Object.keys(counts).sort();
    const sortedCounts: Record<string, number> = {};
    for (const key of sortedKeys) {
      sortedCounts[key] = counts[key];
    }
    return JSON.stringify(sortedCounts);
  }

  /**
   * Check if there are any skipped positions
   */
  hasSkips(): boolean {
    return this.reasons.size > 0;
  }

  /**
   * Clear all tracked data
   */
  clear(): void {
    this.reasons.clear();
  }
}

// Global singleton instance for shared deduplication across modules
let globalLogDeduper: LogDeduper | null = null;

/**
 * Get the global LogDeduper instance
 */
export function getLogDeduper(): LogDeduper {
  if (!globalLogDeduper) {
    globalLogDeduper = new LogDeduper();
  }
  return globalLogDeduper;
}

/**
 * Reset the global LogDeduper (for testing)
 */
export function resetLogDeduper(): void {
  if (globalLogDeduper) {
    globalLogDeduper.resetAll();
  }
  globalLogDeduper = null;
}
