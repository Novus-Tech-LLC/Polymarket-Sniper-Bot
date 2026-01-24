import type { ClobClient } from "@polymarket/clob-client";
import { Contract, Interface, formatUnits } from "ethers";
import type { Wallet, TransactionResponse } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { resolvePolymarketContracts } from "../polymarket/contracts";
import { CTF_ABI, ERC20_ABI, PROXY_WALLET_ABI } from "../trading/exchange-abi";
import { AUTO_REDEEM_CHECK_INTERVAL_MS } from "./constants";
import { postOrder } from "../utils/post-order.util";
import type { RelayerContext } from "../polymarket/relayer";
import { executeRelayerTxs } from "../polymarket/relayer";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";

export interface AutoRedeemConfig {
  enabled: boolean;
  /** Minimum position value in USD to redeem (avoids dust) */
  minPositionUsd: number;
  /** Maximum gas price in gwei to pay for redemption */
  maxGasPriceGwei?: number;
  /** Check interval in milliseconds (default: 30000ms = 30 seconds) */
  checkIntervalMs?: number;
  /**
   * Enable fallback sell for winning positions when redemption fails.
   * When enabled, after MAX_REDEMPTION_FAILURES attempts, the strategy will
   * attempt to sell winning positions at 99.9¢ instead of waiting for redemption.
   * This frees up funds faster by bypassing the on-chain redemption process.
   * Default: true
   */
  enableFallbackSell?: boolean;
}

export interface AutoRedeemStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: AutoRedeemConfig;
  /** Optional relayer context for gasless redemptions (recommended) */
  relayer?: RelayerContext;
}

/**
 * Redemption result for a single position
 */
export interface RedemptionResult {
  tokenId: string;
  marketId: string;
  success: boolean;
  transactionHash?: string;
  amountRedeemed?: string;
  error?: string;
  /** True if error was due to RPC rate limiting (e.g., "in-flight transaction limit") */
  isRateLimited?: boolean;
  /** True if error was due to condition not being resolved on-chain yet (oracle hasn't reported results) */
  isNotResolvedYet?: boolean;
}

/**
 * Auto-Redeem Strategy
 *
 * Automatically claims (redeems) resolved market positions to recover USDC.
 * When a market resolves, winning positions can be redeemed for the full $1 per share,
 * and losing positions become worthless (0 redemption value).
 *
 * REQUIRED ENV VARS (that's all you need!):
 * - PRIVATE_KEY: Your wallet's private key (to sign transactions)
 * - RPC_URL: Polygon RPC endpoint (e.g., from Alchemy, Infura, QuickNode)
 *
 * NO Polymarket API keys needed - the data APIs are public.
 *
 * This strategy:
 * 1. Fetches proxy address from Polymarket public API (if any)
 * 2. Gets redeemable positions from the position tracker
 * 3. Calls redeemPositions() via proxy contract or directly on CTF
 * 4. Supports any number of outcomes (binary YES/NO, multi-outcome, over/under, etc.)
 *
 * Benefits:
 * - Automatic capital recovery without manual intervention
 * - No waiting for Polymarket's 4pm UTC daily settlement
 * - Immediate USDC availability for new trades
 *
 * Inspired by: github.com/milanzandbak/polymarketredeemer
 */
