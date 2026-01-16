import { DEFAULT_CONFIG, POLYGON_USDC_ADDRESS } from '../constants/polymarket.constants';
import type { ArbConfig } from '../arbitrage/config';
import { ARB_PRESETS, DEFAULT_ARB_PRESET, DEFAULT_MONITOR_PRESET, MONITOR_PRESETS } from './presets';

export type MonitorRuntimeConfig = {
  presetName: string;
  enabled: boolean;
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
  requireConfirmed: boolean;
  collateralTokenAddress: string;
  collateralTokenDecimals: number;
  polymarketApiKey: string;
  polymarketApiSecret: string;
  polymarketApiPassphrase: string;
  minTradeSizeUsd: number;
  frontrunSizeMultiplier?: number;
  gasPriceMultiplier?: number;
  overridesApplied: string[];
  ignoredOverrides: string[];
  unsafeOverridesApplied: string[];
};

export type ArbRuntimeConfig = ArbConfig & {
  presetName: string;
  overridesApplied: string[];
  ignoredOverrides: string[];
  unsafeOverridesApplied: string[];
};

const ARB_OVERRIDE_ALLOWLIST = new Set([
  'ARB_DRY_RUN',
  'ARB_LIVE_TRADING',
  'ARB_MAX_WALLET_EXPOSURE_USD',
  'ARB_MAX_POSITION_USD',
  'ARB_MAX_TRADES_PER_HOUR',
  'ARB_MAX_SPREAD_BPS',
  'ARB_KILL_SWITCH_FILE',
  'ARB_DECISIONS_LOG',
  'ARB_MIN_POL_GAS',
  'ARB_SCAN_INTERVAL_MS',
  'ARB_DEBUG_TOP_N',
]);

const MONITOR_OVERRIDE_ALLOWLIST = new Set([
  'MIN_TRADE_SIZE_USD',
  'TRADE_MULTIPLIER',
  'FETCH_INTERVAL',
  'GAS_PRICE_MULTIPLIER',
  'MONITOR_REQUIRE_CONFIRMED',
]);

const LEGACY_MIN_TRADE_KEYS = ['MIN_TRADE_SIZE', 'MIN_TRADE_USDC', 'MIN_TRADE_SIZE_USDC'] as const;

const ARB_LEGACY_DEFAULTS: ArbConfig = {
  enabled: true,
  scanIntervalMs: 3000,
  minEdgeBps: 300,
  minProfitUsd: 1,
  minLiquidityUsd: 10000,
  maxSpreadBps: 100,
  maxHoldMinutes: 120,
  tradeBaseUsd: 3,
  maxPositionUsd: 15,
  maxWalletExposureUsd: 50,
  sizeScaling: 'sqrt',
  slippageBps: 30,
  feeBps: 10,
  startupCooldownSeconds: 120,
  marketCooldownSeconds: 900,
  maxTradesPerHour: 4,
  maxConsecutiveFailures: 2,
  dryRun: true,
  liveTrading: '',
  minPolGas: 3,
  approveUnlimited: false,
  stateDir: '/data',
  decisionsLog: '/data/arb_decisions.jsonl',
  killSwitchFile: '/data/KILL',
  snapshotState: true,
  maxConcurrentTrades: 1,
  debugTopN: 0,
  unitsAutoFix: true,
  logEveryMarket: false,
  rpcUrl: '',
  privateKey: '',
  proxyWallet: undefined,
  polymarketApiKey: '',
  polymarketApiSecret: '',
  polymarketApiPassphrase: '',
  collateralTokenAddress: POLYGON_USDC_ADDRESS,
  collateralTokenDecimals: 6,
};

