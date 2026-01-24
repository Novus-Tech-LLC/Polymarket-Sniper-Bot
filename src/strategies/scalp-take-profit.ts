/**
 * Scalp Take-Profit Strategy with Exit Ladder
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
 * EXIT LADDER (Jan 2025 Refactor):
 * When a scalp is triggered (sudden spike, target profit reached, etc.), the
 * position enters an ExitPlan state machine that guarantees eventual exit:
 *
 * Stage A - PROFIT (first SCALP_EXIT_WINDOW_SEC * 0.6):
 *   - Attempt SELL at target profit price (or bestBid if higher)
 *   - Retry every SCALP_PROFIT_RETRY_SEC with slightly lower limit
 *
 * Stage B - BREAKEVEN (remaining time in window):
 *   - If bestBid >= avgEntryPrice, sell at avgEntry (or bestBid if higher)
 *   - Still avoids loss, just releases capital
 *
 * Stage C - FORCE (when window expires):
 *   - Sell at bestBid immediately, even at loss
 *   - Frees capital, prevents stuck positions
 *
 * NON-NEGOTIABLES:
 * - Sell sizing uses position notional (sharesHeld * limitPrice), NOT profitUsd
 * - If notional < MIN_ORDER_USD, treat as DUST and skip
 * - If no bestBid (NO_BOOK), mark as BLOCKED and retry with backoff
 *
 * This strategy is designed to churn out consistent winners by
 * taking profits when momentum is fading, rather than waiting
 * indefinitely for resolution or $1.00.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type {
  PositionTracker,
  Position,
  PortfolioSnapshot,
} from "./position-tracker";
import { postOrder } from "../utils/post-order.util";
import {
  LogDeduper,
  SkipReasonAggregator,
  SKIP_LOG_TTL_MS,
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

  // === EXIT LADDER CONFIGURATION (Jan 2025) ===
  // When a scalp is triggered, these settings control the exit ladder behavior

  /**
   * Exit window duration in seconds for the exit ladder
   * After a position is flagged for scalp, it enters an exit window.
   * The ladder progresses: PROFIT -> BREAKEVEN -> FORCE
   * Default: 120 seconds (2 minutes)
   */
  exitWindowSec: number;

  /**
   * Retry cadence in seconds during the PROFIT stage of exit ladder
   * How often to retry the profitable exit attempt
   * Default: 15 seconds
   */
  profitRetrySec: number;

  /**
   * Minimum order size in USD
   * Used to check if position notional is tradeable (not dust)
   * Default: 5 (from MIN_ORDER_USD or config)
   */
  minOrderUsd: number;
}

/**
 * ORDERBOOK QUALITY VALIDATION (Jan 2025)
 *
 * Detects corrupted/mismatched orderbook data that would cause scalp failures.
 * Common scenarios:
 * 1. INVALID_BOOK: bestBid=0.01, bestAsk=0.99 (likely wrong tokenId or cache pollution)
 * 2. EXEC_PRICE_UNTRUSTED: bestBid differs from Data-API price by > 30¢
 * 3. NO_EXECUTION_PRICE: Missing bid/ask data entirely
 *
 * When orderbook quality is poor, ScalpExit MUST NOT attempt trades and should
 * enter a cooldown period for that tokenId.
 */
export type OrderbookQualityStatus =
  | "VALID" // Orderbook is usable for execution
  | "INVALID_BOOK" // Extreme spread (bid < 5¢, ask > 95¢) - likely wrong token/cache
  | "EXEC_PRICE_UNTRUSTED" // Bid differs from Data-API price by > 30¢
  | "NO_EXECUTION_PRICE"; // No bid/ask data available

/**
 * Thresholds for orderbook quality validation
 */
export const ORDERBOOK_QUALITY_THRESHOLDS = {
  /** If bestBid is below this, it's suspiciously low */
  INVALID_BID_THRESHOLD: 0.05, // 5¢
  /** If bestAsk is above this, it's suspiciously high */
  INVALID_ASK_THRESHOLD: 0.95, // 95¢
  /** Max acceptable difference between bestBid and dataApiPrice */
  MAX_PRICE_DEVIATION: 0.30, // 30¢
};

/**
 * Result of orderbook quality validation
 */
export interface OrderbookQualityResult {
  status: OrderbookQualityStatus;
  /** Human-readable reason for the status */
  reason?: string;
  /** Diagnostic data for logging */
  diagnostics?: {
    bestBid: number | null;
    bestAsk: number | null;
    dataApiPrice?: number;
    spread?: number;
    priceDeviation?: number;
  };
}

/**
 * Validate orderbook quality for execution safety.
 *
 * @param bestBid Best bid price from CLOB (null if missing)
 * @param bestAsk Best ask price from CLOB (null if missing)
 * @param dataApiPrice Reference price from Data-API (optional)
 * @returns OrderbookQualityResult with status and diagnostics
 */
