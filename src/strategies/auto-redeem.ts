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
import type { PositionTracker, Position } from "./position-tracker";
import type { RelayerContext } from "../polymarket/relayer";
import { httpGet } from "../utils/fetch-data.util";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { resolvePolymarketContracts } from "../polymarket/contracts";
import { CTF_ABI, PROXY_WALLET_ABI } from "../trading/exchange-abi";

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
}

/**
 * Auto-Redeem Strategy Options
 */
export interface AutoRedeemStrategyOptions {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  relayer?: RelayerContext;
  config: AutoRedeemConfig;
}

/**
 * Auto-Redeem Strategy
 *
 * Automatically claims resolved positions to recover USDC.
 */
export class AutoRedeemStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoRedeemConfig;

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

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

  constructor(options: AutoRedeemStrategyOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.positionTracker = options.positionTracker;
    this.config = options.config;
  }

  /**
   * Execute the auto-redeem check cycle
   * Called by the orchestrator on a schedule
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   *
   * @returns The number of successful redemptions
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard: prevent concurrent execution
    if (this.inFlight) {
      this.logger.debug("[AutoRedeem] Skipped - already in flight");
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
    const redeemablePositions = this.getRedeemablePositions();

    if (redeemablePositions.length === 0) {
      return 0;
    }

    this.logger.info(
      `[AutoRedeem] Found ${redeemablePositions.length} redeemable position(s)`,
    );

    let successCount = 0;

    for (const position of redeemablePositions) {
      // Check if we should skip due to recent failures
      if (this.shouldSkipRedemption(position.marketId)) {
        continue;
      }

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

    return successCount;
  }

  /**
   * Force redeem all positions (for CLI use)
   */
  async forceRedeemAll(): Promise<RedemptionResult[]> {
    const redeemablePositions = this.getRedeemablePositions();

    if (redeemablePositions.length === 0) {
      this.logger.info("[AutoRedeem] No redeemable positions found");
      return [];
    }

    const results: RedemptionResult[] = [];

    for (const position of redeemablePositions) {
      const result = await this.redeemPositionWithRetry(position);
      results.push(result);

      // Longer delay between redemptions
      if (
        redeemablePositions.indexOf(position) <
        redeemablePositions.length - 1
      ) {
        await this.sleep(AutoRedeemStrategy.REDEMPTION_DELAY_MS);
      }
    }

    return results;
  }

  /**
   * Get positions that are marked as redeemable
   */
  private getRedeemablePositions(): Position[] {
    return this.positionTracker
      .getPositions()
      .filter((pos) => pos.redeemable === true)
      .filter(
        (pos) => pos.size * pos.currentPrice >= this.config.minPositionUsd,
      );
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
    position: Position,
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
