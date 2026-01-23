/**
 * Market Selector - Universe Filter
 *
 * Filters markets to only trade those that satisfy quality criteria:
 * - Adequate liquidity (top-of-book depth on both sides)
 * - Tight spread
 * - Recent activity
 * - Clear resolution source
 * - No active cooldowns
 * - API health OK
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { MarketData, CooldownEntry } from "./types";

/**
 * Market filter configuration
 * Sensible defaults built-in
 */
export interface MarketSelectorConfig {
  /** Minimum top-of-book depth in USD on both sides (default: $500) */
  minDepthUsd?: number;
  /** Maximum spread in cents (default: 5¢) */
  maxSpreadCents?: number;
  /** Minimum trades in last N minutes (default: 1) */
  minRecentTrades?: number;
  /** Window for recent trades check in minutes (default: 30) */
  recentTradesWindowMin?: number;
  /** Minimum 24h volume in USD (default: $1000) */
  minVolume24hUsd?: number;
  /** Exclude specific categories (default: none) */
  excludeCategories?: string[];
  /** Maximum markets to return (default: 50) */
  maxMarkets?: number;
  /** Cache TTL in seconds (default: 30) */
  cacheTtlSeconds?: number;
}

const DEFAULT_CONFIG: Required<MarketSelectorConfig> = {
  minDepthUsd: 500,
  maxSpreadCents: 5,
  minRecentTrades: 1,
  recentTradesWindowMin: 30,
  minVolume24hUsd: 1000,
  excludeCategories: [],
  maxMarkets: 50,
  cacheTtlSeconds: 30,
};

/**
 * Preset configurations for different trading styles
 */
export const MARKET_SELECTOR_PRESETS: Record<
  string,
  Partial<MarketSelectorConfig>
> = {
  conservative: {
    minDepthUsd: 2000,
    maxSpreadCents: 2,
    minRecentTrades: 5,
    minVolume24hUsd: 10000,
    maxMarkets: 20,
  },
  balanced: {
    minDepthUsd: 1000,
    maxSpreadCents: 3,
    minRecentTrades: 2,
    minVolume24hUsd: 5000,
    maxMarkets: 30,
  },
  aggressive: {
    minDepthUsd: 500,
    maxSpreadCents: 5,
    minRecentTrades: 1,
    minVolume24hUsd: 1000,
    maxMarkets: 50,
  },
};

export class MarketSelector {
  private config: Required<MarketSelectorConfig>;
  private logger: ConsoleLogger;
  private client: ClobClient;

  // Cache
  private marketCache: Map<string, MarketData> = new Map();
  private lastCacheUpdate: number = 0;

  // Cooldown tracking (shared with RiskManager)
  private cooldownTokens: Set<string> = new Set();

