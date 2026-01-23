/**
 * Smart Hedging Strategy - SIMPLIFIED
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
 * Simple Smart Hedging Configuration
 */
export interface SimpleSmartHedgingConfig {
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

export const DEFAULT_SIMPLE_HEDGING_CONFIG: SimpleSmartHedgingConfig = {
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
 * Simple Smart Hedging Strategy
 */
export class SimpleSmartHedgingStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: SimpleSmartHedgingConfig;

  // Track what we've already hedged to avoid double-hedging
  private hedgedPositions: Set<string> = new Set();

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    positionTracker: PositionTracker;
    config: SimpleSmartHedgingConfig;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.positionTracker = config.positionTracker;
    this.config = config.config;

    this.logger.info(
      `[SimpleHedging] Initialized: trigger=-${this.config.triggerLossPct}%, ` +
        `maxHedge=$${this.config.maxHedgeUsd}, absoluteMax=$${this.config.absoluteMaxUsd}`,
    );
  }

  /**
   * Execute the strategy - find losing positions and hedge them
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    const positions = this.positionTracker.getPositions();
    let actionsCount = 0;
    const now = Date.now();

    for (const position of positions) {
      const key = `${position.marketId}-${position.tokenId}`;

      // Skip if already hedged
      if (this.hedgedPositions.has(key)) {
        continue;
      }

      // Skip if not losing enough
      if (position.pnlPct > -this.config.triggerLossPct) {
        continue;
      }

      // Skip if entry price too high (not risky tier)
      if (position.entryPrice >= this.config.maxEntryPrice) {
        continue;
      }

      // Skip if no side defined (can't hedge without knowing the outcome)
      const side = position.side?.toUpperCase();
      if (!side || side.trim() === "") {
        continue;
      }

      // Skip resolved positions
      if (position.redeemable) {
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
          `[SimpleHedging] ⏳ Skipping position without entryTime for min-hold check (marketId=${position.marketId}, tokenId=${position.tokenId})`,
        );
        continue;
      }

      const holdSeconds = (now - entryTime) / 1000;
      if (holdSeconds < this.config.minHoldSeconds) {
        this.logger.debug(
          `[SimpleHedging] ⏳ Position losing ${Math.abs(position.pnlPct).toFixed(1)}% but held only ${holdSeconds.toFixed(0)}s (need ${this.config.minHoldSeconds}s) - waiting`,
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
              `[SimpleHedging] 🚨 No-hedge window (${minutesToClose.toFixed(1)}min to close), loss ${lossPct.toFixed(1)}% >= ${this.config.forceLiquidationPct}% - LIQUIDATING`,
            );
            const sold = await this.sellPosition(position);
            if (sold) {
              actionsCount++;
              this.hedgedPositions.add(key);
            }
          } else {
            this.logger.debug(
              `[SimpleHedging] ⏳ No-hedge window (${minutesToClose.toFixed(1)}min to close), loss ${lossPct.toFixed(1)}% - skipping (too late to hedge)`,
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
              `[SimpleHedging] ⏳ Near-close (${minutesToClose.toFixed(1)}min to close), loss ${lossPct.toFixed(1)}% / drop ${priceDropCents.toFixed(1)}¢ - skipping (thresholds: ${this.config.nearCloseLossPct}% or ${this.config.nearClosePriceDropCents}¢)`,
            );
            continue;
          }

          this.logger.info(
            `[SimpleHedging] 📍 Near-close hedge triggered: ${minutesToClose.toFixed(1)}min to close, ` +
              `loss=${lossPct.toFixed(1)}%${meetsLossThreshold ? " ✓" : ""}, ` +
              `drop=${priceDropCents.toFixed(1)}¢${meetsDropThreshold ? " ✓" : ""}`,
          );
        }
      }

      // Force liquidation if loss is catastrophic
      if (lossPct >= this.config.forceLiquidationPct) {
        this.logger.warn(
          `[SimpleHedging] 🚨 Loss ${lossPct.toFixed(1)}% >= ${this.config.forceLiquidationPct}% - LIQUIDATING`,
        );
        const sold = await this.sellPosition(position);
        if (sold) {
          actionsCount++;
          this.hedgedPositions.add(key);
        }
        continue;
      }

      // Try to hedge
      this.logger.info(
        `[SimpleHedging] 🎯 Position losing ${lossPct.toFixed(1)}% - attempting hedge`,
      );

      const hedged = await this.executeHedge(position);
      if (hedged) {
        actionsCount++;
        this.hedgedPositions.add(key);
        continue;
      }

      // Hedge failed - liquidate to stop bleeding
      this.logger.warn(`[SimpleHedging] ⚠️ Hedge failed - liquidating instead`);
      const sold = await this.sellPosition(position);
      if (sold) {
        actionsCount++;
        this.hedgedPositions.add(key);
      }
    }

    return actionsCount;
  }

  /**
   * Execute a hedge - buy the opposite side
   * Supports all binary market types: YES/NO, Over/Under, Team A/Team B, etc.
   */
  private async executeHedge(position: Position): Promise<boolean> {
    const currentSide = position.side?.toUpperCase();

    // Get the opposite token (works for any binary market)
    const oppositeInfo = await this.getOppositeToken(
      position.marketId,
      position.tokenId,
    );

    if (!oppositeInfo) {
      this.logger.warn(
        `[SimpleHedging] Could not find opposite token for ${currentSide}`,
      );
      return false;
    }

    const { tokenId: oppositeTokenId, outcome: oppositeSide } = oppositeInfo;

    // Get opposite side price
    let oppositePrice: number;
    try {
      const orderbook = await this.client.getOrderBook(oppositeTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(`[SimpleHedging] No liquidity for ${oppositeSide}`);
        return false;
      }
      oppositePrice = parseFloat(orderbook.asks[0].price);
    } catch {
      this.logger.warn(`[SimpleHedging] Failed to get opposite price`);
      return false;
    }

    // If opposite is too expensive (>90¢), our side is probably losing - just sell
    if (oppositePrice >= 0.9) {
      this.logger.warn(
        `[SimpleHedging] ${oppositeSide} at ${(oppositePrice * 100).toFixed(0)}¢ - too expensive to hedge`,
      );
      return false;
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
        `[SimpleHedging] Hedge $${hedgeUsd.toFixed(2)} below min $${this.config.minHedgeUsd}`,
      );
      return false;
    }

