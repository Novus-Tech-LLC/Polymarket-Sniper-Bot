import { Contract, constants, utils } from 'ethers';
import type { BigNumber, Wallet } from 'ethers';
import type { ClobClient } from '@polymarket/clob-client';
import { OrderType, Side } from '@polymarket/clob-client';
import type { Logger } from '../../utils/logger.util';
import type { ArbConfig } from '../config';
import type { MarketDataProvider, TradeExecutionResult, TradeExecutor, TradePlan } from '../types';
import { calculateEdgeBps, estimateProfitUsd } from '../utils/bps';
import { POLYMARKET_CONTRACTS } from '../../constants/polymarket.constants';
import { withAuthRetry } from '../../infrastructure/clob-auth';
import {
  getOrderSubmissionController,
  toOrderSubmissionSettings,
  type OrderSubmissionSettings,
} from '../../utils/order-submission.util';
import {
  checkFundsAndAllowance,
  formatCollateralLabel,
  resolveSignerAddress,
} from '../../utils/funds-allowance.util';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const APPROVAL_COOLDOWN_MS = 60_000;

class AllowanceManager {
  private readonly wallet: Wallet;
  private readonly tokenAddress: string;
  private readonly spender: string;
  private readonly logger: Logger;
  private readonly approveUnlimited: boolean;
  private cachedAllowance: BigNumber = constants.Zero;
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

  async getAllowance(now: number): Promise<BigNumber> {
    if (now - this.lastChecked < 30_000) {
      return this.cachedAllowance;
    }
    const allowance = await this.contract.allowance(this.wallet.address, this.spender);
    this.cachedAllowance = allowance;
    this.lastChecked = now;
    return allowance;
  }

  async ensureAllowance(requiredAmount: BigNumber, now: number): Promise<void> {
    const allowance = await this.getAllowance(now);
    if (allowance.gte(requiredAmount)) return;

    if (now - this.lastApprovalAt < APPROVAL_COOLDOWN_MS) {
      throw new Error('approval_cooldown');
    }

    const approveAmount = this.approveUnlimited ? constants.MaxUint256 : requiredAmount;
    this.logger.info(`[ARB] Approving collateral allowance ${approveAmount.toString()}`);
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
    this.allowanceManager = new AllowanceManager({
      wallet: params.client.wallet,
      tokenAddress: this.config.collateralTokenAddress,
      spender: POLYMARKET_CONTRACTS[1],
      logger: params.logger,
      approveUnlimited: this.config.approveUnlimited,
    });
    this.submissionSettings = toOrderSubmissionSettings({
      minOrderUsd: this.config.minOrderUsd,
      orderSubmitMinIntervalMs: this.config.orderSubmitMinIntervalMs,
      orderSubmitMaxPerHour: this.config.orderSubmitMaxPerHour,
      orderSubmitMarketCooldownSeconds: this.config.orderSubmitMarketCooldownSeconds,
      cloudflareCooldownSeconds: this.config.cloudflareCooldownSeconds,
      authCooldownSeconds: this.config.authCooldownSeconds,
    });
  }

