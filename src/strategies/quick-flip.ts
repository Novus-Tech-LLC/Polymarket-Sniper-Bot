import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";
import { calculateNetProfit } from "./constants";

export interface QuickFlipConfig {
  enabled: boolean;
  targetPct: number; // Sell at this gain percentage (e.g., 5 = 5%)
  stopLossPct: number; // Sell at this loss percentage (e.g., 3 = -3%)
  minHoldSeconds: number; // Minimum time to hold position before selling
}

export interface QuickFlipStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: QuickFlipConfig;
}

/**
 * Quick Flip Strategy
 * Monitors owned positions for price gains and sells when target is reached
 * Also implements stop-loss to limit downside
 * Recycles capital faster than waiting for resolution
 */
export class QuickFlipStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: QuickFlipConfig;
  private positionEntryTimes: Map<string, number> = new Map();

  constructor(strategyConfig: QuickFlipStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the quick flip strategy
   * Returns number of positions sold
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up entry times for positions that no longer exist
    this.cleanupStaleEntries();

    let soldCount = 0;

    // Check for positions that hit target gain
    const targetPositions = this.positionTracker.getPositionsAboveTarget(
      this.config.targetPct,
    );

    for (const position of targetPositions) {
      if (this.shouldSell(position.marketId, position.tokenId)) {
        const netProfitPct = calculateNetProfit(position.pnlPct);
        this.logger.info(
          `[QuickFlip] 📈 Selling position at +${position.pnlPct.toFixed(2)}% gross (+${netProfitPct.toFixed(2)}% net after fees): ${position.marketId}`,
        );

        try {
          await this.sellPosition(
            position.marketId,
            position.tokenId,
            position.size,
            false, // Not a stop-loss
          );
          soldCount++;
        } catch (err) {
          this.logger.error(
            `[QuickFlip] ❌ Failed to sell position ${position.marketId}`,
            err as Error,
          );
        }
      }
    }

    // Check for positions that hit stop loss
    const stopLossPositions = this.positionTracker.getPositionsBelowStopLoss(
      this.config.stopLossPct,
    );

    for (const position of stopLossPositions) {
      if (this.shouldSell(position.marketId, position.tokenId)) {
        const netLossPct = position.pnlPct - 0.2; // Include 0.2% fees in loss calculation
        this.logger.warn(
          `[QuickFlip] 🔻 Stop-loss triggered at ${position.pnlPct.toFixed(2)}% gross (${netLossPct.toFixed(2)}% net with fees): ${position.marketId}`,
        );

        try {
          await this.sellPosition(
            position.marketId,
            position.tokenId,
            position.size,
            true, // Stop-loss - bypass minimum check
          );
          soldCount++;
        } catch (err) {
          this.logger.error(
            `[QuickFlip] ❌ Failed to execute stop-loss for ${position.marketId}`,
            err as Error,
          );
        }
      }
    }

    if (soldCount > 0) {
      this.logger.info(`[QuickFlip] ✅ Sold ${soldCount} positions`);
    }

    return soldCount;
  }

  /**
   * Check if position should be sold based on hold time
   * Records entry time on first detection, checks hold time on subsequent calls
   */
  private shouldSell(marketId: string, tokenId: string): boolean {
    const key = `${marketId}-${tokenId}`;

    // Check if we already have an entry time tracked
    let entryTime = this.positionEntryTimes.get(key);

    if (!entryTime) {
      // Record current time as entry time (first time seeing this position)
      entryTime = Date.now();
      this.positionEntryTimes.set(key, entryTime);
      return false; // Don't sell on first detection
    }

    const holdTimeSeconds = (Date.now() - entryTime) / 1000;
    return holdTimeSeconds >= this.config.minHoldSeconds;
  }

  /**
   * Sell a position using postOrder utility
   * Executes market sell order at best bid price
   * @param marketId - The market ID
   * @param tokenId - The token ID to sell
   * @param size - Number of shares to sell
   * @param isStopLoss - If true, bypasses minimum order size check to ensure stop-loss can execute.
   *                     Defaults to false for regular profit-taking sells which respect the minimum.
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number,
    isStopLoss: boolean = false,
  ): Promise<void> {
    try {
      // Import postOrder utility
      const { postOrder } = await import("../utils/post-order.util");

      // Get current orderbook to check liquidity and best bid
      const orderbook = await this.client.getOrderBook(tokenId);

      if (!orderbook.bids || orderbook.bids.length === 0) {
        throw new Error(`No bids available for token ${tokenId} - cannot sell`);
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestBidSize = parseFloat(orderbook.bids[0].size);

      this.logger.debug(
        `[QuickFlip] Best bid: ${(bestBid * 100).toFixed(1)}¢ (size: ${bestBidSize.toFixed(2)})`,
      );

      // Check if there's sufficient liquidity
      const totalBidLiquidity = orderbook.bids
        .slice(0, 3) // Top 3 levels
        .reduce((sum, level) => sum + parseFloat(level.size), 0);

      if (totalBidLiquidity < size * 0.5) {
        this.logger.warn(
          `[QuickFlip] ⚠️ Low liquidity warning: attempting to sell ${size.toFixed(2)} but only ${totalBidLiquidity.toFixed(2)} available in top 3 levels`,
        );
      }

      // Calculate sell value (size * best bid price)
      const sizeUsd = size * bestBid;

      // Validate minimum order size for regular sells only
      // Stop-loss sells bypass this check to prevent being stuck in losing positions
      const minOrderUsd = 10; // From DEFAULT_CONFIG
      if (!isStopLoss && sizeUsd < minOrderUsd) {
        this.logger.warn(
          `[QuickFlip] ⚠️ Position too small to sell: $${sizeUsd.toFixed(2)} < $${minOrderUsd} minimum`,
        );
        return;
      }

      // Extract wallet if available (for compatibility with postOrder)
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      this.logger.info(
        `[QuickFlip] 🔄 Executing sell: ${size.toFixed(2)} shares at ~${(bestBid * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)})`,
      );

      // Execute sell order using postOrder utility
      // For stop-loss orders, set minOrderUsd=0 to bypass order-submission layer checks
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: "YES", // Direction doesn't matter for sells, we're selling tokens we own
        side: "SELL",
        sizeUsd, // Size in USD terms
        maxAcceptablePrice: bestBid * 0.95, // Accept up to 5% slippage
        logger: this.logger,
        priority: false, // Not a frontrun trade
        orderConfig: isStopLoss ? { minOrderUsd: 0 } : undefined,
      });

      if (result.status === "submitted") {
        this.logger.info(
          `[QuickFlip] ✅ Sold ${size.toFixed(2)} shares at ~${(bestBid * 100).toFixed(1)}¢`,
        );
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[QuickFlip] ⏭️ Sell order skipped: ${result.reason ?? "unknown reason"}`,
        );
      } else {
        this.logger.error(
          `[QuickFlip] ❌ Sell order failed: ${result.reason ?? "unknown reason"}`,
        );
        throw new Error(`Sell order failed: ${result.reason ?? "unknown"}`);
      }
    } catch (err) {
      // Re-throw error for caller to handle
      this.logger.error(
        `[QuickFlip] ❌ Failed to sell position: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      // Always remove from entry times after attempt (success or failure)
      const key = `${marketId}-${tokenId}`;
      this.positionEntryTimes.delete(key);
    }
  }

  /**
   * Clean up entry times for positions that no longer exist
   * Prevents memory leak from tracking sold/closed positions
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );

    let cleanedCount = 0;
    const keysToDelete: string[] = [];
    for (const key of this.positionEntryTimes.keys()) {
      if (!currentKeys.has(key)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.positionEntryTimes.delete(key);
      cleanedCount++;
    }

    if (cleanedCount > 0) {
      this.logger.debug(
        `[QuickFlip] Cleaned up ${cleanedCount} stale position entries`,
      );
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    trackedPositions: number;
    enabled: boolean;
    targetPct: number;
    stopLossPct: number;
  } {
    return {
      trackedPositions: this.positionEntryTimes.size,
      enabled: this.config.enabled,
      targetPct: this.config.targetPct,
      stopLossPct: this.config.stopLossPct,
    };
  }
}
