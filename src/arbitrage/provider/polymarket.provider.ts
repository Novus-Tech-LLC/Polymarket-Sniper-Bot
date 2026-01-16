import type { ClobClient } from '@polymarket/clob-client';
import type { Logger } from '../../utils/logger.util';
import { OrderbookNotFoundError } from '../../errors/app.errors';
import type { MarketDataProvider, MarketSummary, OrderBookTop } from '../types';

const OUTCOME_YES = new Set(['yes', 'y', 'true']);
const OUTCOME_NO = new Set(['no', 'n', 'false']);

function parseOutcome(value?: string): 'YES' | 'NO' | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (OUTCOME_YES.has(normalized)) return 'YES';
  if (OUTCOME_NO.has(normalized)) return 'NO';
  return undefined;
}

function parseTimestamp(value?: string | number): number | undefined {
  if (!value) return undefined;
  const ts = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ts) ? undefined : ts;
}

function parseUsd(value?: string | number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(num) ? undefined : num;
}

export class PolymarketMarketDataProvider implements MarketDataProvider {
  private readonly client: ClobClient;
  private readonly logger: Logger;
  private readonly missingOrderbooks = new Set<string>();
  private readonly tokenMarketMap = new Map<string, string>();

  constructor(params: { client: ClobClient; logger: Logger }) {
    this.client = params.client;
    this.logger = params.logger;
  }

  async getActiveMarkets(): Promise<MarketSummary[]> {
    const payload = await this.client.getSimplifiedMarkets();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const markets: MarketSummary[] = [];

    for (const market of data) {
      const marketId = market.condition_id || market.conditionId || market.id || market.market_id;
      const tokens = Array.isArray(market.tokens) ? market.tokens : [];

      const yesToken = tokens.find((token: any) => parseOutcome(token.outcome || token.label || token.name) === 'YES');
      const noToken = tokens.find((token: any) => parseOutcome(token.outcome || token.label || token.name) === 'NO');

      if (!marketId || !yesToken?.token_id || !noToken?.token_id) continue;

      const marketKey = String(marketId);
      const yesTokenId = String(yesToken.token_id);
      const noTokenId = String(noToken.token_id);

      this.tokenMarketMap.set(yesTokenId, marketKey);
      this.tokenMarketMap.set(noTokenId, marketKey);

      markets.push({
        marketId: marketKey,
        yesTokenId,
        noTokenId,
        endTime: parseTimestamp(market.end_date || market.end_time || market.endDate),
        liquidityUsd: parseUsd(market.liquidity || market.liquidity_usd || market.liquidityUsd),
        volumeUsd: parseUsd(market.volume || market.volume_usd || market.volumeUsd),
      });
    }

    if (markets.length === 0) {
      this.logger.warn('[ARB] No active markets returned from Polymarket API');
    }

    return markets;
  }

  async getOrderBookTop(tokenId: string): Promise<OrderBookTop> {
    if (this.missingOrderbooks.has(tokenId)) {
      return { bestAsk: 0, bestBid: 0 };
    }

    try {
      const book = await this.client.getOrderBook(tokenId);
      const bestAsk = book.asks?.length ? Number(book.asks[0].price) : 0;
      const bestBid = book.bids?.length ? Number(book.bids[0].price) : 0;
      return {
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : 0,
        bestBid: Number.isFinite(bestBid) ? bestBid : 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No orderbook exists') || message.includes('404') || message.includes('Not Found')) {
        if (!this.missingOrderbooks.has(tokenId)) {
          this.missingOrderbooks.add(tokenId);
          const marketId = this.tokenMarketMap.get(tokenId);
          throw new OrderbookNotFoundError(
            `No orderbook exists for token ${tokenId}${marketId ? ` (market ${marketId})` : ''}`,
            tokenId,
            marketId,
            error instanceof Error ? error : undefined,
          );
        }
        return { bestAsk: 0, bestBid: 0 };
      }
      throw error;
    }
  }
}
