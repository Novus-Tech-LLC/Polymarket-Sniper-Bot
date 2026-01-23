/**
 * Scalp Take-Profit Strategy
 *
 * A time-and-momentum-based profit-taking strategy that:
 * 1. Takes profits on positions held 30-120 minutes (configurable per preset)
 * 2. Requires +4-12% profit threshold (configurable per risk preset)
 *    - Conservative: 8-12%, Balanced: 5-8%, Aggressive: 4-6%
 * 3. Checks momentum indicators before exiting:
 *    - Price slope over last N ticks
 *    - Spread widening
 *    - Bid depth thinning
 * 4. CRITICAL SAFEGUARD: Never forces time-based exit on positions where:
 *    - Entry price ≤ 60¢ (speculative tier)
 *    - AND current price ≥ 90¢ (near resolution)
 *    These are $1.00 winners - let them ride to resolution!
 *
 * This strategy is designed to churn out consistent winners by
 * taking profits when momentum is fading, rather than waiting
 * indefinitely for resolution or $1.00.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";

/**
 * Scalp Take-Profit Configuration
 */
export interface ScalpTakeProfitConfig {
  /** Enable the strategy */
  enabled: boolean;

  /**
   * Minimum time (minutes) to hold before considering scalp exit
   * Default: 45 minutes (balanced), 30 (aggressive)
   */
  minHoldMinutes: number;

  /**
   * Maximum time (minutes) after which to force profit-taking (if profitable)
   * Default: 90 minutes (balanced), 60 (aggressive)
   */
  maxHoldMinutes: number;

  /**
   * Minimum profit percentage to trigger scalp exit (after min hold time)
   * Default: 5.0% (balanced), 4.0% (aggressive), 8.0% (conservative)
   */
  minProfitPct: number;

  /**
   * Target profit percentage - when reached, exit immediately (no momentum check needed)
   * Default: 8.0% (balanced), 6.0% (aggressive), 12.0% (conservative)
   */
  targetProfitPct: number;

  /**
   * Number of recent price ticks to analyze for momentum
   * Default: 5
   */
  momentumTickCount: number;

  /**
   * Minimum negative slope to trigger exit (indicates fading momentum)
   * If slope ≤ this value, consider exiting
   * Default: 0 (flat or declining = exit signal)
   */
  momentumSlopeThreshold: number;

  /**
   * Spread widening threshold (bps) to trigger exit
   * If current spread exceeds entry spread by this amount, exit
   * Default: 100 bps (1%)
   */
  spreadWideningThresholdBps: number;

  /**
   * Bid depth thinning threshold (percentage of original depth)
   * If bid depth drops below this % of what it was, exit
   * Default: 50% (bid depth halved = exit signal)
   */
  bidDepthThinningPct: number;

  /**
   * Entry price threshold for resolution exclusion
   * Positions with entry ≤ this price may be winners waiting to resolve
   * Default: 0.60 (60¢)
   */
  resolutionExclusionPrice: number;

  /**
   * Minimum absolute profit in USD for scalp exit
   * Prevents taking tiny profits that aren't worth the effort
   * Default: $0.50
   */
  minProfitUsd: number;

  // === SUDDEN SPIKE DETECTION ===
  // Captures immediate massive moves that could reverse quickly

  /**
   * Enable sudden spike detection for immediate profit capture
   * When a massive move happens quickly, take the profit before it reverses
   * Default: true
   */
  suddenSpikeEnabled: boolean;

  /**
   * Profit threshold (%) for sudden spike detection
   * If price spikes by this % within the spike window, exit immediately
   * Default: 15% - a 15% spike in minutes is unusual and may reverse
   */
  suddenSpikeThresholdPct: number;

  /**
   * Time window (minutes) for detecting sudden spikes
   * Measures price change over this recent period
   * Default: 10 minutes
   */
  suddenSpikeWindowMinutes: number;
}

/**
 * Price history entry for momentum tracking
 */
interface PriceHistoryEntry {
  timestamp: number;
  price: number;
  bidDepth: number;
  askDepth: number;
  spread: number;
}

