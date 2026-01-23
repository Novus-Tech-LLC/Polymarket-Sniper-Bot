import { Contract, MaxUint256, ZeroAddress, parseUnits } from "ethers";
import type { Wallet } from "ethers";
import type { ClobClient } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import type { Logger } from "../../utils/logger.util";
import type { ArbConfig } from "../config";
import type {
  MarketDataProvider,
  TradeExecutionResult,
  TradeExecutor,
  TradePlan,
} from "../types";
import { calculateEdgeBps, estimateProfitUsd } from "../utils/bps";
import { resolvePolymarketContracts } from "../../polymarket/contracts";
import { withAuthRetry } from "../../infrastructure/clob-auth";
import {
  getOrderSubmissionController,
  toOrderSubmissionSettings,
  type OrderSubmissionSettings,
} from "../../utils/order-submission.util";
import {
  checkFundsAndAllowance,
  formatCollateralLabel,
  resolveSignerAddress,
} from "../../utils/funds-allowance.util";
import { readApprovalsConfig } from "../../polymarket/preflight";
import { isLiveTradingEnabled } from "../../utils/live-trading.util";

/**
 * Minimum price for ARB trades to prevent buying extreme loser positions.
 *
 * ARB buys BOTH sides of a market, but if one leg fails to fill or is later
 * cancelled, you're potentially stuck holding a very low-probability loser.
 *
 * This executor intentionally uses a LOWER minimum (5¢) than the global
 * trading utilities, which enforce a 10¢ minimum buy price. The lower
 * threshold here allows capturing additional arbitrage on 5¢/95¢ spreads
 * while still blocking more extreme 3¢/97¢ type positions.
 *
 * IMPORTANT: If ARB order placement is ever refactored to use the shared
 * `postOrder` helper (with its 10¢ minimum), you must either:
 *   - raise ARB_MIN_BUY_PRICE to 0.10 for full consistency, OR
 *   - explicitly preserve this special 5¢ behavior in that helper.
 */
const ARB_MIN_BUY_PRICE = 0.05;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const APPROVAL_COOLDOWN_MS = 60_000;

class AllowanceManager {
  private readonly wallet: Wallet;
  private readonly tokenAddress: string;
  private readonly spender: string;
  private readonly logger: Logger;
  private readonly approveUnlimited: boolean;
  private cachedAllowance: bigint = 0n;
  private lastChecked = 0;
  private lastApprovalAt = 0;

  constructor(params: {
    wallet: Wallet;
    tokenAddress: string;
    spender: string;
    logger: Logger;
    approveUnlimited: boolean;
  }) {
    this.wallet = params.wallet;
    this.tokenAddress = params.tokenAddress;
    this.spender = params.spender;
    this.logger = params.logger;
    this.approveUnlimited = params.approveUnlimited;
  }

  private get contract(): Contract {
    return new Contract(this.tokenAddress, ERC20_ABI, this.wallet);
  }

  async getAllowance(now: number): Promise<bigint> {
    if (now - this.lastChecked < 30_000) {
      return this.cachedAllowance;
    }
    const allowance = await this.contract.allowance(
      this.wallet.address,
      this.spender,
    );
    this.cachedAllowance = allowance;
    this.lastChecked = now;
    return allowance;
  }

  async ensureAllowance(requiredAmount: bigint, now: number): Promise<void> {
    const allowance = await this.getAllowance(now);
    if (allowance >= requiredAmount) return;

    if (now - this.lastApprovalAt < APPROVAL_COOLDOWN_MS) {
      throw new Error("approval_cooldown");
    }

    const approvalsConfig = readApprovalsConfig();
    const liveTradingEnabled = isLiveTradingEnabled();
    if (!liveTradingEnabled || approvalsConfig.mode !== "true") {
      this.logger.warn(
        "[ARB] Approval blocked (live trading disabled or APPROVALS_AUTO!=true).",
      );
      throw new Error("approval_blocked");
    }

    const approveAmount = this.approveUnlimited ? MaxUint256 : requiredAmount;
    this.logger.info(
      `[ARB] Approving collateral allowance ${approveAmount.toString()}`,
    );
    const tx = await this.contract.approve(this.spender, approveAmount);
    await tx.wait(1);
    this.lastApprovalAt = now;
    this.cachedAllowance = approveAmount;
  }
}

