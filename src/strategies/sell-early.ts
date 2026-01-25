/**
 * Sell Early Strategy (Simplified - Jan 2025)
 *
 * ONE CORE BEHAVIOR: If a position I hold is tradable and the best bid is at/above 99.9¢, SELL IT (full size) to free capital.
 *
 * PRIMARY GOAL:
 * - "Take the money and run" at 99.9¢ across the board.
 * - Avoid tying up capital waiting for redemption.
 * - Keep logic minimal, deterministic, and hard to misconfigure.
 *
 * ALGORITHM:
 * 1. Input: PortfolioSnapshot from PositionTracker (same cycle), containing ACTIVE positions with tokenId, marketId, shares.
 * 2. For each ACTIVE position:
 *    - Fetch bestBidCents for tokenId (orderbook or price endpoint).
 *    - If bestBidCents >= 99.9: submit SELL for full shares at limitPrice=99.9 (or bestBid rounded down to 99.9)
 *    - else: skip
 * 3. Do NOT attempt SellEarly for REDEEMABLE/RESOLVED positions. Those go to AutoRedeem.
 * 4. If orderbook missing / 404 / no bids: Skip quietly with reason NO_BID (rate-limited). Do NOT invent additional rules.
 * 5. Must not depend on profit calculations. It is purely a price trigger.
 *
 * OPTIONAL GATES (OFF by default unless explicitly enabled via env vars):
 * - SELL_EARLY_MIN_LIQUIDITY_USD: If set > 0, check liquidity
 * - SELL_EARLY_MAX_SPREAD_CENTS: If set > 0, check spread
 * - SELL_EARLY_MIN_HOLD_SEC: If set > 0, check hold time
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";
import {
  LogDeduper,
  SKIP_LOG_TTL_MS,
  HIGH_VALUE_PRICE_THRESHOLD,
  HIGH_VALUE_NO_BID_LOG_TTL_MS,
} from "../utils/log-deduper.util";

/**
 * Sell Early Configuration
 *
 * NEW DEFAULTS (Simplified):
 * - enabled: true
 * - bidCents: 99.9
 * - All other gating is OFF (0 = disabled) unless explicitly enabled
 */
export interface SellEarlyConfig {
  /** Enable sell-early strategy */
  enabled: boolean;
  /** Minimum bid price in cents to trigger sell (e.g., 99.9 = 99.9¢) */
  bidCents: number;
  /** Minimum liquidity in USD at/near best bid. Set to 0 to DISABLE (default). */
  minLiquidityUsd: number;
  /** Maximum spread in cents allowed. Set to 0 to DISABLE (default). */
  maxSpreadCents: number;
  /** Minimum time (seconds) to hold before sell-early can trigger. Set to 0 to DISABLE (default). */
  minHoldSec: number;
}

/**
 * Default configuration - MINIMAL: only threshold at 99.9¢
 * All optional gating is OFF (0 = disabled)
 */
export const DEFAULT_SELL_EARLY_CONFIG: SellEarlyConfig = {
  enabled: true,
  bidCents: 99.9,
  minLiquidityUsd: 0, // DISABLED by default
  maxSpreadCents: 0, // DISABLED by default
  minHoldSec: 0, // DISABLED by default
};

/**
 * Skip reason enum for clear categorization
 */
export type SkipReason =
  | "REDEEMABLE"
  | "NO_BID"
  | "BELOW_THRESHOLD"
  | "BAD_MARKET_ID"
  | "MIN_ORDER_SIZE"
  | "POSTORDER_FAILED"
  | "ILLIQUID"
  | "SPREAD_WIDE"
  | "HOLD_TIME";

/**
 * Skip reason counters for aggregated logging
 */
interface SkipReasons {
  redeemable: number;
  noBid: number;
  belowThreshold: number;
  badMarketId: number;
  minOrderSize: number;
  postorderFailed: number;
  // Optional gates (only used if enabled)
  illiquid: number;
  spreadWide: number;
  holdTime: number;
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
 * Sell Early Strategy (Simplified)
 *
 * ONE CORE BEHAVIOR: Sell positions at 99.9¢ to free capital.
 * No profiles, no extra knobs, no churny constraints by default.
 */
export class SellEarlyStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: SellEarlyConfig;

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();

