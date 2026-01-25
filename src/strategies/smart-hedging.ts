/**
 * Smart Hedging Strategy
 *
 * Instead of selling at a loss, buy the opposing outcome to guarantee profit.
 *
 * LOGIC:
 * 1. Find positions losing more than triggerLossPct
 * 2. If we can afford a hedge, BUY THE OPPOSITE SIDE
 * 3. If we can't hedge, SELL to stop bleeding
 *
 * That's it. No complex timing, no volume analysis, no elaborate calculations.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";
import {
  LogDeduper,
  SkipReasonAggregator,
  TOKEN_ID_DISPLAY_LENGTH,
} from "../utils/log-deduper.util";
import { formatCents, assessOrderbookQuality } from "../utils/price.util";
import type { ReservePlan } from "../risk";

/**
 * Smart Hedging Direction - determines when smart hedging is active
 * - "down": Only hedge losing positions (traditional behavior)
 * - "up": Only buy more shares when winning at high probability (85¢+)
 * - "both": Both behaviors enabled (default - maximize wins and minimize losses)
 */
export type SmartHedgingDirection = "down" | "up" | "both";

/**
 * Smart Hedging Configuration
 */
export interface SmartHedgingConfig {
  /** Enable smart hedging */
  enabled: boolean;

  /**
   * Direction for smart hedging (default: "both")
   * - "down": Only hedge losing positions (traditional behavior)
   * - "up": Only buy more shares when winning at high probability
   * - "both": Both behaviors enabled (maximize wins AND minimize losses)
   */
  direction: SmartHedgingDirection;

  /** Loss % to trigger hedging (default: 20) */
  triggerLossPct: number;

  /** Maximum USD per hedge (default: from MAX_POSITION_USD) */
  maxHedgeUsd: number;

  /** Minimum USD per hedge - skip smaller hedges (default: 1) */
  minHedgeUsd: number;

  /** Allow exceeding maxHedgeUsd for large losses (default: true) */
  allowExceedMax: boolean;

  /** Absolute max even when exceeding (default: from SMART_HEDGING_ABSOLUTE_MAX_USD) */
  absoluteMaxUsd: number;

  /** Max entry price for hedging - only hedge risky positions (default: 0.75 = 75¢) */
  maxEntryPrice: number;

  /** Loss % to force liquidation instead of hedge (default: 50) */
  forceLiquidationPct: number;

  /**
   * Minimum seconds to hold before hedging/liquidating (default: 120)
   * CRITICAL: Prevents immediate sell after buying due to bid-ask spread.
   * Without this, a position bought at 65¢ might immediately show a "loss"
   * due to the spread between bid/ask and trigger an unwanted hedge/liquidation.
   */
  minHoldSeconds: number;

  // === NEAR-CLOSE HEDGING BEHAVIOR ===
  // Near market close, apply stricter hedging thresholds to avoid dumb hedges

  /**
   * Minutes before market close to apply near-close behavior (default: 15)
   * When position is within this window, stricter hedge triggers apply
   */
  nearCloseWindowMinutes: number;

  /**
   * Near-close: Minimum adverse price move (in cents) to trigger hedge (default: 12)
   * In the near-close window, only hedge if price dropped by at least this amount
   */
  nearClosePriceDropCents: number;

  /**
   * Near-close: Minimum loss % to trigger hedge (default: 30)
   * In the near-close window, only hedge if loss % exceeds this threshold
   * Note: Either price drop OR loss % can trigger a hedge (OR condition)
   */
  nearCloseLossPct: number;

  /**
   * Minutes before market close to disable hedging entirely (default: 3)
   * Inside this window, hedging is blocked (too late - just liquidate if needed)
   */
  noHedgeWindowMinutes: number;

  // === SMART HEDGING UP (HIGH WIN PROBABILITY) ===
  // When near close and price is high (85¢+), buy MORE shares to maximize almost guaranteed gains

  /**
   * Price threshold for "hedging up" - buy more shares when current price >= this (default: 0.85 = 85¢)
   * When a position is winning at this price or above near market close,
   * buy additional shares to maximize gains since resolution to $1 is nearly guaranteed.
   */
  hedgeUpPriceThreshold: number;

  /**
   * Minutes before market close to enable "hedging up" behavior (default: 30)
   * Only buy more shares when within this window AND price >= hedgeUpPriceThreshold.
   * To hedge up without any time restriction, use the hedgeUpAnytime setting instead.
   */
  hedgeUpWindowMinutes: number;

  /**
   * Maximum USD to spend on "hedging up" per position (default: uses absoluteMaxUsd)
   * This is the maximum additional investment in a winning position.
   * Respects dynamic reserves - won't exceed available funds minus reserve.
   */
  hedgeUpMaxUsd: number;

  /**
   * Maximum price for "hedging up" - don't buy at prices >= this (default: 0.95 = 95¢)
   * Prevents buying at prices that are essentially "closed" where profit margin is minimal.
   * The sweet spot for hedging up is between hedgeUpPriceThreshold (85¢) and this max (95¢).
   */
  hedgeUpMaxPrice: number;

  /**
   * Allow "hedging up" at any time, not just near market close (default: false)
   * When true, positions at high win probability (>= hedgeUpPriceThreshold) can be
   * hedged up immediately, regardless of time to close.
   * When false (default), hedging up only occurs within hedgeUpWindowMinutes of market close.
   * This is the safer default - near close, the outcome is more certain.
   */
  hedgeUpAnytime: boolean;
}

export const DEFAULT_HEDGING_CONFIG: SmartHedgingConfig = {
  enabled: true,
  direction: "both", // Enable both hedging down (losses) and hedging up (high win prob)
  triggerLossPct: 20,
  maxHedgeUsd: 10,
  minHedgeUsd: 1,
  allowExceedMax: true,
  absoluteMaxUsd: 25,
  maxEntryPrice: 1.0, // Hedge ALL positions regardless of entry price
  forceLiquidationPct: 50,
  minHoldSeconds: 120, // Wait 2 minutes before hedging - prevents immediate sell after buy
  // Near-close hedging behavior
  nearCloseWindowMinutes: 15, // Apply near-close rules in last 15 minutes
  nearClosePriceDropCents: 12, // Near close: hedge only on >= 12¢ adverse move
  nearCloseLossPct: 30, // Near close: hedge only on >= 30% loss
  noHedgeWindowMinutes: 3, // Don't hedge at all in last 3 minutes (too late)
  // Hedging up (high win probability) settings
  hedgeUpPriceThreshold: 0.85, // Buy more shares when price >= 85¢
  hedgeUpWindowMinutes: 30, // Enable hedging up in last 30 minutes before close
  hedgeUpMaxUsd: 25, // Max USD to spend per position on hedging up (matches absoluteMaxUsd)
  hedgeUpMaxPrice: 0.95, // Don't buy at 95¢+ (too close to resolved, minimal profit margin)
  hedgeUpAnytime: false, // Default: only hedge up near close (safer - more certainty of outcome)
};

