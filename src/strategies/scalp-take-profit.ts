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
import {
  LogDeduper,
  SkipReasonAggregator,
  SKIP_LOG_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  TOKEN_ID_DISPLAY_LENGTH,
} from "../utils/log-deduper.util";

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

  // === LOW-PRICE VOLATILE SCALPING ===
  // Special handling for positions bought at very low prices (high volatility)
  // These positions can move quickly, so we take ANY profit immediately

  /**
   * Price threshold for "low price" volatile scalping mode
   * Positions with entry price at or below this take ANY profit immediately
   * Set to 0 to disable low-price scalping mode
   * Default: 0 (disabled) - set via SCALP_LOW_PRICE_THRESHOLD env
   * Example: 0.20 (20¢) - positions bought at or below 20¢ take any profit
   */
  lowPriceThreshold: number;

  /**
   * Maximum hold time (minutes) for low-price positions before cutting losses
   * If a low-price position hasn't profited within this window, exit at breakeven or trailing stop
   * This prevents holding volatile positions forever when they drop
   * Set to 0 to disable (hold indefinitely). Default: 3 minutes (quick scalps!)
   */
  lowPriceMaxHoldMinutes: number;
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
 * ENTRY TIMES (STATELESS, SURVIVES RESTARTS):
 * This strategy uses EntryMetaResolver to derive entry timestamps from the
 * Polymarket trade history API. This is STATELESS - no disk persistence.
 *
 * WHY THIS MATTERS:
 * Previously, entry times were tracked since container start. After container
 * restarts/redeploys, the "time held" clock reset and the scalper missed valid
 * take-profit opportunities on positions already in the green (e.g., showing
 * "20min" when the position was actually held for hours/days).
 *
 * NOW: timeHeldSec is computed from actual trade history timestamps:
 * - firstAcquiredAt: timestamp of the first BUY that contributed to position
 * - timeHeldSec = now - firstAcquiredAt (stable across restarts)
 *
 * See EntryMetaResolver and Position.timeHeldSec for implementation details.
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
  // Low-price instant profit mode (disabled by default)
  lowPriceThreshold: 0, // Set via SCALP_LOW_PRICE_THRESHOLD to enable (e.g., 0.20 for ≤20¢)
  lowPriceMaxHoldMinutes: 3, // Quick scalps - don't hold volatile positions long
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
  minProfitUsd: 0.5, // $0.50 minimum (aggressive accepts smaller absolute profits)
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

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

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

  // === LOG DEDUPLICATION ===
  // Shared LogDeduper for rate-limiting and deduplicating logs
  private logDeduper = new LogDeduper();
  // Cycle counter for summary logging
  private cycleCount = 0;

  // Rate-limit logging: track last summary log time and counts
  private lastSummaryLogAt = 0;
  private lastLoggedCounts = { profitable: 0, losing: 0, total: 0 };

  /**
   * Hysteresis tracking for skip log spam reduction
   * Key: positionKey, Value: { lastLogAt: timestamp, lastPnlPct: number }
   * Only log "Skip... Profit X%" if:
   * 1. Haven't logged for this position in last SKIP_LOG_COOLDOWN_MS, OR
   * 2. P&L has changed by more than SKIP_LOG_HYSTERESIS_PCT since last log
   */
  private skipLogTracker: Map<
    string,
    { lastLogAt: number; lastPnlPct: number }
  > = new Map();
  private static readonly SKIP_LOG_COOLDOWN_MS = 30_000; // Only log skip reason once per 30 seconds per position
  private static readonly SKIP_LOG_HYSTERESIS_PCT = 2.0; // Log again if P&L changes by more than 2%

  // Constants
  private static readonly SUMMARY_LOG_INTERVAL_MS = 60_000; // Log summary at most once per minute
  // Value used when no entry time is available - assumes position held long enough for all checks
  private static readonly NO_ENTRY_TIME_HOLD_MINUTES = 999999;

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
   *
   * CRITICAL FIX: This method now uses timeHeldSec from trade history API instead of
   * container uptime. Previously, after container restarts, the "time held" clock
   * would reset and the scalper would miss valid take-profit opportunities.
   * Now we derive entry timestamps from actual trade history, which survives restarts.
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // CRITICAL: Get positions enriched with entry metadata from trade history API
    // This provides accurate timeHeldSec that survives container restarts
    const enrichedPositions =
      await this.positionTracker.enrichPositionsWithEntryMeta();
    const positions = this.positionTracker.getPositions();
    let scalpedCount = 0;
    const now = Date.now();

    // Update price history for all positions
    await this.updatePriceHistory(positions);

    // Use PositionTracker as the source of truth for position summaries
    // This ensures consistent reporting across all strategies
    const activePositions = this.positionTracker.getActivePositions();
    const profitable = this.positionTracker.getActiveProfitablePositions();
    const losing = this.positionTracker.getActiveLosingPositions();
    const targetProfit = this.positionTracker.getActivePositionsAboveTarget(
      this.config.targetProfitPct,
    );
    const minProfit = this.positionTracker.getActivePositionsAboveTarget(
      this.config.minProfitPct,
    );

    // Rate-limited logging: log summary at most once per minute or when counts change significantly
    const countsChanged =
      this.lastLoggedCounts.profitable !== profitable.length ||
      this.lastLoggedCounts.losing !== losing.length ||
      this.lastLoggedCounts.total !== activePositions.length;
    const shouldLogSummary =
      countsChanged ||
      now - this.lastSummaryLogAt >=
        ScalpTakeProfitStrategy.SUMMARY_LOG_INTERVAL_MS;

    if (shouldLogSummary) {
      this.lastSummaryLogAt = now;
      this.lastLoggedCounts = {
        profitable: profitable.length,
        losing: losing.length,
        total: activePositions.length,
      };

      // Log summary at DEBUG level (use INFO only when there are positions at target profit threshold)
      if (targetProfit.length > 0) {
        this.logger.info(
          `[ScalpTakeProfit] 📊 Active positions: ${activePositions.length} total | ` +
            `${profitable.length} profitable (>0%) | ${losing.length} losing | ` +
            `${targetProfit.length} >= target ${this.config.targetProfitPct}%`,
        );
      } else {
        this.logger.debug(
          `[ScalpTakeProfit] 📊 Active positions: ${activePositions.length} total | ` +
            `${profitable.length} profitable (>0%) | ${losing.length} losing | ` +
            `${minProfit.length} >= min ${this.config.minProfitPct}% | ` +
            `${targetProfit.length} >= target ${this.config.targetProfitPct}%`,
        );
      }

      // Log profitable positions at DEBUG level with STATELESS timeHeldSec from trade history
      if (profitable.length > 0) {
        for (const p of profitable.slice(0, 10)) {
          // Top 10
          // Find enriched position to get timeHeldSec from trade history
          const enriched = enrichedPositions.find(
            (ep) => ep.tokenId === p.tokenId,
          );
          const holdMin =
            enriched?.timeHeldSec !== undefined
              ? Math.round(enriched.timeHeldSec / 60)
              : "?";
          const entryPriceCents =
            enriched?.avgEntryPriceCents !== undefined
              ? enriched.avgEntryPriceCents.toFixed(1)
              : (p.entryPrice * 100).toFixed(1);
          this.logger.debug(
            `[ScalpTakeProfit] 💰 ${p.tokenId.slice(0, 12)}... +${p.pnlPct.toFixed(1)}% ($${p.pnlUsd.toFixed(2)}) | ` +
              `entry=${entryPriceCents}¢ current=${(p.currentPrice * 100).toFixed(1)}¢ | ` +
              `held=${holdMin}min | size=${p.size.toFixed(2)}`,
          );
        }
        if (profitable.length > 10) {
          this.logger.debug(
            `[ScalpTakeProfit] ... and ${profitable.length - 10} more profitable positions`,
          );
        }
      }
    }

    // Log highly profitable positions that should be candidates for scalping
    // CRITICAL: Uses timeHeldSec from trade history API, not container uptime
    const highlyProfitable = this.positionTracker.getActivePositionsAboveTarget(
      this.config.targetProfitPct,
    );
    if (highlyProfitable.length > 0) {
      this.logger.info(
        `[ScalpTakeProfit] 🎯 ${highlyProfitable.length} position(s) at/above target profit (${this.config.targetProfitPct}%): ` +
          highlyProfitable
            .slice(0, 5)
            .map((p) => {
              // Find enriched position to get timeHeldSec from trade history
              const enriched = enrichedPositions.find(
                (ep) => ep.tokenId === p.tokenId,
              );
              const holdMin =
                enriched?.timeHeldSec !== undefined
                  ? Math.round(enriched.timeHeldSec / 60)
                  : "?";
              return `${p.tokenId.slice(0, 8)}...+${p.pnlPct.toFixed(1)}%/$${p.pnlUsd.toFixed(2)} (${holdMin}min)`;
            })
            .join(", ") +
          (highlyProfitable.length > 5 ? "..." : ""),
      );
    }

    // Iterate over ENRICHED positions to use trade history-derived timeHeldSec
    // === LOG DEDUPLICATION: Use aggregated skip summaries instead of per-position logs ===
    const skipAggregator = new SkipReasonAggregator();
    this.cycleCount++;

    for (const position of enrichedPositions) {
      const positionKey = `${position.marketId}-${position.tokenId}`;
      const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

      // Skip if already exited
      if (this.exitedPositions.has(positionKey)) {
        skipAggregator.add(tokenIdShort, "already_exited");
        continue;
      }

      // STRATEGY GATE: Skip resolved positions - route to AutoRedeem only
      // Resolved markets cannot be sold on the CLOB; they must be redeemed on-chain
      if (position.redeemable) {
        skipAggregator.add(tokenIdShort, "redeemable");
        continue;
      }

      // STRATEGY GATE: Skip positions with NO_BOOK status
      // These positions have no orderbook data - P&L calculation uses fallback pricing
      // which may be inaccurate. Better to skip than make bad decisions.
      if (position.status === "NO_BOOK") {
        skipAggregator.add(tokenIdShort, "no_book");
        continue;
      }

      // STRATEGY GATE: Verify we have bid price for accurate P&L
      // If currentBidPrice is undefined, P&L may be based on fallback/stale data
      if (position.currentBidPrice === undefined) {
        skipAggregator.add(tokenIdShort, "no_bid");
        continue;
      }

      // Check if this is a low-price position that needs special handling
      // Low-price positions can intentionally exit at small losses after lowPriceMaxHoldMinutes
      const isLowPricePosition =
        this.config.lowPriceThreshold > 0 &&
        position.entryPrice <= this.config.lowPriceThreshold;

      // EARLY SKIP: Skip positions in the red (negative profit) - UNLESS it's a low-price position
      // Low-price positions have time-limit logic that can exit at small losses
      // Regular losing positions should be handled by Smart Hedging or Universal Stop-Loss
      if (position.pnlPct < 0 && !isLowPricePosition) {
        skipAggregator.add(tokenIdShort, "losing");
        continue;
      }

      // Check if position qualifies for scalp exit
      const exitDecision = await this.evaluateScalpExit(position, now);

      if (!exitDecision.shouldExit) {
        // Categorize skip reason for aggregation using case-insensitive pattern matching
        if (exitDecision.reason) {
          const reasonLower = exitDecision.reason.toLowerCase();
          if (reasonLower.includes("hold") && reasonLower.includes("min")) {
            // Matches: "Hold Xmin < min Ymin", "Low-price position waiting..."
            skipAggregator.add(tokenIdShort, "hold_time");
          } else if (
            reasonLower.includes("profit") &&
            (reasonLower.includes("< min") || reasonLower.includes("below"))
          ) {
            // Matches: "Profit X% < min Y%", "Profit $X < min $Y"
            skipAggregator.add(tokenIdShort, "below_min_profit");
          } else if (reasonLower.includes("resolution exclusion")) {
            // Matches: "Resolution exclusion: entry..."
            skipAggregator.add(tokenIdShort, "resolution_exclusion");
          } else if (reasonLower.includes("low-price")) {
            // Matches various low-price scenarios
            skipAggregator.add(tokenIdShort, "low_price_wait");
          } else {
            skipAggregator.add(tokenIdShort, "other");
          }
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

        // Clear skip log tracker since position is now exited
        this.skipLogTracker.delete(positionKey);

        // Invalidate orderbook cache for this token to ensure fresh data on next refresh
        this.positionTracker.invalidateOrderbookCache(position.tokenId);
      }
    }

    // === LOG DEDUPLICATION: Emit aggregated skip summary (rate-limited) ===
    if (skipAggregator.hasSkips()) {
      const fingerprint = skipAggregator.getFingerprint();
      if (this.logDeduper.shouldLogSummary("Scalp", fingerprint)) {
        this.logger.debug(
          `[ScalpTakeProfit] Skipped ${skipAggregator.getTotalCount()} positions: ${skipAggregator.getSummary()} (cycle=${this.cycleCount})`,
        );
      }
    }

    if (scalpedCount > 0) {
      this.logger.info(
        `[ScalpTakeProfit] ✅ Scalped ${scalpedCount} position(s)`,
      );
    }

    // Clean up stale tracking data (use enrichedPositions since they include all ACTIVE positions)
    this.cleanupStaleData(enrichedPositions);

    return scalpedCount;
  }

  /**
   * Evaluate whether a position should be scalped
   *
   * CRITICAL: Uses position.timeHeldSec from trade history API when available.
   * This is stateless and survives container restarts. Falls back to container
   * uptime only when trade history cannot be resolved (legacy behavior).
   */
  private async evaluateScalpExit(
    position: Position,
    now: number,
  ): Promise<{ shouldExit: boolean; reason?: string }> {
    // CRITICAL FIX: Use timeHeldSec from trade history API (stateless, survives restarts)
    // Falls back to container uptime only if trade history is unavailable
    let holdMinutes: number;
    let hasTradeHistoryTime = false;

    if (position.timeHeldSec !== undefined) {
      // Use stateless timeHeldSec from trade history API (preferred)
      holdMinutes = position.timeHeldSec / 60;
      hasTradeHistoryTime = true;
    } else {
      // Fallback to legacy container uptime-based tracking
      // WHY THIS IS WRONG: After container restart, this clock resets to 0.
      // We only use this as fallback when trade history API is unavailable.
      const entryTime = this.positionTracker.getPositionEntryTime(
        position.marketId,
        position.tokenId,
      );

      if (entryTime) {
        holdMinutes = (now - entryTime) / (60 * 1000);
      } else {
        // If no entry time at all, treat position as "old enough" (assume external purchase)
        // Use a very large holdMinutes value so all hold time checks pass
        holdMinutes = ScalpTakeProfitStrategy.NO_ENTRY_TIME_HOLD_MINUTES;
      }
    }

    // Log if we couldn't get trade history time (important diagnostic)
    if (
      !hasTradeHistoryTime &&
      holdMinutes < ScalpTakeProfitStrategy.NO_ENTRY_TIME_HOLD_MINUTES
    ) {
      this.logger.debug(
        `[ScalpTakeProfit] Position ${position.tokenId.slice(0, 8)}... using FALLBACK entry time (container uptime). ` +
          `Trade history not available - timeHeldSec may be inaccurate after restarts.`,
      );
    }

    // === LOW-PRICE SCALPING MODE ===
    // For volatile low-price positions, special handling:
    // 1. Take ANY profit immediately (no waiting)
    // 2. If held too long without profit, exit to avoid holding losers forever
    const isLowPricePosition =
      this.config.lowPriceThreshold > 0 &&
      position.entryPrice <= this.config.lowPriceThreshold;

    if (isLowPricePosition) {
      // Take ANY profit immediately
      if (position.pnlPct > 0) {
        return {
          shouldExit: true,
          reason: `⚡ LOW-PRICE INSTANT PROFIT: Entry ${(position.entryPrice * 100).toFixed(1)}¢ ≤ ${(this.config.lowPriceThreshold * 100).toFixed(0)}¢ threshold, taking +${position.pnlPct.toFixed(1)}% profit immediately`,
        };
      }

      // Time window for low-price positions - don't hold losers forever
      // After maxHoldMinutes, try to exit at breakeven or small loss
      if (
        this.config.lowPriceMaxHoldMinutes > 0 &&
        holdMinutes >= this.config.lowPriceMaxHoldMinutes
      ) {
        // If loss is small (< 10%), exit to cut losses on volatile position
        if (position.pnlPct > -10) {
          return {
            shouldExit: true,
            reason: `⏱️ LOW-PRICE TIME LIMIT: Held ${holdMinutes.toFixed(0)}min ≥ ${this.config.lowPriceMaxHoldMinutes}min, exiting at ${position.pnlPct.toFixed(1)}% to avoid holding volatile loser`,
          };
        }
        // If loss is large, log but don't force exit (stop-loss will handle)
        this.logger.debug(
          `[ScalpTakeProfit] Low-price position at ${position.pnlPct.toFixed(1)}% loss after ${holdMinutes.toFixed(0)}min - stop-loss will handle`,
        );
      }

      // Still in window, waiting for profit opportunity
      return {
        shouldExit: false,
        reason: `Low-price position waiting for profit (${holdMinutes.toFixed(0)}/${this.config.lowPriceMaxHoldMinutes}min)`,
      };
    }

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

    // === CRITICAL: Extremely high profit override ===
    // If profit is massive (3x target or 25%+), sell immediately regardless of hold time
    // These are rare opportunities that could reverse - take the money!
    const extremeProfitThreshold = Math.max(
      this.config.targetProfitPct * 3,
      25,
    );
    if (
      position.pnlPct >= extremeProfitThreshold &&
      position.pnlUsd >= this.config.minProfitUsd
    ) {
      return {
        shouldExit: true,
        reason: `🔥 EXTREME PROFIT: +${position.pnlPct.toFixed(1)}% >= ${extremeProfitThreshold.toFixed(0)}% threshold - TAKE IT NOW!`,
      };
    }

    // === Check 1: Minimum hold time ===
    // Note: This can be bypassed by extreme profit above
    if (holdMinutes < this.config.minHoldMinutes) {
      // Log if we're skipping a profitable position due to hold time
      if (position.pnlPct >= this.config.targetProfitPct) {
        this.logger.debug(
          `[ScalpTakeProfit] ⏳ Position at +${position.pnlPct.toFixed(1)}% waiting for hold time (${holdMinutes.toFixed(0)}/${this.config.minHoldMinutes}min)`,
        );
      }
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
  private static readonly NEAR_RESOLUTION_THRESHOLD = 0.9; // 90¢ = near certain winner

  private shouldExcludeFromTimeExit(position: Position): boolean {
    // Only applies to low-entry positions (speculative tier or below)
    if (position.entryPrice > this.config.resolutionExclusionPrice) {
      return false;
    }

    // Only exclude if price has moved to near-resolution (90¢+)
    // A position at 65¢ is still speculative - scalp rules apply
    // A position at 92¢ is almost certainly going to $1.00 - let it ride!
    const nearResolution =
      position.currentPrice >=
      ScalpTakeProfitStrategy.NEAR_RESOLUTION_THRESHOLD;

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
    const spreadWidening = (currentTick.spread - entryMetrics.spread) * 10000; // Convert to bps
    if (spreadWidening >= this.config.spreadWideningThresholdBps) {
      return {
        fadingMomentum: true,
        reason: `Spread widened +${spreadWidening.toFixed(0)}bps >= ${this.config.spreadWideningThresholdBps}bps`,
      };
    }

    // === Check 3: Bid depth thinning ===
    if (entryMetrics.bidDepth > 0) {
      const depthRatio = (currentTick.bidDepth / entryMetrics.bidDepth) * 100;
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
   * Uses position.timeHeldSec from trade history API when available (preferred)
   */
  private updateStats(position: Position): void {
    this.stats.scalpCount++;
    this.stats.totalProfitUsd += position.pnlUsd;

    // Prefer stateless timeHeldSec from trade history API
    let holdMinutes: number | undefined;

    if (position.timeHeldSec !== undefined) {
      // Use stateless timeHeldSec from trade history API (survives restarts)
      holdMinutes = position.timeHeldSec / 60;
    } else {
      // Fallback to container uptime-based tracking
      const entryTime = this.positionTracker.getPositionEntryTime(
        position.marketId,
        position.tokenId,
      );
      if (entryTime) {
        holdMinutes = (Date.now() - entryTime) / (60 * 1000);
      }
    }

    if (holdMinutes !== undefined) {
      // Running average of hold time
      this.stats.avgHoldMinutes =
        (this.stats.avgHoldMinutes * (this.stats.scalpCount - 1) +
          holdMinutes) /
        this.stats.scalpCount;
    }
  }

  /**
   * Check if we should log a skip reason for this position
   * Implements hysteresis to reduce log spam:
   * 1. Must have been > SKIP_LOG_COOLDOWN_MS since last log for this position, OR
   * 2. P&L must have changed by > SKIP_LOG_HYSTERESIS_PCT since last log
   */
  private shouldLogSkip(positionKey: string, currentPnlPct: number): boolean {
    const tracker = this.skipLogTracker.get(positionKey);
    const now = Date.now();

    if (!tracker) {
      // Never logged for this position
      return true;
    }

    // Check cooldown
    if (
      now - tracker.lastLogAt >=
      ScalpTakeProfitStrategy.SKIP_LOG_COOLDOWN_MS
    ) {
      return true;
    }

    // Check P&L change threshold (hysteresis)
    const pnlChange = Math.abs(currentPnlPct - tracker.lastPnlPct);
    if (pnlChange >= ScalpTakeProfitStrategy.SKIP_LOG_HYSTERESIS_PCT) {
      return true;
    }

    return false;
  }

  /**
   * Record that we logged a skip for this position
   */
  private recordSkipLog(positionKey: string, pnlPct: number): void {
    this.skipLogTracker.set(positionKey, {
      lastLogAt: Date.now(),
      lastPnlPct: pnlPct,
    });
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

    // Clean up skip log tracker for positions that are no longer tracked
    for (const key of this.skipLogTracker.keys()) {
      if (!currentKeys.has(key)) {
        this.skipLogTracker.delete(key);
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
