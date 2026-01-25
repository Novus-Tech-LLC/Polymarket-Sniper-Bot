import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { LogDeduper, SKIP_LOG_TTL_MS } from "../utils/log-deduper.util";

export interface AutoSellConfig {
  enabled: boolean;
  threshold: number; // Price threshold to auto-sell (e.g., 0.99 = 99¢)
  minHoldSeconds: number; // Minimum time to hold before auto-selling (avoids conflict with endgame sweep)
  minOrderUsd: number; // Minimum order size in USD (from MIN_ORDER_USD env)
  /**
   * DISPUTE WINDOW EXIT SETTINGS
   * Positions near resolution ($0.99+) can get stuck in a 2-hour dispute window
   * Better to sell at 99.9¢ and free up capital than wait 2 hours for settlement
   *
   * When enabled, the strategy will:
   * 1. Look for positions at 99.9¢ or higher (dispute hold price)
   * 2. Sell immediately to exit without waiting for settlement
   * 3. This allows recycling capital faster instead of waiting for dispute resolution
   */
  disputeWindowExitEnabled?: boolean; // Enable early exit for positions in dispute window
  disputeWindowExitPrice?: number; // Price to sell at for dispute exit (default: 0.999 = 99.9¢)
}

/**
 * Default configuration for AutoSell strategy
 * - Enabled by default for capital efficiency
 * - Normal threshold at 99¢ (0.99)
 * - Dispute exit at 99.9¢ (0.999) for faster capital recovery
 */
export const DEFAULT_AUTO_SELL_CONFIG: AutoSellConfig = {
  enabled: true,
  threshold: 0.99, // Normal near-resolution threshold (99¢)
  minHoldSeconds: 60, // Wait 60s before auto-selling to avoid conflict with endgame sweep
  minOrderUsd: 1, // Minimum $1 order size
  disputeWindowExitEnabled: true, // Enable dispute window exit
  disputeWindowExitPrice: 0.999, // Sell at 99.9¢ for dispute exit
};

export interface AutoSellStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: AutoSellConfig;
}

/**
 * Skip reason tracking for logging
 */
interface SkipReasons {
  redeemable: number;
  notTradable: number;
  noBid: number;
  belowThreshold: number;
  minHoldTime: number;
  alreadySold: number;
}

/**
 * Auto-Sell at High Price Strategy
 * Monitors owned positions approaching resolution
 * Automatically sells when price hits threshold (e.g., 99.6¢)
 * Only sells positions held longer than minHoldSeconds to avoid conflict with endgame sweep
 * Don't wait for 4pm UTC payout - free up capital immediately
 * Lose small amount per share but gain hours of capital availability
 *
 * FILTERING RULES:
 * 1. Only operates on ACTIVE (non-redeemable) positions
 * 2. Skips positions with executionStatus !== TRADABLE
 * 3. Skips positions with no bid price (currentBidPrice undefined)
 */
