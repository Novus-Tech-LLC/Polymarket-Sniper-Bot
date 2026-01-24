import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { EntryMetaResolver, type EntryMeta } from "./entry-meta-resolver";

/**
 * Position status indicating tradability
 */
export type PositionStatus =
  | "ACTIVE"
  | "REDEEMABLE"
  | "RESOLVED"
  | "DUST"
  | "NO_BOOK";

export interface Position {
  marketId: string;
  tokenId: string;
  side: string; // Outcome name (e.g., "YES", "NO" for binary markets, or "Medjedovic", "Under" for multi-outcome markets)
  size: number;
  entryPrice: number;
  currentPrice: number; // Mark price for P&L: uses BEST BID for active positions (what we can sell at)
  pnlPct: number;
  pnlUsd: number;
  redeemable?: boolean; // True if market is resolved/closed
  marketEndTime?: number; // Market close time (Unix timestamp ms) - used for near-close hedging behavior
  /**
   * Best bid price from CLOB orderbook (what we can sell at)
   * This is the CANONICAL mark price for active positions.
   * undefined if no orderbook available (NO_BOOK status)
   */
  currentBidPrice?: number;
  /**
   * Best ask price from CLOB orderbook (what we would pay to buy)
   * Used for cost basis calculations and spread analysis.
   * undefined if no orderbook available
   */
  currentAskPrice?: number;
  /**
   * Position status for strategy routing:
   * - ACTIVE: Can be traded, has valid orderbook
   * - NO_BOOK: Active market but no orderbook data available (use fallback pricing)
   * - REDEEMABLE/RESOLVED: Market resolved, route to AutoRedeem
   * - DUST: Position too small to trade profitably
   */
  status?: PositionStatus;
  /**
   * Age of the orderbook cache in milliseconds
   * Used for debugging stale data issues
   */
  cacheAgeMs?: number;

  // === ENTRY METADATA (from EntryMetaResolver) ===
  // These fields are derived from trade history API, NOT from container uptime.
  // See entry-meta-resolver.ts for details on why uptime-based tracking is wrong.

  /**
   * Weighted average entry price in cents (e.g., 65.5 for 65.5¢)
   * Computed from trade history using weighted average method.
   * undefined if entry metadata could not be resolved from trade history.
   */
  avgEntryPriceCents?: number;

  /**
   * Timestamp (ms) when the position was first acquired.
   * This is the timestamp of the oldest BUY that contributes to the current position.
   * Derived from trade history API - survives container restarts.
   * undefined if entry metadata could not be resolved from trade history.
   */
  firstAcquiredAt?: number;

  /**
   * Timestamp (ms) when the position was last increased (most recent BUY).
   * Derived from trade history API - survives container restarts.
   * undefined if entry metadata could not be resolved from trade history.
   */
  lastAcquiredAt?: number;

  /**
   * Time held in seconds, computed as now - firstAcquiredAt (or lastAcquiredAt if configured).
   * CRITICAL: This is derived from trade history timestamps, NOT from container uptime.
   * This value is stable across container restarts because it uses actual trade timestamps.
   * undefined if entry metadata could not be resolved from trade history.
   */
  timeHeldSec?: number;

  /**
   * Cache age of the entry metadata in milliseconds.
   * Used for debugging to prove the data is not stale.
   */
  entryMetaCacheAgeMs?: number;
}

// Price display constants
const PRICE_TO_CENTS_MULTIPLIER = 100;

// Default thresholds for liquidation candidate filtering
// Used by getLiquidationCandidates and getLiquidationCandidatesValue methods
export const DEFAULT_LIQUIDATION_MIN_LOSS_PCT = 10;
export const DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS = 60;

export interface PositionTrackerConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  refreshIntervalMs?: number;
}

/**
 * Tracks current positions and their P&L
 * Provides data to Quick Flip and Auto-Sell strategies
 */
export class PositionTracker {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positions: Map<string, Position> = new Map();
  private positionEntryTimes: Map<string, number> = new Map(); // Track when positions first appeared
  private positionLastSeen: Map<string, number> = new Map(); // Track when positions were last seen
  private refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;
  private isRefreshing: boolean = false; // Prevent concurrent refreshes
  private currentRefreshPromise: Promise<void> | null = null; // Awaitable refresh promise for single-flight
  private missingOrderbooks = new Set<string>(); // Cache tokenIds with no orderbook to avoid repeated API calls
  private loggedFallbackPrices = new Set<string>(); // Cache tokenIds for which we've already logged fallback price (suppress repeated logs)
  // Cache market outcomes persistently across refresh cycles. Resolved markets cannot change their outcome,
  // so caching is safe and prevents redundant Gamma API calls on every 30-second refresh.
  // Note: Only successful outcomes are cached; null values from transient errors are not cached.
  // Maximum cache size is enforced to prevent unbounded memory growth in long-running processes.
  private marketOutcomeCache: Map<string, string> = new Map();
  private static readonly MAX_OUTCOME_CACHE_SIZE = 1000; // Maximum number of cached market outcomes
  private lastRefreshStats: {
    resolved: number;
    active: number;
    skipped: number;
  } = { resolved: 0, active: 0, skipped: 0 }; // Track stats for summary logging

  // Flag to track whether historical entry times have been loaded from API
  // This prevents immediate sells on container restart by ensuring we know actual entry times
  private historicalEntryTimesLoaded: boolean = false;

  // Cache market end times (Unix timestamp ms). Market end times are fetched from Gamma API
  // and cached to avoid redundant API calls on every 30-second refresh cycle.
  // End times can change, so callers should be prepared to refetch or invalidate entries as needed.
  private marketEndTimeCache: Map<string, number> = new Map();
  private static readonly MAX_END_TIME_CACHE_SIZE = 1000;

  /**
   * Orderbook cache with TTL for accurate P&L calculation
   * Stores best bid/ask per tokenId with timestamp for staleness detection
   *
   * WHY PREVIOUS P&L SHOWED 0.0% AND ALL LOSING:
   * The old code used mid-price ((bestBid + bestAsk) / 2) for P&L calculations.
   * For sell-to-realize-profit scenarios, we MUST use the BEST BID - what we can actually sell at.
   * Using mid-price caused:
   * 1. Overestimation of position value when spread is wide
   * 2. 0.0% readings when mid-price happened to equal entry price
   * 3. All positions appearing as losing when bid was significantly below mid
   *
   * FIX: Now we use BEST BID as the mark price for active positions.
   */
  private orderbookCache: Map<
    string,
    {
      bestBid: number;
      bestAsk: number;
      fetchedAt: number; // Unix timestamp ms
    }
  > = new Map();
  private static readonly ORDERBOOK_CACHE_TTL_MS = 2000; // 2 seconds for active trading
  private static readonly POSITION_BALANCE_CACHE_TTL_MS = 5000; // 5 seconds for position balances
  private static readonly MAX_ORDERBOOK_CACHE_SIZE = 500;

  // API timeout constant for external API calls
  private static readonly API_TIMEOUT_MS = 10000; // 10 seconds

  // Pagination settings for loading historical trade data from wallet
  // PAGE_LIMIT: Maximum trades per API request (API max is 500)
  // MAX_PAGES: Safety limit to prevent infinite loops (500 * 20 = 10,000 trades max)
  private static readonly TRADES_PAGE_LIMIT = 500;
  private static readonly TRADES_MAX_PAGES = 20;

  // Threshold for determining market winner from outcomePrices
  // Price > 0.5 indicates the likely winner in resolved markets
  private static readonly WINNER_THRESHOLD = 0.5;

  // Threshold for detecting resolved positions by price
  // Prices >= 0.99 (99¢) or <= 0.01 (1¢) indicate likely resolved markets
  // This helps detect redeemable positions even when API doesn't mark them as redeemable
  private static readonly RESOLVED_PRICE_HIGH_THRESHOLD = 0.99;
  private static readonly RESOLVED_PRICE_LOW_THRESHOLD = 0.01;

  // P&L sanity check thresholds
  // Used to detect TOKEN_MISMATCH_OR_BOOK_FETCH_BUG:
  // If bid is near zero but market appears liquid (mid > threshold, spread < threshold)
  private static readonly SANITY_CHECK_BID_NEAR_ZERO = 0.001; // Bid below 0.1¢ considered "near zero"
  private static readonly SANITY_CHECK_MID_PRICE_MIN = 0.1; // Mid-price > 10¢ suggests active market
  private static readonly SANITY_CHECK_MAX_SPREAD = 0.2; // Spread < 20¢ suggests liquid market

  // Rate-limit P&L summary logging to avoid log spam (refreshes every 5s)
  private lastPnlSummaryLogAt = 0;
  private lastLoggedPnlCounts = { profitable: 0, losing: 0, redeemable: 0 };
  private static readonly PNL_SUMMARY_LOG_INTERVAL_MS = 60_000; // Log at most once per minute

  // EntryMetaResolver for stateless entry metadata from trade history
  // WHY THIS EXISTS: Container restarts used to reset the "time held" clock.
  // Now we derive entry timestamps from the trade history API, which survives restarts.
  private entryMetaResolver: EntryMetaResolver;

