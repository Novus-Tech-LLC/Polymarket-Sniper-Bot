import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";

export interface Position {
  marketId: string;
  tokenId: string;
  side: string; // Outcome name (e.g., "YES", "NO" for binary markets, or "Medjedovic", "Under" for multi-outcome markets)
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
  redeemable?: boolean; // True if market is resolved/closed
  marketEndTime?: number; // Market close time (Unix timestamp ms) - used for near-close hedging behavior
}

// Price display constants
const PRICE_TO_CENTS_MULTIPLIER = 100;

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

  // API timeout constant for external API calls
  private static readonly API_TIMEOUT_MS = 10000; // 10 seconds

  // Threshold for determining market winner from outcomePrices
  // Price > 0.5 indicates the likely winner in resolved markets
  private static readonly WINNER_THRESHOLD = 0.5;

  // Threshold for detecting resolved positions by price
  // Prices >= 0.99 (99¢) or <= 0.01 (1¢) indicate likely resolved markets
  // This helps detect redeemable positions even when API doesn't mark them as redeemable
  private static readonly RESOLVED_PRICE_HIGH_THRESHOLD = 0.99;
  private static readonly RESOLVED_PRICE_LOW_THRESHOLD = 0.01;

  constructor(config: PositionTrackerConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000; // 30 seconds default
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

    // Start initial refresh in background (non-blocking) to allow trading to start immediately
    // This prevents slow API calls from delaying the entire orchestrator startup
    this.refresh().catch((err) => {
      this.logger.error(
        "[PositionTracker] Initial refresh failed",
        err as Error,
      );
    });

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
    this.logger.info("[PositionTracker] Stopped position tracking");
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
   * Refresh positions from API
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
              const isRedeemable = apiPos.redeemable === true;

              if (isRedeemable) {
                // Market is resolved - fetch the actual market outcome to determine settlement price
                // Use marketId as cache key since all tokens in the same market share the same outcome
                // This avoids redundant Gamma API calls for multi-outcome markets
                let winningOutcome: string | null | undefined =
                  this.marketOutcomeCache.get(marketId);
                const wasCached = winningOutcome !== undefined;

                if (!wasCached) {
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
                }

                if (!winningOutcome) {
                  // Cannot determine outcome from Gamma API, but position is marked redeemable
                  // Use entry price as fallback - the redemption will succeed/fail on chain
                  // This ensures positions aren't silently dropped when outcome API is unavailable
                  currentPrice = entryPrice;
                  resolvedCount++;
                  if (!wasCached) {
                    this.logger.debug(
                      `[PositionTracker] Redeemable position with unknown outcome: tokenId=${tokenId}, side=${side}, using entryPrice=${entryPrice} as fallback`,
                    );
                  }
                } else {
                  // Calculate settlement price based on whether position won or lost
                  currentPrice = side === winningOutcome ? 1.0 : 0.0;
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
                try {
                  // Skip orderbook fetch if we know it's missing (cached)
                  if (this.missingOrderbooks.has(tokenId)) {
                    currentPrice = await this.fetchPriceFallback(tokenId);
                  } else {
                    try {
                      const orderbook = await this.client.getOrderBook(tokenId);

                      if (!orderbook.bids?.[0] || !orderbook.asks?.[0]) {
                        // Orderbook is empty - cache and use fallback
                        this.missingOrderbooks.add(tokenId);
                        this.logger.debug(
                          `[PositionTracker] Empty orderbook for tokenId: ${tokenId}, using fallback price API`,
                        );
                        currentPrice = await this.fetchPriceFallback(tokenId);
                      } else {
                        const bestBid = parseFloat(orderbook.bids[0].price);
                        const bestAsk = parseFloat(orderbook.asks[0].price);
                        currentPrice = (bestBid + bestAsk) / 2;
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
                (currentPrice >= PositionTracker.RESOLVED_PRICE_HIGH_THRESHOLD ||
                  currentPrice <= PositionTracker.RESOLVED_PRICE_LOW_THRESHOLD)
              ) {
                // Price suggests market is resolved - verify with Gamma API
                const winningOutcome = await this.fetchMarketOutcome(tokenId);
                if (winningOutcome !== null) {
                  // Market is confirmed resolved - mark as redeemable
                  finalRedeemable = true;
                  // Adjust current price to exact settlement price based on outcome
                  currentPrice = side === winningOutcome ? 1.0 : 0.0;
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

              // Fetch market end time for active positions (needed for near-close hedging)
              // Skip for redeemable positions since they're already resolved
              let marketEndTime: number | undefined;
              if (!isRedeemable) {
                marketEndTime = await this.fetchMarketEndTime(tokenId);
              }

              return {
                marketId,
                tokenId,
                side,
                size,
                entryPrice,
                currentPrice,
                pnlPct,
                pnlUsd,
                redeemable: isRedeemable,
                marketEndTime,
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
   * Load historical entry times from the Polymarket activity API.
   * This fetches the user's trade history and finds the earliest BUY timestamp
   * for each position, which represents when the position was acquired.
   *
   * This is critical for preventing mass sells on container restart - without
   * knowing when positions were actually bought, strategies might incorrectly
   * assume positions are "new" and trigger stop-loss or hedging immediately.
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
        `[PositionTracker] Loading historical entry times from activity API for ${walletAddress.slice(0, 10)}...`,
      );

      // Fetch user's activity/trade history
      interface ActivityItem {
        type: string;
        timestamp: number | string;
        conditionId: string; // Market ID
        asset: string; // Token ID
        side: string; // "BUY" or "SELL"
        size: number;
        price: number;
      }

      const activities = await httpGet<ActivityItem[]>(
        POLYMARKET_API.ACTIVITY_ENDPOINT(walletAddress),
        { timeout: PositionTracker.API_TIMEOUT_MS },
      );

      if (!activities || activities.length === 0) {
        this.logger.info("[PositionTracker] No historical activities found");
        this.historicalEntryTimesLoaded = true;
        return;
      }

      // Build a map of earliest BUY timestamp per token
      // Key: "marketId-tokenId", Value: earliest BUY timestamp in ms
      const earliestBuyTimes = new Map<string, number>();
      let buyCount = 0;

      for (const activity of activities) {
        // Only process BUY trades (these are when we acquired positions)
        if (
          activity.type !== "TRADE" ||
          activity.side?.toUpperCase() !== "BUY"
        ) {
          continue;
        }

        const marketId = activity.conditionId;
        const tokenId = activity.asset;

        if (!marketId || !tokenId) {
          continue;
        }

        const key = `${marketId}-${tokenId}`;

        // Handle timestamp - check if it's in seconds or milliseconds
        // Timestamps > 1e12 are already in milliseconds (year 2001+)
        // Timestamps < 1e12 are in seconds and need conversion
        let timestamp: number;
        if (typeof activity.timestamp === "number") {
          timestamp =
            activity.timestamp > 1e12
              ? activity.timestamp
              : activity.timestamp * 1000;
        } else {
          timestamp = new Date(activity.timestamp).getTime();
        }

        // Skip activities with invalid timestamps (e.g., unparseable -> NaN)
        // Storing NaN would cause downstream strategies to behave incorrectly
        if (!Number.isFinite(timestamp)) {
          continue;
        }

        // Keep the earliest (oldest) BUY timestamp
        const existing = earliestBuyTimes.get(key);
        if (!existing || timestamp < existing) {
          // Only count as new BUY trade when adding a new position to the map
          if (!existing) {
            buyCount++;
          }
          earliestBuyTimes.set(key, timestamp);
        }
      }

      // Populate positionEntryTimes with historical data
      for (const [key, timestamp] of earliestBuyTimes) {
        // Only set if we don't already have an entry time
        // (shouldn't happen on startup, but be safe)
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, timestamp);
        }
      }

      this.historicalEntryTimesLoaded = true;

      this.logger.info(
        `[PositionTracker] ✅ Loaded ${earliestBuyTimes.size} historical entry times from ${activities.length} activities (${buyCount} unique positions)`,
      );
    } catch (err) {
      // Log the error but don't fail - strategies will be conservative without historical data
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PositionTracker] ⚠️ Could not load historical entry times: ${errMsg}`,
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
}