/**
 * Cooldown duration for failed liquidation attempts (5 minutes).
 *
 * RATIONALE:
 * - After a sell/hedge fails (due to insufficient balance, allowance, or liquidity),
 *   retrying immediately will almost certainly fail again.
 * - 5 minutes is long enough for external conditions to potentially change
 *   (e.g., deposits, approvals, or liquidity improvements).
 * - This prevents repeated attempts that spam logs, waste resources, and may
 *   trigger rate limits.
 *
 * WHEN APPLIED:
 * - When a sell order fails after hedge fails (both attempts exhausted)
 * - When a liquidation order fails in force-liquidation scenario
 * - When a liquidation fails in no-hedge window
 */
const FAILED_LIQUIDATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Maximum number of entries to keep in the failedLiquidationCooldowns map.
 * Prevents unbounded memory growth if positions are removed through other means
 * (e.g., sold externally, redeemed, manually removed) before their cooldown expires.
 */
const MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES = 1000;

/**
 * Threshold for detecting essentially resolved markets.
 * When the opposite side price >= this threshold, the market is
 * considered resolved and liquidation is skipped in favor of redemption.
 */
const MARKET_RESOLVED_THRESHOLD = 0.95;

/**
 * Threshold for determining hedge is too expensive.
 * When the opposite side price >= this threshold but < MARKET_RESOLVED_THRESHOLD,
 * hedging is skipped but liquidation may still be attempted.
 */
const HEDGE_TOO_EXPENSIVE_THRESHOLD = 0.9;

/**
 * Smart Hedging Strategy
 */
