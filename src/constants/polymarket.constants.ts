/**
 * Polymarket contract addresses on Polygon
 */
export const POLYMARKET_CONTRACTS = [
  '0x4bfb41d5b3570dfe5a4bde6f4f13907e456f2b13', // ConditionalTokens
  '0x89c5cc945dd550bcffb72fe42bff002429f46fec', // Polymarket CLOB
] as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  FETCH_INTERVAL_SECONDS: 1,
  MIN_TRADE_SIZE_USD: 100,
  FRONTRUN_SIZE_MULTIPLIER: 0.5,
  GAS_PRICE_MULTIPLIER: 1.2,
  TRADE_MULTIPLIER: 1.0,
  RETRY_LIMIT: 3,
  AGGREGATION_WINDOW_SECONDS: 300,
  MIN_POL_BALANCE: 0.05,
  ACTIVITY_CHECK_WINDOW_SECONDS: 60,
} as const;

/**
 * USDC contract address on Polygon mainnet
 */
export const POLYGON_USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/**
 * Polymarket API endpoints
 */
export const POLYMARKET_API = {
  BASE_URL: 'https://clob.polymarket.com',
  DATA_API_BASE_URL: 'https://data-api.polymarket.com',
  ACTIVITY_ENDPOINT: (user: string) => `${POLYMARKET_API.DATA_API_BASE_URL}/activity?user=${user}`,
  POSITIONS_ENDPOINT: (user: string) => `${POLYMARKET_API.DATA_API_BASE_URL}/positions?user=${user}`,
} as const;

/**
 * Order execution constants
 */
export const ORDER_EXECUTION = {
  MIN_REMAINING_USD: 0.01,
  MAX_RETRIES: 3,
  PRICE_PROTECTION_THRESHOLD: 0.01,
} as const;

