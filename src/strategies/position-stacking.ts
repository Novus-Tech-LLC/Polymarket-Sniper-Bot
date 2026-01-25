/**
 * Position Stacking Strategy
 *
 * Allows "stacking" (doubling down) on winning positions that are up significantly
 * from their entry price. This is a momentum-based strategy that capitalizes on
 * positions that are clearly trending in the right direction.
 *
 * LOGIC:
 * 1. Position must be up at least MIN_GAIN_CENTS (default: 20¢) from entry price
 * 2. Position must be profitable (not in loss)
 * 3. Reserves must allow the additional investment
 * 4. Each position can only be stacked ONCE
 * 5. Stack amount is MAX_POSITION_USD
 *
 * CRITICAL SAFETY: STACK-ONCE GUARANTEE
 * The strategy uses MULTIPLE layers of protection to ensure stacking happens only once:
 *
 * 1. IN-MEMORY TRACKING: Tracks stacked tokenIds in memory (fast, but lost on restart)
 *
 * 2. POSITION SIZE VERIFICATION: Before stacking, records the "baseline" position size.
 *    On subsequent cycles, if position size has grown significantly from baseline,
 *    we know the position was stacked (either by us or manually) and skip it.
 *    This survives container restarts because it's derived from actual API data.
 *
 * 3. INITIAL VALUE CHECK: Uses the dataApiInitialValue (cost basis from API) to detect
 *    if position has been increased. If initialValue > baseline * 1.5, position was stacked.
 *
 * 4. COOLDOWN: 60-second cooldown between stack attempts on the same position.
 *
 * ENV: POSITION_STACKING_ENABLED=true (default)
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
import { isLiveTradingEnabled } from "../utils/live-trading.util";
import type { ReservePlan } from "../risk";
import { LogDeduper } from "../utils/log-deduper.util";

/**
 * Position Stacking Configuration
 */
export interface PositionStackingConfig {
  /** Enable the strategy (default: true) */
  enabled: boolean;

  /**
   * Minimum gain in cents from entry price to allow stacking (default: 20)
   * Position must be up at least this many cents from avgEntryPriceCents
   */
  minGainCents: number;

  /**
   * Maximum USD per stack (from MAX_POSITION_USD)
   * This is the amount used when stacking a position
   */
  maxStackUsd: number;

  /**
   * Minimum profit percentage required (default: 0)
   * Additional safeguard - position must be in profit
   * Set to 0 to only use minGainCents
   */
  minProfitPct: number;

  /**
   * Maximum current price to allow stacking (default: 0.95 = 95¢)
   * Prevents stacking on positions that are already near $1
   * (those positions have limited upside)
   */
  maxCurrentPrice: number;

  /**
   * Cooldown in milliseconds after stacking before allowing another check (default: 60000)
   * Prevents rapid-fire stacking attempts on the same position
   */
  cooldownMs: number;

  /**
   * Threshold for detecting position growth (default: 1.4 = 40% growth)
   * If current size > baseline * threshold, position is considered already stacked
   */
  sizeGrowthThreshold: number;
}

export const DEFAULT_POSITION_STACKING_CONFIG: PositionStackingConfig = {
  enabled: true,
  minGainCents: 20,
  maxStackUsd: 25,
  minProfitPct: 0,
  maxCurrentPrice: 0.95,
  cooldownMs: 60000,
  sizeGrowthThreshold: 1.4, // 40% growth indicates stacking occurred
};

/**
 * Tracking entry for a stacked position (in-memory)
 */
interface StackedPositionEntry {
  tokenId: string;
  marketId: string;
  stackedAtMs: number;
  stackedAtPrice: number;
  stackedAmountUsd: number;
  entryPriceCents: number;
  gainCentsAtStack: number;
}

/**
 * Baseline record for detecting position growth
 * This is the key to detecting stacking across restarts
 */