export class SmartHedgingStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: SmartHedgingConfig;
  /** Optional getter for the current reserve plan (injected by orchestrator) */
  private getReservePlan?: () => ReservePlan | null;

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

  // Track what we've already hedged to avoid double-hedging
  private hedgedPositions: Set<string> = new Set();

  // Track failed liquidation attempts with cooldown to prevent repeated retries
  // Key: position key (marketId-tokenId), Value: timestamp when cooldown expires
  private failedLiquidationCooldowns: Map<string, number> = new Map();

  // === LOG DEDUPLICATION ===
  // Prevents per-position skip log spam by tracking state changes
  private logDeduper = new LogDeduper();
  // Track last skip reason per tokenId to detect state changes
  private lastSkipReasonByTokenId: Map<string, string> = new Map();
  // Cycle counter for summary logging
  private cycleCount = 0;

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    positionTracker: PositionTracker;
    config: SmartHedgingConfig;
    /** Optional getter for the current reserve plan (for reserve-aware hedging) */
    getReservePlan?: () => ReservePlan | null;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.positionTracker = config.positionTracker;
    this.config = config.config;
    this.getReservePlan = config.getReservePlan;

    const hedgeUpStatus =
      this.config.direction !== "down"
        ? `@${(this.config.hedgeUpPriceThreshold * 100).toFixed(0)}¢-${(this.config.hedgeUpMaxPrice * 100).toFixed(0)}¢/$${this.config.hedgeUpMaxUsd}`
        : "disabled";

    this.logger.info(
      `[SmartHedging] Initialized: direction=${this.config.direction}, trigger=-${this.config.triggerLossPct}%, ` +
        `maxHedge=$${this.config.maxHedgeUsd}, absoluteMax=$${this.config.absoluteMaxUsd}, ` +
        `hedgeUp=${hedgeUpStatus}`,
    );
  }

  // Track positions that have been "hedged up" (bought more shares) this cycle
  private hedgedUpPositions: Set<string> = new Set();

  // === PER-CYCLE HEDGE BUDGET ===
  // Tracks remaining hedge budget within a single execute() cycle.
  // This prevents multiple hedges in the same cycle from exceeding (availableCash - reserveRequired).
  // Reset at the start of each executeInternal() call.
  private cycleHedgeBudgetRemaining: number | null = null;

  /**
   * Initialize the per-cycle hedge budget from the current reserve plan.
   * Called at the start of executeInternal() to set the budget for this cycle.
   */
  private initCycleHedgeBudget(): void {
    if (!this.getReservePlan) {
      this.cycleHedgeBudgetRemaining = null;
      return;
    }

    const plan = this.getReservePlan();
    if (!plan) {
      this.cycleHedgeBudgetRemaining = null;
      return;
    }

    // Initialize budget: availableCash - reserveRequired
    this.cycleHedgeBudgetRemaining = Math.max(0, plan.availableCash - plan.reserveRequired);
  }

  /**
   * Deduct an amount from the per-cycle hedge budget after a successful BUY order.
   * @param amountUsd - The USD amount spent on the hedge/buy-more operation (must be non-negative)
   */
  private deductFromCycleHedgeBudget(amountUsd: number): void {
    if (this.cycleHedgeBudgetRemaining !== null && amountUsd > 0) {
      this.cycleHedgeBudgetRemaining = Math.max(0, this.cycleHedgeBudgetRemaining - amountUsd);
    }
  }

  /**
   * Apply reserve-aware sizing to a computed hedge/buy amount.
   * Uses the per-cycle hedge budget to prevent multiple operations from exceeding reserves.
   *
   * @param computedUsd - The originally computed hedge/buy amount
   * @param operationLabel - Label for logging (e.g., "HEDGE" or "HEDGE UP")
   * @returns Object with either { skip: true, reason: string } or { skip: false, cappedUsd: number, isPartial: boolean }
   */
  private applyReserveAwareSizing(
    computedUsd: number,
    operationLabel: string,
  ): { skip: true; reason: string } | { skip: false; cappedUsd: number; isPartial: boolean } {
    // If no reserve budget tracking, use full computed amount
    if (this.cycleHedgeBudgetRemaining === null) {
      return { skip: false, cappedUsd: computedUsd, isPartial: false };
    }

    // Check if budget is below minimum hedge threshold
    if (this.cycleHedgeBudgetRemaining < this.config.minHedgeUsd) {
      this.logger.info(
        `[SmartHedging] 📋 ${operationLabel} skipped (RESERVE_SHORTFALL): budget=$${this.cycleHedgeBudgetRemaining.toFixed(2)} < minHedge=$${this.config.minHedgeUsd}`,
      );
      return { skip: true, reason: "RESERVE_SHORTFALL" };
    }

    // Check if budget is less than computed amount - submit partial
    if (this.cycleHedgeBudgetRemaining < computedUsd) {
      const cappedUsd = this.cycleHedgeBudgetRemaining;
      this.logger.info(
        `[SmartHedging] 📉 PARTIAL ${operationLabel}: Capping from $${computedUsd.toFixed(2)} to $${cappedUsd.toFixed(2)} (reserve constraint)`,
      );
      return { skip: false, cappedUsd, isPartial: true };
    }

    // Full amount available
    return { skip: false, cappedUsd: computedUsd, isPartial: false };
  }

  /**
   * Execute the strategy - find losing positions and hedge them
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard: prevent concurrent execution
    if (this.inFlight) {
      this.logger.debug("[SmartHedging] Skipped - already in flight");
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
    // Clean up expired cooldown entries periodically to prevent memory leaks
    this.cleanupExpiredCooldowns();

    // === INITIALIZE PER-CYCLE HEDGE BUDGET ===
    // This ensures multiple hedges in the same cycle don't exceed reserves
    this.initCycleHedgeBudget();

    const positions = this.positionTracker.getPositions();
    let actionsCount = 0;
    const now = Date.now();
    this.cycleCount++;

    // === LOG DEDUPLICATION: Aggregate skip reasons instead of per-position logs ===
    const skipAggregator = new SkipReasonAggregator();

    // === PHASE 1: HEDGING UP (Buy more shares for high win probability positions near close) ===
    // This maximizes gains on nearly guaranteed wins by buying additional shares
    if (this.config.direction === "up" || this.config.direction === "both") {
      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

        // Skip if already hedged up this cycle
        if (this.hedgedUpPositions.has(key)) {
          continue;
        }

        // Check if position qualifies for "hedging up"
        const hedgeUpResult = await this.tryHedgeUp(position, now);
        if (hedgeUpResult.action === "bought") {
          actionsCount++;
          this.hedgedUpPositions.add(key);
          this.logger.info(
            `[SmartHedging] 📈 HEDGE UP: Bought more shares of ${position.side} ${tokenIdShort}... ` +
              `at ${formatCents(position.currentPrice)} (${hedgeUpResult.reason})`,
          );
        } else if (hedgeUpResult.action === "skipped") {
          skipAggregator.add(tokenIdShort, hedgeUpResult.reason);
        }
        // "not_applicable" means the position doesn't qualify for hedge up at all
      }
    }

    // === PHASE 2: HEDGING DOWN (Hedge or liquidate losing positions) ===
    // This is the traditional hedging behavior - protect against losses
    if (this.config.direction === "down" || this.config.direction === "both") {
      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

        // Skip if already hedged
        if (this.hedgedPositions.has(key)) {
          skipAggregator.add(tokenIdShort, "already_hedged");
          continue;
        }

      // Skip if in failed liquidation cooldown (prevents repeated attempts)
      const cooldownUntil = this.failedLiquidationCooldowns.get(key);
      if (cooldownUntil && now < cooldownUntil) {
        skipAggregator.add(tokenIdShort, "cooldown");
        continue;
      }
      // Clean up expired cooldown entries (for current position)
      if (cooldownUntil && now >= cooldownUntil) {
        this.failedLiquidationCooldowns.delete(key);
      }

      // === ORDERBOOK QUALITY ASSESSMENT (Jan 2025 Fix) ===
      // Check if orderbook prices can be trusted before making P&L-based decisions.
      // This prevents "catastrophic loss" false positives when orderbook is broken.
      //
      // CRITICAL: If orderbook is INVALID_BOOK or NO_BOOK, we should use
      // Data-API price (dataApiCurPrice) instead of orderbook-derived P&L.
      // The position.pnlTrusted flag already handles NO_BOOK cases, but we add
      // explicit orderbook quality checking for additional safety.
      const orderbookQuality = assessOrderbookQuality(
        position.currentBidPrice,
        position.currentAskPrice,
        position.dataApiCurPrice,
      );

      if (orderbookQuality.quality === "INVALID_BOOK") {
        // Orderbook is broken/stale - do not trust P&L derived from it
        // Skip hedge/liquidation to avoid acting on bad data
        const previousReason = this.lastSkipReasonByTokenId.get(key);
        if (previousReason !== "invalid_book") {
          this.logger.warn(
            `[SmartHedging] ⚠️ Invalid orderbook for ${position.side} ${tokenIdShort}... (${orderbookQuality.reason}), skipping to avoid false catastrophic loss`,
          );
          this.lastSkipReasonByTokenId.set(key, "invalid_book");
        }
        skipAggregator.add(tokenIdShort, "invalid_book");
        continue;
      }

      // === CRITICAL: P&L TRUST CHECK ===
      // For normal losses, skip positions with untrusted P&L to avoid selling winners.
      // EXCEPTION: For CATASTROPHIC losses (>= forceLiquidationPct), allow action even with
      // untrusted P&L because the risk of inaction is greater than the risk of acting on
      // imperfect data. A 50% loss is a 50% loss regardless of P&L source precision.
      if (!position.pnlTrusted) {
        // Only consider catastrophic loss exception when pnlPct is actually negative
        const isActualLoss = position.pnlPct < 0;
        const lossPctMagnitude = Math.abs(position.pnlPct);
        const isCatastrophicLoss = isActualLoss && lossPctMagnitude >= this.config.forceLiquidationPct;
        
        if (isCatastrophicLoss) {
          // CATASTROPHIC LOSS with untrusted P&L - ALLOW hedging/liquidation with warning
          // The risk of doing nothing is greater than the risk of acting on imperfect data
          this.logger.warn(
            `[SmartHedging] 🚨 CATASTROPHIC LOSS (${lossPctMagnitude.toFixed(1)}% >= ${this.config.forceLiquidationPct}%) with untrusted P&L ` +
            `(${position.pnlUntrustedReason ?? "unknown reason"}) - PROCEEDING WITH HEDGE/LIQUIDATION despite data uncertainty`,
          );
          // Fall through to continue processing - don't skip
        } else if (isActualLoss && lossPctMagnitude >= this.config.triggerLossPct) {
          // Significant loss but not catastrophic - log warning but still skip
          this.logger.warn(
            `[SmartHedging] ⚠️ Skip hedge (UNTRUSTED_PNL): ${position.side} ${tokenIdShort}... at ${lossPctMagnitude.toFixed(1)}% loss has untrusted P&L (${position.pnlUntrustedReason ?? "unknown reason"}) - CANNOT HEDGE until P&L is trusted`,
          );
          skipAggregator.add(tokenIdShort, "untrusted_pnl");
          continue;
        } else {
          this.logger.debug(
            `[SmartHedging] 📋 Skip hedge (UNTRUSTED_PNL): ${position.side} position has untrusted P&L (${position.pnlUntrustedReason ?? "unknown reason"})`,
          );
          skipAggregator.add(tokenIdShort, "untrusted_pnl");
          continue;
        }
      }

      // === EXECUTION STATUS CHECK (Jan 2025 - Handle NOT_TRADABLE_ON_CLOB) ===
      // If position has executionStatus set to NOT_TRADABLE_ON_CLOB, skip hedging/liquidation.
      // This handles orderbook 404, empty book, and other CLOB unavailability scenarios.
      if (
        position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
        position.executionStatus === "EXECUTION_BLOCKED"
      ) {
        // Log at warn level for significant actual losses (pnlPct must be negative)
        const pnlPct = position.pnlPct;
        const lossPctMagnitude = Math.abs(pnlPct);
        if (pnlPct < 0 && lossPctMagnitude >= this.config.triggerLossPct) {
          this.logger.warn(
            `[SmartHedging] ⚠️ Skip hedge (NOT_TRADABLE): ${position.side} ${tokenIdShort}... at ${lossPctMagnitude.toFixed(1)}% loss - position not tradable on CLOB (status=${position.executionStatus})`,
          );
        }
        skipAggregator.add(tokenIdShort, "not_tradable");
        continue;
      }

      // Skip if not losing enough
      if (position.pnlPct > -this.config.triggerLossPct) {
        skipAggregator.add(tokenIdShort, "loss_below_trigger");
        continue;
      }

      // Skip if entry price too high (not risky tier)
      if (position.entryPrice >= this.config.maxEntryPrice) {
        skipAggregator.add(tokenIdShort, "entry_price_high");
        continue;
      }

      // Skip if no side defined (can't hedge without knowing the outcome)
      const side = position.side?.toUpperCase();
      if (!side || side.trim() === "") {
        skipAggregator.add(tokenIdShort, "no_side");
        continue;
      }

      // Skip resolved positions - log state change only
      if (position.redeemable) {
        const previousReason = this.lastSkipReasonByTokenId.get(key);
        if (previousReason !== "redeemable") {
          // State changed to redeemable - this is noteworthy
          this.logger.info(
            `[SmartHedging] 🔄 Position became redeemable: ${position.side} ${tokenIdShort}... (routing to AutoRedeem)`,
          );
          this.lastSkipReasonByTokenId.set(key, "redeemable");
        }
        skipAggregator.add(tokenIdShort, "redeemable");
        continue;
      }

      // === NEAR-RESOLUTION GATING (Jan 2025 Fix) ===
      // CRITICAL: Skip positions that are near-resolution winners.
      // These positions are almost certainly going to resolve to $1.00.
      // Hedging/liquidating them would be selling winners at a discount.
      //
      // nearResolutionCandidate is computed by PositionTracker using:
      // - currentPrice >= 99.5¢ (NEAR_RESOLUTION_THRESHOLD_DOLLARS)
      // - currentPrice >= 50¢ (safety guard prevents false positives from broken orderbook)
      // - redeemable === false
      if (position.nearResolutionCandidate) {
        const previousReason = this.lastSkipReasonByTokenId.get(key);
        if (previousReason !== "near_resolution") {
          // State changed to near-resolution - log once per TTL
          this.logger.info(
            `[SmartHedging] 🎯 Near-resolution position (${formatCents(position.currentPrice)}), skipping hedge/liquidation: ${position.side} ${tokenIdShort}...`,
          );
          this.lastSkipReasonByTokenId.set(key, "near_resolution");
        }
        skipAggregator.add(tokenIdShort, "near_resolution");
        continue;
      }

      // CRITICAL: Check minimum hold time before ANY action (hedge or sell)
      // This prevents immediate sell/hedge after buying due to bid-ask spread
      const entryTime = this.positionTracker.getPositionEntryTime(
        position.marketId,
        position.tokenId,
      );
      if (!entryTime) {
        // If we don't have an entry time, be conservative and skip this position
        skipAggregator.add(tokenIdShort, "no_entry_time");
        continue;
      }

      const holdSeconds = (now - entryTime) / 1000;
      if (holdSeconds < this.config.minHoldSeconds) {
        skipAggregator.add(tokenIdShort, "hold_time_short");
        continue;
      }

      const lossPct = Math.abs(position.pnlPct);

      // === NEAR-CLOSE HEDGING BEHAVIOR ===
      // Near market close, apply stricter rules to avoid "dumb hedges"
      if (position.marketEndTime && position.marketEndTime > now) {
        const minutesToClose = (position.marketEndTime - now) / (60 * 1000);

        // Inside no-hedge window (last 2-3 minutes): skip hedging entirely
        // It's too late to hedge - just liquidate if loss is bad enough
        if (minutesToClose <= this.config.noHedgeWindowMinutes) {
          if (lossPct >= this.config.forceLiquidationPct) {
            this.logger.warn(
              `[SmartHedging] 🚨 No-hedge window (${minutesToClose.toFixed(1)}min to close), loss ${lossPct.toFixed(1)}% >= ${this.config.forceLiquidationPct}% - LIQUIDATING`,
            );
            const sold = await this.sellPosition(position);
            if (sold) {
              actionsCount++;
              this.hedgedPositions.add(key);
            } else {
              // Sell failed in no-hedge window - add to cooldown
              this.failedLiquidationCooldowns.set(
                key,
                now + FAILED_LIQUIDATION_COOLDOWN_MS,
              );
              this.logger.warn(
                `[SmartHedging] ⏳ Liquidation failed in no-hedge window - position on cooldown for 5 minutes: ${key}`,
              );
            }
          } else {
            // Use aggregator for near-close skips (no per-position log spam)
            skipAggregator.add(tokenIdShort, "no_hedge_window");
          }
          continue;
        }

        // Inside near-close window (last 10-15 minutes): apply stricter thresholds
        // Only hedge if it's a BIG adverse move (≥12¢) OR a BIG loss (≥30%)
        if (minutesToClose <= this.config.nearCloseWindowMinutes) {
          const priceDropCents =
            (position.entryPrice - position.currentPrice) * 100;
          const meetsDropThreshold =
            priceDropCents >= this.config.nearClosePriceDropCents;
          const meetsLossThreshold = lossPct >= this.config.nearCloseLossPct;

          if (!meetsDropThreshold && !meetsLossThreshold) {
            // Use aggregator for near-close threshold skips
            skipAggregator.add(tokenIdShort, "near_close_threshold");
            continue;
          }

          this.logger.info(
            `[SmartHedging] 📍 Near-close hedge triggered: ${minutesToClose.toFixed(1)}min to close, ` +
              `loss=${lossPct.toFixed(1)}%${meetsLossThreshold ? " ✓" : ""}, ` +
              `drop=${priceDropCents.toFixed(1)}¢${meetsDropThreshold ? " ✓" : ""}`,
          );
        }
      }

      // ALWAYS try to hedge FIRST, even for catastrophic losses
      // Only liquidate as a last resort if hedge fails
      const isCatastrophicLoss = lossPct >= this.config.forceLiquidationPct;

      // Try to hedge
      this.logger.info(
        `[SmartHedging] 🎯 Position losing ${lossPct.toFixed(1)}%${isCatastrophicLoss ? " (catastrophic)" : ""} - attempting hedge FIRST`,
      );

      const hedgeResult = await this.executeHedge(position);
      if (hedgeResult.success) {
        actionsCount++;
        this.hedgedPositions.add(key);
        continue;
      }

      // === PARTIAL FILL PROTECTION ===
      // If money was spent on a partial fill, mark position as hedged to prevent
      // re-hedging and exceeding SMART_HEDGING_ABSOLUTE_MAX_USD.
      // This is critical: without this check, partial fills could trigger repeated
      // hedge attempts, each spending money until the total far exceeds the limit.
      if (hedgeResult.filledAmountUsd) {
        this.logger.warn(
          `[SmartHedging] 🛑 Partial hedge fill ($${hedgeResult.filledAmountUsd.toFixed(2)}) - marking position as hedged to prevent exceeding ABSOLUTE_MAX`,
        );
        this.hedgedPositions.add(key);
        actionsCount++;
        continue;
      }

      // If market is essentially resolved (opposite side >= 95¢), skip liquidation
      // The position should be redeemed, not sold at a loss
      if (hedgeResult.reason === "MARKET_RESOLVED") {
        this.logger.info(
          `[SmartHedging] 📋 Position marked as resolved - skipping liquidation, awaiting redemption: ${key}`,
        );
        // Add to hedged positions to prevent future attempts (will be redeemed instead)
        this.hedgedPositions.add(key);
        continue;
      }

      // === REASON-AWARE HEDGE FALLBACK ===
      // When hedge fails due to insufficient funds, try to free funds by selling
      // profitable positions (lowest profit first), then retry the hedge once.
      // Only sell the losing position as a last resort.
      if (hedgeResult.reason === "INSUFFICIENT_BALANCE_OR_ALLOWANCE") {
        this.logger.info(
          `[SmartHedging] 💰 Hedge failed (insufficient funds) - attempting to free funds by selling profitable positions`,
        );

        // Get profitable positions sorted by lowest profit first (sell smallest winners first)
        const profitCandidates =
          this.positionTracker.getProfitLiquidationCandidates(
            0, // Any profit
            this.config.minHoldSeconds,
          );

        // Filter out positions we've already hedged
        const sellableProfits = profitCandidates.filter((p) => {
          const k = `${p.marketId}-${p.tokenId}`;
          return !this.hedgedPositions.has(k);
        });

        let freedFunds = false;
        if (sellableProfits.length > 0) {
          // Sell the lowest-profit profitable position first
          const profitToSell = sellableProfits[0];
          this.logger.info(
            `[SmartHedging] 🔄 Selling profitable position to free funds: ${profitToSell.side} +${profitToSell.pnlPct.toFixed(1)}% ($${(profitToSell.size * profitToSell.currentPrice).toFixed(2)})`,
          );

          const soldProfit = await this.sellPosition(profitToSell);
          if (soldProfit) {
            freedFunds = true;
            actionsCount++;
            // Mark as hedged to prevent future attempts on this position
            this.hedgedPositions.add(
              `${profitToSell.marketId}-${profitToSell.tokenId}`,
            );
          } else {
            this.logger.warn(
              `[SmartHedging] ⚠️ Failed to sell profitable position for fund release`,
            );
          }
        } else {
          this.logger.debug(
            `[SmartHedging] 📋 No profitable positions available to sell for fund release`,
          );
        }

        // Retry hedge once if we freed some funds
        if (freedFunds) {
          this.logger.info(
            `[SmartHedging] 🔄 Retrying hedge after freeing funds...`,
          );

          const retryResult = await this.executeHedge(position);
          if (retryResult.success) {
            actionsCount++;
            this.hedgedPositions.add(key);
            continue;
          }

          // Check for partial fill on retry - still mark as hedged to prevent exceeding limit
          if (retryResult.filledAmountUsd) {
            this.logger.warn(
              `[SmartHedging] 🛑 Retry partial fill ($${retryResult.filledAmountUsd.toFixed(2)}) - marking position as hedged`,
            );
            this.hedgedPositions.add(key);
            actionsCount++;
            continue;
          }

          this.logger.warn(
            `[SmartHedging] ⚠️ Hedge retry failed (${retryResult.reason}) - will sell losing position as last resort`,
          );
        }

        // Fall through to selling the losing position as last resort
      }

      // Log specific hedge failure reasons for visibility
      if (
        hedgeResult.reason === "TOO_EXPENSIVE" ||
        hedgeResult.reason === "NO_OPPOSITE_TOKEN" ||
        hedgeResult.reason === "NO_LIQUIDITY"
      ) {
        this.logger.info(
          `[SmartHedging] 📋 Hedge skip reason: ${hedgeResult.reason}`,
        );
      }

      // Hedge failed - only liquidate if loss is catastrophic (>= forceLiquidationPct)
      // For smaller losses, wait and try again later (market conditions may improve)
      if (!isCatastrophicLoss) {
        this.logger.info(
          `[SmartHedging] 📋 Hedge failed (${hedgeResult.reason}) but loss ${lossPct.toFixed(1)}% < ${this.config.forceLiquidationPct}% threshold - waiting for better conditions`,
        );
        continue;
      }

      // Catastrophic loss AND hedge failed - liquidate to stop bleeding
      this.logger.warn(
        `[SmartHedging] 🚨 Hedge failed (${hedgeResult.reason}) AND loss ${lossPct.toFixed(1)}% >= ${this.config.forceLiquidationPct}% - LIQUIDATING as last resort`,
      );
      const sold = await this.sellPosition(position);
      if (sold) {
        actionsCount++;
        this.hedgedPositions.add(key);
      } else {
        // Both hedge and sell failed - add to cooldown to prevent repeated attempts
        this.failedLiquidationCooldowns.set(
          key,
          now + FAILED_LIQUIDATION_COOLDOWN_MS,
        );
        this.logger.warn(
          `[SmartHedging] ⏳ Hedge and liquidation both failed - position on cooldown for 5 minutes: ${key}`,
        );
      }
    }
    }

    // === LOG DEDUPLICATION: Emit aggregated skip summary (rate-limited) ===
    if (skipAggregator.hasSkips()) {
      const fingerprint = skipAggregator.getFingerprint();
      if (this.logDeduper.shouldLogSummary("Hedging", fingerprint)) {
        this.logger.debug(
          `[SmartHedging] Skipped ${skipAggregator.getTotalCount()} positions: ${skipAggregator.getSummary()} (cycle=${this.cycleCount})`,
        );
      }
    }

    return actionsCount;
  }

  /**
   * Try to "hedge up" - buy more shares of a high win probability position near market close.
   *
   * LOGIC:
   * 1. Check if position qualifies: price >= hedgeUpPriceThreshold (e.g., 85¢)
   * 2. Check if near close: within hedgeUpWindowMinutes (e.g., 30 minutes)
   * 3. Check if we have sufficient funds (respecting dynamic reserves)
   * 4. If all conditions met, buy additional shares up to hedgeUpMaxUsd
   *
   * @returns Object indicating the action taken:
   *          - action: "bought" if we bought more shares
   *          - action: "skipped" if conditions not met but position could qualify
   *          - action: "not_applicable" if position doesn't qualify at all
   *          - reason: Description of what happened
   */
  private async tryHedgeUp(
    position: Position,
    now: number,
  ): Promise<{ action: "bought" | "skipped" | "not_applicable"; reason: string }> {
    const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

    // === BASIC QUALIFICATION CHECKS ===

    // Check if position has a side (required for trading)
    if (!position.side || position.side.trim() === "") {
      return { action: "not_applicable", reason: "no_side" };
    }

    // Check if price is at high win probability threshold
    if (position.currentPrice < this.config.hedgeUpPriceThreshold) {
      return { action: "not_applicable", reason: "price_below_threshold" };
    }

    // Check if price is too high (essentially closed - minimal profit margin)
    // Sweet spot is between hedgeUpPriceThreshold (85¢) and hedgeUpMaxPrice (95¢)
    if (position.currentPrice >= this.config.hedgeUpMaxPrice) {
      return { action: "skipped", reason: "price_too_high" };
    }

    // Check execution status - can't trade if position is not tradable
    if (
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED"
    ) {
      return { action: "skipped", reason: "not_tradable" };
    }

    // Skip redeemable positions (market already resolved)
    if (position.redeemable) {
      return { action: "skipped", reason: "redeemable" };
    }

    // Skip near-resolution positions (99.5¢+, essentially already won)
    if (position.nearResolutionCandidate) {
      return { action: "skipped", reason: "near_resolution" };
    }

    // === TIME WINDOW CHECK ===
    // If hedgeUpAnytime is enabled, skip the time window check entirely
    // Otherwise, only hedge up when near market close
    if (!this.config.hedgeUpAnytime) {
      if (!position.marketEndTime || position.marketEndTime <= now) {
        // No end time available or market already ended
        return { action: "not_applicable", reason: "no_end_time" };
      }

      const minutesToClose = (position.marketEndTime - now) / (60 * 1000);

      // Must be within the hedge up window
      if (minutesToClose > this.config.hedgeUpWindowMinutes) {
        return { action: "not_applicable", reason: "outside_window" };
      }

      // Don't hedge up in the very last minutes (same as no-hedge window)
      if (minutesToClose <= this.config.noHedgeWindowMinutes) {
        return { action: "skipped", reason: "no_hedge_window" };
      }
    } else {
      // Even with hedgeUpAnytime, respect the no-hedge window if market end time is known
      if (position.marketEndTime && position.marketEndTime > now) {
        const minutesToClose = (position.marketEndTime - now) / (60 * 1000);
        if (minutesToClose <= this.config.noHedgeWindowMinutes) {
          return { action: "skipped", reason: "no_hedge_window" };
        }
      }
    }

    // === ORDERBOOK QUALITY CHECK ===
    const orderbookQuality = assessOrderbookQuality(
      position.currentBidPrice,
      position.currentAskPrice,
      position.dataApiCurPrice,
    );

    if (orderbookQuality.quality === "INVALID_BOOK") {
      return { action: "skipped", reason: "invalid_book" };
    }

    // === EXECUTE HEDGE UP ===
    // Compute time to close for logging (may be undefined if no marketEndTime)
    const timeToCloseStr = position.marketEndTime && position.marketEndTime > now
      ? `${((position.marketEndTime - now) / (60 * 1000)).toFixed(1)}min to close`
      : "no close time";
    this.logger.info(
      `[SmartHedging] 📈 HEDGE UP candidate: ${position.side} ${tokenIdShort}... ` +
        `at ${formatCents(position.currentPrice)}, ${timeToCloseStr}`,
    );

    const result = await this.executeBuyMore(position);
    if (result.success) {
      return {
        action: "bought",
        reason: `bought_$${result.amountUsd?.toFixed(2) ?? "?"}_at_${formatCents(position.currentPrice)}`,
      };
    }

    return { action: "skipped", reason: result.reason ?? "buy_failed" };
  }

  /**
   * Execute a "buy more" order - buy additional shares of the same position.
   * Used for "hedging up" to maximize gains on high probability positions.
   *
   * @returns Object with success status, reason, and amount spent
   */
  private async executeBuyMore(
    position: Position,
  ): Promise<{ success: boolean; reason?: string; amountUsd?: number }> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[SmartHedging] No wallet - cannot buy more`);
      return { success: false, reason: "NO_WALLET" };
    }

    // Get current ask price for buying
    let askPrice: number;
    try {
      const orderbook = await this.client.getOrderBook(position.tokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(`[SmartHedging] No liquidity to buy more ${position.side}`);
        return { success: false, reason: "NO_LIQUIDITY" };
      }
      askPrice = parseFloat(orderbook.asks[0].price);
    } catch {
      this.logger.warn(`[SmartHedging] Failed to get price for buying more`);
      return { success: false, reason: "ORDERBOOK_ERROR" };
    }

    // Check if ask price is still at or above our threshold
    if (askPrice < this.config.hedgeUpPriceThreshold) {
      this.logger.debug(
        `[SmartHedging] Ask price ${formatCents(askPrice)} below threshold ${formatCents(this.config.hedgeUpPriceThreshold)}`,
      );
      return { success: false, reason: "PRICE_DROPPED" };
    }

    // Check if ask price is too high (essentially closed - minimal profit margin)
    if (askPrice >= this.config.hedgeUpMaxPrice) {
      this.logger.debug(
        `[SmartHedging] Ask price ${formatCents(askPrice)} too high (>= ${formatCents(this.config.hedgeUpMaxPrice)}) - minimal profit margin`,
      );
      return { success: false, reason: "PRICE_TOO_HIGH" };
    }

    // Calculate buy amount
    // Use hedgeUpMaxUsd, respecting allowExceedMax and absoluteMaxUsd
    let buyUsd: number;
    if (this.config.allowExceedMax) {
      buyUsd = Math.min(this.config.hedgeUpMaxUsd, this.config.absoluteMaxUsd);
    } else {
      buyUsd = Math.min(this.config.hedgeUpMaxUsd, this.config.maxHedgeUsd);
    }

    // === DYNAMIC RESERVES INTEGRATION ===
    // Apply reserve-aware sizing using per-cycle hedge budget
    const reserveSizing = this.applyReserveAwareSizing(buyUsd, "HEDGE UP");
    if (reserveSizing.skip) {
      return { success: false, reason: reserveSizing.reason };
    }
    buyUsd = reserveSizing.cappedUsd;

    // Check minimum
    if (buyUsd < this.config.minHedgeUsd) {
      this.logger.debug(
        `[SmartHedging] Buy amount $${buyUsd.toFixed(2)} below min $${this.config.minHedgeUsd}`,
      );
      return { success: false, reason: "BELOW_MIN" };
    }

    // Calculate expected profit if we win
    const additionalShares = buyUsd / askPrice;
    const potentialProfit = additionalShares * (1 - askPrice); // What we make if price goes to $1

    this.logger.info(
      `[SmartHedging] 📈 BUYING MORE: ${additionalShares.toFixed(2)} ${position.side} @ ${formatCents(askPrice)} = $${buyUsd.toFixed(2)}` +
        `\n  Potential profit if ${position.side} wins: +$${potentialProfit.toFixed(2)}`,
    );

    try {
      // Normalize the outcome for the order API
      const orderOutcome = this.normalizeOutcomeForOrder(position.side ?? "YES");

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: orderOutcome,
        side: "BUY",
        sizeUsd: buyUsd,
        maxAcceptablePrice: askPrice * 1.02, // Allow 2% slippage
        logger: this.logger,
        skipDuplicatePrevention: true, // Hedge up is intentional
        skipMinBuyPriceCheck: true, // High prices are what we want here
      });

      if (result.status === "submitted") {
        // Deduct from per-cycle hedge budget to prevent exceeding reserves
        this.deductFromCycleHedgeBudget(buyUsd);
        this.logger.info(`[SmartHedging] ✅ Buy more executed successfully`);
        return { success: true, amountUsd: buyUsd };
      }

      this.logger.warn(
        `[SmartHedging] ⚠️ Buy more order not filled: ${result.reason ?? "unknown"}`,
      );
      return { success: false, reason: result.reason ?? "ORDER_NOT_FILLED" };
    } catch (err) {
      this.logger.error(
        `[SmartHedging] ❌ Buy more failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { success: false, reason: "BUY_ERROR" };
    }
  }

  /**
   * Execute a hedge - buy the opposite side
   * Supports all binary market types: YES/NO, Over/Under, Team A/Team B, etc.
   *
   * @returns Object with success status and reason for failure
   *          - reason "MARKET_RESOLVED" means opposite side >= 95¢, skip liquidation
   *          - reason "TOO_EXPENSIVE" means opposite side >= 90¢ but < 95¢, try liquidation
   *          - other reasons indicate hedge attempt failed, try liquidation
   *          - filledAmountUsd: Amount spent on partial fills (prevents re-hedging if > 0)
   */
  private async executeHedge(
    position: Position,
  ): Promise<{ success: boolean; reason?: string; filledAmountUsd?: number }> {
    const currentSide = position.side?.toUpperCase();

    // Get the opposite token (works for any binary market)
    const oppositeInfo = await this.getOppositeToken(
      position.marketId,
      position.tokenId,
    );

    if (!oppositeInfo) {
      this.logger.warn(
        `[SmartHedging] Could not find opposite token for ${currentSide}`,
      );
      return { success: false, reason: "NO_OPPOSITE_TOKEN" };
    }

    const { tokenId: oppositeTokenId, outcome: oppositeSide } = oppositeInfo;

    // Get opposite side price
    let oppositePrice: number;
    try {
      const orderbook = await this.client.getOrderBook(oppositeTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(`[SmartHedging] No liquidity for ${oppositeSide}`);
        return { success: false, reason: "NO_LIQUIDITY" };
      }
      oppositePrice = parseFloat(orderbook.asks[0].price);
    } catch {
      this.logger.warn(`[SmartHedging] Failed to get opposite price`);
      return { success: false, reason: "ORDERBOOK_ERROR" };
    }

    // If opposite is too expensive (>90¢), our side is probably losing - just sell
    // EXCEPTION: If opposite is >= 95¢, market is essentially resolved - don't try to sell
    if (oppositePrice >= MARKET_RESOLVED_THRESHOLD) {
      this.logger.info(
        `[SmartHedging] ${oppositeSide} at ${(oppositePrice * 100).toFixed(0)}¢ - market essentially resolved, skipping (await redemption)`,
      );
      // Return special indicator that this is a resolved market, not a hedge failure
      return { success: false, reason: "MARKET_RESOLVED" };
    }
    if (oppositePrice >= HEDGE_TOO_EXPENSIVE_THRESHOLD) {
      this.logger.warn(
        `[SmartHedging] ${oppositeSide} at ${(oppositePrice * 100).toFixed(0)}¢ - too expensive to hedge`,
      );
      return { success: false, reason: "TOO_EXPENSIVE" };
    }

    // Calculate hedge size
    const originalInvestment = position.size * position.entryPrice;
    const hedgeProfit = 1 - oppositePrice; // What we make per share if hedge wins

    // Calculate shares needed to guarantee profit on hedge win
    const breakEvenShares = originalInvestment / hedgeProfit;
    const profitableHedgeUsd = breakEvenShares * oppositePrice * 1.1; // 10% buffer

    // Determine actual hedge size based on limits
    let hedgeUsd: number;
    if (this.config.allowExceedMax) {
      hedgeUsd = Math.min(profitableHedgeUsd, this.config.absoluteMaxUsd);
    } else {
      hedgeUsd = Math.min(profitableHedgeUsd, this.config.maxHedgeUsd);
    }

    // === DYNAMIC RESERVES INTEGRATION ===
    // Apply reserve-aware sizing using per-cycle hedge budget
    const reserveSizing = this.applyReserveAwareSizing(hedgeUsd, "HEDGE");
    if (reserveSizing.skip) {
      return { success: false, reason: reserveSizing.reason };
    }
    hedgeUsd = reserveSizing.cappedUsd;

    // Check minimum
    if (hedgeUsd < this.config.minHedgeUsd) {
      this.logger.debug(
        `[SmartHedging] Hedge $${hedgeUsd.toFixed(2)} below min $${this.config.minHedgeUsd}`,
      );
      return { success: false, reason: "BELOW_MIN_HEDGE" };
    }

    // Calculate expected outcomes
    const hedgeShares = hedgeUsd / oppositePrice;
    const totalInvested = originalInvestment + hedgeUsd;
    const ifOriginalWins = position.size * 1.0 - totalInvested;
    const ifHedgeWins = hedgeShares * 1.0 - totalInvested;

    this.logger.info(
      `[SmartHedging] 🔄 HEDGING: Buy ${hedgeShares.toFixed(2)} ${oppositeSide} @ ${(oppositePrice * 100).toFixed(1)}¢ = $${hedgeUsd.toFixed(2)}` +
        `\n  If ${currentSide} wins: ${ifOriginalWins >= 0 ? "+" : ""}$${ifOriginalWins.toFixed(2)}` +
        `\n  If ${oppositeSide} wins: ${ifHedgeWins >= 0 ? "+" : ""}$${ifHedgeWins.toFixed(2)}`,
    );

    // Execute the hedge order
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[SmartHedging] No wallet - cannot hedge`);
      return { success: false, reason: "NO_WALLET" };
    }

    try {
      // Normalize the outcome to YES/NO for the order API (tokenId identifies the actual outcome)
      const orderOutcome = this.normalizeOutcomeForOrder(oppositeSide);

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: oppositeTokenId,
        outcome: orderOutcome,
        side: "BUY",
        sizeUsd: hedgeUsd,
        maxAcceptablePrice: oppositePrice * 1.02,
        logger: this.logger,
        skipDuplicatePrevention: true, // Hedges are intentional
        skipMinBuyPriceCheck: true, // Allow buying low-priced hedges
      });

      if (result.status === "submitted") {
        // Deduct from per-cycle hedge budget to prevent exceeding reserves
        this.deductFromCycleHedgeBudget(hedgeUsd);
        this.logger.info(`[SmartHedging] ✅ Hedge executed successfully`);
        return { success: true };
      }

      // Check for partial fill - money was spent even though order didn't fully complete
      const filledUsd = result.filledAmountUsd;
      if (filledUsd && filledUsd > 0) {
        // Deduct partial fill from budget too
        this.deductFromCycleHedgeBudget(filledUsd);
        this.logger.warn(
          `[SmartHedging] ⚠️ Hedge partially filled: $${filledUsd.toFixed(2)} spent (order incomplete)`,
        );
        // Return partial fill info so caller can mark position as hedged
        return {
          success: false,
          reason: result.reason ?? "ORDER_NOT_FILLED",
          filledAmountUsd: filledUsd,
        };
      }

      this.logger.warn(
        `[SmartHedging] ⚠️ Hedge order not filled: ${result.reason ?? "unknown"}`,
      );
      return { success: false, reason: result.reason ?? "ORDER_NOT_FILLED" };
    } catch (err) {
      this.logger.error(
        `[SmartHedging] ❌ Hedge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { success: false, reason: "HEDGE_ERROR" };
    }
  }

  /**
   * Normalize an outcome string to the OrderOutcome type expected by postOrder.
   *
   * IMPORTANT: The CLOB API uses tokenId (not outcome) to identify the specific
   * outcome token for order execution. The outcome field is primarily for logging
   * and internal bookkeeping. For non-YES/NO markets, we use "YES" as a placeholder
   * since the tokenId is what actually determines which side is being traded.
   *
   * @param outcome - The outcome string from the position (e.g., "YES", "NO", "Over", "Under", "Team A")
   * @returns "YES" or "NO" for the order API
   */
  private normalizeOutcomeForOrder(outcome: string): "YES" | "NO" {
    const upper = outcome.toUpperCase();
    if (upper === "YES" || upper === "NO") {
      return upper as "YES" | "NO";
    }
    // For non-YES/NO markets (Over/Under, Team A/Team B, etc.), we use "YES" as a
    // placeholder. The tokenId is what the CLOB API uses to identify the specific
    // outcome token - the outcome field is just metadata for logging.
    return "YES";
  }

  /**
   * Sell a position to stop losses
   * Supports all binary market types: YES/NO, Over/Under, Team A/Team B, etc.
   */
  private async sellPosition(position: Position): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[SmartHedging] No wallet - cannot sell`);
      return false;
    }

    // The execute() method already filters out positions without a side,
    // but check again as a safety measure
    if (!position.side || position.side.trim() === "") {
      this.logger.warn(
        `[SmartHedging] Position has no side defined - cannot sell (tokenId=${position.tokenId})`,
      );
      return false;
    }

    const currentValue = position.size * position.currentPrice;

    this.logger.info(
      `[SmartHedging] 💸 SELLING ${position.side} to salvage $${currentValue.toFixed(2)}`,
    );

    try {
      // Normalize the outcome for the order (tokenId is what matters for execution)
      const orderOutcome = this.normalizeOutcomeForOrder(position.side);

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: orderOutcome,
        side: "SELL",
        sizeUsd: currentValue,
        logger: this.logger,
        skipDuplicatePrevention: true,
        skipMinOrderSizeCheck: true, // Allow selling small positions during liquidation
      });

      if (result.status === "submitted") {
        this.logger.info(`[SmartHedging] ✅ Position sold`);
        return true;
      }

      this.logger.warn(
        `[SmartHedging] ⚠️ Sell not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[SmartHedging] ❌ Sell failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the opposite token ID for hedging in any binary market.
   * Works for YES/NO, Over/Under, Team A/Team B, or any other two-outcome market.
   *
   * For binary markets, there are always exactly 2 tokens. We find the one
   * that is NOT the current position's token.
   *
   * @returns Object with tokenId and outcome name, or null if not found
   */
  private async getOppositeToken(
    marketId: string,
    currentTokenId: string,
  ): Promise<{ tokenId: string; outcome: string } | null> {
    try {
      const market = await this.client.getMarket(marketId);
      if (!market) return null;

      const tokens = (
        market as { tokens?: Array<{ token_id: string; outcome: string }> }
      ).tokens;
      // Ensure this is truly a binary market: must have exactly 2 tokens
      if (!tokens || tokens.length !== 2) return null;

      // For any binary market, find the token that is NOT the current one
      const oppositeToken = tokens.find((t) => t.token_id !== currentTokenId);

      if (!oppositeToken) return null;

      // Outcome should always be defined for valid market tokens.
      // If missing, log a warning but continue - the tokenId is what matters for execution.
      if (!oppositeToken.outcome) {
        this.logger.warn(
          `[SmartHedging] Opposite token has no outcome defined (marketId=${marketId}, tokenId=${oppositeToken.token_id})`,
        );
      }

      return {
        tokenId: oppositeToken.token_id,
        outcome: oppositeToken.outcome ?? "Unknown",
      };
    } catch {
      return null;
    }
  }

  /**
   * Clean up expired cooldown entries to prevent unbounded memory growth.
   *
   * This handles cases where positions are removed through other means
   * (e.g., sold externally, redeemed, manually removed) before their
   * cooldown expires. Without cleanup, entries would accumulate indefinitely.
   *
   * Strategy:
   * 1. Remove all entries with expired timestamps
   * 2. If still over max size, remove oldest entries
   */
  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    let expiredCount = 0;

    // First pass: remove all expired entries
    for (const [key, expiresAt] of this.failedLiquidationCooldowns) {
      if (now >= expiresAt) {
        this.failedLiquidationCooldowns.delete(key);
        expiredCount++;
      }
    }

    // Second pass: if still over max size, remove oldest entries
    if (
      this.failedLiquidationCooldowns.size >
      MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES
    ) {
      const entries = Array.from(this.failedLiquidationCooldowns.entries());
      // Sort by expiration time (oldest first)
      entries.sort((a, b) => a[1] - b[1]);

      const toRemove = entries.length - MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES;
      for (let i = 0; i < toRemove; i++) {
        this.failedLiquidationCooldowns.delete(entries[i][0]);
      }

      this.logger.debug(
        `[SmartHedging] Cleaned up ${expiredCount} expired + ${toRemove} oldest cooldown entries (max: ${MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES})`,
      );
    } else if (expiredCount > 0) {
      this.logger.debug(
        `[SmartHedging] Cleaned up ${expiredCount} expired cooldown entries`,
      );
    }
  }

  /**
   * Get strategy stats
   */
  getStats(): {
    enabled: boolean;
    hedgedCount: number;
    failedLiquidationCooldownCount: number;
  } {
    return {
      enabled: this.config.enabled,
      hedgedCount: this.hedgedPositions.size,
      failedLiquidationCooldownCount: this.failedLiquidationCooldowns.size,
    };
  }

  /**
   * Get required reserve for hedging
   */
  getRequiredReserve(): number {
    if (!this.config.enabled) return 0;
    return this.config.allowExceedMax
      ? this.config.absoluteMaxUsd
      : this.config.maxHedgeUsd;
  }

  /**
   * Get positions that are candidates for liquidation when funds are insufficient.
   * This exposes the PositionTracker's liquidation candidates for external visibility
   * (e.g., for monitoring, debugging, or external fund management).
   *
   * Returns active losing positions that can be sold to free up funds for hedging,
   * sorted by worst loss first. Excludes positions that are already hedged or
   * in cooldown.
   *
   * @returns Array of positions suitable for liquidation, sorted by worst loss first
   */
  getLiquidationCandidates(): Position[] {
    const candidates = this.positionTracker.getLiquidationCandidates(
      this.config.triggerLossPct,
      this.config.minHoldSeconds,
    );

    // Exclude positions we've already hedged or that are in cooldown
    const now = Date.now();
    return candidates.filter((pos) => {
      const key = `${pos.marketId}-${pos.tokenId}`;

      // Skip if already hedged
      if (this.hedgedPositions.has(key)) {
        return false;
      }

      // Skip if in failed liquidation cooldown
      const cooldownUntil = this.failedLiquidationCooldowns.get(key);
      if (cooldownUntil && now < cooldownUntil) {
        return false;
      }

      return true;
    });
  }

  /**
   * Get the total USD value that could be recovered by liquidating losing positions.
   * This is useful for determining how much funds could potentially be freed up
   * for hedging operations when the wallet balance is insufficient.
   *
   * @returns Total USD value of liquidation candidates (current market value)
   */
  getLiquidationCandidatesValue(): number {
    const candidates = this.getLiquidationCandidates();
    return candidates.reduce(
      (total, pos) => total + pos.size * pos.currentPrice,
      0,
    );
  }
}
