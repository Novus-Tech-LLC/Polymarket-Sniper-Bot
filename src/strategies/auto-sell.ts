import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";

export interface AutoSellConfig {
  enabled: boolean;
  threshold: number;  // Price threshold to auto-sell (e.g., 0.99 = 99¢)
}

export interface AutoSellStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: AutoSellConfig;
}

/**
 * Auto-Sell at 99¢ Strategy
 * Monitors owned positions approaching resolution
 * Automatically sells when price hits threshold (e.g., 99¢)
 * Don't wait for 4pm UTC payout - free up capital immediately
 * Lose 1¢ per share but gain hours of capital availability
 */
export class AutoSellStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoSellConfig;
  private soldPositions: Set<string> = new Set();

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

      this.logger.info(
        `[AutoSell] Selling position at ${(position.currentPrice * 100).toFixed(1)}¢: ${position.marketId}`
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
   * Sell a position
   * This is a placeholder for actual selling logic
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number
  ): Promise<void> {
    // This would use actual ClobClient methods to sell
    // For now, this is a placeholder
    this.logger.debug(
      `[AutoSell] Would sell ${size} of ${tokenId} in market ${marketId}`
    );
    
    // In production, this would:
    // 1. Get current best bid price
    // 2. Create market sell order to exit quickly
    // 3. Submit order to CLOB
    // 4. Wait for fill confirmation
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
  }
}