  // === RATE-LIMITED SKIP LOGGING ===
  // Tracks last log time per skip reason to avoid spam
  private skipLogTimestamps = new Map<string, number>();
  private static readonly SKIP_LOG_COOLDOWN_MS = 60_000; // 60s between logs per reason

  // === MIN ORDER SIZE TRACKING ===
  // Track tokens that fail min order size to avoid repeated logs
  private minOrderSizeFailures = new Map<string, number>(); // tokenId -> timestamp
  private static readonly MIN_ORDER_LOG_TTL_MS = 300_000; // 5 minutes

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
      // Log initialization with simplified config
      const optionalGates: string[] = [];
      if (this.config.minLiquidityUsd > 0) {
        optionalGates.push(`minLiquidity=$${this.config.minLiquidityUsd}`);
      }
      if (this.config.maxSpreadCents > 0) {
        optionalGates.push(`maxSpread=${this.config.maxSpreadCents}¢`);
      }
      if (this.config.minHoldSec > 0) {
        optionalGates.push(`minHold=${this.config.minHoldSec}s`);
      }

      const gateInfo =
        optionalGates.length > 0
          ? ` (optional: ${optionalGates.join(", ")})`
          : "";
      this.logger.info(
        `[SellEarly] Initialized: threshold=${this.config.bidCents}¢${gateInfo}`,
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
   * Internal execution logic (simplified)
   */
  private async executeInternal(): Promise<number> {
    // Get positions - we just need the basic position data
    const positions = await this.positionTracker.enrichPositionsWithEntryMeta();
    let soldCount = 0;
    let eligibleCount = 0;

    // Track skip reasons for aggregated logging
    const skipReasons: SkipReasons = {
      redeemable: 0,
      noBid: 0,
      belowThreshold: 0,
      badMarketId: 0,
      minOrderSize: 0,
      postorderFailed: 0,
      illiquid: 0,
      spreadWide: 0,
      holdTime: 0,
    };

    // Filter to ACTIVE positions only
    const activePositions = positions.filter((p) => this.isActivePosition(p));

    // Process each position
    for (const position of activePositions) {
      const result = await this.evaluateAndSell(position, skipReasons);
      if (result === "SOLD") {
        soldCount++;
        eligibleCount++;
      } else if (result === "ELIGIBLE_NOT_SOLD") {
        eligibleCount++;
      }
    }

    // Log once-per-cycle summary
    const skippedNoBid = skipReasons.noBid;
    this.logger.info(
      `[SellEarly] scanned=${activePositions.length} active, eligible=${eligibleCount}, sold=${soldCount}, skipped_no_bid=${skippedNoBid}`,
    );

    // Log aggregated skip summary (rate-limited DEBUG)
    this.logSkipSummary(skipReasons);

    // Clean up old min order size failure entries
    this.cleanupMinOrderSizeCache();

    return soldCount;
  }

  /**
   * Check if position is ACTIVE (not redeemable/resolved)
   *
   * IMPORTANT (Jan 2025): Only skip REDEEMABLE if there's actual proof from
   * on-chain (ONCHAIN_DENOM) or Data API (DATA_API_FLAG). Internal flags without
   * proof should NOT block selling - this ensures we can exit positions that
   * might be incorrectly flagged as redeemable internally.
   */
  private isActivePosition(position: Position): boolean {
    // Only skip if there's actual proof of redeemability (on-chain or API)
    const hasRedeemableProof =
      position.redeemableProofSource === "ONCHAIN_DENOM" ||
      position.redeemableProofSource === "DATA_API_FLAG";

    if (hasRedeemableProof) {
      return false;
    }

    return true;
  }

  /**
   * Evaluate a position for sell-early and execute if criteria met
   *
   * @returns "SOLD" if sold, "ELIGIBLE_NOT_SOLD" if eligible but failed to sell, null if not eligible
   */
  private async evaluateAndSell(
    position: Position,
    skipReasons: SkipReasons,
  ): Promise<"SOLD" | "ELIGIBLE_NOT_SOLD" | null> {
    const tokenIdShort = position.tokenId.slice(0, 12);

    // === REDEEMABLE CHECK (only skip if there's actual proof) ===
    // Trust on-chain resolution (ONCHAIN_DENOM) or explicit API flag (DATA_API_FLAG)
    // Don't skip if redeemable=true but proofSource is NONE (internal heuristic only)
    const hasRedeemableProof =
      position.redeemableProofSource === "ONCHAIN_DENOM" ||
      position.redeemableProofSource === "DATA_API_FLAG";

    if (hasRedeemableProof) {
      skipReasons.redeemable++;
      return null;
    }

    // Build diagnostic info for logging: currentPrice, currentBidPrice, executionStatus in one line
    const currentPriceCents = (position.currentPrice * 100).toFixed(1);
    const bidPriceCents =
      position.currentBidPrice !== undefined
        ? (position.currentBidPrice * 100).toFixed(1)
        : "N/A";
    const execStatus = position.executionStatus ?? "unknown";
    const diagInfo = `currentPrice=${currentPriceCents}¢ currentBidPrice=${bidPriceCents}¢ executionStatus=${execStatus}`;

    // === EXECUTION STATUS CHECK (Jan 2025 - Handle NOT_TRADABLE_ON_CLOB) ===
    // If position has executionStatus set, use it to skip non-tradable positions.
    // This handles orderbook 404, empty book, and other CLOB unavailability scenarios.
    if (
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED"
    ) {
      skipReasons.noBid++;
      this.logSkipOnce(
        "NOT_TRADABLE",
        `[SellEarly] skip tokenId=${tokenIdShort}... reason=NOT_TRADABLE ${diagInfo} bookStatus=${position.bookStatus ?? "unknown"}`,
      );
      return null;
    }

    // === BID PRICE CHECK ===
    if (position.currentBidPrice === undefined) {
      skipReasons.noBid++;
      // For high-value positions (>= HIGH_VALUE_PRICE_THRESHOLD), log at INFO level
      // since this represents potentially stuck capital that users need to know about
      const isHighValue =
        position.currentPrice >= HIGH_VALUE_PRICE_THRESHOLD;
      const bookStatusInfo = position.bookStatus ?? "UNKNOWN";
      const noBidMessage =
        `[SellEarly] ⚠️ NO_BID: tokenId=${tokenIdShort}... ${diagInfo} bookStatus=${bookStatusInfo}` +
        (isHighValue
          ? ` — Position at ${currentPriceCents}¢ cannot be sold via CLOB (no orderbook bids). ` +
            `Check if market is in dispute window or orderbook is temporarily unavailable.`
          : ``);

      if (isHighValue) {
        // Log at INFO for high-value positions so users see why their capital is stuck
        // Rate-limited with shorter TTL to ensure visibility while avoiding spam
        const now = Date.now();
        const lastLog =
          this.skipLogTimestamps.get(`NO_BID_HIGH_VALUE:${tokenIdShort}`) ?? 0;
        if (now - lastLog >= HIGH_VALUE_NO_BID_LOG_TTL_MS) {
          this.logger.info(noBidMessage);
          this.skipLogTimestamps.set(`NO_BID_HIGH_VALUE:${tokenIdShort}`, now);
        }
      } else {
        this.logSkipOnce("NO_BID", noBidMessage);
      }
      return null;
    }

    const bidCents =
      position.currentBidPrice * SellEarlyStrategy.CENTS_TO_DECIMAL;
    if (bidCents < this.config.bidCents) {
      skipReasons.belowThreshold++;
      // Log BELOW_THRESHOLD with diagnostic info (rate-limited)
      this.logSkipOnce(
        `BELOW_THRESHOLD:${tokenIdShort}`,
        `[SellEarly] skip tokenId=${tokenIdShort}... reason=BELOW_THRESHOLD ${diagInfo} threshold=${this.config.bidCents}¢`,
      );
      return null;
    }

    // === OPTIONAL: SPREAD CHECK (only if maxSpreadCents > 0) ===
    if (this.config.maxSpreadCents > 0) {
      if (position.currentAskPrice === undefined) {
        skipReasons.noBid++;
        this.logSkipOnce(
          "NO_BID",
          `[SellEarly] skip tokenId=${tokenIdShort}... reason=NO_BID (no ask)`,
        );
        return null;
      }
      const askCents =
        position.currentAskPrice * SellEarlyStrategy.CENTS_TO_DECIMAL;
      const spreadCents = askCents - bidCents;
      if (spreadCents > this.config.maxSpreadCents) {
        skipReasons.spreadWide++;
        this.logSkipOnce(
          "SPREAD_WIDE",
          `[SellEarly] skip tokenId=${tokenIdShort}... reason=SPREAD_WIDE spread=${spreadCents.toFixed(2)}¢`,
        );
        return null;
      }
    }

    // === OPTIONAL: LIQUIDITY CHECK (only if minLiquidityUsd > 0) ===
    if (this.config.minLiquidityUsd > 0) {
      const liquidityUsd = await this.getBidLiquidity(
        position.tokenId,
        bidCents,
      );
      if (liquidityUsd === null || liquidityUsd < this.config.minLiquidityUsd) {
        skipReasons.illiquid++;
        this.logSkipOnce(
          "ILLIQUID",
          `[SellEarly] skip tokenId=${tokenIdShort}... reason=ILLIQUID liquidity=$${liquidityUsd?.toFixed(0) ?? 0}`,
        );
        return null;
      }
    }

    // === OPTIONAL: HOLD TIME CHECK (only if minHoldSec > 0) ===
    if (this.config.minHoldSec > 0) {
      const holdSec = position.timeHeldSec ?? 0;
      if (holdSec < this.config.minHoldSec) {
        skipReasons.holdTime++;
        this.logSkipOnce(
          "HOLD_TIME",
          `[SellEarly] skip tokenId=${tokenIdShort}... reason=HOLD_TIME held=${holdSec}s`,
        );
        return null;
      }
    }

    // === MARKET ID VALIDATION ===
    if (
      !position.marketId ||
      position.marketId === "unknown" ||
      position.marketId === ""
    ) {
      skipReasons.badMarketId++;
      this.logger.error(
        `[SellEarly] ERROR: Bad marketId for tokenId=${tokenIdShort}... marketId="${position.marketId}"`,
      );
      return null;
    }

    // === ALL CHECKS PASSED - EXECUTE SELL ===
    const proceeds = position.size * position.currentBidPrice;

    // Execute the sell
    const sold = await this.sellPosition(position, skipReasons);
    if (sold) {
      this.logger.info(
        `[SellEarly] SOLD tokenId=${tokenIdShort}... shares=${position.size.toFixed(2)} bid=${bidCents.toFixed(1)}¢ proceeds≈$${proceeds.toFixed(2)}`,
      );
      return "SOLD";
    }

    return "ELIGIBLE_NOT_SOLD";
  }

  /**
   * Get liquidity in USD at or near the best bid price
   * Only called if minLiquidityUsd > 0 (optional gate enabled)
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
        SellEarlyStrategy.DEPTH_TOLERANCE_CENTS /
        SellEarlyStrategy.CENTS_TO_DECIMAL;
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
  private async sellPosition(
    position: Position,
    skipReasons: SkipReasons,
  ): Promise<boolean> {
    const tokenIdShort = position.tokenId.slice(0, 12);
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error("[SellEarly] No wallet available");
      skipReasons.postorderFailed++;
      return false;
    }

    // Validate bid price is available (should already be checked by evaluateAndSell)
    if (position.currentBidPrice === undefined) {
      this.logger.error("[SellEarly] No bid price available for sell");
      skipReasons.postorderFailed++;
      return false;
    }

    // Validate side is defined
    const outcome = position.side?.toUpperCase();
    if (outcome !== "YES" && outcome !== "NO") {
      this.logger.error(
        `[SellEarly] ERROR: Invalid or missing position side: ${position.side} tokenId=${tokenIdShort}...`,
      );
      skipReasons.badMarketId++;
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

      // Check for min order size failure
      if (result.reason?.includes("min") || result.reason?.includes("size")) {
        this.logMinOrderSizeFailure(
          position.tokenId,
          result.reason ?? "MIN_ORDER_SIZE",
        );
        skipReasons.minOrderSize++;
        return false;
      }

      this.logSkipOnce(
        "POSTORDER_FAILED",
        `[SellEarly] skip tokenId=${tokenIdShort}... reason=POSTORDER_FAILED: ${result.reason ?? "unknown"}`,
      );
      skipReasons.postorderFailed++;
      return false;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logSkipOnce(
        "POSTORDER_FAILED",
        `[SellEarly] skip tokenId=${tokenIdShort}... reason=POSTORDER_FAILED: ${errMsg}`,
      );
      skipReasons.postorderFailed++;
      return false;
    }
  }

  /**
   * Log skip reason once per TTL (rate-limited DEBUG)
   */
  private logSkipOnce(reason: string, message: string): void {
    const now = Date.now();
    const lastLog = this.skipLogTimestamps.get(reason) ?? 0;
    if (now - lastLog >= SellEarlyStrategy.SKIP_LOG_COOLDOWN_MS) {
      this.logger.debug(message);
      this.skipLogTimestamps.set(reason, now);
    }
  }

  /**
   * Log min order size failure once per TTL per token
   */
  private logMinOrderSizeFailure(tokenId: string, reason: string): void {
    const now = Date.now();
    const lastLog = this.minOrderSizeFailures.get(tokenId) ?? 0;
    if (now - lastLog >= SellEarlyStrategy.MIN_ORDER_LOG_TTL_MS) {
      this.logger.debug(
        `[SellEarly] skip tokenId=${tokenId.slice(0, 12)}... reason=MIN_ORDER_SIZE: ${reason}`,
      );
      this.minOrderSizeFailures.set(tokenId, now);
    }
  }

  /**
   * Log aggregated skip summary (rate-limited DEBUG)
   */
  private logSkipSummary(reasons: SkipReasons): void {
    const total =
      reasons.redeemable +
      reasons.noBid +
      reasons.belowThreshold +
      reasons.badMarketId +
      reasons.minOrderSize +
      reasons.postorderFailed +
      reasons.illiquid +
      reasons.spreadWide +
      reasons.holdTime;

    if (total === 0) {
      return;
    }

    // Create fingerprint for change detection
    const fingerprint = `${reasons.redeemable},${reasons.noBid},${reasons.belowThreshold},${reasons.badMarketId}`;

    // Log only if fingerprint changed or TTL expired
    if (
      this.logDeduper.shouldLog(
        "SellEarly:skip_summary",
        SKIP_LOG_TTL_MS,
        fingerprint,
      )
    ) {
      const parts: string[] = [];
      if (reasons.redeemable > 0)
        parts.push(`redeemable=${reasons.redeemable}`);
      if (reasons.noBid > 0) parts.push(`no_bid=${reasons.noBid}`);
      if (reasons.belowThreshold > 0)
        parts.push(`below_threshold=${reasons.belowThreshold}`);
      if (reasons.badMarketId > 0)
        parts.push(`bad_market_id=${reasons.badMarketId}`);
      if (reasons.minOrderSize > 0)
        parts.push(`min_order_size=${reasons.minOrderSize}`);
      if (reasons.postorderFailed > 0)
        parts.push(`postorder_failed=${reasons.postorderFailed}`);
      // Optional gates (only log if enabled and triggered)
      if (reasons.illiquid > 0) parts.push(`illiquid=${reasons.illiquid}`);
      if (reasons.spreadWide > 0)
        parts.push(`spread_wide=${reasons.spreadWide}`);
      if (reasons.holdTime > 0) parts.push(`hold_time=${reasons.holdTime}`);

      this.logger.debug(`[SellEarly] Skipped: ${parts.join(", ")}`);
    }
  }

  /**
   * Clean up old min order size failure entries to prevent memory leaks
   */
  private cleanupMinOrderSizeCache(): void {
    const now = Date.now();
    const expiredBefore = now - SellEarlyStrategy.MIN_ORDER_LOG_TTL_MS * 2;
    for (const [tokenId, timestamp] of this.minOrderSizeFailures) {
      if (timestamp < expiredBefore) {
        this.minOrderSizeFailures.delete(tokenId);
      }
    }
  }
}
