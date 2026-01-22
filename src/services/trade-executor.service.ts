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
        `[Frontrun] 💰 Balance check - POL: ${polBalance.toFixed(4)} POL, USDC: ${yourUsdBalance.toFixed(2)} USDC`,
      );

      // For frontrunning, we execute the same trade but with higher priority
      // Calculate frontrun size (typically smaller or same as target)
      const sizing = this.calculateFrontrunSize(signal.sizeUsd, env);
      const frontrunSize = sizing.size;
      const calculatedSize = signal.sizeUsd * sizing.multiplier;

      logger.info(
        `[Frontrun] 🔍 Detected trade: ${signal.side} ${signal.sizeUsd.toFixed(2)} USD by other trader`,
      );
      if (sizing.usedFixedSize) {
        // MAX_POSITION_USD is set and is being used as the fixed order size
        logger.info(
          `[Frontrun] 📊 Our order: ${signal.side} ${frontrunSize.toFixed(2)} USD (fixed by MAX_POSITION_USD=${sizing.maxSize})`,
        );
      } else if (sizing.wasCapped) {
        // FRONTRUN_MAX_SIZE_USD is capping the calculated size
        logger.info(
          `[Frontrun] 📊 Our order: ${signal.side} ${frontrunSize.toFixed(2)} USD (capped from ${calculatedSize.toFixed(2)} USD by FRONTRUN_MAX_SIZE_USD=${sizing.maxSize})`,
        );
      } else {
        logger.info(
          `[Frontrun] 📊 Our order: ${signal.side} ${frontrunSize.toFixed(2)} USD (${(sizing.multiplier * 100).toFixed(1)}% of target)`,
        );
      }

      // Validate our order meets minimum size requirements
      // Note: When any position size cap (FRONTRUN_MAX_SIZE_USD or MAX_POSITION_USD) is lower
      // than MIN_ORDER_USD, the effective minimum is adjusted to match the cap so trades can
      // execute at the capped size.
      const minOrderSize = sizing.effectiveMinOrderUsd;
      if (frontrunSize < minOrderSize) {
        logger.warn(
          `[Frontrun] ⚠️ Order size ${frontrunSize.toFixed(2)} USD is below minimum ${minOrderSize.toFixed(2)} USD. Skipping trade.`,
        );
        logger.info(
          `[Frontrun] 💡 Tip: Increase FRONTRUN_SIZE_MULTIPLIER (current: ${(sizing.multiplier * 100).toFixed(1)}%) or decrease MIN_ORDER_USD to execute smaller trades.`,
        );
        return;
      }

      // Balance validation
      const requiredUsdc = frontrunSize;
      const minPolForGas = DEFAULT_CONFIG.MIN_POL_BALANCE;

      if (signal.side === "BUY") {
        if (yourUsdBalance < requiredUsdc) {
          logger.error(
            `[Frontrun] ❌ Insufficient USDC balance. Required: ${requiredUsdc.toFixed(2)} USDC, Available: ${yourUsdBalance.toFixed(2)} USDC`,
          );
          return;
        }
      }

      if (polBalance < minPolForGas) {
        logger.error(
          `[Frontrun] ⛽ Insufficient POL balance for gas. Required: ${minPolForGas} POL, Available: ${polBalance.toFixed(4)} POL`,
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
          minOrderUsd: sizing.effectiveMinOrderUsd,
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
          `[Frontrun] ✅ Successfully executed ${signal.side} order for ${frontrunSize.toFixed(2)} USD`,
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
          `[Frontrun] ⏭️ Skipping trade - Market ${signal.marketId} is closed or resolved: ${errorMessage}`,
        );
      } else {
        logger.error(
          `[Frontrun] ❌ Failed to frontrun trade: ${errorMessage}`,
          err as Error,
        );
      }
    }
  }

  private calculateFrontrunSize(
    targetSize: number,
    env: RuntimeEnv,
  ): {
    size: number;
    multiplier: number;
    maxSize: number;
    wasCapped: boolean;
    cappedByEndgame: boolean;
    effectiveMinOrderUsd: number;
    usedFixedSize: boolean;
  } {
    // Check if MAX_POSITION_USD is set - this is the user's intended fixed position size
    const endgameMax = Number(process.env.MAX_POSITION_USD);
    const hasEndgameCap = Number.isFinite(endgameMax) && endgameMax > 0;
    
    // Frontrun with a percentage of the target size
    // This can be configured via env variable
    const multiplier =
      env.frontrunSizeMultiplier || DEFAULT_CONFIG.FRONTRUN_SIZE_MULTIPLIER;
    const calculatedSize = targetSize * multiplier;

    // Cap at max frontrun size if configured
    const frontrunMax =
      env.frontrunMaxSizeUsd || DEFAULT_CONFIG.FRONTRUN_MAX_SIZE_USD;
    
    const maxSize = hasEndgameCap
      ? Math.min(frontrunMax, endgameMax)
      : frontrunMax;
    
    // Determine which constraint is active:
    // - usedFixedSize: MAX_POSITION_USD is the actual limiting factor (smaller than both calculated and frontrunMax)
    // - wasCapped: FRONTRUN_MAX_SIZE_USD is the limiting factor (without MAX_POSITION_USD being more restrictive)
    const usedFixedSize = hasEndgameCap && endgameMax < calculatedSize && endgameMax <= frontrunMax;
    const wasCapped = calculatedSize > frontrunMax && !usedFixedSize;
    const cappedByEndgame = hasEndgameCap && endgameMax < frontrunMax;
    
    const size = Math.min(calculatedSize, maxSize);

    // Auto-adjust MIN_ORDER_USD if any position size cap (FRONTRUN_MAX_SIZE_USD or MAX_POSITION_USD) is lower to avoid impossible conditions
    // This ensures orders can still execute when either cap is intentionally set low
    const configuredMinOrderUsd = env.minOrderUsd || DEFAULT_CONFIG.MIN_ORDER_USD;
    const effectiveMinOrderUsd =
      configuredMinOrderUsd > maxSize ? maxSize : configuredMinOrderUsd;

    return { size, multiplier, maxSize, wasCapped, cappedByEndgame, effectiveMinOrderUsd, usedFixedSize };
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
