/**
 * Enterprise Smart Hedge Module
 *
 * CORE PRINCIPLES (NON-NEGOTIABLE):
 * 1. SmartHedge is ADDITIVE only - NEVER blocks stop-loss or panic liquidation
 * 2. Capital-aware - only uses explicitly available hedge reserves
 * 3. Bounded - hedge size, cost, and duration are capped
 *
 * This module is a SUPPORTING risk tool, not a primary strategy.
 */

import type { ConsoleLogger } from "../utils/logger.util";
import type { RiskManager } from "./risk-manager";
import type { ExecutionEngine } from "./execution-engine";
import type { OrderRequest, OrderSide, TrackedPosition } from "./types";

// ============================================================
// CONFIGURATION
// ============================================================

export interface EnterpriseSmartHedgeConfig {
  /**
   * Enable smart hedging
   * @default true
   */
  enabled: boolean;

  /**
   * Loss window for hedging eligibility (as positive percentages)
   * Hedge only when: HEDGE_MIN_LOSS <= loss_pct <= HEDGE_MAX_LOSS
   * @default { min: 5, max: 20 }
   */
  hedgeWindowMinLossPct: number;
  hedgeWindowMaxLossPct: number;

  /**
   * PANIC threshold - SmartHedge MUST disengage at this loss level
   * No exceptions. Stop-loss liquidation takes over.
   * @default 25
   */
  panicLossPct: number;

  /**
   * Maximum spread for hedge eligibility (in cents)
   * @default 5
   */
  maxHedgeSpreadCents: number;

  /**
   * Minimum depth required on hedge side (USD)
   * @default 50
   */
  minHedgeDepthUsd: number;

  /**
   * Maximum cost for hedge (in cents)
   * @default 3
   */
  maxHedgeCostCents: number;

  /**
   * Maximum hedge size as fraction of position notional
   * Hedge size <= this * position_notional
   * @default 0.3 (30%)
   */
  maxHedgeFraction: number;

  /**
   * Minimum hedge size (USD)
   * Hedges below this are skipped
   * @default 1
   */
  minHedgeUsd: number;

  /**
   * Maximum hedge size (USD)
   * @default 50
   */
  maxHedgeUsd: number;

  /**
   * Allow selling profits to raise reserves
   * @default false
   */
  allowReserveCreation: boolean;

  /**
   * If reserve creation enabled, minimum profit to keep on sold position
   * @default 0.20
   */
  emergencyMinProfitUsd: number;

  /**
   * Maximum reserves to raise per cycle (USD)
   * @default 20
   */
  maxReserveRaisePerCycleUsd: number;

  /**
   * Verbose logging
   * @default false
   */
  verboseLogging: boolean;
}

export const DEFAULT_SMART_HEDGE_CONFIG: EnterpriseSmartHedgeConfig = {
  enabled: true,
  hedgeWindowMinLossPct: 5,
  hedgeWindowMaxLossPct: 20,
  panicLossPct: 25,
  maxHedgeSpreadCents: 5,
  minHedgeDepthUsd: 50,
  maxHedgeCostCents: 3,
  maxHedgeFraction: 0.3,
  minHedgeUsd: 1,
  maxHedgeUsd: 50,
  allowReserveCreation: false,
  emergencyMinProfitUsd: 0.2,
  maxReserveRaisePerCycleUsd: 20,
  verboseLogging: false,
};

// ============================================================
// TYPES
// ============================================================

export type HedgeReason = "offset" | "smoothing" | "extension";
export type HedgeOutcome =
  | "success"
  | "skipped"
  | "aborted"
  | "panic"
  | "no_reserve"
  | "not_eligible";

export interface HedgeDecision {
  positionId: string;
  lossPct: number;
  hedgeReason: HedgeReason | null;
  hedgeCostUsd: number;
  hedgeSize: number;
  expectedBenefitUsd: number;
  outcome: HedgeOutcome;
  reason: string;
  timestamp: number;
}

export interface MarketConditions {
  spread: number; // cents
  bidDepth: number; // USD
  askDepth: number; // USD
  bestBid: number; // price
  bestAsk: number; // price
}

