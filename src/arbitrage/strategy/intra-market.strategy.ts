import type { ArbConfig } from '../config';
import type { MarketSnapshot, Opportunity, Strategy } from '../types';
import { calculateEdgeBps, calculateSpreadBps, estimateProfitUsd } from '../utils/bps';
import { computeSizeUsd } from '../utils/sizing';

export class IntraMarketArbStrategy implements Strategy {
  private readonly config: ArbConfig;
  private readonly getExposure: (marketId: string) => { market: number; wallet: number };

  constructor(params: {
    config: ArbConfig;
    getExposure: (marketId: string) => { market: number; wallet: number };
  }) {
    this.config = params.config;
    this.getExposure = params.getExposure;
  }

  findOpportunities(markets: MarketSnapshot[], now: number): Opportunity[] {
    const opportunities: Opportunity[] = [];
    for (const market of markets) {
      if (market.liquidityUsd !== undefined && market.liquidityUsd < this.config.minLiquidityUsd) continue;
      if (market.endTime && market.endTime - now > this.config.maxHoldMinutes * 60 * 1000) continue;

      const yesAsk = market.yesTop.bestAsk;
      const noAsk = market.noTop.bestAsk;
      const edgeBps = calculateEdgeBps(yesAsk, noAsk);
      if (edgeBps < this.config.minEdgeBps) continue;

      const spreadYes = calculateSpreadBps(market.yesTop.bestBid, market.yesTop.bestAsk);
      const spreadNo = calculateSpreadBps(market.noTop.bestBid, market.noTop.bestAsk);
      const spreadBps = Math.max(spreadYes, spreadNo);
      if (spreadBps > this.config.maxSpreadBps) continue;

      const exposure = this.getExposure(market.marketId);
      const sizing = computeSizeUsd({
        baseUsd: this.config.tradeBaseUsd,
        edgeBps,
        mode: this.config.sizeScaling,
        maxPositionUsd: this.config.maxPositionUsd,
        maxWalletExposureUsd: this.config.maxWalletExposureUsd,
        currentMarketExposureUsd: exposure.market,
        currentWalletExposureUsd: exposure.wallet,
      });

      if (sizing.sizeUsd <= 0) continue;

      const estProfitUsd = estimateProfitUsd({
        sizeUsd: sizing.sizeUsd,
        edgeBps,
        feeBps: this.config.feeBps,
        slippageBps: this.config.slippageBps,
      });
      if (estProfitUsd < this.config.minProfitUsd) continue;

      opportunities.push({
        marketId: market.marketId,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesAsk,
        noAsk,
        edgeBps,
        estProfitUsd,
        sizeUsd: sizing.sizeUsd,
        liquidityUsd: market.liquidityUsd,
        spreadBps,
        endTime: market.endTime,
        sizeTier: sizing.sizeTier,
      });
    }

    return opportunities;
  }
}
