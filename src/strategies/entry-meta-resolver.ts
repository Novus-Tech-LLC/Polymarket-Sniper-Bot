/**
 * EntryMetaResolver - Stateless Entry Metadata from Trade History
 *
 * This module computes entry metadata (cost basis, timestamps) for positions
 * from the Polymarket trade history API. It is STATELESS and derives all data
 * from remote APIs each run - no local persistence (files, SQLite, volumes).
 *
 * WHY THIS EXISTS:
 * ScalpTakeProfit previously used container uptime to calculate "time held".
 * After container redeploys/upgrades, the clock reset, causing the scalper
 * to miss valid take-profit opportunities on positions already in the green.
 *
 * HOW IT WORKS:
 * For each ACTIVE position (identified by tokenId):
 * 1. Fetch trade/fill history for the address + tokenId
 * 2. Reconstruct position lots from BUY/SELL fills
 * 3. Calculate weighted average entry price for current shares
 * 4. Compute firstAcquiredAt (oldest contributing BUY) and lastAcquiredAt
 * 5. Return timeHeldSec = now - firstAcquiredAt
 *
 * TOKENID-BASED:
 * All calculations use tokenId as primary key. This works for any binary
 * outcome type (YES/NO, Over/Under, TeamA/TeamB, etc.) because each outcome
 * has a unique tokenId regardless of outcome name.
 *
 * UNTRUSTED_ENTRY VALIDATION (Jan 2025):
 * Entry metadata can be marked as UNTRUSTED when:
 * - Computed netShares differs from Data API position shares by >2% or >0.5 shares
 *
 * When trusted === false:
 * - untrustedReason contains the specific mismatch details
 * - Strategies SHOULD NOT use this metadata for P&L calculation or scalp sizing
 * - This prevents the bug where trade history is incorrectly mapped (e.g., multiple
 *   tokenIds getting identical reconstructed values due to grouping errors)
 *
 * CACHING:
 * In-memory cache with short TTL (default 90s) for performance within a
 * single runtime. Cache is reconstructable after restart from API data.
 */

import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { ConsoleLogger } from "../utils/logger.util";

/**
 * Entry metadata for a position
 */
export interface EntryMeta {
  /** Weighted average entry price in cents (e.g., 65.5 for 65.5¢) */
  avgEntryPriceCents: number;
  /** Timestamp (ms) of the first BUY that contributes to current position */
  firstAcquiredAt: number;
  /** Timestamp (ms) of the most recent BUY that increased the position */
  lastAcquiredAt: number;
  /** Time held in seconds since firstAcquiredAt */
  timeHeldSec: number;
  /** Remaining shares in the position */
  remainingShares: number;
  /** Cache age in milliseconds (0 if freshly fetched) */
  cacheAgeMs: number;
  /**
   * Whether the entry metadata is trusted for P&L/sizing calculations.
   *
   * Set to false (UNTRUSTED_ENTRY) when:
   * - Computed netShares differs from Data API position shares by >2% or >0.5 shares
   *
   * When untrusted, strategies should NOT use this metadata for:
   * - P&L calculation
   * - Scalp sizing decisions
   */
  trusted: boolean;
  /**
   * Reason why entry is untrusted (only set when trusted === false)
   */
  untrustedReason?: string;
}

/**
 * Trade item from the Polymarket trades API
 */
interface TradeItem {
  timestamp: number; // Unix timestamp in seconds
  conditionId: string; // Market ID
  asset: string; // Token ID
  side: string; // "BUY" or "SELL"
  size: number | string;
  price: number | string;
}

/**
 * Cache entry with TTL tracking
 */
interface CacheEntry {
  meta: EntryMeta;
  fetchedAt: number;
}

/**
 * Configuration for EntryMetaResolver
 */
