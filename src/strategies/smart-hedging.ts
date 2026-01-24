/**
 * Smart Hedging Strategy
 *
 * Instead of selling at a loss, buy the opposing outcome to guarantee profit.
 *
 * SIMPLE LOGIC:
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

/**
 * Smart Hedging Configuration
 */
export interface SmartHedgingConfig {
  /** Enable smart hedging */
  enabled: boolean;

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
}

export const DEFAULT_HEDGING_CONFIG: SmartHedgingConfig = {
  enabled: true,
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

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

  // Track what we've already hedged to avoid double-hedging
  private hedgedPositions: Set<string> = new Set();

  // Track failed liquidation attempts with cooldown to prevent repeated retries
  // Key: position key (marketId-tokenId), Value: timestamp when cooldown expires
  private failedLiquidationCooldowns: Map<string, number> = new Map();

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    positionTracker: PositionTracker;
    config: SmartHedgingConfig;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.positionTracker = config.positionTracker;
    this.config = config.config;

    this.logger.info(
      `[SmartHedging] Initialized: trigger=-${this.config.triggerLossPct}%, ` +
        `maxHedge=$${this.config.maxHedgeUsd}, absoluteMax=$${this.config.absoluteMaxUsd}`,
    );
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

    const positions = this.positionTracker.getPositions();
    let actionsCount = 0;
    const now = Date.now();

    for (const position of positions) {
      const key = `${position.marketId}-${position.tokenId}`;

      // Skip if already hedged
      if (this.hedgedPositions.has(key)) {
        continue;
      }

      // Skip if in failed liquidation cooldown (prevents repeated attempts)
      const cooldownUntil = this.failedLiquidationCooldowns.get(key);
      if (cooldownUntil && now < cooldownUntil) {
        const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
        this.logger.debug(
          `[SmartHedging] ⏳ Skipping position in liquidation cooldown: ${key} (${remainingSec}s remaining)`,
        );
        continue;
      }
      // Clean up expired cooldown entries (for current position)
      if (cooldownUntil && now >= cooldownUntil) {
        this.failedLiquidationCooldowns.delete(key);
      }

      // Skip if not losing enough
      if (position.pnlPct > -this.config.triggerLossPct) {
        // Only log for positions with meaningful loss (>5%) to reduce noise
        if (position.pnlPct < -5) {
          this.logger.debug(
            `[SmartHedging] 📋 Skip hedge (loss trigger): ${position.side} position pnlPct=${position.pnlPct.toFixed(1)}% > trigger=-${this.config.triggerLossPct}%`,
          );
        }
        continue;
      }

      // Skip if entry price too high (not risky tier)
      if (position.entryPrice >= this.config.maxEntryPrice) {
        this.logger.debug(
          `[SmartHedging] 📋 Skip hedge (entry price gate): ${position.side} entryPrice=${(position.entryPrice * 100).toFixed(0)}¢ >= maxEntryPrice=${(this.config.maxEntryPrice * 100).toFixed(0)}¢`,
        );
        continue;
      }

      // Skip if no side defined (can't hedge without knowing the outcome)
      const side = position.side?.toUpperCase();
      if (!side || side.trim() === "") {
        this.logger.debug(
          `[SmartHedging] 📋 Skip hedge (no side): position tokenId=${position.tokenId.slice(0, 16)}... has no side defined`,
        );
        continue;
      }

      // Skip resolved positions
      if (position.redeemable) {
        this.logger.debug(
          `[SmartHedging] 📋 Skip hedge (redeemable): ${position.side} position already redeemable`,
        );
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
        this.logger.debug(
          `[SmartHedging] ⏳ Skipping position without entryTime for min-hold check (marketId=${position.marketId}, tokenId=${position.tokenId})`,
        );
        continue;
      }

      const holdSeconds = (now - entryTime) / 1000;
      if (holdSeconds < this.config.minHoldSeconds) {
        this.logger.debug(
          `[SmartHedging] ⏳ Position losing ${Math.abs(position.pnlPct).toFixed(1)}% but held only ${holdSeconds.toFixed(0)}s (need ${this.config.minHoldSeconds}s) - waiting`,
        );
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
            this.logger.debug(
              `[SmartHedging] ⏳ No-hedge window (${minutesToClose.toFixed(1)}min to close), loss ${lossPct.toFixed(1)}% - skipping (too late to hedge)`,
            );
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
            this.logger.debug(
              `[SmartHedging] ⏳ Near-close (${minutesToClose.toFixed(1)}min to close), loss ${lossPct.toFixed(1)}% / drop ${priceDropCents.toFixed(1)}¢ - skipping (thresholds: ${this.config.nearCloseLossPct}% or ${this.config.nearClosePriceDropCents}¢)`,
            );
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

    return actionsCount;
  }

  /**
   * Execute a hedge - buy the opposite side
   * Supports all binary market types: YES/NO, Over/Under, Team A/Team B, etc.
   *
   * @returns Object with success status and reason for failure
   *          - reason "MARKET_RESOLVED" means opposite side >= 95¢, skip liquidation
   *          - reason "TOO_EXPENSIVE" means opposite side >= 90¢ but < 95¢, try liquidation
   *          - other reasons indicate hedge attempt failed, try liquidation
   */
  private async executeHedge(
    position: Position,
  ): Promise<{ success: boolean; reason?: string }> {
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
        this.logger.info(`[SmartHedging] ✅ Hedge executed successfully`);
        return { success: true };
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
