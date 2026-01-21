import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";

export interface Position {
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
}

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
      this.logger.debug("[PositionTracker] Refresh already in progress, skipping");
      return;
    }

    this.isRefreshing = true;

    try {
      // Get current positions from Data API and enrich with current market prices
      this.logger.debug("[PositionTracker] Refreshing positions");
      
      // Fetch and process positions with current market data
      const positions = await this.fetchPositionsFromAPI();
      
      // Track which positions existed before this refresh
      const previousKeys = new Set(this.positions.keys());
      
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
        `[PositionTracker] Refreshed ${positions.length} positions`
      );
    } catch (err) {
      this.logger.error(
        "[PositionTracker] Failed to refresh positions",
        err as Error
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
      const { POLYMARKET_API } = await import("../constants/polymarket.constants");
      const { resolveSignerAddress } = await import("../utils/funds-allowance.util");
      
      // Get wallet address from client
      const walletAddress = resolveSignerAddress(this.client);
      
      // Fetch positions from Data API
      interface ApiPosition {
        id?: string;
        market?: string;
        asset_id?: string;
        token_id?: string;
        side?: string;
        size?: string | number;
        initial_cost?: string | number;
        initial_average_price?: string | number;
      }
      
      const apiPositions = await httpGet<ApiPosition[]>(
        POLYMARKET_API.POSITIONS_ENDPOINT(walletAddress),
        { timeout: 10000 }
      );
      
      if (!apiPositions || apiPositions.length === 0) {
        this.logger.debug("[PositionTracker] No positions found");
        return [];
      }
      
      this.logger.debug(
        `[PositionTracker] Fetched ${apiPositions.length} positions from API`
      );
      
      // Enrich positions with current prices and calculate P&L
      const positions: Position[] = [];
      const maxConcurrent = 5; // Rate limit concurrent orderbook fetches
      
      for (let i = 0; i < apiPositions.length; i += maxConcurrent) {
        const batch = apiPositions.slice(i, i + maxConcurrent);
        const batchResults = await Promise.allSettled(
          batch.map(async (apiPos) => {
            try {
              const tokenId = apiPos.token_id ?? apiPos.asset_id;
              const marketId = apiPos.market ?? apiPos.id;
              
              if (!tokenId || !marketId) {
                this.logger.debug("[PositionTracker] Skipping position with missing tokenId or marketId");
                return null;
              }
              
              const size = typeof apiPos.size === "string" ? parseFloat(apiPos.size) : (apiPos.size ?? 0);
              const entryPrice = typeof apiPos.initial_average_price === "string" 
                ? parseFloat(apiPos.initial_average_price) 
                : (apiPos.initial_average_price ?? 0);
              
              if (size <= 0 || entryPrice <= 0) {
                return null;
              }
              
              // Get current orderbook to calculate mid-market price
              const orderbook = await this.client.getOrderBook(tokenId);
              
              if (!orderbook.bids?.[0] || !orderbook.asks?.[0]) {
                this.logger.debug(`[PositionTracker] No orderbook data for ${tokenId}`);
                return null;
              }
              
              const bestBid = parseFloat(orderbook.bids[0].price);
              const bestAsk = parseFloat(orderbook.asks[0].price);
              const currentPrice = (bestBid + bestAsk) / 2;
              
              // Calculate P&L
              const pnlUsd = (currentPrice - entryPrice) * size;
              const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
              
              const side = apiPos.side?.toUpperCase() === "YES" || apiPos.side?.toUpperCase() === "NO" 
                ? (apiPos.side.toUpperCase() as "YES" | "NO")
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
              };
            } catch (err) {
              this.logger.debug(
                `[PositionTracker] Failed to enrich position: ${err instanceof Error ? err.message : String(err)}`
              );
              return null;
            }
          })
        );
        
        // Collect successful results
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value) {
            positions.push(result.value);
          }
        }
        
        // Small delay between batches to avoid rate limiting
        if (i + maxConcurrent < apiPositions.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      this.logger.debug(
        `[PositionTracker] Successfully enriched ${positions.length}/${apiPositions.length} positions`
      );
      
      return positions;
    } catch (err) {
      this.logger.error(
        `[PositionTracker] Failed to fetch positions from API: ${err instanceof Error ? err.message : String(err)}`,
        err as Error
      );
      
      // Return empty array on error - caller handles retry logic
      return [];
    }
  }

  /**
   * Get entry time for a position (when it was first seen)
   */
  getPositionEntryTime(marketId: string, tokenId: string): number | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positionEntryTimes.get(key);
  }
}
