import type { ClobClient } from "@polymarket/clob-client";
import type { RuntimeEnv } from "../config/env";
import type { Logger } from "../utils/logger.util";
import type { TradeSignal } from "../domain/trade.types";
import { JsonRpcProvider } from "ethers";
import { httpGet } from "../utils/fetch-data.util";
import axios from "axios";
import {
  POLYMARKET_CONTRACTS,
  POLYMARKET_API,
  DEFAULT_CONFIG,
} from "../constants/polymarket.constants";
import {
  sanitizeAxiosError,
  sanitizeErrorMessage,
} from "../utils/sanitize-axios-error.util";
import { parallelBatch } from "../utils/parallel-utils";

export type MempoolMonitorDeps = {
  client: ClobClient;
  env: RuntimeEnv;
  logger: Logger;
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

interface ActivityResponse {
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  size: number;
  usdcSize: number;
  price: number;
  side: string;
  outcomeIndex: number;
  transactionHash: string;
  status?: string; // 'pending' | 'confirmed'
}

export class MempoolMonitorService {
  private readonly deps: MempoolMonitorDeps;
  private provider?: JsonRpcProvider;
  private isRunning = false;
  private readonly processedHashes: Set<string> = new Set();
  private readonly targetAddresses: Set<string> = new Set();
  private timer?: NodeJS.Timeout;
  private readonly lastFetchTime: Map<string, number> = new Map();

  constructor(deps: MempoolMonitorDeps) {
    this.deps = deps;
    POLYMARKET_CONTRACTS.forEach((addr) =>
      this.targetAddresses.add(addr.toLowerCase()),
    );
  }

  async start(): Promise<void> {
    const { logger, env } = this.deps;
    logger.info("🚀 Starting Polymarket Frontrun Bot - Mempool Monitor");
    const overridesInfo = env.overridesApplied.length
      ? ` overrides=${env.overridesApplied.join(",")}`
      : "";
    logger.info(
      `[Monitor] ⚙️  Preset=${env.presetName} min_trade_usd=${env.minTradeSizeUsd.toFixed(2)} recent_window=${DEFAULT_CONFIG.ACTIVITY_CHECK_WINDOW_SECONDS}s fetch_interval=${env.fetchIntervalSeconds}s trade_multiplier=${env.tradeMultiplier} gas_multiplier=${env.gasPriceMultiplier} require_confirmed=${env.requireConfirmed} targets=${env.targetAddresses.length}${overridesInfo}`,
    );
    logger.debug(
      `Target addresses: ${env.targetAddresses.map((addr) => addr.toLowerCase()).join(", ") || "none"}`,
    );

    this.provider = new JsonRpcProvider(env.rpcUrl);
    this.isRunning = true;

    await this.enablePendingSubscription();

    // Also monitor Polymarket API for recent orders (hybrid approach)
    // This helps catch orders that might not be in mempool yet
    this.timer = setInterval(
      () => void this.monitorRecentOrders().catch(() => undefined),
      env.fetchIntervalSeconds * 1000,
    );
    await this.monitorRecentOrders();

    logger.info(
      "👀 Mempool monitoring active. Waiting for pending transactions...",
    );
  }

  stop(): void {
    this.isRunning = false;
    if (this.provider) {
      this.provider.removeAllListeners("pending");
    }
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.deps.logger.info("🛑 Mempool monitoring stopped");
  }

  private async enablePendingSubscription(): Promise<void> {
    const { logger } = this.deps;
    if (!this.provider) {
      return;
    }

    // Check if RPC supports eth_newPendingTransactionFilter
    // Note: If this check fails, provider.on('pending') won't work either,
    // as it uses the same underlying mechanism (WebSocket eth_subscribe or
    // HTTP filter polling). We only set up the subscription if this succeeds.
    try {
      const filterId = await this.provider.send(
        "eth_newPendingTransactionFilter",
        [],
      );
      await this.provider.send("eth_uninstallFilter", [filterId]);

      logger.info(
        "[Monitor] ✅ RPC endpoint supports real-time mempool monitoring via eth_newPendingTransactionFilter",
      );
      logger.info(
        "[Monitor] Subscribing to pending transactions for real-time detection...",
      );

      // Subscribe to pending transactions
      // This will work because we've confirmed the RPC supports mempool filters
      this.provider.on("pending", (txHash: string) => {
        if (this.isRunning) {
          void this.handlePendingTransaction(txHash).catch(() => {
            // Silently handle errors for mempool monitoring
          });
        }
      });
    } catch (err) {
      logger.info(
        "[Monitor] ===================================================================",
      );
      logger.info(
        "[Monitor] ℹ️  RPC Capability: eth_newPendingTransactionFilter NOT supported",
      );
      logger.info(
        "[Monitor] ===================================================================",
      );
      logger.info(
        "[Monitor] This RPC endpoint does not support real-time mempool monitoring.",
      );
      logger.info(
        "[Monitor] This is expected and NORMAL for many RPC providers, including:",
      );
      logger.info("[Monitor]   • Alchemy Free Tier");
      logger.info("[Monitor]   • Infura Free Tier");
      logger.info("[Monitor]   • QuickNode (some plans)");
      logger.info("[Monitor]   • Most public RPC endpoints");
      logger.info("[Monitor] ");
      logger.info(
        "[Monitor] ✅ FALLBACK MODE: The bot will use Polymarket API polling instead.",
      );
      logger.info(
        "[Monitor] This provides reliable trade detection via the Polymarket API,",
      );
      logger.info(
        "[Monitor] checking for recent activity at regular intervals.",
      );
      logger.info("[Monitor] ");
      logger.info(
        "[Monitor] ℹ️  For real-time mempool monitoring, you can upgrade to:",
      );
      logger.info(
        "[Monitor]   • Alchemy Growth or Scale plan with eth_subscribe",
      );
      logger.info("[Monitor]   • Infura with WebSocket support");
      logger.info("[Monitor]   • QuickNode with stream add-on");
      logger.info("[Monitor]   • Your own Polygon node");
      logger.info(
        "[Monitor] ===================================================================",
      );
      logger.debug(
        `[Monitor] RPC capability check details: ${sanitizeErrorMessage(err)}`,
      );
      return;
    }
  }

  private async handlePendingTransaction(txHash: string): Promise<void> {
    // Skip if already processed
    if (this.processedHashes.has(txHash)) {
      return;
    }

    try {
      const tx = await this.provider!.getTransaction(txHash);
      if (!tx) {
        return;
      }

      const toAddress = tx.to?.toLowerCase();
      if (!toAddress || !this.targetAddresses.has(toAddress)) {
        return;
      }

      // For now, we'll rely on API monitoring for trade details
      // Mempool monitoring helps us detect transactions early
      // The actual trade parsing happens in monitorRecentOrders
    } catch {
      // Expected - transaction might not be available yet
    }
  }

  private async monitorRecentOrders(): Promise<void> {
    const { logger, env } = this.deps;
    const startTime = Date.now();
    const stats: MonitorStats = this.createEmptyStats();

    // Monitor all addresses from env in parallel (these are the addresses we want to frontrun)
    // Use parallelBatch to control concurrency and prevent overwhelming the API
    const MAX_CONCURRENT_ADDRESS_CHECKS = 4;

    const batchResult = await parallelBatch(
      env.targetAddresses,
      async (targetAddress) => {
        const localStats = this.createEmptyStats();

        try {
          await this.checkRecentActivity(targetAddress, localStats);
          return { success: true, stats: localStats };
        } catch (err) {
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            return { success: true, stats: localStats };
          }
          logger.debug(
            `Error checking activity for ${targetAddress}: ${sanitizeErrorMessage(err)}`,
          );
          // Do not mark this as a skipped API error trade, since no trades were processed.
          // The address check failed, but we didn't skip any actual trades.
          return { success: false, stats: localStats };
        }
      },
      {
        concurrency: MAX_CONCURRENT_ADDRESS_CHECKS,
        logger,
        label: "activity-check",
        silent: true, // Suppress internal log since we log a detailed summary below
      },
    );

    // Aggregate stats from all parallel checks
    let checkedAddresses = 0;
    let failedAddressChecks = 0;
    for (const result of batchResult.results) {
      if (result) {
        checkedAddresses++;
        if (!result.success) {
          failedAddressChecks++;
        }
        // Aggregate individual stats
        stats.tradesSeen += result.stats.tradesSeen;
        stats.recentTrades += result.stats.recentTrades;
        stats.eligibleTrades += result.stats.eligibleTrades;
        stats.skippedSmallTrades += result.stats.skippedSmallTrades;
        stats.skippedLowPriceTrades += result.stats.skippedLowPriceTrades;
        stats.skippedUnconfirmedTrades += result.stats.skippedUnconfirmedTrades;
        stats.skippedNonTargetTrades += result.stats.skippedNonTargetTrades;
        stats.skippedParseErrorTrades += result.stats.skippedParseErrorTrades;
        stats.skippedOutsideRecentWindowTrades +=
          result.stats.skippedOutsideRecentWindowTrades;
        stats.skippedUnsupportedActionTrades +=
          result.stats.skippedUnsupportedActionTrades;
        stats.skippedMissingFieldsTrades +=
          result.stats.skippedMissingFieldsTrades;
        stats.skippedApiErrorTrades += result.stats.skippedApiErrorTrades;
        stats.skippedOtherTrades += result.stats.skippedOtherTrades;
      }
    }
    // Count exceptions from parallelBatch (these are uncaught errors from the batch processor)
    // These were not included in results, so we count them separately as failed address checks
    failedAddressChecks += batchResult.errors.length;
    checkedAddresses += batchResult.errors.length;

    const durationMs = Date.now() - startTime;
    logger.info(
      `[Monitor] Checked ${checkedAddresses} address(es) in ${durationMs}ms (${failedAddressChecks} failed) | trades: ${stats.tradesSeen}, recent: ${stats.recentTrades}, eligible: ${stats.eligibleTrades}, skipped_small: ${stats.skippedSmallTrades}, skipped_low_price: ${stats.skippedLowPriceTrades}, skipped_unconfirmed: ${stats.skippedUnconfirmedTrades}, skipped_non_target: ${stats.skippedNonTargetTrades}, skipped_parse_error: ${stats.skippedParseErrorTrades}, skipped_outside_recent_window: ${stats.skippedOutsideRecentWindowTrades}, skipped_unsupported_action: ${stats.skippedUnsupportedActionTrades}, skipped_missing_fields: ${stats.skippedMissingFieldsTrades}, skipped_api_error: ${stats.skippedApiErrorTrades}, skipped_other: ${stats.skippedOtherTrades}`,
    );
  }

  /**
   * Factory function to create a new MonitorStats object with all values initialized to 0
   */
  private createEmptyStats(): MonitorStats {
    return {
      tradesSeen: 0,
      recentTrades: 0,
      eligibleTrades: 0,
      skippedSmallTrades: 0,
      skippedLowPriceTrades: 0,
      skippedUnconfirmedTrades: 0,
      skippedNonTargetTrades: 0,
      skippedParseErrorTrades: 0,
      skippedOutsideRecentWindowTrades: 0,
      skippedUnsupportedActionTrades: 0,
      skippedMissingFieldsTrades: 0,
      skippedApiErrorTrades: 0,
      skippedOtherTrades: 0,
    };
  }

  private async checkRecentActivity(
    targetAddress: string,
    stats: MonitorStats,
  ): Promise<void> {
    const { logger, env } = this.deps;

    try {
      const url = POLYMARKET_API.ACTIVITY_ENDPOINT(targetAddress);
      const activities: ActivityResponse[] =
        await httpGet<ActivityResponse[]>(url);

      const now = Math.floor(Date.now() / 1000);
      const cutoffTime = now - DEFAULT_CONFIG.ACTIVITY_CHECK_WINDOW_SECONDS;

      for (const activity of activities) {
        if (activity.type !== "TRADE") {
          stats.skippedUnsupportedActionTrades += 1;
          continue;
        }
        stats.tradesSeen += 1;

        const activityTime =
          typeof activity.timestamp === "number"
            ? activity.timestamp
            : Math.floor(new Date(activity.timestamp).getTime() / 1000);

        if (
          !activity.transactionHash ||
          !activity.conditionId ||
          activity.outcomeIndex === undefined
        ) {
          stats.skippedMissingFieldsTrades += 1;
          continue;
        }

        // Only process very recent trades (potential frontrun targets)
        if (activityTime < cutoffTime) {
          stats.skippedOutsideRecentWindowTrades += 1;
          continue;
        }
        stats.recentTrades += 1;

        // Skip if already processed
        if (this.processedHashes.has(activity.transactionHash)) {
          stats.skippedOtherTrades += 1;
          continue;
        }

        const lastTime = this.lastFetchTime.get(targetAddress) || 0;
        if (activityTime <= lastTime) {
          stats.skippedOtherTrades += 1;
          continue;
        }

        // Check minimum trade size
        const sizeUsd = activity.usdcSize || activity.size * activity.price;
        if (!Number.isFinite(sizeUsd)) {
          stats.skippedParseErrorTrades += 1;
          continue;
        }
        if (sizeUsd < env.minTradeSizeUsd) {
          stats.skippedSmallTrades += 1;
          continue;
        }

        // === MINIMUM BUY PRICE CHECK (early filter) ===
        // Skip BUY trades for extremely low-probability positions (e.g., 3¢)
        // This prevents copying trades into positions that are almost certain to lose.
        // Only applies to BUY - SELL orders can exit at any price.
        const isBuy = activity.side.toUpperCase() === "BUY";
        if (isBuy) {
          const minBuyPrice = env.minBuyPrice ?? DEFAULT_CONFIG.MIN_BUY_PRICE;
          if (activity.price < minBuyPrice) {
            stats.skippedLowPriceTrades += 1;
            logger.debug(
              `[Monitor] Skipping low-price BUY: ${(activity.price * 100).toFixed(1)}¢ < ${(minBuyPrice * 100).toFixed(1)}¢ min on market ${activity.conditionId}`,
            );
            continue;
          }
        }

        // Check if transaction is still pending (frontrun opportunity)
        if (env.requireConfirmed) {
          const txStatus = await this.checkTransactionStatus(
            activity.transactionHash,
          );
          if (txStatus !== "confirmed") {
            stats.skippedUnconfirmedTrades += 1;
            continue;
          }
        }

        stats.eligibleTrades += 1;
        logger.info(
          `[Frontrun] 🎯 Detected pending trade: ${activity.side.toUpperCase()} ${sizeUsd.toFixed(2)} USD on market ${activity.conditionId}`,
        );

        const signal: TradeSignal = {
          trader: targetAddress,
          marketId: activity.conditionId,
          tokenId: activity.asset,
          outcome: activity.outcomeIndex === 0 ? "YES" : "NO",
          side: activity.side.toUpperCase() as "BUY" | "SELL",
          sizeUsd,
          price: activity.price,
          timestamp: activityTime * 1000,
          pendingTxHash: activity.transactionHash,
        };

        this.processedHashes.add(activity.transactionHash);
        this.lastFetchTime.set(
          targetAddress,
          Math.max(this.lastFetchTime.get(targetAddress) || 0, activityTime),
        );

        // Execute frontrun
        await this.deps.onDetectedTrade(signal);
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return;
      }
      throw sanitizeAxiosError(err);
    }
  }

  private async checkTransactionStatus(
    txHash: string,
  ): Promise<"pending" | "confirmed"> {
    try {
      const receipt = await this.provider!.getTransactionReceipt(txHash);
      return receipt ? "confirmed" : "pending";
    } catch {
      return "pending";
    }
  }
}

type MonitorStats = {
  tradesSeen: number;
  recentTrades: number;
  eligibleTrades: number;
  skippedSmallTrades: number;
  skippedLowPriceTrades: number;
  skippedUnconfirmedTrades: number;
  skippedNonTargetTrades: number;
  skippedParseErrorTrades: number;
  skippedOutsideRecentWindowTrades: number;
  skippedUnsupportedActionTrades: number;
  skippedMissingFieldsTrades: number;
  skippedApiErrorTrades: number;
  skippedOtherTrades: number;
};
