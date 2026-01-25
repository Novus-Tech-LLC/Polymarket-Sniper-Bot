import { Wallet } from "ethers";
import {
  DEFAULT_CONFIG,
  POLYGON_USDC_ADDRESS,
} from "../constants/polymarket.constants";
import type { ArbConfig } from "../arbitrage/config";
import {
  ARB_PRESETS,
  DEFAULT_ARB_PRESET,
  DEFAULT_MONITOR_PRESET,
  DEFAULT_STRATEGY_PRESET,
  MONITOR_PRESETS,
  STRATEGY_PRESETS,
  type StrategyPresetName,
} from "./presets";

export type TradeMode = "clob" | "onchain";

export type MonitorRuntimeConfig = {
  presetName: string;
  enabled: boolean;
  targetAddresses: string[];
  proxyWallet: string;
  privateKey: string;
  mongoUri?: string;
  rpcUrl: string;
  detectOnly: boolean;
  tradeMode: TradeMode;
  clobCredsComplete: boolean;
  clobDeriveEnabled: boolean;
  clobCredsChecklist: ClobCredsChecklist;
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
  frontrunMaxSizeUsd?: number;
  gasPriceMultiplier?: number;
  /**
   * Minimum price threshold for BUY orders (0-1 scale where 1 = $1)
   * Prevents buying extremely low-probability "loser" positions.
   * Set to 0 to uncap and allow buying at any price (for scalping).
   * Default: 0.50 (50¢) - blocks positions like 3¢ which are almost certain to lose.
   */
  minBuyPrice: number;
  minOrderUsd: number;
  orderBalanceBufferBps: number;
  autoApprove: boolean;
  autoApproveMaxUsd?: number;
  orderSubmitMinIntervalMs: number;
  orderSubmitMaxPerHour: number;
  orderSubmitMarketCooldownSeconds: number;
  orderDuplicatePreventionSeconds: number;
  cloudflareCooldownSeconds: number;
  authCooldownSeconds: number;
  /**
   * Low-price threshold for instant profit-taking (0-1 scale)
   * Positions bought below this price will take ANY profit immediately.
   * Set to 0 to disable. Example: 0.20 = take any profit on positions bought at or below 20¢
   */
  scalpLowPriceThreshold?: number;
  overridesApplied: string[];
  ignoredOverrides: string[];
  unsafeOverridesApplied: string[];
};

export type ArbRuntimeConfig = ArbConfig & {
  presetName: string;
  overridesApplied: string[];
  ignoredOverrides: string[];
  unsafeOverridesApplied: string[];
  clobCredsChecklist: ClobCredsChecklist;
};

export type ClobCredsChecklist = {
  key: { present: boolean; source?: string };
  secret: { present: boolean; source?: string };
  passphrase: { present: boolean; source?: string };
  deriveEnabled: boolean;
};

const ARB_OVERRIDE_ALLOWLIST = new Set([
  "ARB_DRY_RUN",
  "ARB_LIVE_TRADING",
  "ARB_MAX_WALLET_EXPOSURE_USD",
  "ARB_MAX_POSITION_USD",
  "ARB_MAX_TRADES_PER_HOUR",
  "ARB_MAX_SPREAD_BPS",
  "ARB_KILL_SWITCH_FILE",
  "ARB_DECISIONS_LOG",
  "ARB_MIN_POL_GAS",
  "ARB_SCAN_INTERVAL_MS",
  "ARB_DEBUG_TOP_N",
  "MIN_ORDER_USD",
  "ORDER_BALANCE_BUFFER_BPS",
  "AUTO_APPROVE",
  "AUTO_APPROVE_MAX_USD",
  "ORDER_SUBMIT_MIN_INTERVAL_MS",
  "ORDER_SUBMIT_MAX_PER_HOUR",
  "ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS",
  "ORDER_DUPLICATE_PREVENTION_SECONDS",
  "CLOUDFLARE_COOLDOWN_SECONDS",
  "CLOB_AUTH_COOLDOWN_SECONDS",
  "TRADE_MODE",
]);

const MONITOR_OVERRIDE_ALLOWLIST = new Set([
  "MIN_TRADE_SIZE_USD",
  "TRADE_MULTIPLIER",
  "FETCH_INTERVAL",
  "GAS_PRICE_MULTIPLIER",
  "FRONTRUN_SIZE_MULTIPLIER",
  "FRONTRUN_MAX_SIZE_USD",
  "MONITOR_REQUIRE_CONFIRMED",
  "MIN_BUY_PRICE",
  "MIN_ORDER_USD",
  "ORDER_BALANCE_BUFFER_BPS",
  "AUTO_APPROVE",
  "AUTO_APPROVE_MAX_USD",
  "ORDER_SUBMIT_MIN_INTERVAL_MS",
  "ORDER_SUBMIT_MAX_PER_HOUR",
  "ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS",
  "ORDER_DUPLICATE_PREVENTION_SECONDS",
  "CLOUDFLARE_COOLDOWN_SECONDS",
  "CLOB_AUTH_COOLDOWN_SECONDS",
  "TRADE_MODE",
  "SCALP_LOW_PRICE_THRESHOLD",
]);

const LEGACY_MIN_TRADE_KEYS = [
  "MIN_TRADE_SIZE",
  "MIN_TRADE_USDC",
  "MIN_TRADE_SIZE_USDC",
] as const;

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
  sizeScaling: "sqrt",
  slippageBps: 30,
  feeBps: 1, // Correct Polymarket taker fee: 0.01% (1 basis point)
  startupCooldownSeconds: 30,
  marketCooldownSeconds: 1,
  maxTradesPerHour: 100000,
  maxConsecutiveFailures: 10,
  dryRun: true,
  liveTrading: "",
  minPolGas: 3,
  approveUnlimited: false,
  detectOnly: false,
  tradeMode: DEFAULT_CONFIG.TRADE_MODE,
  clobCredsComplete: false,
  clobDeriveEnabled: true, // Default to true (pmxt-style: just need private key)
  stateDir: "/data",
  decisionsLog: "/data/arb_decisions.jsonl",
  killSwitchFile: "/data/KILL",
  snapshotState: true,
  maxConcurrentTrades: 50,
  debugTopN: 0,
  unitsAutoFix: true,
  logEveryMarket: false,
  rpcUrl: "",
  privateKey: "",
  proxyWallet: undefined,
  polymarketApiKey: "",
  polymarketApiSecret: "",
  polymarketApiPassphrase: "",
  collateralTokenAddress: POLYGON_USDC_ADDRESS,
  collateralTokenDecimals: 6,
  minOrderUsd: DEFAULT_CONFIG.MIN_ORDER_USD,
  orderBalanceBufferBps: 0,
  autoApprove: false,
  autoApproveMaxUsd: undefined,
  orderSubmitMinIntervalMs: DEFAULT_CONFIG.ORDER_SUBMIT_MIN_INTERVAL_MS,
  orderSubmitMaxPerHour: DEFAULT_CONFIG.ORDER_SUBMIT_MAX_PER_HOUR,
  orderSubmitMarketCooldownSeconds:
    DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS,
  orderDuplicatePreventionSeconds:
    DEFAULT_CONFIG.ORDER_DUPLICATE_PREVENTION_SECONDS,
  cloudflareCooldownSeconds: DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS,
  authCooldownSeconds: DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS,
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
  frontrunMaxSizeUsd: DEFAULT_CONFIG.FRONTRUN_MAX_SIZE_USD,
  gasPriceMultiplier: DEFAULT_CONFIG.GAS_PRICE_MULTIPLIER,
  minBuyPrice: DEFAULT_CONFIG.MIN_BUY_PRICE,
  minOrderUsd: DEFAULT_CONFIG.MIN_ORDER_USD,
  orderBalanceBufferBps: 0,
  autoApprove: false,
  autoApproveMaxUsd: undefined as number | undefined,
  orderSubmitMinIntervalMs: DEFAULT_CONFIG.ORDER_SUBMIT_MIN_INTERVAL_MS,
  orderSubmitMaxPerHour: DEFAULT_CONFIG.ORDER_SUBMIT_MAX_PER_HOUR,
  orderSubmitMarketCooldownSeconds:
    DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS,
  orderDuplicatePreventionSeconds:
    DEFAULT_CONFIG.ORDER_DUPLICATE_PREVENTION_SECONDS,
  cloudflareCooldownSeconds: DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS,
  authCooldownSeconds: DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS,
  tradeMode: DEFAULT_CONFIG.TRADE_MODE,
  scalpLowPriceThreshold: 0, // Set to e.g. 0.20 to take ANY profit on positions bought below 20¢
};

type EnvParser<T> = (raw: string) => T | undefined;

