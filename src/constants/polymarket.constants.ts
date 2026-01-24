/**
 * Polymarket contract addresses on Polygon
 * @see https://docs.polymarket.com/developers/CTF/deployment-resources
 */
export const POLYMARKET_CONTRACTS = [
  "0x4bfb41d5b3570dfe5a4bde6f4f13907e456f2b13", // ConditionalTokens
  "0x89c5cc945dd550bcffb72fe42bff002429f46fec", // Polymarket CLOB
] as const;

/**
 * Default configuration values
 * Rate limits are based on Polymarket API documentation
 * @see https://docs.polymarket.com/quickstart/introduction/rate-limits
 *
 * NOTE ON RPC USAGE:
 * Trading goes through Polymarket's CLOB API, NOT the RPC endpoint.
 * RPC is only used for: balance checks, gas estimates, approvals, on-chain trades.
 * With CLOB mode (default), RPC usage is minimal (~1-5 calls per trade cycle).
 *
 * Infura free tier: 3M requests/day = ~125k/hour = ~35/second
 * This is MORE than enough for HFT since orders go through CLOB API.
 */
export const DEFAULT_CONFIG = {
  FETCH_INTERVAL_SECONDS: 1,
  MIN_TRADE_SIZE_USD: 100,
  MIN_ORDER_USD: 10,
  /**
   * Minimum price threshold for BUY orders in copy trading (0-1 scale where 1 = $1)
   * Prevents copying trades into low-probability "loser" positions.
   *
   * IMPORTANT: Copy trades at low prices are extremely risky.
   * - The target trader might have inside info you don't have
   * - Low-price positions (e.g., 3¢) are almost certain to lose
   * - These trades cost money and provide no value
   *
   * This protection ONLY applies to copy trades (frontrunning).
   * Other strategies (endgame-sweep) have their own price range controls.
   *
   * Recommended values:
   * - 0.15 (15¢): Aggressive, blocks only extreme losers
   * - 0.25 (25¢): Moderate, blocks most risky positions
   * - 0.50 (50¢): Conservative default, only copy trades close to fair odds
   *
   * Set via MIN_BUY_PRICE environment variable (0.0-1.0 scale)
   * Default: 0.50 (50¢) - conservative, avoids risky copy trades
   */
  MIN_BUY_PRICE: 0.5,
  FRONTRUN_SIZE_MULTIPLIER: 0.5,
  FRONTRUN_MAX_SIZE_USD: 50,
  GAS_PRICE_MULTIPLIER: 1.2,
  TRADE_MULTIPLIER: 1.0,
  RETRY_LIMIT: 3,
  AGGREGATION_WINDOW_SECONDS: 300,
  MIN_POL_BALANCE: 0.05,
  ACTIVITY_CHECK_WINDOW_SECONDS: 60,
  // Rate limits - Polymarket allows ~216,000 orders/hour (36,000 per 10 min sustained)
  // For high-frequency scalping, we want maximum throughput
  ORDER_SUBMIT_MIN_INTERVAL_MS: 0, // No artificial delay
  ORDER_SUBMIT_MAX_PER_HOUR: 100000, // 100k/hour (well under Polymarket's 216k limit)
  ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 1, // 1 second per market (prevent spam on same market)
  /**
   * Token-level duplicate order prevention cooldown (in seconds)
   * Prevents placing the same type of order (BUY/SELL) on the same token within this window.
   * This prevents "order stacking" where multiple identical orders are placed on the same market.
   * Independent of price/size - any BUY/SELL on the same tokenId within this window is blocked.
   * Default: 300 seconds (5 minutes) - prevents duplicate orders within a 5 minute window.
   * Set to 0 to disable.
   */
  ORDER_DUPLICATE_PREVENTION_SECONDS: 300,
  CLOUDFLARE_COOLDOWN_SECONDS: 3600,
  CLOB_AUTH_COOLDOWN_SECONDS: 300,
  TRADE_MODE: "clob" as "clob" | "onchain",
} as const;

/**
 * USDC contract address on Polygon mainnet
 */
