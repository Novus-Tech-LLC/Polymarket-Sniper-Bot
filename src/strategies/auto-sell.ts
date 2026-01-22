import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";

export interface AutoSellConfig {
  enabled: boolean;
  threshold: number; // Price threshold to auto-sell (e.g., 0.99 = 99¢)
  minHoldSeconds: number; // Minimum time to hold before auto-selling (avoids conflict with endgame sweep)
  minOrderUsd: number; // Minimum order size in USD (from MIN_ORDER_USD env)
  /**
   * DISPUTE WINDOW EXIT SETTINGS
   * Positions near resolution ($0.99+) can get stuck in a 2-hour dispute window
   * Better to sell at 99.9¢ and free up capital than wait 2 hours for settlement
   * 
   * When enabled, the strategy will:
   * 1. Look for positions at 99.9¢ or higher (dispute hold price)
   * 2. Sell immediately to exit without waiting for settlement
   * 3. This allows recycling capital faster instead of waiting for dispute resolution
   */
  disputeWindowExitEnabled?: boolean; // Enable early exit for positions in dispute window
  disputeWindowExitPrice?: number; // Price to sell at for dispute exit (default: 0.999 = 99.9¢)
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
  // Track tokens with no liquidity to suppress repeated warnings
  private noLiquidityTokens: Set<string> = new Set();

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

    // === DISPUTE WINDOW EXIT (99.9¢) ===
    // Check for positions that can be sold at 99.9¢ to exit dispute hold
    // This takes priority over normal auto-sell since it frees capital immediately
    if (this.config.disputeWindowExitEnabled) {
      const disputeExitPrice = this.config.disputeWindowExitPrice ?? 0.999;
      const disputeExitPositions =
        this.positionTracker.getPositionsNearResolution(disputeExitPrice);

      for (const position of disputeExitPositions) {
        const positionKey = `${position.marketId}-${position.tokenId}`;

        // Skip if already sold
        if (this.soldPositions.has(positionKey)) {
          continue;
        }

        // For dispute exit, we don't need minimum hold time - we want to exit ASAP
        // getPositionsNearResolution already filters for currentPrice >= disputeExitPrice
        this.logger.info(
          `[AutoSell] 🚨 DISPUTE EXIT: Position at ${(position.currentPrice * 100).toFixed(1)}¢ - selling to exit dispute hold: ${position.marketId}`,
        );

        try {
          const sold = await this.sellPosition(
            position.marketId,
            position.tokenId,
            position.size,
          );

          if (sold) {
            this.soldPositions.add(positionKey);
            soldCount++;

            // Calculate tiny loss for exiting at 99.9¢ vs waiting for $1.00
            const lossPerShare = 1.0 - position.currentPrice;
            const totalLoss = lossPerShare * position.size;

            this.logger.info(
              `[AutoSell] ✅ DISPUTE EXIT: Freed $${(position.size * position.currentPrice).toFixed(2)} capital (cost: $${totalLoss.toFixed(3)} to avoid dispute hold wait)`,
            );
          }
        } catch (err) {
          this.logger.error(
            `[AutoSell] Failed dispute exit for ${position.marketId}`,
            err as Error,
          );
        }
      }
    }

    // === STANDARD AUTO-SELL (normal threshold) ===
    // Get positions near resolution (price >= threshold)
    const nearResolutionPositions =
      this.positionTracker.getPositionsNearResolution(this.config.threshold);