export function validateOrderbookQuality(
  bestBid: number | null,
  bestAsk: number | null,
  dataApiPrice?: number,
): OrderbookQualityResult {
  const diagnostics: OrderbookQualityResult["diagnostics"] = {
    bestBid,
    bestAsk,
    dataApiPrice,
  };

  // NO_EXECUTION_PRICE: Missing bid data
  if (bestBid === null || bestBid === 0) {
    return {
      status: "NO_EXECUTION_PRICE",
      reason: "No bestBid available from orderbook",
      diagnostics,
    };
  }

  // INVALID_BOOK: Extreme spread indicating wrong token mapping or cache pollution
  // bestBid < 5¢ AND bestAsk > 95¢ is a clear indicator of corrupted data
  if (
    bestAsk !== null &&
    bestAsk > 0 &&
    bestBid < ORDERBOOK_QUALITY_THRESHOLDS.INVALID_BID_THRESHOLD &&
    bestAsk > ORDERBOOK_QUALITY_THRESHOLDS.INVALID_ASK_THRESHOLD
  ) {
    diagnostics.spread = bestAsk - bestBid;
    return {
      status: "INVALID_BOOK",
      reason: `Extreme spread: bestBid=${(bestBid * 100).toFixed(1)}¢ < 5¢ AND bestAsk=${(bestAsk * 100).toFixed(1)}¢ > 95¢ (likely wrong tokenId or cache pollution)`,
      diagnostics,
    };
  }

  // EXEC_PRICE_UNTRUSTED: bestBid differs too much from Data-API reference price
  if (dataApiPrice !== undefined && dataApiPrice > 0) {
    const priceDeviation = Math.abs(bestBid - dataApiPrice);
    diagnostics.priceDeviation = priceDeviation;

    if (priceDeviation > ORDERBOOK_QUALITY_THRESHOLDS.MAX_PRICE_DEVIATION) {
      return {
        status: "EXEC_PRICE_UNTRUSTED",
        reason: `bestBid=${(bestBid * 100).toFixed(1)}¢ deviates from dataApiPrice=${(dataApiPrice * 100).toFixed(1)}¢ by ${(priceDeviation * 100).toFixed(1)}¢ (> ${(ORDERBOOK_QUALITY_THRESHOLDS.MAX_PRICE_DEVIATION * 100).toFixed(0)}¢ threshold)`,
        diagnostics,
      };
    }
  }

  // VALID: Orderbook passed all checks
  return {
    status: "VALID",
    diagnostics,
  };
}

/**
 * Circuit breaker entry for per-token execution disabling.
 *
 * When orderbook quality is repeatedly poor for a tokenId, we disable
 * execution attempts with escalating cooldowns to prevent spam.
 */
export interface ExecutionCircuitBreakerEntry {
  /** Unix timestamp (ms) when this token becomes re-enabled */
  disabledUntilMs: number;
  /** Reason for disabling */
  reason: OrderbookQualityStatus;
  /** Last observed bestBid when disabled */
  lastBid: number | null;
  /** Last observed bestAsk when disabled */
  lastAsk: number | null;
  /** Number of consecutive failures (for cooldown escalation) */
  failureCount: number;
  /** Unix timestamp (ms) of last failure */
  lastFailureAtMs: number;
}

/**
 * Cooldown escalation ladder for circuit breaker.
 * Consecutive failures increase cooldown: 1m -> 5m -> 15m -> 60m (max)
 */
export const CIRCUIT_BREAKER_COOLDOWNS_MS = [
  60_000, // 1 minute
  300_000, // 5 minutes
  900_000, // 15 minutes
  3_600_000, // 60 minutes (max)
];

/**
 * Window in which consecutive failures will escalate the cooldown.
 * If the last failure was more than this long ago, reset failure count.
 * Default: 2 hours (allows time for market conditions to change)
 */
export const CIRCUIT_BREAKER_ESCALATION_WINDOW_MS = 7_200_000; // 2 hours

/**
 * Dust cooldown duration (10 minutes)
 */
export const DUST_COOLDOWN_MS = 600_000;

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
 * Exit Ladder Stage
 *
 * The exit ladder progresses through these stages when trying to exit a position:
 * - PROFIT: Try to exit at target profit price (most aggressive)
 * - BREAKEVEN: If PROFIT fails, try to exit at average entry price (no loss)
 * - FORCE: If window expires, exit at best bid even at loss (capital recovery)
 */
export type ExitLadderStage = "PROFIT" | "BREAKEVEN" | "FORCE";

/**
 * Exit Plan State
 *
 * Tracks the state of an in-progress exit attempt for a position.
 * This state machine persists across execution cycles (in-memory).
 */
export interface ExitPlan {
  /** The tokenId this plan applies to */
  tokenId: string;
  /** Unix timestamp (ms) when the exit plan started */
  startedAtMs: number;
  /** Current stage in the exit ladder */
  stage: ExitLadderStage;
  /** Last time an exit attempt was made (ms) */
  lastAttemptAtMs: number;
  /** Number of exit attempts made */
  attempts: number;
  /** Average entry price in cents (for breakeven calculation) */
  avgEntryCents: number;
  /** Target profit price in cents (initial target) */
  targetPriceCents: number;
  /** Position shares at plan creation (for notional calc) */
  sharesHeld: number;
  /** P&L % when plan started (for logging) */
  initialPnlPct: number;
  /** P&L USD when plan started (for logging) */
  initialPnlUsd: number;
  /** If blocked due to execution issues, track for backoff */
  blockedReason?: "NO_BID" | "DUST" | "INVALID_BOOK" | "EXEC_PRICE_UNTRUSTED" | "DUST_COOLDOWN";
  /** When blocked, timestamp of last block occurrence */
  blockedAtMs?: number;
  /** Whether START log has been emitted for this plan (prevents re-logging) */
  startLogged?: boolean;
}

/**
 * Exit Plan Result from attempting to execute a plan
 */
export interface ExitPlanResult {
  /** Whether the position was successfully exited */
  filled: boolean;
  /** If not filled, reason for failure */
  reason?: string;
  /** Price at which exit was attempted */
  attemptedPriceCents?: number;
  /** Whether the plan should continue (false = cancel) */
  shouldContinue: boolean;
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
  // Exit ladder configuration
  exitWindowSec: 120, // 2 minute exit window
  profitRetrySec: 15, // Retry every 15 seconds during PROFIT stage
  minOrderUsd: 5, // Minimum order size (positions below this are DUST)
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

  // === EXIT LADDER STATE MACHINE ===
  // Tracks active exit plans per tokenId
  // Key: tokenId, Value: ExitPlan state
  private exitPlans: Map<string, ExitPlan> = new Map();

  // === EXECUTION CIRCUIT BREAKER ===
  // Tracks disabled tokens due to invalid orderbook data
  // Key: tokenId, Value: ExecutionCircuitBreakerEntry
  private executionCircuitBreaker: Map<string, ExecutionCircuitBreakerEntry> = new Map();

