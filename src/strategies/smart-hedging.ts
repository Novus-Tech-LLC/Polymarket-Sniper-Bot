import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { PRICE_TIERS } from "./trade-quality";
import { postOrder } from "../utils/post-order.util";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";

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
   * Maximum USD to use for hedge position (standard limit)
   * Should match original position size for full coverage
   * Default: $10
   */
  maxHedgeUsd: number;

  /**
   * Minimum USD to use for a hedge position
   * Hedges below this size are skipped (not worth the transaction)
   * Prevents creating micro-hedges (e.g., 0.3 shares) that don't provide meaningful protection
   * Default: $1 (any hedge below $1 is skipped)
   */
  minHedgeUsd: number;

  /**
   * Allow hedge to EXCEED maxHedgeUsd when stopping heavy losses
   * When true, hedge size can match original position even if > maxHedgeUsd
   * This ensures we can fully protect large losing positions
   * Default: true (don't let limits prevent proper protection)
   */
  allowExceedMaxForProtection: boolean;

  /**
   * Absolute maximum USD for hedge even when exceeding limits
   * Acts as a safety cap to prevent runaway hedging
   * Only applies when allowExceedMaxForProtection is true
   * Default: $100 (never hedge more than this regardless of position size)
   */
  absoluteMaxHedgeUsd: number;

  /**
   * Loss percentage threshold to trigger "emergency" hedging (bypass limits)
   * When position drops beyond this %, allow exceeding maxHedgeUsd
   * Default: 30% (severe loss = need full protection)
   */
  emergencyLossThresholdPct: number;

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
   * Default: 2% (lowered from 5% to enable hedging when no highly profitable positions exist)
   * Note: In emergency mode (severe losses), this threshold drops to 0.1% to ensure hedging can occur
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

  /**
   * FALLBACK LIQUIDATION SETTINGS
   * When hedging cannot execute, fall back to selling the losing position
   */

  /**
   * Enable fallback liquidation when hedging fails
   * When true, if a hedge cannot execute (insufficient funds, order fails, etc.),
   * the position will be liquidated instead of left to decay further.
   * Default: true (don't let losers sit and go to zero)
   */
  enableFallbackLiquidation: boolean;

  /**
   * Loss percentage threshold for forced liquidation (catastrophic loss protection)
   * When position drops beyond this %, force liquidate even if hedging timing isn't optimal.
   * This is a safety mechanism to prevent positions from going to zero.
   * Default: 50% (at 50%+ loss, cut losses immediately)
   */
  forceLiquidationLossPct: number;
}

/**
 * Hedge calculation details for transparency
 */
export interface HedgeCalculation {
  /** Original position investment */
  originalInvestment: number;
  /** Current value of original position */
  currentValue: number;
  /** Unrealized loss on original position */
  unrealizedLoss: number;
  /** Price of opposing side when hedged */
  hedgePrice: number;
  /** Minimum hedge size to break even */
  breakEvenHedgeSize: number;
  /** Hedge size needed to profit if hedge wins */
  profitableHedgeSize: number;
  /** Actual hedge size used */
  actualHedgeSize: number;
  /** Profit if original side wins */
  profitIfOriginalWins: number;
  /** Profit if hedge side wins */
  profitIfHedgeWins: number;
  /** Whether this hedge can turn into a winner */
  canTurnIntoWinner: boolean;
}

/**
 * Represents a hedged position pair with full tracking
 */
export interface HedgedPosition {
  marketId: string;
  originalTokenId: string;
  hedgeTokenId: string;
  originalSide: "YES" | "NO";
  /** Original entry price (what we paid per share) */
  originalEntryPrice: number;
  /** Number of shares in original position */
  originalSize: number;
  /** Total USD invested in original position */
  originalInvestment: number;
  /** Price when hedge was triggered */
  priceAtHedge: number;
  /** Unrealized loss when hedge was triggered */
  unrealizedLossAtHedge: number;
  /** Hedge entry price */
  hedgeEntryPrice: number;
  /** Number of hedge shares purchased */
  hedgeSize: number;
  /** Total USD invested in hedge */
  hedgeInvestment: number;
  /** Timestamp when hedge was placed */
  hedgeTimestamp: number;
  /** Maximum potential loss (worst case) */
  maxLoss: number;
  /** Best case profit (if winning side wins) */
  bestCaseProfit: number;
  /** Full calculation details */
  calculation: HedgeCalculation;
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
 * - Buy $5 of NO at 70¢ ≈ 7.14 shares
 * - On resolution, each share that wins pays $1
 * - If YES wins: 10 shares × $1 per share = $10 total payout, total spent $10 → profit = $0
 * - If NO wins: 7.14 shares × $1 per share ≈ $7.14 total payout, total spent $10 → loss ≈ -$2.86
 * - Without hedge (sell YES at 30¢ instead of hedging): YES worth $3, loss = -$2
 * - With hedge: Worst case ≈ -$2.86 at resolution, but you keep upside if YES recovers before expiry
 *
 * KEY INSIGHT: Hedging provides OPTIONALITY - position can still win if market reverses
 *
 * BALANCE CHECK:
 * - SMART_HEDGING_ABSOLUTE_MAX_USD is a config limit, NOT a balance check
 * - If wallet has insufficient funds, the hedge order will fail gracefully
 * - The strategy caps hedge size at absoluteMaxHedgeUsd but doesn't verify wallet balance
 * - Order failures due to insufficient funds are logged and position remains unhedged
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
   * Slippage tolerances for order execution
   */
  private static readonly HEDGE_SLIPPAGE_PCT = 0.05; // 5% slippage for hedge buys
  private static readonly SELL_SLIPPAGE_PCT = 0.10; // 10% slippage for emergency sells
  private static readonly SWAP_FEE_BUFFER_PCT = 0.02; // 2% buffer for swap fees

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

  /**
   * Set of token IDs that are hedge positions (to avoid hedging hedges)
   */
  private hedgeTokenIds: Set<string> = new Set();

  constructor(strategyConfig: SmartHedgingStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
    this.validateConfig(strategyConfig.config);
  }

