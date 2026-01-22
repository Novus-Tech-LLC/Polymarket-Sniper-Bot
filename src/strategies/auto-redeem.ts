import type { ClobClient } from "@polymarket/clob-client";
import { Contract, formatUnits } from "ethers";
import type { Wallet, TransactionResponse } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { resolvePolymarketContracts } from "../polymarket/contracts";
import { CTF_ABI, ERC20_ABI } from "../trading/exchange-abi";

export interface AutoRedeemConfig {
  enabled: boolean;
  /** Minimum position value in USD to redeem (avoids dust) */
  minPositionUsd: number;
  /** Maximum gas price in gwei to pay for redemption */
  maxGasPriceGwei?: number;
}

export interface AutoRedeemStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: AutoRedeemConfig;
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
}

/**
 * Auto-Redeem Strategy
 *
 * Automatically claims (redeems) resolved market positions to recover USDC.
 * When a market resolves, winning positions can be redeemed for the full $1 per share,
 * and losing positions become worthless (0 redemption value).
 *
 * This strategy:
 * 1. Identifies positions marked as "redeemable" (market resolved)
 * 2. Calls the CTF contract's redeemPositions() to claim USDC
 * 3. Frees up capital that would otherwise sit idle
 *
 * Benefits:
 * - Automatic capital recovery without manual intervention
 * - No waiting for Polymarket's 4pm UTC daily settlement
 * - Immediate USDC availability for new trades
 */
