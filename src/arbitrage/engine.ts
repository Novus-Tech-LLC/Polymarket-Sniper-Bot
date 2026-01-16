import type { Logger } from '../utils/logger.util';
import type { ArbConfig } from './config';
import type { DecisionLogger } from './utils/decision-logger';
import { OrderbookNotFoundError } from '../errors/app.errors';
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
      let orderbookFailures = 0;
      let marketsWithOrderbookFailures = 0;
      const snapshots = await Promise.all(
        markets.map((market) =>
          this.orderbookLimiter.with(async () => {
            const yesResult = await this.getOrderBookTopSafe(market.yesTokenId, market.marketId);
            const noResult = await this.getOrderBookTopSafe(market.noTokenId, market.marketId);
            const hasFailure = yesResult.failed || noResult.failed;
            if (hasFailure) {
              marketsWithOrderbookFailures += 1;
            }
            orderbookFailures += (yesResult.failed ? 1 : 0) + (noResult.failed ? 1 : 0);
            return { ...market, yesTop: yesResult.top, noTop: noResult.top };
          }),
        ),
      );

      const opportunities = this.strategy.findOpportunities(snapshots, now);
      opportunities.sort((a, b) => b.estProfitUsd - a.estProfitUsd);
      if (opportunities.length === 0) {
        this.logger.info(
          `[ARB] Scan complete: 0 opportunities (markets=${markets.length}, orderbook_failures=${orderbookFailures}, markets_with_missing_orderbooks=${marketsWithOrderbookFailures})`,
        );
      } else {
        const top = opportunities[0];
        this.logger.info(
          `[ARB] Found ${opportunities.length} opportunity(ies). Top market=${top.marketId} edge=${top.edgeBps.toFixed(1)}bps est=$${top.estProfitUsd.toFixed(2)} size=$${top.sizeUsd.toFixed(2)} (orderbook_failures=${orderbookFailures}, markets_with_missing_orderbooks=${marketsWithOrderbookFailures})`,
        );
      }

      for (const opportunity of opportunities) {
        if (this.activeTrades >= this.config.maxConcurrentTrades) break;
        await this.handleOpportunity(opportunity, now);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ARB] Scan error: ${message}`);
    }
  }

  private async getOrderBookTopSafe(
    tokenId: string,
    marketId: string,
  ): Promise<{ top: { bestAsk: number; bestBid: number }; failed: boolean }> {
    try {
      const top = await this.provider.getOrderBookTop(tokenId);
      return { top, failed: false };
    } catch (error) {
      if (error instanceof OrderbookNotFoundError) {
        this.logger.warn(
          `[ARB] Invalid orderbook token ${tokenId} for market ${marketId}. Remove from config/watchlist if applicable.`,
        );
        return { top: { bestAsk: 0, bestBid: 0 }, failed: true };
      }
      throw error;
    }
  }

  private async handleOpportunity(opportunity: Opportunity, now: number): Promise<void> {
    const decision = this.riskManager.canExecute(opportunity, now);
    if (!decision.allowed) {
      this.logger.info(
        `[ARB] Skip market=${opportunity.marketId} reason=${decision.reason || 'filtered'} edge=${opportunity.edgeBps.toFixed(1)}bps est=$${opportunity.estProfitUsd.toFixed(2)} size=$${opportunity.sizeUsd.toFixed(2)}`,
      );
      await this.logDecision(opportunity, 'skip', decision.reason || 'filtered', now);
      return;
    }

    const gasCheck = await this.riskManager.ensureGasBalance(now);
    if (!gasCheck.ok) {
      this.logger.warn(
        `[ARB] Skip market=${opportunity.marketId} reason=low_gas edge=${opportunity.edgeBps.toFixed(1)}bps est=$${opportunity.estProfitUsd.toFixed(2)} size=$${opportunity.sizeUsd.toFixed(2)}`,
      );
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