  /**
   * Validate configuration values to prevent runtime errors
   */
  private validateConfig(config: SmartHedgingConfig): void {
    if (config.triggerLossPct <= 0 || config.triggerLossPct >= 100) {
      throw new Error(
        `SmartHedgingConfig.triggerLossPct must be > 0 and < 100, received ${config.triggerLossPct}`,
      );
    }

    if (config.emergencyLossThresholdPct < config.triggerLossPct) {
      throw new Error(
        `SmartHedgingConfig.emergencyLossThresholdPct must be >= triggerLossPct (${config.triggerLossPct}), received ${config.emergencyLossThresholdPct}`,
      );
    }

    if (config.maxHedgeUsd <= 0) {
      throw new Error(
        `SmartHedgingConfig.maxHedgeUsd must be > 0, received ${config.maxHedgeUsd}`,
      );
    }

    if (config.minHedgeUsd < 0) {
      throw new Error(
        `SmartHedgingConfig.minHedgeUsd must be >= 0, received ${config.minHedgeUsd}`,
      );
    }

    // Validate absoluteMaxHedgeUsd > 0 before using it for auto-correction
    if (config.absoluteMaxHedgeUsd <= 0) {
      throw new Error(
        `SmartHedgingConfig.absoluteMaxHedgeUsd must be > 0, received ${config.absoluteMaxHedgeUsd}`,
      );
    }

    // Auto-correct maxHedgeUsd if absoluteMaxHedgeUsd is lower
    // This respects user intent: if they set an absolute cap, maxHedgeUsd should not exceed it
    if (config.absoluteMaxHedgeUsd < config.maxHedgeUsd) {
      this.logger.info(
        `[SmartHedging] Auto-adjusting maxHedgeUsd from $${config.maxHedgeUsd} to $${config.absoluteMaxHedgeUsd} (respecting absoluteMaxHedgeUsd cap)`,
      );
      config.maxHedgeUsd = config.absoluteMaxHedgeUsd;
    }

    // Auto-correct minHedgeUsd if it exceeds maxHedgeUsd after the above correction
    if (config.minHedgeUsd > config.maxHedgeUsd) {
      this.logger.info(
        `[SmartHedging] Auto-adjusting minHedgeUsd from $${config.minHedgeUsd} to $${config.maxHedgeUsd} (must be <= maxHedgeUsd)`,
      );
      config.minHedgeUsd = config.maxHedgeUsd;
    }

    if (config.reservePct < 0 || config.reservePct > 100) {
      throw new Error(
        `SmartHedgingConfig.reservePct must be between 0 and 100, received ${config.reservePct}`,
      );
    }

    if (
      config.optimalOpposingPriceMin < 0 ||
      config.optimalOpposingPriceMin > 1 ||
      config.optimalOpposingPriceMax < 0 ||
      config.optimalOpposingPriceMax > 1
    ) {
      throw new Error(
        `SmartHedgingConfig.optimalOpposingPriceMin/Max must each be between 0 and 1, received min=${config.optimalOpposingPriceMin}, max=${config.optimalOpposingPriceMax}`,
      );
    }

    if (config.optimalOpposingPriceMin >= config.optimalOpposingPriceMax) {
      throw new Error(
        `SmartHedgingConfig.optimalOpposingPriceMin must be < optimalOpposingPriceMax, received min=${config.optimalOpposingPriceMin}, max=${config.optimalOpposingPriceMax}`,
      );
    }

    if (config.minOpposingSidePrice < 0 || config.minOpposingSidePrice > 1) {
      throw new Error(
        `SmartHedgingConfig.minOpposingSidePrice must be between 0 and 1, received ${config.minOpposingSidePrice}`,
      );
    }
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
   * ENHANCED: Adds force liquidation for catastrophic losses and fallback liquidation when hedging fails
   */
  private async processHedging(allPositions: Position[]): Promise<number> {
    let actionsCount = 0;

    // Filter for risky tier positions that are losing
    const eligiblePositions = allPositions.filter((pos) => {
      // Skip if already hedged
      const key = `${pos.marketId}-${pos.tokenId}`;
      if (this.hedgedPositions.has(key)) {
        return false;
      }

      // Skip if THIS IS a hedge position (avoid hedging hedges / "hedge-ception")
      if (this.hedgeTokenIds.has(pos.tokenId)) {
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

      // Skip non-binary markets (can only hedge YES/NO)
      const side = pos.side?.toUpperCase();
      if (side !== "YES" && side !== "NO") {
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

      this.pendingHedges.add(positionKey);

      try {
        // =================================================================
        // SMART ACTION: HEDGE OR SELL - NEVER LET POSITIONS GO TO ZERO!
        // =================================================================
        // This is a YES/NO binary market. One side ALWAYS pays $1.
        // 
        // Decision matrix:
        // 1. If hedge can turn loss into profit → BUY THE INVERSE
        // 2. If hedge helps but doesn't guarantee profit → BUY THE INVERSE (better than nothing)
        // 3. If hedge is too expensive (opposing price too high) → SELL NOW to stop bleeding
        // 
        // NEVER just watch a position go to zero!
        // =================================================================

        const lossPct = Math.abs(position.pnlPct);
        const originalInvestment = position.size * position.entryPrice;
        const currentValue = position.size * position.currentPrice;
        const unrealizedLoss = originalInvestment - currentValue;

        this.logger.info(
          `[SmartHedging] 🎯 ANALYZING LOSING POSITION:` +
            `\n  ═══════════════════════════════════════` +
            `\n  Position: ${position.size.toFixed(2)} ${position.side} @ ${(position.entryPrice * 100).toFixed(1)}¢` +
            `\n  Invested: $${originalInvestment.toFixed(2)}` +
            `\n  Current:  ${(position.currentPrice * 100).toFixed(1)}¢ = $${currentValue.toFixed(2)} (${position.pnlPct.toFixed(1)}%)` +
            `\n  Loss:     $${unrealizedLoss.toFixed(2)}` +
            `\n  ═══════════════════════════════════════`,
        );

        // Check if loss exceeds forceLiquidationLossPct - skip hedge analysis and force liquidation
        let analysis: Awaited<ReturnType<typeof this.analyzeHedgeVsSell>>;
        if (
          this.config.forceLiquidationLossPct !== undefined &&
          lossPct >= this.config.forceLiquidationLossPct
        ) {
          // Force liquidation once loss exceeds configured threshold,
          // skipping hedge analysis even if hedging might be viable.
          this.logger.warn(
            `[SmartHedging] 🚨 LOSS ${lossPct.toFixed(1)}% >= forceLiquidationLossPct=${this.config.forceLiquidationLossPct.toFixed(1)}% - forcing liquidation instead of hedging`,
          );
          analysis = {
            action: "SELL",
            reason: `Loss ${lossPct.toFixed(1)}% exceeded forceLiquidationLossPct=${this.config.forceLiquidationLossPct}%`,
            expectedOutcome: "Immediate liquidation to cap further losses",
          };
        } else {
          // Analyze the best action
          analysis = await this.analyzeHedgeVsSell(position);
        }

        if (analysis.action === "HEDGE") {
          this.logger.info(
            `[SmartHedging] 📊 DECISION: HEDGE (buy ${position.side === "YES" ? "NO" : "YES"})` +
              `\n  Reason: ${analysis.reason}` +
              `\n  Expected outcome: ${analysis.expectedOutcome}`,
          );

          const hedged = await this.executeAggressiveHedge(position);
          if (hedged) {
            actionsCount++;
            this.positionFirstSeenLosing.delete(positionKey);
            continue;
          }

          // Hedge failed - try swap as backup
          this.logger.warn(`[SmartHedging] ⚠️ Direct hedge failed - trying SWAP`);
          const swapped = await this.executeSwap(position);
          if (swapped) {
            actionsCount++;
            this.positionFirstSeenLosing.delete(positionKey);
            continue;
          }

          // Both hedge and swap failed - must liquidate to stop bleeding
          this.logger.warn(`[SmartHedging] ⚠️ Hedge and swap both failed - must liquidate`);
        }

        // If we reach here, either:
        // 1. analysis.action === "SELL" (hedging wasn't viable, sell is best option)
        // 2. analysis.action === "HEDGE" but both hedge and swap failed (must liquidate)
        // In both cases, we need to liquidate to stop losses
        this.logger.info(
          `[SmartHedging] 📊 EXECUTING LIQUIDATION:` +
            `\n  Reason: ${analysis.action === "SELL" ? analysis.reason : "All hedge attempts failed"}` +
            `\n  Salvaging: ~$${currentValue.toFixed(2)} before further decay`,
        );

        const liquidated = await this.liquidatePosition(position, "FORCE_LIQUIDATION");
        if (liquidated) {
          actionsCount++;
          this.positionFirstSeenLosing.delete(positionKey);
          this.logger.info(
            `[SmartHedging] ✅ LIQUIDATED - Salvaged $${currentValue.toFixed(2)} (saved from going to $0)`,
          );
        } else {
          this.logger.error(
            `[SmartHedging] ❌ FAILED TO LIQUIDATE - Position still at risk!`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[SmartHedging] ❌ Error processing position: ${err instanceof Error ? err.message : String(err)}`,
        );

        // Emergency liquidation on any error
        if (this.config.enableFallbackLiquidation) {
          try {
            this.logger.warn(`[SmartHedging] 🚨 Emergency liquidation after error`);
            const liquidated = await this.liquidatePosition(position, "HEDGE_ERROR_FALLBACK");
            if (liquidated) {
              actionsCount++;
              this.positionFirstSeenLosing.delete(positionKey);
            }
          } catch (liquidateErr) {
            this.logger.error(
              `[SmartHedging] ❌ Emergency liquidation failed: ${liquidateErr instanceof Error ? liquidateErr.message : String(liquidateErr)}`,
            );
          }
        }
      } finally {
        this.pendingHedges.delete(positionKey);
      }
    }

    if (actionsCount > 0) {
      this.logger.info(
        `[SmartHedging] ✅ Processed ${actionsCount} position(s) (hedged/swapped/liquidated)`,
      );
    }

    return actionsCount;
  }

  /**
   * Analyze whether to HEDGE or SELL a losing position
   * 
   * HEDGE makes sense when:
   * - Opposing price is reasonable (not too expensive)
   * - We have enough budget to create a meaningful hedge
   * - The hedge can either guarantee profit or significantly reduce loss
   * 
   * SELL makes sense when:
   * - Opposing price is too high (e.g., 95¢+ means our side is almost certainly losing)
   * - Hedge would be too expensive to be useful
   * - Position is so deep in the red that hedging can't help
   */
  private async analyzeHedgeVsSell(position: Position): Promise<{
    action: "HEDGE" | "SELL";
    reason: string;
    expectedOutcome: string;
    opposingPrice?: number;
  }> {
    const originalSide = this.determineSide(position);
    if (!originalSide) {
      return {
        action: "SELL",
        reason: "Cannot determine position side",
        expectedOutcome: "Salvage remaining value",
      };
    }

    const opposingTokenId = await this.getOpposingTokenId(
      position.marketId,
      position.tokenId,
      originalSide,
    );

    if (!opposingTokenId) {
      return {
        action: "SELL",
        reason: "Cannot find opposing token",
        expectedOutcome: "Salvage remaining value",
      };
    }

    // Get opposing price
    let opposingPrice: number;
    try {
      const orderbook = await this.client.getOrderBook(opposingTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        return {
          action: "SELL",
          reason: "No liquidity for opposing token",
          expectedOutcome: "Salvage remaining value",
        };
      }
      opposingPrice = parseFloat(orderbook.asks[0].price);
    } catch {
      return {
        action: "SELL",
        reason: "Failed to get opposing price",
        expectedOutcome: "Salvage remaining value",
      };
    }

    const originalInvestment = position.size * position.entryPrice;
    const currentValue = position.size * position.currentPrice;
    const hedgeProfit = 1 - opposingPrice; // Profit per hedge share if hedge wins

    // If opposing price is extremely high (>90¢), our side is almost certainly losing
    // Hedging is very expensive and may not help much
    if (opposingPrice >= 0.90) {
      return {
        action: "SELL",
        reason: `Opposing side at ${(opposingPrice * 100).toFixed(0)}¢ - our side likely losing, hedge too expensive`,
        expectedOutcome: `Salvage $${currentValue.toFixed(2)} now vs risk going to $0`,
        opposingPrice,
      };
    }

    // Calculate what hedge we can afford
    const maxHedgeBudget = this.config.allowExceedMaxForProtection
      ? this.config.absoluteMaxHedgeUsd
      : this.config.maxHedgeUsd;

    // Calculate shares needed to break even on hedge win
    // hedgeShares × (1 - opposingPrice) = originalInvestment
    const breakEvenShares = originalInvestment / hedgeProfit;
    const breakEvenCost = breakEvenShares * opposingPrice;

    // Can we afford a hedge that at least breaks even?
    if (breakEvenCost <= maxHedgeBudget) {
      // We can afford a profitable hedge!
      const profitableHedgeCost = breakEvenCost * 1.1; // 10% buffer for profit
      const hedgeCost = Math.min(profitableHedgeCost, maxHedgeBudget);
      const hedgeShares = hedgeCost / opposingPrice;
      const ifHedgeWins = hedgeShares * 1.0 - originalInvestment - hedgeCost;

      return {
        action: "HEDGE",
        reason: `Can afford profitable hedge ($${hedgeCost.toFixed(2)} ≤ $${maxHedgeBudget} budget)`,
        expectedOutcome: `If ${originalSide === "YES" ? "NO" : "YES"} wins: +$${ifHedgeWins.toFixed(2)} profit`,
        opposingPrice,
      };
    }

    // We can't afford a break-even hedge, but can we afford ANY hedge?
    if (maxHedgeBudget >= this.config.minHedgeUsd) {
      const hedgeShares = maxHedgeBudget / opposingPrice;
      const ifHedgeWins = hedgeShares * 1.0 - originalInvestment - maxHedgeBudget;
      const ifOriginalWins = position.size * 1.0 - originalInvestment - maxHedgeBudget;

      // Check if hedge reduces worst-case loss compared to just selling
      const worstCaseWithHedge = Math.min(ifHedgeWins, ifOriginalWins);
      const lossIfSellNow = currentValue - originalInvestment; // Negative

      if (worstCaseWithHedge > lossIfSellNow) {
        return {
          action: "HEDGE",
          reason: `Partial hedge reduces worst-case loss`,
          expectedOutcome: `Worst case: $${worstCaseWithHedge.toFixed(2)} vs selling now: $${lossIfSellNow.toFixed(2)}`,
          opposingPrice,
        };
      }
    }

    // Hedging doesn't help enough - just sell
    return {
      action: "SELL",
      reason: `Hedge too expensive (need $${breakEvenCost.toFixed(2)}, have $${maxHedgeBudget} budget)`,
      expectedOutcome: `Salvage $${currentValue.toFixed(2)} now`,
      opposingPrice,
    };
  }

  /**
   * Execute an aggressive hedge - just buy the opposite side
   * No waiting for optimal timing - if we have funds, BUY THE INVERSE NOW
   */
  private async executeAggressiveHedge(position: Position): Promise<boolean> {
    const originalSide = this.determineSide(position);
    if (!originalSide) {
      return false;
    }

    const opposingTokenId = await this.getOpposingTokenId(
      position.marketId,
      position.tokenId,
      originalSide,
    );

    if (!opposingTokenId) {
      this.logger.warn(`[SmartHedging] Could not find opposing token for hedge`);
      return false;
    }

    // Get opposing side price
    let opposingPrice: number;
    try {
      const orderbook = await this.client.getOrderBook(opposingTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(`[SmartHedging] No asks for ${originalSide === "YES" ? "NO" : "YES"} token - no liquidity`);
        return false;
      }
      opposingPrice = parseFloat(orderbook.asks[0].price);
    } catch {
      this.logger.warn(`[SmartHedging] Failed to get opposing token orderbook`);
      return false;
    }

    // =================================================================
    // SMART HEDGE CALCULATION: Calculate exact size to GUARANTEE A WIN
    // =================================================================
    // Binary market: YES + NO = $1 at resolution
    // If we own YES and buy NO, one side WILL pay $1
    //
    // Math to GUARANTEE PROFIT on hedge win:
    //   hedgeShares × $1 > originalInvestment + hedgeCost
    //   hedgeShares × $1 > originalInvestment + (hedgeShares × opposingPrice)
    //   hedgeShares × (1 - opposingPrice) > originalInvestment
    //   hedgeShares > originalInvestment / (1 - opposingPrice)
    //
    // Add 10% buffer to ensure actual profit, not just break-even
    // =================================================================
    
    const originalInvestment = position.size * position.entryPrice;
    const hedgeProfit = 1 - opposingPrice; // Profit per hedge share if hedge wins
    
    if (hedgeProfit <= 0) {
      this.logger.warn(`[SmartHedging] Opposing price ${(opposingPrice * 100).toFixed(1)}¢ too high - cannot hedge profitably`);
      return false;
    }

    // Calculate EXACT hedge needed to guarantee profit
    const breakEvenHedgeShares = originalInvestment / hedgeProfit;
    const profitableHedgeShares = breakEvenHedgeShares * 1.1; // 10% buffer for profit
    const profitableHedgeUsd = profitableHedgeShares * opposingPrice;

    // Determine final hedge size based on limits
    let hedgeUsd: number;
    let hedgeReason: string;

    if (this.config.allowExceedMaxForProtection) {
      // With SMART_HEDGING_ALLOW_EXCEED_MAX=true and SMART_HEDGING_ABSOLUTE_MAX_USD set,
      // we can use up to absoluteMaxHedgeUsd to fully hedge
      if (profitableHedgeUsd <= this.config.absoluteMaxHedgeUsd) {
        // We can afford the FULL profitable hedge - GUARANTEED WIN!
        hedgeUsd = profitableHedgeUsd;
        hedgeReason = `FULL HEDGE for guaranteed win ($${hedgeUsd.toFixed(2)} ≤ $${this.config.absoluteMaxHedgeUsd} limit)`;
      } else {
        // Use max allowed - best effort
        hedgeUsd = this.config.absoluteMaxHedgeUsd;
        hedgeReason = `MAX HEDGE (capped at $${this.config.absoluteMaxHedgeUsd}, need $${profitableHedgeUsd.toFixed(2)} for guaranteed win)`;
      }
    } else {
      // Standard mode - use maxHedgeUsd
      hedgeUsd = Math.min(profitableHedgeUsd, this.config.maxHedgeUsd);
      hedgeReason = `Standard hedge ($${hedgeUsd.toFixed(2)} capped at $${this.config.maxHedgeUsd})`;
    }

    // Calculate expected outcomes
    const hedgeShares = hedgeUsd / opposingPrice;
    const totalInvested = originalInvestment + hedgeUsd;
    const ifOriginalWins = position.size * 1.0 - totalInvested; // Original pays $1/share
    const ifHedgeWins = hedgeShares * 1.0 - totalInvested; // Hedge pays $1/share
    const canWin = ifOriginalWins > 0 || ifHedgeWins > 0;

    // Ensure minimum viable hedge
    if (hedgeUsd < this.config.minHedgeUsd) {
      this.logger.debug(`[SmartHedging] Hedge size $${hedgeUsd.toFixed(2)} below minimum $${this.config.minHedgeUsd}`);
      return false;
    }

    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[SmartHedging] No wallet attached - cannot execute hedge`);
      return false;
    }

    this.logger.info(
      `[SmartHedging] 🔄 BUYING ${originalSide === "YES" ? "NO" : "YES"} to hedge:` +
        `\n  ═══════════════════════════════════════` +
        `\n  📊 ORIGINAL: ${position.size.toFixed(2)} ${originalSide} @ ${(position.entryPrice * 100).toFixed(1)}¢ = $${originalInvestment.toFixed(2)} invested` +
        `\n  📉 CURRENT:  ${(position.currentPrice * 100).toFixed(1)}¢ (${position.pnlPct.toFixed(1)}% loss)` +
        `\n  ───────────────────────────────────────` +
        `\n  🎯 HEDGE: Buy ${hedgeShares.toFixed(2)} ${originalSide === "YES" ? "NO" : "YES"} @ ${(opposingPrice * 100).toFixed(1)}¢ = $${hedgeUsd.toFixed(2)}` +
        `\n  📝 Reason: ${hedgeReason}` +
        `\n  ───────────────────────────────────────` +
        `\n  📈 OUTCOMES:` +
        `\n     If ${originalSide} wins: ${ifOriginalWins >= 0 ? "+" : ""}$${ifOriginalWins.toFixed(2)}` +
        `\n     If ${originalSide === "YES" ? "NO" : "YES"} wins: ${ifHedgeWins >= 0 ? "+" : ""}$${ifHedgeWins.toFixed(2)}` +
        `\n  ${canWin ? "🎉 GUARANTEED WIN on one side!" : "📉 Loss capped - best effort hedge"}` +
        `\n  ═══════════════════════════════════════`,
    );

    try {
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: opposingTokenId,
        outcome: originalSide === "YES" ? "NO" : "YES",
        side: "BUY",
        sizeUsd: hedgeUsd,
        maxAcceptablePrice: opposingPrice * (1 + SmartHedgingStrategy.HEDGE_SLIPPAGE_PCT),
        logger: this.logger,
        priority: true,
        skipDuplicatePrevention: true,
        skipMinBuyPriceCheck: true, // Hedge buys are intentional at any price
        orderConfig: { minOrderUsd: 0 },
      });

      if (result.status === "submitted") {
        // Track the hedge
        const key = `${position.marketId}-${position.tokenId}`;
        this.hedgedPositions.set(key, {
          marketId: position.marketId,
          originalTokenId: position.tokenId,
          hedgeTokenId: opposingTokenId,
          originalSide,
          originalEntryPrice: position.entryPrice,
          originalSize: position.size,
          originalInvestment,
          priceAtHedge: position.currentPrice,
          unrealizedLossAtHedge: originalInvestment - position.size * position.currentPrice,
          hedgeEntryPrice: opposingPrice,
          hedgeSize: hedgeShares,
          hedgeInvestment: hedgeUsd,
          hedgeTimestamp: Date.now(),
          maxLoss: Math.abs(Math.min(ifOriginalWins, ifHedgeWins)),
          bestCaseProfit: Math.max(ifOriginalWins, ifHedgeWins),
          calculation: {
            originalInvestment,
            currentValue: position.size * position.currentPrice,
            unrealizedLoss: originalInvestment - position.size * position.currentPrice,
            hedgePrice: opposingPrice,
            breakEvenHedgeSize: breakEvenHedgeShares * opposingPrice,
            profitableHedgeSize: profitableHedgeUsd,
            actualHedgeSize: hedgeUsd,
            profitIfOriginalWins: ifOriginalWins,
            profitIfHedgeWins: ifHedgeWins,
            canTurnIntoWinner: canWin,
          },
        });
        this.hedgeTokenIds.add(opposingTokenId);
        return true;
      }

      this.logger.warn(`[SmartHedging] Hedge order ${result.status}: ${result.reason ?? "unknown"}`);
      return false;
    } catch (err) {
      this.logger.error(`[SmartHedging] Hedge execution error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Execute a SWAP - sell the losing position and buy the opposite side
   * This is the nuclear option when we can't hedge directly due to insufficient funds
   */
  private async executeSwap(position: Position): Promise<boolean> {
    const originalSide = this.determineSide(position);
    if (!originalSide) {
      return false;
    }

    const opposingTokenId = await this.getOpposingTokenId(
      position.marketId,
      position.tokenId,
      originalSide,
    );

    if (!opposingTokenId) {
      return false;
    }

    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      return false;
    }

    // STEP 1: Sell the losing position
    let sellProceeds = 0;
    try {
      const orderbook = await this.client.getOrderBook(position.tokenId);
      if (!orderbook.bids || orderbook.bids.length === 0) {
        this.logger.warn(`[SmartHedging] No bids to sell ${originalSide} - cannot swap`);
        return false;
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      sellProceeds = position.size * bestBid;

      this.logger.info(
        `[SmartHedging] 📤 SWAP STEP 1: Selling ${originalSide}` +
          `\n  Selling: ${position.size.toFixed(2)} shares @ ${(bestBid * 100).toFixed(1)}¢ = ~$${sellProceeds.toFixed(2)}`,
      );

      const sellResult = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: originalSide,
        side: "SELL",
        sizeUsd: sellProceeds,
        maxAcceptablePrice: bestBid * (1 - SmartHedgingStrategy.SELL_SLIPPAGE_PCT),
        logger: this.logger,
        priority: true,
        skipDuplicatePrevention: true,
        orderConfig: { minOrderUsd: 0 },
      });

      if (sellResult.status !== "submitted") {
        this.logger.warn(`[SmartHedging] Sell failed: ${sellResult.reason ?? "unknown"}`);
        return false;
      }
    } catch (err) {
      this.logger.error(`[SmartHedging] Sell error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    // STEP 2: Buy the opposite side with the proceeds
    try {
      const orderbook = await this.client.getOrderBook(opposingTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(
          `[SmartHedging] ⚠️ PARTIAL SWAP: Sold ${originalSide} but no liquidity for ${originalSide === "YES" ? "NO" : "YES"}. ` +
            `Bleeding stopped - position closed.`,
        );
        // Return true because the main goal (stop bleeding) was achieved
        return true;
      }

      const opposingPrice = parseFloat(orderbook.asks[0].price);

      // Use the sell proceeds to buy the opposite side
      // Keep a small buffer for fees
      const buyAmount = sellProceeds * (1 - SmartHedgingStrategy.SWAP_FEE_BUFFER_PCT);

      this.logger.info(
        `[SmartHedging] 📥 SWAP STEP 2: Buying ${originalSide === "YES" ? "NO" : "YES"}` +
          `\n  Buying: $${buyAmount.toFixed(2)} @ ${(opposingPrice * 100).toFixed(1)}¢`,
      );

      const buyResult = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: opposingTokenId,
        outcome: originalSide === "YES" ? "NO" : "YES",
        side: "BUY",
        sizeUsd: buyAmount,
        maxAcceptablePrice: opposingPrice * (1 + SmartHedgingStrategy.HEDGE_SLIPPAGE_PCT),
        logger: this.logger,
        priority: true,
        skipDuplicatePrevention: true,
        skipMinBuyPriceCheck: true, // Swap buys are intentional at any price
        orderConfig: { minOrderUsd: 0 },
      });

      if (buyResult.status === "submitted") {
        this.logger.info(
          `[SmartHedging] ✅ SWAP COMPLETE! Converted ${originalSide} → ${originalSide === "YES" ? "NO" : "YES"}`,
        );
        return true;
      }

      this.logger.warn(
        `[SmartHedging] ⚠️ PARTIAL SWAP: Sold ${originalSide} but buy failed: ${buyResult.reason ?? "unknown"}. ` +
          `Bleeding stopped - position closed.`,
      );
      // Return true because the main goal (stop bleeding) was achieved
      return true;
    } catch (err) {
      this.logger.warn(
        `[SmartHedging] ⚠️ PARTIAL SWAP: Sold ${originalSide} but buy error: ${err instanceof Error ? err.message : String(err)}. ` +
          `Bleeding stopped - position closed.`,
      );
      // Return true because the main goal (stop bleeding) was achieved
      return true;
    }
  }

  /**
   * Analyze whether NOW is the right time to hedge
   * Goal: Don't hedge too early (might recover) or too late (spread too wide)
   */
  private async analyzeHedgeTiming(
    position: Position,
  ): Promise<HedgeTimingAnalysis> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const firstSeenTime =
      this.positionFirstSeenLosing.get(positionKey) ?? Date.now();
    const holdTimeSeconds = (Date.now() - firstSeenTime) / 1000;

    // Get opposing token info
    const originalSide = this.determineSide(position);

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

    if (!originalSide) {
      return { ...defaultAnalysis, reason: "Cannot determine position side" };
    }

    const opposingTokenId = await this.getOpposingTokenId(
      position.marketId,
      position.tokenId,
      originalSide,
    );

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
      return {
        ...defaultAnalysis,
        reason: "Failed to fetch opposing orderbook",
      };
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
    const hasDownwardMomentum =
      consecutiveDrops >= this.config.minConsecutiveDrops;
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
    else if (
      holdTimeSeconds > this.config.minHoldBeforeHedgeSeconds * 3 &&
      position.pnlPct <= -this.config.triggerLossPct * 1.5
    ) {
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
      if (
        now - lastEntry.timestamp <
        SmartHedgingStrategy.PRICE_HISTORY_INTERVAL_MS
      ) {
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
   * Manage reserves by selling profitable positions when needed to fund hedges
   *
   * This ensures funds are always available for hedging by:
   * 1. Calculating how much we need for potential hedges
   * 2. Checking if we have enough reserves
   * 3. Selling profitable positions (prioritizing those with declining volume) to free up funds
   */
  private async manageReserves(allPositions: Position[]): Promise<number> {
    // Find positions that might need hedging soon
    const potentialHedgePositions = allPositions.filter((pos) => {
      const key = `${pos.marketId}-${pos.tokenId}`;
      if (this.hedgedPositions.has(key)) return false;
      if (this.hedgeTokenIds.has(pos.tokenId)) return false;
      if (pos.entryPrice >= this.config.maxEntryPriceForHedging) return false;
      if (pos.redeemable) return false;
      // Include positions that are losing OR approaching loss threshold
      return pos.pnlPct <= 0;
    });

    if (potentialHedgePositions.length === 0) {
      return 0; // No positions need hedging, no need for reserves
    }

    // Calculate estimated funds needed for hedging
    // Use absoluteMaxHedgeUsd when allowExceedMaxForProtection is enabled,
    // otherwise use the standard maxHedgeUsd limit
    const effectiveMaxHedge = this.config.allowExceedMaxForProtection
      ? this.config.absoluteMaxHedgeUsd
      : this.config.maxHedgeUsd;
    const estimatedHedgeFundsNeeded = potentialHedgePositions.reduce(
      (sum, pos) => {
        const positionValue = pos.size * pos.entryPrice;
        // Estimate hedge cost as position value (worst case), capped at effective max
        return sum + Math.min(positionValue, effectiveMaxHedge);
      },
      0,
    );

    // Dynamic threshold: lower the min profit requirement when facing severe losses
    // If we have positions with >emergencyLossThresholdPct loss, accept ANY profitable position
    // Note: pnlPct is negative for losses (e.g., -35% means 35% loss)
    // Math.min returns the most negative value = worst loss (e.g., -48% is worse than -20%)
    // emergencyLossThresholdPct is a positive number (e.g., 30), so we check: worstLoss <= -30
    const worstLoss = Math.min(
      ...potentialHedgePositions.map((pos) => pos.pnlPct),
    );
    const hasEmergencyLoss =
      worstLoss <= -this.config.emergencyLossThresholdPct;
    const effectiveMinProfitPct = hasEmergencyLoss
      ? 0.1
      : this.config.reserveSellMinProfitPct;

    if (hasEmergencyLoss) {
      this.logger.debug(
        `[SmartHedging] Emergency mode: worst loss is ${worstLoss.toFixed(1)}%, lowering reserve sell threshold to ${effectiveMinProfitPct}%`,
      );
    }

    // Find profitable positions we could sell (excluding hedge positions)
    const profitablePositions = allPositions
      .filter((pos) => {
        // Must be profitable (using dynamic threshold)
        if (pos.pnlPct < effectiveMinProfitPct) return false;
        // Don't sell hedge positions
        if (this.hedgeTokenIds.has(pos.tokenId)) return false;
        // Don't sell positions we're hedging
        const key = `${pos.marketId}-${pos.tokenId}`;
        if (this.hedgedPositions.has(key)) return false;
        // Don't sell recently sold positions (cooldown)
        if (this.recentReserveSells.has(key)) return false;
        // Don't sell resolved positions
        if (pos.redeemable) return false;
        return true;
      })
      .sort((a, b) => {
        // Prioritize selling positions with:
        // 1. LOWEST profit % first (keep the big winners, sacrifice small gains)
        // 2. Declining volume (weak conviction = sell first)
        const aVolume = this.volumeCache.get(a.tokenId);
        const bVolume = this.volumeCache.get(b.tokenId);
        const aDecline = aVolume?.volumeChangePercent ?? 0;
        const bDecline = bVolume?.volumeChangePercent ?? 0;

        // Score: LOWER profit = sell first, declining volume = sell first
        // We want to keep highly profitable positions, so sell least profitable first
        const aScore = a.pnlPct - (aDecline < 0 ? Math.abs(aDecline) * 0.5 : 0);
        const bScore = b.pnlPct - (bDecline < 0 ? Math.abs(bDecline) * 0.5 : 0);
        return aScore - bScore; // Lower score (less profitable) first
      });

    if (profitablePositions.length === 0) {
      this.logger.debug(
        `[SmartHedging] No profitable positions available to sell for reserves (need ~$${estimatedHedgeFundsNeeded.toFixed(2)} for potential hedges)`,
      );
      return 0;
    }

    // Calculate how much we should have in reserve
    const targetReserve =
      estimatedHedgeFundsNeeded * (this.config.reservePct / 100);

    // Sell profitable positions until we have enough reserves
    let soldCount = 0;
    let fundsFreed = 0;

    for (const position of profitablePositions) {
      // Stop if we've freed enough funds
      if (fundsFreed >= targetReserve) {
        break;
      }

      const positionKey = `${position.marketId}-${position.tokenId}`;
      const positionValue = position.size * position.currentPrice;

      this.logger.info(
        `[SmartHedging] 💰 Selling profitable position to maintain hedge reserves:` +
          `\n  Position: ${position.size.toFixed(2)} @ ${(position.currentPrice * 100).toFixed(1)}¢ = $${positionValue.toFixed(2)}` +
          `\n  Profit: ${position.pnlPct.toFixed(1)}%` +
          `\n  Reason: Building reserves for potential hedges ($${fundsFreed.toFixed(2)}/$${targetReserve.toFixed(2)})`,
      );

      try {
        const sold = await this.sellPositionForReserve(position);
        if (sold) {
          soldCount++;
          fundsFreed += positionValue;
          this.recentReserveSells.set(positionKey, Date.now());
        }
      } catch (err) {
        this.logger.error(
          `[SmartHedging] Failed to sell position for reserves: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (soldCount > 0) {
      this.logger.info(
        `[SmartHedging] ✅ Sold ${soldCount} profitable position(s), freed ~$${fundsFreed.toFixed(2)} for hedge reserves`,
      );
    }

    return soldCount;
  }

  /**
   * Sell a position to free up reserves for hedging
   */
  private async sellPositionForReserve(position: Position): Promise<boolean> {
    try {
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      if (!wallet) {
        this.logger.error(
          "[SmartHedging] ❌ Cannot sell for reserves: client has no wallet attached",
        );
        return false;
      }

      // Get current bid price for selling
      const orderbook = await this.client.getOrderBook(position.tokenId);
      if (!orderbook.bids || orderbook.bids.length === 0) {
        this.logger.warn(
          `[SmartHedging] ⚠️ No bids for position - cannot sell for reserves`,
        );
        return false;
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      const sizeUsd = position.size * bestBid;

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: position.side as "YES" | "NO",
        side: "SELL",
        sizeUsd,
        maxAcceptablePrice: bestBid * 0.95, // Accept up to 5% slippage
        logger: this.logger,
        priority: false,
        skipDuplicatePrevention: true, // Hedging must bypass duplicate prevention
        orderConfig: { minOrderUsd: 0 },
      });

      if (result.status === "submitted") {
        return true;
      } else if (result.reason === "FOK_ORDER_KILLED") {
        // FOK order was submitted but killed (no fill) - market has insufficient liquidity
        this.logger.warn(
          `[SmartHedging] ⚠️ Reserve sell not filled (FOK killed) - market has insufficient liquidity`,
        );
        return false;
      }
      return false;
    } catch (err) {
      this.logger.error(
        `[SmartHedging] ❌ Failed to sell for reserves: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Liquidate a losing position when hedging is not possible
   * This is a FALLBACK action when:
   * 1. Hedge failed due to insufficient funds after trying to raise reserves
   * 2. Position has catastrophic losses (forceLiquidationLossPct)
   * 3. Market conditions don't allow hedging
   *
   * The goal is to STOP THE BLEEDING rather than let positions go to zero.
   *
   * @param position - The position to liquidate
   * @param reason - Why we're liquidating (for logging)
   * @returns true if liquidation was successful
   */
  private async liquidatePosition(
    position: Position,
    reason: "FORCE_LIQUIDATION" | "HEDGE_FALLBACK" | "HEDGE_ERROR_FALLBACK",
  ): Promise<boolean> {
    try {
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      if (!wallet) {
        this.logger.error(
          "[SmartHedging] ❌ Cannot liquidate: client has no wallet attached",
        );
        return false;
      }

      // Get current bid price for selling
      const orderbook = await this.client.getOrderBook(position.tokenId);
      if (!orderbook.bids || orderbook.bids.length === 0) {
        this.logger.warn(
          `[SmartHedging] ⚠️ No bids for position - cannot liquidate (market may be illiquid)`,
        );
        return false;
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      const sizeUsd = position.size * bestBid;

      const reasonEmoji =
        reason === "FORCE_LIQUIDATION"
          ? "🚨"
          : reason === "HEDGE_FALLBACK"
            ? "⚠️"
            : "❌";
      const reasonText =
        reason === "FORCE_LIQUIDATION"
          ? "Catastrophic loss - force liquidating to stop bleeding"
          : reason === "HEDGE_FALLBACK"
            ? "Hedge could not execute - liquidating as fallback"
            : "Hedge error - liquidating as fallback";

      this.logger.info(
        `[SmartHedging] ${reasonEmoji} LIQUIDATING POSITION:` +
          `\n  Reason: ${reasonText}` +
          `\n  Position: ${position.size.toFixed(2)} ${position.side} @ ${(position.currentPrice * 100).toFixed(1)}¢` +
          `\n  Loss: ${position.pnlPct.toFixed(1)}%` +
          `\n  Selling at: ${(bestBid * 100).toFixed(1)}¢ = ~$${sizeUsd.toFixed(2)}` +
          `\n  💡 This action stops further loss - better to salvage something than lose everything`,
      );

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: position.side as "YES" | "NO",
        side: "SELL",
        sizeUsd,
        maxAcceptablePrice: bestBid * (1 - SmartHedgingStrategy.SELL_SLIPPAGE_PCT),
        logger: this.logger,
        priority: true, // High priority for liquidation
        skipDuplicatePrevention: true, // Must bypass duplicate prevention
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum for liquidation
      });

      if (result.status === "submitted") {
        this.logger.info(
          `[SmartHedging] ✅ Liquidation successful - salvaged ~$${sizeUsd.toFixed(2)} before further losses`,
        );
        return true;
      } else if (result.reason === "FOK_ORDER_KILLED") {
        this.logger.warn(
          `[SmartHedging] ⚠️ Liquidation order not filled (FOK killed) - market has insufficient liquidity`,
        );
        return false;
      } else {
        this.logger.warn(
          `[SmartHedging] ⚠️ Liquidation order ${result.status}: ${result.reason ?? "unknown"}`,
        );
        return false;
      }
    } catch (err) {
      this.logger.error(
        `[SmartHedging] ❌ Failed to liquidate position: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
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
      if (!originalSide) {
        this.logger.warn(
          `[SmartHedging] ⚠️ Cannot hedge - unable to determine position side for ${position.marketId}`,
        );
        return false;
      }

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

      // === CALCULATE HEDGE SIZES ===
      // We need to track:
      // 1. Original investment (what we paid)
      // 2. Current unrealized loss
      // 3. Break-even hedge size (minimize loss)
      // 4. Profitable hedge size (actually make money on hedge win)

      const originalInvestment = position.size * position.entryPrice;
      const currentValue = position.size * position.currentPrice;
      const unrealizedLoss = originalInvestment - currentValue;

      // Calculate hedge sizes:
      // If we buy X hedge shares at price P:
      // - If original wins: original shares × $1 - originalInvestment - (X × P) = profit
      // - If hedge wins: X × $1 - originalInvestment - (X × P) = X × (1 - P) - originalInvestment

      // For hedge win to be PROFITABLE (not just break-even):
      // X × (1 - opposingPrice) > originalInvestment
      // X > originalInvestment / (1 - opposingPrice)
      // We add 10% buffer to ensure actual profit, not just break-even
      const hedgeProfit = 1 - opposingPrice; // Profit per hedge share if hedge wins

      // Guard: if opposingPrice >= 1, hedgeProfit <= 0 and hedge math breaks down
      // This means the opposing side is too expensive (or invalid) to hedge
      if (hedgeProfit <= 0) {
        this.logger.warn(
          `[SmartHedging] ⚠️ Cannot hedge - opposing price ${(opposingPrice * 100).toFixed(1)}¢ is too high (>= $1)`,
        );
        return false;
      }

      const breakEvenHedgeShares = originalInvestment / hedgeProfit;
      const breakEvenHedgeUsd = breakEvenHedgeShares * opposingPrice;
      // Add 10% buffer to ensure we PROFIT, not just break even
      const profitableHedgeShares = breakEvenHedgeShares * 1.1;
      const profitableHedgeUsd = profitableHedgeShares * opposingPrice;

      // Determine actual hedge size based on strategy
      // KEY INSIGHT: We want to create an inverse trade UP TO THE CEILING to undo loss damage
      // NOT micro-trades that match the original tiny position size
      const isEmergency =
        position.pnlPct <= -this.config.emergencyLossThresholdPct;

      let targetHedgeUsd: number;
      let hedgeSizeReason: string;

      // SMART HEDGE CALCULATION:
      // Calculate the exact amount needed to PROFIT if the hedge wins
      // This is the "profitable hedge" - the inverse trade that undoes the damage
      this.logger.debug(
        `[SmartHedging] 🧮 SMART HEDGE CALCULATION:` +
          `\n  Original investment: $${originalInvestment.toFixed(2)}` +
          `\n  Current loss: ${position.pnlPct.toFixed(1)}% ($${unrealizedLoss.toFixed(2)})` +
          `\n  Opposing price: ${(opposingPrice * 100).toFixed(1)}¢` +
          `\n  Profit per hedge share: $${hedgeProfit.toFixed(2)}` +
          `\n  Shares needed to profit: ${profitableHedgeShares.toFixed(2)}` +
          `\n  💰 SMART HEDGE AMOUNT: $${profitableHedgeUsd.toFixed(2)} (this is what we need to make money!)` +
          `\n  Ceiling: $${this.config.absoluteMaxHedgeUsd}`,
      );

      // Goal: Create a meaningful hedge that can turn the loss into a WIN
      // Use the calculated profitableHedgeUsd (capped at ceiling)
      if (this.config.allowExceedMaxForProtection) {
        if (profitableHedgeUsd <= this.config.absoluteMaxHedgeUsd) {
          // We can afford a profitable hedge! Use the full amount needed.
          targetHedgeUsd = profitableHedgeUsd;
          hedgeSizeReason = `💰 SMART HEDGE - buying $${targetHedgeUsd.toFixed(2)} to PROFIT if hedge wins`;
        } else {
          // Profitable hedge exceeds our limit - use the MAXIMUM ALLOWED to get as close as possible
          // This creates a meaningful inverse trade, not a micro-hedge
          targetHedgeUsd = this.config.absoluteMaxHedgeUsd;
          hedgeSizeReason = isEmergency
            ? `🚨 EMERGENCY MAX HEDGE - using full $${this.config.absoluteMaxHedgeUsd} ceiling (${position.pnlPct.toFixed(1)}% loss)`
            : `📊 MAX HEDGE - using full $${this.config.absoluteMaxHedgeUsd} ceiling to maximize protection`;

          this.logger.info(
            `[SmartHedging] ℹ️ Smart hedge exceeds ceiling:` +
              `\n  Smart hedge needed: $${profitableHedgeUsd.toFixed(2)} (to profit from upside)` +
              `\n  Using ceiling: $${this.config.absoluteMaxHedgeUsd}` +
              `\n  💡 Tip: Increase SMART_HEDGING_ABSOLUTE_MAX_USD to $${Math.ceil(profitableHedgeUsd)} to turn this into a winning trade`,
          );
        }
      } else {
        // Standard mode - use maxHedgeUsd as ceiling, but still aim for meaningful hedge
        if (profitableHedgeUsd <= this.config.maxHedgeUsd) {
          targetHedgeUsd = profitableHedgeUsd;
          hedgeSizeReason = `💰 SMART HEDGE within standard $${this.config.maxHedgeUsd} limit`;
        } else {
          // Use the full maxHedgeUsd to create a meaningful inverse trade
          targetHedgeUsd = this.config.maxHedgeUsd;
          hedgeSizeReason = `📊 MAX HEDGE - using full $${this.config.maxHedgeUsd} limit`;
          this.logger.info(
            `[SmartHedging] ℹ️ Smart hedge exceeds standard limit:` +
              `\n  Smart hedge needed: $${profitableHedgeUsd.toFixed(2)} (to profit from upside)` +
              `\n  Using limit: $${this.config.maxHedgeUsd}` +
              `\n  💡 Tip: Set SMART_HEDGING_ALLOW_EXCEED_MAX=true to allow larger hedges`,
          );
        }
      }

      // Check minimum hedge size - skip if below threshold
      if (targetHedgeUsd < this.config.minHedgeUsd) {
        this.logger.info(
          `[SmartHedging] ⏭️ Skipping hedge - calculated size below minimum:` +
            `\n  Position: ${position.size.toFixed(2)} ${originalSide} @ ${(position.entryPrice * 100).toFixed(1)}¢ = $${originalInvestment.toFixed(2)} invested` +
            `\n  Calculated hedge: $${targetHedgeUsd.toFixed(2)} (below minimum $${this.config.minHedgeUsd})` +
            `\n  💡 Tip: Micro-positions are better managed by stop-loss or allowed to expire`,
        );
        return false;
      }

      const hedgeShares = targetHedgeUsd / opposingPrice;

      // Calculate actual outcomes with chosen hedge size
      const totalInvested = originalInvestment + targetHedgeUsd;

      // If original side wins: original shares × $1 - total invested
      const originalWinPayout = position.size * 1.0;
      const originalWinProfit = originalWinPayout - totalInvested;

      // If hedge side wins: hedge shares × $1 - total invested
      const hedgeWinPayout = hedgeShares * 1.0;
      const hedgeWinProfit = hedgeWinPayout - totalInvested;

      const maxLoss = Math.min(originalWinProfit, hedgeWinProfit);
      const bestCaseProfit = Math.max(originalWinProfit, hedgeWinProfit);
      const canTurnIntoWinner = originalWinProfit >= 0 || hedgeWinProfit >= 0;

      // Build calculation details
      const calculation: HedgeCalculation = {
        originalInvestment,
        currentValue,
        unrealizedLoss,
        hedgePrice: opposingPrice,
        breakEvenHedgeSize: breakEvenHedgeUsd,
        profitableHedgeSize: profitableHedgeUsd,
        actualHedgeSize: targetHedgeUsd,
        profitIfOriginalWins: originalWinProfit,
        profitIfHedgeWins: hedgeWinProfit,
        canTurnIntoWinner,
      };

      // Detailed logging
      const outcomeDescription = canTurnIntoWinner
        ? `🎉 TURNING LOSER INTO WINNER!`
        : `📉 Capping loss at $${Math.abs(maxLoss).toFixed(2)}`;

      this.logger.info(
        `[SmartHedging] 🛡️ HEDGE CALCULATION:` +
          `\n  ═══════════════════════════════════════` +
          `\n  📊 ORIGINAL POSITION:` +
          `\n     ${position.size.toFixed(2)} ${originalSide} @ ${(position.entryPrice * 100).toFixed(1)}¢ = $${originalInvestment.toFixed(2)} invested` +
          `\n     Now @ ${(position.currentPrice * 100).toFixed(1)}¢ = $${currentValue.toFixed(2)} (${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(1)}%)` +
          `\n     Unrealized loss: $${unrealizedLoss.toFixed(2)}` +
          `\n  ───────────────────────────────────────` +
          `\n  🎯 HEDGE ANALYSIS:` +
          `\n     ${originalSide === "YES" ? "NO" : "YES"} price: ${(opposingPrice * 100).toFixed(1)}¢` +
          `\n     Break-even hedge: $${breakEvenHedgeUsd.toFixed(2)} (${breakEvenHedgeShares.toFixed(2)} shares)` +
          `\n     Profitable hedge: $${profitableHedgeUsd.toFixed(2)} (${profitableHedgeShares.toFixed(2)} shares)` +
          `\n  ───────────────────────────────────────` +
          `\n  ✅ EXECUTING: ${hedgeSizeReason}` +
          `\n     Buying: ${hedgeShares.toFixed(2)} ${originalSide === "YES" ? "NO" : "YES"} @ ${(opposingPrice * 100).toFixed(1)}¢ = $${targetHedgeUsd.toFixed(2)}` +
          `\n  ───────────────────────────────────────` +
          `\n  📈 OUTCOMES:` +
          `\n     If ${originalSide} wins: $${originalWinPayout.toFixed(2)} payout → ${originalWinProfit >= 0 ? "+" : ""}$${originalWinProfit.toFixed(2)}` +
          `\n     If ${originalSide === "YES" ? "NO" : "YES"} wins: $${hedgeWinPayout.toFixed(2)} payout → ${hedgeWinProfit >= 0 ? "+" : ""}$${hedgeWinProfit.toFixed(2)}` +
          `\n     ${outcomeDescription}` +
          `\n  ═══════════════════════════════════════`,
      );

      // Execute the hedge buy
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      if (!wallet) {
        this.logger.error(
          "[SmartHedging] ❌ Cannot execute hedge: client has no wallet attached. " +
            "Ensure ClobClient is constructed with a wallet for hedging to work.",
        );
        return false;
      }

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: opposingTokenId,
        outcome: originalSide === "YES" ? "NO" : "YES",
        side: "BUY",
        sizeUsd: targetHedgeUsd,
        maxAcceptablePrice: opposingPrice * 1.05, // 5% slippage tolerance
        logger: this.logger,
        priority: true, // High priority for hedging
        skipDuplicatePrevention: true, // Hedging must bypass duplicate prevention
        skipMinBuyPriceCheck: true, // Hedge buys are intentional at any price
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum for hedging
      });

      if (result.status === "submitted") {
        // Record the hedged position with full tracking
        const hedgedPosition: HedgedPosition = {
          marketId: position.marketId,
          originalTokenId: position.tokenId,
          hedgeTokenId: opposingTokenId,
          originalSide,
          originalEntryPrice: position.entryPrice,
          originalSize: position.size,
          originalInvestment,
          priceAtHedge: position.currentPrice,
          unrealizedLossAtHedge: unrealizedLoss,
          hedgeEntryPrice: opposingPrice,
          hedgeSize: hedgeShares,
          hedgeInvestment: targetHedgeUsd,
          hedgeTimestamp: Date.now(),
          maxLoss: Math.abs(maxLoss),
          bestCaseProfit,
          calculation,
        };

        const key = `${position.marketId}-${position.tokenId}`;
        this.hedgedPositions.set(key, hedgedPosition);

        // Track hedge token ID to avoid "hedge-ception" (hedging hedges)
        this.hedgeTokenIds.add(opposingTokenId);

        this.logger.info(
          `[SmartHedging] ✅ HEDGE SUCCESSFUL!` +
            `\n  ${canTurnIntoWinner ? "🎉 Loser turned into potential WINNER!" : `📉 Max loss capped at $${Math.abs(maxLoss).toFixed(2)}`}` +
            `\n  Best case: ${bestCaseProfit >= 0 ? "+" : ""}$${bestCaseProfit.toFixed(2)} | Worst case: ${maxLoss >= 0 ? "+" : ""}$${maxLoss.toFixed(2)}`,
        );
        return true;
      } else if (result.reason === "FOK_ORDER_KILLED") {
        // FOK order was submitted but killed (no fill) - market has insufficient liquidity
        this.logger.warn(
          `[SmartHedging] ⚠️ Hedge order not filled (FOK killed) - market has insufficient liquidity`,
        );
        return false;
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
   * Returns null if side cannot be determined (should skip hedging)
   */
  private determineSide(position: Position): "YES" | "NO" | null {
    // Position tracker provides side info
    const side = position.side?.toUpperCase();
    if (side === "YES" || side === "NO") {
      return side;
    }
    // Cannot determine side - log warning and return null
    this.logger.warn(
      `[SmartHedging] ⚠️ Cannot determine side for position ${position.marketId} - side value: "${position.side}"`,
    );
    return null;
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
            (t: { outcome?: string }) => t.outcome?.toUpperCase() === "YES",
          );
          const noToken = clobMarket.tokens.find(
            (t: { outcome?: string }) => t.outcome?.toUpperCase() === "NO",
          );

          if (yesToken?.token_id && noToken?.token_id) {
            this.marketTokenCache.set(marketId, {
              yesTokenId: yesToken.token_id,
              noTokenId: noToken.token_id,
            });
            return currentSide === "YES" ? noToken.token_id : yesToken.token_id;
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
   * Get strategy statistics with detailed hedge tracking
   */
  getStats(): {
    enabled: boolean;
    triggerLossPct: number;
    maxHedgeUsd: number;
    absoluteMaxHedgeUsd: number;
    allowExceedMaxForProtection: boolean;
    reservePct: number;
    hedgedPositionsCount: number;
    totalOriginalInvestment: number;
    totalHedgeInvestment: number;
    totalMaxLoss: number;
    totalBestCaseProfit: number;
    hedgesCanWin: number;
  } {
    let totalMaxLoss = 0;
    let totalBestCaseProfit = 0;
    let totalOriginalInvestment = 0;
    let totalHedgeInvestment = 0;
    let hedgesCanWin = 0;

    for (const hedge of this.hedgedPositions.values()) {
      totalMaxLoss += hedge.maxLoss;
      totalBestCaseProfit += hedge.bestCaseProfit;
      totalOriginalInvestment += hedge.originalInvestment;
      totalHedgeInvestment += hedge.hedgeInvestment;
      if (hedge.calculation.canTurnIntoWinner) {
        hedgesCanWin++;
      }
    }

    return {
      enabled: this.config.enabled,
      triggerLossPct: this.config.triggerLossPct,
      maxHedgeUsd: this.config.maxHedgeUsd,
      absoluteMaxHedgeUsd: this.config.absoluteMaxHedgeUsd,
      allowExceedMaxForProtection: this.config.allowExceedMaxForProtection,
      reservePct: this.config.reservePct,
      hedgedPositionsCount: this.hedgedPositions.size,
      totalOriginalInvestment,
      totalHedgeInvestment,
      totalMaxLoss,
      totalBestCaseProfit,
      hedgesCanWin,
    };
  }

  /**
   * Calculate the required reserve amount for potential hedges
   * This should be respected by other strategies to ensure hedging can occur
   *
   * @returns Required reserve in USD, or 0 if hedging is disabled or no positions need hedging
   */
  getRequiredReserve(): number {
    if (!this.config.enabled) {
      return 0;
    }

    const allPositions = this.positionTracker.getPositions();

    // Find positions that might need hedging soon
    const potentialHedgePositions = allPositions.filter((pos) => {
      const key = `${pos.marketId}-${pos.tokenId}`;
      if (this.hedgedPositions.has(key)) return false;
      if (this.hedgeTokenIds.has(pos.tokenId)) return false;
      if (pos.entryPrice >= this.config.maxEntryPriceForHedging) return false;
      if (pos.redeemable) return false;
      // Include positions that are losing OR approaching loss threshold
      return pos.pnlPct <= 0;
    });

    if (potentialHedgePositions.length === 0) {
      return 0;
    }

    // Calculate estimated funds needed for hedging
    // Use absoluteMaxHedgeUsd when allowExceedMaxForProtection is enabled
    const effectiveMaxHedge = this.config.allowExceedMaxForProtection
      ? this.config.absoluteMaxHedgeUsd
      : this.config.maxHedgeUsd;

    const estimatedHedgeFundsNeeded = potentialHedgePositions.reduce(
      (sum, pos) => {
        const positionValue = pos.size * pos.entryPrice;
        return sum + Math.min(positionValue, effectiveMaxHedge);
      },
      0,
    );

    // Return the target reserve amount
    return estimatedHedgeFundsNeeded * (this.config.reservePct / 100);
  }

  /**
   * Get detailed info about all hedged positions
   */
  getHedgedPositionsSummary(): Array<{
    marketId: string;
    originalSide: string;
    originalInvestment: number;
    hedgeInvestment: number;
    totalInvested: number;
    maxLoss: number;
    bestCaseProfit: number;
    canWin: boolean;
  }> {
    const summary: Array<{
      marketId: string;
      originalSide: string;
      originalInvestment: number;
      hedgeInvestment: number;
      totalInvested: number;
      maxLoss: number;
      bestCaseProfit: number;
      canWin: boolean;
    }> = [];

    for (const hedge of this.hedgedPositions.values()) {
      summary.push({
        marketId: hedge.marketId,
        originalSide: hedge.originalSide,
        originalInvestment: hedge.originalInvestment,
        hedgeInvestment: hedge.hedgeInvestment,
        totalInvested: hedge.originalInvestment + hedge.hedgeInvestment,
        maxLoss: hedge.maxLoss,
        bestCaseProfit: hedge.bestCaseProfit,
        canWin: hedge.calculation.canTurnIntoWinner,
      });
    }

    return summary;
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
 *
 * POSITION SIZING:
 * - Allow exceeding MAX_POSITION_USD for emergency protection
 * - When bleeding badly, full protection is more important than limits
 */
export const DEFAULT_SMART_HEDGING_CONFIG: SmartHedgingConfig = {
  // === CORE SETTINGS ===
  enabled: true, // Enabled by default per user request
  triggerLossPct: 20, // Trigger hedge consideration at 20% loss
  maxHedgeUsd: 10, // Max $10 per hedge (standard limit)
  minHedgeUsd: 1, // Minimum $1 per hedge (skip micro-hedges that don't provide meaningful protection)
  reservePct: 20, // Keep 20% in reserve for hedging
  maxEntryPriceForHedging: PRICE_TIERS.SPECULATIVE_MIN, // 60¢ - only risky tier
  minOpposingSidePrice: 0.5, // Opposing side must be at least 50¢

  // === POSITION SIZE LIMITS (EXCEED WHEN NEEDED) ===
  allowExceedMaxForProtection: true, // Allow exceeding maxHedgeUsd to stop the bleeding
  absoluteMaxHedgeUsd: 100, // Never hedge more than $100 (safety cap)
  emergencyLossThresholdPct: 30, // At 30%+ loss, use full protection mode

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
  reserveSellMinProfitPct: 2, // Only sell positions with 2%+ profit for reserves (lowered from 5% to enable hedging)
  criticalReserveThresholdPct: 50, // Urgent sell when reserves at 50% of target
  volumeDeclineThresholdPct: 30, // Prioritize selling positions with 30%+ volume decline

  // === FALLBACK LIQUIDATION ===
  enableFallbackLiquidation: true, // Don't let losers sit and go to zero - liquidate if hedge fails
  forceLiquidationLossPct: 50, // At 50%+ loss, force liquidate immediately to stop the bleeding
};