  constructor(config: PositionTrackerConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000; // 30 seconds default

    // Initialize EntryMetaResolver for stateless entry metadata computation
    this.entryMetaResolver = new EntryMetaResolver({
      logger: config.logger,
      cacheTtlMs: 90_000, // 90 second cache TTL
      apiTimeoutMs: 10_000,
      maxPagesPerToken: 10,
      tradesPerPage: 500,
      useLastAcquiredForTimeHeld: false, // Use firstAcquiredAt by default
    });
  }

  /**
   * Start tracking positions
   * On startup, fetches historical entry times from the activity API to prevent
   * mass sells on container restart. Without historical data, we don't know when
   * positions were actually acquired and might trigger stop-loss/hedging immediately.
   */
  async start(): Promise<void> {
    this.logger.info("[PositionTracker] Starting position tracking");

    // Fetch historical entry times from activity API on startup
    // This runs synchronously on startup to ensure we have entry times before strategies run
    // Note: loadHistoricalEntryTimes handles errors internally and does not throw
    await this.loadHistoricalEntryTimes();

    // Start initial refresh synchronously to ensure positions are available before strategies run
    // This is critical - without positions loaded, strategies can't identify what to sell/redeem
    try {
      await this.refresh();

      // Log positions without entry times (critical diagnostic)
      const positions = this.getPositions();
      const withoutEntryTime = positions.filter((p) => {
        const key = `${p.marketId}-${p.tokenId}`;
        return !this.positionEntryTimes.has(key);
      });

      if (withoutEntryTime.length > 0) {
        this.logger.warn(
          `[PositionTracker] ⚠️ ${withoutEntryTime.length} position(s) have NO entry time (external purchases?): ${withoutEntryTime.map((p) => `${p.tokenId.slice(0, 8)}...${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%`).join(", ")}`,
        );
        this.logger.info(
          `[PositionTracker] ℹ️ Positions without entry times will still be sold if profitable (entry time check bypassed for profitable positions)`,
        );
      }
    } catch (err) {
      this.logger.error(
        "[PositionTracker] Initial refresh failed",
        err as Error,
      );
    }

    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error("[PositionTracker] Refresh failed", err as Error);
      });
    }, this.refreshIntervalMs);
  }

  /**
   * Stop tracking positions
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    // Clear caches to release memory
    this.marketOutcomeCache.clear();
    this.missingOrderbooks.clear();
    this.loggedFallbackPrices.clear();
    this.orderbookCache.clear();
    this.logger.info("[PositionTracker] Stopped position tracking");
  }

  /**
   * Invalidate orderbook cache for a specific token
   * Call this after a trade fill to ensure fresh pricing on next lookup
   */
  invalidateOrderbookCache(tokenId: string): void {
    this.orderbookCache.delete(tokenId);
    this.logger.debug(
      `[PositionTracker] Invalidated orderbook cache for ${tokenId.slice(0, 16)}...`,
    );
  }

  /**
   * Invalidate all orderbook caches
   * Call this when a significant market event occurs
   */
  invalidateAllOrderbookCaches(): void {
    const count = this.orderbookCache.size;
    this.orderbookCache.clear();
    this.logger.debug(
      `[PositionTracker] Invalidated ${count} orderbook cache entries`,
    );
  }

  /**
   * Get statistics about the current refresh cycle
   */
  getStats(): {
    resolved: number;
    active: number;
    skipped: number;
    cachedMarkets: number;
  } {
    return {
      ...this.lastRefreshStats,
      cachedMarkets: this.marketOutcomeCache.size,
    };
  }

  /**
   * Await the current refresh if one is in progress, or trigger a new one.
   * This allows strategies to share a single refresh call rather than each
   * triggering their own (which would be blocked by isRefreshing anyway).
   *
   * SINGLE-FLIGHT GUARANTEE:
   * - If a refresh is in progress, returns the existing promise
   * - If no refresh is in progress, starts a new one and returns that promise
   * - All callers await the same promise, ensuring refresh runs exactly once
   */
  async awaitCurrentRefresh(): Promise<void> {
    // If a refresh is already in progress, await it
    if (this.currentRefreshPromise) {
      return this.currentRefreshPromise;
    }

    // Start a new refresh and track the promise
    this.currentRefreshPromise = this.refresh().finally(() => {
      // Clear the promise when done so next caller can start a fresh refresh
      this.currentRefreshPromise = null;
    });

    return this.currentRefreshPromise;
  }

  /**
   * Refresh positions from API
   *
   * SINGLE-FLIGHT: Only one refresh runs at a time.
   * If called while refresh is in progress, returns immediately.
   * Callers wanting to await the current refresh should use awaitCurrentRefresh().
   */
  async refresh(): Promise<void> {
    // Prevent concurrent refreshes (race condition protection)
    if (this.isRefreshing) {
      this.logger.debug(
        "[PositionTracker] Refresh already in progress, skipping",
      );
      return;
    }

    this.isRefreshing = true;

    try {
      // Note: We no longer clear marketOutcomeCache here to avoid redundant Gamma API calls
      // Resolved markets don't change their outcome, so caching is safe across refreshes

      // Get current positions from Data API and enrich with current market prices
      // Note: "Refreshing positions" log removed to reduce noise - the summary log provides refresh status

      // Fetch and process positions with current market data
      const positions = await this.fetchPositionsFromAPI();

      // Update positions map atomically
      const newPositions = new Map<string, Position>();
      const now = Date.now();

      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        newPositions.set(key, position);
        this.positionLastSeen.set(key, now);

        // Preserve entry time if position already existed (from historical data or previous refresh)
        // Only set to "now" for genuinely new positions (bought after startup)
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, now);
          this.logger.debug(
            `[PositionTracker] New position detected (no historical entry time): ${key.slice(0, 30)}...`,
          );
        }
      }

      // Replace positions map atomically to avoid race conditions
      this.positions = newPositions;

      // Clean up stale entry times for positions that have disappeared.
      // Use a grace window to avoid clearing on transient API glitches.
      const staleThresholdMs = this.refreshIntervalMs * 2;
      for (const [key, lastSeen] of this.positionLastSeen.entries()) {
        if (newPositions.has(key)) {
          continue;
        }
        if (now - lastSeen > staleThresholdMs) {
          this.positionLastSeen.delete(key);
          this.positionEntryTimes.delete(key);
        }
      }

      // Note: Positions that temporarily disappear are handled by keeping their
      // entry times in positionEntryTimes Map for a short grace window. This
      // provides resilience against temporary API glitches without treating
      // re-buys as long-held positions.
      // Note: Removed redundant "Refreshed X positions" log - the summary log in fetchPositionsFromAPI provides this info
    } catch (err) {
      this.logger.error(
        "[PositionTracker] Failed to refresh positions",
        err as Error,
      );
      // Don't throw - let the caller decide whether to retry
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get all current positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position by market and token ID
   */
  getPosition(marketId: string, tokenId: string): Position | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positions.get(key);
  }

  /**
   * Get position by token ID only (searches all positions)
   * Used to check if we already own a specific token before buying
   * NOTE: This does NOT block hedging - hedges use a different tokenId (opposite outcome)
   */
  getPositionByTokenId(tokenId: string): Position | undefined {
    for (const position of this.positions.values()) {
      if (position.tokenId === tokenId) {
        return position;
      }
    }
    return undefined;
  }

  /**
   * Get positions with P&L above threshold
   */
  getPositionsAboveTarget(targetPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct >= targetPct);
  }

  /**
   * Get positions below stop loss threshold
   */
  getPositionsBelowStopLoss(stopLossPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct <= -stopLossPct);
  }

  /**
   * Get positions near resolution (price > threshold)
   */
  getPositionsNearResolution(threshold: number): Position[] {
    return this.getPositions().filter((pos) => pos.currentPrice >= threshold);
  }

  /**
   * Get only active (non-redeemable) positions
   * Use this for strategies that can only trade on open markets (scalping, selling, etc.)
   */
  getActivePositions(): Position[] {
    return this.getPositions().filter((pos) => !pos.redeemable);
  }

  /**
   * Get active positions that are profitable (pnlPct > 0)
   * This is the source of truth for scalping candidates
   */
  getActiveProfitablePositions(): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlPct > 0);
  }

  /**
   * Get active positions that are losing (pnlPct < 0)
   * Use this for stop-loss or hedging strategies
   */
  getActiveLosingPositions(): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlPct < 0);
  }

  /**
   * Get active positions above a profit threshold
   * Use this for scalping with minimum profit requirements
   */
  getActivePositionsAboveTarget(targetPct: number): Position[] {
    return this.getActivePositions().filter((pos) => pos.pnlPct >= targetPct);
  }

  /**
   * Get positions that are candidates for liquidation when funds are insufficient.
   * Used by Smart Hedging to determine what positions to sell to free up funds
   * for hedging other positions.
   *
   * Returns active losing positions sorted by loss percentage (worst losses first),
   * filtered to only include positions with valid side info (required for selling).
   *
   * @param minLossPct - Minimum loss percentage to consider for liquidation (default: DEFAULT_LIQUIDATION_MIN_LOSS_PCT)
   * @param minHoldSeconds - Minimum hold time in seconds before a position can be liquidated (default: DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS)
   * @returns Array of positions suitable for liquidation, sorted by worst loss first
   */
  getLiquidationCandidates(
    minLossPct = DEFAULT_LIQUIDATION_MIN_LOSS_PCT,
    minHoldSeconds = DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS,
  ): Position[] {
    const now = Date.now();

    return (
      this.getActiveLosingPositions()
        .filter((pos) => {
          // Must have valid side info for selling
          if (!pos.side || pos.side.trim() === "") {
            return false;
          }

          // Must meet minimum loss threshold
          if (Math.abs(pos.pnlPct) < minLossPct) {
            return false;
          }

          // Must have been held for minimum time (prevent immediate sells on new positions)
          const entryTime = this.getPositionEntryTime(
            pos.marketId,
            pos.tokenId,
          );
          if (entryTime) {
            const holdSeconds = (now - entryTime) / 1000;
            if (holdSeconds < minHoldSeconds) {
              return false;
            }
          }
          // If no entry time, be conservative and include it (may be externally acquired)

          return true;
        })
        // Sort by worst loss first (most negative pnlPct)
        .sort((a, b) => a.pnlPct - b.pnlPct)
    );
  }

  /**
   * Get the total current value (in USD) of positions that could be liquidated.
   * This represents the approximate funds that could be recovered by liquidating
   * losing positions.
   *
   * @param minLossPct - Minimum loss percentage to consider for liquidation (default: DEFAULT_LIQUIDATION_MIN_LOSS_PCT)
   * @param minHoldSeconds - Minimum hold time before a position can be liquidated (default: DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS)
   * @returns Total USD value that could be recovered from liquidation candidates
   */
  getLiquidationCandidatesValue(
    minLossPct = DEFAULT_LIQUIDATION_MIN_LOSS_PCT,
    minHoldSeconds = DEFAULT_LIQUIDATION_MIN_HOLD_SECONDS,
  ): number {
    const candidates = this.getLiquidationCandidates(
      minLossPct,
      minHoldSeconds,
    );
    return candidates.reduce(
      (total, pos) => total + pos.size * pos.currentPrice,
      0,
    );
  }

  /**
   * Get a summary of position counts for logging
   * Provides consistent breakdown across all strategies
   */
  getPositionSummary(): {
    total: number;
    active: number;
    redeemable: number;
    activeProfitable: number;
    activeLosing: number;
    activeBreakeven: number;
  } {
    const positions = this.getPositions();
    const active = positions.filter((p) => !p.redeemable);
    const redeemable = positions.filter((p) => p.redeemable);
    const activeProfitable = active.filter((p) => p.pnlPct > 0);
    const activeLosing = active.filter((p) => p.pnlPct < 0);
    const activeBreakeven = active.filter((p) => p.pnlPct === 0);

    return {
      total: positions.length,
      active: active.length,
      redeemable: redeemable.length,
      activeProfitable: activeProfitable.length,
      activeLosing: activeLosing.length,
      activeBreakeven: activeBreakeven.length,
    };
  }

  /**
   * Fetch positions from Polymarket API
   * Fetches user positions from Data API and enriches with current prices
   */
  private async fetchPositionsFromAPI(): Promise<Position[]> {
    try {
      // Import required utilities
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");
      const { resolveSignerAddress } =
        await import("../utils/funds-allowance.util");

      // Get wallet address from client
      const walletAddress = resolveSignerAddress(this.client);

      // Fetch positions from Data API
      // Updated Jan 2025 to match the current Data API positions response format.
      // Supports both the new format (introduced in late 2024) and the legacy format for backward compatibility.
      interface ApiPosition {
        // New API format fields
        asset?: string; // Token/asset identifier (replaces token_id/asset_id)
        conditionId?: string; // Market identifier (replaces market/id)
        size?: string | number; // Position size
        avgPrice?: string | number; // Average entry price (replaces initial_average_price)
        outcome?: string; // "YES" or "NO" outcome
        redeemable?: boolean; // True if market is resolved/closed (no orderbook available)

        // Legacy fields for backwards compatibility
        id?: string;
        market?: string;
        asset_id?: string;
        token_id?: string;
        side?: string;
        initial_cost?: string | number;
        initial_average_price?: string | number;
      }

      const apiPositions = await httpGet<ApiPosition[]>(
        POLYMARKET_API.POSITIONS_ENDPOINT(walletAddress),
        { timeout: PositionTracker.API_TIMEOUT_MS },
      );

      if (!apiPositions || apiPositions.length === 0) {
        this.logger.debug("[PositionTracker] No positions found");
        return [];
      }

      this.logger.debug(
        `[PositionTracker] Fetched ${apiPositions.length} positions from API`,
      );

      // Enrich positions with current prices and calculate P&L
      const positions: Position[] = [];
      const skippedPositions: Array<{ reason: string; data: ApiPosition }> = [];
      const maxConcurrent = 5; // Rate limit concurrent orderbook fetches

      // Track stats for summary logging
      let resolvedCount = 0;
      let activeCount = 0;
      let newlyCachedMarkets = 0;

      for (let i = 0; i < apiPositions.length; i += maxConcurrent) {
        const batch = apiPositions.slice(i, i + maxConcurrent);
        const batchResults = await Promise.allSettled(
          batch.map(async (apiPos) => {
            try {
              // Try new API format first, then fall back to legacy format
              const tokenId =
                apiPos.asset ?? apiPos.token_id ?? apiPos.asset_id;
              const marketId = apiPos.conditionId ?? apiPos.market ?? apiPos.id;

              if (!tokenId || !marketId) {
                const reason = `Missing required fields - tokenId: ${tokenId || "MISSING"}, marketId: ${marketId || "MISSING"}`;
                skippedPositions.push({ reason, data: apiPos });
                this.logger.debug(`[PositionTracker] ${reason}`);
                return null;
              }

              const size =
                typeof apiPos.size === "string"
                  ? parseFloat(apiPos.size)
                  : (apiPos.size ?? 0);

              // Parse entry price from new or legacy API field
              const entryPrice = this.parseEntryPrice(apiPos);

              if (size <= 0 || entryPrice <= 0) {
                const reason = `Invalid size/price - size: ${size}, entryPrice: ${entryPrice}`;
                skippedPositions.push({ reason, data: apiPos });
                this.logger.debug(`[PositionTracker] ${reason}`);
                return null;
              }

              // Determine position side/outcome early (needed for both redeemable and active positions)
              const sideValue = apiPos.outcome ?? apiPos.side;

              if (
                !sideValue ||
                typeof sideValue !== "string" ||
                sideValue.trim() === ""
              ) {
                // Missing or invalid outcome - skip this position
                const reason = `Missing or invalid side/outcome value for tokenId ${tokenId}`;
                skippedPositions.push({ reason, data: apiPos });
                this.logger.warn(`[PositionTracker] ${reason}`);
                return null;
              }

              // Store the actual outcome value (supports both binary YES/NO and multi-outcome markets)
              const side: string = sideValue.trim();

              // Skip orderbook fetch for resolved/closed markets (no orderbook available)
              let currentPrice: number;
              let bestBidPrice: number | undefined;
              let bestAskPrice: number | undefined;
              let positionStatus: PositionStatus = "ACTIVE";
              let cacheAgeMs: number | undefined;
              const apiRedeemable = apiPos.redeemable === true;

              // GATED REDEEMABLE DETECTION: Don't blindly trust apiPos.redeemable
              // Verify with Gamma API that market is truly resolved/closed
              // This fixes the bug where active markets were incorrectly marked as redeemable
              let isRedeemable = false;
              let verifiedWinningOutcome: string | null = null;

              if (apiRedeemable) {
                // API claims position is redeemable - verify with Gamma
                const resolutionStatus =
                  await this.verifyMarketResolutionStatus(tokenId, marketId);

                if (resolutionStatus.isResolved) {
                  // Gamma confirms market is resolved - trust redeemable flag
                  isRedeemable = true;
                  verifiedWinningOutcome = resolutionStatus.winningOutcome;
                } else if (!resolutionStatus.hasOrderbook) {
                  // No orderbook exists and market might be in limbo state
                  // Keep as redeemable since there's no trading activity
                  isRedeemable = true;
                  this.logger.debug(
                    `[PositionTracker] apiPos.redeemable=true, Gamma not resolved, but no orderbook - treating as redeemable: tokenId=${tokenId.slice(0, 16)}...`,
                  );
                } else {
                  // IMPORTANT: API says redeemable but Gamma says NOT resolved AND orderbook EXISTS
                  // This is the bug case - keep as ACTIVE position
                  isRedeemable = false;
                  this.logger.warn(
                    `[PositionTracker] ⚠️ REDEEMABLE_OVERRIDE: apiPos.redeemable=true but market is STILL ACTIVE (orderbook exists, Gamma not resolved). ` +
                      `Keeping as ACTIVE position. tokenId=${tokenId.slice(0, 16)}..., marketId=${marketId.slice(0, 16)}...`,
                  );
                }
              }

              if (isRedeemable) {
                // Market is verified resolved - set status to REDEEMABLE
                positionStatus = "REDEEMABLE";

                // Use verified winning outcome or fetch from cache/API
                let winningOutcome: string | null | undefined =
                  verifiedWinningOutcome ??
                  this.marketOutcomeCache.get(marketId);
                const wasCached =
                  winningOutcome !== undefined && winningOutcome !== null;

                if (!wasCached && !verifiedWinningOutcome) {
                  winningOutcome = await this.fetchMarketOutcome(tokenId);
                  // Only cache definite outcomes; avoid caching null/undefined that may come from transient API errors
                  if (winningOutcome !== null && winningOutcome !== undefined) {
                    // Enforce maximum cache size to prevent unbounded memory growth
                    if (
                      this.marketOutcomeCache.size >=
                      PositionTracker.MAX_OUTCOME_CACHE_SIZE
                    ) {
                      // Remove oldest entry (first key in Map iteration order)
                      const firstKey = this.marketOutcomeCache
                        .keys()
                        .next().value;
                      if (firstKey) {
                        this.marketOutcomeCache.delete(firstKey);
                      }
                    }
                    this.marketOutcomeCache.set(marketId, winningOutcome);
                    newlyCachedMarkets++;
                  }
                } else if (
                  verifiedWinningOutcome &&
                  !this.marketOutcomeCache.has(marketId)
                ) {
                  // Cache the verified outcome from resolution check
                  if (
                    this.marketOutcomeCache.size <
                    PositionTracker.MAX_OUTCOME_CACHE_SIZE
                  ) {
                    this.marketOutcomeCache.set(
                      marketId,
                      verifiedWinningOutcome,
                    );
                    newlyCachedMarkets++;
                  }
                }

                if (!winningOutcome) {
                  // Cannot determine outcome from Gamma API, but position is marked redeemable
                  // Try to fetch actual price from orderbook or price API first
                  // This is important for profit calculation - don't default to entryPrice which makes pnlPct=0%
                  try {
                    // First try orderbook
                    if (!this.missingOrderbooks.has(tokenId)) {
                      try {
                        const orderbook =
                          await this.client.getOrderBook(tokenId);
                        if (orderbook.bids?.[0] && orderbook.asks?.[0]) {
                          const bestBid = parseFloat(orderbook.bids[0].price);
                          const bestAsk = parseFloat(orderbook.asks[0].price);
                          currentPrice = (bestBid + bestAsk) / 2;
                          this.logger.debug(
                            `[PositionTracker] Redeemable with unknown outcome: using orderbook price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                          );
                        } else {
                          // Empty orderbook, try price fallback
                          this.missingOrderbooks.add(tokenId);
                          currentPrice = await this.fetchPriceFallback(tokenId);
                          this.logger.debug(
                            `[PositionTracker] Redeemable with unknown outcome: using fallback price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                          );
                        }
                      } catch {
                        // Orderbook fetch failed, try price fallback
                        this.missingOrderbooks.add(tokenId);
                        currentPrice = await this.fetchPriceFallback(tokenId);
                        this.logger.debug(
                          `[PositionTracker] Redeemable with unknown outcome: using fallback price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                        );
                      }
                    } else {
                      // Already know orderbook is missing, use price fallback
                      currentPrice = await this.fetchPriceFallback(tokenId);
                      this.logger.debug(
                        `[PositionTracker] Redeemable with unknown outcome: using fallback price ${(currentPrice * 100).toFixed(1)}¢ for tokenId=${tokenId.slice(0, 16)}...`,
                      );
                    }
                  } catch (priceErr) {
                    // All pricing methods failed - use entryPrice as last resort
                    // This prevents silent position drops but may show 0% profit
                    currentPrice = entryPrice;
                    this.logger.warn(
                      `[PositionTracker] ⚠️ Redeemable with unknown outcome AND price fetch failed for tokenId=${tokenId.slice(0, 16)}..., using entryPrice=${entryPrice} (will show 0% profit)`,
                    );
                  }
                  resolvedCount++;
                } else {
                  // Calculate settlement price based on whether position won or lost
                  // Normalize both strings for comparison (case-insensitive, trimmed)
                  const normalizedSide = side.toLowerCase().trim();
                  const normalizedWinner = winningOutcome.toLowerCase().trim();
                  currentPrice =
                    normalizedSide === normalizedWinner ? 1.0 : 0.0;
                  resolvedCount++;

                  // Only log on first resolution (not cached) to reduce noise
                  if (!wasCached) {
                    this.logger.debug(
                      `[PositionTracker] Resolved position: tokenId=${tokenId}, side=${side}, winner=${winningOutcome}, settlementPrice=${currentPrice}`,
                    );
                  }
                }
              } else {
                // Active market - fetch current orderbook with fallback to price API
                // CRITICAL: Use BEST BID as mark price for P&L (what we can actually sell at)
                // This fixes the previous bug where mid-price caused 0.0% P&L readings

                try {
                  // Check TTL cache first
                  const cached = this.orderbookCache.get(tokenId);
                  const now = Date.now();

                  if (
                    cached &&
                    now - cached.fetchedAt <
                      PositionTracker.ORDERBOOK_CACHE_TTL_MS
                  ) {
                    // Use cached values
                    bestBidPrice = cached.bestBid;
                    bestAskPrice = cached.bestAsk;
                    cacheAgeMs = now - cached.fetchedAt;
                    currentPrice = bestBidPrice; // Use BEST BID as mark price
                  } else if (this.missingOrderbooks.has(tokenId)) {
                    // Skip orderbook fetch if we know it's missing (cached)
                    positionStatus = "NO_BOOK";
                    currentPrice = await this.fetchPriceFallback(tokenId);
                  } else {
                    try {
                      const orderbook = await this.client.getOrderBook(tokenId);

                      if (!orderbook.bids?.[0] || !orderbook.asks?.[0]) {
                        // Orderbook is empty - cache and use fallback
                        this.missingOrderbooks.add(tokenId);
                        positionStatus = "NO_BOOK";
                        this.logger.debug(
                          `[PositionTracker] Empty orderbook for tokenId: ${tokenId}, using fallback price API`,
                        );
                        currentPrice = await this.fetchPriceFallback(tokenId);
                      } else {
                        bestBidPrice = parseFloat(orderbook.bids[0].price);
                        bestAskPrice = parseFloat(orderbook.asks[0].price);

                        // CRITICAL FIX: Use BEST BID as mark price for P&L
                        // This is what we can actually sell at, not the mid-price
                        currentPrice = bestBidPrice;
                        cacheAgeMs = 0; // Fresh fetch

                        // Cache the orderbook data with proper eviction
                        // Remove entries until we're under the limit before adding new one
                        while (
                          this.orderbookCache.size >=
                          PositionTracker.MAX_ORDERBOOK_CACHE_SIZE
                        ) {
                          // Remove oldest entry (first key in Map iteration order - FIFO)
                          const firstKey = this.orderbookCache
                            .keys()
                            .next().value;
                          if (firstKey) {
                            this.orderbookCache.delete(firstKey);
                          } else {
                            break; // Safety: exit if no keys found
                          }
                        }
                        this.orderbookCache.set(tokenId, {
                          bestBid: bestBidPrice,
                          bestAsk: bestAskPrice,
                          fetchedAt: Date.now(),
                        });

                        // P&L SANITY CHECK: Validate computed price against UI-like expectations
                        // If computed bid is near 0 but market looks liquid, flag potential mismatch
                        const spread = bestAskPrice - bestBidPrice;
                        const midPrice = (bestBidPrice + bestAskPrice) / 2;
                        if (
                          bestBidPrice <
                            PositionTracker.SANITY_CHECK_BID_NEAR_ZERO &&
                          midPrice >
                            PositionTracker.SANITY_CHECK_MID_PRICE_MIN &&
                          spread < PositionTracker.SANITY_CHECK_MAX_SPREAD
                        ) {
                          // Bid near zero but market appears liquid - likely a bug
                          this.logger.error(
                            `[PositionTracker] ⚠️ TOKEN_MISMATCH_OR_BOOK_FETCH_BUG: tokenId=${tokenId.slice(0, 16)}..., ` +
                              `bid=${(bestBidPrice * 100).toFixed(2)}¢, ask=${(bestAskPrice * 100).toFixed(2)}¢, ` +
                              `mid=${(midPrice * 100).toFixed(2)}¢, spread=${(spread * 100).toFixed(2)}¢ - ` +
                              `Book appears liquid but bid near zero`,
                          );
                          // Log first 3 levels for debugging
                          this.logger.debug(
                            `[PositionTracker] Book levels for ${tokenId.slice(0, 16)}...: ` +
                              `bids=[${orderbook.bids
                                .slice(0, 3)
                                .map((b) => `${b.price}@${b.size}`)
                                .join(", ")}], ` +
                              `asks=[${orderbook.asks
                                .slice(0, 3)
                                .map((a) => `${a.price}@${a.size}`)
                                .join(", ")}]`,
                          );
                        }
                      }
                    } catch (orderbookErr) {
                      const orderbookErrMsg =
                        orderbookErr instanceof Error
                          ? orderbookErr.message
                          : String(orderbookErr);
                      if (
                        orderbookErrMsg.includes("404") ||
                        orderbookErrMsg.includes("not found") ||
                        orderbookErrMsg.includes("No orderbook exists")
                      ) {
                        // 404 or not found - cache and use fallback
                        this.missingOrderbooks.add(tokenId);
                        positionStatus = "NO_BOOK";
                        this.logger.debug(
                          `[PositionTracker] Orderbook not found for tokenId: ${tokenId}, using fallback price API`,
                        );
                        currentPrice = await this.fetchPriceFallback(tokenId);
                      } else {
                        // Other error - rethrow
                        throw orderbookErr;
                      }
                    }
                  }
                } catch (err) {
                  // If all pricing methods fail, skip this position
                  const errMsg =
                    err instanceof Error ? err.message : String(err);
                  const reason = `Failed to fetch price data: ${errMsg}`;
                  skippedPositions.push({ reason, data: apiPos });
                  this.logger.debug(`[PositionTracker] ${reason}`);
                  return null;
                }
                // Increment activeCount only after successful pricing
                activeCount++;
              }

              // FALLBACK REDEMPTION DETECTION: Check if position appears resolved based on price
              // This handles cases where the API doesn't mark positions as redeemable but the market has actually resolved
              // Positions at 99¢+ or 1¢- are likely resolved markets that should be redeemable
              let finalRedeemable = isRedeemable;
              if (
                !isRedeemable &&
                (currentPrice >=
                  PositionTracker.RESOLVED_PRICE_HIGH_THRESHOLD ||
                  currentPrice <= PositionTracker.RESOLVED_PRICE_LOW_THRESHOLD)
              ) {
                // Price suggests market is resolved - verify with Gamma API
                const winningOutcome = await this.fetchMarketOutcome(tokenId);
                if (winningOutcome !== null) {
                  // Market is confirmed resolved - mark as redeemable
                  finalRedeemable = true;
                  // Adjust current price to exact settlement price based on outcome
                  // Normalize both strings for comparison (case-insensitive, trimmed)
                  const normalizedSide = side.toLowerCase().trim();
                  const normalizedWinner = winningOutcome.toLowerCase().trim();
                  currentPrice =
                    normalizedSide === normalizedWinner ? 1.0 : 0.0;
                  resolvedCount++;
                  activeCount--; // Was counted as active, now resolved
                  this.logger.info(
                    `[PositionTracker] Detected resolved position via price fallback: tokenId=${tokenId}, side=${side}, winner=${winningOutcome}, price=${currentPrice === 1.0 ? "100¢ (WIN)" : "0¢ (LOSS)"}`,
                  );
                  // Cache the outcome for future refreshes
                  if (
                    this.marketOutcomeCache.size <
                    PositionTracker.MAX_OUTCOME_CACHE_SIZE
                  ) {
                    this.marketOutcomeCache.set(marketId, winningOutcome);
                  }
                }
              }

              // Calculate P&L
              const pnlUsd = (currentPrice - entryPrice) * size;
              const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

              // Debug log for positions that should be profitable but show 0% or less
              // This helps diagnose when pricing is wrong
              if (currentPrice > entryPrice && pnlPct <= 0) {
                this.logger.warn(
                  `[PositionTracker] ⚠️ P&L calculation anomaly: tokenId=${tokenId.slice(0, 16)}..., entry=${entryPrice}, current=${currentPrice}, pnlPct=${pnlPct.toFixed(2)}%`,
                );
              }

              // Log significant profits at DEBUG level for monitoring
              if (pnlPct >= 10 && !finalRedeemable) {
                this.logger.debug(
                  `[PositionTracker] 💰 High profit position: ${side} entry=${(entryPrice * 100).toFixed(1)}¢ → current=${(currentPrice * 100).toFixed(1)}¢ = +${pnlPct.toFixed(1)}% ($${pnlUsd.toFixed(2)})`,
                );
              }

              // Fetch market end time for active positions (needed for near-close hedging)
              // Skip for redeemable positions since they're already resolved
              let marketEndTime: number | undefined;
              if (!finalRedeemable) {
                marketEndTime = await this.fetchMarketEndTime(tokenId);
              }

              // Determine final position status
              const finalStatus: PositionStatus = finalRedeemable
                ? "REDEEMABLE"
                : positionStatus;

              return {
                marketId,
                tokenId,
                side,
                size,
                entryPrice,
                currentPrice,
                pnlPct,
                pnlUsd,
                redeemable: finalRedeemable,
                marketEndTime,
                currentBidPrice: bestBidPrice,
                currentAskPrice: bestAskPrice,
                status: finalStatus,
                cacheAgeMs,
              };
            } catch (err) {
              const reason = `Failed to enrich position: ${err instanceof Error ? err.message : String(err)}`;
              skippedPositions.push({ reason, data: apiPos });
              this.logger.debug(`[PositionTracker] ${reason}`);
              return null;
            }
          }),
        );

        // Collect successful results
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value) {
            positions.push(result.value);
          }
        }

        // Small delay between batches to avoid rate limiting
        if (i + maxConcurrent < apiPositions.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Log comprehensive summary of position processing
      const successCount = positions.length;
      const skippedCount = skippedPositions.length;
      const totalCount = apiPositions.length;

      // Store stats for external access
      this.lastRefreshStats = {
        resolved: resolvedCount,
        active: activeCount,
        skipped: skippedCount,
      };

      if (successCount > 0) {
        // Only log detailed breakdown if there are new market lookups or if it's the first time
        if (newlyCachedMarkets > 0) {
          this.logger.info(
            `[PositionTracker] ✓ Processed ${successCount}/${totalCount} positions (${resolvedCount} resolved, ${activeCount} active, ${newlyCachedMarkets} new market lookups)`,
          );
        } else {
          // Quieter log for steady-state operation (all markets already cached)
          this.logger.debug(
            `[PositionTracker] ✓ Processed ${successCount} positions (${resolvedCount} resolved, ${activeCount} active) - all outcomes cached`,
          );
        }

        // P&L summary logging with rate-limiting to avoid log spam
        // Sort by P&L% descending to show most profitable first
        const sortedByPnl = [...positions].sort((a, b) => b.pnlPct - a.pnlPct);
        const redeemablePositions = sortedByPnl.filter((p) => p.redeemable);
        // Active positions = non-redeemable (can be traded/scalped)
        const activePositions = sortedByPnl.filter((p) => !p.redeemable);
        const activeProfitable = activePositions.filter((p) => p.pnlPct > 0);
        const activeLosing = activePositions.filter((p) => p.pnlPct < 0);

        // Rate-limit: log at most once per minute or when counts change
        const now = Date.now();
        const countsChanged =
          this.lastLoggedPnlCounts.profitable !== activeProfitable.length ||
          this.lastLoggedPnlCounts.losing !== activeLosing.length ||
          this.lastLoggedPnlCounts.redeemable !== redeemablePositions.length;
        const shouldLogPnlSummary =
          countsChanged ||
          now - this.lastPnlSummaryLogAt >=
            PositionTracker.PNL_SUMMARY_LOG_INTERVAL_MS;

        if (shouldLogPnlSummary) {
          this.lastPnlSummaryLogAt = now;
          this.lastLoggedPnlCounts = {
            profitable: activeProfitable.length,
            losing: activeLosing.length,
            redeemable: redeemablePositions.length,
          };

          // Log summary showing ACTIVE positions breakdown (what scalping/selling strategies care about)
          // This should now match what ScalpTakeProfit reports
          this.logger.info(
            `[PositionTracker] 📊 P&L Summary: ACTIVE: ${activeProfitable.length} profitable, ${activeLosing.length} losing | REDEEMABLE: ${redeemablePositions.length}`,
          );

          // Log active profitable positions at DEBUG level (scalping candidates)
          if (activeProfitable.length > 0) {
            const profitSummary = activeProfitable
              .slice(0, 10) // Top 10 profitable
              .map(
                (p) =>
                  `${p.tokenId.slice(0, 8)}...+${p.pnlPct.toFixed(1)}%/$${p.pnlUsd.toFixed(2)}`,
              )
              .join(", ");
            this.logger.debug(
              `[PositionTracker] 💰 Active Profitable (${activeProfitable.length}): ${profitSummary}${activeProfitable.length > 10 ? "..." : ""}`,
            );
          }

          // Log redeemable positions at INFO level (critical for redemption)
          if (redeemablePositions.length > 0) {
            const redeemSummary = redeemablePositions
              .slice(0, 5)
              .map(
                (p) =>
                  `${p.tokenId.slice(0, 8)}...(${p.currentPrice > 0 ? "WIN" : "LOSS"})`,
              )
              .join(", ");
            this.logger.info(
              `[PositionTracker] 🎯 Redeemable (${redeemablePositions.length}): ${redeemSummary}${redeemablePositions.length > 5 ? "..." : ""}`,
            );
          }
        }
      }

      if (skippedCount > 0) {
        this.logger.warn(
          `[PositionTracker] ⚠ Skipped ${skippedCount}/${totalCount} positions`,
        );

        // Group skipped positions by reason for better diagnostics
        const reasonGroups = new Map<string, number>();
        for (const { reason } of skippedPositions) {
          const count = reasonGroups.get(reason) || 0;
          reasonGroups.set(reason, count + 1);
        }

        const breakdownLines = [
          "[PositionTracker] Skipped position breakdown:",
        ];
        for (const [reason, count] of reasonGroups.entries()) {
          breakdownLines.push(`[PositionTracker]   - ${count}x: ${reason}`);
        }
        this.logger.warn(breakdownLines.join("\n"));

        // Log first few skipped positions for debugging
        const sampleSize = Math.min(3, skippedCount);
        this.logger.warn(
          `[PositionTracker] Sample of skipped positions (first ${sampleSize}):`,
        );
        for (let i = 0; i < sampleSize; i++) {
          const { reason, data } = skippedPositions[i];
          this.logger.warn(`[PositionTracker]   [${i + 1}] ${reason}`);
          this.logger.warn(
            `[PositionTracker]       Data: ${JSON.stringify(data)}`,
          );
        }
      }

      return positions;
    } catch (err) {
      this.logger.error(
        `[PositionTracker] Failed to fetch positions from API: ${err instanceof Error ? err.message : String(err)}`,
        err as Error,
      );

      // Return empty array on error - caller handles retry logic
      return [];
    }
  }

  /**
   * Parse entry price from API response, supporting both new and legacy formats
   */
  private parseEntryPrice(apiPos: {
    avgPrice?: string | number;
    initial_average_price?: string | number;
  }): number {
    // Try new API field first
    if (apiPos.avgPrice !== undefined) {
      return typeof apiPos.avgPrice === "string"
        ? parseFloat(apiPos.avgPrice)
        : apiPos.avgPrice;
    }

    // Fall back to legacy field
    if (apiPos.initial_average_price !== undefined) {
      return typeof apiPos.initial_average_price === "string"
        ? parseFloat(apiPos.initial_average_price)
        : apiPos.initial_average_price;
    }

    return 0;
  }

  /**
   * Fetch market resolution/outcome data from Gamma API using the tokenId.
   * Returns the winning outcome (e.g., "YES", "NO", "Medjedovic", "Under") or null if the outcome
   * cannot be determined (e.g. market unresolved, API/network error, or malformed response).
   *
   * Supports both binary markets (YES/NO) and multi-outcome markets.
   *
   * Uses the `clob_token_ids` query parameter to find the market, then parses
   * the `outcomePrices` array to determine which outcome won (price = 1 or ~1).
   */
  private async fetchMarketOutcome(tokenId: string): Promise<string | null> {
    // Validate tokenId input
    if (!tokenId || typeof tokenId !== "string" || tokenId.trim() === "") {
      this.logger.debug(
        `[PositionTracker] Invalid tokenId provided to fetchMarketOutcome: ${tokenId}`,
      );
      return null;
    }

    try {
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      // Fetch market details from Gamma API using clob_token_ids query
      // This correctly finds the market containing this token
      interface GammaMarketResponse {
        outcomes?: string; // JSON string like '["Yes", "No"]' or '["Medjedovic", "Minaur"]'
        outcomePrices?: string; // JSON string like '["0", "1"]' where 1 = winner
        tokens?: Array<{
          outcome?: string;
          winner?: boolean;
        }>;
        resolvedOutcome?: string;
        resolved_outcome?: string;
        winningOutcome?: string;
        winning_outcome?: string;
        closed?: boolean;
        resolved?: boolean;
      }

      // Encode tokenId for URL safety
      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

      this.logger.debug(
        `[PositionTracker] Fetching market outcome from ${url}`,
      );

      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        this.logger.debug(
          `[PositionTracker] No market data returned for tokenId ${tokenId}`,
        );
        return null;
      }

      const market = markets[0];

      // Primary method: Parse outcomePrices to find winner
      // The winning outcome has price = "1" or very close to 1 (e.g., "0.9999...")
      if (market.outcomes && market.outcomePrices) {
        try {
          const outcomes: string[] = JSON.parse(market.outcomes);
          const prices: string[] = JSON.parse(market.outcomePrices);

          if (outcomes.length > 0 && outcomes.length === prices.length) {
            // Find the index with price closest to 1 (winner)
            let winnerIndex = -1;
            let highestPrice = 0;

            for (let i = 0; i < prices.length; i++) {
              const price = parseFloat(prices[i]);
              if (Number.isFinite(price) && price > highestPrice) {
                highestPrice = price;
                winnerIndex = i;
              }
            }

            // Only consider it a winner if price is significantly above threshold
            if (
              winnerIndex >= 0 &&
              highestPrice > PositionTracker.WINNER_THRESHOLD
            ) {
              const winner = outcomes[winnerIndex].trim();
              this.logger.debug(
                `[PositionTracker] Resolved market for tokenId ${tokenId}: winner="${winner}" (price=${highestPrice.toFixed(4)})`,
              );
              return winner;
            }

            this.logger.debug(
              `[PositionTracker] Market for tokenId ${tokenId} has no clear winner (highestPrice=${highestPrice.toFixed(4)})`,
            );
          }
        } catch (parseErr) {
          this.logger.debug(
            `[PositionTracker] Failed to parse outcomes/prices for tokenId ${tokenId}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          );
        }
      }

      // Fallback: Check for explicit winning outcome field
      const winningOutcome =
        market.resolvedOutcome ??
        market.resolved_outcome ??
        market.winningOutcome ??
        market.winning_outcome;

      if (winningOutcome && typeof winningOutcome === "string") {
        const trimmed = winningOutcome.trim();
        if (trimmed) {
          this.logger.debug(
            `[PositionTracker] Market for tokenId ${tokenId} resolved with explicit outcome: ${trimmed}`,
          );
          return trimmed;
        }
      }

      // Fallback: Check tokens for winner flag (supports multi-outcome markets)
      if (market.tokens && Array.isArray(market.tokens)) {
        for (const token of market.tokens) {
          if (token.winner === true && token.outcome) {
            const trimmed = token.outcome.trim();
            if (trimmed) {
              this.logger.debug(
                `[PositionTracker] Market for tokenId ${tokenId} resolved with winning token: ${trimmed}`,
              );
              return trimmed;
            }
          }
        }
      }

      // If market is closed/resolved but no winner info, cannot determine
      if (market.closed || market.resolved) {
        this.logger.debug(
          `[PositionTracker] Market for tokenId ${tokenId} is closed/resolved but winning outcome not available`,
        );
      }

      return null;
    } catch (err: unknown) {
      const anyErr = err as any;
      const message = err instanceof Error ? err.message : String(err);
      const status: number | undefined =
        typeof anyErr?.status === "number"
          ? anyErr.status
          : typeof anyErr?.statusCode === "number"
            ? anyErr.statusCode
            : typeof anyErr?.response?.status === "number"
              ? anyErr.response.status
              : undefined;
      const code: string | undefined =
        typeof anyErr?.code === "string" ? anyErr.code : undefined;

      if (status === 404) {
        this.logger.warn(
          `[PositionTracker] Market not found (404) for tokenId ${tokenId}: ${message}`,
        );
      } else if (status !== undefined && status >= 400 && status < 500) {
        this.logger.warn(
          `[PositionTracker] Client error (${status}) fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      } else if (status !== undefined && status >= 500) {
        this.logger.error(
          `[PositionTracker] Server error (${status}) fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      } else if (
        code === "ETIMEDOUT" ||
        code === "ECONNREFUSED" ||
        code === "ECONNRESET"
      ) {
        this.logger.error(
          `[PositionTracker] Network error (${code}) fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      } else {
        this.logger.error(
          `[PositionTracker] Unexpected error fetching market outcome for tokenId ${tokenId}: ${message}`,
        );
      }

      // Log raw error at debug level for troubleshooting (limited depth to avoid performance issues)
      if (anyErr && typeof anyErr === "object") {
        const errorSummary = {
          message: anyErr.message || message,
          code: anyErr.code,
          status: anyErr.status || anyErr.statusCode || anyErr.response?.status,
          name: anyErr.name,
        };
        this.logger.debug(
          `[PositionTracker] Raw error while fetching market outcome for tokenId ${tokenId}: ${JSON.stringify(errorSummary)}`,
        );
      } else {
        this.logger.debug(
          `[PositionTracker] Raw error while fetching market outcome for tokenId ${tokenId}: ${String(anyErr)}`,
        );
      }

      return null;
    }
  }

  /**
   * Check if a market is truly resolved via Gamma API.
   * Returns an object with:
   * - isResolved: true if Gamma confirms market is closed or resolved
   * - hasOrderbook: true if orderbook exists with valid bids/asks
   * - winningOutcome: the winning outcome if available
   *
   * This is used to gate redeemable detection - we only trust apiPos.redeemable === true
   * if Gamma confirms the market is resolved/closed OR no orderbook exists.
   */
  private async verifyMarketResolutionStatus(
    tokenId: string,
    marketId: string,
  ): Promise<{
    isResolved: boolean;
    hasOrderbook: boolean;
    winningOutcome: string | null;
  }> {
    // Default result - assume not resolved and no orderbook
    const result = {
      isResolved: false,
      hasOrderbook: false,
      winningOutcome: null as string | null,
    };

    try {
      // Check if orderbook exists (indicates active market)
      if (!this.missingOrderbooks.has(tokenId)) {
        try {
          const orderbook = await this.client.getOrderBook(tokenId);
          if (orderbook.bids?.[0] && orderbook.asks?.[0]) {
            result.hasOrderbook = true;
          }
        } catch (orderbookErr) {
          const errMsg =
            orderbookErr instanceof Error
              ? orderbookErr.message
              : String(orderbookErr);
          // 404 or not found means no orderbook
          if (
            !errMsg.includes("404") &&
            !errMsg.includes("not found") &&
            !errMsg.includes("No orderbook exists")
          ) {
            // Log unexpected errors at debug level
            this.logger.debug(
              `[PositionTracker] verifyMarketResolutionStatus: Unexpected orderbook error for tokenId=${tokenId}: ${errMsg}`,
            );
          }
        }
      }

      // Check if market outcome is cached
      const cachedOutcome = this.marketOutcomeCache.get(marketId);
      if (cachedOutcome !== undefined) {
        result.winningOutcome = cachedOutcome;
        result.isResolved = true;
        return result;
      }

      // Fetch market details from Gamma API to check resolved/closed flags
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      interface GammaMarketResponse {
        outcomes?: string;
        outcomePrices?: string;
        tokens?: Array<{
          outcome?: string;
          winner?: boolean;
        }>;
        resolvedOutcome?: string;
        resolved_outcome?: string;
        winningOutcome?: string;
        winning_outcome?: string;
        closed?: boolean;
        resolved?: boolean;
      }

      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        return result;
      }

      const market = markets[0];

      // Check explicit closed/resolved flags from Gamma
      if (market.closed === true || market.resolved === true) {
        result.isResolved = true;
      }

      // Try to determine winning outcome
      // Method 1: Parse outcomePrices
      if (market.outcomes && market.outcomePrices) {
        try {
          const outcomes: string[] = JSON.parse(market.outcomes);
          const prices: string[] = JSON.parse(market.outcomePrices);

          if (outcomes.length > 0 && outcomes.length === prices.length) {
            let winnerIndex = -1;
            let highestPrice = 0;

            for (let i = 0; i < prices.length; i++) {
              const price = parseFloat(prices[i]);
              if (Number.isFinite(price) && price > highestPrice) {
                highestPrice = price;
                winnerIndex = i;
              }
            }

            if (
              winnerIndex >= 0 &&
              highestPrice > PositionTracker.WINNER_THRESHOLD
            ) {
              result.winningOutcome = outcomes[winnerIndex].trim();
              result.isResolved = true;
            }
          }
        } catch (_parseErr) {
          // Parse error, continue to other methods
          // Don't log here as this is an expected case for malformed API data
        }
      }

      // Method 2: Check explicit winning outcome fields
      if (!result.winningOutcome) {
        const winningOutcome =
          market.resolvedOutcome ??
          market.resolved_outcome ??
          market.winningOutcome ??
          market.winning_outcome;

        if (winningOutcome && typeof winningOutcome === "string") {
          const trimmed = winningOutcome.trim();
          if (trimmed) {
            result.winningOutcome = trimmed;
            result.isResolved = true;
          }
        }
      }

      // Method 3: Check tokens for winner flag
      if (
        !result.winningOutcome &&
        market.tokens &&
        Array.isArray(market.tokens)
      ) {
        for (const token of market.tokens) {
          if (token.winner === true && token.outcome) {
            const trimmed = token.outcome.trim();
            if (trimmed) {
              result.winningOutcome = trimmed;
              result.isResolved = true;
              break;
            }
          }
        }
      }

      return result;
    } catch (err) {
      this.logger.debug(
        `[PositionTracker] verifyMarketResolutionStatus: Error for tokenId=${tokenId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }
  }

  /**
   * Fetch market end time from Gamma API
   * Returns Unix timestamp in milliseconds, or undefined if not available
   * Uses cache to avoid redundant API calls
   */
  private async fetchMarketEndTime(
    tokenId: string,
  ): Promise<number | undefined> {
    // Check cache first
    const cached = this.marketEndTimeCache.get(tokenId);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      interface GammaMarketResponse {
        end_date?: string;
        end_time?: string;
        endDate?: string;
        endTime?: string;
      }

      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;

      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: PositionTracker.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        return undefined;
      }

      const market = markets[0];
      const endDateStr =
        market.end_date ?? market.end_time ?? market.endDate ?? market.endTime;

      if (!endDateStr) {
        return undefined;
      }

      // Parse the date string to Unix timestamp (milliseconds)
      const endTime = new Date(endDateStr).getTime();
      if (!Number.isFinite(endTime) || endTime <= 0) {
        return undefined;
      }

      // Cache the result (enforce max size)
      if (
        this.marketEndTimeCache.size >= PositionTracker.MAX_END_TIME_CACHE_SIZE
      ) {
        const firstKey = this.marketEndTimeCache.keys().next().value;
        if (firstKey) {
          this.marketEndTimeCache.delete(firstKey);
        }
      }
      this.marketEndTimeCache.set(tokenId, endTime);

      return endTime;
    } catch (err) {
      this.logger.debug(
        `[PositionTracker] Failed to fetch market end time for tokenId ${tokenId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Get entry time for a position (when it was first seen)
   */
  getPositionEntryTime(marketId: string, tokenId: string): number | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positionEntryTimes.get(key);
  }

  /**
   * Check if historical entry times have been loaded from the API.
   * Strategies should check this before triggering sells on startup.
   */
  hasLoadedHistoricalEntryTimes(): boolean {
    return this.historicalEntryTimesLoaded;
  }

  /**
   * Load historical entry times from the Polymarket trades API.
   * This fetches the user's BUY trade history from their wallet and finds the earliest
   * BUY timestamp for each position, which represents when the position was acquired.
   *
   * This is critical for preventing mass sells on container restart - without
   * knowing when positions were actually bought, strategies might incorrectly
   * assume positions are "new" and trigger stop-loss or hedging immediately.
   *
   * IMPORTANT: This method paginates through the user's BUY trade history up to a
   * configured safety cap (TRADES_MAX_PAGES, currently ~20 pages / ~10k trades)
   * to find the earliest purchase date for each position. Without pagination, only
   * the most recent trades would be fetched, causing older positions to use container
   * start time (or first-seen time) instead of actual purchase date.
   *
   * If the safety cap is hit before the wallet's full history is exhausted, very old
   * positions whose BUY trades fall before the earliest fetched page may not have an
   * accurate historical entry time and will fall back to the tracker's default behavior
   * (treating them as newly seen). A warning is logged when this occurs.
   *
   * Uses the /trades endpoint with side=BUY filter, which directly queries
   * your wallet's purchase history on the blockchain up to the configured cap.
   */
  private async loadHistoricalEntryTimes(): Promise<void> {
    try {
      const { resolveSignerAddress } =
        await import("../utils/funds-allowance.util");
      const walletAddress = resolveSignerAddress(this.client);

      // Validate wallet address - must be a valid Ethereum address (0x + 40 hex chars)
      // resolveSignerAddress can return "unknown" if wallet is not available
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
      if (!isValidAddress) {
        this.logger.warn(
          `[PositionTracker] ⚠️ Invalid wallet address "${walletAddress}" - cannot load historical entry times`,
        );
        // Don't set historicalEntryTimesLoaded = true, strategies will be conservative
        return;
      }

      this.logger.info(
        `[PositionTracker] Loading purchase history from wallet ${walletAddress.slice(0, 10)}...`,
      );

      // Fetch user's BUY trades directly from the trades API
      // This queries the wallet's trade history on the blockchain
      interface TradeItem {
        timestamp: number; // Unix timestamp in seconds
        conditionId: string; // Market ID
        asset: string; // Token ID
        side: string; // "BUY" or "SELL"
        size: number;
        price: number;
      }

      // Build a map of earliest BUY timestamp per token
      // Key: "marketId-tokenId", Value: earliest BUY timestamp in ms
      const earliestBuyTimes = new Map<string, number>();
      let totalTrades = 0;
      let offset = 0;
      let pageCount = 0;

      // Paginate through all BUY trades from the wallet
      while (pageCount < PositionTracker.TRADES_MAX_PAGES) {
        pageCount++;

        // Build URL with side=BUY filter and pagination
        // TRADES_ENDPOINT already includes ?user=, so we use & for additional params
        const tradesUrl = `${POLYMARKET_API.TRADES_ENDPOINT(walletAddress)}&side=BUY&limit=${PositionTracker.TRADES_PAGE_LIMIT}&offset=${offset}`;

        const trades = await httpGet<TradeItem[]>(tradesUrl, {
          timeout: PositionTracker.API_TIMEOUT_MS,
        });

        // Stop if no more trades
        if (!trades || trades.length === 0) {
          break;
        }

        totalTrades += trades.length;

        // Process each trade in this page
        for (const trade of trades) {
          const marketId = trade.conditionId;
          const tokenId = trade.asset;

          if (!marketId || !tokenId) {
            continue;
          }

          const key = `${marketId}-${tokenId}`;

          // Convert timestamp from seconds to milliseconds
          // The trades API returns Unix timestamp in seconds
          const timestamp = trade.timestamp * 1000;

          // Skip trades with invalid timestamps
          if (!Number.isFinite(timestamp) || timestamp <= 0) {
            continue;
          }

          // Keep the earliest (oldest) BUY timestamp for each position
          // This represents when you first purchased this position
          const existing = earliestBuyTimes.get(key);
          if (!existing || timestamp < existing) {
            earliestBuyTimes.set(key, timestamp);
          }
        }

        // If we got fewer results than requested, we've reached the end
        if (trades.length < PositionTracker.TRADES_PAGE_LIMIT) {
          break;
        }

        // Move to next page
        offset += PositionTracker.TRADES_PAGE_LIMIT;
      }

      // Warn if we hit the max pages limit (may have truncated history)
      if (
        pageCount >= PositionTracker.TRADES_MAX_PAGES &&
        totalTrades > 0 &&
        totalTrades % PositionTracker.TRADES_PAGE_LIMIT === 0
      ) {
        this.logger.warn(
          `[PositionTracker] ⚠️ Hit max pages limit (${PositionTracker.TRADES_MAX_PAGES} pages / ${totalTrades} trades). ` +
            `Very old positions may not have accurate entry times. Consider increasing TRADES_MAX_PAGES if needed.`,
        );
      }

      if (totalTrades === 0) {
        this.logger.info(
          "[PositionTracker] No purchase history found in wallet",
        );
        this.historicalEntryTimesLoaded = true;
        return;
      }

      // Populate positionEntryTimes with historical data from wallet
      for (const [key, timestamp] of earliestBuyTimes) {
        // Only set if we don't already have an entry time
        // (shouldn't happen on startup, but be safe)
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, timestamp);
        }
      }

      this.historicalEntryTimesLoaded = true;

      // Log summary with detailed info for debugging
      this.logger.info(
        `[PositionTracker] ✅ Loaded ${earliestBuyTimes.size} position purchase dates from ${totalTrades} wallet trades (${pageCount} page(s))`,
      );

      // Log entry time range for debugging
      if (earliestBuyTimes.size > 0) {
        const entries = Array.from(earliestBuyTimes.entries());
        const sorted = entries.sort((a, b) => a[1] - b[1]);
        const oldest = sorted[0];
        const newest = sorted[sorted.length - 1];
        const oldestAge = Math.round((Date.now() - oldest[1]) / (60 * 1000));
        const newestAge = Math.round((Date.now() - newest[1]) / (60 * 1000));
        this.logger.info(
          `[PositionTracker] 📅 Purchase dates range: oldest ${oldestAge}min ago, newest ${newestAge}min ago`,
        );
      }
    } catch (err) {
      // Log the error but don't fail - strategies will be conservative without historical data
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PositionTracker] ⚠️ Could not load purchase history from wallet: ${errMsg}`,
      );
      // Do not set historicalEntryTimesLoaded = true on error - strategies should remain conservative
      // Do not re-throw: callers should treat missing historical data as non-fatal
    }
  }

  /**
   * Fetch price from CLOB API /price endpoint as fallback when orderbook is unavailable
   * Uses mid-price between BUY and SELL sides
   */
  private async fetchPriceFallback(tokenId: string): Promise<number> {
    try {
      // Properly encode tokenId for URL safety
      const encodedTokenId = encodeURIComponent(tokenId);

      // Fetch both BUY and SELL prices to calculate mid-price
      const [buyPriceData, sellPriceData] = await Promise.all([
        httpGet<{ price: string }>(
          `${POLYMARKET_API.BASE_URL}/price?token_id=${encodedTokenId}&side=BUY`,
          { timeout: 5000 },
        ),
        httpGet<{ price: string }>(
          `${POLYMARKET_API.BASE_URL}/price?token_id=${encodedTokenId}&side=SELL`,
          { timeout: 5000 },
        ),
      ]);

      const buyPrice = parseFloat(buyPriceData.price);
      const sellPrice = parseFloat(sellPriceData.price);

      // Validate prices are finite and non-negative
      if (
        !Number.isFinite(buyPrice) ||
        !Number.isFinite(sellPrice) ||
        buyPrice < 0 ||
        sellPrice < 0
      ) {
        throw new Error(
          `Invalid price data from fallback API: buy=${buyPrice}, sell=${sellPrice}`,
        );
      }

      // Return mid-price as best estimate of current value
      const midPrice = (buyPrice + sellPrice) / 2;

      // Only log fallback price on first fetch for this token (suppress repetitive logs)
      if (!this.loggedFallbackPrices.has(tokenId)) {
        this.loggedFallbackPrices.add(tokenId);
        this.logger.debug(
          `[PositionTracker] Fallback price for ${tokenId}: ${(midPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢ (buy: ${(buyPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢, sell: ${(sellPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢)`,
        );
      }
      return midPrice;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch fallback price for tokenId ${tokenId}: ${errMsg}`,
      );
    }
  }

  /**
   * Enrich ACTIVE positions with entry metadata from trade history.
   *
   * WHY THIS EXISTS:
   * ScalpTakeProfit previously calculated "time held" based on container uptime.
   * After container restarts, the clock reset and the scalper missed valid
   * take-profit opportunities on positions already in the green.
   *
   * This method derives entry metadata (cost basis, timestamps) from the
   * Polymarket trade history API - data that survives container restarts.
   *
   * WHAT IT PROVIDES:
   * - avgEntryPriceCents: Weighted average entry price from trade history
   * - firstAcquiredAt: Timestamp of first BUY that contributes to position
   * - lastAcquiredAt: Timestamp of most recent BUY that increased position
   * - timeHeldSec: now - firstAcquiredAt (stable across restarts!)
   *
   * TOKENID-BASED:
   * All calculations use tokenId as primary key. This works for any binary
   * outcome type (YES/NO, Over/Under, TeamA/TeamB, etc.).
   *
   * @returns Array of ACTIVE positions with entry metadata fields populated
   */
  async enrichPositionsWithEntryMeta(): Promise<Position[]> {
    const { resolveSignerAddress } =
      await import("../utils/funds-allowance.util");
    const walletAddress = resolveSignerAddress(this.client);

    // Validate wallet address
    const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    if (!isValidAddress) {
      this.logger.warn(
        `[PositionTracker] Cannot enrich positions - invalid wallet address: ${walletAddress}`,
      );
      return this.getActivePositions();
    }

    // Get only ACTIVE positions (exclude redeemable/resolved)
    const activePositions = this.getActivePositions();

    if (activePositions.length === 0) {
      return [];
    }

    // Build list of positions to resolve
    const positionsToResolve = activePositions.map((p) => ({
      tokenId: p.tokenId,
      marketId: p.marketId,
    }));

    // Resolve entry metadata for all positions in batch
    const entryMetaMap = await this.entryMetaResolver.resolveEntryMetaBatch(
      walletAddress,
      positionsToResolve,
    );

    // Enrich positions with entry metadata
    const enrichedPositions: Position[] = [];
    let enrichedCount = 0;
    let skippedCount = 0;

    for (const position of activePositions) {
      const entryMeta = entryMetaMap.get(position.tokenId);

      if (entryMeta) {
        enrichedPositions.push({
          ...position,
          avgEntryPriceCents: entryMeta.avgEntryPriceCents,
          firstAcquiredAt: entryMeta.firstAcquiredAt,
          lastAcquiredAt: entryMeta.lastAcquiredAt,
          timeHeldSec: entryMeta.timeHeldSec,
          entryMetaCacheAgeMs: entryMeta.cacheAgeMs,
        });
        enrichedCount++;
      } else {
        // Entry metadata could not be resolved - include position without enrichment
        // This can happen if trade history is unavailable or incomplete
        enrichedPositions.push(position);
        skippedCount++;
      }
    }

    if (enrichedCount > 0 || skippedCount > 0) {
      this.logger.debug(
        `[PositionTracker] Enriched ${enrichedCount} positions with entry metadata, ${skippedCount} skipped (no trade history)`,
      );
    }

    return enrichedPositions;
  }

  /**
   * Get the EntryMetaResolver instance for direct access (e.g., for cache invalidation).
   */
  getEntryMetaResolver(): EntryMetaResolver {
    return this.entryMetaResolver;
  }

  /**
   * Invalidate entry metadata cache for a specific token.
   * Call this after a trade fill to ensure fresh entry data on next lookup.
   */
  async invalidateEntryMetaCache(tokenId: string): Promise<void> {
    const { resolveSignerAddress } =
      await import("../utils/funds-allowance.util");
    const walletAddress = resolveSignerAddress(this.client);
    this.entryMetaResolver.invalidateCache(walletAddress, tokenId);
  }
}
