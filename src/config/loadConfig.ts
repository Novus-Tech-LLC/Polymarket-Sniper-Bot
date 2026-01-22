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
  minOrderUsd: number;
  orderBalanceBufferBps: number;
  autoApprove: boolean;
  autoApproveMaxUsd?: number;
  orderSubmitMinIntervalMs: number;
  orderSubmitMaxPerHour: number;
  orderSubmitMarketCooldownSeconds: number;
  cloudflareCooldownSeconds: number;
  authCooldownSeconds: number;
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
  "MIN_ORDER_USD",
  "ORDER_BALANCE_BUFFER_BPS",
  "AUTO_APPROVE",
  "AUTO_APPROVE_MAX_USD",
  "ORDER_SUBMIT_MIN_INTERVAL_MS",
  "ORDER_SUBMIT_MAX_PER_HOUR",
  "ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS",
  "CLOUDFLARE_COOLDOWN_SECONDS",
  "CLOB_AUTH_COOLDOWN_SECONDS",
  "TRADE_MODE",
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
  feeBps: 10,
  startupCooldownSeconds: 120,
  marketCooldownSeconds: 900,
  maxTradesPerHour: 4,
  maxConsecutiveFailures: 2,
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
  maxConcurrentTrades: 1,
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
  minOrderUsd: DEFAULT_CONFIG.MIN_ORDER_USD,
  orderBalanceBufferBps: 0,
  autoApprove: false,
  autoApproveMaxUsd: undefined as number | undefined,
  orderSubmitMinIntervalMs: DEFAULT_CONFIG.ORDER_SUBMIT_MIN_INTERVAL_MS,
  orderSubmitMaxPerHour: DEFAULT_CONFIG.ORDER_SUBMIT_MAX_PER_HOUR,
  orderSubmitMarketCooldownSeconds:
    DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS,
  cloudflareCooldownSeconds: DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS,
  authCooldownSeconds: DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS,
  tradeMode: DEFAULT_CONFIG.TRADE_MODE,
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

const shouldPrintEffectiveConfig = (overrides?: Overrides): boolean =>
  readBool("PRINT_EFFECTIVE_CONFIG", false, overrides);

const redact = (value: string | undefined): string | undefined => {
  if (!value) return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
    minOrderUsd: MONITOR_LEGACY_DEFAULTS.minOrderUsd,
    orderBalanceBufferBps: MONITOR_LEGACY_DEFAULTS.orderBalanceBufferBps,
    autoApprove: MONITOR_LEGACY_DEFAULTS.autoApprove,
    autoApproveMaxUsd: MONITOR_LEGACY_DEFAULTS.autoApproveMaxUsd,
    orderSubmitMinIntervalMs: MONITOR_LEGACY_DEFAULTS.orderSubmitMinIntervalMs,
    orderSubmitMaxPerHour: MONITOR_LEGACY_DEFAULTS.orderSubmitMaxPerHour,
    orderSubmitMarketCooldownSeconds:
      MONITOR_LEGACY_DEFAULTS.orderSubmitMarketCooldownSeconds,
    cloudflareCooldownSeconds:
      MONITOR_LEGACY_DEFAULTS.cloudflareCooldownSeconds,
    authCooldownSeconds: MONITOR_LEGACY_DEFAULTS.authCooldownSeconds,
    tradeMode: MONITOR_LEGACY_DEFAULTS.tradeMode,
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
  autoSellEnabled: boolean;
  autoSellThreshold: number;
  autoSellMinHoldSeconds: number;
  endgameSweepEnabled: boolean;
  endgameMinPrice: number;
  endgameMaxPrice: number;
  endgameMaxPositionUsd: number;
  autoRedeemEnabled: boolean;
  autoRedeemMinPositionUsd: number;
  minOrderUsd: number;
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
    autoSellEnabled: preset.AUTO_SELL_ENABLED ?? false,
    autoSellThreshold: preset.AUTO_SELL_THRESHOLD ?? 0.99,
    autoSellMinHoldSeconds: preset.AUTO_SELL_MIN_HOLD_SECONDS ?? 120,
    endgameSweepEnabled: preset.ENDGAME_SWEEP_ENABLED ?? false,
    endgameMinPrice: preset.ENDGAME_MIN_PRICE ?? 0.98,
    endgameMaxPrice: preset.ENDGAME_MAX_PRICE ?? 0.995,
    endgameMaxPositionUsd: preset.MAX_POSITION_USD ?? 25,
    // AUTO_REDEEM_ENABLED: respect env override > preset > default (true)
    autoRedeemEnabled:
      parseBool(readEnv("AUTO_REDEEM_ENABLED", overrides) ?? "") ??
      preset.AUTO_REDEEM_ENABLED ??
      true, // Enabled by default - always claim resolved positions
    // AUTO_REDEEM_MIN_POSITION_USD: respect env override > preset > default ($0.10)
    autoRedeemMinPositionUsd:
      parseNumber(readEnv("AUTO_REDEEM_MIN_POSITION_USD", overrides) ?? "") ??
      preset.AUTO_REDEEM_MIN_POSITION_USD ??
      0.10, // Skip dust below 10 cents
    // MIN_ORDER_USD: respect env override > preset > default
    minOrderUsd:
      parseNumber(readEnv("MIN_ORDER_USD", overrides) ?? "") ??
      ("MIN_ORDER_USD" in preset ? (preset as { MIN_ORDER_USD: number }).MIN_ORDER_USD : undefined) ??
      DEFAULT_CONFIG.MIN_ORDER_USD,
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
