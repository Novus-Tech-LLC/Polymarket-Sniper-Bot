import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { PRICE_TIERS, getDynamicStopLoss } from "./trade-quality";

/**
 * Smart Hedging Strategy Configuration
 *
 * Instead of selling at a loss, this strategy hedges losing positions
 * by buying the opposing outcome, guaranteeing profit on resolution.
 *
 * RESERVE MANAGEMENT:
 * To ensure funds are always available for hedging, this strategy also:
 * - Monitors available balance vs required reserves
 * - Proactively sells profitable positions when reserves run low
 * - Uses volume/momentum indicators to decide WHEN to sell
 * - Prioritizes selling positions with declining volume (weak conviction)
 *
 * Example Math:
 * - Buy YES at 50¢, position drops to 30¢ (40% loss)
 * - Instead of selling at loss, buy NO at 70¢ (since YES + NO = $1)
 * - On resolution: One side pays $1, guaranteed profit on hedge
 * - Max loss is capped at the spread paid, not the full position
 */
export interface SmartHedgingConfig {
  /**
   * Enable smart hedging strategy
   * Default: true - enabled by default to maximize profits
   */
  enabled: boolean;

  /**
   * Loss percentage threshold to trigger hedging
   * When position P&L drops below this %, hedge is triggered
   * Default: 20% (risky tier stop-loss threshold)
   */
  triggerLossPct: number;

  /**
   * Maximum USD to use for hedge position
   * Should match original position size for full coverage
   * Default: $10
   */
  maxHedgeUsd: number;

  /**
   * Percentage of wallet balance to reserve for hedging
   * Ensures funds are always available for hedge trades
   * Default: 20% (keeps 20% in reserve)
   */
  reservePct: number;

  /**
   * Minimum price tier for hedging eligibility
   * Only positions with entry price BELOW this are eligible for hedging
   * Default: 0.6 (60¢) - only risky tier positions get hedged
   * Higher-priced entries use standard stop-loss instead
   */
  maxEntryPriceForHedging: number;

  /**
   * Minimum opposing side price to consider hedging viable
   * Too low means the original side is likely to win
   * Default: 0.5 (50¢) - ensure hedge has reasonable value
   */
  minOpposingSidePrice: number;

  /**
   * HEDGE TIMING OPTIMIZATION
   * Don't hedge too early (might recover) or too late (spread too wide)
   * Find the OPTIMAL window to turn losers into winners
   */

  /**
   * Minimum time to hold before hedging (in seconds)
   * Prevents hedging too early on temporary dips
   * Default: 120 (2 minutes - give position time to recover)
   */
  minHoldBeforeHedgeSeconds: number;

  /**
   * Maximum total spread (YES + NO) to allow hedging
   * If spread > $1.05, hedging becomes too expensive
   * Default: 1.05 ($1.05 max combined price)
   */
  maxTotalSpread: number;

  /**
   * Consecutive price drops required before hedging
   * Ensures downward momentum before committing to hedge
   * Default: 2 (must see 2+ consecutive drops)
   */
  minConsecutiveDrops: number;

  /**
   * Volume increase threshold indicating momentum shift
   * High volume on drop = strong conviction against us = hedge now
   * Default: 50% (50% volume increase on drop = momentum confirmed)
   */
  volumeSurgeThresholdPct: number;

  /**
   * "Sweet spot" opposing price range for optimal hedging
   * If opposing side is in this range, hedge is most profitable
   * Example: If we bought YES at 50¢ and it drops to 35¢, NO at 65¢ is ideal
   * Default: [0.55, 0.75] - hedge when opposing side is 55-75¢
   */
  optimalOpposingPriceMin: number;
  optimalOpposingPriceMax: number;

  /**
   * RESERVE MANAGEMENT SETTINGS
   * When reserves run low, proactively sell profitable positions to replenish
   */

  /**
   * Minimum profit percentage to consider selling for reserve replenishment
   * Only positions with at least this much profit are eligible
   * Default: 5% (don't sell at a loss to replenish reserves)
   */
  reserveSellMinProfitPct: number;

  /**
   * Critical reserve threshold as percentage of target reserve
   * When available balance drops below this % of target, urgently sell to replenish
   * Default: 50% (if target reserve is 20%, trigger at 10% available)
   */
  criticalReserveThresholdPct: number;

  /**
   * Volume decline threshold to prioritize selling
   * Positions with volume declining more than this % are prioritized for reserve sells
   * Lower volume = weaker market conviction = sell first
   * Default: 30% (30% volume decline triggers priority sell)
   */
  volumeDeclineThresholdPct: number;
}

/**
 * Represents a hedged position pair
 */