  async execute(plan: TradePlan, now: number): Promise<TradeExecutionResult> {
    if (this.config.detectOnly) {
      this.logger.info(`[ARB] Detect-only: ${plan.marketId} size=${plan.sizeUsd.toFixed(2)} USD`);
      return { status: 'dry_run' };
    }
    if (this.config.dryRun || this.config.liveTrading !== 'I_UNDERSTAND_THE_RISKS') {
      this.logger.info(`[ARB] Dry run: ${plan.marketId} size=${plan.sizeUsd.toFixed(2)} USD`);
      return { status: 'dry_run' };
    }

    if (!this.config.collateralTokenAddress) {
      return { status: 'failed', reason: 'missing_collateral_token' };
    }

    try {
      const totalUsd = plan.sizeUsd * 2;
      const requiredAmount = utils.parseUnits(totalUsd.toFixed(this.config.collateralTokenDecimals), this.config.collateralTokenDecimals);
      await this.allowanceManager.ensureAllowance(requiredAmount, now);

      const legOrder = plan.yesAsk <= plan.noAsk
        ? ([{ outcome: 'YES', tokenId: plan.yesTokenId, ask: plan.yesAsk }, { outcome: 'NO', tokenId: plan.noTokenId, ask: plan.noAsk }] as const)
        : ([{ outcome: 'NO', tokenId: plan.noTokenId, ask: plan.noAsk }, { outcome: 'YES', tokenId: plan.yesTokenId, ask: plan.yesAsk }] as const);

      const first = legOrder[0];
      const second = legOrder[1];

      const firstTx = await this.submitMarketOrder(plan.marketId, first.tokenId, plan.sizeUsd, first.ask);

      const refreshedFirst = await this.provider.getOrderBookTop(first.tokenId);
      const refreshedSecond = await this.provider.getOrderBookTop(second.tokenId);
      const yesAsk = first.outcome === 'YES' ? refreshedFirst.bestAsk : refreshedSecond.bestAsk;
      const noAsk = first.outcome === 'NO' ? refreshedFirst.bestAsk : refreshedSecond.bestAsk;
      const edgeBps = calculateEdgeBps(yesAsk, noAsk);
      const estProfit = estimateProfitUsd({
        sizeUsd: plan.sizeUsd,
        edgeBps,
        feeBps: this.config.feeBps,
        slippageBps: this.config.slippageBps,
      });

      const maxAcceptableSecond = second.ask * (1 + this.config.slippageBps / 10000);
      if (refreshedSecond.bestAsk > maxAcceptableSecond || estProfit < this.config.minProfitUsd) {
        return { status: 'failed', reason: 'second_leg_guard' };
      }

      const secondTx = await this.submitMarketOrder(plan.marketId, second.tokenId, plan.sizeUsd, refreshedSecond.bestAsk);

      return {
        status: 'submitted',
        txHashes: [firstTx, secondTx].filter(Boolean),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ARB] Trade execution failed: ${message}`);
      return { status: 'failed', reason: message };
    }
  }

  private async submitMarketOrder(marketId: string, tokenId: string, sizeUsd: number, askPrice: number): Promise<string> {
    const maxAcceptablePrice = askPrice * (1 + this.config.slippageBps / 10000);
    const top = await this.provider.getOrderBookTop(tokenId);
    if (!top.bestAsk || top.bestAsk > maxAcceptablePrice) {
      throw new Error('slippage_guard');
    }

    const balanceBufferBps = this.config.orderBalanceBufferBps > 0
      ? this.config.orderBalanceBufferBps
      : this.config.slippageBps + this.config.feeBps;
    const signerAddress = resolveSignerAddress(this.client);
    const collateralLabel = formatCollateralLabel(this.config.collateralTokenAddress);
    const readiness = await checkFundsAndAllowance({
      client: this.client,
      sizeUsd,
      balanceBufferBps,
      collateralTokenAddress: this.config.collateralTokenAddress,
      collateralTokenDecimals: this.config.collateralTokenDecimals,
      autoApprove: this.config.autoApprove,
      autoApproveMaxUsd: this.config.autoApproveMaxUsd,
      logger: this.logger,
    });
    if (!readiness.ok) {
      throw new Error(readiness.reason ?? 'INSUFFICIENT_BALANCE_OR_ALLOWANCE');
    }

    const amount = sizeUsd / top.bestAsk;
    const orderArgs = {
      side: Side.BUY,
      tokenID: tokenId,
      amount,
      price: top.bestAsk,
    };

    const submissionController = getOrderSubmissionController(this.submissionSettings);
    const result = await submissionController.submit({
      sizeUsd,
      marketId,
      tokenId,
      logger: this.logger,
      signerAddress,
      collateralLabel,
      submit: async () => {
        const signedOrder = await this.client.createMarketOrder(orderArgs);
        return withAuthRetry(this.client, () => this.client.postOrder(signedOrder, OrderType.FOK));
      },
    });

    if (result.status !== 'submitted') {
      this.logger.warn(
        `[CLOB] Order ${result.status} (${result.reason ?? 'unknown'}): required=${sizeUsd.toFixed(2)} signer=${signerAddress} collateral=${collateralLabel}`,
      );
      throw new Error(result.reason ?? 'order_rejected');
    }
    return result.orderId || '';
  }
}