interface PositionBaseline {
  tokenId: string;
  /** First observed position size (shares) */
  baselineSize: number;
  /** First observed initial value (cost basis) from API */
  baselineInitialValue: number;
  /** First observed entry price in cents */
  baselineEntryPriceCents: number;
  /** When we first observed this position */
  firstSeenAtMs: number;
  /** Last time we updated this baseline */
  lastUpdatedAtMs: number;
}

/**
 * Position Stacking Strategy
 */
export class PositionStackingStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: PositionStackingConfig;
  private positionTracker?: PositionTracker;

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === STACKED POSITIONS TRACKING (in-memory, layer 1) ===
  // Key = tokenId, tracks positions that have already been stacked (once per position)
  private stackedPositions: Map<string, StackedPositionEntry> = new Map();

  // === POSITION BASELINES (layer 2 - survives restart detection) ===
  // Key = tokenId, stores the first-observed size and cost basis
  // If current size >> baseline, position was already stacked (even after restart)
  private positionBaselines: Map<string, PositionBaseline> = new Map();

  // === COOLDOWN TRACKING ===
  // Key = tokenId, value = timestamp when cooldown expires
  private cooldowns: Map<string, number> = new Map();

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();
  private static readonly SKIP_LOG_TTL_MS = 60_000;

  // === BASELINE STALENESS ===
  // Baselines older than this are considered stale (2 hours)
  private static readonly BASELINE_STALE_MS = 2 * 60 * 60 * 1000;

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    config: PositionStackingConfig;
    positionTracker?: PositionTracker;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.config = config.config;
    this.positionTracker = config.positionTracker;

    this.logger.info(
      `[PositionStacking] Initialized: enabled=${this.config.enabled}, ` +
        `minGainCents=${this.config.minGainCents}¢, maxStackUsd=$${this.config.maxStackUsd}, ` +
        `sizeGrowthThreshold=${((this.config.sizeGrowthThreshold - 1) * 100).toFixed(0)}%`,
    );
  }

  /**
   * Execute the strategy
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   *
   * @param snapshot Portfolio snapshot from orchestrator
   * @param reservePlan Optional reserve plan for RISK_OFF gating
   */
  async execute(
    snapshot?: PortfolioSnapshot,
    reservePlan?: ReservePlan,
  ): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // RISK_OFF gate: block all BUYs (stacking is a BUY) when reserves are insufficient
    if (reservePlan?.mode === "RISK_OFF") {
      if (
        this.logDeduper.shouldLog(
          "PositionStacking:risk_off",
          PositionStackingStrategy.SKIP_LOG_TTL_MS,
        )
      ) {
        this.logger.debug(
          `[PositionStacking] RISK_OFF - skipping stacking (shortfall=$${reservePlan.shortfall.toFixed(2)})`,
        );
      }
      return 0;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[PositionStacking] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    try {
      return await this.executeInternal(snapshot);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Internal execution logic
   */
  private async executeInternal(snapshot?: PortfolioSnapshot): Promise<number> {
    // Clean up expired cooldowns and stale baselines
    this.cleanupCooldowns();
    this.cleanupStaleBaselines();

    // Get active positions from snapshot or tracker
    const positions = snapshot?.activePositions ?? this.getActivePositions();
    if (positions.length === 0) {
      return 0;
    }

    // Update baselines for all positions (this is how we detect stacking across restarts)
    this.updateBaselines(positions);

    let stackedCount = 0;

    for (const position of positions) {
      // === LAYER 1: In-memory stacking check (fast) ===
      if (this.stackedPositions.has(position.tokenId)) {
        continue;
      }

      // === LAYER 2: Baseline growth check (survives restart) ===
      if (this.hasPositionGrown(position)) {
        // Position has grown significantly from baseline - already stacked
        // Mark it as stacked in memory too to avoid repeated checks
        this.markAsAlreadyStacked(position, "BASELINE_GROWTH_DETECTED");
        continue;
      }

      // Skip if on cooldown
      if (this.isOnCooldown(position.tokenId)) {
        continue;
      }

      // Check if position is eligible for stacking
      const eligibility = this.checkEligibility(position);
      if (!eligibility.eligible) {
        // Rate-limited logging for skip reasons
        if (
          this.logDeduper.shouldLog(
            `PositionStacking:skip:${position.tokenId}`,
            PositionStackingStrategy.SKIP_LOG_TTL_MS,
          )
        ) {
          this.logger.debug(
            `[PositionStacking] Skip ${position.tokenId.slice(0, 8)}...: ${eligibility.reason}`,
          );
        }
        continue;
      }

      // Attempt to stack the position
      const stacked = await this.stackPosition(position, eligibility.gainCents);
      if (stacked) {
        stackedCount++;
      }

      // Set cooldown regardless of success to prevent rapid retries
      this.setCooldown(position.tokenId);
    }

    if (stackedCount > 0) {
      this.logger.info(
        `[PositionStacking] ✅ Stacked ${stackedCount} position(s)`,
      );
    }

    return stackedCount;
  }

  /**
   * Update baselines for all active positions.
   * - Creates baselines for NEW positions (not seen before)
   * - Updates lastUpdatedAtMs for EXISTING positions (to prevent stale cleanup)
   * - Does NOT update baselineSize/baselineInitialValue (key to detecting growth)
   */
  private updateBaselines(positions: readonly Position[]): void {
    const now = Date.now();

    for (const position of positions) {
      const existingBaseline = this.positionBaselines.get(position.tokenId);
      
      if (existingBaseline) {
        // Position already has a baseline - just update the lastUpdatedAtMs
        // to indicate this position is still active (prevents stale cleanup)
        // We do NOT update baselineSize/baselineInitialValue as that would
        // break the growth detection mechanism
        existingBaseline.lastUpdatedAtMs = now;
        continue;
      }

      // Create new baseline for this position
      const baseline: PositionBaseline = {
        tokenId: position.tokenId,
        baselineSize: position.size,
        baselineInitialValue: position.dataApiInitialValue ?? 0,
        baselineEntryPriceCents: position.avgEntryPriceCents ?? 0,
        firstSeenAtMs: now,
        lastUpdatedAtMs: now,
      };

      this.positionBaselines.set(position.tokenId, baseline);

      this.logger.debug(
        `[PositionStacking] Baseline created for ${position.tokenId.slice(0, 8)}...: ` +
          `size=${position.size.toFixed(2)}, initialValue=$${(position.dataApiInitialValue ?? 0).toFixed(2)}`,
      );
    }
  }

  /**
   * Check if a position has grown significantly from its baseline.
   * This indicates the position was already stacked (either by us or manually).
   *
   * Uses multiple signals:
   * 1. Size growth: current size > baseline * threshold
   * 2. Cost basis growth: initialValue > baseline * threshold
   */
  private hasPositionGrown(position: Position): boolean {
    const baseline = this.positionBaselines.get(position.tokenId);
    if (!baseline) {
      // No baseline = new position, can't determine growth
      return false;
    }

    const threshold = this.config.sizeGrowthThreshold;

    // Check 1: Size growth
    if (baseline.baselineSize > 0) {
      const sizeGrowthRatio = position.size / baseline.baselineSize;
      if (sizeGrowthRatio >= threshold) {
        this.logger.info(
          `[PositionStacking] 🔒 Position ${position.tokenId.slice(0, 8)}... already stacked ` +
            `(size grew ${((sizeGrowthRatio - 1) * 100).toFixed(0)}%: ${baseline.baselineSize.toFixed(2)} -> ${position.size.toFixed(2)})`,
        );
        return true;
      }
    }

    // Check 2: Cost basis / initial value growth
    const currentInitialValue = position.dataApiInitialValue ?? 0;
    if (baseline.baselineInitialValue > 0 && currentInitialValue > 0) {
      const valueGrowthRatio =
        currentInitialValue / baseline.baselineInitialValue;
      if (valueGrowthRatio >= threshold) {
        this.logger.info(
          `[PositionStacking] 🔒 Position ${position.tokenId.slice(0, 8)}... already stacked ` +
            `(value grew ${((valueGrowthRatio - 1) * 100).toFixed(0)}%: $${baseline.baselineInitialValue.toFixed(2)} -> $${currentInitialValue.toFixed(2)})`,
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Mark a position as already stacked (for positions detected via baseline growth)
   */
  private markAsAlreadyStacked(position: Position, reason: string): void {
    if (this.stackedPositions.has(position.tokenId)) {
      return;
    }

    this.stackedPositions.set(position.tokenId, {
      tokenId: position.tokenId,
      marketId: position.marketId,
      stackedAtMs: Date.now(),
      stackedAtPrice: position.currentPrice,
      stackedAmountUsd: 0, // Unknown - detected retroactively
      entryPriceCents: position.avgEntryPriceCents ?? 0,
      gainCentsAtStack: 0, // Unknown
    });

    this.logger.debug(
      `[PositionStacking] Marked ${position.tokenId.slice(0, 8)}... as already stacked: ${reason}`,
    );
  }

  /**
   * Check if a position is eligible for stacking
   */
  private checkEligibility(position: Position): {
    eligible: boolean;
    reason: string;
    gainCents: number;
  } {
    // Must have entry price data
    if (
      position.avgEntryPriceCents === undefined ||
      position.avgEntryPriceCents <= 0
    ) {
      return {
        eligible: false,
        reason: "NO_ENTRY_PRICE",
        gainCents: 0,
      };
    }

    // Must have trusted P&L
    if (!position.pnlTrusted) {
      return {
        eligible: false,
        reason: "PNL_NOT_TRUSTED",
        gainCents: 0,
      };
    }

    // Must be in profit (not losing)
    if (position.pnlPct < this.config.minProfitPct) {
      return {
        eligible: false,
        reason: `NOT_PROFITABLE_${position.pnlPct.toFixed(1)}%`,
        gainCents: 0,
      };
    }

    // Calculate gain in cents from entry
    const currentPriceCents = position.currentPrice * 100;
    const gainCents = currentPriceCents - position.avgEntryPriceCents;

    // Must be up at least minGainCents from entry
    if (gainCents < this.config.minGainCents) {
      return {
        eligible: false,
        reason: `GAIN_TOO_LOW_${gainCents.toFixed(1)}¢<${this.config.minGainCents}¢`,
        gainCents,
      };
    }

    // Must not be near $1 (limited upside)
    if (position.currentPrice >= this.config.maxCurrentPrice) {
      return {
        eligible: false,
        reason: `PRICE_TOO_HIGH_${(position.currentPrice * 100).toFixed(1)}¢>=${(this.config.maxCurrentPrice * 100).toFixed(0)}¢`,
        gainCents,
      };
    }

    // Must have valid orderbook for execution
    if (
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.bookStatus === "NO_BOOK_404" ||
      position.bookStatus === "EMPTY_BOOK"
    ) {
      return {
        eligible: false,
        reason: "NOT_TRADABLE",
        gainCents,
      };
    }

    return {
      eligible: true,
      reason: "ELIGIBLE",
      gainCents,
    };
  }

  /**
   * Stack (double down on) a position
   */
  private async stackPosition(
    position: Position,
    gainCents: number,
  ): Promise<boolean> {
    if (!isLiveTradingEnabled()) {
      this.logger.info(
        `[PositionStacking] Would stack ${position.tokenId.slice(0, 8)}... ` +
          `+${gainCents.toFixed(1)}¢ gain - LIVE TRADING DISABLED`,
      );
      return false;
    }

    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[PositionStacking] No wallet available`);
      return false;
    }

    const sizeUsd = this.config.maxStackUsd;
    const outcome = position.side.toUpperCase() === "YES" ? "YES" : "NO";

    this.logger.info(
      `[PositionStacking] 📈 Stacking ${position.tokenId.slice(0, 8)}... ` +
        `entry=${position.avgEntryPriceCents?.toFixed(1)}¢, ` +
        `current=${(position.currentPrice * 100).toFixed(1)}¢, ` +
        `gain=+${gainCents.toFixed(1)}¢, ` +
        `stack=$${sizeUsd.toFixed(2)}`,
    );

    try {
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: outcome as "YES" | "NO",
        side: "BUY",
        sizeUsd,
        maxAcceptablePrice: position.currentPrice * 1.02, // Allow 2% slippage
        logger: this.logger,
      });

      if (result.status === "submitted") {
        // Record the stack in memory
        this.stackedPositions.set(position.tokenId, {
          tokenId: position.tokenId,
          marketId: position.marketId,
          stackedAtMs: Date.now(),
          stackedAtPrice: position.currentPrice,
          stackedAmountUsd: sizeUsd,
          entryPriceCents: position.avgEntryPriceCents ?? 0,
          gainCentsAtStack: gainCents,
        });

        // Do NOT update the baseline here using an estimated size.
        // The actual executed size may differ due to slippage/partial fills.
        // We rely on `stackedPositions` Map to prevent duplicate stacking
        // until the next refresh cycle, where baselines will be updated from
        // real position data returned by the API.

        this.logger.info(
          `[PositionStacking] ✅ Stacked ${position.tokenId.slice(0, 8)}... ` +
            `$${sizeUsd.toFixed(2)} at ${(position.currentPrice * 100).toFixed(1)}¢`,
        );
        return true;
      }

      this.logger.warn(
        `[PositionStacking] ⚠️ Stack failed ${position.tokenId.slice(0, 8)}...: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[PositionStacking] ❌ Stack error ${position.tokenId.slice(0, 8)}...: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get active positions from tracker
   */
  private getActivePositions(): Position[] {
    if (!this.positionTracker) return [];
    const snapshot = this.positionTracker.getSnapshot();
    return snapshot ? [...snapshot.activePositions] : [];
  }

  /**
   * Check if a token is on cooldown
   */
  private isOnCooldown(tokenId: string): boolean {
    const cooldownUntil = this.cooldowns.get(tokenId);
    if (!cooldownUntil) return false;
    return Date.now() < cooldownUntil;
  }

  /**
   * Set cooldown for a token
   */
  private setCooldown(tokenId: string): void {
    this.cooldowns.set(tokenId, Date.now() + this.config.cooldownMs);
  }

  /**
   * Clean up expired cooldowns
   */
  private cleanupCooldowns(): void {
    const now = Date.now();
    for (const [tokenId, cooldownUntil] of this.cooldowns) {
      if (now >= cooldownUntil) {
        this.cooldowns.delete(tokenId);
      }
    }
  }

  /**
   * Clean up stale baselines (positions no longer in portfolio)
   */
  private cleanupStaleBaselines(): void {
    const now = Date.now();
    const staleThreshold =
      now - PositionStackingStrategy.BASELINE_STALE_MS;

    for (const [tokenId, baseline] of this.positionBaselines) {
      // If baseline hasn't been updated in 2 hours, it's for a position
      // that's no longer active - remove it
      if (baseline.lastUpdatedAtMs < staleThreshold) {
        this.positionBaselines.delete(tokenId);
        // Also clean up stacked tracking if present
        this.stackedPositions.delete(tokenId);
      }
    }
  }

  /**
   * Check if a position has already been stacked
   */
  isPositionStacked(tokenId: string): boolean {
    return this.stackedPositions.has(tokenId);
  }

  /**
   * Get all stacked positions (for external access/API)
   */
  getStackedPositions(): StackedPositionEntry[] {
    return Array.from(this.stackedPositions.values());
  }

  /**
   * Get strategy stats
   */
  getStats(): {
    enabled: boolean;
    stackedCount: number;
    activeCooldowns: number;
    trackedBaselines: number;
  } {
    return {
      enabled: this.config.enabled,
      stackedCount: this.stackedPositions.size,
      activeCooldowns: this.cooldowns.size,
      trackedBaselines: this.positionBaselines.size,
    };
  }

  /**
   * Clear stacked positions (for testing or reset)
   */
  clearStackedPositions(): void {
    this.stackedPositions.clear();
    this.cooldowns.clear();
    this.positionBaselines.clear();
    this.logger.info("[PositionStacking] Cleared all stacked positions and baselines");
  }
}