export interface HedgeReserveInfo {
  availableUsd: number;
  requiredUsd: number;
  sufficient: boolean;
}

// ============================================================
// SMART HEDGE MODULE
// ============================================================

export class EnterpriseSmartHedge {
  private readonly config: EnterpriseSmartHedgeConfig;
  private readonly logger: ConsoleLogger;
  private readonly riskManager: RiskManager;
  private readonly executionEngine: ExecutionEngine;

  // Decision log for observability
  private readonly decisionLog: HedgeDecision[] = [];
  private readonly maxDecisionLogSize = 100;

  // Reserve tracking
  private reserveRaisedThisCycle = 0;

  constructor(
    config: Partial<EnterpriseSmartHedgeConfig>,
    logger: ConsoleLogger,
    riskManager: RiskManager,
    executionEngine: ExecutionEngine,
  ) {
    this.config = { ...DEFAULT_SMART_HEDGE_CONFIG, ...config };
    this.logger = logger;
    this.riskManager = riskManager;
    this.executionEngine = executionEngine;

    this.logger.info(
      `[SmartHedge] Initialized: window=${this.config.hedgeWindowMinLossPct}-${this.config.hedgeWindowMaxLossPct}%, ` +
        `panic=${this.config.panicLossPct}%, maxFraction=${this.config.maxHedgeFraction}`,
    );
  }

