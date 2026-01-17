import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { MempoolMonitorService } from "../../src/services/mempool-monitor.service";
import type { RuntimeEnv } from "../../src/config/env";
import * as fetchData from "../../src/utils/fetch-data.util";

const baseEnv: RuntimeEnv = {
  presetName: "active",
  enabled: true,
  targetAddresses: ["0xabc"],
  proxyWallet: "0x" + "11".repeat(20),
  privateKey: "0x" + "22".repeat(32),
  mongoUri: undefined,
  rpcUrl: "http://localhost:8545",
  fetchIntervalSeconds: 1,
  tradeMultiplier: 1,
  retryLimit: 0,
  aggregationEnabled: false,
  aggregationWindowSeconds: 10,
  requireConfirmed: false,
  collateralTokenAddress: "0x" + "33".repeat(20),
  collateralTokenDecimals: 6,
  polymarketApiKey: undefined,
  polymarketApiSecret: undefined,
  polymarketApiPassphrase: undefined,
  minTradeSizeUsd: 10,
  frontrunSizeMultiplier: 0.1,
  gasPriceMultiplier: 1.0,
  minOrderUsd: 10,
  orderSubmitMinIntervalMs: 20000,
  orderSubmitMaxPerHour: 20,
  orderSubmitMarketCooldownSeconds: 300,
  cloudflareCooldownSeconds: 3600,
  overridesApplied: [],
  ignoredOverrides: [],
  unsafeOverridesApplied: [],
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const originalHttpGet = fetchData.httpGet;

afterEach(() => {
  (fetchData as { httpGet: typeof fetchData.httpGet }).httpGet =
    originalHttpGet;
});

test("monitor treats pending trades as eligible when confirmation is not required", async () => {
  const now = Math.floor(Date.now() / 1000);
  const activities = [
    {
      type: "TRADE",
      timestamp: now,
      conditionId: "market-1",
      asset: "token-1",
      size: 10,
      usdcSize: 120,
      price: 0.5,
      side: "buy",
      outcomeIndex: 0,
      transactionHash: "0xhash",
    },
  ];

  (fetchData as { httpGet: typeof fetchData.httpGet }).httpGet = async () =>
    activities;

  const detected: string[] = [];
  const service = new MempoolMonitorService({
    client: {} as never,
    env: { ...baseEnv, requireConfirmed: false },
    logger,
    onDetectedTrade: async (signal) => {
      detected.push(signal.marketId);
    },
  });

  (
    service as {
      provider?: { getTransactionReceipt: (hash: string) => Promise<null> };
    }
  ).provider = {
    getTransactionReceipt: async () => null,
  };

  const stats = {
    tradesSeen: 0,
    recentTrades: 0,
    eligibleTrades: 0,
    skippedSmallTrades: 0,
    skippedUnconfirmedTrades: 0,
    skippedNonTargetTrades: 0,
    skippedParseErrorTrades: 0,
    skippedOutsideRecentWindowTrades: 0,
    skippedUnsupportedActionTrades: 0,
    skippedMissingFieldsTrades: 0,
    skippedApiErrorTrades: 0,
    skippedOtherTrades: 0,
  };

  await (
    service as {
      checkRecentActivity: (
        target: string,
        stats: typeof stats,
      ) => Promise<void>;
    }
  ).checkRecentActivity(baseEnv.targetAddresses[0], stats);

  assert.equal(stats.eligibleTrades, 1);
  assert.equal(stats.skippedUnconfirmedTrades, 0);
  assert.equal(detected.length, 1);
});

test("monitor tracks skip counters for unsupported actions, missing fields, and stale trades", async () => {
  const now = Math.floor(Date.now() / 1000);
  const activities = [
    {
      type: "CANCEL",
      timestamp: now,
      conditionId: "market-1",
      asset: "token-1",
      size: 10,
      usdcSize: 120,
      price: 0.5,
      side: "buy",
      outcomeIndex: 0,
      transactionHash: "0xhash1",
    },
    {
      type: "TRADE",
      timestamp: now - 500,
      conditionId: "market-2",
      asset: "token-2",
      size: 10,
      usdcSize: 120,
      price: 0.5,
      side: "sell",
      outcomeIndex: 1,
      transactionHash: "0xhash2",
    },
    {
      type: "TRADE",
      timestamp: now,
      conditionId: "market-3",
      asset: "token-3",
      size: 10,
      usdcSize: 120,
      price: 0.5,
      side: "buy",
      outcomeIndex: undefined,
      transactionHash: "",
    },
  ];

  (fetchData as { httpGet: typeof fetchData.httpGet }).httpGet = async () =>
    activities;

  const service = new MempoolMonitorService({
    client: {} as never,
    env: { ...baseEnv, requireConfirmed: false },
    logger,
    onDetectedTrade: async () => undefined,
  });

  const stats = {
    tradesSeen: 0,
    recentTrades: 0,
    eligibleTrades: 0,
    skippedSmallTrades: 0,
    skippedUnconfirmedTrades: 0,
    skippedNonTargetTrades: 0,
    skippedParseErrorTrades: 0,
    skippedOutsideRecentWindowTrades: 0,
    skippedUnsupportedActionTrades: 0,
    skippedMissingFieldsTrades: 0,
    skippedApiErrorTrades: 0,
    skippedOtherTrades: 0,
  };

  await (
    service as {
      checkRecentActivity: (
        target: string,
        stats: typeof stats,
      ) => Promise<void>;
    }
  ).checkRecentActivity(baseEnv.targetAddresses[0], stats);

  assert.equal(stats.skippedUnsupportedActionTrades, 1);
  assert.equal(stats.skippedOutsideRecentWindowTrades, 1);
  assert.equal(stats.skippedMissingFieldsTrades, 1);
});
