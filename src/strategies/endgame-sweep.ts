import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import { Contract, formatUnits } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker } from "./position-tracker";
import {
  MAX_LIQUIDITY_USAGE_PCT,
  calculateNetProfit,
  isProfitableAfterFees,
} from "./constants";
import { isLiveTradingEnabled } from "../utils/live-trading.util";
import { assessTradeQuality, SPREAD_TIERS } from "./trade-quality";
import { resolvePolymarketContracts } from "../polymarket/contracts";

// Minimum spendable balance (in USD) required to execute a buy
const MIN_SPENDABLE_BALANCE_USD = 1;

export interface EndgameSweepConfig {
  enabled: boolean;
  minPrice: number; // Minimum price to consider (e.g., 0.98 = 98¢)
  maxPrice: number; // Maximum price to consider (e.g., 0.995 = 99.5¢)
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
  spreadBps?: number; // Bid-ask spread in basis points
}

export interface EndgameSweepStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  config: EndgameSweepConfig;
  positionTracker?: PositionTracker; // Optional: used to check existing positions
  /** Optional callback to get the reserved balance that should not be spent (e.g., for Smart Hedging) */
  getReservedBalance?: () => number;
}

/**
 * Endgame Sweep Strategy
 *
 * OPTIMIZED FOR PROFITABLE SCALPING:
 * - Focus on high-confidence entries (85¢+) for reliable scalps
 * - Check spread quality before entering (avoid wide spreads)
 * - Assess trade quality using the trade-quality module
 * - Scale position size based on liquidity and confidence
 * - CHECK EXISTING POSITIONS to avoid exceeding max position size
 */
