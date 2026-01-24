/**
 * Sell Early Strategy
 *
 * Capital efficiency rule: Sell positions at ~99.9¢ instead of waiting for slow redemption.
 *
 * PROBLEM:
 * - Redemption is slow and capital gets trapped in near-100¢ positions.
 * - We want to "take the money and run" at 99.9¢ (or configurable) rather than wait for 100¢ redemption.
 *
 * RULES:
 * 1. Only apply to ACTIVE positions (state=ACTIVE, NOT redeemable=true).
 * 2. NEVER apply to REDEEMABLE/RESOLVED positions (orderbook may be gone) - those go to AutoRedeem.
 * 3. Use executable price (bestBid) from orderbook, not mid-price.
 * 4. Verify: bestBidCents >= SELL_EARLY_BID_CENTS, spread <= max, liquidity >= min.
 * 5. If book missing/404/empty, do not attempt; fall back to normal lifecycle (redeem later).
 *
 * EXECUTION ORDER:
 * This strategy runs BEFORE AutoRedeem each cycle:
 * 1. Position refresh
 * 2. SellEarlyStrategy (ACTIVE near-100 exit)  <-- This module
 * 3. AutoRedeem (REDEEMABLE only)
 * 4. Other strategies
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";
import { LogDeduper, SKIP_LOG_TTL_MS } from "../utils/log-deduper.util";

/**
 * Sell Early Configuration
 */
export interface SellEarlyConfig {
  /** Enable sell-early strategy */
  enabled: boolean;
  /** Minimum bid price in cents to trigger sell (e.g., 99.9 = 99.9¢) */
  bidCents: number;
  /** Minimum liquidity in USD at/near best bid */
  minLiquidityUsd: number;
  /** Maximum spread in cents allowed */
  maxSpreadCents: number;
  /** Minimum time (seconds) to hold before sell-early can trigger */
  minHoldSec: number;
}

/**
 * Default configuration
 */
export const DEFAULT_SELL_EARLY_CONFIG: SellEarlyConfig = {
  enabled: true,
  bidCents: 99.9,
  minLiquidityUsd: 50,
  maxSpreadCents: 0.3,
  minHoldSec: 60,
};

/**
 * Skip reason counters for aggregated logging
 */
interface SkipReasons {
  notActive: number;
  redeemable: number;
  belowThreshold: number;
  noBook: number;
  noBid: number;
  illiquid: number;
  spreadWide: number;
  holdTime: number;
  cooldown: number;
  untrustedPnl: number;
}

/**
 * Sell Early Strategy Options
 */
export interface SellEarlyStrategyOptions {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: SellEarlyConfig;
}

/**
 * Sell Early Strategy
 *
 * Automatically sells ACTIVE positions at near-$1 prices to free capital
 * instead of waiting for slow redemption.
 */
