import type { ClobClient } from "@polymarket/clob-client";
import type { Logger } from "../../utils/logger.util";
import { OrderbookNotFoundError } from "../../errors/app.errors";
import type { MarketDataProvider, MarketSummary, OrderBookTop } from "../types";
import { TTLCache } from "../../utils/parallel-utils";

const OUTCOME_YES = new Set(["yes", "y", "true"]);
const OUTCOME_NO = new Set(["no", "n", "false"]);
const END_CURSOR = "LTE=";
const MAX_MARKET_PAGES = 20;
// Cache orderbook data for 2 seconds to avoid redundant API calls during the same scan cycle
const ORDERBOOK_CACHE_TTL_MS = 2000;
// Cache active markets for 30 seconds since they don't change frequently
const MARKETS_CACHE_TTL_MS = 30000;

function parseOutcome(value?: string): "YES" | "NO" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (OUTCOME_YES.has(normalized)) return "YES";
  if (OUTCOME_NO.has(normalized)) return "NO";
  return undefined;
}

function parseTimestamp(value?: string | number): number | undefined {
  if (!value) return undefined;
  const ts = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ts) ? undefined : ts;
}

function parseUsd(value?: string | number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isNaN(num) ? undefined : num;
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "f", "no", "n", "0"].includes(normalized)) return false;
  }
  return undefined;
}

const INACTIVE_MARKET_STATUSES = new Set([
  "closed",
  "resolved",
  "settled",
  "inactive",
  "archived",
  "cancelled",
  "canceled",
  "finalized",
]);

function isMarketActive(market: Record<string, unknown>): boolean {
  const statusRaw =
    market.status ??
    market.state ??
    market.market_status ??
    market.marketStatus ??
    market.condition_status ??
    market.conditionStatus;
  if (
    typeof statusRaw === "string" &&
    INACTIVE_MARKET_STATUSES.has(statusRaw.toLowerCase())
  ) {
    return false;
  }

  const activityFlag =
    market.active ??
    market.is_active ??
    market.isActive ??
    market.trading ??
    market.is_trading ??
    market.isTrading;
  if (parseBooleanFlag(activityFlag) === false) return false;

  const closedFlag =
    market.closed ??
    market.is_closed ??
    market.isClosed ??
    market.resolved ??
    market.is_resolved ??
    market.isResolved ??
    market.settled ??
    market.archived ??
    market.is_archived ??
    market.isArchived;
  return parseBooleanFlag(closedFlag) !== true;
}

function normalizeTokens(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((token) => token && typeof token === "object") as Array<
      Record<string, unknown>
    >;
  }
  if (value && typeof value === "object") {
    return Object.values(value).filter(
      (token) => token && typeof token === "object",
    ) as Array<Record<string, unknown>>;
  }
  return [];
}

export class PolymarketMarketDataProvider implements MarketDataProvider {
  private readonly client: ClobClient;
  private readonly logger: Logger;
  private readonly missingOrderbooks = new Set<string>();
  private readonly tokenMarketMap = new Map<string, string>();
  // TTL caches to reduce redundant API calls
  private readonly orderbookCache = new TTLCache<string, OrderBookTop>(ORDERBOOK_CACHE_TTL_MS);
  private readonly marketsCache = new TTLCache<string, MarketSummary[]>(MARKETS_CACHE_TTL_MS);

  constructor(params: { client: ClobClient; logger: Logger }) {
    this.client = params.client;
    this.logger = params.logger;
  }

