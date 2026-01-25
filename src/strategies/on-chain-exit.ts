/**
 * On-Chain Exit Strategy
 *
 * Handles positions that are NOT TRADABLE ON CLOB but have high current price (≥99¢).
 * These positions cannot be sold via AutoSell (CLOB blocked) but may be redeemable on-chain.
 *
 * WHEN THIS STRATEGY APPLIES:
 * - Position has executionStatus=NOT_TRADABLE_ON_CLOB
 * - Position has bookStatus=NO_BOOK_404, EMPTY_BOOK, or BOOK_ANOMALY
 * - Position has high currentPrice (configurable, default ≥99¢)
 *
 * WHAT IT DOES:
 * 1. Detects ACTIVE positions that AutoSell skips due to NOT_TRADABLE status
 * 2. Checks on-chain payoutDenominator to see if redemption is possible
 * 3. If redeemable on-chain, triggers redemption flow
 * 4. If not redeemable, logs clear reason and skips (will retry next cycle)
 *
 * SAFETY CHECKS:
 * - Never attempts on-chain exit when market is unresolved
 * - Requires payoutDenominator > 0 (on-chain proof of resolution)
 * - Ensures position is not processed by both AutoSell and OnChainExit in same cycle
 */

import { Contract, type Wallet } from "ethers";
import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { resolvePolymarketContracts } from "../polymarket/contracts";
import { CTF_ABI } from "../trading/exchange-abi";
import { LogDeduper, SKIP_LOG_TTL_MS } from "../utils/log-deduper.util";

/**
 * On-Chain Exit Configuration
 */
export interface OnChainExitConfig {
  /** Enable on-chain exit strategy */
  enabled: boolean;
  /** Minimum price threshold for on-chain exit (default: 0.99 = 99¢) */
  priceThreshold: number;
  /** Minimum position value (USD) to attempt on-chain exit */
  minPositionUsd: number;
}

/**
 * Default configuration for OnChainExit strategy
 */
export const DEFAULT_ON_CHAIN_EXIT_CONFIG: OnChainExitConfig = {
  enabled: true,
  priceThreshold: 0.99, // 99¢ - positions near resolution but not tradable on CLOB
  minPositionUsd: 0.01, // Attempt exit for any non-dust position
};

/**
 * Skip reason tracking for logging and diagnostics
 */
export type OnChainExitSkipReason =
  | "TRADABLE_ON_CLOB" // Position is tradable on CLOB (AutoSell handles it)
  | "BELOW_PRICE_THRESHOLD" // currentPrice below configured threshold
  | "BELOW_MIN_VALUE" // Position value below minPositionUsd
  | "NOT_REDEEMABLE_ONCHAIN" // payoutDenominator == 0 (market not resolved on-chain)
  | "NO_WALLET" // No wallet available for on-chain check
  | "INVALID_CONDITION_ID" // conditionId format invalid
  | "RPC_ERROR" // Error checking on-chain state
  | "ALREADY_PROCESSED"; // Already processed this cycle

/**
 * Skip reasons counter for summary logging
 */
interface SkipReasons {
  tradableOnClob: number;
  belowPriceThreshold: number;
  belowMinValue: number;
  notRedeemableOnchain: number;
  noWallet: number;
  invalidConditionId: number;
  rpcError: number;
  alreadyProcessed: number;
}

/**
 * Result of on-chain exit check
 */
export interface OnChainExitCheckResult {
  canExit: boolean;
  skipReason?: OnChainExitSkipReason;
  payoutDenominator?: bigint;
}

/**
 * Strategy options
 */
export interface OnChainExitStrategyOptions {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: OnChainExitConfig;
}

/**
 * On-Chain Exit Strategy
 *
 * Routes positions that cannot be sold via CLOB to on-chain redemption
 * when the market is resolved.
 */