const parseNumber: EnvParser<number> = (raw) => {
  if (raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

const parseBool: EnvParser<boolean> = (raw) => {
  if (raw === "") return undefined;
  return String(raw).toLowerCase() === "true";
};

const parseString: EnvParser<string> = (raw) => raw;

const parseTradeMode: EnvParser<TradeMode> = (raw) => {
  if (raw === "") return undefined;
  const normalized = String(raw).toLowerCase();
  if (normalized === "clob" || normalized === "onchain") {
    return normalized as TradeMode;
  }
  // Invalid value - log warning and return default
  // Note: Using process.stderr since logger isn't available in config loading phase
  process.stderr.write(
    `[Config] Invalid TRADE_MODE="${raw}", defaulting to "clob". Valid values: "clob", "onchain"\n`,
  );
  return "clob";
};

const derivePublicKey = (
  privateKey: string | undefined,
): string | undefined => {
  if (!privateKey) return undefined;
  try {
    return new Wallet(privateKey).address;
  } catch {
    return undefined;
  }
};

const ARB_ENV_MAP = {
  ARB_ENABLED: { key: "enabled", parse: parseBool },
  ARB_SCAN_INTERVAL_MS: { key: "scanIntervalMs", parse: parseNumber },
  ARB_MIN_EDGE_BPS: { key: "minEdgeBps", parse: parseNumber },
  ARB_MIN_PROFIT_USD: { key: "minProfitUsd", parse: parseNumber },
  ARB_MIN_LIQUIDITY_USD: { key: "minLiquidityUsd", parse: parseNumber },
  ARB_MAX_SPREAD_BPS: { key: "maxSpreadBps", parse: parseNumber },
  ARB_MAX_HOLD_MINUTES: { key: "maxHoldMinutes", parse: parseNumber },
  ARB_TRADE_BASE_USD: { key: "tradeBaseUsd", parse: parseNumber },
  ARB_MAX_POSITION_USD: { key: "maxPositionUsd", parse: parseNumber },
  ARB_MAX_WALLET_EXPOSURE_USD: {
    key: "maxWalletExposureUsd",
    parse: parseNumber,
  },
  ARB_SIZE_SCALING: { key: "sizeScaling", parse: parseString },
  ARB_SLIPPAGE_BPS: { key: "slippageBps", parse: parseNumber },
  ARB_FEE_BPS: { key: "feeBps", parse: parseNumber },
  ARB_STARTUP_COOLDOWN_SECONDS: {
    key: "startupCooldownSeconds",
    parse: parseNumber,
  },
  ARB_MARKET_COOLDOWN_SECONDS: {
    key: "marketCooldownSeconds",
    parse: parseNumber,
  },
  ARB_MAX_TRADES_PER_HOUR: { key: "maxTradesPerHour", parse: parseNumber },
  ARB_MAX_CONSECUTIVE_FAILURES: {
    key: "maxConsecutiveFailures",
    parse: parseNumber,
  },
  ARB_DRY_RUN: { key: "dryRun", parse: parseBool },
  ARB_LIVE_TRADING: { key: "liveTrading", parse: parseString },
  ARB_MIN_POL_GAS: { key: "minPolGas", parse: parseNumber },
  ARB_APPROVE_UNLIMITED: { key: "approveUnlimited", parse: parseBool },
  ARB_STATE_DIR: { key: "stateDir", parse: parseString },
  ARB_DECISIONS_LOG: { key: "decisionsLog", parse: parseString },
  ARB_KILL_SWITCH_FILE: { key: "killSwitchFile", parse: parseString },
  ARB_SNAPSHOT_STATE: { key: "snapshotState", parse: parseBool },
  ARB_MAX_CONCURRENT_TRADES: { key: "maxConcurrentTrades", parse: parseNumber },
  ARB_DEBUG_TOP_N: { key: "debugTopN", parse: parseNumber },
  ARB_UNITS_AUTO_FIX: { key: "unitsAutoFix", parse: parseBool },
  ARB_LOG_EVERY_MARKET: { key: "logEveryMarket", parse: parseBool },
  MIN_ORDER_USD: { key: "minOrderUsd", parse: parseNumber },
  ORDER_BALANCE_BUFFER_BPS: {
    key: "orderBalanceBufferBps",
    parse: parseNumber,
  },
  AUTO_APPROVE: { key: "autoApprove", parse: parseBool },
  AUTO_APPROVE_MAX_USD: { key: "autoApproveMaxUsd", parse: parseNumber },
  ORDER_SUBMIT_MIN_INTERVAL_MS: {
    key: "orderSubmitMinIntervalMs",
    parse: parseNumber,
  },
  ORDER_SUBMIT_MAX_PER_HOUR: {
    key: "orderSubmitMaxPerHour",
    parse: parseNumber,
  },
  ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: {
    key: "orderSubmitMarketCooldownSeconds",
    parse: parseNumber,
  },
  ORDER_DUPLICATE_PREVENTION_SECONDS: {
    key: "orderDuplicatePreventionSeconds",
    parse: parseNumber,
  },
  CLOUDFLARE_COOLDOWN_SECONDS: {
    key: "cloudflareCooldownSeconds",
    parse: parseNumber,
  },
  CLOB_AUTH_COOLDOWN_SECONDS: {
    key: "authCooldownSeconds",
    parse: parseNumber,
  },
  TRADE_MODE: { key: "tradeMode", parse: parseTradeMode },
} as const satisfies Record<
  string,
  { key: keyof ArbConfig; parse: EnvParser<unknown> }
>;

const MONITOR_ENV_MAP = {
  MONITOR_ENABLED: { key: "enabled", parse: parseBool },
  FETCH_INTERVAL: { key: "fetchIntervalSeconds", parse: parseNumber },
  MIN_TRADE_SIZE_USD: { key: "minTradeSizeUsd", parse: parseNumber },
  TRADE_MULTIPLIER: { key: "tradeMultiplier", parse: parseNumber },
  RETRY_LIMIT: { key: "retryLimit", parse: parseNumber },
  TRADE_AGGREGATION_ENABLED: { key: "aggregationEnabled", parse: parseBool },
  TRADE_AGGREGATION_WINDOW_SECONDS: {
    key: "aggregationWindowSeconds",
    parse: parseNumber,
  },
  FRONTRUN_SIZE_MULTIPLIER: {
    key: "frontrunSizeMultiplier",
    parse: parseNumber,
  },
  FRONTRUN_MAX_SIZE_USD: {
    key: "frontrunMaxSizeUsd",
    parse: parseNumber,
  },
  GAS_PRICE_MULTIPLIER: { key: "gasPriceMultiplier", parse: parseNumber },
  MONITOR_REQUIRE_CONFIRMED: { key: "requireConfirmed", parse: parseBool },
  MIN_BUY_PRICE: { key: "minBuyPrice", parse: parseNumber },
  MIN_ORDER_USD: { key: "minOrderUsd", parse: parseNumber },
  ORDER_BALANCE_BUFFER_BPS: {
    key: "orderBalanceBufferBps",
    parse: parseNumber,
  },
  AUTO_APPROVE: { key: "autoApprove", parse: parseBool },
  AUTO_APPROVE_MAX_USD: { key: "autoApproveMaxUsd", parse: parseNumber },
  ORDER_SUBMIT_MIN_INTERVAL_MS: {
    key: "orderSubmitMinIntervalMs",
    parse: parseNumber,
  },
  ORDER_SUBMIT_MAX_PER_HOUR: {
    key: "orderSubmitMaxPerHour",
    parse: parseNumber,
  },
  ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: {
    key: "orderSubmitMarketCooldownSeconds",
    parse: parseNumber,
  },
  ORDER_DUPLICATE_PREVENTION_SECONDS: {
    key: "orderDuplicatePreventionSeconds",
    parse: parseNumber,
  },
  CLOUDFLARE_COOLDOWN_SECONDS: {
    key: "cloudflareCooldownSeconds",
    parse: parseNumber,
  },
  CLOB_AUTH_COOLDOWN_SECONDS: {
    key: "authCooldownSeconds",
    parse: parseNumber,
  },
  TRADE_MODE: { key: "tradeMode", parse: parseTradeMode },
  SCALP_LOW_PRICE_THRESHOLD: {
    key: "scalpLowPriceThreshold",
    parse: parseNumber,
  },
} as const satisfies Record<
  string,
  { key: keyof MonitorRuntimeConfig; parse: EnvParser<unknown> }
>;

const MONITOR_LEGACY_KEYS = [
  "FETCH_INTERVAL",
  "MIN_TRADE_SIZE_USD",
  ...LEGACY_MIN_TRADE_KEYS,
  "TRADE_MULTIPLIER",
  "RETRY_LIMIT",
  "TRADE_AGGREGATION_ENABLED",
  "TRADE_AGGREGATION_WINDOW_SECONDS",
  "FRONTRUN_SIZE_MULTIPLIER",
  "FRONTRUN_MAX_SIZE_USD",
  "GAS_PRICE_MULTIPLIER",
  "MONITOR_REQUIRE_CONFIRMED",
  "MIN_ORDER_USD",
  "ORDER_BALANCE_BUFFER_BPS",
  "AUTO_APPROVE",
  "AUTO_APPROVE_MAX_USD",
  "ORDER_SUBMIT_MIN_INTERVAL_MS",
  "ORDER_SUBMIT_MAX_PER_HOUR",
  "ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS",
  "ORDER_DUPLICATE_PREVENTION_SECONDS",
  "CLOUDFLARE_COOLDOWN_SECONDS",
];

const ARB_LEGACY_KEYS = Object.keys(ARB_ENV_MAP);

type Overrides = Record<string, string | undefined>;

const readEnv = (key: string, overrides?: Overrides): string | undefined =>
  overrides?.[key] ??
  overrides?.[key.toLowerCase()] ??
  process.env[key] ??
  process.env[key.toLowerCase()];

const readBool = (
  key: string,
  fallback: boolean,
  overrides?: Overrides,
): boolean => {
  const raw = readEnv(key, overrides);
  if (raw === undefined) return fallback;
  return String(raw).toLowerCase() === "true";
};

const readNumber = (
  key: string,
  fallback: number,
  overrides?: Overrides,
): number => {
  const raw = readEnv(key, overrides);
  const parsed = raw === undefined ? undefined : parseNumber(raw);
  return parsed ?? fallback;
};

const readFirstEnvWithSource = (
  keys: string[],
  overrides?: Overrides,
): { value?: string; source?: string } => {
  for (const key of keys) {
    const raw = readEnv(key, overrides);
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value.length > 0) return { value, source: key };
  }
  return {};
};

const readFirstEnv = (
  keys: string[],
  overrides?: Overrides,
): string | undefined => readFirstEnvWithSource(keys, overrides).value;

const readBoolFromKeys = (keys: string[], overrides?: Overrides): boolean => {
  for (const key of keys) {
    const raw = readEnv(key, overrides);
    if (raw === undefined) continue;
    if (String(raw).toLowerCase() === "true") return true;
  }
  return false;
};

const required = (key: string, overrides?: Overrides): string => {
  const raw = readEnv(key, overrides);
  if (!raw) throw new Error(`Missing required env var: ${key}`);
  return raw;
};

const CLOB_CRED_KEYS = {
  key: ["POLYMARKET_API_KEY", "POLY_API_KEY", "CLOB_API_KEY"],
  secret: ["POLYMARKET_API_SECRET", "POLY_SECRET", "CLOB_API_SECRET"],
  passphrase: [
    "POLYMARKET_API_PASSPHRASE",
    "POLY_PASSPHRASE",
    "CLOB_API_PASSPHRASE",
  ],
};

const CLOB_DERIVE_KEYS = [
  "CLOB_DERIVE_CREDS",
  "CLOB_DERIVE_API_KEY",
  "POLYMARKET_DERIVE_API_KEY",
  "POLY_DERIVE_API_KEY",
];

const readClobCreds = (
  overrides?: Overrides,
): { key?: string; secret?: string; passphrase?: string } => {
  // Always read credentials from environment - deriveEnabled should not prevent
  // using explicitly provided API credentials
  const keyEntry = readFirstEnvWithSource(CLOB_CRED_KEYS.key, overrides);
  const secretEntry = readFirstEnvWithSource(CLOB_CRED_KEYS.secret, overrides);
  const passphraseEntry = readFirstEnvWithSource(
    CLOB_CRED_KEYS.passphrase,
    overrides,
  );
  return {
    key: keyEntry.value,
    secret: secretEntry.value,
    passphrase: passphraseEntry.value,
  };
};

/**
 * Check if credential derivation is enabled.
 *
 * Following pmxt's approach: just provide PRIVATE_KEY and credentials are
 * automatically derived. This returns true by default unless explicitly
 * disabled with CLOB_DERIVE_CREDS=false.
 *
 * Key precedence (first one found wins):
 * 1. CLOB_DERIVE_CREDS
 * 2. CLOB_DERIVE_API_KEY
 * 3. POLYMARKET_DERIVE_API_KEY
 * 4. POLY_DERIVE_API_KEY
 *
 * If none are set, defaults to true (enabled).
 */
const readClobDeriveEnabled = (overrides?: Overrides): boolean => {
  // Check if any CLOB_DERIVE_* key is explicitly set (first one wins)
  for (const key of CLOB_DERIVE_KEYS) {
    const raw = readEnv(key, overrides);
    if (raw !== undefined) {
      // Explicitly set - use the value
      return String(raw).toLowerCase() === "true";
    }
  }
  // Not explicitly set - default to true (pmxt-style: just need private key)
  return true;
};

const buildClobCredsChecklist = (
  overrides?: Overrides,
  deriveEnabled?: boolean,
): ClobCredsChecklist => {
  const keyEntry = readFirstEnvWithSource(CLOB_CRED_KEYS.key, overrides);
  const secretEntry = readFirstEnvWithSource(CLOB_CRED_KEYS.secret, overrides);
  const passphraseEntry = readFirstEnvWithSource(
    CLOB_CRED_KEYS.passphrase,
    overrides,
  );
  // Check if credentials are actually present - they should be used even if deriveEnabled=true
  const hasKey = Boolean(keyEntry.value);
  const hasSecret = Boolean(secretEntry.value);
  const hasPassphrase = Boolean(passphraseEntry.value);
  const hasCompleteCreds = hasKey && hasSecret && hasPassphrase;

  // When derive is enabled but credentials are provided, explicit credentials take precedence
  // Only show "(ignored)" when derive is enabled AND no credentials are provided
  const showIgnored = deriveEnabled && !hasCompleteCreds;

  if (showIgnored) {
    return {
      key: {
        present: false,
        source: keyEntry.source ? `${keyEntry.source} (ignored)` : undefined,
      },
      secret: {
        present: false,
        source: secretEntry.source
          ? `${secretEntry.source} (ignored)`
          : undefined,
      },
      passphrase: {
        present: false,
        source: passphraseEntry.source
          ? `${passphraseEntry.source} (ignored)`
          : undefined,
      },
      deriveEnabled: true,
    };
  }
  return {
    key: { present: hasKey, source: keyEntry.source },
    secret: { present: hasSecret, source: secretEntry.source },
    passphrase: {
      present: hasPassphrase,
      source: passphraseEntry.source,
    },
    deriveEnabled: deriveEnabled ?? readClobDeriveEnabled(overrides),
  };
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
    .split(",")
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
    return { presetName: "custom", legacyKeysDetected };
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

const resolveLegacyMinTradeOverride = (
  overrides?: Overrides,
): { value?: number; key?: string } => {
  const canonicalRaw = readEnv("MIN_TRADE_SIZE_USD", overrides);
  const canonicalValue =
    canonicalRaw === undefined ? undefined : parseNumber(canonicalRaw);
  if (canonicalRaw !== undefined) {
    return { value: canonicalValue, key: "MIN_TRADE_SIZE_USD" };
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

  console.warn(`[Config] ${scope} legacy vars detected: ${keys.join(", ")}`);
};

const warnIgnoredOverrides = (scope: string, keys: string[]): void => {
  if (!keys.length) return;

  console.warn(
    `[Config] ${scope} overrides ignored (locked to preset): ${keys.join(", ")}`,
  );
};

const warnUnsafeOverrides = (scope: string, keys: string[]): void => {
  if (!keys.length) return;

  console.warn(
    `[Config] ${scope} unsafe overrides applied: ${keys.join(", ")}`,
  );
};

/**
 * Mapping of legacy env var names to their unified/canonical equivalents.
 * Used to detect conflicting configurations where both legacy and unified vars
 * are set to different values.
 *
 * HOW TO EXTEND:
 * When deprecating an env var in favor of a new unified name:
 * 1. Add the mapping: LEGACY_NAME: "UNIFIED_NAME"
 * 2. The system will warn if both are set to different values
 * 3. The unified value always takes precedence
 *
 * CURRENT MAPPINGS:
 * - MIN_TRADE_SIZE -> MIN_TRADE_SIZE_USD
 * - MIN_TRADE_USDC -> MIN_TRADE_SIZE_USD
 * - MIN_TRADE_SIZE_USDC -> MIN_TRADE_SIZE_USD
 */
const LEGACY_TO_UNIFIED_MAP: Record<string, string> = {
  // MIN_TRADE legacy aliases - all map to unified MIN_TRADE_SIZE_USD
  MIN_TRADE_SIZE: "MIN_TRADE_SIZE_USD",
  MIN_TRADE_USDC: "MIN_TRADE_SIZE_USD",
  MIN_TRADE_SIZE_USDC: "MIN_TRADE_SIZE_USD",
};

/**
 * Detect conflicts where both legacy and unified env vars are set to different values.
 * Returns an array of conflict descriptions for logging.
 */
const detectLegacyUnifiedConflicts = (
  overrides?: Overrides,
): {
  legacy: string;
  unified: string;
  legacyValue: string;
  unifiedValue: string;
}[] => {
  const conflicts: {
    legacy: string;
    unified: string;
    legacyValue: string;
    unifiedValue: string;
  }[] = [];

  for (const [legacyKey, unifiedKey] of Object.entries(LEGACY_TO_UNIFIED_MAP)) {
    const legacyValue = readEnv(legacyKey, overrides);
    const unifiedValue = readEnv(unifiedKey, overrides);

    if (
      legacyValue !== undefined &&
      unifiedValue !== undefined &&
      legacyValue !== unifiedValue
    ) {
      conflicts.push({
        legacy: legacyKey,
        unified: unifiedKey,
        legacyValue,
        unifiedValue,
      });
    }
  }

  return conflicts;
};

/**
 * Warn about legacy/unified conflicts and indicate which value is being used.
 * The unified value always takes precedence.
 */
const warnLegacyUnifiedConflicts = (
  scope: string,
  conflicts: {
    legacy: string;
    unified: string;
    legacyValue: string;
    unifiedValue: string;
  }[],
): void => {
  if (!conflicts.length) return;

  console.warn(
    `[Config] ${scope} ⚠️  LEGACY/UNIFIED CONFIG CONFLICT DETECTED:`,
  );
  for (const conflict of conflicts) {
    console.warn(
      `[Config]   ${conflict.legacy}="${conflict.legacyValue}" vs ${conflict.unified}="${conflict.unifiedValue}"`,
    );
    console.warn(
      `[Config]   → Using UNIFIED value: ${conflict.unified}="${conflict.unifiedValue}" (legacy ignored)`,
    );
  }
};

const shouldPrintEffectiveConfig = (overrides?: Overrides): boolean =>
  readBool("PRINT_EFFECTIVE_CONFIG", false, overrides);

const redact = (value: string | undefined): string | undefined => {
  if (!value) return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

/**
 * Config value with source tracking for debugging.
 */
type ConfigValueWithSource = {
  value: unknown;
  source: "preset" | "env_override" | "legacy_alias" | "default";
};

/**
 * Print effective config with source information for each value.
 * This helps debug config loading issues by showing where each value came from.
 */
const printEffectiveConfigWithSources = (
  label: string,
  payload: Record<string, unknown>,
  sources: Record<string, string>,
): void => {
  console.info(
    `[Config] ========== EFFECTIVE ${label.toUpperCase()} CONFIG ==========`,
  );
  for (const [key, value] of Object.entries(payload)) {
    const source = sources[key] || "default";
    const displayValue =
      key.toLowerCase().includes("key") ||
      key.toLowerCase().includes("secret") ||
      key.toLowerCase().includes("private")
        ? redact(String(value))
        : value;
    console.info(
      `[Config]   ${key}=${JSON.stringify(displayValue)} (${source})`,
    );
  }
  console.info(
    `[Config] ==========================================================`,
  );
};

const printEffectiveConfig = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  console.info(
    `[Config] Effective ${label} config: ${JSON.stringify(payload, null, 2)}`,
  );
};

export function loadArbConfig(overrides: Overrides = {}): ArbRuntimeConfig {
  const mode = String(
    readEnv("MODE", overrides) ?? readEnv("mode", overrides) ?? "arb",
  ).toLowerCase();
  const allowUnsafe = readBool("ARB_ALLOW_UNSAFE_OVERRIDES", false, overrides);
  const presetLookup = getPresetName(
    "ARB_PRESET",
    DEFAULT_ARB_PRESET,
    ARB_LEGACY_KEYS,
    overrides,
  );
  let presetName = presetLookup.presetName;
  const { legacyKeysDetected } = presetLookup;
  const clobDeriveEnabled = readClobDeriveEnabled(overrides);
  const clobCreds = readClobCreds(overrides);
  const clobCredsComplete = Boolean(
    clobCreds.key && clobCreds.secret && clobCreds.passphrase,
  );
  const clobCredsChecklist = buildClobCredsChecklist(
    overrides,
    clobDeriveEnabled,
  );

  // Check for legacy/unified conflicts EARLY and warn
  const legacyConflicts = detectLegacyUnifiedConflicts(overrides);
  warnLegacyUnifiedConflicts("ARB", legacyConflicts);

  if (presetName === "custom") {
    warnLegacyKeys("ARB", legacyKeysDetected);
  }

  let preset =
    presetName === "custom"
      ? undefined
      : ARB_PRESETS[presetName as keyof typeof ARB_PRESETS];
  if (!preset && presetName !== "custom") {
    console.warn(
      `[Config] Unknown ARB_PRESET="${presetName}", falling back to ${DEFAULT_ARB_PRESET}.`,
    );
    presetName = DEFAULT_ARB_PRESET;
    preset = ARB_PRESETS[DEFAULT_ARB_PRESET];
  }

  const baseConfig: ArbConfig = { ...ARB_LEGACY_DEFAULTS };

  if (preset && presetName !== "custom") {
    mapPresetValues(baseConfig, preset as Record<string, unknown>, ARB_ENV_MAP);
  }

  let overrideResult = {
    applied: [] as string[],
    unsafeApplied: [] as string[],
    ignored: [] as string[],
  };
  if (presetName === "custom") {
    const baseConfigRecord = baseConfig as Record<
      keyof ArbConfig,
      ArbConfig[keyof ArbConfig]
    >;
    Object.keys(ARB_ENV_MAP).forEach((envKey) => {
      const raw = readEnv(envKey, overrides);
      if (raw === undefined) return;
      const mapping = ARB_ENV_MAP[envKey as keyof typeof ARB_ENV_MAP];
      const parsed = mapping.parse(raw);
      if (parsed === undefined) return;
      baseConfigRecord[mapping.key] = parsed as ArbConfig[keyof ArbConfig];
    });
  } else {
    overrideResult = applyOverrides(
      baseConfig,
      overrides,
      ARB_ENV_MAP,
      ARB_OVERRIDE_ALLOWLIST,
      allowUnsafe,
    );
    warnIgnoredOverrides("ARB", overrideResult.ignored);
    warnUnsafeOverrides("ARB", overrideResult.unsafeApplied);
    if (overrideResult.applied.length > 0) {
      console.info(
        `[Config] ARB overrides applied: ${overrideResult.applied.join(", ")}`,
      );
    }
  }

  const enabledFromPreset = baseConfig.enabled;
  const enabledFromMode = mode === "arb" || mode === "both";

  const decisionsLogRaw = readEnv("ARB_DECISIONS_LOG", overrides);
  const collateralAddressRaw =
    readEnv("COLLATERAL_TOKEN_ADDRESS", overrides) ||
    readEnv("USDC_CONTRACT_ADDRESS", overrides) ||
    readEnv("POLY_USDCE_ADDRESS", overrides);

  const privateKey = required("PRIVATE_KEY", overrides);
  const proxyWallet =
    readEnv("PUBLIC_KEY", overrides) || derivePublicKey(privateKey);

  const config: ArbRuntimeConfig = {
    ...baseConfig,
    enabled: enabledFromPreset && enabledFromMode,
    decisionsLog: decisionsLogRaw === "" ? "" : baseConfig.decisionsLog,
    rpcUrl: required("RPC_URL", overrides),
    privateKey,
    proxyWallet,
    detectOnly: !clobCredsComplete && !clobDeriveEnabled,
    clobCredsComplete,
    clobDeriveEnabled,
    clobCredsChecklist,
    polymarketApiKey: clobCreds.key ?? "",
    polymarketApiSecret: clobCreds.secret ?? "",
    polymarketApiPassphrase: clobCreds.passphrase ?? "",
    collateralTokenAddress: collateralAddressRaw || POLYGON_USDC_ADDRESS,
    collateralTokenDecimals: readNumber(
      "COLLATERAL_TOKEN_DECIMALS",
      6,
      overrides,
    ),
    presetName,
    overridesApplied: [],
    ignoredOverrides: [],
    unsafeOverridesApplied: [],
  };

  if (presetName !== "custom") {
    config.overridesApplied = overrideResult.applied;
    config.ignoredOverrides = overrideResult.ignored;
    config.unsafeOverridesApplied = overrideResult.unsafeApplied;
  } else {
    config.overridesApplied = legacyKeysDetected;
  }

  if (shouldPrintEffectiveConfig(overrides)) {
    printEffectiveConfig("arb", {
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

export function loadMonitorConfig(
  overrides: Overrides = {},
): MonitorRuntimeConfig {
  const allowUnsafe = readBool("ARB_ALLOW_UNSAFE_OVERRIDES", false, overrides);
  const monitorPresetLookup = getPresetName(
    "MONITOR_PRESET",
    DEFAULT_MONITOR_PRESET,
    MONITOR_LEGACY_KEYS,
    overrides,
  );
  let presetName = monitorPresetLookup.presetName;
  const { legacyKeysDetected } = monitorPresetLookup;
  const clobDeriveEnabled = readClobDeriveEnabled(overrides);
  const clobCreds = readClobCreds(overrides);
  const clobCredsComplete = Boolean(
    clobCreds.key && clobCreds.secret && clobCreds.passphrase,
  );
  const clobCredsChecklist = buildClobCredsChecklist(
    overrides,
    clobDeriveEnabled,
  );

  // Check for legacy/unified conflicts EARLY and warn
  const legacyConflicts = detectLegacyUnifiedConflicts(overrides);
  warnLegacyUnifiedConflicts("MONITOR", legacyConflicts);

  if (presetName === "custom") {
    warnLegacyKeys("MONITOR", legacyKeysDetected);
  }

  let preset =
    presetName === "custom"
      ? undefined
      : MONITOR_PRESETS[presetName as keyof typeof MONITOR_PRESETS];
  if (!preset && presetName !== "custom") {
    console.warn(
      `[Config] Unknown MONITOR_PRESET="${presetName}", falling back to ${DEFAULT_MONITOR_PRESET}.`,
    );
    presetName = DEFAULT_MONITOR_PRESET;
    preset = MONITOR_PRESETS[DEFAULT_MONITOR_PRESET];
  }

  const baseConfig: MonitorRuntimeConfig = {
    presetName,
    enabled: MONITOR_LEGACY_DEFAULTS.enabled,
    targetAddresses: [],
    proxyWallet: "",
    privateKey: "",
    mongoUri: readEnv("MONGO_URI", overrides),
    rpcUrl: "",
    detectOnly: !clobCredsComplete && !clobDeriveEnabled,
    clobCredsComplete,
    clobDeriveEnabled,
    clobCredsChecklist,
    fetchIntervalSeconds: MONITOR_LEGACY_DEFAULTS.fetchIntervalSeconds,
    tradeMultiplier: MONITOR_LEGACY_DEFAULTS.tradeMultiplier,
    retryLimit: MONITOR_LEGACY_DEFAULTS.retryLimit,
    aggregationEnabled: MONITOR_LEGACY_DEFAULTS.aggregationEnabled,
    aggregationWindowSeconds: MONITOR_LEGACY_DEFAULTS.aggregationWindowSeconds,
    requireConfirmed: MONITOR_LEGACY_DEFAULTS.requireConfirmed,
    collateralTokenAddress: POLYGON_USDC_ADDRESS,
    collateralTokenDecimals: 6,
    polymarketApiKey: clobCreds.key ?? "",
    polymarketApiSecret: clobCreds.secret ?? "",
    polymarketApiPassphrase: clobCreds.passphrase ?? "",
    minTradeSizeUsd: MONITOR_LEGACY_DEFAULTS.minTradeSizeUsd,
    frontrunSizeMultiplier: MONITOR_LEGACY_DEFAULTS.frontrunSizeMultiplier,
    frontrunMaxSizeUsd: MONITOR_LEGACY_DEFAULTS.frontrunMaxSizeUsd,
    gasPriceMultiplier: MONITOR_LEGACY_DEFAULTS.gasPriceMultiplier,
    minBuyPrice: MONITOR_LEGACY_DEFAULTS.minBuyPrice,
    minOrderUsd: MONITOR_LEGACY_DEFAULTS.minOrderUsd,
    orderBalanceBufferBps: MONITOR_LEGACY_DEFAULTS.orderBalanceBufferBps,
    autoApprove: MONITOR_LEGACY_DEFAULTS.autoApprove,
    autoApproveMaxUsd: MONITOR_LEGACY_DEFAULTS.autoApproveMaxUsd,
    orderSubmitMinIntervalMs: MONITOR_LEGACY_DEFAULTS.orderSubmitMinIntervalMs,
    orderSubmitMaxPerHour: MONITOR_LEGACY_DEFAULTS.orderSubmitMaxPerHour,
    orderSubmitMarketCooldownSeconds:
      MONITOR_LEGACY_DEFAULTS.orderSubmitMarketCooldownSeconds,
    orderDuplicatePreventionSeconds:
      MONITOR_LEGACY_DEFAULTS.orderDuplicatePreventionSeconds,
    cloudflareCooldownSeconds:
      MONITOR_LEGACY_DEFAULTS.cloudflareCooldownSeconds,
    authCooldownSeconds: MONITOR_LEGACY_DEFAULTS.authCooldownSeconds,
    tradeMode: MONITOR_LEGACY_DEFAULTS.tradeMode,
    scalpLowPriceThreshold: MONITOR_LEGACY_DEFAULTS.scalpLowPriceThreshold,
    overridesApplied: [],
    ignoredOverrides: [],
    unsafeOverridesApplied: [],
  };

  if (preset && presetName !== "custom") {
    mapPresetValues(
      baseConfig,
      preset as Record<string, unknown>,
      MONITOR_ENV_MAP,
    );
  }

  let overrideResult = {
    applied: [] as string[],
    unsafeApplied: [] as string[],
    ignored: [] as string[],
  };
  if (presetName === "custom") {
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
      baseConfigRecord[mapping.key] =
        parsed as MonitorRuntimeConfig[keyof MonitorRuntimeConfig];
    });
  } else {
    overrideResult = applyOverrides(
      baseConfig,
      overrides,
      MONITOR_ENV_MAP,
      MONITOR_OVERRIDE_ALLOWLIST,
      allowUnsafe,
    );
    warnIgnoredOverrides("MONITOR", overrideResult.ignored);
    warnUnsafeOverrides("MONITOR", overrideResult.unsafeApplied);
    if (overrideResult.applied.length > 0) {
      console.info(
        `[Config] MONITOR overrides applied: ${overrideResult.applied.join(", ")}`,
      );
    }
  }

  const minTradeOverride = resolveLegacyMinTradeOverride(overrides);
  if (
    minTradeOverride.value !== undefined &&
    (presetName === "custom" ||
      MONITOR_OVERRIDE_ALLOWLIST.has("MIN_TRADE_SIZE_USD"))
  ) {
    baseConfig.minTradeSizeUsd = minTradeOverride.value;
    if (minTradeOverride.key && minTradeOverride.key !== "MIN_TRADE_SIZE_USD") {
      warnLegacyKeys("MONITOR", [minTradeOverride.key]);
    }
  } else if (minTradeOverride.key && minTradeOverride.value === undefined) {
    console.warn(
      `[Config] MONITOR override ${minTradeOverride.key} ignored (invalid value).`,
    );
  }

  const targetAddresses = parseList(readEnv("TARGET_ADDRESSES", overrides));
  if (targetAddresses.length === 0) {
    throw new Error(
      "TARGET_ADDRESSES must contain at least one trader address",
    );
  }

  baseConfig.targetAddresses = targetAddresses;
  const monitorPrivateKey = required("PRIVATE_KEY", overrides);
  baseConfig.proxyWallet =
    readEnv("PUBLIC_KEY", overrides) ||
    derivePublicKey(monitorPrivateKey) ||
    "";
  baseConfig.privateKey = monitorPrivateKey;
  baseConfig.rpcUrl = required("RPC_URL", overrides);
  baseConfig.collateralTokenAddress =
    readEnv("COLLATERAL_TOKEN_ADDRESS", overrides) ||
    readEnv("USDC_CONTRACT_ADDRESS", overrides) ||
    readEnv("POLY_USDCE_ADDRESS", overrides) ||
    POLYGON_USDC_ADDRESS;
  baseConfig.collateralTokenDecimals = readNumber(
    "COLLATERAL_TOKEN_DECIMALS",
    6,
    overrides,
  );

  if (presetName !== "custom") {
    baseConfig.overridesApplied = overrideResult.applied;
    baseConfig.ignoredOverrides = overrideResult.ignored;
    baseConfig.unsafeOverridesApplied = overrideResult.unsafeApplied;
  } else {
    baseConfig.overridesApplied = legacyKeysDetected;
  }

  if (shouldPrintEffectiveConfig(overrides)) {
    printEffectiveConfig("monitor", {
      preset: baseConfig.presetName,
      enabled: baseConfig.enabled,
      fetchIntervalSeconds: baseConfig.fetchIntervalSeconds,
      minTradeSizeUsd: baseConfig.minTradeSizeUsd,
      minOrderUsd: baseConfig.minOrderUsd,
      orderBalanceBufferBps: baseConfig.orderBalanceBufferBps,
      autoApprove: baseConfig.autoApprove,
      autoApproveMaxUsd: baseConfig.autoApproveMaxUsd,
      orderSubmitMinIntervalMs: baseConfig.orderSubmitMinIntervalMs,
      orderSubmitMaxPerHour: baseConfig.orderSubmitMaxPerHour,
      orderSubmitMarketCooldownSeconds:
        baseConfig.orderSubmitMarketCooldownSeconds,
      cloudflareCooldownSeconds: baseConfig.cloudflareCooldownSeconds,
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
    if (!arg.startsWith("--")) continue;
    const [rawKey, rawValue] = arg.slice(2).split("=");
    if (rawValue !== undefined) {
      overrides[rawKey.toUpperCase()] = rawValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      overrides[rawKey.toUpperCase()] = next;
      i += 1;
    } else {
      overrides[rawKey.toUpperCase()] = "true";
    }
  }
  return overrides;
}

/**
 * Strategy configuration type for unified presets
 */
export type StrategyConfig = {
  presetName: string;
  enabled: boolean;
  arbEnabled: boolean;
  monitorEnabled: boolean;
  quickFlipEnabled: boolean;
  quickFlipTargetPct: number;
  quickFlipStopLossPct: number;
  quickFlipMinHoldSeconds: number;
  quickFlipMinProfitUsd: number; // Minimum absolute profit in USD per trade
  quickFlipDynamicTargets: boolean; // Enable dynamic profit targets based on entry price
  endgameSweepEnabled: boolean;
  endgameMinPrice: number;
  endgameMaxPrice: number;
  endgameMaxPositionUsd: number;
  autoRedeemEnabled: boolean;
  autoRedeemMinPositionUsd: number;
  autoRedeemCheckIntervalMs: number;
  // Smart Hedging settings (replaces stop-loss for risky tier positions)
  smartHedgingEnabled: boolean;
  smartHedgingTriggerLossPct: number;
  smartHedgingMaxHedgeUsd: number;
  /**
   * Minimum USD for a hedge position - skip hedges below this threshold
   * Prevents creating micro-hedges that don't provide meaningful protection
   * Default: $1
   */
  smartHedgingMinHedgeUsd: number;
  smartHedgingReservePct: number;
  /**
   * Allow hedging to exceed MAX_POSITION_USD / maxHedgeUsd when needed to stop bleeding
   * Default: true - proper protection > arbitrary limits
   */
  smartHedgingAllowExceedMax: boolean;
  /**
   * Absolute maximum USD for hedge even when exceeding normal limits
   * Safety cap to prevent runaway hedging
   * Default: $100
   */
  smartHedgingAbsoluteMaxUsd: number;
  /**
   * Loss percentage threshold for emergency/full protection mode
   * When position drops beyond this %, use absoluteMaxUsd limit instead of maxHedgeUsd
   * Default: 30%
   */
  smartHedgingEmergencyLossPct: number;
  /**
   * Enable fallback liquidation when hedging fails
   * When true, if a hedge cannot execute, the position will be sold to stop further losses
   * Default: true - don't let losers sit and go to zero
   */
  smartHedgingEnableFallbackLiquidation: boolean;
  /**
   * Loss percentage threshold for forced liquidation
   * When position drops beyond this %, force liquidate even if hedging isn't optimal
   * Default: 50%
   */
  smartHedgingForceLiquidationLossPct: number;
  /**
   * Near-close window: minutes before market close to apply stricter hedge rules
   * Default: 15 minutes
   */
  smartHedgingNearCloseWindowMinutes: number;
  /**
   * Near-close: minimum adverse price drop in cents to trigger hedge
   * Default: 12 cents
   */
  smartHedgingNearClosePriceDropCents: number;
  /**
   * Near-close: minimum loss % to trigger hedge (OR condition with price drop)
   * Default: 30%
   */
  smartHedgingNearCloseLossPct: number;
  /**
   * No-hedge window: minutes before market close to disable hedging entirely
   * Default: 3 minutes
   */
  smartHedgingNoHedgeWindowMinutes: number;
  /**
   * Smart Hedging Direction: controls when hedging is active
   * - "down": Only hedge losing positions (traditional behavior)
   * - "up": Only buy more shares when winning at high probability (85¢+)
   * - "both": Both behaviors enabled (default - maximize wins AND minimize losses)
   */
  smartHedgingDirection: "down" | "up" | "both";
  /**
   * Hedge Up: Minimum price threshold to trigger buying more shares (default: 0.85 = 85¢)
   * When position price is at or above this threshold near market close,
   * buy additional shares to maximize gains since resolution to $1 is nearly guaranteed.
   */
  smartHedgingHedgeUpPriceThreshold: number;
  /**
   * Hedge Up: Maximum price threshold - don't buy at prices >= this (default: 0.95 = 95¢)
   * Prevents buying at prices that are essentially "closed" where profit margin is minimal.
   */
  smartHedgingHedgeUpMaxPrice: number;
  /**
   * Hedge Up: Minutes before market close to enable buying more shares (default: 30)
   * Only buy more shares when within this window AND price is in the valid range.
   */
  smartHedgingHedgeUpWindowMinutes: number;
  /**
   * Hedge Up: Maximum USD to spend on buying more shares per position (default: 25)
   * This is the maximum additional investment in a winning position.
   */
  smartHedgingHedgeUpMaxUsd: number;
  /**
   * Universal Stop-Loss: Minimum time (seconds) to hold before stop-loss can trigger.
   * Prevents selling positions immediately after buying due to bid-ask spread.
   * Default: 60 seconds
   */
  stopLossMinHoldSeconds: number;
  minOrderUsd: number;
  // === SCALP TAKE-PROFIT SETTINGS ===
  // Time-and-momentum-based profit taking to avoid waiting forever for resolution
  /**
   * Enable scalp take-profit strategy
   * Default: true (on by default across all presets)
   */
  scalpTakeProfitEnabled: boolean;
  /**
   * Minimum hold time (minutes) before considering scalp exit
   * Default: 45 (balanced), 30 (aggressive), 60 (conservative)
   */
  scalpMinHoldMinutes: number;
  /**
   * Maximum hold time (minutes) - force exit if profitable
   * Default: 90 (balanced), 60 (aggressive), 120 (conservative)
   */
  scalpMaxHoldMinutes: number;
  /**
   * Minimum profit % to consider scalp exit (after min hold)
   * Default: 5% (balanced), 4% (aggressive), 8% (conservative)
   */
  scalpMinProfitPct: number;
  /**
   * Target profit % - when reached, exit immediately (no momentum check needed)
   * Default: 8% (balanced), 6% (aggressive), 12% (conservative)
   */
  scalpTargetProfitPct: number;
  /**
   * Minimum profit in USD for scalp exit
   * Default: $1.00 (balanced), $0.50 (aggressive), $2.00 (conservative)
   */
  scalpMinProfitUsd: number;
  /**
   * Entry price threshold for resolution exclusion safeguard
   * CRITICAL: Never time-exit positions ≤ this price that reach 90¢+ (near resolution)
   * Default: 0.60 (60¢) - these are potential $1.00 winners
   */
  scalpResolutionExclusionPrice: number;
  /**
   * Enable sudden spike detection for immediate profit capture
   * When a massive move happens quickly, take the profit before it reverses
   * Default: true
   */
  scalpSuddenSpikeEnabled: boolean;
  /**
   * Profit threshold (%) for sudden spike detection
   * Default: 15% (balanced), 12% (aggressive), 20% (conservative)
   */
  scalpSuddenSpikeThresholdPct: number;
  /**
   * Time window (minutes) for detecting sudden spikes
   * Default: 10 (balanced), 5 (aggressive)
   */
  scalpSuddenSpikeWindowMinutes: number;
  /**
   * Low-price threshold for instant profit mode (0-1 scale)
   * Positions bought at or below this price take ANY profit immediately
   * Also allows buying at this price (bypasses MIN_BUY_PRICE)
   * Set to 0 to disable. Example: 0.20 = instant profit on positions ≤20¢
   */
  scalpLowPriceThreshold: number;
  /**
   * Maximum hold time (minutes) for low-price positions before cutting losses
   * If a low-price position hasn't profited within this window, exit at breakeven or small loss
   * Prevents holding volatile positions forever when they drop
   * Set to 0 to disable (hold indefinitely). Default: 3 minutes (quick scalps!)
   */
  scalpLowPriceMaxHoldMinutes: number;
  /**
   * Exit window duration in seconds for the scalp exit ladder
   * After a position is flagged for scalp, the ladder progresses: PROFIT -> BREAKEVEN -> FORCE
   * Default: 120 seconds (2 minutes)
   */
  scalpExitWindowSec: number;
  /**
   * Retry cadence in seconds during the PROFIT stage of exit ladder
   * How often to retry the profitable exit attempt
   * Default: 15 seconds
   */
  scalpProfitRetrySec: number;
  // === SELL EARLY STRATEGY SETTINGS (SIMPLIFIED Jan 2025) ===
  // Capital efficiency: Sell positions at 99.9¢ instead of waiting for slow redemption
  // ONE CORE BEHAVIOR: If bid >= 99.9¢, SELL IT. No extra knobs by default.
  /**
   * Enable sell-early strategy for capital efficiency
   * When a position is essentially won (price near $1) but not yet redeemable,
   * sell into the book to free capital immediately.
   * Default: true
   */
  sellEarlyEnabled: boolean;
  /**
   * Minimum bid price in cents to trigger sell-early (e.g., 99.9 = 99.9¢)
   * Position will be sold if best bid >= this threshold.
   * Default: 99.9 (99.9¢)
   */
  sellEarlyBidCents: number;
  /**
   * Minimum liquidity in USD at/near best bid to consider selling.
   * Set to 0 to DISABLE this check (default).
   * Prevents selling into thin books where slippage would be significant.
   * Default: 0 (DISABLED)
   */
  sellEarlyMinLiquidityUsd: number;
  /**
   * Maximum spread in cents allowed for sell-early.
   * Set to 0 to DISABLE this check (default).
   * If spread > this, the book may be stale or illiquid.
   * Default: 0 (DISABLED)
   */
  sellEarlyMaxSpreadCents: number;
  /**
   * Minimum time (seconds) to hold a position before sell-early can trigger.
   * Set to 0 to DISABLE this check (default).
   * Prevents instant flips if desired.
   * Default: 0 (DISABLED)
   */
  sellEarlyMinHoldSec: number;
  /**
   * Enable auto-sell strategy for near-resolution positions
   * Sells positions at 99¢+ to free capital instead of waiting for redemption.
   * Also handles dispute window exit at 99.9¢ for faster capital recovery.
   * Default: true
   */
  autoSellEnabled: boolean;
  /**
   * Price threshold for auto-sell (0.0-1.0 scale, e.g., 0.99 = 99¢)
   * Positions at or above this price will be sold.
   * Default: 0.99
   */
  autoSellThreshold: number;
  /**
   * Price threshold for dispute window exit (0.0-1.0 scale, e.g., 0.999 = 99.9¢)
   * Positions at or above this price will be sold immediately (no hold time).
   * Default: 0.999
   */
  autoSellDisputeExitPrice: number;
  /**
   * Enable dispute window exit feature
   * When true, positions at 99.9¢+ are sold immediately to avoid dispute hold wait.
   * Default: true
   */
  autoSellDisputeExitEnabled: boolean;
  /**
   * Minimum hold time (seconds) before auto-sell can trigger
   * Avoids conflict with endgame sweep which buys near-resolution positions.
   * Default: 60 (1 minute)
   */
  autoSellMinHoldSec: number;
  // Combined settings from ARB and MONITOR
  arbConfig?: ArbRuntimeConfig;
  monitorConfig?: MonitorRuntimeConfig;
};

/**
 * Load unified strategy configuration from STRATEGY_PRESET
 * Falls back to individual ARB_PRESET and MONITOR_PRESET if not set
 * Supports LIVE_TRADING as alias for ARB_LIVE_TRADING
 */
export function loadStrategyConfig(
  overrides?: Record<string, string>,
): StrategyConfig | null {
  const strategyPresetName = readEnv("STRATEGY_PRESET", overrides);

  // If no STRATEGY_PRESET is set, return null (use individual presets)
  if (!strategyPresetName) {
    return null;
  }

  // Validate preset name
  if (!(strategyPresetName in STRATEGY_PRESETS)) {
    throw new Error(
      `Invalid STRATEGY_PRESET="${strategyPresetName}". Valid values: ${Object.keys(STRATEGY_PRESETS).join(", ")}`,
    );
  }

  const presetName = strategyPresetName as StrategyPresetName;
  const preset = STRATEGY_PRESETS[presetName];

  // Support LIVE_TRADING as alias for ARB_LIVE_TRADING
  const liveTradingValue = readEnv("LIVE_TRADING", overrides);
  if (liveTradingValue) {
    // Set ARB_LIVE_TRADING from LIVE_TRADING if provided
    if (overrides) {
      overrides.ARB_LIVE_TRADING = liveTradingValue;
    } else {
      process.env.ARB_LIVE_TRADING = liveTradingValue;
    }
  }

  // Build strategy config
  const config: StrategyConfig = {
    presetName,
    enabled: preset.STRATEGY_ENABLED ?? false,
    arbEnabled: preset.ARB_ENABLED ?? false,
    monitorEnabled: preset.MONITOR_ENABLED ?? false,
    quickFlipEnabled: preset.QUICK_FLIP_ENABLED ?? false,
    quickFlipTargetPct: preset.QUICK_FLIP_TARGET_PCT ?? 5,
    quickFlipStopLossPct: preset.QUICK_FLIP_STOP_LOSS_PCT ?? 3,
    quickFlipMinHoldSeconds: preset.QUICK_FLIP_MIN_HOLD_SECONDS ?? 30,
    // QUICK_FLIP_MIN_PROFIT_USD: minimum absolute profit per trade
    // Ensures trades are worthwhile even on small positions
    // Default: $0.25 (5% on $5 position)
    quickFlipMinProfitUsd:
      parseNumber(readEnv("QUICK_FLIP_MIN_PROFIT_USD", overrides) ?? "") ??
      ("QUICK_FLIP_MIN_PROFIT_USD" in preset
        ? (preset as { QUICK_FLIP_MIN_PROFIT_USD: number })
            .QUICK_FLIP_MIN_PROFIT_USD
        : undefined) ??
      0.25, // Default $0.25 minimum profit per trade
    // QUICK_FLIP_DYNAMIC_TARGETS: enable entry-price-based dynamic profit targets
    // Lower entry price = higher profit target required (more uncertainty)
    // Default: false (use static targets from config)
    quickFlipDynamicTargets:
      parseBool(readEnv("QUICK_FLIP_DYNAMIC_TARGETS", overrides) ?? "") ??
      ("QUICK_FLIP_DYNAMIC_TARGETS" in preset
        ? (preset as { QUICK_FLIP_DYNAMIC_TARGETS: boolean })
            .QUICK_FLIP_DYNAMIC_TARGETS
        : undefined) ??
      false, // Default to static targets
    endgameSweepEnabled: preset.ENDGAME_SWEEP_ENABLED ?? false,
    endgameMinPrice: preset.ENDGAME_MIN_PRICE ?? 0.98,
    endgameMaxPrice: preset.ENDGAME_MAX_PRICE ?? 0.995,
    // MAX_POSITION_USD: respect env override > preset > default
    // This controls the maximum USD per position for all strategies
    endgameMaxPositionUsd:
      parseNumber(readEnv("MAX_POSITION_USD", overrides) ?? "") ??
      preset.MAX_POSITION_USD ??
      25,
    // AUTO_REDEEM_ENABLED: respect env override > preset > default (true)
    autoRedeemEnabled:
      parseBool(readEnv("AUTO_REDEEM_ENABLED", overrides) ?? "") ??
      preset.AUTO_REDEEM_ENABLED ??
      true, // Enabled by default - always claim resolved positions
    // AUTO_REDEEM_MIN_POSITION_USD: respect env override > preset > default ($0.10)
    autoRedeemMinPositionUsd:
      parseNumber(readEnv("AUTO_REDEEM_MIN_POSITION_USD", overrides) ?? "") ??
      preset.AUTO_REDEEM_MIN_POSITION_USD ??
      0.1, // Skip dust below 10 cents
    // AUTO_REDEEM_CHECK_INTERVAL_MS: how often to check for redeemable positions (default: 30000ms = 30 seconds)
    autoRedeemCheckIntervalMs:
      parseNumber(readEnv("AUTO_REDEEM_CHECK_INTERVAL_MS", overrides) ?? "") ??
      30000, // 30 seconds default
    /**
     * SMART HEDGING SETTINGS
     * Instead of selling risky positions (<60¢ entry) at a loss,
     * hedge by buying the opposing side to cap maximum loss at the spread
     */
    // SMART_HEDGING_ENABLED: enabled by default to minimize losses
    smartHedgingEnabled:
      parseBool(readEnv("SMART_HEDGING_ENABLED", overrides) ?? "") ??
      ("SMART_HEDGING_ENABLED" in preset
        ? (preset as { SMART_HEDGING_ENABLED: boolean }).SMART_HEDGING_ENABLED
        : undefined) ??
      true, // Enabled by default - make money, not lose it!
    // SMART_HEDGING_TRIGGER_LOSS_PCT: loss percentage to trigger hedging
    smartHedgingTriggerLossPct:
      parseNumber(readEnv("SMART_HEDGING_TRIGGER_LOSS_PCT", overrides) ?? "") ??
      ("SMART_HEDGING_TRIGGER_LOSS_PCT" in preset
        ? (preset as { SMART_HEDGING_TRIGGER_LOSS_PCT: number })
            .SMART_HEDGING_TRIGGER_LOSS_PCT
        : undefined) ??
      20, // Default: hedge at 20% loss
    // SMART_HEDGING_MAX_HEDGE_USD: maximum USD per hedge position
    smartHedgingMaxHedgeUsd:
      parseNumber(readEnv("SMART_HEDGING_MAX_HEDGE_USD", overrides) ?? "") ??
      ("SMART_HEDGING_MAX_HEDGE_USD" in preset
        ? (preset as { SMART_HEDGING_MAX_HEDGE_USD: number })
            .SMART_HEDGING_MAX_HEDGE_USD
        : undefined) ??
      10, // Default: max $10 per hedge
    // SMART_HEDGING_MIN_HEDGE_USD: minimum USD per hedge position (skip smaller hedges)
    // Prevents creating micro-hedges that don't provide meaningful protection
    smartHedgingMinHedgeUsd:
      parseNumber(readEnv("SMART_HEDGING_MIN_HEDGE_USD", overrides) ?? "") ??
      ("SMART_HEDGING_MIN_HEDGE_USD" in preset
        ? (preset as { SMART_HEDGING_MIN_HEDGE_USD: number })
            .SMART_HEDGING_MIN_HEDGE_USD
        : undefined) ??
      1, // Default: min $1 per hedge (skip micro-hedges below $1)
    // SMART_HEDGING_RESERVE_PCT: percentage of wallet to reserve for hedging
    smartHedgingReservePct:
      parseNumber(readEnv("SMART_HEDGING_RESERVE_PCT", overrides) ?? "") ??
      ("SMART_HEDGING_RESERVE_PCT" in preset
        ? (preset as { SMART_HEDGING_RESERVE_PCT: number })
            .SMART_HEDGING_RESERVE_PCT
        : undefined) ??
      20, // Default: keep 20% in reserve
    /**
     * SMART_HEDGING_ALLOW_EXCEED_MAX: Allow hedge to exceed maxHedgeUsd when stopping heavy losses
     * Set to "true" to allow hedging beyond normal limits when position is bleeding
     * Default: true (proper protection is more important than arbitrary limits)
     */
    smartHedgingAllowExceedMax:
      parseBool(readEnv("SMART_HEDGING_ALLOW_EXCEED_MAX", overrides) ?? "") ??
      ("SMART_HEDGING_ALLOW_EXCEED_MAX" in preset
        ? (preset as { SMART_HEDGING_ALLOW_EXCEED_MAX: boolean })
            .SMART_HEDGING_ALLOW_EXCEED_MAX
        : undefined) ??
      true, // Default: allow exceeding limits for protection
    /**
     * SMART_HEDGING_ABSOLUTE_MAX_USD: Safety cap for hedge size even when exceeding limits
     * This is the maximum a single hedge can ever be, regardless of position size
     * Default: $100
     */
    smartHedgingAbsoluteMaxUsd:
      parseNumber(readEnv("SMART_HEDGING_ABSOLUTE_MAX_USD", overrides) ?? "") ??
      ("SMART_HEDGING_ABSOLUTE_MAX_USD" in preset
        ? (preset as { SMART_HEDGING_ABSOLUTE_MAX_USD: number })
            .SMART_HEDGING_ABSOLUTE_MAX_USD
        : undefined) ??
      100, // Default: max $100 per hedge (safety cap)
    /**
     * SMART_HEDGING_EMERGENCY_LOSS_PCT: Loss % threshold for emergency full protection
     * When position drops beyond this %, switch to absoluteMaxUsd limit
     * Default: 30%
     */
    smartHedgingEmergencyLossPct:
      parseNumber(
        readEnv("SMART_HEDGING_EMERGENCY_LOSS_PCT", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_EMERGENCY_LOSS_PCT" in preset
        ? (preset as { SMART_HEDGING_EMERGENCY_LOSS_PCT: number })
            .SMART_HEDGING_EMERGENCY_LOSS_PCT
        : undefined) ??
      30, // Default: emergency mode at 30% loss
    /**
     * SMART_HEDGING_ENABLE_FALLBACK_LIQUIDATION: Enable fallback liquidation when hedging fails
     * When true, if a hedge cannot execute, the position will be sold to stop further losses
     * Default: true
     */
    smartHedgingEnableFallbackLiquidation:
      parseBool(
        readEnv("SMART_HEDGING_ENABLE_FALLBACK_LIQUIDATION", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_ENABLE_FALLBACK_LIQUIDATION" in preset
        ? (preset as { SMART_HEDGING_ENABLE_FALLBACK_LIQUIDATION: boolean })
            .SMART_HEDGING_ENABLE_FALLBACK_LIQUIDATION
        : undefined) ??
      true, // Default: enable fallback liquidation
    /**
     * SMART_HEDGING_FORCE_LIQUIDATION_LOSS_PCT: Loss % threshold for forced liquidation
     * When position drops beyond this %, force liquidate even if hedging isn't optimal
     * Default: 50%
     */
    smartHedgingForceLiquidationLossPct:
      parseNumber(
        readEnv("SMART_HEDGING_FORCE_LIQUIDATION_LOSS_PCT", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_FORCE_LIQUIDATION_LOSS_PCT" in preset
        ? (preset as { SMART_HEDGING_FORCE_LIQUIDATION_LOSS_PCT: number })
            .SMART_HEDGING_FORCE_LIQUIDATION_LOSS_PCT
        : undefined) ??
      50, // Default: force liquidate at 50% loss
    /**
     * SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES: Minutes before market close to apply stricter hedge rules
     * Inside this window, only hedge on big adverse moves or big losses
     * Default: 15 minutes
     */
    smartHedgingNearCloseWindowMinutes:
      parseNumber(
        readEnv("SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES" in preset
        ? (preset as { SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES: number })
            .SMART_HEDGING_NEAR_CLOSE_WINDOW_MINUTES
        : undefined) ??
      15, // Default: apply near-close rules in last 15 minutes
    /**
     * SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS: Minimum price drop (cents) to trigger near-close hedge
     * Near close, only hedge if price dropped by at least this amount (OR condition with loss %)
     * Default: 12 cents
     */
    smartHedgingNearClosePriceDropCents:
      parseNumber(
        readEnv("SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS" in preset
        ? (preset as { SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS: number })
            .SMART_HEDGING_NEAR_CLOSE_PRICE_DROP_CENTS
        : undefined) ??
      12, // Default: near-close hedge on >= 12¢ adverse move
    /**
     * SMART_HEDGING_NEAR_CLOSE_LOSS_PCT: Minimum loss % to trigger near-close hedge
     * Near close, only hedge if loss % exceeds this (OR condition with price drop)
     * Default: 30%
     */
    smartHedgingNearCloseLossPct:
      parseNumber(
        readEnv("SMART_HEDGING_NEAR_CLOSE_LOSS_PCT", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_NEAR_CLOSE_LOSS_PCT" in preset
        ? (preset as { SMART_HEDGING_NEAR_CLOSE_LOSS_PCT: number })
            .SMART_HEDGING_NEAR_CLOSE_LOSS_PCT
        : undefined) ??
      30, // Default: near-close hedge on >= 30% loss
    /**
     * SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES: Minutes before close to disable hedging entirely
     * Inside this window, hedging is blocked (too late - just liquidate if needed)
     * Default: 3 minutes
     */
    smartHedgingNoHedgeWindowMinutes:
      parseNumber(
        readEnv("SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES" in preset
        ? (preset as { SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES: number })
            .SMART_HEDGING_NO_HEDGE_WINDOW_MINUTES
        : undefined) ??
      3, // Default: don't hedge in last 3 minutes
    /**
     * SMART_HEDGING_DIRECTION: controls when hedging is active
     * - "down": Only hedge losing positions (traditional behavior)
     * - "up": Only buy more shares when winning at high probability
     * - "both": Both behaviors enabled (default - maximize wins AND minimize losses)
     */
    smartHedgingDirection: (() => {
      const envValue = readEnv("SMART_HEDGING_DIRECTION", overrides)?.toLowerCase();
      if (envValue === "down" || envValue === "up" || envValue === "both") {
        return envValue;
      }
      if ("SMART_HEDGING_DIRECTION" in preset) {
        const presetValue = (preset as { SMART_HEDGING_DIRECTION: string }).SMART_HEDGING_DIRECTION;
        if (presetValue === "down" || presetValue === "up" || presetValue === "both") {
          return presetValue;
        }
      }
      return "both"; // Default: both directions enabled
    })(),
    /**
     * SMART_HEDGING_HEDGE_UP_PRICE_THRESHOLD: minimum price to trigger buying more shares
     * When position price is at or above this threshold, buy additional shares
     * Default: 0.85 = 85¢
     */
    smartHedgingHedgeUpPriceThreshold:
      parseNumber(
        readEnv("SMART_HEDGING_HEDGE_UP_PRICE_THRESHOLD", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_HEDGE_UP_PRICE_THRESHOLD" in preset
        ? (preset as { SMART_HEDGING_HEDGE_UP_PRICE_THRESHOLD: number })
            .SMART_HEDGING_HEDGE_UP_PRICE_THRESHOLD
        : undefined) ??
      0.85, // Default: buy more at 85¢+
    /**
     * SMART_HEDGING_HEDGE_UP_MAX_PRICE: maximum price - don't buy at prices >= this
     * Prevents buying at essentially closed prices where profit margin is minimal
     * Default: 0.95 = 95¢
     */
    smartHedgingHedgeUpMaxPrice:
      parseNumber(
        readEnv("SMART_HEDGING_HEDGE_UP_MAX_PRICE", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_HEDGE_UP_MAX_PRICE" in preset
        ? (preset as { SMART_HEDGING_HEDGE_UP_MAX_PRICE: number })
            .SMART_HEDGING_HEDGE_UP_MAX_PRICE
        : undefined) ??
      0.95, // Default: don't buy at 95¢+ (too close to resolved)
    /**
     * SMART_HEDGING_HEDGE_UP_WINDOW_MINUTES: minutes before close to enable buying more
     * Only buy more shares when within this window AND price is in valid range
     * Default: 30 minutes
     */
    smartHedgingHedgeUpWindowMinutes:
      parseNumber(
        readEnv("SMART_HEDGING_HEDGE_UP_WINDOW_MINUTES", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_HEDGE_UP_WINDOW_MINUTES" in preset
        ? (preset as { SMART_HEDGING_HEDGE_UP_WINDOW_MINUTES: number })
            .SMART_HEDGING_HEDGE_UP_WINDOW_MINUTES
        : undefined) ??
      30, // Default: enable hedge up in last 30 minutes
    /**
     * SMART_HEDGING_HEDGE_UP_MAX_USD: maximum USD to spend on buying more per position
     * Default: 25 (matches absoluteMaxUsd)
     */
    smartHedgingHedgeUpMaxUsd:
      parseNumber(
        readEnv("SMART_HEDGING_HEDGE_UP_MAX_USD", overrides) ?? "",
      ) ??
      ("SMART_HEDGING_HEDGE_UP_MAX_USD" in preset
        ? (preset as { SMART_HEDGING_HEDGE_UP_MAX_USD: number })
            .SMART_HEDGING_HEDGE_UP_MAX_USD
        : undefined) ??
      25, // Default: max $25 per position on hedge up
    /**
     * STOP_LOSS_MIN_HOLD_SECONDS: Minimum time before stop-loss can trigger
     * Prevents premature stop-loss sells due to bid-ask spread right after buying
     * Default: 60 seconds
     */
    stopLossMinHoldSeconds:
      parseNumber(readEnv("STOP_LOSS_MIN_HOLD_SECONDS", overrides) ?? "") ??
      ("STOP_LOSS_MIN_HOLD_SECONDS" in preset
        ? (preset as { STOP_LOSS_MIN_HOLD_SECONDS: number })
            .STOP_LOSS_MIN_HOLD_SECONDS
        : undefined) ??
      60, // Default: 60 seconds minimum hold before stop-loss
    // MIN_ORDER_USD: respect env override > preset > default
    minOrderUsd:
      parseNumber(readEnv("MIN_ORDER_USD", overrides) ?? "") ??
      ("MIN_ORDER_USD" in preset
        ? (preset as { MIN_ORDER_USD: number }).MIN_ORDER_USD
        : undefined) ??
      DEFAULT_CONFIG.MIN_ORDER_USD,
    /**
     * SCALP TAKE-PROFIT SETTINGS
     * Time-and-momentum-based profit taking to avoid waiting forever for resolution.
     * Enabled by default across all presets.
     */
    // SCALP_TAKE_PROFIT_ENABLED: enabled by default
    scalpTakeProfitEnabled:
      parseBool(readEnv("SCALP_TAKE_PROFIT_ENABLED", overrides) ?? "") ??
      ("SCALP_TAKE_PROFIT_ENABLED" in preset
        ? (preset as { SCALP_TAKE_PROFIT_ENABLED: boolean })
            .SCALP_TAKE_PROFIT_ENABLED
        : undefined) ??
      true, // Default: enabled
    // SCALP_MIN_HOLD_MINUTES: minimum hold time before considering exit
    scalpMinHoldMinutes:
      parseNumber(readEnv("SCALP_MIN_HOLD_MINUTES", overrides) ?? "") ??
      ("SCALP_MIN_HOLD_MINUTES" in preset
        ? (preset as { SCALP_MIN_HOLD_MINUTES: number }).SCALP_MIN_HOLD_MINUTES
        : undefined) ??
      45, // Default: 45 minutes
    // SCALP_MAX_HOLD_MINUTES: force exit if profitable after this time
    scalpMaxHoldMinutes:
      parseNumber(readEnv("SCALP_MAX_HOLD_MINUTES", overrides) ?? "") ??
      ("SCALP_MAX_HOLD_MINUTES" in preset
        ? (preset as { SCALP_MAX_HOLD_MINUTES: number }).SCALP_MAX_HOLD_MINUTES
        : undefined) ??
      90, // Default: 90 minutes
    // SCALP_MIN_PROFIT_PCT: minimum profit % to consider exit
    // IMPORTANT: Must be high enough to clear transaction costs (fees + slippage + spread)!
    scalpMinProfitPct:
      parseNumber(readEnv("SCALP_MIN_PROFIT_PCT", overrides) ?? "") ??
      ("SCALP_MIN_PROFIT_PCT" in preset
        ? (preset as { SCALP_MIN_PROFIT_PCT: number }).SCALP_MIN_PROFIT_PCT
        : undefined) ??
      5.0, // Default: 5% - must clear ~3% costs to be meaningful
    // SCALP_TARGET_PROFIT_PCT: target profit % for exit
    scalpTargetProfitPct:
      parseNumber(readEnv("SCALP_TARGET_PROFIT_PCT", overrides) ?? "") ??
      ("SCALP_TARGET_PROFIT_PCT" in preset
        ? (preset as { SCALP_TARGET_PROFIT_PCT: number })
            .SCALP_TARGET_PROFIT_PCT
        : undefined) ??
      8.0, // Default: 8% - meaningful profit after all costs
    // SCALP_MIN_PROFIT_USD: minimum profit in USD for exit
    scalpMinProfitUsd:
      parseNumber(readEnv("SCALP_MIN_PROFIT_USD", overrides) ?? "") ??
      ("SCALP_MIN_PROFIT_USD" in preset
        ? (preset as { SCALP_MIN_PROFIT_USD: number }).SCALP_MIN_PROFIT_USD
        : undefined) ??
      1.0, // Default: $1.00 - at least $1 profit or don't bother
    // SCALP_RESOLUTION_EXCLUSION_PRICE: entry price threshold for resolution exclusion
    // CRITICAL: Never time-exit positions ≤ this price with increasing probability
    scalpResolutionExclusionPrice:
      parseNumber(
        readEnv("SCALP_RESOLUTION_EXCLUSION_PRICE", overrides) ?? "",
      ) ??
      ("SCALP_RESOLUTION_EXCLUSION_PRICE" in preset
        ? (preset as { SCALP_RESOLUTION_EXCLUSION_PRICE: number })
            .SCALP_RESOLUTION_EXCLUSION_PRICE
        : undefined) ??
      0.6, // Default: 60¢ - these are potential $1.00 winners
    // SCALP_SUDDEN_SPIKE_ENABLED: enable sudden spike detection
    scalpSuddenSpikeEnabled:
      parseBool(readEnv("SCALP_SUDDEN_SPIKE_ENABLED", overrides) ?? "") ??
      ("SCALP_SUDDEN_SPIKE_ENABLED" in preset
        ? (preset as { SCALP_SUDDEN_SPIKE_ENABLED: boolean })
            .SCALP_SUDDEN_SPIKE_ENABLED
        : undefined) ??
      true, // Default: enabled
    // SCALP_SUDDEN_SPIKE_THRESHOLD_PCT: profit threshold for spike detection
    scalpSuddenSpikeThresholdPct:
      parseNumber(
        readEnv("SCALP_SUDDEN_SPIKE_THRESHOLD_PCT", overrides) ?? "",
      ) ??
      ("SCALP_SUDDEN_SPIKE_THRESHOLD_PCT" in preset
        ? (preset as { SCALP_SUDDEN_SPIKE_THRESHOLD_PCT: number })
            .SCALP_SUDDEN_SPIKE_THRESHOLD_PCT
        : undefined) ??
      15.0, // Default: 15%
    // SCALP_SUDDEN_SPIKE_WINDOW_MINUTES: time window for spike detection
    scalpSuddenSpikeWindowMinutes:
      parseNumber(
        readEnv("SCALP_SUDDEN_SPIKE_WINDOW_MINUTES", overrides) ?? "",
      ) ??
      ("SCALP_SUDDEN_SPIKE_WINDOW_MINUTES" in preset
        ? (preset as { SCALP_SUDDEN_SPIKE_WINDOW_MINUTES: number })
            .SCALP_SUDDEN_SPIKE_WINDOW_MINUTES
        : undefined) ??
      10, // Default: 10 minutes
    // SCALP_LOW_PRICE_THRESHOLD: enable instant profit mode for low-price positions
    // Positions bought at or below this price take ANY profit immediately
    // Also allows buying at this price (bypasses MIN_BUY_PRICE)
    scalpLowPriceThreshold:
      parseNumber(readEnv("SCALP_LOW_PRICE_THRESHOLD", overrides) ?? "") ??
      ("SCALP_LOW_PRICE_THRESHOLD" in preset
        ? (preset as { SCALP_LOW_PRICE_THRESHOLD: number })
            .SCALP_LOW_PRICE_THRESHOLD
        : undefined) ??
      0, // Default: disabled
    // SCALP_LOW_PRICE_MAX_HOLD_MINUTES: max time to hold low-price positions
    // If position hasn't profited within this window, exit to avoid holding losers forever
    scalpLowPriceMaxHoldMinutes:
      parseNumber(
        readEnv("SCALP_LOW_PRICE_MAX_HOLD_MINUTES", overrides) ?? "",
      ) ??
      ("SCALP_LOW_PRICE_MAX_HOLD_MINUTES" in preset
        ? (preset as { SCALP_LOW_PRICE_MAX_HOLD_MINUTES: number })
            .SCALP_LOW_PRICE_MAX_HOLD_MINUTES
        : undefined) ??
      3, // Default: 3 minutes - quick scalps, don't hold volatile positions
    // SCALP_EXIT_WINDOW_SEC: Exit ladder window duration in seconds
    // When a scalp is triggered, the ladder progresses: PROFIT -> BREAKEVEN -> FORCE
    scalpExitWindowSec:
      parseNumber(readEnv("SCALP_EXIT_WINDOW_SEC", overrides) ?? "") ??
      ("SCALP_EXIT_WINDOW_SEC" in preset
        ? (preset as { SCALP_EXIT_WINDOW_SEC: number }).SCALP_EXIT_WINDOW_SEC
        : undefined) ??
      120, // Default: 120 seconds (2 minutes)
    // SCALP_PROFIT_RETRY_SEC: Retry cadence during PROFIT stage of exit ladder
    scalpProfitRetrySec:
      parseNumber(readEnv("SCALP_PROFIT_RETRY_SEC", overrides) ?? "") ??
      ("SCALP_PROFIT_RETRY_SEC" in preset
        ? (preset as { SCALP_PROFIT_RETRY_SEC: number }).SCALP_PROFIT_RETRY_SEC
        : undefined) ??
      15, // Default: 15 seconds
    // === SELL EARLY STRATEGY (Capital Efficiency - SIMPLIFIED Jan 2025) ===
    // SELL_EARLY_ENABLED: Enable selling near-$1 positions before redemption
    sellEarlyEnabled:
      parseBool(readEnv("SELL_EARLY_ENABLED", overrides) ?? "") ??
      ("SELL_EARLY_ENABLED" in preset
        ? (preset as { SELL_EARLY_ENABLED: boolean }).SELL_EARLY_ENABLED
        : undefined) ??
      true, // Default: enabled - free capital instead of waiting for redemption
    // SELL_EARLY_BID_CENTS: Minimum bid to trigger sell-early (in cents)
    sellEarlyBidCents:
      parseNumber(readEnv("SELL_EARLY_BID_CENTS", overrides) ?? "") ??
      ("SELL_EARLY_BID_CENTS" in preset
        ? (preset as { SELL_EARLY_BID_CENTS: number }).SELL_EARLY_BID_CENTS
        : undefined) ??
      99.9, // Default: 99.9¢ - essentially won positions
    // SELL_EARLY_MIN_LIQUIDITY_USD: Minimum depth at best bid (0 = DISABLED)
    sellEarlyMinLiquidityUsd:
      parseNumber(readEnv("SELL_EARLY_MIN_LIQUIDITY_USD", overrides) ?? "") ??
      ("SELL_EARLY_MIN_LIQUIDITY_USD" in preset
        ? (preset as { SELL_EARLY_MIN_LIQUIDITY_USD: number })
            .SELL_EARLY_MIN_LIQUIDITY_USD
        : undefined) ??
      0, // Default: 0 = DISABLED (no liquidity gating)
    // SELL_EARLY_MAX_SPREAD_CENTS: Maximum allowed spread (0 = DISABLED)
    sellEarlyMaxSpreadCents:
      parseNumber(readEnv("SELL_EARLY_MAX_SPREAD_CENTS", overrides) ?? "") ??
      ("SELL_EARLY_MAX_SPREAD_CENTS" in preset
        ? (preset as { SELL_EARLY_MAX_SPREAD_CENTS: number })
            .SELL_EARLY_MAX_SPREAD_CENTS
        : undefined) ??
      0, // Default: 0 = DISABLED (no spread gating)
    // SELL_EARLY_MIN_HOLD_SEC: Minimum hold time before sell-early (0 = DISABLED)
    sellEarlyMinHoldSec:
      parseNumber(readEnv("SELL_EARLY_MIN_HOLD_SEC", overrides) ?? "") ??
      ("SELL_EARLY_MIN_HOLD_SEC" in preset
        ? (preset as { SELL_EARLY_MIN_HOLD_SEC: number })
            .SELL_EARLY_MIN_HOLD_SEC
        : undefined) ??
      0, // Default: 0 = DISABLED (no hold time gating)
    // === AUTO-SELL STRATEGY (Near-Resolution Exit) ===
    // AUTO_SELL_ENABLED: Enable selling near-resolution ACTIVE positions (99¢+)
    autoSellEnabled:
      parseBool(readEnv("AUTO_SELL_ENABLED", overrides) ?? "") ??
      ("AUTO_SELL_ENABLED" in preset
        ? (preset as { AUTO_SELL_ENABLED: boolean }).AUTO_SELL_ENABLED
        : undefined) ??
      true, // Default: enabled - free capital for near-resolution positions
    // AUTO_SELL_THRESHOLD: Price threshold to trigger auto-sell (0.0-1.0 scale)
    autoSellThreshold:
      parseNumber(readEnv("AUTO_SELL_THRESHOLD", overrides) ?? "") ??
      ("AUTO_SELL_THRESHOLD" in preset
        ? (preset as { AUTO_SELL_THRESHOLD: number }).AUTO_SELL_THRESHOLD
        : undefined) ??
      0.999, // Default: 99.9¢ - sell positions near resolution
    // AUTO_SELL_DISPUTE_EXIT_PRICE: Price for dispute window exit (0.0-1.0 scale)
    autoSellDisputeExitPrice:
      parseNumber(readEnv("AUTO_SELL_DISPUTE_EXIT_PRICE", overrides) ?? "") ??
      ("AUTO_SELL_DISPUTE_EXIT_PRICE" in preset
        ? (preset as { AUTO_SELL_DISPUTE_EXIT_PRICE: number })
            .AUTO_SELL_DISPUTE_EXIT_PRICE
        : undefined) ??
      0.999, // Default: 99.9¢ - exit dispute window immediately
    // AUTO_SELL_DISPUTE_EXIT_ENABLED: Enable dispute window exit feature
    autoSellDisputeExitEnabled:
      parseBool(readEnv("AUTO_SELL_DISPUTE_EXIT_ENABLED", overrides) ?? "") ??
      ("AUTO_SELL_DISPUTE_EXIT_ENABLED" in preset
        ? (preset as { AUTO_SELL_DISPUTE_EXIT_ENABLED: boolean })
            .AUTO_SELL_DISPUTE_EXIT_ENABLED
        : undefined) ??
      true, // Default: enabled - avoid dispute hold wait
    // AUTO_SELL_MIN_HOLD_SEC: Minimum hold time before auto-sell (in seconds)
    autoSellMinHoldSec:
      parseNumber(readEnv("AUTO_SELL_MIN_HOLD_SEC", overrides) ?? "") ??
      ("AUTO_SELL_MIN_HOLD_SEC" in preset
        ? (preset as { AUTO_SELL_MIN_HOLD_SEC: number }).AUTO_SELL_MIN_HOLD_SEC
        : undefined) ??
      60, // Default: 60 seconds - avoid conflict with endgame sweep
  };

  // Apply preset settings to environment for ARB and MONITOR config loaders
  const tempEnv: Record<string, string> = {};

  // Map preset values to env vars
  for (const [key, value] of Object.entries(preset)) {
    if (value !== undefined && value !== null) {
      tempEnv[key] = String(value);
    }
  }

  // Merge temp env with overrides
  const mergedOverrides = { ...tempEnv, ...overrides };

  // Load ARB config if enabled
  if (config.arbEnabled) {
    try {
      config.arbConfig = loadArbConfig(mergedOverrides);
    } catch (err) {
      console.error("[StrategyConfig] Failed to load ARB config", err);
      throw err;
    }
  }

  // Load MONITOR config if enabled
  if (config.monitorEnabled) {
    try {
      config.monitorConfig = loadMonitorConfig(mergedOverrides);
    } catch (err) {
      console.error("[StrategyConfig] Failed to load MONITOR config", err);
      throw err;
    }
  }

  console.info(
    `[StrategyConfig] Loaded unified preset: ${presetName} (ARB=${config.arbEnabled}, MONITOR=${config.monitorEnabled})`,
  );

  return config;
}