    // Calculate expected outcomes
    const hedgeShares = hedgeUsd / oppositePrice;
    const totalInvested = originalInvestment + hedgeUsd;
    const ifOriginalWins = position.size * 1.0 - totalInvested;
    const ifHedgeWins = hedgeShares * 1.0 - totalInvested;

    this.logger.info(
      `[SimpleHedging] 🔄 HEDGING: Buy ${hedgeShares.toFixed(2)} ${oppositeSide} @ ${(oppositePrice * 100).toFixed(1)}¢ = $${hedgeUsd.toFixed(2)}` +
        `\n  If ${currentSide} wins: ${ifOriginalWins >= 0 ? "+" : ""}$${ifOriginalWins.toFixed(2)}` +
        `\n  If ${oppositeSide} wins: ${ifHedgeWins >= 0 ? "+" : ""}$${ifHedgeWins.toFixed(2)}`,
    );

    // Execute the hedge order
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[SimpleHedging] No wallet - cannot hedge`);
      return false;
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
        this.logger.info(`[SimpleHedging] ✅ Hedge executed successfully`);
        return true;
      }

      this.logger.warn(
        `[SimpleHedging] ⚠️ Hedge order not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[SimpleHedging] ❌ Hedge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
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
      this.logger.error(`[SimpleHedging] No wallet - cannot sell`);
      return false;
    }

    // The execute() method already filters out positions without a side,
    // but check again as a safety measure
    if (!position.side || position.side.trim() === "") {
      this.logger.warn(
        `[SimpleHedging] Position has no side defined - cannot sell (tokenId=${position.tokenId})`,
      );
      return false;
    }

    const currentValue = position.size * position.currentPrice;

    this.logger.info(
      `[SimpleHedging] 💸 SELLING ${position.side} to salvage $${currentValue.toFixed(2)}`,
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
      });

      if (result.status === "submitted") {
        this.logger.info(`[SimpleHedging] ✅ Position sold`);
        return true;
      }

      this.logger.warn(
        `[SimpleHedging] ⚠️ Sell not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[SimpleHedging] ❌ Sell failed: ${err instanceof Error ? err.message : String(err)}`,
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
          `[SimpleHedging] Opposite token has no outcome defined (marketId=${marketId}, tokenId=${oppositeToken.token_id})`,
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
   * Get strategy stats
   */
  getStats(): { enabled: boolean; hedgedCount: number } {
    return {
      enabled: this.config.enabled,
      hedgedCount: this.hedgedPositions.size,
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
}
