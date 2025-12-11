import { DEFAULT_CONFIG, POLYGON_USDC_ADDRESS } from '../constants/polymarket.constants';

export type RuntimeEnv = {
  targetAddresses: string[];
  proxyWallet: string;
  privateKey: string;
  mongoUri?: string;
  rpcUrl: string;
  fetchIntervalSeconds: number;
  tradeMultiplier: number;
  retryLimit: number;
  aggregationEnabled: boolean;
  aggregationWindowSeconds: number;
  usdcContractAddress: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  minTradeSizeUsd?: number; // Minimum trade size to frontrun (USD)
  frontrunSizeMultiplier?: number; // Frontrun size as percentage of target trade (0.0-1.0)
  gasPriceMultiplier?: number; // Gas price multiplier for frontrunning (e.g., 1.2 = 20% higher)
};

export function loadEnv(): RuntimeEnv {
  const parseList = (val: string | undefined): string[] => {
    if (!val) return [];
    try {
      const maybeJson = JSON.parse(val);
      if (Array.isArray(maybeJson)) return maybeJson.map(String);
    } catch (_) {
      // not JSON, parse as comma separated
    }
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const required = (name: string, v: string | undefined): string => {
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  const targetAddresses = parseList(process.env.TARGET_ADDRESSES);
  if (targetAddresses.length === 0) {
    throw new Error('TARGET_ADDRESSES must contain at least one trader address');
  }

  const env: RuntimeEnv = {
    targetAddresses,
    proxyWallet: required('PUBLIC_KEY', process.env.PUBLIC_KEY),
    privateKey: required('PRIVATE_KEY', process.env.PRIVATE_KEY),
    mongoUri: process.env.MONGO_URI,
    rpcUrl: required('RPC_URL', process.env.RPC_URL),
    fetchIntervalSeconds: Number(process.env.FETCH_INTERVAL ?? DEFAULT_CONFIG.FETCH_INTERVAL_SECONDS),
    tradeMultiplier: Number(process.env.TRADE_MULTIPLIER ?? DEFAULT_CONFIG.TRADE_MULTIPLIER),
    retryLimit: Number(process.env.RETRY_LIMIT ?? DEFAULT_CONFIG.RETRY_LIMIT),
    aggregationEnabled: String(process.env.TRADE_AGGREGATION_ENABLED ?? 'false') === 'true',
    aggregationWindowSeconds: Number(process.env.TRADE_AGGREGATION_WINDOW_SECONDS ?? DEFAULT_CONFIG.AGGREGATION_WINDOW_SECONDS),
    usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || POLYGON_USDC_ADDRESS,
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    minTradeSizeUsd: Number(process.env.MIN_TRADE_SIZE_USD ?? DEFAULT_CONFIG.MIN_TRADE_SIZE_USD),
    frontrunSizeMultiplier: Number(process.env.FRONTRUN_SIZE_MULTIPLIER ?? DEFAULT_CONFIG.FRONTRUN_SIZE_MULTIPLIER),
    gasPriceMultiplier: Number(process.env.GAS_PRICE_MULTIPLIER ?? DEFAULT_CONFIG.GAS_PRICE_MULTIPLIER),
  };

  return env;
}