export class ArbTradeExecutor implements TradeExecutor {
  private readonly client: ClobClient & { wallet: Wallet };
  private readonly provider: MarketDataProvider;
  private readonly config: ArbConfig;
  private readonly logger: Logger;
  private readonly allowanceManager: AllowanceManager;
  private readonly submissionSettings: OrderSubmissionSettings;

  constructor(params: {
    client: ClobClient & { wallet: Wallet };
    provider: MarketDataProvider;
    config: ArbConfig;
    logger: Logger;
  }) {
    this.client = params.client;
    this.provider = params.provider;
    this.config = params.config;
    this.logger = params.logger;
    const contracts = resolvePolymarketContracts();
    const spender = contracts.ctfExchangeAddress ?? ZeroAddress;
    if (!contracts.ctfExchangeAddress) {
      this.logger.warn(
        "[ARB] Missing POLY_CTF_EXCHANGE_ADDRESS; forcing detect-only.",
      );
      this.config.detectOnly = true;
    }
    this.allowanceManager = new AllowanceManager({
      wallet: params.client.wallet,
      tokenAddress: this.config.collateralTokenAddress,
      spender,
      logger: params.logger,
      approveUnlimited: this.config.approveUnlimited,
    });
    this.submissionSettings = toOrderSubmissionSettings({
      minOrderUsd: this.config.minOrderUsd,
      orderSubmitMinIntervalMs: this.config.orderSubmitMinIntervalMs,
      orderSubmitMaxPerHour: this.config.orderSubmitMaxPerHour,
      orderSubmitMarketCooldownSeconds:
        this.config.orderSubmitMarketCooldownSeconds,
      cloudflareCooldownSeconds: this.config.cloudflareCooldownSeconds,
      authCooldownSeconds: this.config.authCooldownSeconds,
    });
  }

