import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import {
  MAX_LIQUIDITY_USAGE_PCT,
  calculateNetProfit,
  isProfitableAfterFees,
} from "./constants";
import { isLiveTradingEnabled } from "../utils/live-trading.util";

export interface EndgameSweepConfig {
  enabled: boolean;
  minPrice: number;  // Minimum price to consider (e.g., 0.98 = 98¢)
  maxPrice: number;  // Maximum price to consider (e.g., 0.995 = 99.5¢)
  /**
   * ⚠️ CRITICAL SAFETY SETTING ⚠️
   * Maximum USD to invest PER POSITION (NOT total exposure)
   * 
   * This strategy can buy MULTIPLE positions simultaneously.
   * Your total exposure = maxPositionUsd × number of opportunities found
   * 
   * RECOMMENDED VALUES:
   * - Testing/New users: $5-10 per position
   * - Conservative: $10-20 per position
   * - Balanced: $20-30 per position
   * - Aggressive: $30-50 per position (HIGH RISK)
   * 
   * WARNING: Setting this too high can deplete your entire wallet quickly!
   * Start small and increase gradually as you gain confidence.
   */
  maxPositionUsd: number;
}

export interface Market {
  id: string;
  tokenId: string;
  side: "YES" | "NO";
  price: number;
  liquidity: number;
}

export interface EndgameSweepStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  config: EndgameSweepConfig;
}

/**
 * Endgame Sweep Strategy
 * Scan markets for positions trading at 98-99¢ (near-certain outcomes)
 * Buy these positions for near-guaranteed 1-2% profit
 * Very low risk since outcome is almost certain
 */
