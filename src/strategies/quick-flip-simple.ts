/**
 * Quick Flip Strategy - SIMPLIFIED
 *
 * Sell positions when they hit profit target.
 *
 * SIMPLE LOGIC:
 * 1. Find positions that are profitable
 * 2. If profit >= target AND held long enough, SELL
 *
 * That's it. No complex dynamic targets, no elaborate calculations.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";

/**
 * Simple Quick Flip Configuration
 */
export interface SimpleQuickFlipConfig {
  /** Enable the strategy */
  enabled: boolean;

  /** Target profit % to trigger sell (default: 5) */
  targetPct: number;

  /** Minimum seconds to hold before selling (default: 60) */
  minHoldSeconds: number;

  /** Minimum profit in USD to sell (default: 0.25) */
  minProfitUsd: number;
}

export const DEFAULT_SIMPLE_QUICKFLIP_CONFIG: SimpleQuickFlipConfig = {
  enabled: true,
  targetPct: 5,
  minHoldSeconds: 60,
  minProfitUsd: 0.25,
};

/**
 * Simple Quick Flip Strategy
 */
export class SimpleQuickFlipStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: SimpleQuickFlipConfig;
  private positionTracker: PositionTracker;

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    config: SimpleQuickFlipConfig;
    positionTracker: PositionTracker;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.config = config.config;
    this.positionTracker = config.positionTracker;

    this.logger.info(
      `[SimpleQuickFlip] Initialized: target=+${this.config.targetPct}%, minHold=${this.config.minHoldSeconds}s`,
    );
  }

  /**
   * Execute the strategy
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    const positions = this.positionTracker.getPositions();
    let soldCount = 0;

    for (const position of positions) {
      // Skip if not profitable enough
      if (position.pnlPct < this.config.targetPct) {
        continue;
      }

      // Skip if profit too small in absolute terms
      if (position.pnlUsd < this.config.minProfitUsd) {
        continue;
      }

      // Check hold time
      const entryTime = this.positionTracker.getPositionEntryTime(
        position.marketId,
        position.tokenId,
      );
      if (!entryTime) {
        continue; // Don't know when we bought - skip
      }

      const holdSeconds = (Date.now() - entryTime) / 1000;
      if (holdSeconds < this.config.minHoldSeconds) {
        this.logger.debug(
          `[SimpleQuickFlip] Hold ${holdSeconds.toFixed(0)}s < ${this.config.minHoldSeconds}s - waiting`,
        );
        continue;
      }

      // Sell!
      this.logger.info(
        `[SimpleQuickFlip] 📈 Selling at +${position.pnlPct.toFixed(1)}% (+$${position.pnlUsd.toFixed(2)})`,
      );

      const sold = await this.sellPosition(position);
      if (sold) {
        soldCount++;
      }
    }

    if (soldCount > 0) {
      this.logger.info(`[SimpleQuickFlip] ✅ Sold ${soldCount} position(s)`);
    }

    return soldCount;
  }

  /**
   * Sell a position
   */
  private async sellPosition(position: {
    marketId: string;
    tokenId: string;
    size: number;
    currentPrice: number;
    side?: string;
  }): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[SimpleQuickFlip] No wallet`);
      return false;
    }

    try {
      const sizeUsd = position.size * position.currentPrice;

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: (position.side?.toUpperCase() as "YES" | "NO") || "YES",
        side: "SELL",
        sizeUsd,
        logger: this.logger,
        skipDuplicatePrevention: true,
      });

      if (result.status === "submitted") {
        this.logger.info(`[SimpleQuickFlip] ✅ Sold successfully`);
        return true;
      }

      this.logger.warn(
        `[SimpleQuickFlip] ⚠️ Sell not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[SimpleQuickFlip] ❌ Sell failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get strategy stats
   */
  getStats(): { enabled: boolean; targetPct: number } {
    return {
      enabled: this.config.enabled,
      targetPct: this.config.targetPct,
    };
  }
}