  // === DUST COOLDOWN TRACKING ===
  // Tracks tokens in dust cooldown to prevent repeated plan restarts
  // Key: tokenId, Value: Unix timestamp (ms) when cooldown ends
  private dustCooldowns: Map<string, number> = new Map();

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
  // Minimum amount above entry price (in cents) for PROFIT stage when bestBid is below entry
  private static readonly MIN_PROFIT_ABOVE_ENTRY_CENTS = 0.1;
  // Multiplier for max window duration in FORCE stage before abandoning
  private static readonly FORCE_STAGE_WINDOW_MULTIPLIER = 2;

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
   *
   * SNAPSHOT-DRIVEN EXECUTION (Jan 2025 Refactor):
   * This method now accepts a PortfolioSnapshot from the orchestrator.
   * It MUST use snapshot.activePositions, NOT call positionTracker methods directly.
   * This ensures all strategies operate on the same consistent data per cycle.
   *
   * CRASH-PROOF RECOVERY (Jan 2025):
   * - If snapshot.stale === true, we're using lastGoodSnapshot fallback
   * - Still trade, but log once: "using stale snapshot age=Xs"
   * - If snapshot suddenly reports activeTotal=0 but lastGoodSnapshot had >0,
   *   treat as upstream failure and keep using lastGoodSnapshot
   *
   * @param snapshot Optional PortfolioSnapshot from orchestrator. If not provided,
   *                 falls back to positionTracker.getSnapshot() for backward compatibility.
   */
  async execute(snapshot?: PortfolioSnapshot): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // === SNAPSHOT RESOLUTION ===
    // Prefer snapshot passed from orchestrator, fall back to positionTracker.getSnapshot()
    let effectiveSnapshot = snapshot ?? this.positionTracker.getSnapshot();

    // === CRASH-PROOF RECOVERY: HANDLE STALE/EMPTY SNAPSHOTS ===
    // If snapshot is stale, log warning but continue trading
    // If snapshot suddenly reports 0 active but we had positions before, treat as failure
    if (effectiveSnapshot) {
      // Check for stale snapshot and log warning (rate-limited)
      if (effectiveSnapshot.stale) {
        const staleAgeSec = Math.round(
          (effectiveSnapshot.staleAgeMs ?? 0) / 1000,
        );
        if (
          this.logDeduper.shouldLog(
            "ScalpTakeProfit:stale_snapshot",
            30_000, // Log at most every 30 seconds
          )
        ) {
          this.logger.warn(
            `[ScalpTakeProfit] ⚠️ using stale snapshot age=${staleAgeSec}s ` +
              `reason="${effectiveSnapshot.staleReason ?? "unknown"}" ` +
              `active=${effectiveSnapshot.activePositions.length} ` +
              `redeemable=${effectiveSnapshot.redeemablePositions.length}`,
          );
        }
      }

      // Check for sudden collapse to 0 active positions
      // This is a safety net against upstream failures that slip through validation
      const lastGoodSnapshot = this.positionTracker.getLastGoodSnapshot?.();
      if (
        effectiveSnapshot.activePositions.length === 0 &&
        lastGoodSnapshot &&
        lastGoodSnapshot.activePositions.length > 0 &&
        !effectiveSnapshot.stale // Not already marked as stale
      ) {
        // Snapshot reports 0 but lastGood had positions - treat as upstream failure
        if (
          this.logDeduper.shouldLog(
            "ScalpTakeProfit:zero_active_fallback",
            30_000,
          )
        ) {
          this.logger.warn(
            `[ScalpTakeProfit] ⚠️ snapshot reports activeTotal=0 but lastGoodSnapshot had ` +
              `${lastGoodSnapshot.activePositions.length} positions; using lastGoodSnapshot as fallback`,
          );
        }
        // Use lastGoodSnapshot instead
        effectiveSnapshot = lastGoodSnapshot;
      }
    }

    // CRITICAL: Get positions enriched with entry metadata from trade history API
    // This provides accurate timeHeldSec that survives container restarts
    const enrichedPositions =
      await this.positionTracker.enrichPositionsWithEntryMeta();
    let scalpedCount = 0;
    const now = Date.now();

    // Use snapshot for position data if available, otherwise fall back to positionTracker
    // This ensures we use the same data that PositionTracker computed
    let activePositions: readonly Position[];
    let profitable: Position[];
    let losing: Position[];
    let targetProfit: Position[];
    let minProfit: Position[];
    let holdingAddress: string | null;

    if (effectiveSnapshot) {
      // SNAPSHOT-DRIVEN: Use immutable snapshot data (preferred)
      activePositions = effectiveSnapshot.activePositions;
      holdingAddress = effectiveSnapshot.addressUsed;

      // Compute derived arrays from snapshot (cannot call positionTracker for these)
      profitable = activePositions.filter((p) => p.pnlPct > 0) as Position[];
      losing = activePositions.filter((p) => p.pnlPct < 0) as Position[];
      targetProfit = activePositions.filter(
        (p) => p.pnlPct >= this.config.targetProfitPct,
      ) as Position[];
      minProfit = activePositions.filter(
        (p) => p.pnlPct >= this.config.minProfitPct,
      ) as Position[];

      // === INVARIANT CHECK: SNAPSHOT_MISMATCH ===
      // If snapshot says activeTotal > 0 but we see 0, that's a BUG
      // Enhanced with rawCounts and classification reasons from snapshot
      if (
        effectiveSnapshot.summary.activeTotal > 0 &&
        activePositions.length === 0
      ) {
        // Rate-limit this error log to avoid spam
        if (
          this.logDeduper.shouldLog(
            "ScalpTakeProfit:SNAPSHOT_MISMATCH",
            60_000, // 60 second TTL
          )
        ) {
          const rawCounts = effectiveSnapshot.rawCounts;
          const classificationReasons = effectiveSnapshot.classificationReasons;
          let reasonsStr = "none";
          if (classificationReasons && classificationReasons.size > 0) {
            const reasons: string[] = [];
            for (const [reason, count] of classificationReasons) {
              reasons.push(`${reason}=${count}`);
            }
            reasonsStr = reasons.join(", ");
          }

          this.logger.error(
            `[ScalpTakeProfit] 🐛 SNAPSHOT_MISMATCH: cycleId=${effectiveSnapshot.cycleId} ` +
              `addressUsed=${holdingAddress?.slice(0, 10)}... ` +
              `snapshot.summary.activeTotal=${effectiveSnapshot.summary.activeTotal} ` +
              `but activePositions.length=0. ` +
              `rawCounts=${JSON.stringify(rawCounts ?? "unavailable")} ` +
              `classification_reasons=[${reasonsStr}] ` +
              `Summary: prof=${effectiveSnapshot.summary.prof} ` +
              `lose=${effectiveSnapshot.summary.lose} ` +
              `unknown=${effectiveSnapshot.summary.unknown}`,
          );
        }
      }
    } else {
      // FALLBACK: No snapshot available, use positionTracker methods (legacy path)
      this.logger.warn(
        `[ScalpTakeProfit] No snapshot available, falling back to positionTracker methods`,
      );
      activePositions = this.positionTracker.getActivePositions();
      profitable = this.positionTracker.getActiveProfitablePositions();
      losing = this.positionTracker.getActiveLosingPositions();
      targetProfit = this.positionTracker.getActivePositionsAboveTarget(
        this.config.targetProfitPct,
      );
      minProfit = this.positionTracker.getActivePositionsAboveTarget(
        this.config.minProfitPct,
      );
      holdingAddress = this.positionTracker.getHoldingAddress();
    }

