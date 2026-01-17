import type { ArbConfig } from "../config";
import type { MarketSnapshot, Opportunity, Strategy } from "../types";
import {
  calculateEdgeBps,
  calculateSpreadBps,
  estimateProfitUsd,
} from "../utils/bps";
import { computeSizeUsd } from "../utils/sizing";

export type ArbSkipReason =
  | "SKIP_LOW_EDGE"
  | "SKIP_LOW_PROFIT"
  | "SKIP_LOW_LIQ"
  | "SKIP_WIDE_SPREAD"
  | "SKIP_BAD_BOOK"
  | "SKIP_UNITS"
  | "SKIP_OTHER";

export type CandidateSnapshot = {
  marketId: string;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  sum: number;
  edgeBps: number;
  liquidityUsd?: number;
  spreadBps: number;
  reason?: ArbSkipReason | "ELIGIBLE";
};

export type ArbDiagnostics = {
  candidates: CandidateSnapshot[];
  skipCounts: Record<ArbSkipReason, number>;
};

const SKIP_REASONS: ArbSkipReason[] = [
  "SKIP_LOW_EDGE",
  "SKIP_LOW_PROFIT",
  "SKIP_LOW_LIQ",
  "SKIP_WIDE_SPREAD",
  "SKIP_BAD_BOOK",
  "SKIP_UNITS",
  "SKIP_OTHER",
];

const initSkipCounts = (): Record<ArbSkipReason, number> =>
  SKIP_REASONS.reduce(
    (acc, reason) => {
      acc[reason] = 0;
      return acc;
    },
    {} as Record<ArbSkipReason, number>,
  );

type NormalizedTop = {
  bestAsk: number;
  bestBid: number;
  skipReason?: ArbSkipReason;
};

const normalizeOrderbookTop = (
  top: { bestAsk: number; bestBid: number },
  autoFix: boolean,
): NormalizedTop => {
  const ask = Number(top.bestAsk);
  const bid = Number(top.bestBid);
  if (!Number.isFinite(ask) || !Number.isFinite(bid)) {
    return { bestAsk: 0, bestBid: 0, skipReason: "SKIP_BAD_BOOK" };
  }

  const normalize = (
    value: number,
  ): { value: number; skipReason?: ArbSkipReason } => {
    if (value > 1.5) {
      if (!autoFix) {
        return { value: 0, skipReason: "SKIP_UNITS" };
      }
      const fixed = value / 100;
      if (fixed > 1.5) {
        return { value: 0, skipReason: "SKIP_UNITS" };
      }
      return { value: fixed };
    }
    return { value };
  };

  const askNormalized = normalize(ask);
  if (askNormalized.skipReason) {
    return { bestAsk: 0, bestBid: 0, skipReason: askNormalized.skipReason };
  }
  const bidNormalized = normalize(bid);
  if (bidNormalized.skipReason) {
    return { bestAsk: 0, bestBid: 0, skipReason: bidNormalized.skipReason };
  }

  return { bestAsk: askNormalized.value, bestBid: bidNormalized.value };
};

export class IntraMarketArbStrategy implements Strategy {
  private readonly config: ArbConfig;
  private readonly getExposure: (marketId: string) => {
    market: number;
    wallet: number;
  };
  private lastDiagnostics: ArbDiagnostics = {
    candidates: [],
    skipCounts: initSkipCounts(),
  };

  constructor(params: {
    config: ArbConfig;
    getExposure: (marketId: string) => { market: number; wallet: number };
  }) {
    this.config = params.config;
    this.getExposure = params.getExposure;
  }

  findOpportunities(markets: MarketSnapshot[], now: number): Opportunity[] {
    const opportunities: Opportunity[] = [];
    const candidates: CandidateSnapshot[] = [];
    const skipCounts = initSkipCounts();
    for (const market of markets) {
      const yesTop = normalizeOrderbookTop(
        market.yesTop,
        this.config.unitsAutoFix,
      );
      if (yesTop.skipReason) {
        skipCounts[yesTop.skipReason] += 1;
        continue;
      }
      const noTop = normalizeOrderbookTop(
        market.noTop,
        this.config.unitsAutoFix,
      );
      if (noTop.skipReason) {
        skipCounts[noTop.skipReason] += 1;
        continue;
      }

      const yesAsk = yesTop.bestAsk;
      const yesBid = yesTop.bestBid;
      const noAsk = noTop.bestAsk;
      const noBid = noTop.bestBid;
      if (yesAsk <= 0 || noAsk <= 0) {
        skipCounts.SKIP_BAD_BOOK += 1;
        continue;
      }
      if (yesBid <= 0 || noBid <= 0) {
        skipCounts.SKIP_BAD_BOOK += 1;
        continue;
      }

      const edgeBps = calculateEdgeBps(yesAsk, noAsk);

      const spreadYes = calculateSpreadBps(yesBid, yesAsk);
      const spreadNo = calculateSpreadBps(noBid, noAsk);
      const spreadBps = Math.max(spreadYes, spreadNo);

      const candidate: CandidateSnapshot = {
        marketId: market.marketId,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        sum: yesAsk + noAsk,
        edgeBps,
        liquidityUsd: market.liquidityUsd,
        spreadBps,
      };
      candidates.push(candidate);

      if (
        market.liquidityUsd !== undefined &&
        market.liquidityUsd < this.config.minLiquidityUsd
      ) {
        candidate.reason = "SKIP_LOW_LIQ";
        skipCounts.SKIP_LOW_LIQ += 1;
        continue;
      }
      if (
        market.endTime &&
        market.endTime - now > this.config.maxHoldMinutes * 60 * 1000
      ) {
        candidate.reason = "SKIP_OTHER";
        skipCounts.SKIP_OTHER += 1;
        continue;
      }
      if (edgeBps < this.config.minEdgeBps) {
        candidate.reason = "SKIP_LOW_EDGE";
        skipCounts.SKIP_LOW_EDGE += 1;
        continue;
      }
      if (spreadBps > this.config.maxSpreadBps) {
        candidate.reason = "SKIP_WIDE_SPREAD";
        skipCounts.SKIP_WIDE_SPREAD += 1;
        continue;
      }

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

      if (sizing.sizeUsd <= 0) {
        candidate.reason = "SKIP_OTHER";
        skipCounts.SKIP_OTHER += 1;
        continue;
      }

      const estProfitUsd = estimateProfitUsd({
        sizeUsd: sizing.sizeUsd,
        edgeBps,
        feeBps: this.config.feeBps,
        slippageBps: this.config.slippageBps,
      });
      if (estProfitUsd < this.config.minProfitUsd) {
        candidate.reason = "SKIP_LOW_PROFIT";
        skipCounts.SKIP_LOW_PROFIT += 1;
        continue;
      }

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
      candidate.reason = "ELIGIBLE";
    }

    this.lastDiagnostics = { candidates, skipCounts };
    return opportunities;
  }

  getDiagnostics(): ArbDiagnostics {
    return this.lastDiagnostics;
  }
}