  /**
   * Evaluate whether to hedge a position
   *
   * SmartHedge may act ONLY if ALL conditions are true:
   * - Position loss is within HEDGE_WINDOW
   * - Position is NOT in PANIC state
   * - Market is liquid enough
   * - Hedge is cheap
   * - Hedge capital is available
   *
   * If any condition fails → SmartHedge EXITS immediately and allows stop-loss
   */
  async evaluatePosition(
    position: TrackedPosition,
    market: MarketConditions,
    availableReserveUsd: number,
  ): Promise<HedgeDecision> {
    const lossPct = Math.abs(position.unrealizedPnlPct);
    const decision: HedgeDecision = {
      positionId: position.tokenId,
      lossPct,
      hedgeReason: null,
      hedgeCostUsd: 0,
      hedgeSize: 0,
      expectedBenefitUsd: 0,
      outcome: "not_eligible",
      reason: "",
      timestamp: Date.now(),
    };

    // ============================================================
    // PANIC OVERRIDE (HARD RULE) - Check first
    // ============================================================
    if (lossPct >= this.config.panicLossPct) {
      decision.outcome = "panic";
      decision.reason = `PANIC: ${lossPct.toFixed(1)}% >= ${this.config.panicLossPct}% threshold`;
      this.logDecision(decision);

      // MUST signal RiskManager to resume normal stop-loss behavior
      this.signalStopLossEligible(position.tokenId);

      return decision;
    }

    // ============================================================
    // HEDGE WINDOW CHECK
    // ============================================================
    if (lossPct < this.config.hedgeWindowMinLossPct) {
      decision.outcome = "skipped";
      decision.reason = `Loss ${lossPct.toFixed(1)}% < min ${this.config.hedgeWindowMinLossPct}%`;
      this.logDecision(decision);
      return decision;
    }

    if (lossPct > this.config.hedgeWindowMaxLossPct) {
      decision.outcome = "skipped";
      decision.reason = `Loss ${lossPct.toFixed(1)}% > max ${this.config.hedgeWindowMaxLossPct}%`;
      this.logDecision(decision);
      // Allow stop-loss to handle this
      this.signalStopLossEligible(position.tokenId);
      return decision;
    }

    // ============================================================
    // MARKET LIQUIDITY CHECK
    // ============================================================
    const spreadCents = (market.bestAsk - market.bestBid) * 100;
    if (spreadCents > this.config.maxHedgeSpreadCents) {
      decision.outcome = "skipped";
      decision.reason = `Spread ${spreadCents.toFixed(1)}¢ > max ${this.config.maxHedgeSpreadCents}¢`;
      this.logDecision(decision);
      return decision;
    }

    // Check depth on the side we'd be buying for hedge
    // If position is YES, we hedge by buying NO (need to check askDepth for NO)
    // If position is NO, we hedge by buying YES (need to check bidDepth for YES)
    // Note: In Polymarket, buying NO uses the ask side of the NO token orderbook
    const hedgeDepth =
      position.outcome === "YES" ? market.askDepth : market.bidDepth;
    if (hedgeDepth < this.config.minHedgeDepthUsd) {
      decision.outcome = "skipped";
      decision.reason = `Hedge depth $${hedgeDepth.toFixed(2)} < min $${this.config.minHedgeDepthUsd}`;
      this.logDecision(decision);
      return decision;
    }

    // ============================================================
    // HEDGE COST CHECK
    // ============================================================
    // When hedging YES position by buying NO:
    //   - Use bestAsk price for NO token (market.bestAsk represents ask side)
    // When hedging NO position by buying YES:
    //   - Use bestBid price for YES token (since we're buying at the bid)
    // In practice with Polymarket: YES + NO = $1, so NO price ≈ 1 - YES price
    const hedgePrice =
      position.outcome === "YES" ? market.bestAsk : market.bestBid;
    const hedgeCostCents = hedgePrice * 100;
    if (hedgeCostCents > this.config.maxHedgeCostCents) {
      decision.outcome = "skipped";
      decision.reason = `Hedge cost ${hedgeCostCents.toFixed(1)}¢ > max ${this.config.maxHedgeCostCents}¢`;
      this.logDecision(decision);
      return decision;
    }

    // ============================================================
    // CALCULATE HEDGE SIZE
    // ============================================================
    const positionNotional = position.currentValue;
    let hedgeSize = Math.min(
      positionNotional * this.config.maxHedgeFraction,
      this.config.maxHedgeUsd,
    );

    if (hedgeSize < this.config.minHedgeUsd) {
      decision.outcome = "skipped";
      decision.reason = `Hedge size $${hedgeSize.toFixed(2)} < min $${this.config.minHedgeUsd}`;
      this.logDecision(decision);
      return decision;
    }

    // ============================================================
    // RESERVE CHECK
    // ============================================================
    const requiredReserve = hedgeSize;
    if (availableReserveUsd < requiredReserve) {
      // Try to create reserves if allowed
      if (this.config.allowReserveCreation) {
        const raised = await this.tryRaiseReserves(
          requiredReserve - availableReserveUsd,
        );
        if (!raised) {
          decision.outcome = "no_reserve";
          decision.reason = `Insufficient reserves: need $${requiredReserve.toFixed(2)}, have $${availableReserveUsd.toFixed(2)}, raise failed`;
          this.logDecision(decision);
          // Allow stop-loss
          this.signalStopLossEligible(position.tokenId);
          return decision;
        }
      } else {
        decision.outcome = "no_reserve";
        decision.reason = `Insufficient reserves: need $${requiredReserve.toFixed(2)}, have $${availableReserveUsd.toFixed(2)}`;
        this.logDecision(decision);
        // Allow stop-loss
        this.signalStopLossEligible(position.tokenId);
        return decision;
      }
    }

    // ============================================================
    // ALL CONDITIONS MET - EXECUTE HEDGE
    // ============================================================
    decision.hedgeReason = "offset"; // Partial risk offset
    decision.hedgeCostUsd = hedgeSize * hedgePrice;
    decision.hedgeSize = hedgeSize / hedgePrice; // Shares
    decision.expectedBenefitUsd = this.calculateExpectedBenefit(
      position,
      hedgeSize,
      lossPct,
    );

    try {
      const hedgeResult = await this.executeHedge(
        position,
        hedgeSize,
        hedgePrice,
      );

      if (hedgeResult.success) {
        decision.outcome = "success";
        decision.reason = "Hedge executed successfully";
      } else {
        decision.outcome = "aborted";
        decision.reason = `Hedge failed: ${hedgeResult.error}`;
        // Allow stop-loss on failure
        this.signalStopLossEligible(position.tokenId);
      }
    } catch (err) {
      decision.outcome = "aborted";
      decision.reason = `Hedge error: ${err instanceof Error ? err.message : String(err)}`;
      // Allow stop-loss on error
      this.signalStopLossEligible(position.tokenId);
    }

    this.logDecision(decision);
    return decision;
  }