    for (const position of nearResolutionPositions) {
      const positionKey = `${position.marketId}-${position.tokenId}`;

      // Skip if already sold (including from dispute exit above)
      if (this.soldPositions.has(positionKey)) {
        continue;
      }

      // Track first seen time
      if (!this.positionFirstSeen.has(positionKey)) {
        this.positionFirstSeen.set(positionKey, Date.now());
        continue; // Don't sell on first detection
      }

      // Check minimum hold time (avoids conflict with endgame sweep)
      const holdTimeSeconds =
        (Date.now() - this.positionFirstSeen.get(positionKey)!) / 1000;
      if (holdTimeSeconds < this.config.minHoldSeconds) {
        this.logger.debug(
          `[AutoSell] Position ${position.marketId} held for ${holdTimeSeconds.toFixed(0)}s, waiting for ${this.config.minHoldSeconds}s`,
        );
        continue;
      }

      this.logger.info(
        `[AutoSell] Selling position at ${(position.currentPrice * 100).toFixed(1)}¢ (held ${holdTimeSeconds.toFixed(0)}s): ${position.marketId}`,
      );

      try {
        const sold = await this.sellPosition(
          position.marketId,
          position.tokenId,
          position.size,
        );

        if (sold) {
          this.soldPositions.add(positionKey);
          soldCount++;

          // Log the capital recovery trade-off (includes 0.2% fees)
          const lossPerShare = 1.0 - position.currentPrice;
          const totalLossFromPrice = lossPerShare * position.size;
          const feeCost = position.size * 0.002; // 0.2% round-trip fees
          const totalCost = totalLossFromPrice + feeCost;

          this.logger.info(
            `[AutoSell] Freed $${position.size.toFixed(2)} capital (cost: $${totalLossFromPrice.toFixed(2)} + $${feeCost.toFixed(2)} fees = $${totalCost.toFixed(2)} total, ${((totalCost / position.size) * 100).toFixed(2)}% of position)`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[AutoSell] Failed to sell position ${position.marketId}`,
          err as Error,
        );
      }
    }

    if (soldCount > 0) {
      this.logger.info(
        `[AutoSell] Sold ${soldCount} positions near resolution`,
      );
    }

    return soldCount;
  }

  /**
   * Sell a position using postOrder utility
   * Executes market sell order at best bid for quick capital recovery
   * @returns true if order was submitted successfully, false if skipped/no liquidity
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number,
  ): Promise<boolean> {
    try {
      // Import postOrder utility
      const { postOrder } = await import("../utils/post-order.util");

      // Get current orderbook to check liquidity and best bid
      const orderbook = await this.client.getOrderBook(tokenId);

      if (!orderbook.bids || orderbook.bids.length === 0) {
        // Only log if we haven't already logged for this token (suppress log spam)
        if (!this.noLiquidityTokens.has(tokenId)) {
          this.logger.warn(
            `[AutoSell] ⚠️ No bids available for token ${tokenId} - position cannot be sold (illiquid market)`,
          );
          this.noLiquidityTokens.add(tokenId);
        }
        // Return false - position will be re-evaluated on the next cycle when liquidity may return
        return false;
      }

      // Clear no-liquidity flag if liquidity has returned
      this.noLiquidityTokens.delete(tokenId);

      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestBidSize = parseFloat(orderbook.bids[0].size);

      this.logger.debug(
        `[AutoSell] Best bid: ${(bestBid * 100).toFixed(1)}¢ (size: ${bestBidSize.toFixed(2)})`,
      );

      // Check liquidity
      const totalBidLiquidity = orderbook.bids
        .slice(0, 5) // Top 5 levels for auto-sell
        .reduce((sum, level) => sum + parseFloat(level.size), 0);

      if (totalBidLiquidity < size * 0.3) {
        this.logger.warn(
          `[AutoSell] Low liquidity: attempting to sell ${size.toFixed(2)} but only ${totalBidLiquidity.toFixed(2)} available`,
        );
      }

      // Calculate sell value
      const sizeUsd = size * bestBid;

      // Log info for small positions but allow selling them to liquidate
      const minOrderUsd = this.config.minOrderUsd;
      if (sizeUsd < minOrderUsd) {
        this.logger.debug(
          `[AutoSell] ℹ️ Selling small position: $${sizeUsd.toFixed(2)} (below $${minOrderUsd} minimum, allowed for liquidation)`,
        );
      }

      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      // Calculate expected loss per share
      const lossPerShare = 1.0 - bestBid;
      const totalLoss = lossPerShare * size;

      this.logger.info(
        `[AutoSell] Executing sell: ${size.toFixed(2)} shares at ~${(bestBid * 100).toFixed(1)}¢ (loss: $${totalLoss.toFixed(2)})`,
      );

      // Execute sell order - use aggressive pricing for fast fill
      // Always set minOrderUsd=0 for sells to allow liquidating small positions
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: "YES", // Direction doesn't matter for sells
        side: "SELL",
        sizeUsd,
        maxAcceptablePrice: bestBid * 0.9, // Accept up to 10% slippage for urgent exit
        logger: this.logger,
        priority: false,
        skipDuplicatePrevention: true, // Auto-sell must bypass duplicate prevention for exits
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum order size for all sells
      });

      if (result.status === "submitted") {
        const freedCapital = size * bestBid;
        this.logger.info(
          `[AutoSell] ✓ Sold ${size.toFixed(2)} shares, freed $${freedCapital.toFixed(2)} capital`,
        );
        return true;
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[AutoSell] Sell order skipped: ${result.reason ?? "unknown reason"}`,
        );
        return false;
      } else {
        this.logger.error(
          `[AutoSell] Sell order failed: ${result.reason ?? "unknown reason"}`,
        );
        throw new Error(`Sell order failed: ${result.reason ?? "unknown"}`);
      }
    } catch (err) {
      // Re-throw error for caller to handle
      this.logger.error(
        `[AutoSell] Failed to sell position: ${err instanceof Error ? err.message : String(err)}`,
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
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

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

    // Also clean up no-liquidity cache for tokens we no longer hold
    const tokensToRemove: string[] = [];
    for (const tokenId of this.noLiquidityTokens) {
      if (!currentTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      this.noLiquidityTokens.delete(tokenId);
    }

    if (cleanedFirstSeen > 0 || cleanedSold > 0) {
      this.logger.debug(
        `[AutoSell] Cleaned up ${cleanedFirstSeen} first-seen and ${cleanedSold} sold entries`,
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
    this.noLiquidityTokens.clear();
  }
}