  async getActiveMarkets(): Promise<MarketSummary[]> {
    // Check cache first
    const cached = this.marketsCache.get("active");
    if (cached) {
      return cached;
    }

    const markets: MarketSummary[] = [];
    let nextCursor: string | undefined;
    let pagesChecked = 0;

    while (pagesChecked < MAX_MARKET_PAGES) {
      const payload = await this.client.getSimplifiedMarkets(nextCursor);
      const data = Array.isArray(payload?.data) ? payload.data : [];
      pagesChecked += 1;

      for (const market of data) {
        if (!isMarketActive(market)) continue;
        const marketId =
          market.condition_id ||
          market.conditionId ||
          market.id ||
          market.market_id ||
          market.marketId ||
          market.conditionID;
        const tokens = normalizeTokens(
          market.tokens ??
            market.outcomes ??
            market.outcomeTokens ??
            market.tokenSet,
        );

        const yesToken = tokens.find((token) => {
          const outcome = parseOutcome(
            String(
              token.outcome ??
                token.label ??
                token.name ??
                token.symbol ??
                token.title ??
                "",
            ),
          );
          return outcome === "YES";
        });
        const noToken = tokens.find((token) => {
          const outcome = parseOutcome(
            String(
              token.outcome ??
                token.label ??
                token.name ??
                token.symbol ??
                token.title ??
                "",
            ),
          );
          return outcome === "NO";
        });

        const yesTokenId =
          yesToken?.token_id ??
          yesToken?.tokenId ??
          yesToken?.id ??
          yesToken?.tokenID;
        const noTokenId =
          noToken?.token_id ??
          noToken?.tokenId ??
          noToken?.id ??
          noToken?.tokenID;

        if (!marketId || !yesTokenId || !noTokenId) continue;

        const marketKey = String(marketId);
        const yesTokenKey = String(yesTokenId);
        const noTokenKey = String(noTokenId);

        this.tokenMarketMap.set(yesTokenKey, marketKey);
        this.tokenMarketMap.set(noTokenKey, marketKey);

        markets.push({
          marketId: marketKey,
          yesTokenId: yesTokenKey,
          noTokenId: noTokenKey,
          endTime: parseTimestamp(
            market.end_date || market.end_time || market.endDate,
          ),
          liquidityUsd: parseUsd(
            market.liquidity || market.liquidity_usd || market.liquidityUsd,
          ),
          volumeUsd: parseUsd(
            market.volume || market.volume_usd || market.volumeUsd,
          ),
        });
      }

      const payloadCursor = payload as
        | { next_cursor?: string; nextCursor?: string }
        | undefined;
      const rawNextCursor =
        payloadCursor?.next_cursor ?? payloadCursor?.nextCursor;
      if (!rawNextCursor || rawNextCursor === END_CURSOR) {
        break;
      }
      nextCursor = rawNextCursor;
    }

    if (markets.length === 0) {
      const fallbackPayload = await this.client.getSamplingSimplifiedMarkets();
      const sampleData = Array.isArray(fallbackPayload?.data)
        ? fallbackPayload.data
        : [];
      for (const market of sampleData) {
        if (!isMarketActive(market)) continue;
        const marketId =
          market.condition_id ||
          market.conditionId ||
          market.id ||
          market.market_id ||
          market.marketId ||
          market.conditionID;
        const tokens = normalizeTokens(
          market.tokens ??
            market.outcomes ??
            market.outcomeTokens ??
            market.tokenSet,
        );
        const yesToken = tokens.find((token) => {
          const outcome = parseOutcome(
            String(
              token.outcome ??
                token.label ??
                token.name ??
                token.symbol ??
                token.title ??
                "",
            ),
          );
          return outcome === "YES";
        });
        const noToken = tokens.find((token) => {
          const outcome = parseOutcome(
            String(
              token.outcome ??
                token.label ??
                token.name ??
                token.symbol ??
                token.title ??
                "",
            ),
          );
          return outcome === "NO";
        });
        const yesTokenId =
          yesToken?.token_id ??
          yesToken?.tokenId ??
          yesToken?.id ??
          yesToken?.tokenID;
        const noTokenId =
          noToken?.token_id ??
          noToken?.tokenId ??
          noToken?.id ??
          noToken?.tokenID;
        if (!marketId || !yesTokenId || !noTokenId) continue;

        const marketKey = String(marketId);
        const yesTokenKey = String(yesTokenId);
        const noTokenKey = String(noTokenId);

        this.tokenMarketMap.set(yesTokenKey, marketKey);
        this.tokenMarketMap.set(noTokenKey, marketKey);

        markets.push({
          marketId: marketKey,
          yesTokenId: yesTokenKey,
          noTokenId: noTokenKey,
          endTime: parseTimestamp(
            market.end_date || market.end_time || market.endDate,
          ),
          liquidityUsd: parseUsd(
            market.liquidity || market.liquidity_usd || market.liquidityUsd,
          ),
          volumeUsd: parseUsd(
            market.volume || market.volume_usd || market.volumeUsd,
          ),
        });
      }
    }

    if (markets.length === 0) {
      this.logger.warn(
        `[ARB] No active markets returned from Polymarket API (checked ${pagesChecked} page${
          pagesChecked === 1 ? "" : "s"
        })`,
      );
    }

    // Cache the result
    this.marketsCache.set("active", markets);
    return markets;
  }

  async getOrderBookTop(tokenId: string): Promise<OrderBookTop> {
    if (this.missingOrderbooks.has(tokenId)) {
      return { bestAsk: 0, bestBid: 0 };
    }

    // Check cache first to avoid redundant API calls within the same scan cycle
    const cached = this.orderbookCache.get(tokenId);
    if (cached) {
      return cached;
    }

    try {
      const book = await this.client.getOrderBook(tokenId);
      const bestAsk = book.asks?.length ? Number(book.asks[0].price) : 0;
      const bestBid = book.bids?.length ? Number(book.bids[0].price) : 0;
      const result = {
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : 0,
        bestBid: Number.isFinite(bestBid) ? bestBid : 0,
      };
      // Cache the result
      this.orderbookCache.set(tokenId, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("No orderbook exists") ||
        message.includes("404") ||
        message.includes("Not Found")
      ) {
        if (!this.missingOrderbooks.has(tokenId)) {
          this.missingOrderbooks.add(tokenId);
          const marketId = this.tokenMarketMap.get(tokenId);
          throw new OrderbookNotFoundError(
            `No orderbook exists for token ${tokenId}${marketId ? ` (market ${marketId})` : ""}`,
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