export class AutoSellStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoSellConfig;
  private soldPositions: Set<string> = new Set();
  private positionFirstSeen: Map<string, number> = new Map();
  // Track tokens with no liquidity to suppress repeated warnings
  private noLiquidityTokens: Set<string> = new Set();

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();

  constructor(strategyConfig: AutoSellStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;

    if (this.config.enabled) {
      const disputeInfo = this.config.disputeWindowExitEnabled
        ? ` disputeExit=${(this.config.disputeWindowExitPrice ?? 0.999) * 100}¢`
        : "";
      this.logger.info(
        `[AutoSell] Initialized: threshold=${(this.config.threshold * 100).toFixed(1)}¢ minHold=${this.config.minHoldSeconds}s${disputeInfo}`,
      );
    }
  }

  /**
   * Execute the auto-sell strategy
   * Returns number of positions sold
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[AutoSell] Skipped - already in flight");
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
    // Clean up stale entries
    this.cleanupStaleEntries();

    // Track skip reasons for aggregated logging
    const skipReasons: SkipReasons = {
      redeemable: 0,
      notTradable: 0,
      noBid: 0,
      belowThreshold: 0,
      minHoldTime: 0,
      alreadySold: 0,
    };

    let soldCount = 0;
    let scannedCount = 0;

    // === DISPUTE WINDOW EXIT (99.9¢) ===
    // Check for positions that can be sold at 99.9¢ to exit dispute hold
    // This takes priority over normal auto-sell since it frees capital immediately
    if (this.config.disputeWindowExitEnabled) {
      const disputeExitPrice = this.config.disputeWindowExitPrice ?? 0.999;
      const disputeExitPositions =
        this.positionTracker.getPositionsNearResolution(disputeExitPrice);

      for (const position of disputeExitPositions) {
        scannedCount++;
        const sold = await this.processPosition(
          position,
          skipReasons,
          true, // isDisputeExit
        );
        if (sold) {
          soldCount++;
        }
      }
    }

    // === STANDARD AUTO-SELL (normal threshold) ===
    // Get positions near resolution (price >= threshold)
    const nearResolutionPositions =
      this.positionTracker.getPositionsNearResolution(this.config.threshold);

    for (const position of nearResolutionPositions) {
      scannedCount++;
      const sold = await this.processPosition(
        position,
        skipReasons,
        false, // isDisputeExit
      );
      if (sold) {
        soldCount++;
      }
    }

    // Log once-per-cycle summary
    this.logger.info(
      `[AutoSell] scanned=${scannedCount} sold=${soldCount} skipped_redeemable=${skipReasons.redeemable} skipped_not_tradable=${skipReasons.notTradable} skipped_no_bid=${skipReasons.noBid}`,
    );

    // Log aggregated skip summary (rate-limited DEBUG)
    this.logSkipSummary(skipReasons);

    return soldCount;
  }

  /**
   * Check if position is tradable (not redeemable, has valid execution status)
   * Returns skip reason if not tradable, or null if tradable
   */
  private checkTradability(
    position: Position,
  ): "REDEEMABLE" | "NOT_TRADABLE" | "NO_BID" | null {
    // Filter 1: Skip REDEEMABLE positions - these go to AutoRedeem
    if (position.redeemable === true) {
      return "REDEEMABLE";
    }

    // Filter 2: Skip positions with invalid execution status
    if (
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED"
    ) {
      return "NOT_TRADABLE";
    }

    // Filter 3: Skip positions with no bid (can't sell)
    if (position.currentBidPrice === undefined) {
      return "NO_BID";
    }

    return null; // Position is tradable
  }

  /**
   * Process a single position for auto-sell
   * @returns true if position was sold
   */
  private async processPosition(
    position: Position,
    skipReasons: SkipReasons,
    isDisputeExit: boolean,
  ): Promise<boolean> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const tokenIdShort = position.tokenId.slice(0, 12);

    // Skip if already sold
    if (this.soldPositions.has(positionKey)) {
      skipReasons.alreadySold++;
      return false;
    }

    // Check tradability (redeemable, execution status, bid availability)
    const tradabilityIssue = this.checkTradability(position);
    if (tradabilityIssue) {
      switch (tradabilityIssue) {
        case "REDEEMABLE":
          skipReasons.redeemable++;
          this.logSkipOnce(
            `REDEEMABLE:${tokenIdShort}`,
            `[AutoSell] skip tokenId=${tokenIdShort}... reason=REDEEMABLE (route to AutoRedeem)`,
          );
          break;
        case "NOT_TRADABLE":
          skipReasons.notTradable++;
          this.logSkipOnce(
            `NOT_TRADABLE:${tokenIdShort}`,
            `[AutoSell] skip tokenId=${tokenIdShort}... reason=NOT_TRADABLE executionStatus=${position.executionStatus ?? "unknown"} bookStatus=${position.bookStatus ?? "unknown"}`,
          );
          break;
        case "NO_BID":
          skipReasons.noBid++;
          this.logSkipOnce(
            `NO_BID:${tokenIdShort}`,
            `[AutoSell] skip tokenId=${tokenIdShort}... reason=NO_BID (currentBidPrice undefined, cannot sell)`,
          );
          break;
      }
      return false;
    }

    // For dispute exit, skip min hold time check
    if (!isDisputeExit) {
      // Track first seen time
      if (!this.positionFirstSeen.has(positionKey)) {
        this.positionFirstSeen.set(positionKey, Date.now());
        skipReasons.minHoldTime++;
        return false; // Don't sell on first detection
      }

      // Check minimum hold time (avoids conflict with endgame sweep)
      const holdTimeSeconds =
        (Date.now() - this.positionFirstSeen.get(positionKey)!) / 1000;
      if (holdTimeSeconds < this.config.minHoldSeconds) {
        skipReasons.minHoldTime++;
        this.logger.debug(
          `[AutoSell] Position ${position.marketId.slice(0, 16)}... held for ${holdTimeSeconds.toFixed(0)}s, waiting for ${this.config.minHoldSeconds}s`,
        );
        return false;
      }
    }

    // All checks passed - attempt to sell
    const priceLabel = isDisputeExit ? "DISPUTE EXIT" : "NEAR_RESOLUTION";
    this.logger.info(
      `[AutoSell] ${priceLabel}: Selling position at ${(position.currentPrice * 100).toFixed(1)}¢: tokenId=${tokenIdShort}... marketId=${position.marketId.slice(0, 16)}...`,
    );

    try {
      const sold = await this.sellPosition(
        position.marketId,
        position.tokenId,
        position.size,
      );

      if (sold) {
        this.soldPositions.add(positionKey);

        // Calculate and log capital recovery
        const lossPerShare = 1.0 - position.currentPrice;
        const totalLoss = lossPerShare * position.size;
        const freedCapital = position.size * position.currentPrice;

        if (isDisputeExit) {
          this.logger.info(
            `[AutoSell] ✅ DISPUTE EXIT: Freed $${freedCapital.toFixed(2)} capital (cost: $${totalLoss.toFixed(3)} to avoid dispute hold wait)`,
          );
        } else {
          const feeCost = position.size * 0.002; // 0.2% round-trip fees
          const totalCost = totalLoss + feeCost;
          this.logger.info(
            `[AutoSell] ✅ Freed $${freedCapital.toFixed(2)} capital (cost: $${totalLoss.toFixed(2)} + $${feeCost.toFixed(2)} fees = $${totalCost.toFixed(2)} total)`,
          );
        }
        return true;
      }
    } catch (err) {
      this.logger.error(
        `[AutoSell] Failed to sell position ${position.marketId.slice(0, 16)}...`,
        err as Error,
      );
    }

    return false;
  }

  /**
   * Log skip reason once per TTL (rate-limited DEBUG)
   */
  private logSkipOnce(key: string, message: string): void {
    if (this.logDeduper.shouldLog(`AutoSell:${key}`, SKIP_LOG_TTL_MS)) {
      this.logger.debug(message);
    }
  }

  /**
   * Log aggregated skip summary (rate-limited DEBUG)
   */
  private logSkipSummary(reasons: SkipReasons): void {
    const total =
      reasons.redeemable +
      reasons.notTradable +
      reasons.noBid +
      reasons.belowThreshold +
      reasons.minHoldTime +
      reasons.alreadySold;

    if (total === 0) {
      return;
    }

    // Create fingerprint for change detection
    const fingerprint = `${reasons.redeemable},${reasons.notTradable},${reasons.noBid}`;

    // Log only if fingerprint changed or TTL expired
    if (
      this.logDeduper.shouldLog(
        "AutoSell:skip_summary",
        SKIP_LOG_TTL_MS,
        fingerprint,
      )
    ) {
      const parts: string[] = [];
      if (reasons.redeemable > 0) parts.push(`redeemable=${reasons.redeemable}`);
      if (reasons.notTradable > 0)
        parts.push(`not_tradable=${reasons.notTradable}`);
      if (reasons.noBid > 0) parts.push(`no_bid=${reasons.noBid}`);
      if (reasons.belowThreshold > 0)
        parts.push(`below_threshold=${reasons.belowThreshold}`);
      if (reasons.minHoldTime > 0)
        parts.push(`min_hold_time=${reasons.minHoldTime}`);
      if (reasons.alreadySold > 0)
        parts.push(`already_sold=${reasons.alreadySold}`);

      this.logger.debug(`[AutoSell] Skipped: ${parts.join(", ")}`);
    }
  }

  /**
   * Sell a position using postOrder utility
   * Executes market sell order at best bid for quick capital recovery
   * @returns true if order was submitted successfully, false if skipped/no liquidity
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number,
  ): Promise<boolean> {
    try {
      // Import postOrder utility
      const { postOrder } = await import("../utils/post-order.util");

      // Get current orderbook to check liquidity and best bid
      const orderbook = await this.client.getOrderBook(tokenId);

      if (!orderbook.bids || orderbook.bids.length === 0) {
        // Only log if we haven't already logged for this token (suppress log spam)
        if (!this.noLiquidityTokens.has(tokenId)) {
          this.logger.warn(
            `[AutoSell] ⚠️ No bids available for token ${tokenId} - position cannot be sold (illiquid market)`,
          );
          this.noLiquidityTokens.add(tokenId);
        }
        // Return false - position will be re-evaluated on the next cycle when liquidity may return
        return false;
      }

      // Clear no-liquidity flag if liquidity has returned
      this.noLiquidityTokens.delete(tokenId);

      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestBidSize = parseFloat(orderbook.bids[0].size);

      this.logger.debug(
        `[AutoSell] Best bid: ${(bestBid * 100).toFixed(1)}¢ (size: ${bestBidSize.toFixed(2)})`,
      );

      // Check liquidity
      const totalBidLiquidity = orderbook.bids
        .slice(0, 5) // Top 5 levels for auto-sell
        .reduce((sum, level) => sum + parseFloat(level.size), 0);

      if (totalBidLiquidity < size * 0.3) {
        this.logger.warn(
          `[AutoSell] Low liquidity: attempting to sell ${size.toFixed(2)} but only ${totalBidLiquidity.toFixed(2)} available`,
        );
      }

      // Calculate sell value
      const sizeUsd = size * bestBid;

      // Log info for small positions but allow selling them to liquidate
      const minOrderUsd = this.config.minOrderUsd;
      if (sizeUsd < minOrderUsd) {
        this.logger.debug(
          `[AutoSell] ℹ️ Selling small position: $${sizeUsd.toFixed(2)} (below $${minOrderUsd} minimum, allowed for liquidation)`,
        );
      }

      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      // Calculate expected loss per share
      const lossPerShare = 1.0 - bestBid;
      const totalLoss = lossPerShare * size;

      this.logger.info(
        `[AutoSell] Executing sell: ${size.toFixed(2)} shares at ~${(bestBid * 100).toFixed(1)}¢ (loss: $${totalLoss.toFixed(2)})`,
      );

      // Execute sell order - use aggressive pricing for fast fill
      // Always set minOrderUsd=0 for sells to allow liquidating small positions
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: "YES", // Direction doesn't matter for sells
        side: "SELL",
        sizeUsd,
        minAcceptablePrice: bestBid * 0.9, // Accept up to 10% slippage below current bid for urgent exit
        logger: this.logger,
        priority: false,
        skipDuplicatePrevention: true, // Auto-sell must bypass duplicate prevention for exits
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum order size for all sells
      });

      if (result.status === "submitted") {
        const freedCapital = size * bestBid;
        this.logger.info(
          `[AutoSell] ✓ Sold ${size.toFixed(2)} shares, freed $${freedCapital.toFixed(2)} capital`,
        );
        return true;
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[AutoSell] Sell order skipped: ${result.reason ?? "unknown reason"}`,
        );
        return false;
      } else if (result.reason === "FOK_ORDER_KILLED") {
        // FOK order was submitted but killed (no fill) - market has insufficient liquidity
        this.logger.warn(
          `[AutoSell] ⚠️ Sell order not filled (FOK killed): ${size.toFixed(2)} shares at ~${(bestBid * 100).toFixed(1)}¢ - market has insufficient liquidity`,
        );
        return false;
      } else {
        this.logger.error(
          `[AutoSell] Sell order failed: ${result.reason ?? "unknown reason"}`,
        );
        throw new Error(`Sell order failed: ${result.reason ?? "unknown"}`);
      }
    } catch (err) {
      // Re-throw error for caller to handle
      this.logger.error(
        `[AutoSell] Failed to sell position: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Clean up stale entries from tracking Maps/Sets
   * Removes entries for positions that no longer exist or were sold
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

    // Clean up positionFirstSeen for positions that no longer exist
    let cleanedFirstSeen = 0;
    const firstSeenKeysToDelete: string[] = [];
    for (const key of this.positionFirstSeen.keys()) {
      if (!currentKeys.has(key)) {
        firstSeenKeysToDelete.push(key);
      }
    }
    for (const key of firstSeenKeysToDelete) {
      this.positionFirstSeen.delete(key);
      cleanedFirstSeen++;
    }

    // Clean up soldPositions that are no longer in current positions
    // (they've been fully removed/resolved)
    let cleanedSold = 0;
    const soldKeysToDelete: string[] = [];
    for (const key of this.soldPositions) {
      if (!currentKeys.has(key)) {
        soldKeysToDelete.push(key);
      }
    }
    for (const key of soldKeysToDelete) {
      this.soldPositions.delete(key);
      cleanedSold++;
    }

    // Also clean up no-liquidity cache for tokens we no longer hold
    const tokensToRemove: string[] = [];
    for (const tokenId of this.noLiquidityTokens) {
      if (!currentTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      this.noLiquidityTokens.delete(tokenId);
    }

    if (cleanedFirstSeen > 0 || cleanedSold > 0) {
      this.logger.debug(
        `[AutoSell] Cleaned up ${cleanedFirstSeen} first-seen and ${cleanedSold} sold entries`,
      );
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    soldCount: number;
    enabled: boolean;
    threshold: number;
  } {
    return {
      soldCount: this.soldPositions.size,
      enabled: this.config.enabled,
      threshold: this.config.threshold,
    };
  }

  /**
   * Reset sold positions tracking (for testing or daily reset)
   */
  reset(): void {
    this.soldPositions.clear();
    this.positionFirstSeen.clear();
    this.noLiquidityTokens.clear();
  }
}