  constructor(
    client: ClobClient,
    logger: ConsoleLogger,
    config?: MarketSelectorConfig,
  ) {
    this.client = client;
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get filtered markets that meet all criteria
   */
  async getEligibleMarkets(): Promise<MarketData[]> {
    // Check cache freshness
    const cacheAge = (Date.now() - this.lastCacheUpdate) / 1000;
    if (cacheAge < this.config.cacheTtlSeconds && this.marketCache.size > 0) {
      return this.filterMarkets(Array.from(this.marketCache.values()));
    }

    try {
      // Fetch markets from Gamma API
      const markets = await this.fetchMarkets();

      // Update cache
      this.marketCache.clear();
      for (const market of markets) {
        this.marketCache.set(market.marketId, market);
      }
      this.lastCacheUpdate = Date.now();

      return this.filterMarkets(markets);
    } catch (err) {
      this.logger.error(
        `[MarketSelector] Failed to fetch markets: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Return cached data if available
      if (this.marketCache.size > 0) {
        this.logger.warn(
          "[MarketSelector] Using stale cache due to fetch error",
        );
        return this.filterMarkets(Array.from(this.marketCache.values()));
      }
      return [];
    }
  }

  /**
   * Check if a specific token is eligible for trading
   */
  async isMarketEligible(
    tokenId: string,
  ): Promise<{ eligible: boolean; reason?: string }> {
    try {
      const market = await this.getMarketData(tokenId);
      if (!market) {
        return { eligible: false, reason: "MARKET_NOT_FOUND" };
      }
      return this.checkEligibility(market);
    } catch (err) {
      return {
        eligible: false,
        reason: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get market data for a specific market/token
   * Note: In Polymarket, tokenId is the unique identifier for an outcome position.
   * The caller should provide the correct tokenId.
   */
  async getMarketData(tokenId: string): Promise<MarketData | null> {
    // Check cache first
    const cached = this.marketCache.get(tokenId);
    const cacheAge = (Date.now() - this.lastCacheUpdate) / 1000;
    if (cached && cacheAge < this.config.cacheTtlSeconds) {
      return cached;
    }

    try {
      // Fetch fresh data using tokenId (the CLOB orderbook uses tokenId)
      const orderbook = await this.client.getOrderBook(tokenId);

      if (!orderbook) return null;

      const bestBid = orderbook.bids?.[0]
        ? parseFloat(orderbook.bids[0].price)
        : 0;
      const bestAsk = orderbook.asks?.[0]
        ? parseFloat(orderbook.asks[0].price)
        : 1;

      const bidDepth = this.calculateDepth(orderbook.bids ?? []);
      const askDepth = this.calculateDepth(orderbook.asks ?? []);

      const spread = (bestAsk - bestBid) * 100; // Convert to cents
      const midPrice = (bestBid + bestAsk) / 2;
      const spreadBps = midPrice > 0 ? (spread / midPrice) * 100 : 0;

      // Extract marketId from orderbook if available, otherwise derive from context
      // In real usage, the caller should know the marketId
      const marketId =
        (orderbook as { market_id?: string }).market_id ?? tokenId;

      const market: MarketData = {
        marketId,
        tokenId, // Use the provided tokenId
        question: "",
        midPrice,
        bestBid,
        bestAsk,
        spread,
        spreadBps,
        bidDepth,
        askDepth,
        lastUpdate: Date.now(),
        isHealthy: bestBid > 0 && bestAsk < 1 && spread < 50, // Basic sanity check
      };

      this.marketCache.set(tokenId, market);
      return market;
    } catch (err) {
      this.logger.debug(
        `[MarketSelector] Error fetching market ${tokenId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Register a token cooldown (from order rejection)
   */
  addCooldown(tokenId: string): void {
    this.cooldownTokens.add(tokenId);
  }

  /**
   * Clear a token cooldown
   */
  clearCooldown(tokenId: string): void {
    this.cooldownTokens.delete(tokenId);
  }

  /**
   * Update cooldowns from RiskManager
   */
  syncCooldowns(cooldowns: CooldownEntry[]): void {
    this.cooldownTokens.clear();
    for (const entry of cooldowns) {
      if (Date.now() < entry.cooldownUntil) {
        this.cooldownTokens.add(entry.tokenId);
      }
    }
  }

  /**
   * Fetch markets from API
   */
  private async fetchMarkets(): Promise<MarketData[]> {
    // This would typically fetch from Gamma API
    // For now, return empty - real implementation would integrate with API
    this.logger.debug("[MarketSelector] Fetching markets from API...");

    // Placeholder - in real implementation:
    // const response = await fetch(`${GAMMA_API_BASE_URL}/markets`);
    // const data = await response.json();
    // return data.markets.map(m => this.transformMarket(m));

    return [];
  }

  /**
   * Filter markets by criteria
   */
  private filterMarkets(markets: MarketData[]): MarketData[] {
    const filtered = markets.filter((market) => {
      const result = this.checkEligibility(market);
      return result.eligible;
    });

    // Sort by liquidity (prefer more liquid markets)
    filtered.sort(
      (a, b) => b.bidDepth + b.askDepth - (a.bidDepth + a.askDepth),
    );

    // Limit to max markets
    return filtered.slice(0, this.config.maxMarkets);
  }

  /**
   * Check if market meets all eligibility criteria
   */
  private checkEligibility(market: MarketData): {
    eligible: boolean;
    reason?: string;
  } {
    // 1. Cooldown check
    if (this.cooldownTokens.has(market.tokenId)) {
      return { eligible: false, reason: "COOLDOWN_ACTIVE" };
    }

    // 2. Health check
    if (!market.isHealthy) {
      return { eligible: false, reason: "UNHEALTHY_MARKET" };
    }

    // 3. Spread check
    if (market.spread > this.config.maxSpreadCents) {
      return {
        eligible: false,
        reason: `SPREAD_TOO_WIDE: ${market.spread.toFixed(1)}¢ > ${this.config.maxSpreadCents}¢`,
      };
    }

    // 4. Bid depth check
    if (market.bidDepth < this.config.minDepthUsd) {
      return {
        eligible: false,
        reason: `BID_DEPTH_LOW: $${market.bidDepth.toFixed(0)} < $${this.config.minDepthUsd}`,
      };
    }

    // 5. Ask depth check
    if (market.askDepth < this.config.minDepthUsd) {
      return {
        eligible: false,
        reason: `ASK_DEPTH_LOW: $${market.askDepth.toFixed(0)} < $${this.config.minDepthUsd}`,
      };
    }

    // 6. Volume check (if available)
    if (
      market.volume24h !== undefined &&
      market.volume24h < this.config.minVolume24hUsd
    ) {
      return {
        eligible: false,
        reason: `VOLUME_LOW: $${market.volume24h.toFixed(0)} < $${this.config.minVolume24hUsd}`,
      };
    }

    // 7. Recent trades check (if available)
    if (
      market.tradesLast5Min !== undefined &&
      market.tradesLast5Min < this.config.minRecentTrades
    ) {
      return {
        eligible: false,
        reason: `INACTIVE: ${market.tradesLast5Min} trades < ${this.config.minRecentTrades}`,
      };
    }

    // 8. Category exclusion
    if (
      market.category &&
      this.config.excludeCategories.includes(market.category)
    ) {
      return {
        eligible: false,
        reason: `EXCLUDED_CATEGORY: ${market.category}`,
      };
    }

    return { eligible: true };
  }

  /**
   * Calculate total depth from orderbook levels
   */
  private calculateDepth(
    levels: Array<{ price: string; size: string }>,
  ): number {
    // Sum up the first 5 levels (or configurable)
    const maxLevels = 5;
    let depth = 0;

    for (let i = 0; i < Math.min(levels.length, maxLevels); i++) {
      const price = parseFloat(levels[i].price);
      const size = parseFloat(levels[i].size);
      depth += price * size;
    }

    return depth;
  }

  /**
   * Get selector stats for monitoring
   */
  getStats(): {
    cachedMarkets: number;
    eligibleMarkets: number;
    cooldownTokens: number;
    cacheAgeSeconds: number;
  } {
    const eligible = this.filterMarkets(Array.from(this.marketCache.values()));
    return {
      cachedMarkets: this.marketCache.size,
      eligibleMarkets: eligible.length,
      cooldownTokens: this.cooldownTokens.size,
      cacheAgeSeconds: (Date.now() - this.lastCacheUpdate) / 1000,
    };
  }
}

/**
 * Create MarketSelector with preset configuration
 */
export function createMarketSelector(
  client: ClobClient,
  logger: ConsoleLogger,
  preset: "conservative" | "balanced" | "aggressive",
  overrides?: Partial<MarketSelectorConfig>,
): MarketSelector {
  const config = {
    ...MARKET_SELECTOR_PRESETS[preset],
    ...overrides,
  };
  return new MarketSelector(client, logger, config);
}
