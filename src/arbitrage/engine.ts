import type { Logger } from "../utils/logger.util";
import type { ArbConfig } from "./config";
import type { DecisionLogger } from "./utils/decision-logger";
import { OrderbookNotFoundError } from "../errors/app.errors";
import type {
  MarketDataProvider,
  Opportunity,
  RiskManager,
  Strategy,
  TradeExecutor,
} from "./types";
import { Semaphore } from "./utils/limiter";
import type {
  ArbDiagnostics,
  CandidateSnapshot,
} from "./strategy/intra-market.strategy";
import {
  getAdaptiveLearner,
  type AdaptiveTradeLearner,
} from "./learning/adaptive-learner";

export class ArbitrageEngine {
  private readonly provider: MarketDataProvider;
  private readonly strategy: Strategy;
  private readonly riskManager: RiskManager;
  private readonly executor: TradeExecutor;
  private readonly config: ArbConfig;
  private readonly logger: Logger;
  private readonly decisionLogger?: DecisionLogger;
  private readonly orderbookLimiter: Semaphore;
  private readonly learner: AdaptiveTradeLearner;
  private running = false;
  private activeTrades = 0;
  /** Track pending trades for outcome recording */
  private pendingTrades: Map<
    string,
    { tradeId: string; opportunity: Opportunity; startTime: number }
  > = new Map();

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
    this.learner = getAdaptiveLearner(params.logger);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info("[ARB] 🚀 Arbitrage engine started");
    this.logger.info(
      "[ARB] 🧠 Adaptive learning enabled - will learn from trade outcomes",
    );
    while (this.running) {
      const startedAt = Date.now();
      await this.scanOnce(startedAt);
      const elapsed = Date.now() - startedAt;
      const waitMs = Math.max(0, this.config.scanIntervalMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    // Print learning summary on stop
    this.learner.printSummary();
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
            const yesResult = await this.getOrderBookTopSafe(
              market.yesTokenId,
              market.marketId,
            );
            const noResult = await this.getOrderBookTopSafe(
              market.noTokenId,
              market.marketId,
            );
            const hasFailure = yesResult.failed || noResult.failed;
            if (hasFailure) {
              marketsWithOrderbookFailures += 1;
            }
            orderbookFailures +=
              (yesResult.failed ? 1 : 0) + (noResult.failed ? 1 : 0);
            return { ...market, yesTop: yesResult.top, noTop: noResult.top };
          }),
        ),
      );

      const opportunities = this.strategy.findOpportunities(snapshots, now);
      const diagnostics = this.getDiagnostics();
      const allCandidates = diagnostics?.candidates ?? [];
      const topCandidates = this.selectTopCandidates(allCandidates);
      await this.logCandidates(allCandidates, topCandidates, now);
      const skipSummary = diagnostics
        ? this.formatSkipCounts(diagnostics.skipCounts)
        : "n/a";
      opportunities.sort((a, b) => b.estProfitUsd - a.estProfitUsd);
      if (opportunities.length === 0) {
        this.logger.info(
          `[ARB] 🔍 Scan complete: 0 opportunities (markets=${markets.length}, orderbook_failures=${orderbookFailures}, markets_with_missing_orderbooks=${marketsWithOrderbookFailures}, skips=${skipSummary})`,
        );
      } else {
        const top = opportunities[0];
        this.logger.info(
          `[ARB] 🎯 Found ${opportunities.length} opportunity(ies). Top market=${top.marketId} edge=${top.edgeBps.toFixed(1)}bps est=$${top.estProfitUsd.toFixed(2)} size=$${top.sizeUsd.toFixed(2)} (orderbook_failures=${orderbookFailures}, markets_with_missing_orderbooks=${marketsWithOrderbookFailures}, skips=${skipSummary})`,
        );
      }

      this.logTopCandidates(topCandidates);

      for (const opportunity of opportunities) {
        if (this.activeTrades >= this.config.maxConcurrentTrades) break;
        await this.handleOpportunity(opportunity, now);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ARB] ⚠️  Scan error: ${message}`);
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
          `[ARB] ⚠️  Invalid orderbook token ${tokenId} for market ${marketId}. Remove from config/watchlist if applicable.`,
        );
        return { top: { bestAsk: 0, bestBid: 0 }, failed: true };
      }
      throw error;
    }
  }

  private async handleOpportunity(
    opportunity: Opportunity,
    now: number,
  ): Promise<void> {
    // First, check with the adaptive learner
    const spreadBps = opportunity.spreadBps ?? 100; // Default spread if not available
    const learnerEval = this.learner.evaluateTrade({
      marketId: opportunity.marketId,
      edgeBps: opportunity.edgeBps,
      spreadBps,
      sizeUsd: opportunity.sizeUsd,
      liquidityUsd: opportunity.liquidityUsd,
    });

    if (!learnerEval.shouldTrade) {
      this.logger.info(
        `[ARB] ⛔ Skip (learner) market=${opportunity.marketId.slice(0, 12)}... confidence=${learnerEval.confidence}% reasons: ${learnerEval.reasons.join(", ")}`,
      );
      await this.logDecision(
        opportunity,
        "skip",
        `learner:${learnerEval.reasons[0] || "low_confidence"}`,
        now,
      );
      return;
    }

    // Apply learner's size adjustment
    const adjustedSize =
      opportunity.sizeUsd * learnerEval.adjustments.sizeMultiplier;

    const decision = this.riskManager.canExecute(opportunity, now);
    if (!decision.allowed) {
      this.logger.info(
        `[ARB] ⛔ Skip market=${opportunity.marketId.slice(0, 12)}... reason=${decision.reason || "filtered"} edge=${opportunity.edgeBps.toFixed(1)}bps`,
      );
      await this.logDecision(
        opportunity,
        "skip",
        decision.reason || "filtered",
        now,
      );
      return;
    }

    const gasCheck = await this.riskManager.ensureGasBalance(now);
    if (!gasCheck.ok) {
      this.logger.warn(
        `[ARB] ⚠️  Skip market=${opportunity.marketId.slice(0, 12)}... reason=low_gas`,
      );
      await this.logDecision(opportunity, "skip", "low_gas", now);
      return;
    }

    // Record trade for learning
    const tradeId = this.learner.recordTrade({
      marketId: opportunity.marketId,
      timestamp: now,
      entryPrice: opportunity.yesAsk,
      sizeUsd: adjustedSize,
      edgeBps: opportunity.edgeBps,
      spreadBps,
      liquidityUsd: opportunity.liquidityUsd,
      outcome: "pending",
    });

    this.activeTrades += 1;
    await this.riskManager.onTradeSubmitted(opportunity, now);

    const plan = {
      marketId: opportunity.marketId,
      yesTokenId: opportunity.yesTokenId,
      noTokenId: opportunity.noTokenId,
      yesAsk: opportunity.yesAsk,
      noAsk: opportunity.noAsk,
      sizeUsd: adjustedSize,
      edgeBps: opportunity.edgeBps,
      estProfitUsd:
        opportunity.estProfitUsd * learnerEval.adjustments.sizeMultiplier,
    };

    this.logger.info(
      `[ARB] 🚀 Execute market=${opportunity.marketId.slice(0, 12)}... edge=${opportunity.edgeBps.toFixed(1)}bps size=$${adjustedSize.toFixed(2)} confidence=${learnerEval.confidence}%`,
    );

    const result = await this.executor.execute(plan, now);
    this.activeTrades -= 1;
    const holdTimeMs = Date.now() - now;

    if (result.status === "submitted" || result.status === "dry_run") {
      await this.riskManager.onTradeSuccess(opportunity, now);
      // Record as win for now (in real scenario, would need to track settlement)
      this.learner.updateTradeOutcome(
        tradeId,
        "win",
        opportunity.yesAsk,
        plan.estProfitUsd,
        holdTimeMs,
      );
      this.logger.info(
        `[ARB] ✅ Trade submitted market=${opportunity.marketId.slice(0, 12)}... tx=${result.txHashes?.[0]?.slice(0, 10) || "dry_run"}...`,
      );
      await this.logDecision(
        opportunity,
        "trade",
        result.status,
        now,
        plan.sizeUsd,
        result.txHashes?.[0],
      );
    } else {
      await this.riskManager.onTradeFailure(
        opportunity,
        now,
        result.reason || result.status,
      );
      // Record as loss for learning
      this.learner.updateTradeOutcome(
        tradeId,
        "loss",
        opportunity.yesAsk,
        -plan.sizeUsd * 0.01, // Assume small loss for failed trades
        holdTimeMs,
      );
      this.logger.warn(
        `[ARB] ❌ Trade failed market=${opportunity.marketId.slice(0, 12)}... reason=${result.reason || result.status}`,
      );
      await this.logDecision(
        opportunity,
        "skip",
        result.reason || result.status,
        now,
      );
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
      sum: opportunity.yesAsk + opportunity.noAsk,
      edge_bps: opportunity.edgeBps,
      liquidity: opportunity.liquidityUsd,
      spread_bps: opportunity.spreadBps,
      est_profit_usd: opportunity.estProfitUsd,
      action,
      reason,
      planned_size: plannedSize,
      tx_hash: txHash,
      status: action === "trade" ? "submitted" : "skipped",
    });
  }

  private getDiagnostics(): ArbDiagnostics | undefined {
    const strategyWithDiagnostics = this.strategy as unknown as {
      getDiagnostics?: () => ArbDiagnostics;
    };
    if (typeof strategyWithDiagnostics.getDiagnostics === "function") {
      return strategyWithDiagnostics.getDiagnostics();
    }
    return undefined;
  }

  private selectTopCandidates(
    candidates: CandidateSnapshot[],
  ): CandidateSnapshot[] {
    if (!this.config.debugTopN || this.config.debugTopN <= 0) return [];
    return [...candidates]
      .sort((a, b) => b.edgeBps - a.edgeBps)
      .slice(0, this.config.debugTopN);
  }

  private logTopCandidates(candidates: CandidateSnapshot[]): void {
    if (!this.config.debugTopN || candidates.length === 0) return;
    const lines = candidates.map((candidate) => {
      const liquidity =
        candidate.liquidityUsd !== undefined
          ? candidate.liquidityUsd.toFixed(2)
          : "n/a";
      return `market_id=${candidate.marketId} yesBid=${candidate.yesBid.toFixed(4)} yesAsk=${candidate.yesAsk.toFixed(
        4,
      )} noBid=${candidate.noBid.toFixed(4)} noAsk=${candidate.noAsk.toFixed(
        4,
      )} sum=${candidate.sum.toFixed(4)} edge_bps=${candidate.edgeBps.toFixed(
        1,
      )} spread_bps=${candidate.spreadBps.toFixed(1)} liquidity=${liquidity}`;
    });
    this.logger.info(
      `[ARB] TopCandidates (pre-filter, top ${this.config.debugTopN}):\n${lines.join("\n")}`,
    );
  }

  private formatSkipCounts(skipCounts: Record<string, number>): string {
    return Object.entries(skipCounts)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(",");
  }

  private async logCandidates(
    allCandidates: CandidateSnapshot[],
    topCandidates: CandidateSnapshot[],
    now: number,
  ): Promise<void> {
    if (!this.decisionLogger) return;
    if (topCandidates.length === 0 && !this.config.logEveryMarket) return;
    const entries = this.config.logEveryMarket ? allCandidates : topCandidates;
    const ts = new Date(now).toISOString();
    for (const candidate of entries) {
      await this.decisionLogger.append({
        ts,
        market_id: candidate.marketId,
        yes_ask: candidate.yesAsk,
        no_ask: candidate.noAsk,
        sum: candidate.sum,
        edge_bps: candidate.edgeBps,
        liquidity: candidate.liquidityUsd,
        spread_bps: candidate.spreadBps,
        est_profit_usd: undefined,
        action: "candidate",
        reason: candidate.reason ?? "pre_filter",
      });
    }
  }
}
