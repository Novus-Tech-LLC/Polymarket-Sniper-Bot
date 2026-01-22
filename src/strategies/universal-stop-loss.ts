import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { getDynamicStopLoss, PRICE_TIERS } from "./trade-quality";

export interface UniversalStopLossConfig {
  enabled: boolean;
  /**
   * Maximum stop-loss percentage allowed for ANY position.
   * Acts as an absolute ceiling regardless of entry price tier.
   * Default: 25% - no position should ever lose more than this.
   */
  maxStopLossPct: number;
  /**
   * Use dynamic stop-loss tiers based on entry price.
   * If false, uses maxStopLossPct for all positions.
   */
  useDynamicTiers: boolean;
  /**
   * Skip risky tier positions (entry < 60¢) - let smart hedging handle them
   * Default: true when smart hedging is enabled
   */
  skipRiskyTierForHedging?: boolean;
}

export interface UniversalStopLossStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: UniversalStopLossConfig;
}

/**
 * Universal Stop-Loss Strategy
 *
 * A SAFETY NET that runs on ALL positions regardless of which strategy created them.
 * This ensures no position can "fall through the cracks" and exceed its stop-loss threshold.
 *
 * Stop-Loss Tiers (when useDynamicTiers=true):
 * - Premium tier (90¢+): 3% stop-loss
 * - Quality tier (80-90¢): 5% stop-loss
 * - Standard tier (70-80¢): 8% stop-loss
 * - Speculative tier (60-70¢): 12% stop-loss
 * - Risky tier (< 60¢): 20% stop-loss (SKIPPED if smart hedging enabled)
 *
 * The maxStopLossPct acts as an absolute ceiling (default 25%).
 *
 * NOTE: When Smart Hedging is enabled (default), risky tier positions (<60¢ entry)
 * are SKIPPED by this strategy. Smart Hedging handles them by buying the opposing
 * side instead of selling at a loss, which can turn losers into winners.
 *
 * This strategy is designed to catch positions from:
 * - ARB trades (which have no built-in stop-loss)
 * - Monitor/Mempool trades (which have no built-in stop-loss)
 * - Endgame Sweep trades (which have no built-in stop-loss)
 * - Any other source of positions
 */