export class EndgameSweepStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: EndgameSweepConfig;
  private positionTracker?: PositionTracker;
  private purchasedMarkets: Set<string> = new Set();
  private purchaseTimestamps: Map<string, number> = new Map(); // Track when markets were purchased
  private getReservedBalance?: () => number;

  constructor(strategyConfig: EndgameSweepStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.config = strategyConfig.config;
    this.positionTracker = strategyConfig.positionTracker;
    this.getReservedBalance = strategyConfig.getReservedBalance;
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

      // Skip if already purchased by this strategy in this session
      if (this.purchasedMarkets.has(marketKey)) {
        continue;
      }

      // === CHECK FOR CONFLICTING POSITIONS ===
      // CRITICAL: Don't buy the opposite outcome if we already have a winning position in the same market.
      // This prevents the bot from betting against itself (e.g., buying NO when we have a winning YES).
      const conflictingPosition = this.getConflictingPosition(market.id, market.tokenId);
      if (conflictingPosition) {
        this.logger.info(
          `[EndgameSweep] ⏭️ Skipping ${market.id} (${market.side}): already have ${conflictingPosition.side} position ` +
            `at ${(conflictingPosition.pnlPct >= 0 ? "+" : "")}${conflictingPosition.pnlPct.toFixed(1)}% P&L - won't bet against own position`,
        );
        continue;
      }

      // === CHECK EXISTING POSITION SIZE ===
      // Prevent exceeding max position size by checking current exposure
      const existingPositionUsd = this.getExistingPositionSize(
        market.id,
        market.tokenId,
      );
      if (existingPositionUsd >= this.config.maxPositionUsd) {
        this.logger.debug(
          `[EndgameSweep] Skipping ${market.id}: already at max position ($${existingPositionUsd.toFixed(2)} >= $${this.config.maxPositionUsd})`,
        );
        continue;
      }

      // Calculate remaining capacity for this position
      const remainingCapacityUsd =
        this.config.maxPositionUsd - existingPositionUsd;
      if (remainingCapacityUsd < 1) {
        // Less than $1 remaining capacity, skip
        this.logger.debug(
          `[EndgameSweep] Skipping ${market.id}: insufficient remaining capacity ($${remainingCapacityUsd.toFixed(2)})`,
        );
        continue;
      }

      // === TRADE QUALITY ASSESSMENT ===
      // Use the trade-quality module to assess if this is a good scalp opportunity
      const quality = assessTradeQuality({
        entryPrice: market.price,
        spreadBps: market.spreadBps,
        liquidityUsd: market.liquidity,
        positionSizeUsd: remainingCapacityUsd, // Use remaining capacity for quality assessment
      });

      // Skip trades that should be avoided based on quality assessment
      if (quality.action === "AVOID") {
        this.logger.debug(
          `[EndgameSweep] Skipping ${market.id}: quality score ${quality.score} suggests AVOID (${quality.reasons.join(", ")})`,
        );
        continue;
      }

      // Check spread quality - avoid wide spreads that eat into profits
      if (
        market.spreadBps !== undefined &&
        market.spreadBps > SPREAD_TIERS.ACCEPTABLE_MAX
      ) {
        this.logger.debug(
          `[EndgameSweep] Skipping ${market.id} at ${(market.price * 100).toFixed(1)}¢ - spread too wide (${market.spreadBps}bps > ${SPREAD_TIERS.ACCEPTABLE_MAX}bps max)`,
        );
        continue;
      }

      // Calculate expected profit (gross and net)
      const expectedGrossProfitPct =
        ((1.0 - market.price) / market.price) * 100;
      const expectedNetProfitPct = calculateNetProfit(expectedGrossProfitPct);

      // Skip if not profitable after fees (minimum 0.5% net profit)
      if (!isProfitableAfterFees(expectedGrossProfitPct, 0.5)) {
        this.logger.debug(
          `[EndgameSweep] Skipping ${market.id} at ${(market.price * 100).toFixed(1)}¢ - insufficient margin (${expectedNetProfitPct.toFixed(2)}% net after fees)`,
        );
        continue;
      }

      // Log opportunity with quality assessment and existing position info
      const existingInfo =
        existingPositionUsd > 0
          ? ` [existing: $${existingPositionUsd.toFixed(2)}, remaining: $${remainingCapacityUsd.toFixed(2)}]`
          : "";
      this.logger.info(
        `[EndgameSweep] 💰 Opportunity: ${market.id} at ${(market.price * 100).toFixed(1)}¢ ` +
          `(quality: ${quality.score}/100, spread: ${market.spreadBps ?? "N/A"}bps, ` +
          `gross: ${expectedGrossProfitPct.toFixed(2)}%, net: ${expectedNetProfitPct.toFixed(2)}%)${existingInfo}`,
      );

      try {
        // Pass remaining capacity to buyPosition to limit the purchase
        await this.buyPosition(market, remainingCapacityUsd);
        this.purchasedMarkets.add(marketKey);
        this.purchaseTimestamps.set(marketKey, Date.now());
        purchasedCount++;
      } catch (err) {
        this.logger.error(
          `[EndgameSweep] ❌ Failed to buy position ${market.id}`,
          err as Error,
        );
      }
    }

    if (purchasedCount > 0) {
      this.logger.info(
        `[EndgameSweep] ✅ Purchased ${purchasedCount} endgame positions`,
      );
    }

    return purchasedCount;
  }

  /**
   * Scan for endgame opportunities
   * Fetches markets from Gamma API and filters by price range
   * Enhanced with spread calculation for trade quality assessment
   */
  private async scanForEndgameOpportunities(): Promise<Market[]> {
    this.logger.debug(
      `[EndgameSweep] Scanning for positions between ${(this.config.minPrice * 100).toFixed(1)}¢ and ${(this.config.maxPrice * 100).toFixed(1)}¢`,
    );

    try {
      // Import utilities
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

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

      this.logger.debug(
        `[EndgameSweep] Fetched ${response.length} markets from Gamma API`,
      );

      // Filter and map markets to opportunities
      const opportunities: Market[] = [];
      const maxConcurrent = 3; // Rate limit orderbook fetches

      for (let i = 0; i < response.length; i += maxConcurrent) {
        const batch = response.slice(i, i + maxConcurrent);

        const batchResults = await Promise.allSettled(
          batch.map(async (market) => {
            try {
              // Skip if market is closed or not accepting orders
              if (
                market.closed ||
                market.archived ||
                !market.accepting_orders ||
                !market.enable_order_book
              ) {
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

                  // Calculate spread if bids are available
                  let spreadBps: number | undefined;
                  if (orderbook.bids && orderbook.bids.length > 0) {
                    const bestBid = parseFloat(orderbook.bids[0].price);
                    // Spread = (ask - bid) / midpoint * 10000 (in basis points)
                    const midpoint = (bestAsk + bestBid) / 2;
                    if (midpoint > 0) {
                      spreadBps = Math.round(
                        ((bestAsk - bestBid) / midpoint) * 10000,
                      );
                    }
                  }

                  // Check if price is in target range
                  if (
                    bestAsk >= this.config.minPrice &&
                    bestAsk <= this.config.maxPrice
                  ) {
                    // Calculate total liquidity in target range
                    const totalLiquidity = orderbook.asks
                      .filter((level) => {
                        const price = parseFloat(level.price);
                        return (
                          price >= this.config.minPrice &&
                          price <= this.config.maxPrice
                        );
                      })
                      .reduce((sum, level) => sum + parseFloat(level.size), 0);

                    // Convert liquidity from shares to USD
                    const liquidityUsd = totalLiquidity * bestAsk;

                    // Only consider if there's sufficient liquidity
                    const minLiquidity = this.config.maxPositionUsd / bestAsk;
                    if (totalLiquidity >= minLiquidity * 0.5) {
                      const side =
                        token.outcome?.toUpperCase() === "YES" ||
                        token.outcome?.toUpperCase() === "NO"
                          ? (token.outcome.toUpperCase() as "YES" | "NO")
                          : "YES";

                      marketOpportunities.push({
                        id: marketId,
                        tokenId,
                        side,
                        price: bestAsk,
                        liquidity: liquidityUsd, // Converted from shares to USD (shares * price)
                        spreadBps, // Include spread for quality assessment
                      });
                    }
                  }
                } catch (err) {
                  // Skip this token on error (might be resolved or have no orderbook)
                  this.logger.debug(
                    `[EndgameSweep] Failed to fetch orderbook for token ${tokenId}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }

              return marketOpportunities;
            } catch (err) {
              this.logger.debug(
                `[EndgameSweep] Failed to process market: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            }
          }),
        );

        // Collect results
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value) {
            opportunities.push(...result.value);
          }
        }

        // Small delay between batches
        if (i + maxConcurrent < response.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // Sort by expected profit (1 - price) descending (lower price = higher profit potential)
      opportunities.sort((a, b) => 1 - a.price - (1 - b.price));

      this.logger.debug(
        `[EndgameSweep] Found ${opportunities.length} opportunities in target price range`,
      );

      // Log top 5 opportunities
      if (opportunities.length > 0) {
        const top5 = opportunities.slice(0, 5);
        this.logger.info(
          `[EndgameSweep] 🎯 Top opportunities: ${top5.map((o) => `${(o.price * 100).toFixed(1)}¢ (${((1 - o.price) * 100).toFixed(2)}% profit)`).join(", ")}`,
        );
      }

      return opportunities;
    } catch (err) {
      this.logger.error(
        `[EndgameSweep] ❌ Failed to scan for opportunities: ${err instanceof Error ? err.message : String(err)}`,
        err as Error,
      );
      return [];
    }
  }

  /**
   * Get existing position size in USD for a market/token
   * Returns 0 if no position exists or positionTracker is not available
   */
  private getExistingPositionSize(marketId: string, tokenId: string): number {
    if (!this.positionTracker) {
      return 0;
    }

    const positions = this.positionTracker.getPositions();
    let totalExposureUsd = 0;

    for (const pos of positions) {
      // Check for the same market AND token to avoid summing unrelated positions
      // A position matches if it's in the same market with the same token
      if (pos.marketId === marketId && pos.tokenId === tokenId) {
        // Position value = size * entry price (what we paid)
        totalExposureUsd += pos.size * pos.entryPrice;
      }
    }

    return totalExposureUsd;
  }

  /**
   * Check if there's a conflicting position in the same market (different outcome).
   * Returns the conflicting position if:
   * 1. We have a position in the same market but different tokenId (opposite outcome)
   * 2. That position is winning (positive P&L)
   * 
   * This prevents the bot from betting against its own winning positions.
   * For example, if we have YES at +20% profit, we shouldn't buy NO.
   */
  private getConflictingPosition(
    marketId: string,
    targetTokenId: string,
  ): { side: string; pnlPct: number; size: number } | null {
    if (!this.positionTracker) {
      return null;
    }

    const positions = this.positionTracker.getPositions();

    for (const pos of positions) {
      // Check for positions in the same market but with a DIFFERENT token
      // (i.e., the opposite outcome)
      if (pos.marketId === marketId && pos.tokenId !== targetTokenId) {
        // Only block if the existing position is winning (positive P&L)
        // We don't want to bet against our own winning position
        if (pos.pnlPct >= 0) {
          return {
            side: pos.side,
            pnlPct: pos.pnlPct,
            size: pos.size,
          };
        }
      }
    }

    return null;
  }

  /**
   * Buy a position using postOrder utility
   * Executes market buy order at best ask price
   * @param market - Market opportunity to buy
   * @param maxBuyUsd - Maximum USD to spend (respects existing position limits)
   */
  private async buyPosition(
    market: Market,
    maxBuyUsd?: number,
  ): Promise<void> {
    // Validate market price before calculations
    if (market.price <= 0) {
      this.logger.warn(
        `[EndgameSweep] ⚠️ Invalid market price (${market.price}) for ${market.id}, skipping`,
      );
      return;
    }

    // Check if we need to respect reserved balance (for Smart Hedging)
    if (this.getReservedBalance) {
      const reservedBalance = this.getReservedBalance();
      if (reservedBalance > 0) {
        // Get wallet balance to check available funds
        const wallet = (this.client as { wallet?: Wallet }).wallet;
        if (wallet?.provider) {
          try {
            const contracts = resolvePolymarketContracts();
            const usdcContract = new Contract(
              contracts.usdcAddress,
              ["function balanceOf(address) view returns (uint256)"],
              wallet.provider,
            );
            const balanceRaw = await usdcContract.balanceOf(wallet.address);
            const availableBalance = parseFloat(formatUnits(balanceRaw, 6));
            const spendableBalance = availableBalance - reservedBalance;
            
            if (spendableBalance < MIN_SPENDABLE_BALANCE_USD) {
              this.logger.debug(
                `[EndgameSweep] Skipping purchase: insufficient balance after reserve ` +
                `(available: $${availableBalance.toFixed(2)}, reserved: $${reservedBalance.toFixed(2)}, spendable: $${spendableBalance.toFixed(2)})`,
              );
              return;
            }
            
            // Reduce maxBuyUsd to respect reserve
            if (maxBuyUsd === undefined || maxBuyUsd > spendableBalance) {
              this.logger.debug(
                `[EndgameSweep] Limiting buy to spendable balance: $${spendableBalance.toFixed(2)} (reserved $${reservedBalance.toFixed(2)} for hedging)`,
              );
              maxBuyUsd = spendableBalance;
            }
          } catch (err) {
            this.logger.debug(
              `[EndgameSweep] Could not check balance for reserve: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // Use the smaller of maxPositionUsd and maxBuyUsd (remaining capacity)
    const effectiveMaxUsd = maxBuyUsd
      ? Math.min(this.config.maxPositionUsd, maxBuyUsd)
      : this.config.maxPositionUsd;

    // Calculate position size based on effective max and available liquidity
    const positionSize = Math.min(
      effectiveMaxUsd / market.price,
      market.liquidity * MAX_LIQUIDITY_USAGE_PCT, // Don't take more than configured % of liquidity
    );

    // Validate position size before proceeding
    if (positionSize <= 0) {
      this.logger.warn(
        `[EndgameSweep] ⚠️ Invalid position size (${positionSize}) for ${market.id}, skipping`,
      );
      return;
    }

    try {
      // Import postOrder utility
      const { postOrder } = await import("../utils/post-order.util");

      // Get fresh orderbook for current pricing
      const orderbook = await this.client.getOrderBook(market.tokenId);

      if (!orderbook.asks || orderbook.asks.length === 0) {
        throw new Error(
          `No asks available for token ${market.tokenId} - market may have closed`,
        );
      }

      const bestAsk = parseFloat(orderbook.asks[0].price);
      const bestAskSize = parseFloat(orderbook.asks[0].size);

      // Re-validate price is still in range (may have changed)
      if (bestAsk < this.config.minPrice || bestAsk > this.config.maxPrice) {
        this.logger.warn(
          `[EndgameSweep] ⚠️ Price moved out of range: ${(bestAsk * 100).toFixed(1)}¢ (was ${(market.price * 100).toFixed(1)}¢)`,
        );
        return;
      }

      this.logger.debug(
        `[EndgameSweep] Best ask: ${(bestAsk * 100).toFixed(1)}¢ (size: ${bestAskSize.toFixed(2)})`,
      );

      // Calculate USD size for order
      const sizeUsd = positionSize * bestAsk;

      // Check LIVE_TRADING is enabled (supports both ARB_LIVE_TRADING and LIVE_TRADING)
      const liveTradingEnabled = isLiveTradingEnabled();
      if (!liveTradingEnabled) {
        this.logger.warn(
          `[EndgameSweep] 🔒 Would buy ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)}) - LIVE TRADING DISABLED`,
        );
        return;
      }

      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      // Calculate expected profit
      const expectedProfit = (1.0 - bestAsk) * positionSize;
      const expectedProfitPct = ((1.0 - bestAsk) / bestAsk) * 100;

      this.logger.info(
        `[EndgameSweep] 🛒 Executing buy: ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)}, expected profit: $${expectedProfit.toFixed(2)} / ${expectedProfitPct.toFixed(2)}%)`,
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
          `[EndgameSweep] ✅ Bought ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ (expected profit: $${expectedProfit.toFixed(2)})`,
        );
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[EndgameSweep] ⏭️ Buy order skipped: ${result.reason ?? "unknown reason"}`,
        );
        throw new Error(`Buy order skipped: ${result.reason ?? "unknown"}`);
      } else if (result.reason === "FOK_ORDER_KILLED") {
        // FOK order was submitted but killed (no fill) - market has insufficient liquidity
        this.logger.warn(
          `[EndgameSweep] ⚠️ Buy order not filled (FOK killed): ${positionSize.toFixed(2)} shares at ${(bestAsk * 100).toFixed(1)}¢ - market has insufficient liquidity`,
        );
        throw new Error(`Buy order not filled: market has insufficient liquidity`);
      } else {
        this.logger.error(
          `[EndgameSweep] ❌ Buy order failed: ${result.reason ?? "unknown reason"}`,
        );
        throw new Error(`Buy order failed: ${result.reason ?? "unknown"}`);
      }
    } catch (err) {
      // Re-throw error for caller to handle
      this.logger.error(
        `[EndgameSweep] ❌ Failed to buy position: ${err instanceof Error ? err.message : String(err)}`,
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
        `[EndgameSweep] Cleaned up ${cleanedCount} old purchase records`,
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
