export type OrderBookTop = {
  bestAsk: number;
  bestBid: number;
};

export type MarketSummary = {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  endTime?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
};

export type MarketSnapshot = MarketSummary & {
  yesTop: OrderBookTop;
  noTop: OrderBookTop;
};

export type Opportunity = {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  edgeBps: number;
  estProfitUsd: number;
  sizeUsd: number;
  liquidityUsd?: number;
  spreadBps?: number;
  endTime?: number;
  sizeTier: number;
};

export type TradePlan = {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesAsk: number;
  noAsk: number;
  sizeUsd: number;
  edgeBps: number;
  estProfitUsd: number;
};

export type TradeExecutionResult = {
  status: 'dry_run' | 'submitted' | 'failed' | 'skipped';
  txHashes?: string[];
  reason?: string;
};

export interface MarketDataProvider {
  getActiveMarkets: () => Promise<MarketSummary[]>;
  getOrderBookTop: (tokenId: string) => Promise<OrderBookTop>;
}

export interface Strategy {
  findOpportunities: (markets: MarketSnapshot[], now: number) => Opportunity[];
}

export interface RiskManager {
  canExecute: (opportunity: Opportunity, now: number) => { allowed: boolean; reason?: string };
  ensureGasBalance: (now: number) => Promise<{ ok: boolean; balance: number }>;
  onTradeSubmitted: (opportunity: Opportunity, now: number) => Promise<void> | void;
  onTradeSuccess: (opportunity: Opportunity, now: number) => Promise<void> | void;
  onTradeFailure: (opportunity: Opportunity, now: number, reason: string) => Promise<void> | void;
}

export interface TradeExecutor {
  execute: (plan: TradePlan, now: number) => Promise<TradeExecutionResult>;
}

export interface StateStore {
  load: () => Promise<void>;
  snapshot: () => Promise<void>;
  getMarketExposure: (marketId: string) => number;
  getWalletExposure: () => number;
  addExposure: (marketId: string, amountUsd: number) => void;
  setMarketCooldown: (marketId: string, nextAllowedAt: number) => void;
  getMarketCooldown: (marketId: string) => number | undefined;
  incrementFailure: () => void;
  resetFailures: () => void;
  getConsecutiveFailures: () => number;
  recordTradeTimestamp: (timestamp: number) => void;
  countTradesSince: (since: number) => number;
}