    // Update price history for all positions
    // Note: Create mutable copy since activePositions may be readonly from snapshot
    await this.updatePriceHistory(Array.from(activePositions));

    // DIAGNOSTIC: Log active_count with filtering step counts (requirement #3)
    // Log filter steps: start -> afterStateFilter -> afterPnlTrusted -> afterThreshold
    const afterStateFilter = activePositions.length; // Already filtered to ACTIVE
    const afterPnlTrusted = activePositions.filter((p) => p.pnlTrusted).length;
    const afterThreshold = activePositions.filter(
      (p) => p.pnlTrusted && p.pnlPct >= this.config.minProfitPct,
    ).length;

    // Log active_count with diagnostics if 0
    if (activePositions.length === 0) {
      // Get raw total for diagnostic
      const allPositions = this.positionTracker.getPositions();
      this.logger.info(
        `[ScalpTakeProfit] active_count=0 ` +
          `(cycleId=${effectiveSnapshot?.cycleId ?? "none"} ` +
          `chosenAddress=${holdingAddress ?? "unknown"} ` +
          `raw_total=${allPositions.length} ` +
          `start=${allPositions.length} afterStateFilter=${afterStateFilter} ` +
          `afterPnlTrusted=${afterPnlTrusted} afterThreshold=${afterThreshold})`,
      );
    } else if (
      this.logDeduper.shouldLog(
        "ScalpTakeProfit:active_count",
        SKIP_LOG_TTL_MS,
        String(activePositions.length),
      )
    ) {
      this.logger.debug(
        `[ScalpTakeProfit] active_count=${activePositions.length} ` +
          `(cycleId=${effectiveSnapshot?.cycleId ?? "none"} ` +
          `start=${activePositions.length} afterPnlTrusted=${afterPnlTrusted} ` +
          `afterThreshold=${afterThreshold})`,
      );
    }

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
    // Use targetProfit from snapshot instead of calling positionTracker
    const highlyProfitable = targetProfit;
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

