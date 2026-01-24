/**
 * Endgame Sweep Strategy
 *
 * Buy high-confidence positions near resolution (85-99¢) that are likely to pay $1.
 *
 * SIMPLE LOGIC:
 * 1. Scan for markets with prices in the sweet spot (85-99¢)
 * 2. Check we haven't exceeded MAX_POSITION_USD for that market
 * 3. Buy if we have capacity
 *
 * That's it. No complex quality scoring, no elaborate spread analysis.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";
import { isLiveTradingEnabled } from "../utils/live-trading.util";

/**
 * Endgame Sweep Configuration
 */
export interface EndgameSweepConfig {
  /** Enable the strategy */
  enabled: boolean;

  /** Minimum price to consider (default: 0.85 = 85¢) */
  minPrice: number;

  /** Maximum price to consider (default: 0.99 = 99¢) */
  maxPrice: number;

  /** Maximum USD per market position (from MAX_POSITION_USD) */
  maxPositionUsd: number;
}

export const DEFAULT_ENDGAME_CONFIG: EndgameSweepConfig = {
  enabled: true,
  minPrice: 0.85,
  maxPrice: 0.99,
  maxPositionUsd: 25,
};

/**
 * Endgame Sweep Strategy
 */
export class EndgameSweepStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: EndgameSweepConfig;
  private positionTracker?: PositionTracker;

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

  // Track markets we've already bought in this session
  private purchasedMarkets: Set<string> = new Set();

  // Track in-flight buys to prevent stacking
  private inFlightBuys: Map<string, number> = new Map();

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    config: EndgameSweepConfig;
    positionTracker?: PositionTracker;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.config = config.config;
    this.positionTracker = config.positionTracker;

    this.logger.info(
      `[EndgameSweep] Initialized: price range ${(this.config.minPrice * 100).toFixed(0)}-${(this.config.maxPrice * 100).toFixed(0)}¢, maxPosition=$${this.config.maxPositionUsd}`,
    );
  }

  /**
   * Execute the strategy
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard: prevent concurrent execution
    if (this.inFlight) {
      this.logger.debug("[EndgameSweep] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    try {
      return await this.executeInternal();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Internal execution logic (called by execute() with in-flight guard)
   */
  private async executeInternal(): Promise<number> {
    // Clean up old in-flight entries (older than 60 seconds)
    const now = Date.now();
    for (const [marketId, timestamp] of this.inFlightBuys) {
      if (now - timestamp > 60000) {
        this.inFlightBuys.delete(marketId);
      }
    }

    let purchasedCount = 0;

    // Get markets to scan
    const markets = await this.scanMarkets();

    for (const market of markets) {
      // Skip if already purchased this session
      if (this.purchasedMarkets.has(market.id)) {
        continue;
      }

      // Skip if there's an in-flight buy
      if (this.inFlightBuys.has(market.id)) {
        continue;
      }

      // Check existing exposure in this market
      const existingExposure = this.getMarketExposure(market.id);
      if (existingExposure >= this.config.maxPositionUsd) {
        this.logger.debug(
          `[EndgameSweep] Skip ${market.id}: at max ($${existingExposure.toFixed(2)} >= $${this.config.maxPositionUsd})`,
        );
        continue;
      }

      // Calculate how much we can buy
      const remainingCapacity = this.config.maxPositionUsd - existingExposure;
      if (remainingCapacity < 1) {
        continue;
      }

      // Try to buy
      const bought = await this.buyPosition(market, remainingCapacity);
      if (bought) {
        purchasedCount++;
        this.purchasedMarkets.add(market.id);
      }
    }

    if (purchasedCount > 0) {
      this.logger.info(
        `[EndgameSweep] ✅ Bought ${purchasedCount} position(s)`,
      );
    }

    return purchasedCount;
  }

  /**
   * Scan for markets in the target price range
   */
  private async scanMarkets(): Promise<
    Array<{
      id: string;
      tokenId: string;
      price: number;
      side: "YES" | "NO";
    }>
  > {
    const candidates: Array<{
      id: string;
      tokenId: string;
      price: number;
      side: "YES" | "NO";
    }> = [];

    try {
      // Get markets from Gamma API
      const response = await fetch(
        "https://gamma-api.polymarket.com/markets?closed=false&limit=100",
      );
      if (!response.ok) return candidates;

      const markets = await response.json();

      for (const market of markets) {
        if (!market.tokens || market.tokens.length < 2) continue;
        if (market.closed || !market.accepting_orders) continue;

        for (const token of market.tokens) {
          try {
            const orderbook = await this.client.getOrderBook(token.token_id);
            if (!orderbook.asks || orderbook.asks.length === 0) continue;

            const price = parseFloat(orderbook.asks[0].price);

            // Check if in our target range
            if (
              price >= this.config.minPrice &&
              price <= this.config.maxPrice
            ) {
              candidates.push({
                id: market.condition_id || market.id,
                tokenId: token.token_id,
                price,
                side: token.outcome?.toUpperCase() === "YES" ? "YES" : "NO",
              });
            }
          } catch {
            // Skip markets we can't get orderbooks for
          }
        }
      }
    } catch (err) {
      this.logger.error(
        `[EndgameSweep] Scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return candidates;
  }

  /**
   * Get total exposure in a market
   */
  private getMarketExposure(marketId: string): number {
    if (!this.positionTracker) return 0;

    const positions = this.positionTracker.getPositions();
    let exposure = 0;

    for (const pos of positions) {
      if (pos.marketId === marketId) {
        exposure += pos.size * pos.entryPrice;
      }
    }

    return exposure;
  }

  /**
   * Buy a position
   */
  private async buyPosition(
    market: { id: string; tokenId: string; price: number; side: "YES" | "NO" },
    maxUsd: number,
  ): Promise<boolean> {
    if (!isLiveTradingEnabled()) {
      this.logger.debug(
        `[EndgameSweep] Would buy at ${(market.price * 100).toFixed(1)}¢ - LIVE TRADING DISABLED`,
      );
      return false;
    }

    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[EndgameSweep] No wallet`);
      return false;
    }

    // Mark as in-flight
    this.inFlightBuys.set(market.id, Date.now());

    try {
      const sizeUsd = Math.min(maxUsd, this.config.maxPositionUsd);
      const expectedProfit = ((1 - market.price) / market.price) * 100;

      this.logger.info(
        `[EndgameSweep] 🛒 Buying at ${(market.price * 100).toFixed(1)}¢, $${sizeUsd.toFixed(2)} (expected: +${expectedProfit.toFixed(1)}%)`,
      );

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: market.id,
        tokenId: market.tokenId,
        outcome: market.side,
        side: "BUY",
        sizeUsd,
        maxAcceptablePrice: market.price * 1.02,
        logger: this.logger,
      });

      if (result.status === "submitted") {
        this.logger.info(`[EndgameSweep] ✅ Bought successfully`);
        return true;
      }

      this.logger.warn(
        `[EndgameSweep] ⚠️ Order not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[EndgameSweep] ❌ Buy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      // Clear in-flight after attempt
      this.inFlightBuys.delete(market.id);
    }
  }

  /**
   * Get strategy stats
   */
  getStats(): { enabled: boolean; purchasedCount: number } {
    return {
      enabled: this.config.enabled,
      purchasedCount: this.purchasedMarkets.size,
    };
  }
}
