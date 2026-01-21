import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";

export interface QuickFlipConfig {
  enabled: boolean;
  targetPct: number;        // Sell at this gain percentage (e.g., 5 = 5%)
  stopLossPct: number;      // Sell at this loss percentage (e.g., 3 = -3%)
  minHoldSeconds: number;   // Minimum time to hold position before selling
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

    let soldCount = 0;

    // Check for positions that hit target gain
    const targetPositions = this.positionTracker.getPositionsAboveTarget(
      this.config.targetPct
    );
    
    for (const position of targetPositions) {
      if (this.shouldSell(position.marketId, position.tokenId)) {
        this.logger.info(
          `[QuickFlip] Selling position at +${position.pnlPct.toFixed(2)}% gain: ${position.marketId}`
        );
        
        try {
          await this.sellPosition(position.marketId, position.tokenId, position.size);
          soldCount++;
        } catch (err) {
          this.logger.error(
            `[QuickFlip] Failed to sell position ${position.marketId}`,
            err as Error
          );
        }
      }
    }

    // Check for positions that hit stop loss
    const stopLossPositions = this.positionTracker.getPositionsBelowStopLoss(
      this.config.stopLossPct
    );
    
    for (const position of stopLossPositions) {
      if (this.shouldSell(position.marketId, position.tokenId)) {
        this.logger.warn(
          `[QuickFlip] Stop-loss triggered at ${position.pnlPct.toFixed(2)}%: ${position.marketId}`
        );
        
        try {
          await this.sellPosition(position.marketId, position.tokenId, position.size);
          soldCount++;
        } catch (err) {
          this.logger.error(
            `[QuickFlip] Failed to execute stop-loss for ${position.marketId}`,
            err as Error
          );
        }
      }
    }

    if (soldCount > 0) {
      this.logger.info(`[QuickFlip] Sold ${soldCount} positions`);
    }

    return soldCount;
  }

  /**
   * Check if position should be sold based on hold time
   */
  private shouldSell(marketId: string, tokenId: string): boolean {
    const key = `${marketId}-${tokenId}`;
    const entryTime = this.positionEntryTimes.get(key);
    
    if (!entryTime) {
      // First time seeing this position, record entry time
      this.positionEntryTimes.set(key, Date.now());
      return false;
    }

    const holdTimeSeconds = (Date.now() - entryTime) / 1000;
    return holdTimeSeconds >= this.config.minHoldSeconds;
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
      `[QuickFlip] Would sell ${size} of ${tokenId} in market ${marketId}`
    );
    
    // In production, this would:
    // 1. Get current best bid price
    // 2. Create sell order slightly below best bid
    // 3. Submit order to CLOB
    // 4. Wait for fill confirmation
    
    // Remove from entry times after selling
    const key = `${marketId}-${tokenId}`;
    this.positionEntryTimes.delete(key);
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