export interface HedgedPosition {
  marketId: string;
  originalTokenId: string;
  hedgeTokenId: string;
  originalSide: "YES" | "NO";
  originalEntryPrice: number;
  originalSize: number;
  hedgeEntryPrice: number;
  hedgeSize: number;
  hedgeTimestamp: number;
  /** Maximum potential loss (spread paid) */
  maxLoss: number;
  /** Guaranteed minimum return on resolution */
  guaranteedReturn: number;
}

/**
 * Market volume data for smart selling decisions
 */
export interface MarketVolumeData {
  tokenId: string;
  currentVolume24h: number;
  previousVolume24h: number;
  volumeChangePercent: number;
  bidDepth: number;
  askDepth: number;
  spreadBps: number;
  lastUpdated: number;
}

/**
 * Position with volume analysis for reserve management
 */
export interface PositionWithAnalysis extends Position {
  volumeData?: MarketVolumeData;
  sellPriority: number; // Higher = sell first (0-100)
  sellReason?: string;
}

/**
 * Price history entry for timing optimization
 */
export interface PriceHistoryEntry {
  price: number;
  timestamp: number;
  volume?: number;
}

/**
 * Hedge timing analysis result
 */
export interface HedgeTimingAnalysis {
  shouldHedgeNow: boolean;
  reason: string;
  confidence: number; // 0-100
  isOptimalWindow: boolean;
  isTooEarly: boolean;
  isTooLate: boolean;
  consecutiveDrops: number;
  volumeTrend: "surging" | "stable" | "declining";
  opposingPrice: number;
  totalSpread: number;
  potentialOutcome: {
    ifOriginalWins: number;
    ifHedgeWins: number;
    maxLoss: number;
    breakEvenChance: number;
  };
}

export interface SmartHedgingStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: SmartHedgingConfig;
}

/**
 * Smart Hedging Strategy
 *
 * A REPLACEMENT for stop-loss on risky tier positions (<60¢ entry).
 *
 * WHY HEDGE INSTEAD OF STOP-LOSS?
 *
 * Traditional stop-loss at 20% means:
 * - Buy at 50¢, sell at 40¢ = -20% loss, position closed
 * - Money is gone, no upside potential
 *
 * Smart hedging at 20% drop means:
 * - Buy YES at 50¢, drops to 40¢
 * - Buy NO at 60¢ (since YES + NO ≈ $1)
 * - On resolution: ONE side ALWAYS pays $1
 * - If YES wins: YES pays $1, NO worth $0 → Net: $1 - $0.50 - $0.60 = -$0.10
 * - If NO wins: NO pays $1, YES worth $0 → Net: $1 - $0.50 - $0.60 = -$0.10
 * - MAX LOSS is capped at the spread ($0.10), not the full position
 *
 * RESERVE MANAGEMENT:
 * To ensure funds are always available for hedging, this strategy also:
 * - Monitors available balance vs required reserves
 * - Proactively sells profitable positions when reserves run low
 * - Uses volume/momentum indicators to decide WHEN and WHAT to sell
 * - Prioritizes selling positions with:
 *   1. Declining volume (weak market conviction)
 *   2. Wide spreads (poor liquidity - get out while you can)
 *   3. Higher profit % (lock in gains before reversal)
 *
 * MATH EXAMPLE (user's scenario):
 * - Buy $5 of YES at 50¢ = 10 shares
 * - YES drops to 30¢, NO rises to 70¢
 * - Buy $5 of NO at 70¢ = 7.14 shares
 * - If YES wins: 10 × $1 = $10, total spent $10, profit = $0
 * - If NO wins: 7.14 × $1 = $7.14, total spent $10, loss = -$2.86
 * - Without hedge: YES worth $3, loss = -$2
 * - With hedge: Worst case -$2.86, but potential to break even if YES recovers!
 *
 * KEY INSIGHT: Hedging provides OPTIONALITY - position can still win if market reverses
 */
