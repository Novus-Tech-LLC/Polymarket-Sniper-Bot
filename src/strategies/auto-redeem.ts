/**
 * Auto-Redeem Strategy
 *
 * Automatically redeems resolved market positions to recover USDC.
 * Based on: https://github.com/milanzandbak/polymarketredeemer/blob/main/polyredeemer.js
 *
 * When a market resolves (outcome determined), positions can be redeemed for USDC.
 * This strategy:
 * 1. Periodically checks for redeemable positions via Polymarket Data API
 * 2. Fetches the user's proxy address (if any) from Polymarket
 * 3. Sends redemption transactions to the CTF contract
 *
 * Configuration is minimal - only private key and RPC URL are needed.
 * The public key is derived from the private key automatically.
 */

import { Contract, Interface, Wallet, ZeroHash } from "ethers";
import type { TransactionResponse } from "ethers";
import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { RelayerContext } from "../polymarket/relayer";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { resolvePolymarketContracts } from "../polymarket/contracts";
import { CTF_ABI, PROXY_WALLET_ABI } from "../trading/exchange-abi";
import { resolveSignerAddress } from "../utils/funds-allowance.util";

/**
 * Minimal position data needed for redemption.
 * AutoRedeem fetches this directly from the Data API instead of using PositionTracker.
 *
 * WHY NOT USE POSITIONTRACKER?
 * AutoRedeem's responsibility is simple: find positions where payoutDenominator > 0 on-chain
 * and redeem them. It doesn't need PositionTracker's complex state machine, P&L calculations,
 * or orderbook data. By scanning on-chain directly (via the payoutDenominator check),
 * AutoRedeem is authoritative about what can actually be redeemed.
 *
 * The Data API provides the list of tokenIds/conditionIds to check. The on-chain
 * payoutDenominator check is the ONLY authority for redeemability.
 */
export interface RedeemablePosition {
  /** Token ID (ERC-1155 token identifier) */
  tokenId: string;
  /** Condition ID / Market ID (bytes32 conditionId for CTF contract) */
  marketId: string;
  /** Number of shares held */
  size: number;
  /** Current price (used for value estimation, not redeemability) */
  currentPrice: number;
}

/**
 * Raw position data from Data API /positions endpoint
 */
interface DataApiPosition {
  asset: string; // tokenId
  conditionId: string; // marketId/conditionId
  size: number;
  curPrice?: number;
  redeemable?: boolean;
}

/**
 * Auto-Redeem Configuration
 */
export interface AutoRedeemConfig {
  /** Enable auto-redemption */
  enabled: boolean;
  /** Minimum position value (USD) to bother redeeming */
  minPositionUsd: number;
  /** How often to check for redeemable positions (ms) */
  checkIntervalMs: number;
}

/**
 * Redemption skip reason for detailed tracking
 */
export type RedemptionSkipReason =
  | "NOT_RESOLVED_ONCHAIN" // payoutDenominator == 0
  | "BELOW_MIN_VALUE" // position value < minPositionUsd
  | "TOO_MANY_FAILURES" // exceeded MAX_REDEMPTION_FAILURES
  | "IN_COOLDOWN"; // still in retry cooldown

/**
 * Result of a redemption attempt
 */
export interface RedemptionResult {
  tokenId: string;
  marketId: string;
  success: boolean;
  transactionHash?: string;
  amountRedeemed?: string;
  error?: string;
  isRateLimited?: boolean;
  isNotResolvedYet?: boolean;
  isNonceError?: boolean;
  /** Reason why redemption was skipped (only set when skipped) */
  skippedReason?: RedemptionSkipReason;
  /** Position value in USD (for reporting) */
  positionValueUsd?: number;
}

/**
 * Auto-Redeem Strategy Options
 *
 * NOTE: AutoRedeem does NOT use PositionTracker. It fetches positions directly
 * from the Data API and uses on-chain payoutDenominator checks as the sole
 * authority for redeemability. This avoids coupling to PositionTracker's
 * complex state machine and ensures AutoRedeem is self-contained.
 */
export interface AutoRedeemStrategyOptions {
  client: ClobClient;
  logger: ConsoleLogger;
  relayer?: RelayerContext;
  config: AutoRedeemConfig;
}