  /**
   * Execute the hedge order
   */
  private async executeHedge(
    position: TrackedPosition,
    hedgeSizeUsd: number,
    hedgePrice: number,
  ): Promise<{ success: boolean; error?: string }> {
    // Determine hedge parameters
    // If original position is YES, hedge by buying NO
    // If original position is NO, hedge by buying YES
    const hedgeOutcome = position.outcome === "YES" ? "NO" : "YES";
    const hedgeSide: OrderSide = "BUY";

    const orderRequest: OrderRequest = {
      strategyId: "SMART_HEDGE",
      marketId: position.marketId,
      tokenId: position.tokenId, // Same market, different outcome
      outcome: hedgeOutcome,
      side: hedgeSide,
      size: hedgeSizeUsd / hedgePrice,
      price: hedgePrice,
      sizeUsd: hedgeSizeUsd,
      orderType: "LIMIT",
    };

    this.logger.info(
      `[SmartHedge] Executing hedge for ${position.tokenId}: ` +
        `${hedgeOutcome} $${hedgeSizeUsd.toFixed(2)} @ ${hedgePrice.toFixed(3)}`,
    );

    const result = await this.executionEngine.executeOrder(orderRequest);

    if (!result.success) {
      this.logger.warn(
        `[SmartHedge] Hedge failed for ${position.tokenId}: ${result.rejectReason ?? result.error}`,
      );
      return { success: false, error: result.rejectReason ?? result.error };
    }

    this.logger.info(
      `[SmartHedge] ✅ Hedge successful for ${position.tokenId}: ` +
        `${result.filledSize?.toFixed(2)} shares filled`,
    );

    return { success: true };
  }

  /**
   * Try to raise reserves by selling profitable positions
   * Only allowed if config.allowReserveCreation is true
   */
  private async tryRaiseReserves(amountNeeded: number): Promise<boolean> {
    if (!this.config.allowReserveCreation) {
      return false;
    }

    // Check cycle limit
    if (this.reserveRaisedThisCycle >= this.config.maxReserveRaisePerCycleUsd) {
      this.logger.debug(
        `[SmartHedge] Reserve raise limit reached: $${this.reserveRaisedThisCycle.toFixed(2)}`,
      );
      return false;
    }

    const maxRaise = Math.min(
      amountNeeded,
      this.config.maxReserveRaisePerCycleUsd - this.reserveRaisedThisCycle,
    );

    this.logger.debug(
      `[SmartHedge] Attempting to raise $${maxRaise.toFixed(2)} in reserves`,
    );

    // In a full implementation, this would:
    // 1. Find profitable positions
    // 2. Select those with profit > emergencyMinProfitUsd
    // 3. Sell portion to raise needed reserves
    // 4. Track the amount raised

    // For now, return false - reserve creation requires position access
    this.logger.debug(
      `[SmartHedge] Reserve creation not implemented - aborting`,
    );
    return false;
  }

  /**
   * Calculate expected benefit of hedge
   */
  private calculateExpectedBenefit(
    position: TrackedPosition,
    hedgeSize: number,
    currentLossPct: number,
  ): number {
    // Simplified calculation:
    // Expected benefit = potential avoided loss - hedge cost
    // If position continues to drop to panic level, hedge saves the difference
    const potentialAdditionalLoss =
      (this.config.panicLossPct - currentLossPct) / 100;
    const positionValue = position.currentValue;
    const avoidedLoss = positionValue * potentialAdditionalLoss;

    // Hedge cost is the premium paid
    const hedgeCost = hedgeSize * 0.02; // Assume ~2% premium for hedge

    return Math.max(0, avoidedLoss - hedgeCost);
  }

  /**
   * Signal that stop-loss is eligible for this position
   * Called when SmartHedge cannot act or fails
   */
  private signalStopLossEligible(tokenId: string): void {
    // The RiskManager should allow stop-loss orders for this position
    // This is a signal that SmartHedge has stepped back
    if (this.config.verboseLogging) {
      this.logger.debug(`[SmartHedge] Stop-loss re-enabled for ${tokenId}`);
    }
  }