const MONITOR_LEGACY_DEFAULTS = {
  enabled: true,
  fetchIntervalSeconds: DEFAULT_CONFIG.FETCH_INTERVAL_SECONDS,
  tradeMultiplier: DEFAULT_CONFIG.TRADE_MULTIPLIER,
  retryLimit: DEFAULT_CONFIG.RETRY_LIMIT,
  aggregationEnabled: false,
  aggregationWindowSeconds: DEFAULT_CONFIG.AGGREGATION_WINDOW_SECONDS,
  requireConfirmed: true,
  minTradeSizeUsd: DEFAULT_CONFIG.MIN_TRADE_SIZE_USD,
  frontrunSizeMultiplier: DEFAULT_CONFIG.FRONTRUN_SIZE_MULTIPLIER,
  gasPriceMultiplier: DEFAULT_CONFIG.GAS_PRICE_MULTIPLIER,
};

type EnvParser<T> = (raw: string) => T | undefined;

const parseNumber: EnvParser<number> = (raw) => {
  if (raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

const parseBool: EnvParser<boolean> = (raw) => {
  if (raw === '') return undefined;
  return String(raw).toLowerCase() === 'true';
};

const parseString: EnvParser<string> = (raw) => raw;

const ARB_ENV_MAP = {
  ARB_ENABLED: { key: 'enabled', parse: parseBool },
  ARB_SCAN_INTERVAL_MS: { key: 'scanIntervalMs', parse: parseNumber },
  ARB_MIN_EDGE_BPS: { key: 'minEdgeBps', parse: parseNumber },
  ARB_MIN_PROFIT_USD: { key: 'minProfitUsd', parse: parseNumber },
  ARB_MIN_LIQUIDITY_USD: { key: 'minLiquidityUsd', parse: parseNumber },
  ARB_MAX_SPREAD_BPS: { key: 'maxSpreadBps', parse: parseNumber },
  ARB_MAX_HOLD_MINUTES: { key: 'maxHoldMinutes', parse: parseNumber },
  ARB_TRADE_BASE_USD: { key: 'tradeBaseUsd', parse: parseNumber },
  ARB_MAX_POSITION_USD: { key: 'maxPositionUsd', parse: parseNumber },
  ARB_MAX_WALLET_EXPOSURE_USD: { key: 'maxWalletExposureUsd', parse: parseNumber },
  ARB_SIZE_SCALING: { key: 'sizeScaling', parse: parseString },
  ARB_SLIPPAGE_BPS: { key: 'slippageBps', parse: parseNumber },
  ARB_FEE_BPS: { key: 'feeBps', parse: parseNumber },
  ARB_STARTUP_COOLDOWN_SECONDS: { key: 'startupCooldownSeconds', parse: parseNumber },
  ARB_MARKET_COOLDOWN_SECONDS: { key: 'marketCooldownSeconds', parse: parseNumber },
  ARB_MAX_TRADES_PER_HOUR: { key: 'maxTradesPerHour', parse: parseNumber },
  ARB_MAX_CONSECUTIVE_FAILURES: { key: 'maxConsecutiveFailures', parse: parseNumber },
  ARB_DRY_RUN: { key: 'dryRun', parse: parseBool },
  ARB_LIVE_TRADING: { key: 'liveTrading', parse: parseString },
  ARB_MIN_POL_GAS: { key: 'minPolGas', parse: parseNumber },
  ARB_APPROVE_UNLIMITED: { key: 'approveUnlimited', parse: parseBool },
  ARB_STATE_DIR: { key: 'stateDir', parse: parseString },
  ARB_DECISIONS_LOG: { key: 'decisionsLog', parse: parseString },
  ARB_KILL_SWITCH_FILE: { key: 'killSwitchFile', parse: parseString },
  ARB_SNAPSHOT_STATE: { key: 'snapshotState', parse: parseBool },
  ARB_MAX_CONCURRENT_TRADES: { key: 'maxConcurrentTrades', parse: parseNumber },
  ARB_DEBUG_TOP_N: { key: 'debugTopN', parse: parseNumber },
  ARB_UNITS_AUTO_FIX: { key: 'unitsAutoFix', parse: parseBool },
  ARB_LOG_EVERY_MARKET: { key: 'logEveryMarket', parse: parseBool },
} as const satisfies Record<string, { key: keyof ArbConfig; parse: EnvParser<unknown> }>;

const MONITOR_ENV_MAP = {
  MONITOR_ENABLED: { key: 'enabled', parse: parseBool },
  FETCH_INTERVAL: { key: 'fetchIntervalSeconds', parse: parseNumber },
  MIN_TRADE_SIZE_USD: { key: 'minTradeSizeUsd', parse: parseNumber },
  TRADE_MULTIPLIER: { key: 'tradeMultiplier', parse: parseNumber },
  RETRY_LIMIT: { key: 'retryLimit', parse: parseNumber },
  TRADE_AGGREGATION_ENABLED: { key: 'aggregationEnabled', parse: parseBool },
  TRADE_AGGREGATION_WINDOW_SECONDS: { key: 'aggregationWindowSeconds', parse: parseNumber },
  FRONTRUN_SIZE_MULTIPLIER: { key: 'frontrunSizeMultiplier', parse: parseNumber },
  GAS_PRICE_MULTIPLIER: { key: 'gasPriceMultiplier', parse: parseNumber },
  MONITOR_REQUIRE_CONFIRMED: { key: 'requireConfirmed', parse: parseBool },
} as const satisfies Record<string, { key: keyof MonitorRuntimeConfig; parse: EnvParser<unknown> }>;

const MONITOR_LEGACY_KEYS = [
  'FETCH_INTERVAL',
  'MIN_TRADE_SIZE_USD',
  ...LEGACY_MIN_TRADE_KEYS,
  'TRADE_MULTIPLIER',
  'RETRY_LIMIT',
  'TRADE_AGGREGATION_ENABLED',
  'TRADE_AGGREGATION_WINDOW_SECONDS',
  'FRONTRUN_SIZE_MULTIPLIER',
  'GAS_PRICE_MULTIPLIER',
  'MONITOR_REQUIRE_CONFIRMED',
];

const ARB_LEGACY_KEYS = Object.keys(ARB_ENV_MAP);

type Overrides = Record<string, string | undefined>;

const readEnv = (key: string, overrides?: Overrides): string | undefined =>
  overrides?.[key] ?? overrides?.[key.toLowerCase()] ?? process.env[key] ?? process.env[key.toLowerCase()];

const readBool = (key: string, fallback: boolean, overrides?: Overrides): boolean => {
  const raw = readEnv(key, overrides);
  if (raw === undefined) return fallback;
  return String(raw).toLowerCase() === 'true';
};

const readNumber = (key: string, fallback: number, overrides?: Overrides): number => {
  const raw = readEnv(key, overrides);
  const parsed = raw === undefined ? undefined : parseNumber(raw);
  return parsed ?? fallback;
};

const required = (key: string, overrides?: Overrides): string => {
  const raw = readEnv(key, overrides);
  if (!raw) throw new Error(`Missing required env var: ${key}`);
  return raw;
};

const parseList = (val: string | undefined): string[] => {
  if (!val) return [];
  try {
    const maybeJson = JSON.parse(val);
    if (Array.isArray(maybeJson)) return maybeJson.map(String);
  } catch (_) {
    // ignore JSON parse error
  }
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

const detectLegacyKeys = (keys: string[], overrides?: Overrides): string[] => {
  return keys.filter((key) => readEnv(key, overrides) !== undefined);
};

const getPresetName = (
  envKey: string,
  defaultPreset: string,
  legacyKeys: string[],
  overrides?: Overrides,
): { presetName: string; legacyKeysDetected: string[] } => {
  const preset = readEnv(envKey, overrides);
  const legacyKeysDetected = detectLegacyKeys(legacyKeys, overrides);
  if (!preset && legacyKeysDetected.length > 0) {
    return { presetName: 'custom', legacyKeysDetected };
  }
  return { presetName: preset || defaultPreset, legacyKeysDetected };
};

const mapPresetValues = <T extends Record<string, unknown>>(
  config: T,
  preset: Record<string, unknown>,
  envMap: Record<string, { key: keyof T; parse: EnvParser<unknown> }>,
): void => {
  Object.entries(preset).forEach(([key, value]) => {
    const mapping = envMap[key];
    if (!mapping) return;
    const parsed = mapping.parse(String(value));
    if (parsed !== undefined) {
      config[mapping.key] = parsed as T[keyof T];
    }
  });
};

const applyOverrides = <T extends Record<string, unknown>>(
  config: T,
  overrides: Overrides,
  envMap: Record<string, { key: keyof T; parse: EnvParser<unknown> }>,
  allowlist: Set<string>,
  allowUnsafe: boolean,
): { applied: string[]; unsafeApplied: string[]; ignored: string[] } => {
  const applied: string[] = [];
  const unsafeApplied: string[] = [];
  const ignored: string[] = [];
  Object.keys(envMap).forEach((envKey) => {
    const raw = readEnv(envKey, overrides);
    if (raw === undefined) return;
    const canApply = allowUnsafe || allowlist.has(envKey);
    if (!canApply) {
      ignored.push(envKey);
      return;
    }
    const parsed = envMap[envKey].parse(raw);
    if (parsed === undefined) {
      ignored.push(envKey);
      return;
    }
    config[envMap[envKey].key] = parsed as T[keyof T];
    applied.push(envKey);
    if (!allowlist.has(envKey)) {
      unsafeApplied.push(envKey);
    }
  });
  return { applied, unsafeApplied, ignored };
};

const resolveLegacyMinTradeOverride = (overrides?: Overrides): { value?: number; key?: string } => {
  const canonicalRaw = readEnv('MIN_TRADE_SIZE_USD', overrides);
  const canonicalValue = canonicalRaw === undefined ? undefined : parseNumber(canonicalRaw);
  if (canonicalRaw !== undefined) {
    return { value: canonicalValue, key: 'MIN_TRADE_SIZE_USD' };
  }
  for (const key of LEGACY_MIN_TRADE_KEYS) {
    const raw = readEnv(key, overrides);
    if (raw === undefined) continue;
    const parsed = parseNumber(raw);
    return { value: parsed, key };
  }
  return {};
};

const warnLegacyKeys = (scope: string, keys: string[]): void => {
  if (!keys.length) return;
  // eslint-disable-next-line no-console
  console.warn(`[Config] ${scope} legacy vars detected: ${keys.join(', ')}`);
};

const warnIgnoredOverrides = (scope: string, keys: string[]): void => {
  if (!keys.length) return;
  // eslint-disable-next-line no-console
  console.warn(`[Config] ${scope} overrides ignored (locked to preset): ${keys.join(', ')}`);
};

const warnUnsafeOverrides = (scope: string, keys: string[]): void => {
  if (!keys.length) return;
  // eslint-disable-next-line no-console
  console.warn(`[Config] ${scope} unsafe overrides applied: ${keys.join(', ')}`);
};

const shouldPrintEffectiveConfig = (overrides?: Overrides): boolean =>
  readBool('PRINT_EFFECTIVE_CONFIG', false, overrides);

const redact = (value: string | undefined): string | undefined => {
  if (!value) return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const printEffectiveConfig = (label: string, payload: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console
  console.info(`[Config] Effective ${label} config: ${JSON.stringify(payload, null, 2)}`);
};

export function loadArbConfig(overrides: Overrides = {}): ArbRuntimeConfig {
  const mode = String(readEnv('MODE', overrides) ?? readEnv('mode', overrides) ?? 'arb').toLowerCase();
  const allowUnsafe = readBool('ARB_ALLOW_UNSAFE_OVERRIDES', false, overrides);
  const presetLookup = getPresetName('ARB_PRESET', DEFAULT_ARB_PRESET, ARB_LEGACY_KEYS, overrides);
  let presetName = presetLookup.presetName;
  const { legacyKeysDetected } = presetLookup;

  if (presetName === 'custom') {
    warnLegacyKeys('ARB', legacyKeysDetected);
  }

  let preset = presetName === 'custom' ? undefined : ARB_PRESETS[presetName as keyof typeof ARB_PRESETS];
  if (!preset && presetName !== 'custom') {
    // eslint-disable-next-line no-console
    console.warn(`[Config] Unknown ARB_PRESET="${presetName}", falling back to ${DEFAULT_ARB_PRESET}.`);
    presetName = DEFAULT_ARB_PRESET;
    preset = ARB_PRESETS[DEFAULT_ARB_PRESET];
  }

  const baseConfig: ArbConfig = { ...ARB_LEGACY_DEFAULTS };

  if (preset && presetName !== 'custom') {
    mapPresetValues(baseConfig, preset as Record<string, unknown>, ARB_ENV_MAP);
  }

  let overrideResult = { applied: [] as string[], unsafeApplied: [] as string[], ignored: [] as string[] };
  if (presetName === 'custom') {
    const baseConfigRecord = baseConfig as Record<keyof ArbConfig, ArbConfig[keyof ArbConfig]>;
    Object.keys(ARB_ENV_MAP).forEach((envKey) => {
      const raw = readEnv(envKey, overrides);
      if (raw === undefined) return;
      const mapping = ARB_ENV_MAP[envKey as keyof typeof ARB_ENV_MAP];
      const parsed = mapping.parse(raw);
      if (parsed === undefined) return;
      baseConfigRecord[mapping.key] = parsed as ArbConfig[keyof ArbConfig];
    });
  } else {
    overrideResult = applyOverrides(baseConfig, overrides, ARB_ENV_MAP, ARB_OVERRIDE_ALLOWLIST, allowUnsafe);
    warnIgnoredOverrides('ARB', overrideResult.ignored);
    warnUnsafeOverrides('ARB', overrideResult.unsafeApplied);
    if (overrideResult.applied.length > 0) {
      // eslint-disable-next-line no-console
      console.info(`[Config] ARB overrides applied: ${overrideResult.applied.join(', ')}`);
    }
  }

  const enabledFromPreset = baseConfig.enabled;
  const enabledFromMode = mode === 'arb' || mode === 'both';

  const decisionsLogRaw = readEnv('ARB_DECISIONS_LOG', overrides);
  const collateralAddressRaw = readEnv('COLLATERAL_TOKEN_ADDRESS', overrides) || readEnv('USDC_CONTRACT_ADDRESS', overrides);

  const config: ArbRuntimeConfig = {
    ...baseConfig,
    enabled: enabledFromPreset && enabledFromMode,
    decisionsLog: decisionsLogRaw === '' ? '' : baseConfig.decisionsLog,
    rpcUrl: required('RPC_URL', overrides),
    privateKey: required('PRIVATE_KEY', overrides),
    proxyWallet: readEnv('PUBLIC_KEY', overrides),
    polymarketApiKey: required('POLYMARKET_API_KEY', overrides),
    polymarketApiSecret: required('POLYMARKET_API_SECRET', overrides),
    polymarketApiPassphrase: required('POLYMARKET_API_PASSPHRASE', overrides),
    collateralTokenAddress: collateralAddressRaw || POLYGON_USDC_ADDRESS,
    collateralTokenDecimals: readNumber('COLLATERAL_TOKEN_DECIMALS', 6, overrides),
    presetName,
    overridesApplied: [],
    ignoredOverrides: [],
    unsafeOverridesApplied: [],
  };

  if (presetName !== 'custom') {
    config.overridesApplied = overrideResult.applied;
    config.ignoredOverrides = overrideResult.ignored;
    config.unsafeOverridesApplied = overrideResult.unsafeApplied;
  } else {
    config.overridesApplied = legacyKeysDetected;
  }

  if (shouldPrintEffectiveConfig(overrides)) {
    printEffectiveConfig('arb', {
      preset: config.presetName,
      enabled: config.enabled,
      scanIntervalMs: config.scanIntervalMs,
      minEdgeBps: config.minEdgeBps,
      minProfitUsd: config.minProfitUsd,
      minLiquidityUsd: config.minLiquidityUsd,
      maxSpreadBps: config.maxSpreadBps,
      tradeBaseUsd: config.tradeBaseUsd,
      maxPositionUsd: config.maxPositionUsd,
      maxWalletExposureUsd: config.maxWalletExposureUsd,
      maxTradesPerHour: config.maxTradesPerHour,
      marketCooldownSeconds: config.marketCooldownSeconds,
      overridesApplied: config.overridesApplied,
      unsafeOverridesApplied: config.unsafeOverridesApplied,
      rpcUrl: config.rpcUrl,
      privateKey: redact(config.privateKey),
      proxyWallet: config.proxyWallet,
      collateralTokenAddress: config.collateralTokenAddress,
    });
  }

  return config;
}

export function loadMonitorConfig(overrides: Overrides = {}): MonitorRuntimeConfig {
  const allowUnsafe = readBool('ARB_ALLOW_UNSAFE_OVERRIDES', false, overrides);
  const monitorPresetLookup = getPresetName(
    'MONITOR_PRESET',
    DEFAULT_MONITOR_PRESET,
    MONITOR_LEGACY_KEYS,
    overrides,
  );
  let presetName = monitorPresetLookup.presetName;
  const { legacyKeysDetected } = monitorPresetLookup;

  if (presetName === 'custom') {
    warnLegacyKeys('MONITOR', legacyKeysDetected);
  }

  let preset = presetName === 'custom' ? undefined : MONITOR_PRESETS[presetName as keyof typeof MONITOR_PRESETS];
  if (!preset && presetName !== 'custom') {
    // eslint-disable-next-line no-console
    console.warn(`[Config] Unknown MONITOR_PRESET="${presetName}", falling back to ${DEFAULT_MONITOR_PRESET}.`);
    presetName = DEFAULT_MONITOR_PRESET;
    preset = MONITOR_PRESETS[DEFAULT_MONITOR_PRESET];
  }

  const baseConfig: MonitorRuntimeConfig = {
    presetName,
    enabled: MONITOR_LEGACY_DEFAULTS.enabled,
    targetAddresses: [],
    proxyWallet: '',
    privateKey: '',
    mongoUri: readEnv('MONGO_URI', overrides),
    rpcUrl: '',
    fetchIntervalSeconds: MONITOR_LEGACY_DEFAULTS.fetchIntervalSeconds,
    tradeMultiplier: MONITOR_LEGACY_DEFAULTS.tradeMultiplier,
    retryLimit: MONITOR_LEGACY_DEFAULTS.retryLimit,
    aggregationEnabled: MONITOR_LEGACY_DEFAULTS.aggregationEnabled,
    aggregationWindowSeconds: MONITOR_LEGACY_DEFAULTS.aggregationWindowSeconds,
    requireConfirmed: MONITOR_LEGACY_DEFAULTS.requireConfirmed,
    collateralTokenAddress: POLYGON_USDC_ADDRESS,
    collateralTokenDecimals: 6,
    polymarketApiKey: required('POLYMARKET_API_KEY', overrides),
    polymarketApiSecret: required('POLYMARKET_API_SECRET', overrides),
    polymarketApiPassphrase: required('POLYMARKET_API_PASSPHRASE', overrides),
    minTradeSizeUsd: MONITOR_LEGACY_DEFAULTS.minTradeSizeUsd,
    frontrunSizeMultiplier: MONITOR_LEGACY_DEFAULTS.frontrunSizeMultiplier,
    gasPriceMultiplier: MONITOR_LEGACY_DEFAULTS.gasPriceMultiplier,
    overridesApplied: [],
    ignoredOverrides: [],
    unsafeOverridesApplied: [],
  };

  if (preset && presetName !== 'custom') {
    mapPresetValues(baseConfig, preset as Record<string, unknown>, MONITOR_ENV_MAP);
  }

  let overrideResult = { applied: [] as string[], unsafeApplied: [] as string[], ignored: [] as string[] };
  if (presetName === 'custom') {
    const baseConfigRecord = baseConfig as Record<
      keyof MonitorRuntimeConfig,
      MonitorRuntimeConfig[keyof MonitorRuntimeConfig]
    >;
    Object.keys(MONITOR_ENV_MAP).forEach((envKey) => {
      const raw = readEnv(envKey, overrides);
      if (raw === undefined) return;
      const mapping = MONITOR_ENV_MAP[envKey as keyof typeof MONITOR_ENV_MAP];
      const parsed = mapping.parse(raw);
      if (parsed === undefined) return;
      baseConfigRecord[mapping.key] = parsed as MonitorRuntimeConfig[keyof MonitorRuntimeConfig];
    });
  } else {
    overrideResult = applyOverrides(baseConfig, overrides, MONITOR_ENV_MAP, MONITOR_OVERRIDE_ALLOWLIST, allowUnsafe);
    warnIgnoredOverrides('MONITOR', overrideResult.ignored);
    warnUnsafeOverrides('MONITOR', overrideResult.unsafeApplied);
    if (overrideResult.applied.length > 0) {
      // eslint-disable-next-line no-console
      console.info(`[Config] MONITOR overrides applied: ${overrideResult.applied.join(', ')}`);
    }
  }

  const minTradeOverride = resolveLegacyMinTradeOverride(overrides);
  if (minTradeOverride.value !== undefined && (presetName === 'custom' || MONITOR_OVERRIDE_ALLOWLIST.has('MIN_TRADE_SIZE_USD'))) {
    baseConfig.minTradeSizeUsd = minTradeOverride.value;
    if (minTradeOverride.key && minTradeOverride.key !== 'MIN_TRADE_SIZE_USD') {
      warnLegacyKeys('MONITOR', [minTradeOverride.key]);
    }
  } else if (minTradeOverride.key && minTradeOverride.value === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[Config] MONITOR override ${minTradeOverride.key} ignored (invalid value).`);
  }

  const targetAddresses = parseList(readEnv('TARGET_ADDRESSES', overrides));
  if (targetAddresses.length === 0) {
    throw new Error('TARGET_ADDRESSES must contain at least one trader address');
  }

  baseConfig.targetAddresses = targetAddresses;
  baseConfig.proxyWallet = required('PUBLIC_KEY', overrides);
  baseConfig.privateKey = required('PRIVATE_KEY', overrides);
  baseConfig.rpcUrl = required('RPC_URL', overrides);
  baseConfig.collateralTokenAddress =
    readEnv('COLLATERAL_TOKEN_ADDRESS', overrides) || readEnv('USDC_CONTRACT_ADDRESS', overrides) || POLYGON_USDC_ADDRESS;
  baseConfig.collateralTokenDecimals = readNumber('COLLATERAL_TOKEN_DECIMALS', 6, overrides);

  if (presetName !== 'custom') {
    baseConfig.overridesApplied = overrideResult.applied;
    baseConfig.ignoredOverrides = overrideResult.ignored;
    baseConfig.unsafeOverridesApplied = overrideResult.unsafeApplied;
  } else {
    baseConfig.overridesApplied = legacyKeysDetected;
  }

  if (shouldPrintEffectiveConfig(overrides)) {
    printEffectiveConfig('monitor', {
      preset: baseConfig.presetName,
      enabled: baseConfig.enabled,
      fetchIntervalSeconds: baseConfig.fetchIntervalSeconds,
      minTradeSizeUsd: baseConfig.minTradeSizeUsd,
      tradeMultiplier: baseConfig.tradeMultiplier,
      requireConfirmed: baseConfig.requireConfirmed,
      gasPriceMultiplier: baseConfig.gasPriceMultiplier,
      overridesApplied: baseConfig.overridesApplied,
      unsafeOverridesApplied: baseConfig.unsafeOverridesApplied,
      rpcUrl: baseConfig.rpcUrl,
      privateKey: redact(baseConfig.privateKey),
      targetAddresses: baseConfig.targetAddresses.length,
    });
  }

  return baseConfig;
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
