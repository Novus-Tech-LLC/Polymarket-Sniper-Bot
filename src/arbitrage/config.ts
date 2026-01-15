import { POLYGON_USDC_ADDRESS } from '../constants/polymarket.constants';

export type SizeScalingMode = 'linear' | 'sqrt' | 'log';

export type ArbConfig = {
  enabled: boolean;
  scanIntervalMs: number;
  minEdgeBps: number;
  minProfitUsd: number;
  minLiquidityUsd: number;
  maxSpreadBps: number;
  maxHoldMinutes: number;
  tradeBaseUsd: number;
  maxPositionUsd: number;
  maxWalletExposureUsd: number;
  sizeScaling: SizeScalingMode;
  slippageBps: number;
  feeBps: number;
  startupCooldownSeconds: number;
  marketCooldownSeconds: number;
  maxTradesPerHour: number;
  maxConsecutiveFailures: number;
  dryRun: boolean;
  liveTrading: string;
  minPolGas: number;
  approveUnlimited: boolean;
  stateDir: string;
  decisionsLog: string;
  killSwitchFile: string;
  snapshotState: boolean;
  maxConcurrentTrades: number;
  rpcUrl: string;
  privateKey: string;
  proxyWallet?: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  collateralTokenAddress: string;
  collateralTokenDecimals: number;
};

export function loadArbConfig(overrides: Record<string, string | undefined> = {}): ArbConfig {
  const read = (key: string): string | undefined => overrides[key] ?? process.env[key];
  const readBool = (key: string, fallback: boolean): boolean => {
    const val = read(key);
    if (val === undefined) return fallback;
    return String(val).toLowerCase() === 'true';
  };
  const readNumber = (key: string, fallback: number): number => {
    const val = read(key);
    if (val === undefined || val === '') return fallback;
    return Number(val);
  };
  const required = (key: string): string => {
    const val = read(key);
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const decisionsLogRaw = read('ARB_DECISIONS_LOG');
  const collateralAddressRaw = read('COLLATERAL_TOKEN_ADDRESS') || read('USDC_CONTRACT_ADDRESS');

  const mode = String(read('MODE') || 'arb').toLowerCase();

  return {
    enabled: mode === 'arb' || mode === 'both',
    scanIntervalMs: readNumber('ARB_SCAN_INTERVAL_MS', 3000),
    minEdgeBps: readNumber('ARB_MIN_EDGE_BPS', 300),
    minProfitUsd: readNumber('ARB_MIN_PROFIT_USD', 1),
    minLiquidityUsd: readNumber('ARB_MIN_LIQUIDITY_USD', 10000),
    maxSpreadBps: readNumber('ARB_MAX_SPREAD_BPS', 100),
    maxHoldMinutes: readNumber('ARB_MAX_HOLD_MINUTES', 120),
    tradeBaseUsd: readNumber('ARB_TRADE_BASE_USD', 3),
    maxPositionUsd: readNumber('ARB_MAX_POSITION_USD', 15),
    maxWalletExposureUsd: readNumber('ARB_MAX_WALLET_EXPOSURE_USD', 50),
    sizeScaling: (read('ARB_SIZE_SCALING') as SizeScalingMode) || 'sqrt',
    slippageBps: readNumber('ARB_SLIPPAGE_BPS', 30),
    feeBps: readNumber('ARB_FEE_BPS', 10),
    startupCooldownSeconds: readNumber('ARB_STARTUP_COOLDOWN_SECONDS', 120),
    marketCooldownSeconds: readNumber('ARB_MARKET_COOLDOWN_SECONDS', 900),
    maxTradesPerHour: readNumber('ARB_MAX_TRADES_PER_HOUR', 4),
    maxConsecutiveFailures: readNumber('ARB_MAX_CONSECUTIVE_FAILURES', 2),
    dryRun: readBool('ARB_DRY_RUN', true),
    liveTrading: read('ARB_LIVE_TRADING') || '',
    minPolGas: readNumber('ARB_MIN_POL_GAS', 3),
    approveUnlimited: readBool('ARB_APPROVE_UNLIMITED', false),
    stateDir: read('ARB_STATE_DIR') || '/data',
    decisionsLog: decisionsLogRaw === '' ? '' : decisionsLogRaw || '/data/arb_decisions.jsonl',
    killSwitchFile: read('ARB_KILL_SWITCH_FILE') || '/data/KILL',
    snapshotState: readBool('ARB_SNAPSHOT_STATE', true),
    maxConcurrentTrades: readNumber('ARB_MAX_CONCURRENT_TRADES', 1),
    rpcUrl: required('RPC_URL'),
    privateKey: required('PRIVATE_KEY'),
    proxyWallet: read('PUBLIC_KEY'),
    polymarketApiKey: read('POLYMARKET_API_KEY'),
    polymarketApiSecret: read('POLYMARKET_API_SECRET'),
    polymarketApiPassphrase: read('POLYMARKET_API_PASSPHRASE'),
    collateralTokenAddress: collateralAddressRaw || POLYGON_USDC_ADDRESS,
    collateralTokenDecimals: readNumber('COLLATERAL_TOKEN_DECIMALS', 6),
  };
}

export function parseCliOverrides(argv: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    if (rawValue !== undefined) {
      overrides[rawKey.toUpperCase()] = rawValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      overrides[rawKey.toUpperCase()] = next;
      i += 1;
    } else {
      overrides[rawKey.toUpperCase()] = 'true';
    }
  }
  return overrides;
}