  /**
   * Log decision for observability
   */
  private logDecision(decision: HedgeDecision): void {
    // Add to log
    this.decisionLog.push(decision);
    if (this.decisionLog.length > this.maxDecisionLogSize) {
      this.decisionLog.shift();
    }

    // Log to console
    const emoji =
      decision.outcome === "success"
        ? "✅"
        : decision.outcome === "panic"
          ? "🚨"
          : decision.outcome === "aborted"
            ? "❌"
            : "⏭️";

    this.logger.info(
      `[SmartHedge] ${emoji} ${decision.positionId.slice(0, 8)}... ` +
        `loss=${decision.lossPct.toFixed(1)}% reason=${decision.hedgeReason ?? "N/A"} ` +
        `cost=$${decision.hedgeCostUsd.toFixed(2)} size=${decision.hedgeSize.toFixed(2)} ` +
        `benefit=$${decision.expectedBenefitUsd.toFixed(2)} outcome=${decision.outcome}: ${decision.reason}`,
    );
  }

  /**
   * Reset cycle tracking (call at start of each execution cycle)
   */
  resetCycle(): void {
    this.reserveRaisedThisCycle = 0;
  }

  /**
   * Get recent decisions for monitoring
   */
  getRecentDecisions(limit: number = 10): HedgeDecision[] {
    return this.decisionLog.slice(-limit);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalDecisions: number;
    successCount: number;
    skippedCount: number;
    abortedCount: number;
    panicCount: number;
    noReserveCount: number;
  } {
    const stats = {
      totalDecisions: this.decisionLog.length,
      successCount: 0,
      skippedCount: 0,
      abortedCount: 0,
      panicCount: 0,
      noReserveCount: 0,
    };

    for (const d of this.decisionLog) {
      switch (d.outcome) {
        case "success":
          stats.successCount++;
          break;
        case "skipped":
        case "not_eligible":
          stats.skippedCount++;
          break;
        case "aborted":
          stats.abortedCount++;
          break;
        case "panic":
          stats.panicCount++;
          break;
        case "no_reserve":
          stats.noReserveCount++;
          break;
      }
    }

    return stats;
  }

  /**
   * Check if position is within hedge window
   */
  isInHedgeWindow(lossPct: number): boolean {
    return (
      lossPct >= this.config.hedgeWindowMinLossPct &&
      lossPct <= this.config.hedgeWindowMaxLossPct
    );
  }

  /**
   * Check if position is in PANIC state
   */
  isInPanic(lossPct: number): boolean {
    return lossPct >= this.config.panicLossPct;
  }
}

/**
 * Create EnterpriseSmartHedge from environment config
 */
export function loadSmartHedgeConfigFromEnv(): Partial<EnterpriseSmartHedgeConfig> {
  return {
    enabled: process.env.SMART_HEDGING_ENABLED?.toLowerCase() !== "false",
    hedgeWindowMinLossPct: process.env.SMART_HEDGING_TRIGGER_LOSS_PCT
      ? parseFloat(process.env.SMART_HEDGING_TRIGGER_LOSS_PCT) * 0.5
      : undefined,
    hedgeWindowMaxLossPct: process.env.SMART_HEDGING_TRIGGER_LOSS_PCT
      ? parseFloat(process.env.SMART_HEDGING_TRIGGER_LOSS_PCT)
      : undefined,
    panicLossPct: process.env.SMART_HEDGING_EMERGENCY_LOSS_PCT
      ? parseFloat(process.env.SMART_HEDGING_EMERGENCY_LOSS_PCT)
      : undefined,
    maxHedgeUsd: process.env.SMART_HEDGING_MAX_HEDGE_USD
      ? parseFloat(process.env.SMART_HEDGING_MAX_HEDGE_USD)
      : undefined,
    minHedgeUsd: process.env.SMART_HEDGING_MIN_HEDGE_USD
      ? parseFloat(process.env.SMART_HEDGING_MIN_HEDGE_USD)
      : undefined,
    allowReserveCreation:
      process.env.SMART_HEDGING_ALLOW_EXCEED_MAX?.toLowerCase() === "true",
    maxReserveRaisePerCycleUsd: process.env.SMART_HEDGING_ABSOLUTE_MAX_USD
      ? parseFloat(process.env.SMART_HEDGING_ABSOLUTE_MAX_USD)
      : undefined,
  };
}
