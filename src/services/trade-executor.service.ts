import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { RuntimeEnv } from "../config/env";
import type { Logger } from "../utils/logger.util";
import type { TradeSignal } from "../domain/trade.types";
import { postOrder } from "../utils/post-order.util";
import { getUsdBalanceApprox, getPolBalance } from "../utils/get-balance.util";
import { httpGet } from "../utils/fetch-data.util";
import {
  POLYMARKET_API,
  DEFAULT_CONFIG,
} from "../constants/polymarket.constants";
import { parallelFetch, TTLCache } from "../utils/parallel-utils";

export type TradeExecutorDeps = {
  client: ClobClient & { wallet: Wallet };
  proxyWallet: string;
  env: RuntimeEnv;
  logger: Logger;
};

interface Position {
  conditionId: string;
  initialValue: number;
  currentValue: number;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  private detectOnlyLogged = false;
  // Cache balances for 5 seconds to avoid repeated RPC calls within the same trade cycle
  private readonly balanceCache = new TTLCache<string, number>(5000);

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  async frontrunTrade(signal: TradeSignal): Promise<void> {
    const { logger, env, client } = this.deps;
    if (env.detectOnly) {
      if (!this.detectOnlyLogged) {
        logger.warn(
          "[Frontrun] Detect-only mode enabled; skipping order submissions.",
        );
        this.detectOnlyLogged = true;
      }
      return;
    }
    try {
      // Fetch both balances in parallel instead of sequentially
      // This reduces latency by ~50% for balance checks
      const balances = await parallelFetch({
        usdBalance: this.balanceCache.getOrFetch(
          `usdc:${client.wallet.address}`,
          () =>
            getUsdBalanceApprox(
              client.wallet,
              env.collateralTokenAddress,
              env.collateralTokenDecimals,
            ),
        ),
        polBalance: this.balanceCache.getOrFetch(
          `pol:${client.wallet.address}`,
          () => getPolBalance(client.wallet),
        ),
      });

      const yourUsdBalance = balances.usdBalance ?? 0;
      const polBalance = balances.polBalance ?? 0;

      logger.info(
        `[Frontrun] Balance check - POL: ${polBalance.toFixed(4)} POL, USDC: ${yourUsdBalance.toFixed(2)} USDC`,
      );

      // For frontrunning, we execute the same trade but with higher priority
      // Calculate frontrun size (typically smaller or same as target)
      const sizing = this.calculateFrontrunSize(signal.sizeUsd, env);
      const frontrunSize = sizing.size;
      const calculatedSize = signal.sizeUsd * sizing.multiplier;

      logger.info(
        `[Frontrun] Detected trade: ${signal.side} ${signal.sizeUsd.toFixed(2)} USD by other trader`,
      );
      if (sizing.wasCapped) {
        logger.info(
          `[Frontrun] Our order: ${signal.side} ${frontrunSize.toFixed(2)} USD (capped from ${calculatedSize.toFixed(2)} USD by FRONTRUN_MAX_SIZE_USD=${sizing.maxSize})`,
        );
      } else {
        logger.info(
          `[Frontrun] Our order: ${signal.side} ${frontrunSize.toFixed(2)} USD (${(sizing.multiplier * 100).toFixed(1)}% of target)`,
        );
      }

      // Validate our order meets minimum size requirements
      // Note: This validation is also performed by OrderSubmissionController.checkPreflight,
      // but we check early here to provide immediate feedback with helpful tips to the user.
      const minOrderSize = env.minOrderUsd || DEFAULT_CONFIG.MIN_ORDER_USD;
      if (frontrunSize < minOrderSize) {
        logger.warn(
          `[Frontrun] Order size ${frontrunSize.toFixed(2)} USD is below minimum ${minOrderSize.toFixed(2)} USD. Skipping trade.`,
        );
        logger.info(
          `[Frontrun] Tip: Increase FRONTRUN_SIZE_MULTIPLIER (current: ${(sizing.multiplier * 100).toFixed(1)}%) or decrease MIN_ORDER_USD to execute smaller trades.`,
        );
        return;
      }

      // Balance validation
      const requiredUsdc = frontrunSize;
      const minPolForGas = DEFAULT_CONFIG.MIN_POL_BALANCE;

      if (signal.side === "BUY") {
        if (yourUsdBalance < requiredUsdc) {
          logger.error(
            `[Frontrun] Insufficient USDC balance. Required: ${requiredUsdc.toFixed(2)} USDC, Available: ${yourUsdBalance.toFixed(2)} USDC`,
          );
          return;
        }
      }

      if (polBalance < minPolForGas) {
        logger.error(
          `[Frontrun] Insufficient POL balance for gas. Required: ${minPolForGas} POL, Available: ${polBalance.toFixed(4)} POL`,
        );
        return;
      }

      // Execute frontrun order with priority
      // The postOrder function will use higher gas prices if configured
      const submissionResult = await postOrder({
        client,
        wallet: client.wallet,
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: frontrunSize,
        collateralTokenAddress: env.collateralTokenAddress,
        collateralTokenDecimals: env.collateralTokenDecimals,
        priority: true, // Flag for priority execution
        targetGasPrice: signal.targetGasPrice,
        logger,
        orderConfig: {
          minOrderUsd: env.minOrderUsd,
          orderSubmitMinIntervalMs: env.orderSubmitMinIntervalMs,
          orderSubmitMaxPerHour: env.orderSubmitMaxPerHour,
          orderSubmitMarketCooldownSeconds:
            env.orderSubmitMarketCooldownSeconds,
          cloudflareCooldownSeconds: env.cloudflareCooldownSeconds,
          authCooldownSeconds: env.authCooldownSeconds,
          balanceBufferBps: env.orderBalanceBufferBps,
          autoApprove: env.autoApprove,
          autoApproveMaxUsd: env.autoApproveMaxUsd,
        },
      });

      if (submissionResult.status === "submitted") {
        logger.info(
          `[Frontrun] Successfully executed ${signal.side} order for ${frontrunSize.toFixed(2)} USD`,
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes("closed") ||
        errorMessage.includes("resolved") ||
        errorMessage.includes("No orderbook")
      ) {
        logger.warn(
          `[Frontrun] Skipping trade - Market ${signal.marketId} is closed or resolved: ${errorMessage}`,
        );
      } else {
        logger.error(
          `[Frontrun] Failed to frontrun trade: ${errorMessage}`,
          err as Error,
        );
      }
    }
  }

  private calculateFrontrunSize(
    targetSize: number,
    env: RuntimeEnv,
  ): { size: number; multiplier: number; maxSize: number; wasCapped: boolean } {
    // Frontrun with a percentage of the target size
    // This can be configured via env variable
    const multiplier =
      env.frontrunSizeMultiplier || DEFAULT_CONFIG.FRONTRUN_SIZE_MULTIPLIER;
    const calculatedSize = targetSize * multiplier;

    // Cap at max frontrun size if configured
    const maxSize =
      env.frontrunMaxSizeUsd || DEFAULT_CONFIG.FRONTRUN_MAX_SIZE_USD;
    const wasCapped = calculatedSize > maxSize;
    const size = Math.min(calculatedSize, maxSize);

    return { size, multiplier, maxSize, wasCapped };
  }

  // Keep copyTrade for backward compatibility, but redirect to frontrun
  async copyTrade(signal: TradeSignal): Promise<void> {
    return this.frontrunTrade(signal);
  }

  private async getTraderBalance(trader: string): Promise<number> {
    try {
      const positions: Position[] = await httpGet<Position[]>(
        POLYMARKET_API.POSITIONS_ENDPOINT(trader),
      );
      const totalValue = positions.reduce(
        (sum, pos) => sum + (pos.currentValue || pos.initialValue || 0),
        0,
      );
      return Math.max(100, totalValue);
    } catch {
      return 1000;
    }
  }
}