export const POLYGON_USDC_ADDRESS =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/**
 * Polymarket on-chain addresses (Polygon mainnet)
 * @see https://docs.polymarket.com/developers/CTF/deployment-resources
 */
export const POLYMARKET_CTF_ADDRESS =
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
export const POLYMARKET_CTF_EXCHANGE_ADDRESS =
  "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const POLYMARKET_NEG_RISK_CTF_EXCHANGE_ADDRESS =
  "0xC5d563A36AE78145C45a50134d48A1215220f80a";
export const POLYMARKET_NEG_RISK_ADAPTER_ADDRESS =
  "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

/**
 * Polymarket API endpoints
 * @see https://docs.polymarket.com/quickstart/reference/endpoints
 */
export const POLYMARKET_API = {
  /** CLOB API - Order management, prices, orderbooks */
  BASE_URL: "https://clob.polymarket.com",
  /** Data API - User positions, activity, history */
  DATA_API_BASE_URL: "https://data-api.polymarket.com",
  /** Gamma API - Market discovery, metadata, events */
  GAMMA_API_BASE_URL: "https://gamma-api.polymarket.com",
  /** Geoblock API - Geographic eligibility check */
  GEOBLOCK_ENDPOINT: "https://polymarket.com/api/geoblock",
  /** Main Polymarket website - for user onboarding/trading activation */
  WEBSITE_URL: "https://polymarket.com",
  ACTIVITY_ENDPOINT: (user: string) =>
    `${POLYMARKET_API.DATA_API_BASE_URL}/activity?user=${user}`,
  POSITIONS_ENDPOINT: (user: string) =>
    `${POLYMARKET_API.DATA_API_BASE_URL}/positions?user=${user}`,
  /** Trades API - User trade history with timestamps (more efficient than activity for BUY trades) */
  TRADES_ENDPOINT: (user: string) =>
    `${POLYMARKET_API.DATA_API_BASE_URL}/trades?user=${user}`,
} as const;

/**
 * Order execution constants
 */
export const ORDER_EXECUTION = {
  MIN_REMAINING_USD: 0.01,
  MAX_RETRIES: 3,
  PRICE_PROTECTION_THRESHOLD: 0.01,
} as const;

/**
 * Polymarket API Rate Limits
 * All limits are per 10 seconds unless noted otherwise in the comment.
 * These are informational - actual enforcement is done by Cloudflare throttling.
 * @see https://docs.polymarket.com/quickstart/introduction/rate-limits
 */
export const POLYMARKET_RATE_LIMITS = {
  /** General rate limiting (per 10 seconds) */
  GENERAL: 15000,
  /** CLOB API general (per 10 seconds) */
  CLOB_GENERAL: 9000,
  /** CLOB /book endpoint (per 10 seconds) */
  CLOB_BOOK: 1500,
  /** CLOB /books endpoint (per 10 seconds) */
  CLOB_BOOKS: 500,
  /** CLOB /price endpoint (per 10 seconds) */
  CLOB_PRICE: 1500,
  /** CLOB POST /order endpoint - burst (per 10 seconds) */
  CLOB_ORDER_POST_BURST: 3500,
  /** CLOB POST /order endpoint - sustained: 36000 requests per 10 MINUTES (~60/s average) */
  CLOB_ORDER_POST_SUSTAINED: 36000,
  /** CLOB DELETE /order endpoint - burst (per 10 seconds) */
  CLOB_ORDER_DELETE_BURST: 3000,
  /** Data API general (per 10 seconds) */
  DATA_API_GENERAL: 1000,
  /** Data API /trades (per 10 seconds) */
  DATA_API_TRADES: 200,
  /** Data API /positions (per 10 seconds) */
  DATA_API_POSITIONS: 150,
  /** GAMMA API general (per 10 seconds) */
  GAMMA_GENERAL: 4000,
  /** GAMMA /events (per 10 seconds) */
  GAMMA_EVENTS: 500,
  /** GAMMA /markets (per 10 seconds) */
  GAMMA_MARKETS: 300,
  /** Relayer /submit (per 1 MINUTE, not 10 seconds) */
  RELAYER_SUBMIT: 25,
} as const;