export class AutoRedeemStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoRedeemConfig;
  private relayer?: RelayerContext;
  // Track redeemed markets by marketId only (not marketId-tokenId)
  // This is because redeemPositions() redeems ALL positions for a market condition in one tx
  private redeemedMarkets: Set<string> = new Set();
  private redemptionAttempts: Map<
    string,
    { lastAttempt: number; failures: number; isRateLimited?: boolean }
  > = new Map();
  // Track markets where fallback sell was attempted (to avoid repeated sell attempts)
  private fallbackSellAttempted: Set<string> = new Set();
  // Throttling: track last execution time to avoid checking too frequently
  private lastExecutionTime: number = 0;
  private checkIntervalMs: number;
  // Global rate limit flag - when hit, pause ALL redemptions
  private globalRateLimitUntil: number = 0;

  // Constants
  private static readonly MAX_REDEMPTION_FAILURES = 3;
  private static readonly REDEMPTION_RETRY_COOLDOWN_MS = 1 * 60 * 1000; // 1 minute - reduced from 5 min for faster retries
  /**
   * Extended cooldown for RPC rate limit errors (e.g., "in-flight transaction limit reached")
   * These errors indicate the RPC provider is overwhelmed - need longer backoff
   * Default: 15 minutes
   */
  private static readonly RPC_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly DEFAULT_GAS_LIMIT = 300000n;
  /** Timeout for waiting for transaction confirmation */
  private static readonly TX_CONFIRMATION_TIMEOUT_MS = 45000; // 45 seconds
  /** Timeout for API calls (profile lookup, etc.) */
  private static readonly API_TIMEOUT_MS = 10000; // 10 seconds
  // Multiplier to convert USD threshold to minimum share count: minPositionUsd * this = minimum shares to redeem
  // For example, if minPositionUsd = 1, we require at least 0.01 shares to redeem
  // (filters out positions with fractional shares smaller than 0.01 as true dust)
  private static readonly MIN_SHARES_USD_MULTIPLIER = 0.01;
  /**
   * Fallback sell price for winning positions when redemption fails.
   * Selling at 99.9¢ allows immediate exit instead of waiting for on-chain redemption.
   * This is slightly below $1.00 to ensure the sell order gets filled quickly.
   */
  private static readonly FALLBACK_SELL_PRICE = 0.999;
  /**
   * Price threshold for detecting "essentially resolved" winning positions.
   * Positions at >= 99.5¢ are almost certainly resolved winners even if not
   * flagged as redeemable by the API. These should be candidates for fallback sell.
   */
  private static readonly HIGH_PRICE_THRESHOLD = 0.995;
  /**
   * Time after which to reset all failure tracking and try again.
   * After this period, blocked markets get a fresh start.
   * Default: 10 minutes - gives markets time to settle/resolve properly.
   */
  private static readonly FULL_RESET_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
  /**
   * Time after which to retry fallback sell if it failed previously.
   * This allows retrying sell when market conditions may have changed.
   * Default: 5 minutes
   */
  private static readonly FALLBACK_SELL_RETRY_MS = 5 * 60 * 1000; // 5 minutes

  // Track when fallback sell was last attempted (for retry logic)
  private fallbackSellLastAttempt: Map<string, number> = new Map();

  constructor(strategyConfig: AutoRedeemStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
    this.relayer = strategyConfig.relayer;
    // Use configured interval or default from constants
    this.checkIntervalMs =
      strategyConfig.config.checkIntervalMs ?? AUTO_REDEEM_CHECK_INTERVAL_MS;

    // Log relayer availability
    if (this.relayer?.enabled) {
      this.logger.info(
        `[AutoRedeem] ✅ Relayer enabled - using gasless redemptions (recommended)`,
      );
    } else {
      this.logger.info(
        `[AutoRedeem] ⚠️ Relayer not available - using direct contract calls (may hit rate limits)`,
      );
    }
  }

  /**
   * Get the check interval in milliseconds
   */
  getCheckIntervalMs(): number {
    return this.checkIntervalMs;
  }

  /**
   * Execute the auto-redeem strategy
   * Returns number of positions redeemed
   *
   * Note: This method is throttled to only run the full check at the configured interval
   * (default: every 30 seconds). The orchestrator calls this every 2 seconds, but most
   * calls will return early due to throttling. This prevents excessive blockchain calls
   * while still being responsive to resolved markets.
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Throttle: only run full check at the configured interval
    const now = Date.now();
    const timeSinceLastExecution = now - this.lastExecutionTime;
    if (
      this.lastExecutionTime > 0 &&
      timeSinceLastExecution < this.checkIntervalMs
    ) {
      // Not enough time has passed since last check - show when next check will happen
      const nextCheckIn = Math.ceil(
        (this.checkIntervalMs - timeSinceLastExecution) / 1000,
      );
      this.logger.debug(
        `[AutoRedeem] Throttled - next check in ${nextCheckIn}s`,
      );
      return 0;
    }
    this.lastExecutionTime = now;

    // Check global rate limit - if we hit "in-flight transaction limit", pause all redemptions
    if (this.globalRateLimitUntil > now) {
      const remainingSeconds = Math.ceil(
        (this.globalRateLimitUntil - now) / 1000,
      );
      this.logger.info(
        `[AutoRedeem] ⏳ Global rate limit active - paused for ${remainingSeconds}s (RPC provider limit)`,
      );
      return 0;
    }

    this.logger.debug(`[AutoRedeem] 🔄 Running redemption check...`);

    // Clean up stale entries
    this.cleanupStaleEntries();

    let redeemedCount = 0;
    let skippedAlreadyRedeemed = 0;
    let skippedCooldown = 0;
    let skippedMaxFailures = 0;
    let skippedRateLimited = 0;
    let attemptedRedemptions = 0;

    // Get all positions and filter for redeemable ones OR positions at ~100¢ (essentially resolved winners)
    // Positions at >= 99.5¢ are almost certainly resolved winners even if not flagged as redeemable
    const allPositions = this.positionTracker.getPositions();
    const redeemablePositions = allPositions.filter(
      (pos) =>
        pos.redeemable === true ||
        pos.currentPrice >= AutoRedeemStrategy.HIGH_PRICE_THRESHOLD,
    );

    if (redeemablePositions.length === 0) {
      this.logger.debug("[AutoRedeem] No redeemable positions found");
      return 0;
    }

    // Count how many are flagged redeemable vs just high-priced
    const flaggedRedeemable = redeemablePositions.filter(
      (pos) => pos.redeemable === true,
    ).length;
    const highPriced = redeemablePositions.filter(
      (pos) =>
        !pos.redeemable &&
        pos.currentPrice >= AutoRedeemStrategy.HIGH_PRICE_THRESHOLD,
    ).length;

    if (highPriced > 0) {
      this.logger.info(
        `[AutoRedeem] Found ${redeemablePositions.length} position(s) to process (${flaggedRedeemable} redeemable, ${highPriced} at ≥${(AutoRedeemStrategy.HIGH_PRICE_THRESHOLD * 100).toFixed(1)}¢)`,
      );
    } else {
      this.logger.info(
        `[AutoRedeem] Found ${redeemablePositions.length} redeemable position(s)`,
      );
    }

    // Group positions by marketId to avoid duplicate redemption attempts
    // redeemPositions() redeems ALL positions for a market condition in one tx
    const marketIds = new Set(redeemablePositions.map((pos) => pos.marketId));
    const positionsByMarket = new Map<string, Position[]>();
    for (const pos of redeemablePositions) {
      const existing = positionsByMarket.get(pos.marketId) || [];
      existing.push(pos);
      positionsByMarket.set(pos.marketId, existing);
    }

    for (const marketId of marketIds) {
      // Skip if this market was already redeemed
      if (this.redeemedMarkets.has(marketId)) {
        skippedAlreadyRedeemed++;
        this.logger.debug(
          `[AutoRedeem] ⏭️ Skipping market ${marketId.slice(0, 16)}... - already redeemed in this session`,
        );
        continue;
      }

      // Get all positions for this market
      const marketPositions = positionsByMarket.get(marketId) || [];

      // Calculate total position value for this market (for logging purposes)
      // Note: Losing positions have currentPrice=0, but we still need to redeem them to clear from wallet
      const totalValueUsd = marketPositions.reduce(
        (sum, pos) => sum + pos.size * pos.currentPrice,
        0,
      );

      // Calculate total size (for determining if this is dust)
      const totalSize = marketPositions.reduce((sum, pos) => sum + pos.size, 0);

      // Check if we should skip due to recent failures
      const attempts = this.redemptionAttempts.get(marketId);
      if (attempts) {
        // Check if enough time has passed to reset all tracking and try fresh
        const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
        if (timeSinceLastAttempt >= AutoRedeemStrategy.FULL_RESET_COOLDOWN_MS) {
          // Reset all tracking for this market - give it a fresh start
          this.redemptionAttempts.delete(marketId);
          this.fallbackSellAttempted.delete(marketId);
          this.fallbackSellLastAttempt.delete(marketId);
          this.logger.info(
            `[AutoRedeem] 🔄 Reset tracking for market ${marketId.slice(0, 16)}... after ${Math.round(timeSinceLastAttempt / 60000)}min cooldown`,
          );
          // Fall through to attempt redemption
        } else if (
          attempts.failures >= AutoRedeemStrategy.MAX_REDEMPTION_FAILURES
        ) {
          skippedMaxFailures++;
          // Max redemption failures reached
          const enableFallbackSell = this.config.enableFallbackSell !== false; // Default: true
          const isWinning = marketPositions.some((pos) => pos.currentPrice > 0);

          // CRITICAL: Fallback sell only works for positions that are NOT officially resolved
          // Resolved markets have no orderbook, so selling is impossible - must redeem on-chain
          const isTrulyResolved = marketPositions.every(
            (pos) => pos.redeemable === true,
          );

          // Check if we should retry fallback sell (only for non-resolved high-price positions)
          const lastFallbackAttempt =
            this.fallbackSellLastAttempt.get(marketId) || 0;
          const timeSinceFallback = Date.now() - lastFallbackAttempt;
          const canRetryFallback =
            !this.fallbackSellAttempted.has(marketId) ||
            timeSinceFallback >= AutoRedeemStrategy.FALLBACK_SELL_RETRY_MS;

          if (
            enableFallbackSell &&
            isWinning &&
            canRetryFallback &&
            !isTrulyResolved
          ) {
            const isRetry = this.fallbackSellAttempted.has(marketId);
            // Attempt fallback sell at 99.9¢ instead of waiting for redemption
            this.logger.info(
              `[AutoRedeem] 💸 ${isRetry ? "RETRY: " : ""}Redemption failed ${attempts.failures}x - attempting fallback SELL at ${(AutoRedeemStrategy.FALLBACK_SELL_PRICE * 100).toFixed(1)}¢ for market ${marketId}`,
            );

            const sellSuccess = await this.attemptFallbackSell(marketPositions);
            this.fallbackSellAttempted.add(marketId);
            this.fallbackSellLastAttempt.set(marketId, Date.now());

            if (sellSuccess) {
              this.redeemedMarkets.add(marketId); // Mark as handled
              redeemedCount++;
              this.logger.info(
                `[AutoRedeem] ✓ Fallback sell succeeded for market ${marketId} (~$${totalValueUsd.toFixed(2)})`,
              );
            } else {
              this.logger.warn(
                `[AutoRedeem] Fallback sell failed for market ${marketId} - will retry in ${Math.round(AutoRedeemStrategy.FALLBACK_SELL_RETRY_MS / 60000)}min`,
              );
            }
          } else if (isTrulyResolved) {
            // Truly resolved market - fallback sell won't work (no orderbook)
            // Log why and show when retry will happen
            const remainingCooldown = Math.max(
              0,
              Math.ceil(
                (AutoRedeemStrategy.FULL_RESET_COOLDOWN_MS -
                  timeSinceLastAttempt) /
                  60000,
              ),
            );
            this.logger.info(
              `[AutoRedeem] ⚠️ Market ${marketId.slice(0, 16)}... is RESOLVED but redemption failed ${attempts.failures}x. ` +
                `Fallback sell not possible (no orderbook). Will retry redemption in ~${remainingCooldown}min.`,
            );
          } else {
            const nextRetryIn = Math.max(
              0,
              Math.ceil(
                (AutoRedeemStrategy.FALLBACK_SELL_RETRY_MS -
                  timeSinceFallback) /
                  60000,
              ),
            );
            this.logger.debug(
              `[AutoRedeem] Skipping market ${marketId.slice(0, 16)}... - max failures reached${!isWinning ? " (losing position)" : ""}${this.fallbackSellAttempted.has(marketId) ? ` (retry in ${nextRetryIn}min)` : ""}`,
            );
          }
          continue;
        }
        // Check cooldown for normal retry (not at max failures yet)
        const cooldownTimeSinceAttempt = Date.now() - attempts.lastAttempt;
        if (
          cooldownTimeSinceAttempt <
          AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS
        ) {
          skippedCooldown++;
          const remainingCooldown = Math.ceil(
            (AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS -
              cooldownTimeSinceAttempt) /
              1000,
          );
          this.logger.debug(
            `[AutoRedeem] ⏳ Market ${marketId.slice(0, 16)}... in cooldown (${attempts.failures} failures, ${remainingCooldown}s remaining)`,
          );
          continue;
        }
      }

      // Skip only if the total position SIZE is negligible (true dust)
      // We want to redeem even losing positions to clear them from the wallet
      const minShares =
        this.config.minPositionUsd *
        AutoRedeemStrategy.MIN_SHARES_USD_MULTIPLIER;
      if (totalSize < minShares) {
        this.logger.debug(
          `[AutoRedeem] Skipping dust market: ${totalSize.toFixed(4)} shares < ${minShares.toFixed(4)} minimum`,
        );
        continue;
      }

      // Use first position for redemption (all positions in the market will be redeemed together)
      const position = marketPositions[0];

      // Determine if this is a winning or losing position:
      // consider it winning if any position in the market has a positive current price.
      const isWinning = marketPositions.some((pos) => pos.currentPrice > 0);

      // Check if ALL positions are high-priced but NOT flagged as redeemable
      // These are "essentially resolved" winners that we can sell at 99.9¢ immediately
      const isHighPricedNotRedeemable = marketPositions.every(
        (pos) =>
          !pos.redeemable &&
          pos.currentPrice >= AutoRedeemStrategy.HIGH_PRICE_THRESHOLD,
      );

      if (isHighPricedNotRedeemable) {
        // Position is at ~100¢ but not flagged as redeemable - try direct fallback sell
        const enableFallbackSell = this.config.enableFallbackSell !== false; // Default: true
        const firstPosition = marketPositions[0];

        if (enableFallbackSell && !this.fallbackSellAttempted.has(marketId)) {
          this.logger.info(
            `[AutoRedeem] 💰 Position at ${(firstPosition.currentPrice * 100).toFixed(1)}¢ (not yet redeemable) - attempting direct SELL at ${(AutoRedeemStrategy.FALLBACK_SELL_PRICE * 100).toFixed(1)}¢ for market ${marketId}`,
          );

          const sellSuccess = await this.attemptFallbackSell(marketPositions);
          this.fallbackSellAttempted.add(marketId);

          if (sellSuccess) {
            this.redeemedMarkets.add(marketId); // Mark as handled
            redeemedCount++;
            this.logger.info(
              `[AutoRedeem] ✓ Direct sell succeeded for high-priced market ${marketId} (~$${totalValueUsd.toFixed(2)})`,
            );
          } else {
            this.logger.warn(
              `[AutoRedeem] Direct sell failed for market ${marketId} - will wait for official resolution`,
            );
          }
        }
        continue;
      }

      attemptedRedemptions++;
      this.logger.info(
        `[AutoRedeem] Attempting to redeem ${isWinning ? "WINNING" : "LOSING"} market: market=${marketId}, positions=${marketPositions.length}, shares=${totalSize.toFixed(2)}, value=$${totalValueUsd.toFixed(2)}`,
      );

      try {
        const result = await this.redeemPosition(position);

        if (result.success) {
          // Mark entire market as redeemed (all positions for this market are now redeemed)
          this.redeemedMarkets.add(marketId);
          redeemedCount++;
          // Show actual redeemed amount if available, otherwise show estimated value
          const actualRedeemed = result.amountRedeemed ? `$${result.amountRedeemed}` : `~$${totalValueUsd.toFixed(2)}`;
          this.logger.info(
            `[AutoRedeem] ✓ Successfully redeemed market ${marketId} (${actualRedeemed}) (tx: ${result.transactionHash})`,
          );
        } else {
          // Check if this was a rate limit error - if so, set global pause
          if (result.isRateLimited) {
            this.globalRateLimitUntil =
              Date.now() + AutoRedeemStrategy.RPC_RATE_LIMIT_COOLDOWN_MS;
            this.logger.warn(
              `[AutoRedeem] 🚫 RPC rate limit hit - pausing ALL redemptions for ${AutoRedeemStrategy.RPC_RATE_LIMIT_COOLDOWN_MS / 60000} minutes`,
            );
            // Don't count as failure - this is a temporary rate limit, not a position problem
            break; // Stop trying more redemptions this cycle
          }

          // Check if condition is not resolved on-chain yet - don't count as failure
          // The oracle just hasn't reported results yet, will retry later
          if (result.isNotResolvedYet) {
            // Set a short cooldown (1 minute) to avoid spamming checks
            this.redemptionAttempts.set(marketId, {
              lastAttempt: Date.now(),
              failures: 0, // Don't increment failures - this is expected behavior
            });
            // Don't log as failure - already logged in redeemPosition()
            continue;
          }

          // Track failure by marketId
          const currentAttempts = this.redemptionAttempts.get(marketId) || {
            lastAttempt: 0,
            failures: 0,
          };
          this.redemptionAttempts.set(marketId, {
            lastAttempt: Date.now(),
            failures: currentAttempts.failures + 1,
          });
          this.logger.warn(
            `[AutoRedeem] Failed to redeem market ${marketId}: ${result.error}`,
          );
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Track failure by marketId
        const currentAttempts = this.redemptionAttempts.get(marketId) || {
          lastAttempt: 0,
          failures: 0,
        };
        this.redemptionAttempts.set(marketId, {
          lastAttempt: Date.now(),
          failures: currentAttempts.failures + 1,
        });
        this.logger.error(
          `[AutoRedeem] Error redeeming market ${marketId}: ${errorMsg}`,
        );
      }

      // Add small delay between redemption attempts to avoid overwhelming RPC
      // This helps prevent "in-flight transaction limit" errors
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay between redemptions
    }

    // Log summary of redemption activity
    if (redeemedCount > 0) {
      this.logger.info(`[AutoRedeem] ✅ Redeemed ${redeemedCount} market(s)`);
    }

    // Log diagnostic info if we have redeemable positions but didn't attempt any redemptions
    const totalSkipped =
      skippedAlreadyRedeemed +
      skippedCooldown +
      skippedMaxFailures +
      skippedRateLimited;
    if (attemptedRedemptions === 0 && totalSkipped > 0) {
      this.logger.info(
        `[AutoRedeem] ⚠️ ${redeemablePositions.length} redeemable but ${totalSkipped} skipped: ` +
          `${skippedAlreadyRedeemed} already redeemed, ${skippedCooldown} in cooldown, ${skippedMaxFailures} max failures`,
      );
    }

    return redeemedCount;
  }

  /**
   * Redeem a single position by calling the CTF contract
   * 
   * Simple approach inspired by github.com/milanzandbak/polymarketredeemer:
   * 1. Get proxy address from Polymarket API (if any)
   * 2. If proxy exists, call proxy.proxy(CTF, redeemData)
   * 3. If no proxy, call CTF.redeemPositions() directly
   * 4. Always use [1, 2] index sets to cover both YES and NO outcomes
   * 
   * NOTE: This only requires a private key and RPC URL - no Polymarket API keys needed!
   * The data-api.polymarket.com endpoints are public.
   */
  /**
   * Check if a condition has been resolved on-chain by querying payoutDenominator.
   * Returns true only when the oracle has reported the results (payoutDenominator > 0).
   * This prevents attempting redemption before on-chain resolution.
   */
  private async isConditionResolvedOnChain(
    wallet: Wallet,
    ctfAddress: string,
    conditionId: string,
  ): Promise<{ resolved: boolean; error?: string }> {
    try {
      const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet.provider);
      const payoutDenominator = await ctfContract.payoutDenominator(conditionId);
      // payoutDenominator is 0 when condition is not resolved, > 0 when resolved
      const resolved = BigInt(payoutDenominator) > 0n;
      return { resolved };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { resolved: false, error: errorMsg };
    }
  }

  private async redeemPosition(position: Position): Promise<RedemptionResult> {
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

    const conditionId = position.marketId;

    // Validate conditionId format (should be a bytes32 hex string)
    if (!conditionId?.startsWith("0x") || conditionId.length !== 66) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: `Invalid conditionId format: ${conditionId}`,
      };
    }

    // CRITICAL: Check if condition is actually resolved on-chain before attempting redemption
    // The API may mark positions as "redeemable" before the oracle has reported results
    const resolutionCheck = await this.isConditionResolvedOnChain(
      wallet,
      ctfAddress,
      conditionId,
    );

    if (resolutionCheck.error) {
      this.logger.warn(
        `[AutoRedeem] ⚠️ Could not verify on-chain resolution for ${conditionId.slice(0, 16)}...: ${resolutionCheck.error}`,
      );
      // Continue anyway - let the actual redemption call fail if not resolved
    } else if (!resolutionCheck.resolved) {
      // Condition not resolved on-chain yet - skip redemption attempt
      this.logger.info(
        `[AutoRedeem] ⏳ Market ${conditionId.slice(0, 16)}... marked redeemable but NOT resolved on-chain yet (oracle hasn't reported results)`,
      );
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: "Condition not resolved on-chain yet (payoutDenominator=0)",
        isNotResolvedYet: true,
      };
    } else {
      this.logger.debug(
        `[AutoRedeem] ✓ On-chain resolution confirmed for ${conditionId.slice(0, 16)}...`,
      );
    }

    try {
      // Step 1: Get proxy address from Polymarket public API (no auth needed)
      let proxyAddress: string | null = null;
      try {
        const profileUrl = POLYMARKET_API.PROFILE_ENDPOINT(wallet.address);
        const profileData = await httpGet<{ proxyAddress?: string }>(profileUrl, {
          timeout: AutoRedeemStrategy.API_TIMEOUT_MS,
        });
        if (profileData?.proxyAddress) {
          proxyAddress = profileData.proxyAddress;
          this.logger.debug(`[AutoRedeem] Found proxy address: ${proxyAddress}`);
        }
      } catch {
        // No proxy found or API timeout - will use direct call
        this.logger.debug(`[AutoRedeem] No proxy address found, using direct wallet`);
      }

      // Determine which address holds the tokens
      const targetAddress = proxyAddress || wallet.address;
      this.logger.info(`[AutoRedeem] Redeeming for ${targetAddress} (proxy=${!!proxyAddress})`);

      // Step 2: Build the redeemPositions call data
      // Index sets in CTF are powers of 2: outcome 0 = 1, outcome 1 = 2, outcome 2 = 4, etc.
      // Use the actual outcome slot count to avoid "invalid index set" reverts on non-binary markets.
      // The CTF contract safely ignores index sets you don't hold tokens for.
      const outcomeSlotCount = await this.fetchOutcomeSlotCount(
        position.tokenId,
        conditionId,
      );
      const safeOutcomeSlotCount =
        outcomeSlotCount && outcomeSlotCount > 0 ? outcomeSlotCount : 2;

      if (!outcomeSlotCount || outcomeSlotCount <= 0) {
        this.logger.warn(
          `[AutoRedeem] ⚠️ Unable to determine outcome slot count for market ${conditionId.slice(0, 16)}... - defaulting to 2 outcomes`,
        );
      }

      const indexSets = Array.from(
        { length: safeOutcomeSlotCount },
        (_, i) => Math.pow(2, i),
      );
      
      const ctfInterface = new Interface(CTF_ABI);
      const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
        usdcAddress,
        "0x0000000000000000000000000000000000000000000000000000000000000000", // parentCollectionId = bytes32(0)
        conditionId,
        indexSets,
      ]);

      // Step 3: Get gas fees with 30% buffer (like reference implementation)
      if (!wallet.provider) {
        return {
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          error: "No provider available",
        };
      }
      const feeData = await wallet.provider.getFeeData();
      const maxPriorityFee = feeData.maxPriorityFeePerGas 
        ? (feeData.maxPriorityFeePerGas * 130n) / 100n 
        : undefined;
      const maxFee = feeData.maxFeePerGas 
        ? (feeData.maxFeePerGas * 130n) / 100n 
        : undefined;
      const txOptions = maxPriorityFee && maxFee
        ? { maxPriorityFeePerGas: maxPriorityFee, maxFeePerGas: maxFee }
        : {}; // Fall back to provider defaults if fee data unavailable

      // Step 4: Execute the redemption
      let tx: TransactionResponse;

      if (proxyAddress) {
        // Use proxy contract to execute redemption
        this.logger.info(`[AutoRedeem] 🔄 Sending redemption via proxy ${proxyAddress.slice(0, 10)}...`);
        const proxyContract = new Contract(proxyAddress, PROXY_WALLET_ABI, wallet);
        tx = await proxyContract.proxy(ctfAddress, redeemData, txOptions) as TransactionResponse;
      } else {
        // Direct call to CTF contract (no proxy)
        this.logger.info(`[AutoRedeem] 🔄 Sending direct redemption to CTF...`);
        const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet);
        tx = await ctfContract.redeemPositions(
          usdcAddress,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          conditionId,
          indexSets,
          txOptions,
        ) as TransactionResponse;
      }

      this.logger.info(`[AutoRedeem] ✅ Tx sent: ${tx.hash}`);

      // Step 5: Wait for confirmation with timeout
      const receipt = await Promise.race([
        tx.wait(),
        new Promise<null>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Transaction timeout (${AutoRedeemStrategy.TX_CONFIRMATION_TIMEOUT_MS / 1000}s)`)),
            AutoRedeemStrategy.TX_CONFIRMATION_TIMEOUT_MS
          )
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
        `[AutoRedeem] ✅ Confirmed in block ${receipt.blockNumber}. ` +
        `View on Polygonscan: https://polygonscan.com/tx/${tx.hash}`
      );

      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: true,
        transactionHash: tx.hash,
      };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[AutoRedeem] ❌ Error: ${errorMsg}`);

      // Check for rate limit errors
      const isRateLimitError =
        errorMsg.includes("in-flight transaction limit") ||
        errorMsg.includes("-32000");

      // Check for "not resolved yet" errors from the contract
      // This can happen if our on-chain check failed but we tried anyway
      const isNotResolvedYet =
        errorMsg.includes("result for condition not received yet") ||
        errorMsg.includes("condition not resolved");

      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: errorMsg,
        isRateLimited: isRateLimitError,
        isNotResolvedYet: isNotResolvedYet,
      };
    }
  }

  /**
   * Fetch the number of outcomes for a market so we can build valid index sets.
   * Uses the Gamma API via the tokenId (same approach as outcome fetching).
   */
  private async fetchOutcomeSlotCount(
    tokenId: string,
    marketId: string,
  ): Promise<number | null> {
    if (!tokenId || typeof tokenId !== "string") {
      return null;
    }

    try {
      interface GammaMarketResponse {
        outcomes?: string; // JSON string like '["Yes","No"]'
        tokens?: Array<{ outcome?: string }>;
      }

      const encodedTokenId = encodeURIComponent(tokenId.trim());
      const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;
      const markets = await httpGet<GammaMarketResponse[]>(url, {
        timeout: AutoRedeemStrategy.API_TIMEOUT_MS,
      });

      if (!markets || !Array.isArray(markets) || markets.length === 0) {
        return null;
      }

      const market = markets[0];

      if (market.outcomes) {
        try {
          const outcomes = JSON.parse(market.outcomes);
          if (Array.isArray(outcomes) && outcomes.length > 0) {
            return outcomes.length;
          }
        } catch (error) {
          this.logger.debug(
            `[AutoRedeem] Failed parsing outcomes for ${marketId.slice(0, 16)}...: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (market.tokens && Array.isArray(market.tokens)) {
        const tokenCount = market.tokens.length;
        if (tokenCount > 0) {
          return tokenCount;
        }
      }
    } catch (error) {
      this.logger.debug(
        `[AutoRedeem] Failed fetching outcomes for ${marketId.slice(0, 16)}...: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return null;
  }

  /**
   * Clean up stale entries from tracking Maps/Sets
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentMarketIds = new Set(
      currentPositions.map((pos) => pos.marketId),
    );

    // Clean up redeemed markets that are no longer tracked
    let cleanedRedeemed = 0;
    const redeemedKeysToDelete: string[] = [];
    for (const marketId of this.redeemedMarkets) {
      if (!currentMarketIds.has(marketId)) {
        redeemedKeysToDelete.push(marketId);
      }
    }
    for (const key of redeemedKeysToDelete) {
      this.redeemedMarkets.delete(key);
      cleanedRedeemed++;
    }

    // Clean up redemption attempts for markets that no longer exist
    let cleanedAttempts = 0;
    const attemptsKeysToDelete: string[] = [];
    for (const marketId of this.redemptionAttempts.keys()) {
      if (!currentMarketIds.has(marketId)) {
        attemptsKeysToDelete.push(marketId);
      }
    }
    for (const key of attemptsKeysToDelete) {
      this.redemptionAttempts.delete(key);
      cleanedAttempts++;
    }

    // Clean up fallback sell attempts for markets that no longer exist
    let cleanedFallbackSell = 0;
    const fallbackSellKeysToDelete: string[] = [];
    for (const marketId of this.fallbackSellAttempted) {
      if (!currentMarketIds.has(marketId)) {
        fallbackSellKeysToDelete.push(marketId);
      }
    }
    for (const key of fallbackSellKeysToDelete) {
      this.fallbackSellAttempted.delete(key);
      this.fallbackSellLastAttempt.delete(key);
      cleanedFallbackSell++;
    }

    if (cleanedRedeemed > 0 || cleanedAttempts > 0 || cleanedFallbackSell > 0) {
      this.logger.debug(
        `[AutoRedeem] Cleaned up ${cleanedRedeemed} redeemed, ${cleanedAttempts} attempt, and ${cleanedFallbackSell} fallback sell entries`,
      );
    }
  }

  /**
   * Attempt to sell winning positions at 99.9¢ as a fallback when redemption fails.
   * This frees up funds immediately instead of waiting for on-chain redemption.
   *
   * @param positions - The positions to sell (all for the same market)
   * @returns true if at least one sell succeeded
   */
  private async attemptFallbackSell(positions: Position[]): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.warn("[AutoRedeem] No wallet available for fallback sell");
      return false;
    }

    // Check if on-chain mode is enabled - fallback sell won't work in on-chain mode
    // because the on-chain executor doesn't support order execution yet
    const tradeMode = (process.env.TRADE_MODE ?? "clob").toLowerCase();
    if (tradeMode === "onchain") {
      this.logger.warn(
        `[AutoRedeem] ⚠️ TRADE_MODE=onchain - fallback sell NOT SUPPORTED. ` +
          `On-chain trading requires maker order integration (not implemented). ` +
          `Use TRADE_MODE=clob for selling, or rely on on-chain redemption only.`,
      );
      return false;
    }

    let anySuccess = false;

    for (const position of positions) {
      // Only sell winning positions (currentPrice > 0)
      if (position.currentPrice <= 0) {
        continue;
      }

      try {
        // Calculate sell size at 99.9¢
        const sizeUsd = position.size * AutoRedeemStrategy.FALLBACK_SELL_PRICE;

        this.logger.info(
          `[AutoRedeem] 💰 Fallback selling ${position.size.toFixed(2)} shares of ${position.side} at ${(AutoRedeemStrategy.FALLBACK_SELL_PRICE * 100).toFixed(1)}¢ (~$${sizeUsd.toFixed(2)})`,
        );

        // Normalize outcome for order API - tokenId is what identifies the actual outcome
        const orderOutcome = this.normalizeOutcomeForOrder(position.side);

        const result = await postOrder({
          client: this.client,
          wallet,
          marketId: position.marketId,
          tokenId: position.tokenId,
          outcome: orderOutcome,
          side: "SELL",
          sizeUsd,
          maxAcceptablePrice: AutoRedeemStrategy.FALLBACK_SELL_PRICE,
          logger: this.logger,
          skipDuplicatePrevention: true, // This is a deliberate fallback action
          skipMinOrderSizeCheck: true, // Allow small positions
        });

        if (result.status === "submitted") {
          this.logger.info(
            `[AutoRedeem] ✓ Fallback sell order submitted for ${position.tokenId.slice(0, 12)}...`,
          );
          anySuccess = true;
        } else {
          this.logger.warn(
            `[AutoRedeem] Fallback sell skipped/failed for ${position.tokenId.slice(0, 12)}...: ${result.reason ?? "unknown"}`,
          );
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[AutoRedeem] Error during fallback sell for ${position.tokenId.slice(0, 12)}...: ${errorMsg}`,
        );
      }
    }

    return anySuccess;
  }

  /**
   * Normalize an outcome string to the OrderOutcome type expected by postOrder.
   *
   * For YES/NO markets: returns "YES" or "NO" as-is
   * For multi-outcome markets (e.g., "Bucks", "Over", "Medjedovic"): returns "YES" as placeholder
   *
   * The tokenId is what actually identifies the specific outcome for order execution,
   * so the outcome field is primarily for logging and internal bookkeeping.
   */
  private normalizeOutcomeForOrder(outcome: string | undefined): "YES" | "NO" {
    if (!outcome) {
      return "YES";
    }
    const upper = outcome.toUpperCase();
    if (upper === "YES" || upper === "NO") {
      return upper as "YES" | "NO";
    }
    // For non-YES/NO markets, use "YES" as placeholder - tokenId identifies the actual outcome
    return "YES";
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    redeemedCount: number;
    pendingRedemptions: number;
    minPositionUsd: number;
    checkIntervalMs: number;
    nextCheckInMs: number;
  } {
    const allPositions = this.positionTracker.getPositions();
    // Count unique markets with redeemable positions that haven't been redeemed yet
    const redeemableMarkets = new Set(
      allPositions
        .filter(
          (pos) =>
            pos.redeemable === true && !this.redeemedMarkets.has(pos.marketId),
        )
        .map((pos) => pos.marketId),
    );

    // Calculate time until next check
    // Handle potential clock drift or system clock changes
    const timeSinceLastCheck = Math.max(0, Date.now() - this.lastExecutionTime);
    const nextCheckInMs = Math.max(
      0,
      this.checkIntervalMs - timeSinceLastCheck,
    );

    return {
      enabled: this.config.enabled,
      redeemedCount: this.redeemedMarkets.size,
      pendingRedemptions: redeemableMarkets.size,
      minPositionUsd: this.config.minPositionUsd,
      checkIntervalMs: this.checkIntervalMs,
      nextCheckInMs,
    };
  }

  /**
   * Force redeem all eligible positions (for manual CLI trigger)
   */
  async forceRedeemAll(): Promise<RedemptionResult[]> {
    const results: RedemptionResult[] = [];

    const allPositions = this.positionTracker.getPositions();
    const redeemablePositions = allPositions.filter(
      (pos) => pos.redeemable === true,
    );

    if (redeemablePositions.length === 0) {
      this.logger.info("[AutoRedeem] No redeemable positions to force redeem");
      return results;
    }

    // Group by marketId to avoid duplicate redemption attempts
    const marketIds = new Set(redeemablePositions.map((pos) => pos.marketId));
    const positionsByMarket = new Map<string, Position[]>();
    for (const pos of redeemablePositions) {
      const existing = positionsByMarket.get(pos.marketId) || [];
      existing.push(pos);
      positionsByMarket.set(pos.marketId, existing);
    }

    this.logger.info(
      `[AutoRedeem] Force redeeming ${marketIds.size} market(s) (${redeemablePositions.length} position(s))`,
    );

    for (const marketId of marketIds) {
      // Skip if already redeemed
      if (this.redeemedMarkets.has(marketId)) {
        this.logger.debug(`[AutoRedeem] Market ${marketId} already redeemed`);
        continue;
      }

      const marketPositions = positionsByMarket.get(marketId) || [];
      const position = marketPositions[0];

      try {
        const result = await this.redeemPosition(position);
        results.push(result);

        if (result.success) {
          this.redeemedMarkets.add(marketId);
          this.logger.info(
            `[AutoRedeem] ✓ Force redeemed market: ${marketId} (tx: ${result.transactionHash})`,
          );
        } else {
          this.logger.warn(
            `[AutoRedeem] Force redeem failed: ${marketId} - ${result.error}`,
          );
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          error: errorMsg,
        });
        this.logger.error(
          `[AutoRedeem] Error during force redeem: ${errorMsg}`,
        );
      }
    }

    return results;
  }

  /**
   * Reset redeemed markets tracking (for testing or daily reset)
   */
  reset(): void {
    this.redeemedMarkets.clear();
    this.redemptionAttempts.clear();
    this.fallbackSellAttempted.clear();
    this.fallbackSellLastAttempt.clear();
  }
}
