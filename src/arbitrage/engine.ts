import type { Logger } from '../utils/logger.util';
import type { ArbConfig } from './config';
import type { DecisionLogger } from './utils/decision-logger';
import type { MarketDataProvider, Opportunity, RiskManager, Strategy, TradeExecutor } from './types';
import { Semaphore } from './utils/limiter';

export class ArbitrageEngine {
  private readonly provider: MarketDataProvider;
  private readonly strategy: Strategy;
  private readonly riskManager: RiskManager;
  private readonly executor: TradeExecutor;
  private readonly config: ArbConfig;
  private readonly logger: Logger;
  private readonly decisionLogger?: DecisionLogger;
  private readonly orderbookLimiter: Semaphore;
  private running = false;
  private activeTrades = 0;

  constructor(params: {
    provider: MarketDataProvider;
    strategy: Strategy;
    riskManager: RiskManager;
    executor: TradeExecutor;
    config: ArbConfig;
    logger: Logger;
    decisionLogger?: DecisionLogger;
  }) {
    this.provider = params.provider;
    this.strategy = params.strategy;
    this.riskManager = params.riskManager;
    this.executor = params.executor;
    this.config = params.config;
    this.logger = params.logger;
    this.decisionLogger = params.decisionLogger;
    this.orderbookLimiter = new Semaphore(6);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info('[ARB] Arbitrage engine started');
    while (this.running) {
      const startedAt = Date.now();
      await this.scanOnce(startedAt);
      const elapsed = Date.now() - startedAt;
      const waitMs = Math.max(0, this.config.scanIntervalMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  stop(): void {
    this.running = false;
  }

  async scanOnce(now: number = Date.now()): Promise<void> {
    try {
      const markets = await this.provider.getActiveMarkets();
      const snapshots = await Promise.all(
        markets.map((market) =>
          this.orderbookLimiter.with(async () => {
            const yesTop = await this.provider.getOrderBookTop(market.yesTokenId);
            const noTop = await this.provider.getOrderBookTop(market.noTokenId);
            return { ...market, yesTop, noTop };
          }),
        ),
      );

      const opportunities = this.strategy.findOpportunities(snapshots, now);
      opportunities.sort((a, b) => b.estProfitUsd - a.estProfitUsd);

      for (const opportunity of opportunities) {
        if (this.activeTrades >= this.config.maxConcurrentTrades) break;
        await this.handleOpportunity(opportunity, now);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ARB] Scan error: ${message}`);
    }
  }

  private async handleOpportunity(opportunity: Opportunity, now: number): Promise<void> {
    const decision = this.riskManager.canExecute(opportunity, now);
    if (!decision.allowed) {
      await this.logDecision(opportunity, 'skip', decision.reason || 'filtered', now);
      return;
    }

    const gasCheck = await this.riskManager.ensureGasBalance(now);
    if (!gasCheck.ok) {
      await this.logDecision(opportunity, 'skip', 'low_gas', now);
      return;
    }

    this.activeTrades += 1;
    await this.riskManager.onTradeSubmitted(opportunity, now);

    const plan = {
      marketId: opportunity.marketId,
      yesTokenId: opportunity.yesTokenId,
      noTokenId: opportunity.noTokenId,
      yesAsk: opportunity.yesAsk,
      noAsk: opportunity.noAsk,
      sizeUsd: opportunity.sizeUsd,
      edgeBps: opportunity.edgeBps,
      estProfitUsd: opportunity.estProfitUsd,
    };

    const result = await this.executor.execute(plan, now);
    this.activeTrades -= 1;

    if (result.status === 'submitted' || result.status === 'dry_run') {
      await this.riskManager.onTradeSuccess(opportunity, now);
      await this.logDecision(opportunity, 'trade', result.status, now, plan.sizeUsd, result.txHashes?.[0]);
    } else {
      await this.riskManager.onTradeFailure(opportunity, now, result.reason || result.status);
      await this.logDecision(opportunity, 'skip', result.reason || result.status, now);
    }
  }

  private async logDecision(
    opportunity: Opportunity,
    action: string,
    reason: string,
    now: number,
    plannedSize?: number,
    txHash?: string,
  ): Promise<void> {
    if (!this.decisionLogger) return;
    await this.decisionLogger.append({
      ts: new Date(now).toISOString(),
      market_id: opportunity.marketId,
      yes_ask: opportunity.yesAsk,
      no_ask: opportunity.noAsk,
      edge_bps: opportunity.edgeBps,
      liquidity: opportunity.liquidityUsd,
      spread_bps: opportunity.spreadBps,
      est_profit_usd: opportunity.estProfitUsd,
      action,
      reason,
      planned_size: plannedSize,
      tx_hash: txHash,
      status: action === 'trade' ? 'submitted' : 'skipped',
    });
  }
}