export interface EntryMetaResolverConfig {
  logger: ConsoleLogger;
  /** Cache TTL in milliseconds (default: 90000ms = 90s) */
  cacheTtlMs?: number;
  /** API timeout in milliseconds (default: 10000ms = 10s) */
  apiTimeoutMs?: number;
  /** Maximum pages to fetch per token (default: 10) */
  maxPagesPerToken?: number;
  /** Trades per page (default: 500) */
  tradesPerPage?: number;
  /**
   * Use lastAcquiredAt instead of firstAcquiredAt for timeHeldSec calculation.
   * When true, timeHeldSec = now - lastAcquiredAt (time since last buy).
   * When false (default), timeHeldSec = now - firstAcquiredAt (time since first buy).
   */
  useLastAcquiredForTimeHeld?: boolean;
  /**
   * Maximum history depth in days to scan (default: unlimited).
   * Trades older than this many days are ignored to speed up boot time.
   * Set to e.g. 30 to only consider last 30 days of trades.
   */
  maxHistoryDays?: number;
  /**
   * Maximum total trades to scan per token (default: unlimited).
   * Stops scanning after this many trades to limit boot time scanning.
   */
  maxTradesPerToken?: number;
}

/**
 * Read max history depth controls from environment variables.
 * Returns defaults if not set.
 */
const parseHistoryDepthConfig = (): {
  maxHistoryDays: number | undefined;
  maxTradesPerToken: number | undefined;
} => {
  const daysEnv = process.env.HISTORY_MAX_DAYS;
  const tradesEnv = process.env.HISTORY_MAX_TRADES_PER_TOKEN;

  let maxHistoryDays: number | undefined;
  let maxTradesPerToken: number | undefined;

  if (daysEnv) {
    const parsed = parseInt(daysEnv, 10);
    if (!isNaN(parsed) && parsed > 0) {
      maxHistoryDays = parsed;
    }
  }

  if (tradesEnv) {
    const parsed = parseInt(tradesEnv, 10);
    if (!isNaN(parsed) && parsed > 0) {
      maxTradesPerToken = parsed;
    }
  }

  return { maxHistoryDays, maxTradesPerToken };
};

/**
 * EntryMetaResolver - Computes stateless entry metadata from trade history
 */
export class EntryMetaResolver {
  private logger: ConsoleLogger;
  private cacheTtlMs: number;
  private apiTimeoutMs: number;
  private maxPagesPerToken: number;
  private tradesPerPage: number;
  private useLastAcquiredForTimeHeld: boolean;
  private maxHistoryDays: number | undefined;
  private maxTradesPerToken: number | undefined;

  // In-memory cache: key = "address-tokenId"
  private cache: Map<string, CacheEntry> = new Map();

  // Track which tokens had fetch errors (to avoid repeated failures)
  private fetchErrors: Map<string, { errorAt: number; message: string }> =
    new Map();
  private static readonly FETCH_ERROR_COOLDOWN_MS = 60_000; // 1 minute cooldown on errors

  constructor(config: EntryMetaResolverConfig) {
    this.logger = config.logger;
    this.cacheTtlMs = config.cacheTtlMs ?? 90_000; // 90 seconds default
    this.apiTimeoutMs = config.apiTimeoutMs ?? 10_000; // 10 seconds
    this.maxPagesPerToken = config.maxPagesPerToken ?? 10;
    this.tradesPerPage = config.tradesPerPage ?? 500;
    this.useLastAcquiredForTimeHeld =
      config.useLastAcquiredForTimeHeld ?? false;

    // Parse max history depth from config or environment
    const envConfig = parseHistoryDepthConfig();
    this.maxHistoryDays = config.maxHistoryDays ?? envConfig.maxHistoryDays;
    this.maxTradesPerToken =
      config.maxTradesPerToken ?? envConfig.maxTradesPerToken;

    // Log history depth controls if configured
    if (this.maxHistoryDays || this.maxTradesPerToken) {
      this.logger.info(
        `[EntryMetaResolver] History depth controls: maxDays=${this.maxHistoryDays ?? "unlimited"} maxTradesPerToken=${this.maxTradesPerToken ?? "unlimited"}`,
      );
    }
  }

  /**
   * Resolve entry metadata for a position.
   *
   * @param address - Wallet address (or proxy address) that holds/traded the position
   * @param tokenId - The token ID of the position (outcome token)
   * @param marketId - The market ID (conditionId) - used for filtering trades
   * @param livePositionShares - Optional: live position shares from Data API for validation
   * @returns EntryMeta if successful, null if unable to resolve
   */
  async resolveEntryMeta(
    address: string,
    tokenId: string,
    marketId: string,
    livePositionShares?: number,
  ): Promise<EntryMeta | null> {
    const cacheKey = `${address.toLowerCase()}-${tokenId}`;
    const now = Date.now();

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      const cacheAgeMs = now - cached.fetchedAt;
      return {
        ...cached.meta,
        cacheAgeMs,
        // Recalculate timeHeldSec with current time
        timeHeldSec: this.useLastAcquiredForTimeHeld
          ? Math.floor((now - cached.meta.lastAcquiredAt) / 1000)
          : Math.floor((now - cached.meta.firstAcquiredAt) / 1000),
      };
    }