export class SellEarlyStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: SellEarlyConfig;

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === COOLDOWN TRACKING ===
  // Prevents spam-selling the same token repeatedly
  private sellCooldowns = new Map<string, number>(); // tokenId -> timestamp of last attempt
  private static readonly COOLDOWN_MS = 60_000; // 60 seconds between attempts per token

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();
  private lastSkipSummaryFingerprint = "";

  // === CONSTANTS ===
  // Convert cents to decimal price (e.g., 99.9¢ -> 0.999)
  private static readonly CENTS_TO_DECIMAL = 100;
  // Tolerance for depth calculation (within 0.1¢ of best bid)
  private static readonly DEPTH_TOLERANCE_CENTS = 0.1;

  constructor(options: SellEarlyStrategyOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.positionTracker = options.positionTracker;
    this.config = options.config;

    if (this.config.enabled) {
      this.logger.info(
        `[SellEarly] Initialized: bidThreshold=${this.config.bidCents}¢, ` +
          `minLiquidity=$${this.config.minLiquidityUsd}, ` +
          `maxSpread=${this.config.maxSpreadCents}¢, ` +
          `minHold=${this.config.minHoldSec}s`,
      );
    }
  }

  /**
   * Execute the sell-early check cycle
   * Called by the orchestrator BEFORE AutoRedeem
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   *
   * @returns The number of successful sells
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[SellEarly] Skipped - already in flight");
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
   * Internal execution logic
   */
  private async executeInternal(): Promise<number> {
    // Get positions enriched with entry metadata for accurate hold time
    const positions = await this.positionTracker.enrichPositionsWithEntryMeta();
    const now = Date.now();
    let soldCount = 0;

    // Track skip reasons for aggregated logging
    const skipReasons: SkipReasons = {
      notActive: 0,
      redeemable: 0,
      belowThreshold: 0,
      noBook: 0,
      noBid: 0,
      illiquid: 0,
      spreadWide: 0,
      holdTime: 0,
      cooldown: 0,
      untrustedPnl: 0,
    };

    // Process each position
    for (const position of positions) {
      const result = await this.evaluateAndSell(position, now, skipReasons);
      if (result) {
        soldCount++;
      }
    }

    // Log aggregated skip summary (rate-limited)
    this.logSkipSummary(skipReasons);

    // Clean up old cooldowns
    this.cleanupCooldowns(now);

    return soldCount;
  }

  /**
   * Evaluate a position for sell-early and execute if criteria met
   *
   * @returns true if position was sold
   */
  private async evaluateAndSell(
    position: Position,
    now: number,
    skipReasons: SkipReasons,
  ): Promise<boolean> {
    const tokenIdShort = position.tokenId.slice(0, 12);

    // === STATE GATE: Only ACTIVE positions ===
    // NEVER sell REDEEMABLE positions - their orderbooks may be dead
    if (position.redeemable === true) {
      skipReasons.redeemable++;
      return false;
    }

    // Check position state if available
    if (position.positionState && position.positionState !== "ACTIVE") {
      if (
        position.positionState === "REDEEMABLE" ||
        position.positionState === "CLOSED_NOT_REDEEMABLE"
      ) {
        skipReasons.redeemable++;
      } else {
        skipReasons.notActive++;
      }
      return false;
    }

    // Check status field
    if (position.status === "REDEEMABLE" || position.status === "RESOLVED") {
      skipReasons.redeemable++;
      return false;
    }

    // === P&L TRUST CHECK ===
    // Skip positions with untrusted P&L (may indicate book issues)
    if (!position.pnlTrusted) {
      skipReasons.untrustedPnl++;
      return false;
    }

    // === NO_BOOK CHECK ===
    if (position.status === "NO_BOOK") {
      skipReasons.noBook++;
      return false;
    }

    // === COOLDOWN CHECK ===
    const lastAttempt = this.sellCooldowns.get(position.tokenId);
    if (lastAttempt && now - lastAttempt < SellEarlyStrategy.COOLDOWN_MS) {
      skipReasons.cooldown++;
      return false;
    }

    // === BID PRICE CHECK ===
    if (position.currentBidPrice === undefined) {
      skipReasons.noBid++;
      return false;
    }

    const bidCents = position.currentBidPrice * SellEarlyStrategy.CENTS_TO_DECIMAL;
    if (bidCents < this.config.bidCents) {
      skipReasons.belowThreshold++;
      return false;
    }

    // === ASK PRICE CHECK (for spread calculation) ===
    if (position.currentAskPrice === undefined) {
      skipReasons.noBook++;
      return false;
    }

    // === SPREAD CHECK ===
    const askCents = position.currentAskPrice * SellEarlyStrategy.CENTS_TO_DECIMAL;
    const spreadCents = askCents - bidCents;
    if (spreadCents > this.config.maxSpreadCents) {
      skipReasons.spreadWide++;
      return false;
    }

    // === LIQUIDITY CHECK ===
    // Get orderbook to check depth at best bid
    const liquidityUsd = await this.getBidLiquidity(position.tokenId, bidCents);
    if (liquidityUsd === null || liquidityUsd < this.config.minLiquidityUsd) {
      skipReasons.illiquid++;
      return false;
    }

    // === HOLD TIME CHECK ===
    const holdSec = position.timeHeldSec ?? 0;
    if (holdSec < this.config.minHoldSec) {
      skipReasons.holdTime++;
      return false;
    }

    // === ALL CHECKS PASSED - EXECUTE SELL ===
    const positionValue = position.size * position.currentBidPrice;

    this.logger.info(
      `[SellEarly] 💰 SELLING ${tokenIdShort}... shares=${position.size.toFixed(2)} ` +
        `bid=${bidCents.toFixed(1)}¢ value=$${positionValue.toFixed(2)} ` +
        `reason=CAPITAL_FREE (held ${Math.round(holdSec / 60)}min, liquidity=$${liquidityUsd.toFixed(0)})`,
    );

    // Record attempt (for cooldown)
    this.sellCooldowns.set(position.tokenId, now);

    // Execute the sell
    const sold = await this.sellPosition(position);
    if (sold) {
      this.logger.info(
        `[SellEarly] ✅ SOLD tokenId=${tokenIdShort}... shares=${position.size.toFixed(2)} ` +
          `bid=${bidCents.toFixed(1)}¢ value=$${positionValue.toFixed(2)} reason=CAPITAL_FREE`,
      );
      return true;
    }

    return false;
  }

  /**
   * Get liquidity in USD at or near the best bid price
   */
  private async getBidLiquidity(
    tokenId: string,
    bestBidCents: number,
  ): Promise<number | null> {
    try {
      const orderBook = await this.client.getOrderBook(tokenId);
      if (!orderBook?.bids || orderBook.bids.length === 0) {
        return null;
      }

      // Sum up liquidity at bids within tolerance of best bid
      const toleranceDecimal =
        SellEarlyStrategy.DEPTH_TOLERANCE_CENTS / SellEarlyStrategy.CENTS_TO_DECIMAL;
      const bestBidDecimal = bestBidCents / SellEarlyStrategy.CENTS_TO_DECIMAL;
      const minPriceDecimal = bestBidDecimal - toleranceDecimal;

      let totalUsd = 0;
      for (const bid of orderBook.bids) {
        const price = parseFloat(bid.price);
        if (price >= minPriceDecimal) {
          const size = parseFloat(bid.size);
          totalUsd += size * price;
        }
      }

      return totalUsd;
    } catch {
      return null;
    }
  }

  /**
   * Execute a sell order for the position
   */
  private async sellPosition(position: Position): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error("[SellEarly] No wallet available");
      return false;
    }

    // Validate bid price is available (should already be checked by evaluateAndSell)
    if (position.currentBidPrice === undefined) {
      this.logger.error("[SellEarly] No bid price available for sell");
      return false;
    }

    // Validate side is defined
    const outcome = position.side?.toUpperCase();
    if (outcome !== "YES" && outcome !== "NO") {
      this.logger.error(`[SellEarly] Invalid or missing position side: ${position.side}`);
      return false;
    }

    try {
      // Calculate size in USD at the current bid price (already validated above)
      const sizeUsd = position.size * position.currentBidPrice;

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: outcome as "YES" | "NO", // Already validated above
        side: "SELL",
        sizeUsd,
        logger: this.logger,
        skipDuplicatePrevention: true, // This is an intentional liquidation
        skipMinOrderSizeCheck: true, // Sell whatever we have
      });

      if (result.status === "submitted") {
        // Invalidate orderbook cache for this token
        this.positionTracker.invalidateOrderbookCache(position.tokenId);
        return true;
      }

      this.logger.warn(
        `[SellEarly] ⚠️ Sell not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[SellEarly] ❌ Sell failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Log aggregated skip summary (rate-limited)
   */
  private logSkipSummary(reasons: SkipReasons): void {
    const total =
      reasons.notActive +
      reasons.redeemable +
      reasons.belowThreshold +
      reasons.noBook +
      reasons.noBid +
      reasons.illiquid +
      reasons.spreadWide +
      reasons.holdTime +
      reasons.cooldown +
      reasons.untrustedPnl;

    if (total === 0) {
      return;
    }

    // Create fingerprint for change detection
    const fingerprint = `${reasons.redeemable},${reasons.belowThreshold},${reasons.noBook},${reasons.illiquid},${reasons.spreadWide}`;

    // Log only if fingerprint changed or TTL expired
    if (this.logDeduper.shouldLog("SellEarly:skip_summary", SKIP_LOG_TTL_MS, fingerprint)) {
      const parts: string[] = [];
      if (reasons.redeemable > 0) parts.push(`redeemable=${reasons.redeemable}`);
      if (reasons.belowThreshold > 0) parts.push(`below_threshold=${reasons.belowThreshold}`);
      if (reasons.noBook > 0) parts.push(`no_book=${reasons.noBook}`);
      if (reasons.noBid > 0) parts.push(`no_bid=${reasons.noBid}`);
      if (reasons.illiquid > 0) parts.push(`illiquid=${reasons.illiquid}`);
      if (reasons.spreadWide > 0) parts.push(`spread_wide=${reasons.spreadWide}`);
      if (reasons.holdTime > 0) parts.push(`hold_time=${reasons.holdTime}`);
      if (reasons.cooldown > 0) parts.push(`cooldown=${reasons.cooldown}`);
      if (reasons.notActive > 0) parts.push(`not_active=${reasons.notActive}`);
      if (reasons.untrustedPnl > 0) parts.push(`untrusted_pnl=${reasons.untrustedPnl}`);

      this.logger.debug(
        `[SellEarly] Skipped: ${parts.join(", ")}`,
      );
    }
  }

  /**
   * Clean up old cooldown entries to prevent memory leaks
   */
  private cleanupCooldowns(now: number): void {
    const expiredBefore = now - SellEarlyStrategy.COOLDOWN_MS * 2;
    for (const [tokenId, timestamp] of this.sellCooldowns) {
      if (timestamp < expiredBefore) {
        this.sellCooldowns.delete(tokenId);
      }
    }
  }
}