export class UniversalStopLossStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: UniversalStopLossConfig;

  /**
   * Tracks tokenIds with no liquidity to suppress repeated warnings.
   * Key: tokenId (string)
   * Cleared when position is sold or no longer held.
   */
  private noLiquidityTokens: Set<string> = new Set();

  /**
   * Tracks positions currently being processed for stop-loss sell.
   * Key format: "marketId-tokenId"
   * Used to prevent duplicate sell attempts within the same execution cycle.
   * Entries are removed after sell attempt completes (success or failure).
   */
  private pendingSells: Set<string> = new Set();

  /**
   * Tracks when stop-loss was triggered for each position (for logging/diagnostics).
   * Key format: "marketId-tokenId"
   * Value: timestamp (ms) when stop-loss was triggered
   * Cleaned up when position no longer exists.
   */
  private stopLossTriggered: Map<string, number> = new Map();

  constructor(strategyConfig: UniversalStopLossStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the universal stop-loss strategy
   * Returns number of positions sold
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up stale entries
    this.cleanupStaleEntries();

    let soldCount = 0;
    const allPositions = this.positionTracker.getPositions();

    // Skip resolved/redeemable positions (they can't be sold, only redeemed)
    let activePositions = allPositions.filter((pos) => !pos.redeemable);

    // Skip risky tier positions if smart hedging is handling them
    // Risky tier = entry price < 60¢ (SPECULATIVE_MIN threshold)
    if (this.config.skipRiskyTierForHedging) {
      const riskyThreshold = PRICE_TIERS.SPECULATIVE_MIN; // 0.6 = 60¢
      const riskyCount = activePositions.filter((pos) => pos.entryPrice < riskyThreshold).length;
      activePositions = activePositions.filter((pos) => pos.entryPrice >= riskyThreshold);
      
      if (riskyCount > 0) {
        this.logger.debug(
          `[UniversalStopLoss] Skipping ${riskyCount} risky tier position(s) - smart hedging will handle them`,
        );
      }
    }

    if (activePositions.length === 0) {
      return 0;
    }

    // Find positions exceeding their stop-loss threshold
    const positionsToStop: Array<{ position: Position; stopLossPct: number }> =
      [];

    for (const position of activePositions) {
      const stopLossPct = this.getStopLossThreshold(position.entryPrice);

      // Check if position exceeds stop-loss (negative P&L beyond threshold)
      if (position.pnlPct <= -stopLossPct) {
        positionsToStop.push({ position, stopLossPct });
      }
    }

    // Log summary of positions being monitored
    if (positionsToStop.length > 0) {
      this.logger.warn(
        `[UniversalStopLoss] 🚨 ${positionsToStop.length} position(s) exceeding stop-loss threshold!`,
      );
    }

    // Process stop-loss sells
    for (const { position, stopLossPct } of positionsToStop) {
      const positionKey = `${position.marketId}-${position.tokenId}`;

      // Skip if we're already trying to sell this position
      if (this.pendingSells.has(positionKey)) {
        continue;
      }

      // Log the stop-loss trigger
      const tierName = this.getTierName(position.entryPrice);
      this.logger.warn(
        `[UniversalStopLoss] 🔻 STOP-LOSS TRIGGERED: ${position.pnlPct.toFixed(2)}% loss ` +
          `(threshold: -${stopLossPct}%, tier: ${tierName}, entry: ${(position.entryPrice * 100).toFixed(1)}¢) ` +
          `Market: ${position.marketId.slice(0, 16)}...`,
      );

      this.pendingSells.add(positionKey);
      this.stopLossTriggered.set(positionKey, Date.now());

      try {
        const sold = await this.sellPosition(
          position.marketId,
          position.tokenId,
          position.size,
          position.pnlPct,
        );

        if (sold) {
          soldCount++;
          this.logger.info(
            `[UniversalStopLoss] ✅ Stop-loss executed: sold ${position.size.toFixed(2)} shares ` +
              `at ${position.pnlPct.toFixed(2)}% loss`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[UniversalStopLoss] ❌ Failed to execute stop-loss for ${position.marketId}`,
          err as Error,
        );
      } finally {
        // Remove from pending after attempt (success or failure)
        this.pendingSells.delete(positionKey);
      }
    }

    if (soldCount > 0) {
      this.logger.info(
        `[UniversalStopLoss] 💰 Executed ${soldCount} stop-loss sell(s)`,
      );
    }

    return soldCount;
  }

  /**
   * Get stop-loss threshold for a position based on entry price
   */
  private getStopLossThreshold(entryPrice: number): number {
    if (!this.config.useDynamicTiers) {
      return this.config.maxStopLossPct;
    }

    // Get dynamic stop-loss based on entry price tier
    const dynamicStopLoss = getDynamicStopLoss(entryPrice);

    // Apply the absolute ceiling
    return Math.min(dynamicStopLoss, this.config.maxStopLossPct);
  }

  /**
   * Get human-readable tier name for logging
   */
  private getTierName(entryPrice: number): string {
    if (entryPrice >= PRICE_TIERS.PREMIUM_MIN) return "Premium";
    if (entryPrice >= PRICE_TIERS.QUALITY_MIN) return "Quality";
    if (entryPrice >= PRICE_TIERS.STANDARD_MIN) return "Standard";
    if (entryPrice >= PRICE_TIERS.SPECULATIVE_MIN) return "Speculative";
    return "Risky";
  }

  /**
   * Sell a position using postOrder utility
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number,
    currentLossPct: number,
  ): Promise<boolean> {
    try {
      const { postOrder } = await import("../utils/post-order.util");

      // Get current orderbook
      const orderbook = await this.client.getOrderBook(tokenId);

      if (!orderbook.bids || orderbook.bids.length === 0) {
        if (!this.noLiquidityTokens.has(tokenId)) {
          this.logger.warn(
            `[UniversalStopLoss] ⚠️ No bids for token ${tokenId} - cannot execute stop-loss (illiquid)`,
          );
          this.noLiquidityTokens.add(tokenId);
        }
        return false;
      }

      // Clear no-liquidity flag if liquidity returned
      this.noLiquidityTokens.delete(tokenId);

      const bestBid = parseFloat(orderbook.bids[0].price);
      const sizeUsd = size * bestBid;

      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      this.logger.info(
        `[UniversalStopLoss] 🔄 Executing stop-loss sell: ${size.toFixed(2)} shares ` +
          `at ~${(bestBid * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)}, loss: ${currentLossPct.toFixed(2)}%)`,
      );

      // Execute sell order with aggressive slippage tolerance for stop-loss
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: "YES",
        side: "SELL",
        sizeUsd,
        maxAcceptablePrice: bestBid * 0.9, // Accept up to 10% slippage for stop-loss
        logger: this.logger,
        priority: true, // High priority for stop-loss
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum for stop-loss
      });

      if (result.status === "submitted") {
        return true;
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[UniversalStopLoss] ⏭️ Stop-loss sell skipped: ${result.reason ?? "unknown"}`,
        );
        return false;
      } else {
        this.logger.error(
          `[UniversalStopLoss] ❌ Stop-loss sell failed: ${result.reason ?? "unknown"}`,
        );
        return false;
      }
    } catch (err) {
      this.logger.error(
        `[UniversalStopLoss] ❌ Error selling position: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Clean up stale entries from tracking sets
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

    // Clean up stop-loss triggers for positions that no longer exist
    const triggersToRemove: string[] = [];
    for (const key of this.stopLossTriggered.keys()) {
      if (!currentKeys.has(key)) {
        triggersToRemove.push(key);
      }
    }
    for (const key of triggersToRemove) {
      this.stopLossTriggered.delete(key);
    }

    // Clean up no-liquidity cache for tokens we no longer hold
    const tokensToRemove: string[] = [];
    for (const tokenId of this.noLiquidityTokens) {
      if (!currentTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      this.noLiquidityTokens.delete(tokenId);
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    maxStopLossPct: number;
    useDynamicTiers: boolean;
    activeStopLossTriggers: number;
  } {
    return {
      enabled: this.config.enabled,
      maxStopLossPct: this.config.maxStopLossPct,
      useDynamicTiers: this.config.useDynamicTiers,
      activeStopLossTriggers: this.stopLossTriggered.size,
    };
  }
}