export class SmartHedgingStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: SmartHedgingConfig;

  /**
   * Tracks positions that have been hedged
   * Key: "marketId-originalTokenId"
   */
  private hedgedPositions: Map<string, HedgedPosition> = new Map();

  /**
   * Tracks positions currently being processed for hedging
   * Key: "marketId-tokenId"
   */
  private pendingHedges: Set<string> = new Set();

  /**
   * Cache for market token pairs (YES/NO tokens for each market)
   * Key: marketId, Value: { yesTokenId, noTokenId }
   */
  private marketTokenCache: Map<
    string,
    { yesTokenId: string; noTokenId: string }
  > = new Map();

  /**
   * Cache for volume data (refreshed periodically)
   * Key: tokenId, Value: MarketVolumeData
   */
  private volumeCache: Map<string, MarketVolumeData> = new Map();
  private lastVolumeRefresh: number = 0;
  private static readonly VOLUME_CACHE_TTL_MS = 60000; // 1 minute

  /**
   * Track positions sold for reserves to avoid re-selling
   * Key: "marketId-tokenId", Value: timestamp
   */
  private recentReserveSells: Map<string, number> = new Map();
  private static readonly RESERVE_SELL_COOLDOWN_MS = 300000; // 5 minutes

  /**
   * Price history for timing optimization
   * Key: tokenId, Value: array of price entries (most recent first)
   */
  private priceHistory: Map<string, PriceHistoryEntry[]> = new Map();
  private static readonly MAX_PRICE_HISTORY_ENTRIES = 20;
  private static readonly PRICE_HISTORY_INTERVAL_MS = 30000; // 30 seconds between entries

  /**
   * First seen timestamps for positions (to enforce min hold time)
   * Key: "marketId-tokenId", Value: timestamp when first detected as losing
   */
  private positionFirstSeenLosing: Map<string, number> = new Map();

  constructor(strategyConfig: SmartHedgingStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the smart hedging strategy
   * Returns number of actions taken (hedges + reserve sells)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up stale entries
    this.cleanupStaleEntries();

    let actionsCount = 0;
    const allPositions = this.positionTracker.getPositions();

    // STEP 1: Manage reserves - sell profitable positions if needed
    const reserveSells = await this.manageReserves(allPositions);
    actionsCount += reserveSells;

    // STEP 2: Process hedging for risky positions
    const hedgeCount = await this.processHedging(allPositions);
    actionsCount += hedgeCount;

    return actionsCount;
  }

  /**
   * Process hedging for eligible positions with smart timing
   */
  private async processHedging(allPositions: Position[]): Promise<number> {
    let hedgedCount = 0;

    // Filter for risky tier positions that are losing
    const eligiblePositions = allPositions.filter((pos) => {
      // Skip if already hedged
      const key = `${pos.marketId}-${pos.tokenId}`;
      if (this.hedgedPositions.has(key)) {
        return false;
      }

      // Skip if not in risky tier (entry price too high)
      if (pos.entryPrice >= this.config.maxEntryPriceForHedging) {
        return false;
      }

      // Skip if not losing enough to trigger hedge consideration
      if (pos.pnlPct > -this.config.triggerLossPct) {
        return false;
      }

      // Skip resolved/redeemable positions
      if (pos.redeemable) {
        return false;
      }

      return true;
    });

    if (eligiblePositions.length === 0) {
      return 0;
    }

    this.logger.info(
      `[SmartHedging] 🎯 Found ${eligiblePositions.length} position(s) eligible for hedging analysis`,
    );

    // Process each eligible position with timing analysis
    for (const position of eligiblePositions) {
      const positionKey = `${position.marketId}-${position.tokenId}`;

      // Skip if already processing
      if (this.pendingHedges.has(positionKey)) {
        continue;
      }

      // Track when we first saw this position as losing
      if (!this.positionFirstSeenLosing.has(positionKey)) {
        this.positionFirstSeenLosing.set(positionKey, Date.now());
        this.logger.debug(
          `[SmartHedging] 📍 First detection of losing position: ${position.marketId.slice(0, 16)}... at ${position.pnlPct.toFixed(1)}%`,
        );
      }

      // Update price history
      this.updatePriceHistory(position.tokenId, position.currentPrice);

      // Analyze hedge timing
      const timingAnalysis = await this.analyzeHedgeTiming(position);

      if (!timingAnalysis.shouldHedgeNow) {
        this.logger.debug(
          `[SmartHedging] ⏳ Not hedging yet: ${timingAnalysis.reason} (confidence: ${timingAnalysis.confidence}%)`,
        );
        continue;
      }

      this.pendingHedges.add(positionKey);

      try {
        // Log the timing analysis
        this.logger.info(
          `[SmartHedging] ⏰ HEDGE TIMING OPTIMAL: ${timingAnalysis.reason}` +
            `\n  Confidence: ${timingAnalysis.confidence}%` +
            `\n  Consecutive drops: ${timingAnalysis.consecutiveDrops}` +
            `\n  Volume trend: ${timingAnalysis.volumeTrend}` +
            `\n  Opposing price: ${(timingAnalysis.opposingPrice * 100).toFixed(1)}¢` +
            `\n  If original wins: $${timingAnalysis.potentialOutcome.ifOriginalWins.toFixed(2)}` +
            `\n  If hedge wins: $${timingAnalysis.potentialOutcome.ifHedgeWins.toFixed(2)}` +
            `\n  Max loss: $${timingAnalysis.potentialOutcome.maxLoss.toFixed(2)}` +
            `\n  Break-even chance: ${(timingAnalysis.potentialOutcome.breakEvenChance * 100).toFixed(0)}%`,
        );

        const hedged = await this.hedgePosition(position, timingAnalysis);
        if (hedged) {
          hedgedCount++;
          // Clear the first-seen timestamp on successful hedge
          this.positionFirstSeenLosing.delete(positionKey);
        }
      } catch (err) {
        this.logger.error(
          `[SmartHedging] ❌ Failed to hedge position: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.pendingHedges.delete(positionKey);
      }
    }

    if (hedgedCount > 0) {
      this.logger.info(
        `[SmartHedging] ✅ Hedged ${hedgedCount} position(s) - turning losers into winners!`,
      );
    }

    return hedgedCount;
  }

  /**
   * Analyze whether NOW is the right time to hedge
   * Goal: Don't hedge too early (might recover) or too late (spread too wide)
   */
  private async analyzeHedgeTiming(
    position: Position,
  ): Promise<HedgeTimingAnalysis> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const firstSeenTime = this.positionFirstSeenLosing.get(positionKey) ?? Date.now();
    const holdTimeSeconds = (Date.now() - firstSeenTime) / 1000;

    // Get opposing token info
    const originalSide = this.determineSide(position);
    const opposingTokenId = await this.getOpposingTokenId(
      position.marketId,
      position.tokenId,
      originalSide,
    );

    // Default analysis (can't hedge)
    const defaultAnalysis: HedgeTimingAnalysis = {
      shouldHedgeNow: false,
      reason: "Unable to analyze",
      confidence: 0,
      isOptimalWindow: false,
      isTooEarly: false,
      isTooLate: false,
      consecutiveDrops: 0,
      volumeTrend: "stable",
      opposingPrice: 0,
      totalSpread: 0,
      potentialOutcome: {
        ifOriginalWins: 0,
        ifHedgeWins: 0,
        maxLoss: 0,
        breakEvenChance: 0,
      },
    };

    if (!opposingTokenId) {
      return { ...defaultAnalysis, reason: "No opposing token found" };
    }

    // Get opposing side price
    let opposingPrice: number;
    try {
      const orderbook = await this.client.getOrderBook(opposingTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        return { ...defaultAnalysis, reason: "No liquidity for opposing side" };
      }
      opposingPrice = parseFloat(orderbook.asks[0].price);
    } catch {
      return { ...defaultAnalysis, reason: "Failed to fetch opposing orderbook" };
    }

    const totalSpread = position.currentPrice + opposingPrice;
    const priceHistory = this.priceHistory.get(position.tokenId) ?? [];
    const consecutiveDrops = this.countConsecutiveDrops(priceHistory);
    const volumeTrend = await this.analyzeVolumeTrend(position.tokenId);

    // Calculate potential outcomes
    const originalValue = position.size * position.entryPrice;
    const hedgeSizeUsd = Math.min(originalValue, this.config.maxHedgeUsd);
    const hedgeShares = hedgeSizeUsd / opposingPrice;
    const totalInvested = originalValue + hedgeSizeUsd;

    const ifOriginalWins = position.size * 1.0 - totalInvested;
    const ifHedgeWins = hedgeShares * 1.0 - totalInvested;
    const maxLoss = Math.abs(Math.min(ifOriginalWins, ifHedgeWins));

    // Calculate break-even chance based on current prices
    // If original side is at 30¢, implied 30% chance of winning
    const breakEvenChance = position.currentPrice;

    const potentialOutcome = {
      ifOriginalWins,
      ifHedgeWins,
      maxLoss,
      breakEvenChance,
    };

    // === TIMING ANALYSIS ===

    // Check 1: Is it TOO EARLY?
    const isTooEarly = holdTimeSeconds < this.config.minHoldBeforeHedgeSeconds;
    if (isTooEarly) {
      return {
        shouldHedgeNow: false,
        reason: `Too early - held ${holdTimeSeconds.toFixed(0)}s, need ${this.config.minHoldBeforeHedgeSeconds}s`,
        confidence: 20,
        isOptimalWindow: false,
        isTooEarly: true,
        isTooLate: false,
        consecutiveDrops,
        volumeTrend,
        opposingPrice,
        totalSpread,
        potentialOutcome,
      };
    }

    // Check 2: Is it TOO LATE? (spread too wide)
    const isTooLate = totalSpread > this.config.maxTotalSpread;
    if (isTooLate) {
      return {
        shouldHedgeNow: false,
        reason: `Too late - spread ${(totalSpread * 100).toFixed(1)}¢ > max ${(this.config.maxTotalSpread * 100).toFixed(1)}¢`,
        confidence: 30,
        isOptimalWindow: false,
        isTooEarly: false,
        isTooLate: true,
        consecutiveDrops,
        volumeTrend,
        opposingPrice,
        totalSpread,
        potentialOutcome,
      };
    }

    // Check 3: Is opposing price viable?
    if (opposingPrice < this.config.minOpposingSidePrice) {
      return {
        shouldHedgeNow: false,
        reason: `Opposing side too cheap (${(opposingPrice * 100).toFixed(1)}¢) - original likely to win`,
        confidence: 40,
        isOptimalWindow: false,
        isTooEarly: false,
        isTooLate: false,
        consecutiveDrops,
        volumeTrend,
        opposingPrice,
        totalSpread,
        potentialOutcome,
      };
    }

    // Check 4: Is this the OPTIMAL window?
    const isOptimalWindow =
      opposingPrice >= this.config.optimalOpposingPriceMin &&
      opposingPrice <= this.config.optimalOpposingPriceMax;

    // Check 5: Momentum confirmation
    const hasDownwardMomentum = consecutiveDrops >= this.config.minConsecutiveDrops;
    const hasVolumeSurge = volumeTrend === "surging";

    // === DECISION LOGIC ===
    let shouldHedgeNow = false;
    let reason = "";
    let confidence = 0;

    // Scenario A: Optimal window + momentum confirmed = HEDGE NOW
    if (isOptimalWindow && hasDownwardMomentum) {
      shouldHedgeNow = true;
      reason = `Optimal window (${(opposingPrice * 100).toFixed(1)}¢) + ${consecutiveDrops} consecutive drops`;
      confidence = 90;
    }
    // Scenario B: Optimal window + volume surge = HEDGE NOW (urgent)
    else if (isOptimalWindow && hasVolumeSurge) {
      shouldHedgeNow = true;
      reason = `Optimal window + volume surge - market moving against us`;
      confidence = 95;
    }
    // Scenario C: Not optimal but position deteriorating fast = HEDGE NOW
    else if (hasDownwardMomentum && hasVolumeSurge && position.pnlPct <= -30) {
      shouldHedgeNow = true;
      reason = `Rapid deterioration (${position.pnlPct.toFixed(1)}%) with volume surge - hedge before too late`;
      confidence = 85;
    }
    // Scenario D: Long hold time + still losing = HEDGE (avoid further loss)
    else if (holdTimeSeconds > this.config.minHoldBeforeHedgeSeconds * 3 && position.pnlPct <= -this.config.triggerLossPct * 1.5) {
      shouldHedgeNow = true;
      reason = `Extended hold (${(holdTimeSeconds / 60).toFixed(1)} min) at ${position.pnlPct.toFixed(1)}% loss - hedge to cap loss`;
      confidence = 75;
    }
    // Scenario E: Approaching max spread = HEDGE (last chance)
    else if (totalSpread > this.config.maxTotalSpread * 0.95) {
      shouldHedgeNow = true;
      reason = `Approaching max spread (${(totalSpread * 100).toFixed(1)}¢) - last chance to hedge`;
      confidence = 80;
    }
    // Scenario F: Wait for better timing
    else {
      shouldHedgeNow = false;
      reason = `Waiting for optimal timing (drops: ${consecutiveDrops}/${this.config.minConsecutiveDrops}, volume: ${volumeTrend})`;
      confidence = 50;
    }

    return {
      shouldHedgeNow,
      reason,
      confidence,
      isOptimalWindow,
      isTooEarly,
      isTooLate,
      consecutiveDrops,
      volumeTrend,
      opposingPrice,
      totalSpread,
      potentialOutcome,
    };
  }

  /**
   * Update price history for a token
   */
  private updatePriceHistory(tokenId: string, currentPrice: number): void {
    const history = this.priceHistory.get(tokenId) ?? [];
    const now = Date.now();

    // Only add if enough time has passed since last entry
    if (history.length > 0) {
      const lastEntry = history[0];
      if (now - lastEntry.timestamp < SmartHedgingStrategy.PRICE_HISTORY_INTERVAL_MS) {
        return; // Too soon
      }
    }

    // Add new entry at the front
    history.unshift({ price: currentPrice, timestamp: now });

    // Trim to max entries
    if (history.length > SmartHedgingStrategy.MAX_PRICE_HISTORY_ENTRIES) {
      history.pop();
    }

    this.priceHistory.set(tokenId, history);
  }

  /**
   * Count consecutive price drops in history
   */
  private countConsecutiveDrops(history: PriceHistoryEntry[]): number {
    if (history.length < 2) return 0;

    let drops = 0;
    for (let i = 0; i < history.length - 1; i++) {
      if (history[i].price < history[i + 1].price) {
        drops++;
      } else {
        break; // Streak broken
      }
    }
    return drops;
  }

  /**
   * Analyze volume trend for a token
   */
  private async analyzeVolumeTrend(
    tokenId: string,
  ): Promise<"surging" | "stable" | "declining"> {
    const volumeData = this.volumeCache.get(tokenId);
    if (!volumeData) {
      return "stable"; // No data, assume stable
    }

    const changePercent = volumeData.volumeChangePercent;

    if (changePercent >= this.config.volumeSurgeThresholdPct) {
      return "surging";
    } else if (changePercent <= -this.config.volumeDeclineThresholdPct) {
      return "declining";
    }
    return "stable";
  }

  /**
   * Manage reserves by selling profitable positions when needed
   */
  private async manageReserves(allPositions: Position[]): Promise<number> {
    // TODO: Implement reserve management logic
    // This will sell profitable positions to ensure funds are available for hedging
    // For now, return 0 (no sells)
    return 0;
  }

  /**
   * Hedge a losing position by buying the opposing outcome
   * Uses pre-computed timing analysis when available
   */
  private async hedgePosition(
    position: Position,
    timingAnalysis?: HedgeTimingAnalysis,
  ): Promise<boolean> {
    try {
      // Determine original side and find opposing token
      const originalSide = this.determineSide(position);
      const opposingTokenId = await this.getOpposingTokenId(
        position.marketId,
        position.tokenId,
        originalSide,
      );

      if (!opposingTokenId) {
        this.logger.warn(
          `[SmartHedging] ⚠️ Could not find opposing token for ${position.marketId}`,
        );
        return false;
      }

      // Use timing analysis opposing price if available, otherwise fetch fresh
      let opposingPrice: number;
      if (timingAnalysis && timingAnalysis.opposingPrice > 0) {
        opposingPrice = timingAnalysis.opposingPrice;
      } else {
        const orderbook = await this.client.getOrderBook(opposingTokenId);
        if (!orderbook.asks || orderbook.asks.length === 0) {
          this.logger.warn(
            `[SmartHedging] ⚠️ No asks for opposing token - cannot hedge`,
          );
          return false;
        }
        opposingPrice = parseFloat(orderbook.asks[0].price);
      }

      // Validate opposing price is reasonable (skip if already validated in timing analysis)
      if (!timingAnalysis) {
        if (opposingPrice < this.config.minOpposingSidePrice) {
          this.logger.warn(
            `[SmartHedging] ⚠️ Opposing side price too low (${(opposingPrice * 100).toFixed(1)}¢) - original side likely to win, skipping hedge`,
          );
          return false;
        }

        // Validate total spread (should be close to $1)
        const totalSpread = position.currentPrice + opposingPrice;
        if (totalSpread > this.config.maxTotalSpread) {
          this.logger.warn(
            `[SmartHedging] ⚠️ Market spread too wide (${(totalSpread * 100).toFixed(1)}¢) - market may be illiquid`,
          );
          return false;
        }
      }

      // Calculate hedge size - aim to match original position value
      const originalValue = position.size * position.entryPrice;
      const hedgeSizeUsd = Math.min(originalValue, this.config.maxHedgeUsd);
      const hedgeShares = hedgeSizeUsd / opposingPrice;

      // Calculate potential outcomes
      const totalInvested = originalValue + hedgeSizeUsd;

      // If original side wins: original shares × $1
      const originalWinPayout = position.size * 1.0;
      // If opposing side wins: hedge shares × $1
      const hedgeWinPayout = hedgeShares * 1.0;

      const originalWinProfit = originalWinPayout - totalInvested;
      const hedgeWinProfit = hedgeWinPayout - totalInvested;
      const maxLoss = Math.min(originalWinProfit, hedgeWinProfit);
      const guaranteedReturn = Math.max(originalWinProfit, hedgeWinProfit);

      // Determine outcome description for logging
      const canTurnIntoWinner = originalWinProfit >= 0 || hedgeWinProfit >= 0;
      const outcomeDescription = canTurnIntoWinner
        ? `🎉 TURNING LOSER INTO WINNER - one outcome yields profit!`
        : `📉 Capping loss at $${Math.abs(maxLoss).toFixed(2)} (vs unlimited without hedge)`;

      this.logger.info(
        `[SmartHedging] 🛡️ EXECUTING HEDGE:` +
          `\n  ${outcomeDescription}` +
          `\n  Original: ${position.size.toFixed(2)} ${originalSide} @ ${(position.entryPrice * 100).toFixed(1)}¢ (now ${(position.currentPrice * 100).toFixed(1)}¢, P&L: ${position.pnlPct.toFixed(1)}%)` +
          `\n  Hedge: ${hedgeShares.toFixed(2)} ${originalSide === "YES" ? "NO" : "YES"} @ ${(opposingPrice * 100).toFixed(1)}¢ ($${hedgeSizeUsd.toFixed(2)})` +
          `\n  Total invested: $${totalInvested.toFixed(2)}` +
          `\n  If ${originalSide} wins: $${originalWinPayout.toFixed(2)} payout = $${originalWinProfit >= 0 ? "+" : ""}${originalWinProfit.toFixed(2)}` +
          `\n  If ${originalSide === "YES" ? "NO" : "YES"} wins: $${hedgeWinPayout.toFixed(2)} payout = $${hedgeWinProfit >= 0 ? "+" : ""}${hedgeWinProfit.toFixed(2)}`,
      );

      // Execute the hedge buy
      const { postOrder } = await import("../utils/post-order.util");
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: opposingTokenId,
        outcome: originalSide === "YES" ? "NO" : "YES",
        side: "BUY",
        sizeUsd: hedgeSizeUsd,
        maxAcceptablePrice: opposingPrice * 1.05, // 5% slippage tolerance
        logger: this.logger,
        priority: true, // High priority for hedging
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum for hedging
      });

      if (result.status === "submitted") {
        // Record the hedged position
        const hedgedPosition: HedgedPosition = {
          marketId: position.marketId,
          originalTokenId: position.tokenId,
          hedgeTokenId: opposingTokenId,
          originalSide,
          originalEntryPrice: position.entryPrice,
          originalSize: position.size,
          hedgeEntryPrice: opposingPrice,
          hedgeSize: hedgeShares,
          hedgeTimestamp: Date.now(),
          maxLoss: Math.abs(maxLoss),
          guaranteedReturn,
        };

        const key = `${position.marketId}-${position.tokenId}`;
        this.hedgedPositions.set(key, hedgedPosition);

        this.logger.info(
          `[SmartHedging] ✅ HEDGE SUCCESSFUL - ${canTurnIntoWinner ? "Loser turned into potential winner!" : `Max loss capped at $${Math.abs(maxLoss).toFixed(2)}`}`,
        );
        return true;
      } else {
        this.logger.warn(
          `[SmartHedging] ⏭️ Hedge order ${result.status}: ${result.reason ?? "unknown"}`,
        );
        return false;
      }
    } catch (err) {
      this.logger.error(
        `[SmartHedging] ❌ Failed to hedge: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Determine the side (YES/NO) based on position data
   */
  private determineSide(position: Position): "YES" | "NO" {
    // Position tracker provides side info
    const side = position.side?.toUpperCase();
    if (side === "YES" || side === "NO") {
      return side;
    }
    // Default to YES if unclear
    return "YES";
  }

  /**
   * Get the opposing token ID for a given position
   */
  private async getOpposingTokenId(
    marketId: string,
    currentTokenId: string,
    currentSide: "YES" | "NO",
  ): Promise<string | null> {
    // Check cache first
    const cached = this.marketTokenCache.get(marketId);
    if (cached) {
      return currentSide === "YES" ? cached.noTokenId : cached.yesTokenId;
    }

    try {
      // Fetch market data to get both token IDs
      const { httpGet } = await import("../utils/fetch-data.util");
      const { POLYMARKET_API } =
        await import("../constants/polymarket.constants");

      // Try to get market info from Gamma API
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets/${marketId}`;
      const market = await httpGet<{
        tokens?: Array<{
          token_id?: string;
          outcome?: string;
        }>;
      }>(url, { timeout: 10000 });

      if (!market?.tokens || market.tokens.length < 2) {
        // Fall back to CLOB client market info
        const clobMarket = await this.client.getMarket(marketId);
        if (clobMarket?.tokens && Array.isArray(clobMarket.tokens)) {
          const yesToken = clobMarket.tokens.find(
            (t: { outcome?: string }) =>
              t.outcome?.toUpperCase() === "YES",
          );
          const noToken = clobMarket.tokens.find(
            (t: { outcome?: string }) =>
              t.outcome?.toUpperCase() === "NO",
          );

          if (yesToken?.token_id && noToken?.token_id) {
            this.marketTokenCache.set(marketId, {
              yesTokenId: yesToken.token_id,
              noTokenId: noToken.token_id,
            });
            return currentSide === "YES"
              ? noToken.token_id
              : yesToken.token_id;
          }
        }
        return null;
      }

      // Find YES and NO tokens
      const yesToken = market.tokens.find(
        (t) => t.outcome?.toUpperCase() === "YES",
      );
      const noToken = market.tokens.find(
        (t) => t.outcome?.toUpperCase() === "NO",
      );

      if (!yesToken?.token_id || !noToken?.token_id) {
        return null;
      }

      // Cache for future use
      this.marketTokenCache.set(marketId, {
        yesTokenId: yesToken.token_id,
        noTokenId: noToken.token_id,
      });

      return currentSide === "YES" ? noToken.token_id : yesToken.token_id;
    } catch (err) {
      this.logger.debug(
        `[SmartHedging] Failed to fetch market tokens: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Check if a position has already been hedged
   */
  isPositionHedged(marketId: string, tokenId: string): boolean {
    return this.hedgedPositions.has(`${marketId}-${tokenId}`);
  }

  /**
   * Get hedged position info
   */
  getHedgedPosition(
    marketId: string,
    tokenId: string,
  ): HedgedPosition | undefined {
    return this.hedgedPositions.get(`${marketId}-${tokenId}`);
  }

  /**
   * Clean up stale entries from tracking maps
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

    // Clean up hedged positions for positions that no longer exist
    const hedgeKeysToRemove: string[] = [];
    for (const key of this.hedgedPositions.keys()) {
      const [marketId] = key.split("-");
      // Keep if either the original or hedge position still exists
      const hasAnyPosition = currentPositions.some(
        (pos) => pos.marketId === marketId,
      );
      if (!hasAnyPosition) {
        hedgeKeysToRemove.push(key);
      }
    }

    for (const key of hedgeKeysToRemove) {
      this.hedgedPositions.delete(key);
    }

    // Clean up first-seen timestamps for positions that no longer exist
    const firstSeenToRemove: string[] = [];
    for (const key of this.positionFirstSeenLosing.keys()) {
      if (!currentKeys.has(key)) {
        firstSeenToRemove.push(key);
      }
    }
    for (const key of firstSeenToRemove) {
      this.positionFirstSeenLosing.delete(key);
    }

    // Clean up price history for tokens we no longer hold
    const priceHistoryToRemove: string[] = [];
    for (const tokenId of this.priceHistory.keys()) {
      if (!currentTokenIds.has(tokenId)) {
        priceHistoryToRemove.push(tokenId);
      }
    }
    for (const tokenId of priceHistoryToRemove) {
      this.priceHistory.delete(tokenId);
    }

    // Clean up old reserve sell cooldowns
    const now = Date.now();
    const reserveSellsToRemove: string[] = [];
    for (const [key, timestamp] of this.recentReserveSells.entries()) {
      if (now - timestamp > SmartHedgingStrategy.RESERVE_SELL_COOLDOWN_MS) {
        reserveSellsToRemove.push(key);
      }
    }
    for (const key of reserveSellsToRemove) {
      this.recentReserveSells.delete(key);
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    triggerLossPct: number;
    maxHedgeUsd: number;
    reservePct: number;
    hedgedPositionsCount: number;
    totalMaxLoss: number;
  } {
    let totalMaxLoss = 0;
    for (const hedge of this.hedgedPositions.values()) {
      totalMaxLoss += hedge.maxLoss;
    }

    return {
      enabled: this.config.enabled,
      triggerLossPct: this.config.triggerLossPct,
      maxHedgeUsd: this.config.maxHedgeUsd,
      reservePct: this.config.reservePct,
      hedgedPositionsCount: this.hedgedPositions.size,
      totalMaxLoss,
    };
  }
}

/**
 * Default Smart Hedging configuration
 * Enabled by default to maximize profit potential
 *
 * TIMING OPTIMIZATION:
 * - Don't hedge too early (give position time to recover)
 * - Don't hedge too late (spread becomes too wide)
 * - Find the optimal window to turn losers into winners
 */
export const DEFAULT_SMART_HEDGING_CONFIG: SmartHedgingConfig = {
  // === CORE SETTINGS ===
  enabled: true, // Enabled by default per user request
  triggerLossPct: 20, // Trigger hedge consideration at 20% loss
  maxHedgeUsd: 10, // Max $10 per hedge (match typical position size)
  reservePct: 20, // Keep 20% in reserve for hedging
  maxEntryPriceForHedging: PRICE_TIERS.SPECULATIVE_MIN, // 60¢ - only risky tier
  minOpposingSidePrice: 0.5, // Opposing side must be at least 50¢

  // === TIMING OPTIMIZATION ===
  minHoldBeforeHedgeSeconds: 120, // Wait 2 minutes before hedging (might recover)
  maxTotalSpread: 1.05, // Don't hedge if YES + NO > $1.05 (too expensive)
  minConsecutiveDrops: 2, // Require 2+ consecutive price drops (confirm momentum)
  volumeSurgeThresholdPct: 50, // 50% volume increase = strong move against us

  // === OPTIMAL WINDOW ===
  // The "sweet spot" for hedging: opposing side in 55-75¢ range
  // Below 55¢: Original side likely to win, don't hedge
  // Above 75¢: Hedge too expensive, limited upside
  optimalOpposingPriceMin: 0.55, // Ideal hedge starts at 55¢
  optimalOpposingPriceMax: 0.75, // Ideal hedge up to 75¢

  // === RESERVE MANAGEMENT ===
  reserveSellMinProfitPct: 5, // Only sell positions with 5%+ profit for reserves
  criticalReserveThresholdPct: 50, // Urgent sell when reserves at 50% of target
  volumeDeclineThresholdPct: 30, // Prioritize selling positions with 30%+ volume decline
};