/**
 * FEE AND SLIPPAGE CONSIDERATIONS
 * 
 * Polymarket fees: ~0.02% round-trip (0.01% per side)
 * Expected slippage: 0.5-2% depending on liquidity
 * Spread cost: typically 1-3%
 * 
 * TOTAL COST OF TRADE: ~2-5% when you factor in:
 * - Entry slippage (buying at ask)
 * - Exit slippage (selling at bid)
 * - Bid-ask spread
 * - Trading fees
 * 
 * Therefore, profit targets MUST be well above these costs!
 * - Minimum: 5% (to clear ~3% costs and still profit)
 * - Target: 8%+ (meaningful profit after all costs)
 * - Never scalp below 5% - you're just paying fees!
 */

/**
 * Default configuration - balanced settings
 * 
 * PROFIT TARGETS: Must clear transaction costs (fees + slippage + spread)!
 * A 3% "profit" can easily become a loss after costs. Target 5%+ minimum.
 * 
 * TIME WINDOWS: We ALWAYS respect the time window. No early exits!
 * - Wait at least minHoldMinutes before considering ANY exit
 * - After minHoldMinutes, exit only when profit >= target AND momentum fading
 * - After maxHoldMinutes, exit if profit >= minimum (don't let winners sit forever)
 * 
 * EXCEPTION - SUDDEN SPIKE: If price spikes massively in a short window
 * (e.g., +15% in 10 minutes), capture it immediately - such moves often reverse.
 * 
 * ENTRY TIMES: This strategy relies on the PositionTracker's historical
 * entry time loading from the wallet activity API. On container restart,
 * entry times are fetched from actual purchase history, NOT container
 * start time. See PositionTracker.loadHistoricalEntryTimes() for details.
 */
export const DEFAULT_SCALP_TAKE_PROFIT_CONFIG: ScalpTakeProfitConfig = {
  enabled: true,
  minHoldMinutes: 45,
  maxHoldMinutes: 90,
  minProfitPct: 5.0, // MINIMUM 5% - anything less gets eaten by costs!
  targetProfitPct: 8.0, // Target 8% for meaningful profit after costs
  momentumTickCount: 5,
  momentumSlopeThreshold: 0,
  spreadWideningThresholdBps: 100,
  bidDepthThinningPct: 50,
  resolutionExclusionPrice: 0.6,
  minProfitUsd: 1.0, // At least $1 profit or don't bother
  // Sudden spike detection
  suddenSpikeEnabled: true,
  suddenSpikeThresholdPct: 15.0, // 15% spike in short window = take it
  suddenSpikeWindowMinutes: 10,
};

/**
 * Conservative preset - patient, larger profits
 * 
 * Wait longer (60-120 min) for bigger profits (8-12%).
 * Best for larger positions where patience pays off.
 * $2.00 minimum profit ensures trades are truly worthwhile.
 * Higher spike threshold (20%) - only capture truly massive moves.
 */
export const CONSERVATIVE_SCALP_CONFIG: Partial<ScalpTakeProfitConfig> = {
  minHoldMinutes: 60,
  maxHoldMinutes: 120,
  minProfitPct: 8.0, // 8% minimum - well above costs
  targetProfitPct: 12.0, // 12% target - real profits
  minProfitUsd: 2.0, // $2 minimum profit
  suddenSpikeThresholdPct: 20.0, // Conservative: only 20%+ spikes
};

/**
 * Balanced preset - moderate patience and profit targets
 * 
 * Hold 45-90 minutes, target 5-8% profit.
 * Good balance of churn rate and profit per trade.
 * $1.00 minimum profit ensures trades matter after fees.
 * 15% spike threshold for sudden moves.
 */
export const BALANCED_SCALP_CONFIG: Partial<ScalpTakeProfitConfig> = {
  minHoldMinutes: 45,
  maxHoldMinutes: 90,
  minProfitPct: 5.0, // 5% minimum - clears typical costs
  targetProfitPct: 8.0, // 8% target - meaningful after costs
  minProfitUsd: 1.0, // $1 minimum profit
  suddenSpikeThresholdPct: 15.0, // Balanced: 15%+ spikes
};

/**
 * Aggressive preset - faster churn, but STILL meaningful profits
 * 
 * Faster exits (30-60 min) with 4-6% targets.
 * Higher sensitivity to momentum changes.
 * 
 * IMPORTANT: Even "aggressive" mode requires 4%+ profit!
 * We're aggressive on TIME, not on accepting tiny profits.
 * A 2% "profit" after fees/slippage is basically break-even.
 * Don't waste time and risk for nothing.
 */