    // Check if we're in error cooldown for this token
    const errorEntry = this.fetchErrors.get(cacheKey);
    if (
      errorEntry &&
      now - errorEntry.errorAt < EntryMetaResolver.FETCH_ERROR_COOLDOWN_MS
    ) {
      this.logger.debug(
        `[EntryMetaResolver] Skipping ${tokenId.slice(0, 12)}... (in error cooldown: ${errorEntry.message})`,
      );
      return null;
    }

    // Fetch trade history for this token
    try {
      const meta = await this.fetchAndComputeEntryMeta(
        address,
        tokenId,
        marketId,
      );

      if (meta) {
        // Validate against live position shares if provided
        const validatedMeta = this.validateAgainstLiveShares(
          meta,
          livePositionShares,
          tokenId,
        );

        // Cache the result
        this.cache.set(cacheKey, { meta: validatedMeta, fetchedAt: now });
        // Clear any previous error
        this.fetchErrors.delete(cacheKey);
        return { ...validatedMeta, cacheAgeMs: 0 };
      }

      return null;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.fetchErrors.set(cacheKey, { errorAt: now, message: errMsg });
      this.logger.warn(
        `[EntryMetaResolver] Failed to fetch entry meta for ${tokenId.slice(0, 12)}...: ${errMsg}`,
      );
      return null;
    }
  }

  /**
   * Validate computed entry metadata against live position shares.
   *
   * Marks entry as UNTRUSTED if computed shares differ materially from Data API:
   * - Difference > 2% OR
   * - Difference > 0.5 shares (absolute)
   *
   * This prevents the bug where trade history is incorrectly mapped (e.g., multiple
   * tokenIds getting identical reconstructed values).
   *
   * @param meta - Computed entry metadata
   * @param liveShares - Live position shares from Data API (optional)
   * @param tokenId - Token ID for logging
   * @returns EntryMeta with trusted flag set appropriately
   */
  private validateAgainstLiveShares(
    meta: EntryMeta,
    liveShares: number | undefined,
    tokenId: string,
  ): EntryMeta {
    // If no live shares provided, can't validate - assume trusted
    if (liveShares === undefined || liveShares <= 0) {
      return { ...meta, trusted: true };
    }

    const computedShares = meta.remainingShares;
    const difference = Math.abs(computedShares - liveShares);
    const percentDiff = (difference / liveShares) * 100;

    // Threshold constants
    const MAX_PERCENT_DIFF = 2; // 2%
    const MAX_ABSOLUTE_DIFF = 0.5; // 0.5 shares

    if (percentDiff > MAX_PERCENT_DIFF || difference > MAX_ABSOLUTE_DIFF) {
      const reason = `Shares mismatch: computed=${computedShares.toFixed(2)} vs live=${liveShares.toFixed(2)} (diff=${difference.toFixed(2)}, ${percentDiff.toFixed(1)}%)`;

      this.logger.warn(
        `[EntryMetaResolver] UNTRUSTED_ENTRY tokenId=${tokenId.slice(0, 12)}... ${reason}`,
      );

      return {
        ...meta,
        trusted: false,
        untrustedReason: reason,
      };
    }

    return { ...meta, trusted: true };
  }

  /**
   * Fetch trade history and compute entry metadata
   */
  private async fetchAndComputeEntryMeta(
    address: string,
    tokenId: string,
    marketId: string,
  ): Promise<EntryMeta | null> {
    // Fetch trades (BUY and SELL) for this specific tokenId to reconstruct position
    // Filter by asset=tokenId so we only get trades for this outcome, not all user trades
    // We need both BUY and SELL to calculate remaining shares and weighted average
    const trades: TradeItem[] = [];
    let offset = 0;
    let pageCount = 0;

    // Calculate cutoff timestamp if maxHistoryDays is set
    const now = Date.now();
    const cutoffTimestamp = this.maxHistoryDays
      ? Math.floor((now - this.maxHistoryDays * 24 * 60 * 60 * 1000) / 1000)
      : 0;

    while (pageCount < this.maxPagesPerToken) {
      pageCount++;

      // Build URL: filter by user, asset (tokenId), with pagination
      // Note: TRADES_ENDPOINT already includes ?user=, so we use & for additional params
      // Filter by asset=tokenId to only get trades for this specific outcome
      const tradesUrl = `${POLYMARKET_API.TRADES_ENDPOINT(address)}&asset=${encodeURIComponent(tokenId)}&limit=${this.tradesPerPage}&offset=${offset}`;

      const response = await httpGet<TradeItem[]>(tradesUrl, {
        timeout: this.apiTimeoutMs,
      });

      if (!response || response.length === 0) {
        break;
      }

      // Apply history depth filter: only include trades within maxHistoryDays
      let filteredResponse = response;
      if (cutoffTimestamp > 0) {
        filteredResponse = response.filter(
          (t) => t.timestamp >= cutoffTimestamp,
        );
        // If all trades in this page are too old, stop scanning
        if (filteredResponse.length === 0 && response.length > 0) {
          this.logger.debug(
            `[EntryMetaResolver] Stopping scan for ${tokenId.slice(0, 12)}... - trades older than ${this.maxHistoryDays} days`,
          );
          break;
        }
      }

      trades.push(...filteredResponse);

      // Check maxTradesPerToken limit
      if (this.maxTradesPerToken && trades.length >= this.maxTradesPerToken) {
        this.logger.debug(
          `[EntryMetaResolver] Stopping scan for ${tokenId.slice(0, 12)}... - reached ${this.maxTradesPerToken} trades limit`,
        );
        break;
      }

      // Stop if we got fewer results than requested (end of data)
      if (response.length < this.tradesPerPage) {
        break;
      }

      offset += this.tradesPerPage;
    }

    if (trades.length === 0) {
      this.logger.debug(
        `[EntryMetaResolver] No trades found for ${tokenId.slice(0, 12)}...`,
      );
      return null;
    }

    // Sort trades by timestamp (oldest first) for correct reconstruction
    trades.sort((a, b) => a.timestamp - b.timestamp);

    // Reconstruct position from trade history using weighted average method
    return this.reconstructPositionFromTrades(trades, tokenId);
  }

  /**
   * Reconstruct position entry metadata from trade history.
   *
   * Uses WEIGHTED AVERAGE method for cost basis:
   * - BUY trades add to position with their price contributing to average
   * - SELL trades reduce position at the current average price (FIFO-style impact)
   *
   * Timestamps:
   * - firstAcquiredAt: timestamp of the oldest BUY that contributes to current position
   * - lastAcquiredAt: timestamp of the most recent BUY that increased the position
   *
   * @param trades - Array of trades sorted by timestamp (oldest first)
   * @param tokenId - Token ID for logging
   */
  private reconstructPositionFromTrades(
    trades: TradeItem[],
    tokenId: string,
  ): EntryMeta | null {
    // Track position state
    let totalShares = 0;
    let totalCost = 0; // Total cost in price units (0-1 scale)
    let firstAcquiredAt: number | null = null;
    let lastAcquiredAt: number | null = null;

    // Track contributing BUY timestamps for firstAcquiredAt recalculation
    // When SELLs occur, we may need to update firstAcquiredAt
    // For simplicity with weighted average, we track the first BUY that started
    // the current "open" position (reset when position goes to 0)
    let positionStartTimestamp: number | null = null;

    for (const trade of trades) {
      const side = trade.side?.toUpperCase();
      const size =
        typeof trade.size === "string" ? parseFloat(trade.size) : trade.size;
      const price =
        typeof trade.price === "string" ? parseFloat(trade.price) : trade.price;
      const timestampMs = trade.timestamp * 1000; // Convert seconds to ms

      // Skip invalid trades
      if (!Number.isFinite(size) || size <= 0) continue;
      if (!Number.isFinite(price) || price < 0) continue;
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) continue;

      if (side === "BUY") {
        // BUY: Add to position
        const tradeValue = size * price;
        totalShares += size;
        totalCost += tradeValue;

        // Track timestamps
        if (positionStartTimestamp === null) {
          // This BUY started a new position (or is the first BUY)
          positionStartTimestamp = timestampMs;
        }
        lastAcquiredAt = timestampMs;

        // firstAcquiredAt is the start of the current open position
        if (firstAcquiredAt === null) {
          firstAcquiredAt = timestampMs;
        }
      } else if (side === "SELL") {
        // SELL: Reduce position at weighted average
        if (totalShares > 0) {
          const avgPrice = totalCost / totalShares;
          const sharesToSell = Math.min(size, totalShares);
          const costReduction = sharesToSell * avgPrice;

          totalShares -= sharesToSell;
          totalCost -= costReduction;

          // If position is fully closed, reset tracking
          if (totalShares <= 0.0001) {
            // Near zero threshold for floating point
            totalShares = 0;
            totalCost = 0;
            positionStartTimestamp = null;
            firstAcquiredAt = null;
            lastAcquiredAt = null;
          }
        }
      }
    }

    // If no remaining position, return null
    if (totalShares <= 0.0001) {
      this.logger.debug(
        `[EntryMetaResolver] No remaining position for ${tokenId.slice(0, 12)}... after trade reconstruction`,
      );
      return null;
    }

    // Calculate weighted average entry price
    const avgEntryPrice = totalCost / totalShares; // 0-1 scale
    const avgEntryPriceCents = avgEntryPrice * 100; // Convert to cents

    // Ensure we have valid timestamps
    if (!firstAcquiredAt || !lastAcquiredAt) {
      this.logger.warn(
        `[EntryMetaResolver] Missing timestamps for ${tokenId.slice(0, 12)}... (firstAcquiredAt=${firstAcquiredAt}, lastAcquiredAt=${lastAcquiredAt})`,
      );
      return null;
    }

    // Calculate time held
    const now = Date.now();
    const referenceTimestamp = this.useLastAcquiredForTimeHeld
      ? lastAcquiredAt
      : firstAcquiredAt;
    const timeHeldSec = Math.floor((now - referenceTimestamp) / 1000);

    this.logger.debug(
      `[EntryMetaResolver] Reconstructed ${tokenId.slice(0, 12)}...: ` +
        `${totalShares.toFixed(2)} shares @ ${avgEntryPriceCents.toFixed(1)}¢ avg, ` +
        `first=${new Date(firstAcquiredAt).toISOString().slice(11, 19)}, ` +
        `last=${new Date(lastAcquiredAt).toISOString().slice(11, 19)}, ` +
        `held=${Math.floor(timeHeldSec / 60)}min`,
    );

    return {
      avgEntryPriceCents,
      firstAcquiredAt,
      lastAcquiredAt,
      timeHeldSec,
      remainingShares: totalShares,
      cacheAgeMs: 0,
      trusted: true, // Will be validated against live shares in resolveEntryMeta
    };
  }

  /**
   * Resolve entry metadata for multiple positions in batch.
   * More efficient than resolving one by one due to potential caching.
   *
   * @param address - Wallet address
   * @param positions - Array of {tokenId, marketId} pairs
   * @returns Map of tokenId -> EntryMeta (or null if unable to resolve)
   */
  async resolveEntryMetaBatch(
    address: string,
    positions: Array<{ tokenId: string; marketId: string }>,
  ): Promise<Map<string, EntryMeta | null>> {
    const results = new Map<string, EntryMeta | null>();

    // Resolve in parallel with concurrency limit
    const concurrencyLimit = 5;
    for (let i = 0; i < positions.length; i += concurrencyLimit) {
      const batch = positions.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(async (pos) => {
          const meta = await this.resolveEntryMeta(
            address,
            pos.tokenId,
            pos.marketId,
          );
          return { tokenId: pos.tokenId, meta };
        }),
      );

      for (const result of batchResults) {
        results.set(result.tokenId, result.meta);
      }
    }

    return results;
  }

  /**
   * Invalidate cache entry for a specific token.
   * Call this after a trade fill to ensure fresh data on next lookup.
   */
  invalidateCache(address: string, tokenId: string): void {
    const cacheKey = `${address.toLowerCase()}-${tokenId}`;
    this.cache.delete(cacheKey);
    this.fetchErrors.delete(cacheKey);
  }

  /**
   * Clear all cache entries.
   */
  clearCache(): void {
    this.cache.clear();
    this.fetchErrors.clear();
  }

  /**
   * Get cache statistics for monitoring.
   */
  getCacheStats(): { size: number; errorCount: number } {
    return {
      size: this.cache.size,
      errorCount: this.fetchErrors.size,
    };
  }
}
