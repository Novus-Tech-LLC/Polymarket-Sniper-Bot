import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadArbConfig, loadMonitorConfig } from '../../src/config/loadConfig';

const baseArbEnv = {
  RPC_URL: 'http://localhost:8545',
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  MODE: 'arb',
};

const baseMonitorEnv = {
  TARGET_ADDRESSES: '0xabc',
  PUBLIC_KEY: '0x' + '22'.repeat(20),
  PRIVATE_KEY: '0x' + '33'.repeat(32),
  RPC_URL: 'http://localhost:8545',
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

test('ARB_PRESET=micro loads expected defaults', () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: 'micro',
  });

  const config = loadArbConfig();
  assert.equal(config.scanIntervalMs, 1500);
  assert.equal(config.minEdgeBps, 60);
  assert.equal(config.minProfitUsd, 0.05);
  assert.equal(config.maxTradesPerHour, 15);
});

test('allowlisted override applies for arb presets', () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: 'safe_small',
    ARB_MAX_WALLET_EXPOSURE_USD: '40',
  });

  const config = loadArbConfig();
  assert.equal(config.maxWalletExposureUsd, 40);
});

test('ARB_MAX_SPREAD_BPS override applies for arb presets', () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: 'safe_small',
    ARB_MAX_SPREAD_BPS: '180',
  });

  const config = loadArbConfig();
  assert.equal(config.maxSpreadBps, 180);
});

test('non-allowlisted arb override is ignored unless unsafe overrides enabled', () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: 'safe_small',
    ARB_MIN_EDGE_BPS: '999',
  });

  const safeConfig = loadArbConfig();
  assert.equal(safeConfig.minEdgeBps, 120);

  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: 'safe_small',
    ARB_MIN_EDGE_BPS: '999',
    ARB_ALLOW_UNSAFE_OVERRIDES: 'true',
  });
  const unsafeConfig = loadArbConfig();
  assert.equal(unsafeConfig.minEdgeBps, 999);
});

test('MONITOR_PRESET=active changes min trade threshold (eligibility mocked)', () => {
  resetEnv();
  Object.assign(process.env, baseMonitorEnv, {
    MONITOR_PRESET: 'active',
  });

  const config = loadMonitorConfig();
  assert.equal(config.minTradeSizeUsd, 25);
  assert.equal(20 >= config.minTradeSizeUsd, false);
  assert.equal(30 >= config.minTradeSizeUsd, true);
});

test('legacy monitor vars trigger custom preset behavior', () => {
  resetEnv();
  Object.assign(process.env, baseMonitorEnv, {
    MIN_TRADE_SIZE: '75',
  });

  const config = loadMonitorConfig();
  assert.equal(config.presetName, 'custom');
  assert.equal(config.minTradeSizeUsd, 75);
});

test('print-effective-config includes preset and key subset', () => {
  resetEnv();
  Object.assign(process.env, baseArbEnv, {
    ARB_PRESET: 'classic',
    PRINT_EFFECTIVE_CONFIG: 'true',
  });

  const originalInfo = console.info;
  const lines: string[] = [];
  console.info = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    loadArbConfig();
  } finally {
    console.info = originalInfo;
  }

  const output = lines.join('\n');
  assert.match(output, /"preset":\s*"classic"/);
  assert.match(output, /scanIntervalMs/);
});
