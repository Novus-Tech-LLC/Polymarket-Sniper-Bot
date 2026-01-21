import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";

export interface Position {
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
  redeemable?: boolean; // True if market is resolved/closed
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
  private refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;
  private isRefreshing: boolean = false; // Prevent concurrent refreshes
  private missingOrderbooks = new Set<string>(); // Cache tokenIds with no orderbook to avoid repeated API calls

  constructor(config: PositionTrackerConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000; // 30 seconds default
  }

  /**
   * Start tracking positions
   */
  async start(): Promise<void> {
    this.logger.info("[PositionTracker] Starting position tracking");
    await this.refresh();

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
    this.logger.info("[PositionTracker] Stopped position tracking");
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
      // Get current positions from Data API and enrich with current market prices
      this.logger.debug("[PositionTracker] Refreshing positions");

      // Fetch and process positions with current market data
      const positions = await this.fetchPositionsFromAPI();

      // Update positions map atomically
      const newPositions = new Map<string, Position>();
      const now = Date.now();

      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        newPositions.set(key, position);

        // Preserve entry time if position already existed
        if (!this.positionEntryTimes.has(key)) {
          this.positionEntryTimes.set(key, now);
        }
      }

      // Replace positions map atomically to avoid race conditions
      this.positions = newPositions;

      // Note: Positions that temporarily disappear are handled by keeping their
      // entry times in positionEntryTimes Map. This provides resilience against
      // temporary API glitches. Cleanup happens in strategies that use this tracker.

      this.logger.debug(
        `[PositionTracker] Refreshed ${positions.length} positions`,
      );
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
        { timeout: 10000 },
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

              // Skip orderbook fetch for resolved/closed markets (no orderbook available)
              let currentPrice: number;
              const isRedeemable = apiPos.redeemable === true;

              if (isRedeemable) {
                // Market is resolved - we cannot reliably determine the settlement price
                // without fetching the actual market resolution outcome.
                // Skipping this position as we cannot determine if it won (1.0) or lost (0.0).
                const reason = `Position is redeemable (market resolved) - cannot determine settlement price for tokenId: ${tokenId}`;
                skippedPositions.push({ reason, data: apiPos });
                this.logger.debug(`[PositionTracker] ${reason}`);
                return null;
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
              }

              // Calculate P&L
              const pnlUsd = (currentPrice - entryPrice) * size;
              const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

              // Try new API field first, then fall back to legacy field
              const sideValue = apiPos.outcome ?? apiPos.side;
              const side =
                sideValue?.toUpperCase() === "YES" ||
                sideValue?.toUpperCase() === "NO"
                  ? (sideValue.toUpperCase() as "YES" | "NO")
                  : "YES"; // Default to YES if unknown

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

      if (successCount > 0) {
        this.logger.info(
          `[PositionTracker] ✓ Successfully processed ${successCount}/${totalCount} positions`,
        );
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
   * Get entry time for a position (when it was first seen)
   */
  getPositionEntryTime(marketId: string, tokenId: string): number | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positionEntryTimes.get(key);
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
      this.logger.debug(
        `[PositionTracker] Fallback price for ${tokenId}: ${(midPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢ (buy: ${(buyPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢, sell: ${(sellPrice * PRICE_TO_CENTS_MULTIPLIER).toFixed(2)}¢)`,
      );
      return midPrice;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch fallback price for tokenId ${tokenId}: ${errMsg}`,
      );
    }
  }
}