export const AGGRESSIVE_SCALP_CONFIG: Partial<ScalpTakeProfitConfig> = {
  minHoldMinutes: 30,
  maxHoldMinutes: 60,
  minProfitPct: 4.0, // 4% minimum - even aggressive needs real profit
  targetProfitPct: 6.0, // 6% target
  momentumSlopeThreshold: -0.001, // More sensitive to declining momentum
  spreadWideningThresholdBps: 75, // More sensitive to spread changes
  bidDepthThinningPct: 60, // More sensitive to liquidity changes
  minProfitUsd: 0.50, // $0.50 minimum (aggressive accepts smaller absolute profits)
  suddenSpikeThresholdPct: 12.0, // Capture 12%+ spikes (more aggressive)
  suddenSpikeWindowMinutes: 5, // Shorter window - faster detection
};

/**
 * Scalp Take-Profit Strategy Implementation
 */
export class ScalpTakeProfitStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: ScalpTakeProfitConfig;

  // Track price history for momentum analysis
  // Key: tokenId, Value: array of price history entries
  private priceHistory: Map<string, PriceHistoryEntry[]> = new Map();

  // Track entry spread/depth for comparison
  private entryMetrics: Map<
    string,
    { spread: number; bidDepth: number; entryPrice: number }
  > = new Map();

  // Track positions we've already exited to avoid duplicate sells
  private exitedPositions: Set<string> = new Set();

  // Scalp statistics
  private stats = {
    scalpCount: 0,
    totalProfitUsd: 0,
    avgHoldMinutes: 0,
  };

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    positionTracker: PositionTracker;
    config: ScalpTakeProfitConfig;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.positionTracker = config.positionTracker;
    this.config = config.config;

    this.logger.info(
      `[ScalpTakeProfit] Initialized: ` +
        `hold=${this.config.minHoldMinutes}-${this.config.maxHoldMinutes}min, ` +
        `profit=${this.config.minProfitPct}-${this.config.targetProfitPct}%`,
    );
  }

  /**
   * Execute the scalp take-profit strategy
   * Returns number of positions scalped
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    const positions = this.positionTracker.getPositions();
    let scalpedCount = 0;
    const now = Date.now();

    // Update price history for all positions
    await this.updatePriceHistory(positions);

    for (const position of positions) {
      const positionKey = `${position.marketId}-${position.tokenId}`;

      // Skip if already exited
      if (this.exitedPositions.has(positionKey)) {
        continue;
      }

      // Skip resolved positions (handled by auto-redeem)
      if (position.redeemable) {
        continue;
      }

      // Check if position qualifies for scalp exit
      const exitDecision = await this.evaluateScalpExit(position, now);

      if (!exitDecision.shouldExit) {
        if (exitDecision.reason) {
          this.logger.debug(
            `[ScalpTakeProfit] Skip ${positionKey.slice(0, 20)}...: ${exitDecision.reason}`,
          );
        }
        continue;
      }

      // Execute the scalp exit
      this.logger.info(
        `[ScalpTakeProfit] 💰 Scalping position at +${position.pnlPct.toFixed(1)}% (+$${position.pnlUsd.toFixed(2)}): ${exitDecision.reason}`,
      );

      const sold = await this.sellPosition(position);
      if (sold) {
        scalpedCount++;
        this.exitedPositions.add(positionKey);
        this.updateStats(position);
      }
    }

    if (scalpedCount > 0) {
      this.logger.info(
        `[ScalpTakeProfit] ✅ Scalped ${scalpedCount} position(s)`,
      );
    }

    // Clean up stale tracking data
    this.cleanupStaleData(positions);

    return scalpedCount;
  }

  /**
   * Evaluate whether a position should be scalped
   */
  private async evaluateScalpExit(
    position: Position,
    now: number,
  ): Promise<{ shouldExit: boolean; reason?: string }> {
    const entryTime = this.positionTracker.getPositionEntryTime(
      position.marketId,
      position.tokenId,
    );

    if (!entryTime) {
      return { shouldExit: false, reason: "No entry time available" };
    }

    const holdMinutes = (now - entryTime) / (60 * 1000);

    // === CRITICAL SAFEGUARD: Resolution exclusion (checked FIRST) ===
    // Never force exit on positions that are near-certain $1.00 winners!
    // This check runs BEFORE all other exit logic to protect these positions.
    if (this.shouldExcludeFromTimeExit(position)) {
      return {
        shouldExit: false,
        reason: `Resolution exclusion: entry ≤${(this.config.resolutionExclusionPrice * 100).toFixed(0)}¢ + current ≥90¢ (near resolution)`,
      };
    }

    // === SUDDEN SPIKE DETECTION (bypasses hold time) ===
    // If there's been a massive move in a short window, capture it before reversal
    // Note: This runs AFTER resolution exclusion to protect $1.00 winners
    if (this.config.suddenSpikeEnabled) {
      const spikeCheck = this.checkSuddenSpike(position, now);
      if (spikeCheck.isSpike) {
        // Still require minimum profit in USD even for spikes
        if (position.pnlUsd >= this.config.minProfitUsd) {
          return {
            shouldExit: true,
            reason: `🚀 SUDDEN SPIKE: ${spikeCheck.reason}`,
          };
        }
      }
    }

    // === Check 1: Minimum hold time ===
    if (holdMinutes < this.config.minHoldMinutes) {
      return {
        shouldExit: false,
        reason: `Hold ${holdMinutes.toFixed(0)}min < min ${this.config.minHoldMinutes}min`,
      };
    }

    // === Check 2: Must be profitable ===
    if (position.pnlPct < this.config.minProfitPct) {
      return {
        shouldExit: false,
        reason: `Profit ${position.pnlPct.toFixed(1)}% < min ${this.config.minProfitPct}%`,
      };
    }

    // === Check 3: Minimum profit in USD ===
    if (position.pnlUsd < this.config.minProfitUsd) {
      return {
        shouldExit: false,
        reason: `Profit $${position.pnlUsd.toFixed(2)} < min $${this.config.minProfitUsd}`,
      };
    }

    // === Check 4: Target profit reached - TAKE IT! ===
    if (position.pnlPct >= this.config.targetProfitPct) {
      return {
        shouldExit: true,
        reason: `Target profit reached: +${position.pnlPct.toFixed(1)}% >= ${this.config.targetProfitPct}%`,
      };
    }

    // === Check 5: Max hold time exceeded with minimum profit ===
    if (holdMinutes >= this.config.maxHoldMinutes) {
      return {
        shouldExit: true,
        reason: `Max hold time: ${holdMinutes.toFixed(0)}min >= ${this.config.maxHoldMinutes}min at +${position.pnlPct.toFixed(1)}%`,
      };
    }

    // === Check 6: Momentum checks (for positions between min and max hold) ===
    const momentumCheck = await this.checkMomentum(position);
    if (momentumCheck.fadingMomentum) {
      return {
        shouldExit: true,
        reason: `Fading momentum: ${momentumCheck.reason}`,
      };
    }

    // Not time to exit yet
    return { shouldExit: false };
  }

  /**
   * Check for sudden price spike that should trigger immediate exit
   * 
   * A sudden spike is when price moves significantly in a short window.
   * These moves often reverse quickly (news events, whale activity, etc.)
   * so capturing them immediately can lock in gains before reversal.
   */
  private checkSuddenSpike(
    position: Position,
    now: number,
  ): { isSpike: boolean; reason?: string } {
    const history = this.priceHistory.get(position.tokenId);
    if (!history || history.length < 2) {
      return { isSpike: false };
    }

    const windowMs = this.config.suddenSpikeWindowMinutes * 60 * 1000;
    const windowStart = now - windowMs;

    // Find the earliest price in the spike detection window
    let earliestPriceInWindow: number | null = null;
    let earliestTimestamp = now;

    for (const tick of history) {
      if (tick.timestamp >= windowStart && tick.timestamp < earliestTimestamp) {
        earliestPriceInWindow = tick.price;
        earliestTimestamp = tick.timestamp;
      }
    }

    if (earliestPriceInWindow === null) {
      return { isSpike: false };
    }

    // Calculate price change percentage within the window
    const currentPrice = position.currentPrice;
    const priceChangePct =
      ((currentPrice - earliestPriceInWindow) / earliestPriceInWindow) * 100;

    // Check if it qualifies as a spike
    if (priceChangePct >= this.config.suddenSpikeThresholdPct) {
      const windowMinutes = (now - earliestTimestamp) / (60 * 1000);
      return {
        isSpike: true,
        reason: `+${priceChangePct.toFixed(1)}% in ${windowMinutes.toFixed(0)}min (threshold: ${this.config.suddenSpikeThresholdPct}%)`,
      };
    }

    return { isSpike: false };
  }

  /**
   * CRITICAL SAFEGUARD: Resolution Exclusion
   *
   * Never force time-based exit on positions where:
   * 1. Entry price ≤ 60¢ (speculative tier - potential big winners)
   * 2. AND current price >= 90¢ (near resolution - almost certain winner)
   *
   * These are positions that started speculative but are now near-certain
   * $1.00 winners. Don't force them out on a time window - let them ride!
   * 
   * Example: Bought at 50¢, now at 92¢ = don't force exit, let it resolve to $1.00
   * Example: Bought at 50¢, now at 65¢ = still speculative, scalp rules apply
   */
  private static readonly NEAR_RESOLUTION_THRESHOLD = 0.90; // 90¢ = near certain winner

  private shouldExcludeFromTimeExit(position: Position): boolean {
    // Only applies to low-entry positions (speculative tier or below)
    if (position.entryPrice > this.config.resolutionExclusionPrice) {
      return false;
    }

    // Only exclude if price has moved to near-resolution (90¢+)
    // A position at 65¢ is still speculative - scalp rules apply
    // A position at 92¢ is almost certainly going to $1.00 - let it ride!
    const nearResolution =
      position.currentPrice >= ScalpTakeProfitStrategy.NEAR_RESOLUTION_THRESHOLD;

    if (nearResolution) {
      this.logger.debug(
        `[ScalpTakeProfit] 🎯 Resolution exclusion active: ` +
          `entry ${(position.entryPrice * 100).toFixed(1)}¢ → current ${(position.currentPrice * 100).toFixed(1)}¢ ` +
          `(near resolution at 90¢+, let it ride to $1.00!)`,
      );
      return true;
    }

    return false;
  }

  /**
   * Check momentum indicators for exit signals
   */
  private async checkMomentum(
    position: Position,
  ): Promise<{ fadingMomentum: boolean; reason?: string }> {
    const history = this.priceHistory.get(position.tokenId);
    const entryMetrics = this.entryMetrics.get(position.tokenId);

    if (!history || history.length < this.config.momentumTickCount) {
      return { fadingMomentum: false };
    }

    // Get recent ticks
    const recentTicks = history.slice(-this.config.momentumTickCount);

    // === Check 1: Price slope ===
    const slope = this.calculateSlope(recentTicks);
    if (slope <= this.config.momentumSlopeThreshold) {
      return {
        fadingMomentum: true,
        reason: `Price slope ${slope.toFixed(4)} ≤ ${this.config.momentumSlopeThreshold} (flat/declining)`,
      };
    }

    if (!entryMetrics) {
      return { fadingMomentum: false };
    }

    // === Check 2: Spread widening ===
    const currentTick = recentTicks[recentTicks.length - 1];
    const spreadWidening =
      (currentTick.spread - entryMetrics.spread) * 10000; // Convert to bps
    if (spreadWidening >= this.config.spreadWideningThresholdBps) {
      return {
        fadingMomentum: true,
        reason: `Spread widened +${spreadWidening.toFixed(0)}bps >= ${this.config.spreadWideningThresholdBps}bps`,
      };
    }

    // === Check 3: Bid depth thinning ===
    if (entryMetrics.bidDepth > 0) {
      const depthRatio =
        (currentTick.bidDepth / entryMetrics.bidDepth) * 100;
      if (depthRatio < this.config.bidDepthThinningPct) {
        return {
          fadingMomentum: true,
          reason: `Bid depth thinned to ${depthRatio.toFixed(0)}% < ${this.config.bidDepthThinningPct}%`,
        };
      }
    }

    return { fadingMomentum: false };
  }

  /**
   * Calculate price slope from recent ticks
   * Returns positive for upward momentum, negative for downward
   */
  private calculateSlope(ticks: PriceHistoryEntry[]): number {
    if (ticks.length < 2) return 0;

    // Simple linear regression
    const n = ticks.length;
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += ticks[i].price;
      sumXY += i * ticks[i].price;
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  /**
   * Update price history for all positions
   */
  private async updatePriceHistory(positions: Position[]): Promise<void> {
    const now = Date.now();

    for (const position of positions) {
      try {
        const orderbook = await this.client.getOrderBook(position.tokenId);

        if (!orderbook.bids || !orderbook.asks) continue;
        if (orderbook.bids.length === 0 || orderbook.asks.length === 0)
          continue;

        const bestBid = parseFloat(orderbook.bids[0].price);
        const bestAsk = parseFloat(orderbook.asks[0].price);
        const spread = bestAsk - bestBid;
        const midPrice = (bestBid + bestAsk) / 2;

        // Calculate bid depth (top 5 levels)
        const bidDepth = orderbook.bids
          .slice(0, 5)
          .reduce(
            (sum, level) =>
              sum + parseFloat(level.size) * parseFloat(level.price),
            0,
          );

        // Calculate ask depth (top 5 levels)
        const askDepth = orderbook.asks
          .slice(0, 5)
          .reduce(
            (sum, level) =>
              sum + parseFloat(level.size) * parseFloat(level.price),
            0,
          );

        // Update history
        const history = this.priceHistory.get(position.tokenId) || [];
        history.push({
          timestamp: now,
          price: midPrice,
          bidDepth,
          askDepth,
          spread,
        });

        // Keep only recent history (last 20 ticks)
        if (history.length > 20) {
          history.shift();
        }

        this.priceHistory.set(position.tokenId, history);

        // Set entry metrics if not already set
        // LIMITATION: These "entry" metrics are captured when we first see the position,
        // not at actual entry time. After a container restart, these will reflect
        // market conditions at restart time rather than original entry conditions.
        // This means momentum signals (spread widening, bid depth thinning) may be
        // less reliable after restarts until the position is seen fresh again.
        // Entry TIME is still accurate (loaded from wallet activity API).
        if (!this.entryMetrics.has(position.tokenId)) {
          this.entryMetrics.set(position.tokenId, {
            spread,
            bidDepth,
            entryPrice: position.entryPrice,
          });
        }
      } catch {
        // Silently skip positions we can't get orderbook for
      }
    }
  }

  /**
   * Sell a position to take profit
   */
  private async sellPosition(position: Position): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[ScalpTakeProfit] No wallet`);
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
        this.logger.info(`[ScalpTakeProfit] ✅ Scalp sell executed`);
        return true;
      }

      this.logger.warn(
        `[ScalpTakeProfit] ⚠️ Scalp not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[ScalpTakeProfit] ❌ Scalp failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Update statistics after a successful scalp
   */
  private updateStats(position: Position): void {
    this.stats.scalpCount++;
    this.stats.totalProfitUsd += position.pnlUsd;

    const entryTime = this.positionTracker.getPositionEntryTime(
      position.marketId,
      position.tokenId,
    );
    if (entryTime) {
      const holdMinutes = (Date.now() - entryTime) / (60 * 1000);
      // Running average of hold time
      this.stats.avgHoldMinutes =
        (this.stats.avgHoldMinutes * (this.stats.scalpCount - 1) +
          holdMinutes) /
        this.stats.scalpCount;
    }
  }

  /**
   * Clean up tracking data for positions that no longer exist
   */
  private cleanupStaleData(currentPositions: Position[]): void {
    const currentTokenIds = new Set(currentPositions.map((p) => p.tokenId));
    const currentKeys = new Set(
      currentPositions.map((p) => `${p.marketId}-${p.tokenId}`),
    );

    // Clean up price history
    for (const tokenId of this.priceHistory.keys()) {
      if (!currentTokenIds.has(tokenId)) {
        this.priceHistory.delete(tokenId);
      }
    }

    // Clean up entry metrics
    for (const tokenId of this.entryMetrics.keys()) {
      if (!currentTokenIds.has(tokenId)) {
        this.entryMetrics.delete(tokenId);
      }
    }

    // Clean up exited positions that are no longer tracked
    for (const key of this.exitedPositions) {
      if (!currentKeys.has(key)) {
        this.exitedPositions.delete(key);
      }
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    scalpCount: number;
    totalProfitUsd: number;
    avgHoldMinutes: number;
  } {
    return {
      enabled: this.config.enabled,
      ...this.stats,
    };
  }

  /**
   * Reset strategy state (useful for testing or daily reset)
   */
  reset(): void {
    this.priceHistory.clear();
    this.entryMetrics.clear();
    this.exitedPositions.clear();
    this.stats = {
      scalpCount: 0,
      totalProfitUsd: 0,
      avgHoldMinutes: 0,
    };
  }
}
