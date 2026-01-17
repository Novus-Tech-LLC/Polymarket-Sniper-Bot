import type { ClobClient } from "@polymarket/clob-client";
import type { RuntimeEnv } from "../config/env";
import type { Logger } from "../utils/logger.util";
import type { TradeSignal } from "../domain/trade.types";
import { ethers } from "ethers";
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
  private provider?: ethers.providers.JsonRpcProvider;
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
    logger.info("Starting Polymarket Frontrun Bot - Mempool Monitor");
    const overridesInfo = env.overridesApplied.length
      ? ` overrides=${env.overridesApplied.join(",")}`
      : "";
    logger.info(
      `[Monitor] Preset=${env.presetName} min_trade_usd=${env.minTradeSizeUsd.toFixed(2)} recent_window=${DEFAULT_CONFIG.ACTIVITY_CHECK_WINDOW_SECONDS}s fetch_interval=${env.fetchIntervalSeconds}s trade_multiplier=${env.tradeMultiplier} gas_multiplier=${env.gasPriceMultiplier} require_confirmed=${env.requireConfirmed} targets=${env.targetAddresses.length}${overridesInfo}`,
    );
    logger.debug(
      `Target addresses: ${env.targetAddresses.map((addr) => addr.toLowerCase()).join(", ") || "none"}`,
    );

    this.provider = new ethers.providers.JsonRpcProvider(env.rpcUrl);
    this.isRunning = true;

    // Subscribe to pending transactions
    this.provider.on("pending", (txHash: string) => {
      if (this.isRunning) {
        void this.handlePendingTransaction(txHash).catch(() => {
          // Silently handle errors for mempool monitoring
        });
      }
    });

    // Also monitor Polymarket API for recent orders (hybrid approach)
    // This helps catch orders that might not be in mempool yet
    this.timer = setInterval(
      () => void this.monitorRecentOrders().catch(() => undefined),
      env.fetchIntervalSeconds * 1000,
    );
    await this.monitorRecentOrders();

    logger.info(
      "Mempool monitoring active. Waiting for pending transactions...",
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
    this.deps.logger.info("Mempool monitoring stopped");
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
    let checkedAddresses = 0;
    const stats: MonitorStats = {
      tradesSeen: 0,
      recentTrades: 0,
      eligibleTrades: 0,
      skippedSmallTrades: 0,
      skippedUnconfirmedTrades: 0,
      skippedNonTargetTrades: 0,
      skippedParseErrorTrades: 0,
      skippedOutsideRecentWindowTrades: 0,
      skippedUnsupportedActionTrades: 0,
      skippedMissingFieldsTrades: 0,
      skippedApiErrorTrades: 0,
      skippedOtherTrades: 0,
    };

    // Monitor all addresses from env (these are the addresses we want to frontrun)
    for (const targetAddress of env.targetAddresses) {
      try {
        await this.checkRecentActivity(targetAddress, stats);
        checkedAddresses += 1;
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          checkedAddresses += 1;
          continue;
        }
        stats.skippedApiErrorTrades += 1;
        logger.debug(
          `Error checking activity for ${targetAddress}: ${sanitizeErrorMessage(err)}`,
        );
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      `[Monitor] Checked ${checkedAddresses} address(es) in ${durationMs}ms | trades: ${stats.tradesSeen}, recent: ${stats.recentTrades}, eligible: ${stats.eligibleTrades}, skipped_small: ${stats.skippedSmallTrades}, skipped_unconfirmed: ${stats.skippedUnconfirmedTrades}, skipped_non_target: ${stats.skippedNonTargetTrades}, skipped_parse_error: ${stats.skippedParseErrorTrades}, skipped_outside_recent_window: ${stats.skippedOutsideRecentWindowTrades}, skipped_unsupported_action: ${stats.skippedUnsupportedActionTrades}, skipped_missing_fields: ${stats.skippedMissingFieldsTrades}, skipped_api_error: ${stats.skippedApiErrorTrades}, skipped_other: ${stats.skippedOtherTrades}`,
    );
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
          `[Frontrun] Detected pending trade: ${activity.side.toUpperCase()} ${sizeUsd.toFixed(2)} USD on market ${activity.conditionId}`,
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
  skippedUnconfirmedTrades: number;
  skippedNonTargetTrades: number;
  skippedParseErrorTrades: number;
  skippedOutsideRecentWindowTrades: number;
  skippedUnsupportedActionTrades: number;
  skippedMissingFieldsTrades: number;
  skippedApiErrorTrades: number;
  skippedOtherTrades: number;
};