/**
 * Auto-Redeem Strategy
 *
 * Automatically claims resolved positions to recover USDC.
 *
 * ARCHITECTURE: Direct On-Chain Scanning (No PositionTracker)
 * ============================================================
 * AutoRedeem fetches wallet holdings directly from the Data API and uses
 * on-chain payoutDenominator checks to determine redeemability. This design:
 *
 * 1. AVOIDS PositionTracker dependency - AutoRedeem is self-contained
 * 2. Uses on-chain state as the SOLE AUTHORITY for redeemability
 * 3. Data API provides tokenIds/conditionIds to check (not redeemability)
 * 4. payoutDenominator > 0 is the ONLY criterion for redemption
 *
 * The strict redeemable state machine is implemented HERE via checkOnChainResolved(),
 * not inherited from PositionTracker.
 */
export class AutoRedeemStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: AutoRedeemConfig;

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

  // === INTERVAL-BASED THROTTLING ===
  // AutoRedeem only runs every checkIntervalMs to avoid hammering APIs
  private lastCheckTimeMs = 0;

  // Timing constants
  private static readonly API_TIMEOUT_MS = 10_000;
  private static readonly TX_CONFIRMATION_TIMEOUT_MS = 45_000;
  private static readonly REDEMPTION_DELAY_MS = 5_000; // Delay between redemptions to avoid rate limits
  private static readonly RETRY_BASE_DELAY_MS = 2_000; // Base delay for exponential backoff
  private static readonly MAX_RETRIES = 3; // Max retries for rate-limited requests

  // Standard indexSets for binary (YES/NO) markets on Polymarket
  // [1, 2] represents the two outcome slots in a binary market
  // Based on: https://github.com/milanzandbak/polymarketredeemer
  private static readonly BINARY_MARKET_INDEX_SETS = [1, 2];

  // Bytes32 hex string length (0x + 64 hex chars)
  private static readonly BYTES32_HEX_LENGTH = 66;

  // Track redemption attempts to avoid spamming failed markets
  private redemptionAttempts = new Map<
    string,
    { lastAttempt: number; failures: number }
  >();
  private static readonly REDEMPTION_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
  private static readonly MAX_REDEMPTION_FAILURES = 3;

  // Cache for on-chain payoutDenominator checks to minimize RPC calls
  private payoutDenominatorCache = new Map<
    string,
    { resolved: boolean; checkedAt: number }
  >();
  private static readonly PAYOUT_DENOM_CACHE_TTL_MS = 300_000; // 5 minutes

  constructor(options: AutoRedeemStrategyOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.config = options.config;
  }

  /**
   * Execute the auto-redeem check cycle
   * Called by the orchestrator on a schedule (every 2s), but only runs
   * when checkIntervalMs has elapsed since last check.
   *
   * INTERVAL-BASED THROTTLING: Only checks every checkIntervalMs (default 30s)
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   *
   * @returns The number of successful redemptions
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Interval-based throttling: only run every checkIntervalMs
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastCheckTimeMs;
    if (timeSinceLastCheck < this.config.checkIntervalMs) {
      // Not yet time to check - silently skip (no log spam)
      return 0;
    }

    // Single-flight guard: prevent concurrent execution
    if (this.inFlight) {
      this.logger.debug("[AutoRedeem] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    this.lastCheckTimeMs = now; // Update last check time
    try {
      return await this.executeInternal();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Internal execution logic (called by execute() with in-flight guard)
   *
   * ARCHITECTURE (Jan 2025 Refactor):
   * =================================
   * AutoRedeem no longer uses PositionTracker. Instead:
   * 1. Fetches positions directly from Data API (source of tokenIds)
   * 2. Checks on-chain payoutDenominator for each position
   * 3. Only redeems positions where payoutDenominator > 0
   *
   * The on-chain check is the SOLE AUTHORITY for redeemability.
   */
  private async executeInternal(): Promise<number> {
    // getRedeemablePositions now fetches from Data API and checks on-chain
    const redeemablePositions = await this.getRedeemablePositions();

    if (redeemablePositions.length === 0) {
      return 0;
    }

    this.logger.info(
      `[AutoRedeem] Found ${redeemablePositions.length} on-chain redeemable position(s), executing redemptions...`,
    );

    let successCount = 0;

    for (const position of redeemablePositions) {
      // On-chain already confirmed in getRedeemablePositions - proceed with redemption
      const result = await this.redeemPositionWithRetry(position);

      // Track attempts
      this.updateRedemptionAttempts(position.marketId, result);

      if (result.success) {
        successCount++;
      }

      // Longer delay between redemptions to avoid rate limits
      if (
        redeemablePositions.indexOf(position) <
        redeemablePositions.length - 1
      ) {
        await this.sleep(AutoRedeemStrategy.REDEMPTION_DELAY_MS);
      }
    }

    this.logger.info(
      `[AutoRedeem] Summary: ${successCount} of ${redeemablePositions.length} redeemed successfully`,
    );

    return successCount;
  }

  /**
   * Force redeem all positions (for CLI use)
   * Fetches positions directly from Data API and checks on-chain payoutDenominator.
   *
   * STRICT REDEEMABLE STATE MACHINE:
   * Only redeems positions where payoutDenominator > 0 on-chain.
   * Data API is only used to get the list of tokenIds to check.
   *
   * @param includeLosses - If true, includes $0 positions (losses). Default is true.
   * @returns Array of redemption results with detailed skip reasons
   */
  async forceRedeemAll(includeLosses = true): Promise<RedemptionResult[]> {
    // Fetch all positions directly from Data API (not from PositionTracker)
    const allPositions = await this.fetchPositionsFromDataApi();

    if (allPositions.length === 0) {
      this.logger.info("[AutoRedeem] No positions found in wallet");
      return [];
    }

    this.logger.info(
      `[AutoRedeem] Found ${allPositions.length} position(s), checking on-chain resolution...`,
    );

    const results: RedemptionResult[] = [];

    for (const position of allPositions) {
      const positionValue = position.size * position.currentPrice;

      // Check min value filter:
      // - If includeLosses is false (--exclude-losses): skip $0 positions (losers) AND positions below minPositionUsd
      // - If includeLosses is true (default): only skip if below minPositionUsd (allows $0 losers to be redeemed for cleanup)
      //
      // A $0 loser is a position where currentPrice ≈ 0 (the outcome lost), so positionValue ≈ 0.
      // Redeeming $0 losers costs gas but returns nothing - usually pointless.
      const isZeroValueLoser = positionValue < 0.001; // Less than 0.1 cent is effectively $0
      const isBelowMinValue = positionValue < this.config.minPositionUsd;

      if (!includeLosses && isZeroValueLoser) {
        this.logger.info(
          `[AutoRedeem] ⏭️ SKIPPED ($0 loser): ${position.marketId.slice(0, 16)}... | Value: $${positionValue.toFixed(4)} (excluded via --exclude-losses)`,
        );
        results.push({
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          skippedReason: "BELOW_MIN_VALUE",
          positionValueUsd: positionValue,
        });
        continue;
      }

      if (isBelowMinValue && !isZeroValueLoser) {
        this.logger.info(
          `[AutoRedeem] ⏭️ SKIPPED (below min value): ${position.marketId.slice(0, 16)}... | Value: $${positionValue.toFixed(4)} < $${this.config.minPositionUsd}`,
        );
        results.push({
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          skippedReason: "BELOW_MIN_VALUE",
          positionValueUsd: positionValue,
        });
        continue;
      }

      // On-chain preflight check: verify payoutDenominator > 0 before sending tx
      // This is the ONLY authority for redeemability
      const isOnChainResolved = await this.checkOnChainResolved(
        position.marketId,
      );

      if (!isOnChainResolved) {
        this.logger.info(
          `[AutoRedeem] ⏭️ SKIPPED (not resolved on-chain): ${position.marketId.slice(0, 16)}... | Value: $${positionValue.toFixed(2)}`,
        );
        results.push({
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          skippedReason: "NOT_RESOLVED_ONCHAIN",
          positionValueUsd: positionValue,
          isNotResolvedYet: true,
        });
        continue;
      }

      // Position is on-chain resolved, proceed with redemption
      const result = await this.redeemPositionWithRetry(position);
      result.positionValueUsd = positionValue;
      results.push(result);

      // Longer delay between redemptions
      if (allPositions.indexOf(position) < allPositions.length - 1) {
        await this.sleep(AutoRedeemStrategy.REDEMPTION_DELAY_MS);
      }
    }

    // Log summary
    this.logRedemptionSummary(results);

    return results;
  }

  /**
   * Log a detailed redemption summary with categorized counts
   */
  private logRedemptionSummary(results: RedemptionResult[]): void {
    const redeemed = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success && !r.skippedReason);
    const skippedNotResolved = results.filter(
      (r) => r.skippedReason === "NOT_RESOLVED_ONCHAIN",
    );
    const skippedBelowMin = results.filter(
      (r) => r.skippedReason === "BELOW_MIN_VALUE",
    );

    this.logger.info(`[AutoRedeem] 📊 Redemption Summary:`);
    this.logger.info(`  ✅ Redeemed: ${redeemed.length}`);
    this.logger.info(
      `  ⏭️ Skipped (not resolved on-chain): ${skippedNotResolved.length}`,
    );
    this.logger.info(
      `  ⏭️ Skipped (below min value): ${skippedBelowMin.length}`,
    );
    this.logger.info(`  ❌ Failed: ${failed.length}`);
  }

  /**
   * Check on-chain payoutDenominator for a conditionId.
   * Returns true if payoutDenominator > 0, indicating the market is resolved on-chain.
   *
   * Uses caching to minimize RPC calls.
   *
   * @param conditionId - The conditionId (same as marketId in Polymarket)
   * @returns true if resolved on-chain (payoutDenominator > 0), false otherwise
   */
  private async checkOnChainResolved(conditionId: string): Promise<boolean> {
    // Validate conditionId format (bytes32)
    if (
      !conditionId?.startsWith("0x") ||
      conditionId.length !== AutoRedeemStrategy.BYTES32_HEX_LENGTH
    ) {
      this.logger.debug(
        `[AutoRedeem] Invalid conditionId format: ${conditionId?.slice(0, 20)}...`,
      );
      return false;
    }

    // Check cache first
    const cached = this.payoutDenominatorCache.get(conditionId);
    const now = Date.now();
    if (
      cached &&
      now - cached.checkedAt < AutoRedeemStrategy.PAYOUT_DENOM_CACHE_TTL_MS
    ) {
      return cached.resolved;
    }

    try {
      const wallet = (this.client as { wallet?: Wallet }).wallet;
      if (!wallet?.provider) {
        this.logger.debug(
          "[AutoRedeem] No wallet/provider available for on-chain check",
        );
        return false;
      }

      const contracts = resolvePolymarketContracts();
      const ctfAddress = contracts.ctfAddress;
      if (!ctfAddress) {
        this.logger.debug("[AutoRedeem] CTF contract address not configured");
        return false;
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

      // Clean up old cache entries if needed (prevent unbounded growth)
      if (this.payoutDenominatorCache.size > 1000) {
        const entriesToDelete: string[] = [];
        for (const [key, entry] of this.payoutDenominatorCache) {
          if (
            now - entry.checkedAt >
            AutoRedeemStrategy.PAYOUT_DENOM_CACHE_TTL_MS * 2
          ) {
            entriesToDelete.push(key);
          }
        }
        for (const key of entriesToDelete) {
          this.payoutDenominatorCache.delete(key);
        }
      }

      if (isResolved) {
        this.logger.debug(
          `[AutoRedeem] 🔗 ON-CHAIN RESOLVED: conditionId=${conditionId.slice(0, 16)}... payoutDenominator=${denominator}`,
        );
      } else {
        this.logger.debug(
          `[AutoRedeem] ⏳ NOT RESOLVED ON-CHAIN: conditionId=${conditionId.slice(0, 16)}... payoutDenominator=0`,
        );
      }

      return isResolved;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `[AutoRedeem] checkOnChainResolved failed for ${conditionId.slice(0, 16)}...: ${errMsg}`,
      );
      // On error, don't cache - return false to be safe (don't send tx)
      return false;
    }
  }

  /**
   * Fetch all positions from Data API.
   * This is the source of tokenIds/conditionIds to check for redemption.
   * The Data API `redeemable` flag is NOT used - on-chain payoutDenominator is authoritative.
   *
   * @returns Array of positions from wallet holdings
   */
  private async fetchPositionsFromDataApi(): Promise<RedeemablePosition[]> {
    try {
      const walletAddress = resolveSignerAddress(this.client);
      if (!walletAddress || walletAddress === "unknown") {
        this.logger.debug(
          "[AutoRedeem] Cannot resolve wallet address for Data API fetch",
        );
        return [];
      }

      const url = POLYMARKET_API.POSITIONS_ENDPOINT(walletAddress);
      const apiPositions = await httpGet<DataApiPosition[]>(url, {
        timeout: AutoRedeemStrategy.API_TIMEOUT_MS,
      });

      if (!Array.isArray(apiPositions)) {
        this.logger.debug(
          "[AutoRedeem] Data API returned non-array response",
        );
        return [];
      }

      // Map to RedeemablePosition format
      // Note: We do NOT filter by redeemable flag - on-chain check is authoritative
      return apiPositions
        .filter((p) => p.asset && p.conditionId && p.size > 0)
        .map((p) => ({
          tokenId: p.asset,
          marketId: p.conditionId,
          size: p.size,
          currentPrice: p.curPrice ?? 0,
        }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `[AutoRedeem] Failed to fetch positions from Data API: ${errMsg}`,
      );
      return [];
    }
  }

  /**
   * Get positions that are redeemable ON-CHAIN.
   *
   * STRICT REDEEMABLE STATE MACHINE:
   * ================================
   * A position is ONLY redeemable if payoutDenominator(conditionId) > 0 on-chain.
   * - Data API `redeemable` flag is NOT trusted (can be stale or wrong)
   * - Price near 1.0 does NOT imply redeemable
   * - Empty orderbook does NOT imply redeemable
   * - Gamma "winner" field does NOT imply redeemable
   *
   * ONLY on-chain payoutDenominator > 0 is authoritative.
   *
   * @returns Array of positions that are confirmed redeemable on-chain
   */
  private async getRedeemablePositions(): Promise<RedeemablePosition[]> {
    // 1. Fetch all positions from Data API (source of tokenIds)
    const allPositions = await this.fetchPositionsFromDataApi();

    if (allPositions.length === 0) {
      return [];
    }

    // 2. Filter by minimum value threshold
    const aboveMinValue = allPositions.filter(
      (pos) => pos.size * pos.currentPrice >= this.config.minPositionUsd,
    );

    // 3. Check on-chain payoutDenominator for each position
    // This is the AUTHORITATIVE check for redeemability
    const redeemable: RedeemablePosition[] = [];

    for (const pos of aboveMinValue) {
      // Skip if in cooldown due to recent failures
      if (this.shouldSkipRedemption(pos.marketId)) {
        continue;
      }

      const isOnChainResolved = await this.checkOnChainResolved(pos.marketId);
      if (isOnChainResolved) {
        redeemable.push(pos);
      }
    }

    return redeemable;
  }

  /**
   * Check if we should skip redemption due to recent failures
   */
  private shouldSkipRedemption(marketId: string): boolean {
    const attempts = this.redemptionAttempts.get(marketId);
    if (!attempts) return false;

    // Skip if too many failures
    if (attempts.failures >= AutoRedeemStrategy.MAX_REDEMPTION_FAILURES) {
      return true;
    }

    // Skip if still in cooldown
    const cooldownRemaining =
      attempts.lastAttempt +
      AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS -
      Date.now();
    if (cooldownRemaining > 0) {
      return true;
    }

    return false;
  }

  /**
   * Update redemption attempt tracking
   */
  private updateRedemptionAttempts(
    marketId: string,
    result: RedemptionResult,
  ): void {
    if (result.success) {
      // Clear attempts on success
      this.redemptionAttempts.delete(marketId);
      return;
    }

    if (result.isRateLimited) {
      // Don't count rate limits as failures - transient network issue
      return;
    }

    if (result.isNonceError) {
      // Don't count nonce/replacement errors as failures - transient blockchain state
      // These occur when there are pending transactions and resolve on their own
      return;
    }

    if (result.isNotResolvedYet) {
      // Don't increment failures for "not resolved yet" - just set cooldown
      this.redemptionAttempts.set(marketId, {
        lastAttempt: Date.now(),
        failures: 0,
      });
      return;
    }

    // Track actual failure
    const current = this.redemptionAttempts.get(marketId) || {
      lastAttempt: 0,
      failures: 0,
    };
    this.redemptionAttempts.set(marketId, {
      lastAttempt: Date.now(),
      failures: current.failures + 1,
    });
  }

  /**
   * Redeem a position with retry logic for transient errors (rate limiting, nonce issues)
   */
  private async redeemPositionWithRetry(
    position: RedeemablePosition,
  ): Promise<RedemptionResult> {
    let lastResult: RedemptionResult | null = null;

    for (
      let attempt = 0;
      attempt <= AutoRedeemStrategy.MAX_RETRIES;
      attempt++
    ) {
      const result = await this.redeemPosition(position);

      // If successful or not a transient error, return immediately
      const isTransientError = result.isRateLimited || result.isNonceError;
      if (result.success || !isTransientError) {
        return result;
      }

      lastResult = result;

      // If we haven't exhausted retries, wait with exponential backoff
      if (attempt < AutoRedeemStrategy.MAX_RETRIES) {
        const backoffDelay =
          AutoRedeemStrategy.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        const reason = result.isNonceError
          ? "nonce/replacement error"
          : "rate limited";
        this.logger.info(
          `[AutoRedeem] ⏳ ${reason}, retrying in ${backoffDelay / 1000}s (attempt ${attempt + 1}/${AutoRedeemStrategy.MAX_RETRIES})`,
        );
        await this.sleep(backoffDelay);
      }
    }

    // All retries exhausted
    this.logger.warn(
      `[AutoRedeem] ⚠️ Exhausted ${AutoRedeemStrategy.MAX_RETRIES} retries due to transient errors`,
    );
    return (
      lastResult || {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: "Exhausted retries due to transient errors",
        isRateLimited: true,
      }
    );
  }

  /**
   * Redeem a single position
   * Based on: https://github.com/milanzandbak/polymarketredeemer/blob/main/polyredeemer.js
   */
  private async redeemPosition(
    position: RedeemablePosition,
  ): Promise<RedemptionResult> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;

    if (!wallet) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: "No wallet available for redemption",
      };
    }

    const contracts = resolvePolymarketContracts();
    const ctfAddress = contracts.ctfAddress;
    const usdcAddress = contracts.usdcAddress;

    if (!ctfAddress || !usdcAddress) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: "CTF or USDC contract address not configured",
      };
    }

    if (!wallet.provider) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: "No provider available",
      };
    }

    // The marketId in Polymarket is the conditionId (bytes32)
    const conditionId = position.marketId;

    if (
      !conditionId?.startsWith("0x") ||
      conditionId.length !== AutoRedeemStrategy.BYTES32_HEX_LENGTH
    ) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: `Invalid conditionId format (expected bytes32): ${conditionId}`,
      };
    }

    try {
      // 1) Find proxy address (optional) - from Polymarket Data API
      let proxyAddress: string | null = null;
      try {
        const profileUrl = POLYMARKET_API.PROFILE_ENDPOINT(wallet.address);
        const profileData = await httpGet<{ proxyAddress?: string }>(
          profileUrl,
          { timeout: AutoRedeemStrategy.API_TIMEOUT_MS },
        );
        if (profileData?.proxyAddress) {
          proxyAddress = profileData.proxyAddress;
          this.logger.debug(
            `[AutoRedeem] Found proxy address: ${proxyAddress}`,
          );
        }
      } catch {
        this.logger.debug(
          `[AutoRedeem] No proxy address found, using direct wallet`,
        );
      }

      const targetAddress = proxyAddress || wallet.address;
      this.logger.info(
        `[AutoRedeem] Redeeming ${conditionId.slice(0, 16)}... for ${targetAddress.slice(0, 10)}... (proxy=${!!proxyAddress})`,
      );

      // 2) Get fee data with 30% buffer (like reference implementation)
      const feeData = await wallet.provider.getFeeData();
      const maxPriorityFee = feeData.maxPriorityFeePerGas
        ? (feeData.maxPriorityFeePerGas * 130n) / 100n
        : undefined;
      const maxFee = feeData.maxFeePerGas
        ? (feeData.maxFeePerGas * 130n) / 100n
        : undefined;

      const txDetails =
        maxPriorityFee && maxFee
          ? { maxPriorityFeePerGas: maxPriorityFee, maxFeePerGas: maxFee }
          : {};

      // 3) Encode the redemption call
      // Using standard indexSets for binary markets (like reference implementation)
      const ctfInterface = new Interface(CTF_ABI);
      const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
        usdcAddress,
        ZeroHash, // parentCollectionId (always 0x0 for Polymarket)
        conditionId,
        AutoRedeemStrategy.BINARY_MARKET_INDEX_SETS,
      ]);

      // 4) Send transaction (via proxy if available, otherwise direct)
      let tx: TransactionResponse;

      if (
        proxyAddress &&
        proxyAddress.toLowerCase() !== wallet.address.toLowerCase()
      ) {
        // Use proxy contract to forward the call
        this.logger.info(
          `[AutoRedeem] 🔄 Sending via proxy ${proxyAddress.slice(0, 10)}...`,
        );
        const proxyContract = new Contract(
          proxyAddress,
          PROXY_WALLET_ABI,
          wallet,
        );
        tx = (await proxyContract.proxy(
          ctfAddress,
          redeemData,
          txDetails,
        )) as TransactionResponse;
      } else {
        // Direct call to CTF contract
        this.logger.info(`[AutoRedeem] 🔄 Sending direct redemption to CTF...`);
        const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet);
        tx = (await ctfContract.redeemPositions(
          usdcAddress,
          ZeroHash,
          conditionId,
          AutoRedeemStrategy.BINARY_MARKET_INDEX_SETS,
          txDetails,
        )) as TransactionResponse;
      }

      this.logger.info(`[AutoRedeem] ✅ Tx sent: ${tx.hash}`);

      // 5) Wait for confirmation with timeout
      const receipt = await Promise.race([
        tx.wait(),
        new Promise<null>((_, reject) =>
          setTimeout(
            () => reject(new Error("Transaction timeout (45s)")),
            AutoRedeemStrategy.TX_CONFIRMATION_TIMEOUT_MS,
          ),
        ),
      ]);

      if (!receipt || receipt.status !== 1) {
        return {
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          transactionHash: tx.hash,
          error: "Transaction failed or reverted",
        };
      }

      this.logger.info(
        `[AutoRedeem] ✅ Confirmed in block ${receipt.blockNumber}. View: https://polygonscan.com/tx/${tx.hash}`,
      );

      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: true,
        transactionHash: tx.hash,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isRateLimited = this.isRpcRateLimitError(errorMsg);
      const isNonceError = this.isTransactionNonceError(errorMsg);
      const isNotResolvedYet = this.isNotResolvedYetError(errorMsg);

      // Log as warning for transient errors, error for permanent failures
      if (isRateLimited || isNonceError) {
        this.logger.warn(
          `[AutoRedeem] ⚠️ Transient error (will retry): ${errorMsg}`,
        );
      } else {
        this.logger.error(`[AutoRedeem] ❌ Error: ${errorMsg}`);
      }

      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: errorMsg,
        isRateLimited,
        isNotResolvedYet,
        isNonceError,
      };
    }
  }

  /**
   * Check if error is due to RPC rate limiting or transient network issues
   */
  private isRpcRateLimitError(msg: string): boolean {
    return (
      msg.includes("in-flight transaction limit") ||
      msg.includes("rate limit") ||
      msg.includes("Too Many Requests") ||
      msg.includes("429") ||
      msg.includes("-32000") ||
      msg.includes("-32005") ||
      msg.includes("BAD_DATA") ||
      msg.includes("missing response for request")
    );
  }

  /**
   * Check if error is a transaction nonce/replacement issue
   * These errors occur when there are pending transactions and should be retried
   */
  private isTransactionNonceError(msg: string): boolean {
    return (
      msg.includes("REPLACEMENT_UNDERPRICED") ||
      msg.includes("replacement fee too low") ||
      msg.includes("replacement transaction underpriced") ||
      msg.includes("nonce too low") ||
      msg.includes("already known")
    );
  }

  /**
   * Check if error indicates market not resolved yet
   */
  private isNotResolvedYetError(msg: string): boolean {
    return (
      msg.includes("result for condition not received yet") ||
      msg.includes("condition not resolved") ||
      msg.includes("payoutDenominator") ||
      msg.includes("payout denominator") ||
      msg.includes("not resolved")
    );
  }

  /**
   * Simple sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