export class EndgameSweepStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: EndgameSweepConfig;
  private purchasedMarkets: Set<string> = new Set();
  private purchaseTimestamps: Map<string, number> = new Map(); // Track when markets were purchased

  constructor(strategyConfig: EndgameSweepStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the endgame sweep strategy
   * Returns number of positions purchased
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up stale entries (older than 24 hours)
    this.cleanupOldPurchases();

    let purchasedCount = 0;

    // Scan for markets with high-confidence outcomes
    const candidates = await this.scanForEndgameOpportunities();

    for (const market of candidates) {
      const marketKey = `${market.id}-${market.tokenId}`;
      
      // Skip if already purchased
      if (this.purchasedMarkets.has(marketKey)) {
        continue;
      }

      // Calculate expected profit (gross and net)
      const expectedGrossProfitPct = ((1.0 - market.price) / market.price) * 100;
      const expectedNetProfitPct = calculateNetProfit(expectedGrossProfitPct);

      // Skip if not profitable after fees (minimum 0.5% net profit)
      if (!isProfitableAfterFees(expectedGrossProfitPct, 0.5)) {
        this.logger.debug(
          `[EndgameSweep] Skipping ${market.id} at ${(market.price * 100).toFixed(1)}¢ - insufficient margin (${expectedNetProfitPct.toFixed(2)}% net after fees)`
        );
        continue;
      }

      this.logger.info(
        `[EndgameSweep] Opportunity: ${market.id} at ${(market.price * 100).toFixed(1)}¢ (gross ${expectedGrossProfitPct.toFixed(2)}%, net ${expectedNetProfitPct.toFixed(2)}% after fees)`
      );

      try {
        await this.buyPosition(market);
        this.purchasedMarkets.add(marketKey);
        this.purchaseTimestamps.set(marketKey, Date.now());
        purchasedCount++;
      } catch (err) {
        this.logger.error(
          `[EndgameSweep] Failed to buy position ${market.id}`,
          err as Error
        );
      }
    }

    if (purchasedCount > 0) {
      this.logger.info(
        `[EndgameSweep] Purchased ${purchasedCount} endgame positions`
      );
    }

    return purchasedCount;
  }

  /**
   * Scan for endgame opportunities
   * Fetches markets from Gamma API and filters by price range
   */
  private async scanForEndgameOpportunities(): Promise<Market[]> {
    this.logger.debug(
      `[EndgameSweep] Scanning for positions between ${(this.config.minPrice * 100).toFixed(1)}¢ and ${(this.config.maxPrice * 100).toFixed(1)}¢`
    );

    try {
      // Import utilities
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } = await import("../constants/polymarket.constants");
      
      // Interface for Gamma API market response
      interface GammaMarket {
        condition_id?: string;
        id?: string;
        question?: string;
        tokens?: Array<{
          token_id?: string;
          outcome?: string;
          price?: string | number;
        }>;
        active?: boolean;
        closed?: boolean;
        archived?: boolean;
        accepting_orders?: boolean;
        enable_order_book?: boolean;
      }
      
      // Fetch active markets from Gamma API
      // Note: Gamma API returns paginated results, we'll fetch first page
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?limit=100&active=true&closed=false`;
      
      this.logger.debug(`[EndgameSweep] Fetching markets from ${url}`);
      
      const response = await httpGet<GammaMarket[]>(url, { timeout: 15000 });
      
      if (!response || response.length === 0) {
        this.logger.debug("[EndgameSweep] No active markets found");
        return [];
      }
      
      this.logger.debug(`[EndgameSweep] Fetched ${response.length} markets from Gamma API`);
      
      // Filter and map markets to opportunities
      const opportunities: Market[] = [];
      const maxConcurrent = 3; // Rate limit orderbook fetches
      
      for (let i = 0; i < response.length; i += maxConcurrent) {
        const batch = response.slice(i, i + maxConcurrent);
        
        const batchResults = await Promise.allSettled(
          batch.map(async (market) => {
            try {
              // Skip if market is closed or not accepting orders
              if (market.closed || market.archived || !market.accepting_orders || !market.enable_order_book) {
                return null;
              }
              
              const marketId = market.condition_id ?? market.id;
              if (!marketId || !market.tokens || market.tokens.length === 0) {
                return null;
              }
              
              // Check each outcome token
              const marketOpportunities: Market[] = [];
              
              for (const token of market.tokens) {
                const tokenId = token.token_id;
                if (!tokenId) continue;
                
                try {
                  // Fetch current orderbook for accurate pricing
                  const orderbook = await this.client.getOrderBook(tokenId);
                  
                  if (!orderbook.asks || orderbook.asks.length === 0) {
                    continue; // No liquidity
                  }
                  
                  const bestAsk = parseFloat(orderbook.asks[0].price);
                  const bestAskSize = parseFloat(orderbook.asks[0].size);
                  
                  // Check if price is in target range
                  if (bestAsk >= this.config.minPrice && bestAsk <= this.config.maxPrice) {
                    // Calculate total liquidity in target range
                    const totalLiquidity = orderbook.asks
                      .filter(level => {
                        const price = parseFloat(level.price);
                        return price >= this.config.minPrice && price <= this.config.maxPrice;
                      })
                      .reduce((sum, level) => sum + parseFloat(level.size), 0);
                    
                    // Only consider if there's sufficient liquidity
                    const minLiquidity = this.config.maxPositionUsd / bestAsk;
                    if (totalLiquidity >= minLiquidity * 0.5) {
                      const side = token.outcome?.toUpperCase() === "YES" || token.outcome?.toUpperCase() === "NO"
                        ? (token.outcome.toUpperCase() as "YES" | "NO")
                        : "YES";
                      
                      marketOpportunities.push({
                        id: marketId,
                        tokenId,
                        side,
                        price: bestAsk,
                        liquidity: totalLiquidity,
                      });
                    }
                  }
                } catch (err) {
                  // Skip this token on error (might be resolved or have no orderbook)
                  this.logger.debug(
                    `[EndgameSweep] Failed to fetch orderbook for token ${tokenId}: ${err instanceof Error ? err.message : String(err)}`
                  );
                }
              }
              
              return marketOpportunities;
            } catch (err) {
              this.logger.debug(
                `[EndgameSweep] Failed to process market: ${err instanceof Error ? err.message : String(err)}`
              );
              return null;
            }
          })
        );
        
        // Collect results
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value) {
            opportunities.push(...result.value);
          }
        }
        
        // Small delay between batches
        if (i + maxConcurrent < response.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      // Sort by expected profit (1 - price) descending
      opportunities.sort((a, b) => (1 - a.price) - (1 - b.price));
      
      this.logger.debug(
        `[EndgameSweep] Found ${opportunities.length} opportunities in target price range`
      );
      
      // Log top 5 opportunities
      if (opportunities.length > 0) {
        const top5 = opportunities.slice(0, 5);
        this.logger.info(
          `[EndgameSweep] Top opportunities: ${top5.map(o => `${(o.price * 100).toFixed(1)}¢ (${((1 - o.price) * 100).toFixed(2)}% profit)`).join(", ")}`
        );
      }
      
      return opportunities;
    } catch (err) {
      this.logger.error(
        `[EndgameSweep] Failed to scan for opportunities: ${err instanceof Error ? err.message : String(err)}`,
        err as Error
      );
      return [];
    }
  }

  /**
   * Buy a position using postOrder utility
   * Executes market buy order at best ask price
   */
  private async buyPosition(market: Market): Promise<void> {
    // Validate market price before calculations
    if (market.price <= 0) {
      this.logger.warn(
        `[EndgameSweep] Invalid market price (${market.price}) for ${market.id}, skipping`
      );
      return;
    }

    // Calculate position size based on configured max and available liquidity
    const positionSize = Math.min(
      this.config.maxPositionUsd / market.price,
      market.liquidity * MAX_LIQUIDITY_USAGE_PCT // Don't take more than configured % of liquidity
    );

    // Validate position size before proceeding
    if (positionSize <= 0) {
      this.logger.warn(
        `[EndgameSweep] Invalid position size (${positionSize}) for ${market.id}, skipping`
      );
      return;
    }

    try {
      // Import postOrder utility
      const { postOrder } = await import("../utils/post-order.util");
      
      // Get fresh orderbook for current pricing
      const orderbook = await this.client.getOrderBook(market.tokenId);
      
      if (!orderbook.asks || orderbook.asks.length === 0) {
        throw new Error(`No asks available for token ${market.tokenId} - market may have closed`);
      }
      
      const bestAsk = parseFloat(orderbook.asks[0].price);
      const bestAskSize = parseFloat(orderbook.asks[0].size);
      
      // Re-validate price is still in range (may have changed)
      if (bestAsk < this.config.minPrice || bestAsk > this.config.maxPrice) {
        this.logger.warn(
          `[EndgameSweep] Price moved out of range: ${(bestAsk * 100).toFixed(1)}¢ (was ${(market.price * 100).toFixed(1)}¢)`
        );
        return;
      }
      
      this.logger.debug(
        `[EndgameSweep] Best ask: ${(bestAsk * 100).toFixed(1)}¢ (size: ${bestAskSize.toFixed(2)})`
      );
      
      // Calculate USD size for order
      const sizeUsd = positionSize * bestAsk;
      
      // Validate minimum order size
      const minOrderUsd = 10;
      if (sizeUsd < minOrderUsd) {
        this.logger.warn(
          `[EndgameSweep] Position too small: $${sizeUsd.toFixed(2)} < $${minOrderUsd} minimum`
        );
        return;
      }
      
      // Check LIVE_TRADING is enabled (supports both ARB_LIVE_TRADING and LIVE_TRADING)
      const liveTradingEnabled = isLiveTradingEnabled();
      if (!liveTradingEnabled) {
        this.logger.warn(
          `[EndgameSweep] Would buy ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)}) - LIVE TRADING DISABLED`
        );
        return;
      }
      
      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      
      // Calculate expected profit
      const expectedProfit = (1.0 - bestAsk) * positionSize;
      const expectedProfitPct = ((1.0 - bestAsk) / bestAsk) * 100;
      
      this.logger.info(
        `[EndgameSweep] Executing buy: ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)}, expected profit: $${expectedProfit.toFixed(2)} / ${expectedProfitPct.toFixed(2)}%)`
      );
      
      // Execute buy order
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: market.id,
        tokenId: market.tokenId,
        outcome: market.side,
        side: "BUY",
        sizeUsd,
        maxAcceptablePrice: bestAsk * 1.02, // Accept up to 2% slippage for endgame positions
        logger: this.logger,
        priority: false,
      });
      
      if (result.status === "submitted") {
        this.logger.info(
          `[EndgameSweep] ✓ Bought ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ (expected profit: $${expectedProfit.toFixed(2)})`
        );
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[EndgameSweep] Buy order skipped: ${result.reason ?? "unknown reason"}`
        );
        throw new Error(`Buy order skipped: ${result.reason ?? "unknown"}`);
      } else {
        this.logger.error(
          `[EndgameSweep] Buy order failed: ${result.reason ?? "unknown reason"}`
        );
        throw new Error(`Buy order failed: ${result.reason ?? "unknown"}`);
      }
      
    } catch (err) {
      // Re-throw error for caller to handle
      this.logger.error(
        `[EndgameSweep] Failed to buy position: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    purchasedCount: number;
    enabled: boolean;
    minPrice: number;
    maxPrice: number;
  } {
    return {
      purchasedCount: this.purchasedMarkets.size,
      enabled: this.config.enabled,
      minPrice: this.config.minPrice,
      maxPrice: this.config.maxPrice,
    };
  }

  /**
   * Clean up purchased markets older than 24 hours
   * This prevents the Set from growing indefinitely
   */
  private cleanupOldPurchases(): void {
    const now = Date.now();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    
    let cleanedCount = 0;
    for (const [marketKey, timestamp] of this.purchaseTimestamps.entries()) {
      if (now - timestamp > twentyFourHoursMs) {
        this.purchasedMarkets.delete(marketKey);
        this.purchaseTimestamps.delete(marketKey);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.logger.debug(
        `[EndgameSweep] Cleaned up ${cleanedCount} old purchase records`
      );
    }
  }

  /**
   * Reset purchased markets tracking (for testing or daily reset)
   */
  reset(): void {
    this.purchasedMarkets.clear();
    this.purchaseTimestamps.clear();
  }
}