export class OnChainExitStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: OnChainExitConfig;

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();

  // === PROCESSED TRACKING ===
  // Track positions already processed this cycle to avoid duplicates
  private processedThisCycle: Set<string> = new Set();

  // Cache for on-chain payoutDenominator checks (5 min TTL)
  private payoutDenominatorCache = new Map<
    string,
    { resolved: boolean; checkedAt: number }
  >();
  private static readonly PAYOUT_DENOM_CACHE_TTL_MS = 300_000; // 5 minutes
  private static readonly BYTES32_HEX_LENGTH = 66;

  constructor(options: OnChainExitStrategyOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.positionTracker = options.positionTracker;
    this.config = options.config;

    if (this.config.enabled) {
      this.logger.info(
        `[OnChainExit] Initialized: priceThreshold=${(this.config.priceThreshold * 100).toFixed(1)}¢ minPositionUsd=$${this.config.minPositionUsd}`,
      );
    }
  }

  /**
   * Execute the on-chain exit strategy
   * Returns number of positions successfully routed to redemption
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[OnChainExit] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    try {
      // Reset processed set at start of cycle
      this.processedThisCycle.clear();
      return await this.executeInternal();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Internal execution logic
   */
  private async executeInternal(): Promise<number> {
    // Track skip reasons for aggregated logging
    const skipReasons: SkipReasons = {
      tradableOnClob: 0,
      belowPriceThreshold: 0,
      belowMinValue: 0,
      notRedeemableOnchain: 0,
      noWallet: 0,
      invalidConditionId: 0,
      rpcError: 0,
      alreadyProcessed: 0,
    };

    let routedToRedemption = 0;
    let scannedCount = 0;

    // Get all active positions
    const positions = this.positionTracker.getPositions();

    for (const position of positions) {
      scannedCount++;

      // Skip if already redeemable (AutoRedeem handles these)
      if (position.redeemable === true) {
        continue;
      }

      // Check if this position is a candidate for on-chain exit
      const checkResult = await this.checkOnChainExitCandidate(
        position,
        skipReasons,
      );

      if (!checkResult.canExit) {
        continue;
      }

      // Position is redeemable on-chain!
      // Log this discovery - AutoRedeem will pick it up once PositionTracker updates.
      // The on-chain payoutDenominator check we performed will be cached, so AutoRedeem
      // won't need to repeat it. If PositionTracker hasn't marked this as redeemable yet,
      // it will on the next refresh cycle.
      const tokenIdShort = position.tokenId.slice(0, 12);
      const positionValue = position.size * position.currentPrice;
      this.logger.info(
        `[OnChainExit] ✅ ON-CHAIN REDEEMABLE FOUND: tokenId=${tokenIdShort}... marketId=${position.marketId.slice(0, 16)}... ` +
          `currentPrice=${(position.currentPrice * 100).toFixed(1)}¢ value=$${positionValue.toFixed(2)} ` +
          `payoutDenominator=${checkResult.payoutDenominator} (AutoRedeem will claim on next cycle)`,
      );

      // Mark as processed
      this.processedThisCycle.add(`${position.marketId}-${position.tokenId}`);
      routedToRedemption++;
    }

    // Log summary
    if (scannedCount > 0 || routedToRedemption > 0) {
      this.logger.info(
        `[OnChainExit] scanned=${scannedCount} found_redeemable=${routedToRedemption} ` +
          `skipped_tradable=${skipReasons.tradableOnClob} skipped_below_threshold=${skipReasons.belowPriceThreshold} ` +
          `skipped_not_redeemable=${skipReasons.notRedeemableOnchain}`,
      );
    }

    // Log detailed skip summary (rate-limited)
    this.logSkipSummary(skipReasons);

    return routedToRedemption;
  }

  /**
   * Check if a position is a candidate for on-chain exit
   */
  private async checkOnChainExitCandidate(
    position: Position,
    skipReasons: SkipReasons,
  ): Promise<OnChainExitCheckResult> {
    const tokenIdShort = position.tokenId.slice(0, 12);
    const positionKey = `${position.marketId}-${position.tokenId}`;

    // Skip if already processed this cycle
    if (this.processedThisCycle.has(positionKey)) {
      skipReasons.alreadyProcessed++;
      return { canExit: false, skipReason: "ALREADY_PROCESSED" };
    }

    // Check 1: Only process positions that AutoSell skips (NOT_TRADABLE_ON_CLOB)
    // If position is tradable on CLOB, AutoSell handles it
    if (
      position.executionStatus !== "NOT_TRADABLE_ON_CLOB" &&
      position.executionStatus !== "EXECUTION_BLOCKED"
    ) {
      // Position is tradable on CLOB - not our concern
      skipReasons.tradableOnClob++;
      return { canExit: false, skipReason: "TRADABLE_ON_CLOB" };
    }

    // Check 2: Price threshold - only high-value near-resolution positions
    const effectivePrice = position.currentPrice;
    if (effectivePrice < this.config.priceThreshold) {
      skipReasons.belowPriceThreshold++;
      this.logSkipOnce(
        `BELOW_THRESHOLD:${tokenIdShort}`,
        `[OnChainExit] skip tokenId=${tokenIdShort}... reason=BELOW_PRICE_THRESHOLD ` +
          `currentPrice=${(effectivePrice * 100).toFixed(1)}¢ < threshold=${(this.config.priceThreshold * 100).toFixed(1)}¢`,
      );
      return { canExit: false, skipReason: "BELOW_PRICE_THRESHOLD" };
    }

    // Check 3: Minimum position value
    const positionValue = position.size * position.currentPrice;
    if (positionValue < this.config.minPositionUsd) {
      skipReasons.belowMinValue++;
      return { canExit: false, skipReason: "BELOW_MIN_VALUE" };
    }

    // Check 4: On-chain resolution status
    const onChainResult = await this.checkOnChainResolved(position.marketId);

    if (onChainResult.skipReason) {
      switch (onChainResult.skipReason) {
        case "NO_WALLET":
          skipReasons.noWallet++;
          break;
        case "INVALID_CONDITION_ID":
          skipReasons.invalidConditionId++;
          break;
        case "NOT_REDEEMABLE_ONCHAIN":
          skipReasons.notRedeemableOnchain++;
          // Log with position info for better diagnostics
          this.logSkipOnce(
            `NOT_REDEEMABLE:${tokenIdShort}`,
            `[OnChainExit] skip tokenId=${tokenIdShort}... reason=NOT_REDEEMABLE_ONCHAIN ` +
              `currentPrice=${(effectivePrice * 100).toFixed(1)}¢ bookStatus=${position.bookStatus ?? "unknown"} ` +
              `(market not resolved on-chain, will retry)`,
          );
          break;
        case "RPC_ERROR":
          skipReasons.rpcError++;
          break;
      }
      return onChainResult;
    }

    // Position is redeemable on-chain!
    return {
      canExit: true,
      payoutDenominator: onChainResult.payoutDenominator,
    };
  }

  /**
   * Check on-chain payoutDenominator for a conditionId.
   * Returns whether position can be redeemed on-chain.
   */
  private async checkOnChainResolved(
    conditionId: string,
  ): Promise<OnChainExitCheckResult> {
    // Validate conditionId format (bytes32)
    if (
      !conditionId?.startsWith("0x") ||
      conditionId.length !== OnChainExitStrategy.BYTES32_HEX_LENGTH
    ) {
      return { canExit: false, skipReason: "INVALID_CONDITION_ID" };
    }

    // Check cache first
    const cached = this.payoutDenominatorCache.get(conditionId);
    const now = Date.now();
    if (
      cached &&
      now - cached.checkedAt < OnChainExitStrategy.PAYOUT_DENOM_CACHE_TTL_MS
    ) {
      if (cached.resolved) {
        return { canExit: true, payoutDenominator: 1n }; // Cached as resolved
      }
      return { canExit: false, skipReason: "NOT_REDEEMABLE_ONCHAIN" };
    }

    try {
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      if (!wallet?.provider) {
        return { canExit: false, skipReason: "NO_WALLET" };
      }

      const contracts = resolvePolymarketContracts();
      const ctfAddress = contracts.ctfAddress;
      if (!ctfAddress) {
        return { canExit: false, skipReason: "NO_WALLET" };
      }

      // Create CTF contract instance (read-only, using provider)
      const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet.provider);

      // Call payoutDenominator view function
      const denominator = (await ctfContract.payoutDenominator(
        conditionId,
      )) as bigint;

      const isResolved = denominator > 0n;

      // Cache the result
      this.payoutDenominatorCache.set(conditionId, {
        resolved: isResolved,
        checkedAt: now,
      });

      // Clean up old cache entries if needed
      if (this.payoutDenominatorCache.size > 1000) {
        const entriesToDelete: string[] = [];
        for (const [key, entry] of this.payoutDenominatorCache) {
          if (
            now - entry.checkedAt >
            OnChainExitStrategy.PAYOUT_DENOM_CACHE_TTL_MS * 2
          ) {
            entriesToDelete.push(key);
          }
        }
        for (const key of entriesToDelete) {
          this.payoutDenominatorCache.delete(key);
        }
      }

      if (isResolved) {
        return { canExit: true, payoutDenominator: denominator };
      }
      return { canExit: false, skipReason: "NOT_REDEEMABLE_ONCHAIN" };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `[OnChainExit] checkOnChainResolved failed for ${conditionId.slice(0, 16)}...: ${errMsg}`,
      );
      return { canExit: false, skipReason: "RPC_ERROR" };
    }
  }

  /**
   * Log skip reason once per TTL (rate-limited)
   */
  private logSkipOnce(key: string, message: string): void {
    if (this.logDeduper.shouldLog(`OnChainExit:${key}`, SKIP_LOG_TTL_MS)) {
      this.logger.debug(message);
    }
  }

  /**
   * Log aggregated skip summary (rate-limited)
   */
  private logSkipSummary(reasons: SkipReasons): void {
    const total =
      reasons.tradableOnClob +
      reasons.belowPriceThreshold +
      reasons.belowMinValue +
      reasons.notRedeemableOnchain +
      reasons.noWallet +
      reasons.invalidConditionId +
      reasons.rpcError +
      reasons.alreadyProcessed;

    if (total === 0) {
      return;
    }

    // Create fingerprint for change detection
    const fingerprint = `${reasons.notRedeemableOnchain},${reasons.belowPriceThreshold}`;

    // Log only if fingerprint changed or TTL expired
    if (
      this.logDeduper.shouldLog(
        "OnChainExit:skip_summary",
        SKIP_LOG_TTL_MS,
        fingerprint,
      )
    ) {
      const parts: string[] = [];
      if (reasons.tradableOnClob > 0)
        parts.push(`tradable_on_clob=${reasons.tradableOnClob}`);
      if (reasons.belowPriceThreshold > 0)
        parts.push(`below_threshold=${reasons.belowPriceThreshold}`);
      if (reasons.belowMinValue > 0)
        parts.push(`below_min_value=${reasons.belowMinValue}`);
      if (reasons.notRedeemableOnchain > 0)
        parts.push(`not_redeemable=${reasons.notRedeemableOnchain}`);
      if (reasons.rpcError > 0) parts.push(`rpc_error=${reasons.rpcError}`);

      this.logger.debug(`[OnChainExit] Skipped: ${parts.join(", ")}`);
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    priceThreshold: number;
    cacheSize: number;
  } {
    return {
      enabled: this.config.enabled,
      priceThreshold: this.config.priceThreshold,
      cacheSize: this.payoutDenominatorCache.size,
    };
  }

  /**
   * Clear cache (for testing)
   */
  clearCache(): void {
    this.payoutDenominatorCache.clear();
    this.processedThisCycle.clear();
  }
}
