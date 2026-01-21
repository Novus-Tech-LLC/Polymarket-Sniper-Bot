import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";

export interface AutoSellConfig {
  enabled: boolean;
  threshold: number;  // Price threshold to auto-sell (e.g., 0.99 = 99¢)
  minHoldSeconds: number;  // Minimum time to hold before auto-selling (avoids conflict with endgame sweep)
}

export interface AutoSellStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: AutoSellConfig;
}

/**
 * Auto-Sell at High Price Strategy
 * Monitors owned positions approaching resolution
 * Automatically sells when price hits threshold (e.g., 99.6¢)
 * Only sells positions held longer than minHoldSeconds to avoid conflict with endgame sweep
 * Don't wait for 4pm UTC payout - free up capital immediately
 * Lose small amount per share but gain hours of capital availability
 */
export class AutoSellStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoSellConfig;
  private soldPositions: Set<string> = new Set();
  private positionFirstSeen: Map<string, number> = new Map();

  constructor(strategyConfig: AutoSellStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the auto-sell strategy
   * Returns number of positions sold
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up stale entries
    this.cleanupStaleEntries();

    let soldCount = 0;

    // Get positions near resolution (price >= threshold)
    const nearResolutionPositions = this.positionTracker.getPositionsNearResolution(
      this.config.threshold
    );

    for (const position of nearResolutionPositions) {
      const positionKey = `${position.marketId}-${position.tokenId}`;
      
      // Skip if already sold
      if (this.soldPositions.has(positionKey)) {
        continue;
      }

      // Track first seen time
      if (!this.positionFirstSeen.has(positionKey)) {
        this.positionFirstSeen.set(positionKey, Date.now());
        continue; // Don't sell on first detection
      }

      // Check minimum hold time (avoids conflict with endgame sweep)
      const holdTimeSeconds = (Date.now() - this.positionFirstSeen.get(positionKey)!) / 1000;
      if (holdTimeSeconds < this.config.minHoldSeconds) {
        this.logger.debug(
          `[AutoSell] Position ${position.marketId} held for ${holdTimeSeconds.toFixed(0)}s, waiting for ${this.config.minHoldSeconds}s`
        );
        continue;
      }

      this.logger.info(
        `[AutoSell] Selling position at ${(position.currentPrice * 100).toFixed(1)}¢ (held ${holdTimeSeconds.toFixed(0)}s): ${position.marketId}`
      );
      
      try {
        await this.sellPosition(position.marketId, position.tokenId, position.size);
        this.soldPositions.add(positionKey);
        soldCount++;
        
        // Log the trade-off
        const lossPerShare = 1.0 - position.currentPrice;
        const totalLoss = lossPerShare * position.size;
        this.logger.info(
          `[AutoSell] Freed up $${position.size.toFixed(2)} (loss: $${totalLoss.toFixed(2)})`
        );
      } catch (err) {
        this.logger.error(
          `[AutoSell] Failed to sell position ${position.marketId}`,
          err as Error
        );
      }
    }

    if (soldCount > 0) {
      this.logger.info(`[AutoSell] Sold ${soldCount} positions near resolution`);
    }

    return soldCount;
  }

  /**
   * Sell a position using postOrder utility
   * Executes market sell order at best bid for quick capital recovery
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number
  ): Promise<void> {
    try {
      // Import postOrder utility
      const { postOrder } = await import("../utils/post-order.util");
      
      // Get current orderbook to check liquidity and best bid
      const orderbook = await this.client.getOrderBook(tokenId);
      
      if (!orderbook.bids || orderbook.bids.length === 0) {
        throw new Error(`No bids available for token ${tokenId} - market may be closed or resolved`);
      }
      
      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestBidSize = parseFloat(orderbook.bids[0].size);
      
      this.logger.debug(
        `[AutoSell] Best bid: ${(bestBid * 100).toFixed(1)}¢ (size: ${bestBidSize.toFixed(2)})`
      );
      
      // Check liquidity
      const totalBidLiquidity = orderbook.bids
        .slice(0, 5) // Top 5 levels for auto-sell
        .reduce((sum, level) => sum + parseFloat(level.size), 0);
      
      if (totalBidLiquidity < size * 0.3) {
        this.logger.warn(
          `[AutoSell] Low liquidity: attempting to sell ${size.toFixed(2)} but only ${totalBidLiquidity.toFixed(2)} available`
        );
      }
      
      // Calculate sell value
      const sizeUsd = size * bestBid;
      
      // Validate minimum order size
      const minOrderUsd = 10;
      if (sizeUsd < minOrderUsd) {
        this.logger.warn(
          `[AutoSell] Position too small: $${sizeUsd.toFixed(2)} < $${minOrderUsd} minimum`
        );
        return;
      }
      
      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      
      // Calculate expected loss per share
      const lossPerShare = 1.0 - bestBid;
      const totalLoss = lossPerShare * size;
      
      this.logger.info(
        `[AutoSell] Executing sell: ${size.toFixed(2)} shares at ~${(bestBid * 100).toFixed(1)}¢ (loss: $${totalLoss.toFixed(2)})`
      );
      
      // Execute sell order - use aggressive pricing for fast fill
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: "YES", // Direction doesn't matter for sells
        side: "SELL",
        sizeUsd,
        maxAcceptablePrice: bestBid * 0.90, // Accept up to 10% slippage for urgent exit
        logger: this.logger,
        priority: false,
      });
      
      if (result.status === "submitted") {
        const freedCapital = size * bestBid;
        this.logger.info(
          `[AutoSell] ✓ Sold ${size.toFixed(2)} shares, freed $${freedCapital.toFixed(2)} capital`
        );
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[AutoSell] Sell order skipped: ${result.reason ?? "unknown reason"}`
        );
      } else {
        this.logger.error(
          `[AutoSell] Sell order failed: ${result.reason ?? "unknown reason"}`
        );
        throw new Error(`Sell order failed: ${result.reason ?? "unknown"}`);
      }
      
    } catch (err) {
      // Re-throw error for caller to handle
      this.logger.error(
        `[AutoSell] Failed to sell position: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  }

  /**
   * Clean up stale entries from tracking Maps/Sets
   * Removes entries for positions that no longer exist or were sold
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map(pos => `${pos.marketId}-${pos.tokenId}`)
    );
    
    // Clean up positionFirstSeen for positions that no longer exist
    let cleanedFirstSeen = 0;
    const firstSeenKeysToDelete: string[] = [];
    for (const key of this.positionFirstSeen.keys()) {
      if (!currentKeys.has(key)) {
        firstSeenKeysToDelete.push(key);
      }
    }
    for (const key of firstSeenKeysToDelete) {
      this.positionFirstSeen.delete(key);
      cleanedFirstSeen++;
    }
    
    // Clean up soldPositions that are no longer in current positions
    // (they've been fully removed/resolved)
    let cleanedSold = 0;
    const soldKeysToDelete: string[] = [];
    for (const key of this.soldPositions) {
      if (!currentKeys.has(key)) {
        soldKeysToDelete.push(key);
      }
    }
    for (const key of soldKeysToDelete) {
      this.soldPositions.delete(key);
      cleanedSold++;
    }
    
    if (cleanedFirstSeen > 0 || cleanedSold > 0) {
      this.logger.debug(
        `[AutoSell] Cleaned up ${cleanedFirstSeen} first-seen and ${cleanedSold} sold entries`
      );
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    soldCount: number;
    enabled: boolean;
    threshold: number;
  } {
    return {
      soldCount: this.soldPositions.size,
      enabled: this.config.enabled,
      threshold: this.config.threshold,
    };
  }

  /**
   * Reset sold positions tracking (for testing or daily reset)
   */
  reset(): void {
    this.soldPositions.clear();
    this.positionFirstSeen.clear();
  }
}
