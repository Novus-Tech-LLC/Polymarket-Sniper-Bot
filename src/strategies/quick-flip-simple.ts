/**
 * Quick Flip Strategy - PROFIT ONLY
 *
 * CRITICAL RULE: This strategy ONLY sells for PROFIT. NEVER for a loss.
 *
 * If a position is losing money, Quick Flip does NOTHING.
 * Losses are handled by Smart Hedging (which hedges or liquidates at configured thresholds).
 *
 * SIMPLE LOGIC:
 * 1. Find positions that are profitable at ACTUAL BID PRICE (not mid-price)
 * 2. If profit >= target % AND profit >= min USD AND held long enough, SELL
 * 3. If ANY of these conditions fail, DO NOTHING - let the position ride
 *
 * The separation of concerns:
 * - Quick Flip = MAKING money (profit-taking)
 * - Smart Hedging = PROTECTING money (loss mitigation at configured thresholds)
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

  /** Minimum profit in USD to sell (default: 0.10) */
  minProfitUsd: number;
}

/**
 * Polymarket fee structure:
 * - Trading fee: 0.01% per side (1 basis point per side)
 * - Round-trip fee: 0.02% (2 basis points total)
 * - Bid-ask spread: typically 1-5% depending on liquidity
 *
 * To ensure profit after fees, we need substantial profit targets.
 * The trading fee (0.02%) is negligible, but spread can eat into profits.
 */
const MIN_PROFIT_BUFFER_PCT = 1.0; // 1% buffer to cover spread + fees
const EFFECTIVE_MIN_PROFIT_PCT = MIN_PROFIT_BUFFER_PCT; // ~1% minimum profit required

export const DEFAULT_SIMPLE_QUICKFLIP_CONFIG: SimpleQuickFlipConfig = {
  enabled: true,
  targetPct: 5, // 5% target - reasonable profit after spread/fees
  minHoldSeconds: 60, // Hold 60 seconds before selling
  minProfitUsd: 0.5, // Minimum $0.50 profit per trade
};

/**
 * Simple Quick Flip Strategy
 *
 * PROFIT ONLY - Never sells below entry price.
 * Takes the quickest reasonable profit above trading fees.
 * For loss handling, see Smart Hedging strategy.
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
      // Skip if not profitable enough (based on mid-price from position tracker)
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

      // CRITICAL: Verify profit at ACTUAL BID PRICE before selling
      // Position tracker uses mid-price, but we sell at bid price
      // This prevents selling for a loss when spread is large
      const actualProfit = await this.verifyProfitAtBidPrice(position);
      if (!actualProfit.profitable) {
        this.logger.debug(
          `[SimpleQuickFlip] ⚠️ Mid-price shows +${position.pnlPct.toFixed(1)}% but bid price shows ${actualProfit.bidPnlPct.toFixed(1)}% - skipping to avoid loss`,
        );
        continue;
      }

      // Sell!
      this.logger.info(
        `[SimpleQuickFlip] 📈 Selling at +${actualProfit.bidPnlPct.toFixed(1)}% (+$${actualProfit.bidPnlUsd.toFixed(2)}) [mid-price was +${position.pnlPct.toFixed(1)}%]`,
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
   * Verify profit at actual bid price before selling
   *
   * CRITICAL: Quick Flip NEVER sells below entry price.
   * This method ensures we only sell when:
   * 1. Bid price > entry price (absolute floor - NEVER sell for a loss)
   * 2. Profit % >= EFFECTIVE_MIN_PROFIT_PCT (covers fees + spread)
   * 3. Profit % >= configured target %
   * 4. Profit USD >= minimum USD
   *
   * If ANY condition fails, returns profitable=false and we DO NOT sell.
   *
   * The goal is to take the QUICKEST reasonable profit above trading fees.
   */
  private async verifyProfitAtBidPrice(position: {
    marketId: string;
    tokenId: string;
    size: number;
    entryPrice: number;
  }): Promise<{
    profitable: boolean;
    bidPnlPct: number;
    bidPnlUsd: number;
    bidPrice: number;
  }> {
    try {
      const orderbook = await this.client.getOrderBook(position.tokenId);

      if (!orderbook.bids || orderbook.bids.length === 0) {
        // No bids - can't sell, so not profitable
        return {
          profitable: false,
          bidPnlPct: -100,
          bidPnlUsd: -position.size * position.entryPrice,
          bidPrice: 0,
        };
      }

      const bidPrice = parseFloat(orderbook.bids[0].price);
      const bidPnlUsd = (bidPrice - position.entryPrice) * position.size;
      const bidPnlPct =
        ((bidPrice - position.entryPrice) / position.entryPrice) * 100;

      // ABSOLUTE RULE #1: Never sell below entry price
      // This is the hard floor - no matter what, we don't sell for a loss
      if (bidPrice <= position.entryPrice) {
        this.logger.debug(
          `[SimpleQuickFlip] 🚫 Bid ${(bidPrice * 100).toFixed(1)}¢ <= entry ${(position.entryPrice * 100).toFixed(1)}¢ - NEVER sell for a loss`,
        );
        return { profitable: false, bidPnlPct, bidPnlUsd, bidPrice };
      }

      // RULE #2: Must be above effective minimum (fees + spread buffer)
      // This ensures we actually make money after all costs
      if (bidPnlPct < EFFECTIVE_MIN_PROFIT_PCT) {
        this.logger.debug(
          `[SimpleQuickFlip] Profit ${bidPnlPct.toFixed(2)}% below fee threshold ${EFFECTIVE_MIN_PROFIT_PCT.toFixed(2)}% - waiting for better price`,
        );
        return { profitable: false, bidPnlPct, bidPnlUsd, bidPrice };
      }

      // RULE #3: Must meet configured target % (user can set higher if they want)
      const meetsTarget = bidPnlPct >= this.config.targetPct;

      // RULE #4: Must meet minimum USD profit
      const meetsMinProfit = bidPnlUsd >= this.config.minProfitUsd;

      const profitable = meetsTarget && meetsMinProfit;

      if (!profitable) {
        this.logger.debug(
          `[SimpleQuickFlip] Profit ${bidPnlPct.toFixed(1)}% / $${bidPnlUsd.toFixed(2)} below targets (${this.config.targetPct}% / $${this.config.minProfitUsd}) - waiting`,
        );
      }

      return { profitable, bidPnlPct, bidPnlUsd, bidPrice };
    } catch (err) {
      this.logger.warn(
        `[SimpleQuickFlip] Could not verify bid price: ${err instanceof Error ? err.message : String(err)}`,
      );
      // If we can't verify, don't sell (safety first)
      return { profitable: false, bidPnlPct: 0, bidPnlUsd: 0, bidPrice: 0 };
    }
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