      // === CRITICAL: P&L TRUST CHECK ===
      // NEVER scalp positions with untrusted P&L. We might be selling winners!
      // This encompasses NO_BOOK, NO_BID, and any other reason for untrusted data.
      if (!position.pnlTrusted) {
        if (this.shouldLogSkip(positionKey, position.pnlPct)) {
          this.logger.debug(
            `[ScalpTakeProfit] Skip ${positionKey.slice(0, 20)}...: UNTRUSTED_PNL - ${position.pnlUntrustedReason ?? "unknown reason"}`,
          );
          this.recordSkipLog(positionKey, position.pnlPct);
        }
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

      // === EXIT PLAN STATE MACHINE ===
      // Check if there's already an exit plan for this position
      const existingPlan = this.exitPlans.get(position.tokenId);

      if (existingPlan) {
        // Already in an exit plan - execute it
        const result = await this.executeExitPlan(existingPlan, position, now);

        if (result.filled) {
          scalpedCount++;
          this.exitedPositions.add(positionKey);
          this.updateStats(position);
          this.exitPlans.delete(position.tokenId);
          this.skipLogTracker.delete(positionKey);
          this.positionTracker.invalidateOrderbookCache(position.tokenId);
        } else if (!result.shouldContinue) {
          // Plan exhausted (DUST, MAX_ATTEMPTS, etc.)
          this.exitPlans.delete(position.tokenId);
        }
        // Continue to next position - don't re-evaluate
        continue;
      }

      // === CIRCUIT BREAKER CHECK (before creating new plans) ===
      // If this token is in circuit breaker cooldown, skip without starting a new plan
      const circuitBreaker = this.executionCircuitBreaker.get(position.tokenId);
      if (circuitBreaker && circuitBreaker.disabledUntilMs > now) {
        skipAggregator.add(tokenIdShort, "circuit_breaker");
        continue;
      }

      // === DUST COOLDOWN CHECK (before creating new plans) ===
      // If this token had a recent DUST exit, skip to prevent repeated plan creation
      const dustCooldownEnd = this.dustCooldowns.get(position.tokenId);
      if (dustCooldownEnd && dustCooldownEnd > now) {
        skipAggregator.add(tokenIdShort, "dust_cooldown");
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

      // === PRE-FLIGHT ORDERBOOK QUALITY CHECK ===
      // Validate orderbook quality BEFORE creating exit plan to avoid creating plans
      // that will immediately fail with INVALID_BOOK
      const bestBid = position.currentBidPrice ?? null;
      const bestAsk = position.currentAskPrice ?? null;
      const dataApiPrice = position.currentPrice;

      const preflightQuality = validateOrderbookQuality(bestBid, bestAsk, dataApiPrice);

      if (preflightQuality.status !== "VALID") {
        // Orderbook quality is poor - enter circuit breaker instead of creating plan
        this.updateCircuitBreaker(position.tokenId, preflightQuality, now);

        // Log only once per TTL
        if (this.logDeduper.shouldLog(`ScalpExit:PREFLIGHT_INVALID:${position.tokenId}`, 30_000)) {
          this.logger.warn(
            `[CLOB] INVALID_BOOK (preflight) tokenId=${position.tokenId.slice(0, 12)}... ` +
              `bestBid=${bestBid !== null ? (bestBid * 100).toFixed(1) + "¢" : "null"} ` +
              `bestAsk=${bestAsk !== null ? (bestAsk * 100).toFixed(1) + "¢" : "null"} ` +
              `dataApiPrice=${dataApiPrice !== undefined ? (dataApiPrice * 100).toFixed(1) + "¢" : "N/A"} ` +
              `-> NOT creating exit plan. Reason: ${preflightQuality.reason}`,
          );
        }

        skipAggregator.add(tokenIdShort, "invalid_book");
        continue;
      }

      // === NEW SCALP TRIGGER - Create Exit Plan ===
      this.logger.info(
        `[ScalpTakeProfit] 💰 Scalping position at +${position.pnlPct.toFixed(1)}% (+$${position.pnlUsd.toFixed(2)}): ${exitDecision.reason}`,
      );

      // Create and start the exit plan
      const plan = this.createExitPlan(position, now);
      this.exitPlans.set(position.tokenId, plan);

      // Execute immediately on creation
      const result = await this.executeExitPlan(plan, position, now);

      if (result.filled) {
        scalpedCount++;
        this.exitedPositions.add(positionKey);
        this.updateStats(position);
        this.exitPlans.delete(position.tokenId);
        this.skipLogTracker.delete(positionKey);
        this.positionTracker.invalidateOrderbookCache(position.tokenId);
      } else if (!result.shouldContinue) {
        // Plan exhausted (DUST, MAX_ATTEMPTS, etc.)
        this.exitPlans.delete(position.tokenId);
      }
      // If shouldContinue is true, plan stays for next cycle
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
   *
   * CRITICAL FIX: Sell sizing uses position notional (sharesHeld * limitPrice),
   * NOT profitUsd which causes SKIP_MIN_ORDER_SIZE errors.
   *
   * @param position The position to sell
   * @param limitPriceCents Optional limit price in cents (defaults to currentBidPrice * 100)
   */
  private async sellPosition(
    position: Position,
    limitPriceCents?: number,
  ): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[ScalpTakeProfit] No wallet`);
      return false;
    }

    try {
      // Use provided limit price or fall back to current bid
      const effectiveLimitCents =
        limitPriceCents ?? (position.currentBidPrice ?? position.currentPrice) * 100;
      const effectiveLimitPrice = effectiveLimitCents / 100;

      // CRITICAL: Compute notional as sharesHeld * limitPrice (what we'll receive)
      // NOT profitUsd which would cause SKIP_MIN_ORDER_SIZE
      const notionalUsd = position.size * effectiveLimitPrice;

      // Preflight check: is notional >= minOrderUsd?
      if (notionalUsd < this.config.minOrderUsd) {
        this.logger.debug(
          `[ScalpTakeProfit] DUST_EXIT: notional=${notionalUsd.toFixed(2)} < minOrder=${this.config.minOrderUsd}. ` +
            `shares=${position.size.toFixed(4)} limitPrice=${effectiveLimitPrice.toFixed(4)} tokenId=${position.tokenId.slice(0, 12)}...`,
        );
        return false;
      }

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: (position.side?.toUpperCase() as "YES" | "NO") || "YES",
        side: "SELL",
        sizeUsd: notionalUsd,
        minAcceptablePrice: effectiveLimitPrice, // For SELL: floor protection (don't dump too cheap)
        logger: this.logger,
        skipDuplicatePrevention: true,
      });

      if (result.status === "submitted") {
        this.logger.info(
          `[ScalpTakeProfit] ✅ Scalp sell executed: notional=$${notionalUsd.toFixed(2)} ` +
            `limit=${effectiveLimitCents.toFixed(1)}¢`,
        );
        return true;
      }

      // Check for SKIP_MIN_ORDER_SIZE despite our preflight
      if (result.reason === "SKIP_MIN_ORDER_SIZE") {
        this.logger.error(
          `[ScalpTakeProfit] BUG: SKIP_MIN_ORDER_SIZE despite notional=$${notionalUsd.toFixed(2)} >= min=$${this.config.minOrderUsd}. ` +
            `shares=${position.size.toFixed(4)} limit=${effectiveLimitCents.toFixed(1)}¢ tokenId=${position.tokenId.slice(0, 12)}...`,
        );
      }

      this.logger.warn(
        `[ScalpTakeProfit] ⚠️ Scalp not filled: ${result.reason ?? "unknown"} ` +
          `position={tokenId=${position.tokenId.slice(0, 16)}..., marketId=${position.marketId.slice(0, 16)}..., ` +
          `side=${position.side}, shares=${position.size.toFixed(4)}, entry=${(position.entryPrice * 100).toFixed(1)}¢, ` +
          `currentBid=${position.currentBidPrice !== undefined ? (position.currentBidPrice * 100).toFixed(1) + "¢" : "N/A"}, ` +
          `limit=${effectiveLimitCents.toFixed(1)}¢, notional=$${notionalUsd.toFixed(2)}}`,
      );
      return false;
    } catch (err) {
      // Include full position context for troubleshooting price protection and other errors
      // NOTE: Exit plans persist in memory (this.exitPlans Map) so errors may repeat until
      // the position exits or the plan is abandoned. Container restarts clear plans but
      // positions remain, causing new plans to be created on the next cycle.
      const exitPlan = this.exitPlans.get(position.tokenId);
      const exitPlanInfo = exitPlan
        ? `stage=${exitPlan.stage}, attempts=${exitPlan.attempts}, elapsed=${Math.round((Date.now() - exitPlan.startedAtMs) / 1000)}s`
        : "no active plan";
      // Recalculate limit/notional for error logging (same logic as try block)
      const errLimitCents = limitPriceCents ?? (position.currentBidPrice ?? position.currentPrice) * 100;
      const errNotionalUsd = position.size * (errLimitCents / 100);
      this.logger.error(
        `[ScalpTakeProfit] ❌ Scalp failed: ${err instanceof Error ? err.message : String(err)} ` +
          `position={tokenId=${position.tokenId.slice(0, 16)}..., marketId=${position.marketId.slice(0, 16)}..., ` +
          `side=${position.side}, shares=${position.size.toFixed(4)}, entry=${(position.entryPrice * 100).toFixed(1)}¢, ` +
          `currentBid=${position.currentBidPrice !== undefined ? (position.currentBidPrice * 100).toFixed(1) + "¢" : "N/A"}, ` +
          `currentAsk=${position.currentAskPrice !== undefined ? (position.currentAskPrice * 100).toFixed(1) + "¢" : "N/A"}, ` +
          `limit=${errLimitCents.toFixed(1)}¢, notional=$${errNotionalUsd.toFixed(2)}} ` +
          `exitPlan={${exitPlanInfo}}`,
      );
      return false;
    }
  }

  // === EXIT LADDER METHODS ===

  /**
   * Create a new ExitPlan for a position
   */
  private createExitPlan(position: Position, now: number): ExitPlan {
    // Calculate target price: entry + target profit %
    const avgEntryCents = position.avgEntryPriceCents ?? position.entryPrice * 100;
    const targetPriceCents = avgEntryCents * (1 + this.config.targetProfitPct / 100);

    const plan: ExitPlan = {
      tokenId: position.tokenId,
      startedAtMs: now,
      stage: "PROFIT",
      lastAttemptAtMs: 0,
      attempts: 0,
      avgEntryCents,
      targetPriceCents,
      sharesHeld: position.size,
      initialPnlPct: position.pnlPct,
      initialPnlUsd: position.pnlUsd,
      startLogged: true, // Mark that START log was emitted
    };

    this.logger.info(
      `[ScalpExit] START tokenId=${position.tokenId.slice(0, 12)}... ` +
        `pnl=+${position.pnlPct.toFixed(1)}% profit=$${position.pnlUsd.toFixed(2)} ` +
        `window=${this.config.exitWindowSec}s shares=${position.size.toFixed(4)} ` +
        `entry=${avgEntryCents.toFixed(1)}¢ target=${targetPriceCents.toFixed(1)}¢`,
    );

    return plan;
  }

  /**
   * Check if an existing exit plan should escalate to the next stage
   */
  private updateExitPlanStage(plan: ExitPlan, now: number): void {
    const elapsedSec = (now - plan.startedAtMs) / 1000;
    const profitWindowSec = this.config.exitWindowSec * 0.6; // 60% of window for PROFIT stage

    const previousStage = plan.stage;

    if (plan.stage === "PROFIT" && elapsedSec >= profitWindowSec) {
      plan.stage = "BREAKEVEN";
      this.logger.info(
        `[ScalpExit] ESCALATE tokenId=${plan.tokenId.slice(0, 12)}... ` +
          `PROFIT->BREAKEVEN reason=WINDOW_PROGRESS (${elapsedSec.toFixed(0)}s elapsed)`,
      );
    } else if (plan.stage === "BREAKEVEN" && elapsedSec >= this.config.exitWindowSec) {
      plan.stage = "FORCE";
      this.logger.info(
        `[ScalpExit] ESCALATE tokenId=${plan.tokenId.slice(0, 12)}... ` +
          `BREAKEVEN->FORCE reason=WINDOW_EXPIRED (${elapsedSec.toFixed(0)}s elapsed)`,
      );
    }

    // Log stage transition
    if (previousStage !== plan.stage) {
      plan.attempts = 0; // Reset attempts on stage change
    }
  }

  /**
   * Calculate the limit price for the current exit plan stage
   *
   * PROFIT: max(targetPriceCents, bestBidCents) but must remain > avgEntryCents
   * BREAKEVEN: max(avgEntryCents, bestBidCents) but only if bestBid >= avgEntry
   * FORCE: bestBidCents (even if < avgEntry)
   */
  private calculateExitLimitPrice(
    plan: ExitPlan,
    bestBidCents: number,
  ): { limitCents: number; reason: string } {
    switch (plan.stage) {
      case "PROFIT": {
        // Try to get target profit, but at least beat best bid if it's above entry
        const limitCents = Math.max(plan.targetPriceCents, bestBidCents);
        // Ensure we're still profitable (above entry)
        if (limitCents <= plan.avgEntryCents) {
          return {
            limitCents:
              plan.avgEntryCents +
              ScalpTakeProfitStrategy.MIN_PROFIT_ABOVE_ENTRY_CENTS,
            reason: "PROFIT_MIN_ABOVE_ENTRY",
          };
        }
        return { limitCents, reason: "PROFIT_TARGET" };
      }

      case "BREAKEVEN": {
        // Exit at entry price or better
        if (bestBidCents >= plan.avgEntryCents) {
          return {
            limitCents: Math.max(plan.avgEntryCents, bestBidCents),
            reason: "BREAKEVEN_AT_ENTRY_OR_BETTER",
          };
        }
        // bestBid is below entry - can't break even yet
        return {
          limitCents: plan.avgEntryCents,
          reason: "BREAKEVEN_WAITING_FOR_BID",
        };
      }

      case "FORCE": {
        // Exit at best bid, even at loss
        return { limitCents: bestBidCents, reason: "FORCE_AT_BID" };
      }

      default:
        return { limitCents: bestBidCents, reason: "UNKNOWN_STAGE" };
    }
  }

  /**
   * Execute an exit plan for a position
   *
   * Returns whether the plan should continue (false = remove plan)
   *
   * ORDERBOOK QUALITY VALIDATION (Jan 2025):
   * Before attempting any trade, validate that the orderbook data is trustworthy.
   * If INVALID_BOOK or EXEC_PRICE_UNTRUSTED, block execution and enter cooldown.
   */
  private async executeExitPlan(
    plan: ExitPlan,
    position: Position,
    now: number,
  ): Promise<ExitPlanResult> {
    // === CIRCUIT BREAKER CHECK ===
    // If this token is in circuit breaker cooldown, skip without logging repeatedly
    const circuitBreaker = this.executionCircuitBreaker.get(plan.tokenId);
    if (circuitBreaker && circuitBreaker.disabledUntilMs > now) {
      // Token is disabled - keep plan alive but don't attempt
      plan.blockedReason = circuitBreaker.reason as typeof plan.blockedReason;
      plan.blockedAtMs = now;
      // Log only once per 30 seconds to avoid spam
      if (this.logDeduper.shouldLog(`ScalpExit:CIRCUIT_BREAKER:${plan.tokenId}`, 30_000)) {
        const remainingSec = Math.ceil((circuitBreaker.disabledUntilMs - now) / 1000);
        this.logger.debug(
          `[ScalpExit] CIRCUIT_BREAKER tokenId=${plan.tokenId.slice(0, 12)}... ` +
            `reason=${circuitBreaker.reason} cooldown=${remainingSec}s remaining`,
        );
      }
      return { filled: false, reason: circuitBreaker.reason, shouldContinue: true };
    }

    // Check for NO_BID condition
    if (position.currentBidPrice === undefined || position.status === "NO_BOOK") {
      // Mark as blocked
      plan.blockedReason = "NO_BID";
      plan.blockedAtMs = now;
      if (this.logDeduper.shouldLog(`ScalpExit:NO_BID:${plan.tokenId}`, 30_000)) {
        this.logger.warn(
          `[ScalpExit] BLOCKED tokenId=${plan.tokenId.slice(0, 12)}... reason=NO_BID`,
        );
      }
      return { filled: false, reason: "NO_BID", shouldContinue: true };
    }

    // === ORDERBOOK QUALITY VALIDATION ===
    // Get bestAsk for validation (we need both bid and ask to detect INVALID_BOOK)
    const bestBid = position.currentBidPrice;
    const bestAsk = position.currentAskPrice ?? null;
    const dataApiPrice = position.currentPrice; // Use Data-API mark price as reference

    const qualityResult = validateOrderbookQuality(bestBid, bestAsk, dataApiPrice);

    if (qualityResult.status !== "VALID") {
      // Orderbook quality is poor - enter circuit breaker
      this.updateCircuitBreaker(plan.tokenId, qualityResult, now);

      plan.blockedReason = qualityResult.status as typeof plan.blockedReason;
      plan.blockedAtMs = now;

      // Log only once per TTL to prevent spam
      if (this.logDeduper.shouldLog(`ScalpExit:INVALID_BOOK:${plan.tokenId}`, 30_000)) {
        this.logger.warn(
          `[CLOB] INVALID_BOOK tokenId=${plan.tokenId.slice(0, 12)}... ` +
            `bestBid=${qualityResult.diagnostics?.bestBid !== null ? (qualityResult.diagnostics?.bestBid! * 100).toFixed(1) + "¢" : "null"} ` +
            `bestAsk=${qualityResult.diagnostics?.bestAsk !== null ? (qualityResult.diagnostics?.bestAsk! * 100).toFixed(1) + "¢" : "null"} ` +
            `dataApiPrice=${dataApiPrice !== undefined ? (dataApiPrice * 100).toFixed(1) + "¢" : "N/A"} ` +
            `-> disabling execution for cooldown. Reason: ${qualityResult.reason}`,
        );
      }

      return { filled: false, reason: qualityResult.status, shouldContinue: true };
    }

    // Clear blocked state if we now have valid orderbook
    if (plan.blockedReason === "NO_BID" || plan.blockedReason === "INVALID_BOOK" || plan.blockedReason === "EXEC_PRICE_UNTRUSTED") {
      plan.blockedReason = undefined;
      plan.blockedAtMs = undefined;
      // Clear circuit breaker on successful validation
      this.executionCircuitBreaker.delete(plan.tokenId);
    }

    // At this point, currentBidPrice is guaranteed to exist and be > 0
    // because validateOrderbookQuality() would have returned NO_EXECUTION_PRICE if not
    const bestBidCents = position.currentBidPrice! * 100;

    // Update plan stage based on elapsed time
    this.updateExitPlanStage(plan, now);

    // Calculate limit price for current stage
    const { limitCents, reason } = this.calculateExitLimitPrice(plan, bestBidCents);

    // Check retry cadence
    const timeSinceLastAttempt = now - plan.lastAttemptAtMs;
    if (timeSinceLastAttempt < this.config.profitRetrySec * 1000 && plan.attempts > 0) {
      return { filled: false, reason: "RETRY_COOLDOWN", shouldContinue: true };
    }

    // Compute notional for preflight
    const notionalUsd = plan.sharesHeld * (limitCents / 100);

    // DUST check with cooldown tracking
    if (notionalUsd < this.config.minOrderUsd) {
      plan.blockedReason = "DUST";
      // Set dust cooldown to prevent re-starting plan
      this.dustCooldowns.set(plan.tokenId, now + DUST_COOLDOWN_MS);
      this.logger.debug(
        `[ScalpExit] DUST_EXIT tokenId=${plan.tokenId.slice(0, 12)}... ` +
          `notional=$${notionalUsd.toFixed(2)} < min=$${this.config.minOrderUsd} ` +
          `(cooldown 10min to prevent spam)`,
      );
      // Don't continue - remove plan for dust positions
      return { filled: false, reason: "DUST", shouldContinue: false };
    }

    // Log attempt
    plan.attempts++;
    plan.lastAttemptAtMs = now;

    // Rate-limited attempt logging
    if (this.logDeduper.shouldLog(`ScalpExit:TRY:${plan.tokenId}`, 5000, plan.stage)) {
      this.logger.info(
        `[ScalpExit] TRY stage=${plan.stage} tokenId=${plan.tokenId.slice(0, 12)}... ` +
          `price=${limitCents.toFixed(1)}¢ notional=$${notionalUsd.toFixed(2)} ` +
          `attempt=${plan.attempts} reason=${reason}`,
      );
    }

    // Execute the sell
    const filled = await this.sellPosition(position, limitCents);

    if (filled) {
      this.logger.info(
        `[ScalpExit] FILLED tokenId=${plan.tokenId.slice(0, 12)}... ` +
          `stage=${plan.stage} price=${limitCents.toFixed(1)}¢`,
      );
      return { filled: true, attemptedPriceCents: limitCents, shouldContinue: false };
    }

    // Check if FORCE stage and window expired - should still try
    if (plan.stage === "FORCE") {
      const elapsedSec = (now - plan.startedAtMs) / 1000;
      // Give FORCE stage extra time (multiplier * window) before giving up
      const maxForceWindowSec =
        this.config.exitWindowSec *
        ScalpTakeProfitStrategy.FORCE_STAGE_WINDOW_MULTIPLIER;
      if (elapsedSec > maxForceWindowSec) {
        this.logger.warn(
          `[ScalpExit] ABANDONED tokenId=${plan.tokenId.slice(0, 12)}... ` +
            `elapsed=${elapsedSec.toFixed(0)}s - exceeded max attempts`,
        );
        return { filled: false, reason: "MAX_ATTEMPTS", shouldContinue: false };
      }
    }

    return {
      filled: false,
      reason: "NOT_FILLED",
      attemptedPriceCents: limitCents,
      shouldContinue: true,
    };
  }

  /**
   * Update the circuit breaker for a tokenId based on orderbook quality failure.
   * Escalates cooldown on consecutive failures.
   */
  private updateCircuitBreaker(
    tokenId: string,
    qualityResult: OrderbookQualityResult,
    now: number,
  ): void {
    const existing = this.executionCircuitBreaker.get(tokenId);

    let failureCount = 1;
    if (existing) {
      // If failure happened recently (within escalation window), escalate
      // Using separate constant for clarity, not tied to cooldown values
      if (now - existing.lastFailureAtMs < CIRCUIT_BREAKER_ESCALATION_WINDOW_MS) {
        failureCount = Math.min(existing.failureCount + 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length);
      }
    }

    // Get cooldown based on failure count (0-indexed)
    const cooldownMs = CIRCUIT_BREAKER_COOLDOWNS_MS[Math.min(failureCount - 1, CIRCUIT_BREAKER_COOLDOWNS_MS.length - 1)];

    this.executionCircuitBreaker.set(tokenId, {
      disabledUntilMs: now + cooldownMs,
      reason: qualityResult.status,
      lastBid: qualityResult.diagnostics?.bestBid ?? null,
      lastAsk: qualityResult.diagnostics?.bestAsk ?? null,
      failureCount,
      lastFailureAtMs: now,
    });

    // Log escalation
    if (failureCount > 1) {
      this.logger.debug(
        `[ScalpExit] Circuit breaker escalated for tokenId=${tokenId.slice(0, 12)}... ` +
          `failures=${failureCount} cooldown=${cooldownMs / 1000}s`,
      );
    }
  }

  /**
   * Check if a position has an active exit plan
   */
  hasExitPlan(tokenId: string): boolean {
    return this.exitPlans.has(tokenId);
  }

  /**
   * Get all active exit plans (for testing/debugging)
   */
  getExitPlans(): Map<string, ExitPlan> {
    return new Map(this.exitPlans);
  }

  /**
   * Get the circuit breaker entry for a token (for testing/debugging)
   */
  getCircuitBreaker(tokenId: string): ExecutionCircuitBreakerEntry | undefined {
    return this.executionCircuitBreaker.get(tokenId);
  }

  /**
   * Get all circuit breaker entries (for testing/debugging)
   */
  getCircuitBreakers(): Map<string, ExecutionCircuitBreakerEntry> {
    return new Map(this.executionCircuitBreaker);
  }

  /**
   * Clear circuit breaker for a token (for testing/recovery)
   */
  clearCircuitBreaker(tokenId: string): void {
    this.executionCircuitBreaker.delete(tokenId);
  }

  /**
   * Check if a token is in dust cooldown
   */
  isInDustCooldown(tokenId: string, now: number = Date.now()): boolean {
    const cooldownEnd = this.dustCooldowns.get(tokenId);
    return cooldownEnd !== undefined && cooldownEnd > now;
  }

  /**
   * Clear dust cooldown for a token (for testing/recovery)
   */
  clearDustCooldown(tokenId: string): void {
    this.dustCooldowns.delete(tokenId);
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

    // Clean up exit plans for positions that no longer exist
    for (const tokenId of this.exitPlans.keys()) {
      if (!currentTokenIds.has(tokenId)) {
        this.exitPlans.delete(tokenId);
      }
    }

    // Clean up expired circuit breakers
    const now = Date.now();
    for (const [tokenId, entry] of this.executionCircuitBreaker.entries()) {
      if (!currentTokenIds.has(tokenId) || entry.disabledUntilMs <= now) {
        this.executionCircuitBreaker.delete(tokenId);
      }
    }

    // Clean up expired dust cooldowns
    for (const [tokenId, cooldownEnd] of this.dustCooldowns.entries()) {
      if (!currentTokenIds.has(tokenId) || cooldownEnd <= now) {
        this.dustCooldowns.delete(tokenId);
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
    this.exitPlans.clear();
    this.skipLogTracker.clear();
    this.executionCircuitBreaker.clear();
    this.dustCooldowns.clear();
    this.stats = {
      scalpCount: 0,
      totalProfitUsd: 0,
      avgHoldMinutes: 0,
    };
  }
}