  async execute(plan: TradePlan, now: number): Promise<TradeExecutionResult> {
    if (this.config.detectOnly) {
      this.logger.info(
        `[ARB] Detect-only: ${plan.marketId} size=${plan.sizeUsd.toFixed(2)} USD`,
      );
      return { status: "dry_run" };
    }
    if (
      this.config.dryRun ||
      this.config.liveTrading !== "I_UNDERSTAND_THE_RISKS"
    ) {
      this.logger.info(
        `[ARB] Dry run: ${plan.marketId} size=${plan.sizeUsd.toFixed(2)} USD`,
      );
      return { status: "dry_run" };
    }

    if (!this.config.collateralTokenAddress) {
      return { status: "failed", reason: "missing_collateral_token" };
    }

    // === MINIMUM PRICE CHECK ===
    // Prevent buying extreme loser positions. If one leg fails, you're stuck with a loser.
    // Block trades where either side is below the minimum (e.g., 3¢ positions are almost certain losers)
    if (plan.yesAsk < ARB_MIN_BUY_PRICE || plan.noAsk < ARB_MIN_BUY_PRICE) {
      const loserSide = plan.yesAsk < ARB_MIN_BUY_PRICE ? "YES" : "NO";
      const loserPrice = plan.yesAsk < ARB_MIN_BUY_PRICE ? plan.yesAsk : plan.noAsk;
      this.logger.warn(
        `[ARB] 🚫 Skipping trade - ${loserSide} price ${(loserPrice * 100).toFixed(1)}¢ < ${(ARB_MIN_BUY_PRICE * 100).toFixed(0)}¢ min. ` +
          `Positions this cheap are almost certain losers if the other leg fails.`,
      );
      return { status: "failed", reason: "loser_position_price_too_low" };
    }

    try {
      const totalUsd = plan.sizeUsd * 2;
      const requiredAmount = parseUnits(
        totalUsd.toFixed(this.config.collateralTokenDecimals),
        this.config.collateralTokenDecimals,
      );
      await this.allowanceManager.ensureAllowance(requiredAmount, now);

      const legOrder =
        plan.yesAsk <= plan.noAsk
          ? ([
              { outcome: "YES", tokenId: plan.yesTokenId, ask: plan.yesAsk },
              { outcome: "NO", tokenId: plan.noTokenId, ask: plan.noAsk },
            ] as const)
          : ([
              { outcome: "NO", tokenId: plan.noTokenId, ask: plan.noAsk },
              { outcome: "YES", tokenId: plan.yesTokenId, ask: plan.yesAsk },
            ] as const);

      const first = legOrder[0];
      const second = legOrder[1];

      const firstTx = await this.submitMarketOrder(
        plan.marketId,
        first.tokenId,
        plan.sizeUsd,
        first.ask,
      );

      const refreshedFirst = await this.provider.getOrderBookTop(first.tokenId);
      const refreshedSecond = await this.provider.getOrderBookTop(
        second.tokenId,
      );
      const yesAsk =
        first.outcome === "YES"
          ? refreshedFirst.bestAsk
          : refreshedSecond.bestAsk;
      const noAsk =
        first.outcome === "NO"
          ? refreshedFirst.bestAsk
          : refreshedSecond.bestAsk;
      const edgeBps = calculateEdgeBps(yesAsk, noAsk);
      const estProfit = estimateProfitUsd({
        sizeUsd: plan.sizeUsd,
        edgeBps,
        feeBps: this.config.feeBps,
        slippageBps: this.config.slippageBps,
      });

      const maxAcceptableSecond =
        second.ask * (1 + this.config.slippageBps / 10000);
      if (
        refreshedSecond.bestAsk > maxAcceptableSecond ||
        estProfit < this.config.minProfitUsd
      ) {
        return { status: "failed", reason: "second_leg_guard" };
      }

      const secondTx = await this.submitMarketOrder(
        plan.marketId,
        second.tokenId,
        plan.sizeUsd,
        refreshedSecond.bestAsk,
      );

      return {
        status: "submitted",
        txHashes: [firstTx, secondTx].filter(Boolean),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ARB] Trade execution failed: ${message}`);
      return { status: "failed", reason: message };
    }
  }

  private async submitMarketOrder(
    marketId: string,
    tokenId: string,
    sizeUsd: number,
    askPrice: number,
  ): Promise<string> {
    const maxAcceptablePrice = askPrice * (1 + this.config.slippageBps / 10000);
    const top = await this.provider.getOrderBookTop(tokenId);
    if (!top.bestAsk || top.bestAsk > maxAcceptablePrice) {
      throw new Error("slippage_guard");
    }

    const balanceBufferBps =
      this.config.orderBalanceBufferBps > 0
        ? this.config.orderBalanceBufferBps
        : this.config.slippageBps + this.config.feeBps;
    const signerAddress = resolveSignerAddress(this.client);
    const collateralLabel = formatCollateralLabel(
      this.config.collateralTokenAddress,
    );
    const readiness = await checkFundsAndAllowance({
      client: this.client,
      sizeUsd,
      balanceBufferBps,
      collateralTokenAddress: this.config.collateralTokenAddress,
      collateralTokenDecimals: this.config.collateralTokenDecimals,
      conditionalTokenId: tokenId,
      autoApprove: this.config.autoApprove,
      autoApproveMaxUsd: this.config.autoApproveMaxUsd,
      logger: this.logger,
    });
    if (!readiness.ok) {
      throw new Error(readiness.reason ?? "INSUFFICIENT_BALANCE_OR_ALLOWANCE");
    }

    const amount = sizeUsd / top.bestAsk;
    const orderArgs = {
      side: Side.BUY,
      tokenID: tokenId,
      amount,
      price: top.bestAsk,
    };

    const submissionController = getOrderSubmissionController(
      this.submissionSettings,
    );
    const result = await submissionController.submit({
      sizeUsd,
      marketId,
      tokenId,
      logger: this.logger,
      signerAddress,
      collateralLabel,
      submit: async () => {
        const signedOrder = await this.client.createMarketOrder(orderArgs);
        return withAuthRetry(this.client, () =>
          this.client.postOrder(signedOrder, OrderType.FOK),
        );
      },
    });

    if (result.status !== "submitted") {
      this.logger.warn(
        `[CLOB] Order ${result.status} (${result.reason ?? "unknown"}): required=${sizeUsd.toFixed(2)} signer=${signerAddress} collateral=${collateralLabel}`,
      );
      throw new Error(result.reason ?? "order_rejected");
    }
    return result.orderId || "";
  }
}