export class AutoRedeemStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoRedeemConfig;
  // Track redeemed markets by marketId only (not marketId-tokenId)
  // This is because redeemPositions() redeems ALL positions for a market condition in one tx
  private redeemedMarkets: Set<string> = new Set();
  private redemptionAttempts: Map<string, { lastAttempt: number; failures: number }> = new Map();

  // Constants
  private static readonly MAX_REDEMPTION_FAILURES = 3;
  private static readonly REDEMPTION_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly DEFAULT_GAS_LIMIT = 300000n;

  constructor(strategyConfig: AutoRedeemStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Execute the auto-redeem strategy
   * Returns number of positions redeemed
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Clean up stale entries
    this.cleanupStaleEntries();

    let redeemedCount = 0;

    // Get all positions and filter for redeemable ones
    const allPositions = this.positionTracker.getPositions();
    const redeemablePositions = allPositions.filter((pos) => pos.redeemable === true);

    if (redeemablePositions.length === 0) {
      this.logger.debug("[AutoRedeem] No redeemable positions found");
      return 0;
    }

    this.logger.info(
      `[AutoRedeem] Found ${redeemablePositions.length} redeemable position(s)`,
    );

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
        continue;
      }

      // Check if we should skip due to recent failures
      const attempts = this.redemptionAttempts.get(marketId);
      if (attempts) {
        if (attempts.failures >= AutoRedeemStrategy.MAX_REDEMPTION_FAILURES) {
          this.logger.debug(
            `[AutoRedeem] Skipping market ${marketId} - max failures reached`,
          );
          continue;
        }
        if (Date.now() - attempts.lastAttempt < AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS) {
          continue;
        }
      }

      // Get all positions for this market
      const marketPositions = positionsByMarket.get(marketId) || [];
      
      // Calculate total position value for this market
      const totalValueUsd = marketPositions.reduce(
        (sum, pos) => sum + pos.size * pos.currentPrice,
        0,
      );

      // Skip if total value is below threshold
      if (totalValueUsd < this.config.minPositionUsd) {
        this.logger.debug(
          `[AutoRedeem] Skipping dust market: $${totalValueUsd.toFixed(2)} < $${this.config.minPositionUsd} minimum`,
        );
        continue;
      }

      // Use first position for redemption (all positions in the market will be redeemed together)
      const position = marketPositions[0];
      
      this.logger.info(
        `[AutoRedeem] Attempting to redeem market: market=${marketId}, positions=${marketPositions.length}, total_value=$${totalValueUsd.toFixed(2)}`,
      );

      try {
        const result = await this.redeemPosition(position);

        if (result.success) {
          // Mark entire market as redeemed (all positions for this market are now redeemed)
          this.redeemedMarkets.add(marketId);
          redeemedCount++;
          this.logger.info(
            `[AutoRedeem] ✓ Successfully redeemed market ${marketId} (~$${totalValueUsd.toFixed(2)}) (tx: ${result.transactionHash})`,
          );
        } else {
          // Track failure by marketId
          const currentAttempts = this.redemptionAttempts.get(marketId) || { lastAttempt: 0, failures: 0 };
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
        const currentAttempts = this.redemptionAttempts.get(marketId) || { lastAttempt: 0, failures: 0 };
        this.redemptionAttempts.set(marketId, {
          lastAttempt: Date.now(),
          failures: currentAttempts.failures + 1,
        });
        this.logger.error(
          `[AutoRedeem] Error redeeming market ${marketId}: ${errorMsg}`,
        );
      }
    }

    if (redeemedCount > 0) {
      this.logger.info(
        `[AutoRedeem] Redeemed ${redeemedCount} market(s)`,
      );
    }

    return redeemedCount;
  }

  /**
   * Redeem a single position by calling the CTF contract
   */
  private async redeemPosition(position: Position): Promise<RedemptionResult> {
    // Access wallet from client - this is a common pattern in the codebase
    // The ClobClient is extended with a wallet property by the factory
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

    if (!ctfAddress) {
      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: "CTF contract address not configured",
      };
    }

    try {
      // Create CTF contract instance
      const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet);

      // Get USDC balance before redemption (for logging)
      const usdcContract = new Contract(usdcAddress, ERC20_ABI, wallet);
      const balanceBefore = await usdcContract.balanceOf(wallet.address) as bigint;

      // For Polymarket, the conditionId is the marketId
      // The parentCollectionId is always bytes32(0) for top-level positions
      const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";
      const conditionId = position.marketId;

      // Determine index sets dynamically based on the position's side.
      // For multi-outcome markets, `position.side` can be > 2 (e.g., 3, 4, ...).
      // For YES/NO markets: indexSet 1 = YES, indexSet 2 = NO.
      // The CTF contract will only redeem positions that have value based on resolution.
      let indexSets: number[];
      const side = position.side;
      if (typeof side === "number" && Number.isFinite(side)) {
        // Numeric side directly represents the outcome index set
        indexSets = [side];
      } else if (typeof side === "string") {
        const sideStr = side.toUpperCase();
        if (sideStr === "YES") {
          indexSets = [1];
        } else if (sideStr === "NO") {
          indexSets = [2];
        } else {
          // Unknown string side (could be multi-outcome market name like "Player A")
          // Fall back to binary default [1, 2] to attempt redemption
          indexSets = [1, 2];
        }
      } else {
        // No usable side information; fall back to binary default
        indexSets = [1, 2];
      }

      this.logger.debug(
        `[AutoRedeem] Calling redeemPositions: collateral=${usdcAddress}, parentCollectionId=${parentCollectionId}, conditionId=${conditionId}, indexSets=[${indexSets.join(",")}], side=${position.side}`,
      );

      // Check gas price if configured
      if (this.config.maxGasPriceGwei) {
        if (!wallet.provider) {
          return {
            tokenId: position.tokenId,
            marketId: position.marketId,
            success: false,
            error: "No provider available for gas price check",
          };
        }
        const feeData = await wallet.provider.getFeeData();
        const gasPriceGwei = feeData.gasPrice ? Number(feeData.gasPrice) / 1e9 : 0;
        if (gasPriceGwei > this.config.maxGasPriceGwei) {
          return {
            tokenId: position.tokenId,
            marketId: position.marketId,
            success: false,
            error: `Gas price ${gasPriceGwei.toFixed(2)} gwei exceeds max ${this.config.maxGasPriceGwei} gwei`,
          };
        }
      }

      // Execute redemption transaction
      const tx = await ctfContract.redeemPositions(
        usdcAddress,
        parentCollectionId,
        conditionId,
        indexSets,
        { gasLimit: AutoRedeemStrategy.DEFAULT_GAS_LIMIT },
      ) as TransactionResponse;

      this.logger.info(`[AutoRedeem] Redemption tx submitted: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait(1);

      if (!receipt || receipt.status !== 1) {
        return {
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          transactionHash: tx.hash,
          error: "Transaction failed or reverted",
        };
      }

      // Get USDC balance after redemption
      const balanceAfter = await usdcContract.balanceOf(wallet.address) as bigint;
      const amountRedeemed = balanceAfter - balanceBefore;
      const amountRedeemedFormatted = formatUnits(amountRedeemed, 6);

      this.logger.info(
        `[AutoRedeem] Redemption confirmed in block ${receipt.blockNumber}, redeemed $${amountRedeemedFormatted} USDC`,
      );

      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: true,
        transactionHash: tx.hash,
        amountRedeemed: amountRedeemedFormatted,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Handle specific error cases
      if (errorMsg.includes("insufficient funds")) {
        return {
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          error: "Insufficient gas funds for redemption",
        };
      }

      if (errorMsg.includes("execution reverted") || errorMsg.includes("revert")) {
        // Position may already be redeemed or condition not resolved
        return {
          tokenId: position.tokenId,
          marketId: position.marketId,
          success: false,
          error: `Contract reverted: ${errorMsg}`,
        };
      }

      return {
        tokenId: position.tokenId,
        marketId: position.marketId,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Clean up stale entries from tracking Maps/Sets
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentMarketIds = new Set(currentPositions.map((pos) => pos.marketId));

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

    if (cleanedRedeemed > 0 || cleanedAttempts > 0) {
      this.logger.debug(
        `[AutoRedeem] Cleaned up ${cleanedRedeemed} redeemed and ${cleanedAttempts} attempt entries`,
      );
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    redeemedCount: number;
    pendingRedemptions: number;
    minPositionUsd: number;
  } {
    const allPositions = this.positionTracker.getPositions();
    // Count unique markets with redeemable positions that haven't been redeemed yet
    const redeemableMarkets = new Set(
      allPositions
        .filter((pos) => pos.redeemable === true && !this.redeemedMarkets.has(pos.marketId))
        .map((pos) => pos.marketId),
    );

    return {
      enabled: this.config.enabled,
      redeemedCount: this.redeemedMarkets.size,
      pendingRedemptions: redeemableMarkets.size,
      minPositionUsd: this.config.minPositionUsd,
    };
  }

  /**
   * Force redeem all eligible positions (for manual CLI trigger)
   */
  async forceRedeemAll(): Promise<RedemptionResult[]> {
    const results: RedemptionResult[] = [];

    const allPositions = this.positionTracker.getPositions();
    const redeemablePositions = allPositions.filter((pos) => pos.redeemable === true);

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
  }
}
