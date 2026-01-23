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
  frontrunMaxSizeUsd: 50,
  gasPriceMultiplier: 1.0,
  minBuyPrice: 0.5,
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
    skippedLowPriceTrades: 0,
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
    skippedLowPriceTrades: 0,
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

test.skip("monitor gracefully handles RPC endpoint without eth_newPendingTransactionFilter support", async () => {
  const logMessages: string[] = [];
  const testLogger = {
    info: (msg: string) => logMessages.push(`INFO: ${msg}`),
    warn: (msg: string) => logMessages.push(`WARN: ${msg}`),
    error: (msg: string) => logMessages.push(`ERROR: ${msg}`),
    debug: (msg: string) => logMessages.push(`DEBUG: ${msg}`),
  };

  const service = new MempoolMonitorService({
    client: {} as never,
    env: { ...baseEnv, requireConfirmed: false },
    logger: testLogger,
    onDetectedTrade: async () => undefined,
  });

  // Mock provider that doesn't support eth_newPendingTransactionFilter
  const mockProvider = {
    send: async (method: string) => {
      if (method === "eth_newPendingTransactionFilter") {
        const error: Error & { code?: string } = new Error(
          "The method eth_newPendingTransactionFilter does not exist/is not available",
        );
        error.code = "UNSUPPORTED_OPERATION";
        throw error;
      }
      return null;
    },
    on: () => undefined,
    removeAllListeners: () => undefined,
  };

  (
    service as {
      provider?: typeof mockProvider;
    }
  ).provider = mockProvider;

  // Call enablePendingSubscription
  await (
    service as {
      enablePendingSubscription: () => Promise<void>;
    }
  ).enablePendingSubscription();

  // Verify that appropriate info messages were logged (not warning/error)
  const infoMessages = logMessages.filter((msg) => msg.startsWith("INFO:"));
  assert.ok(
    infoMessages.some((msg) =>
      msg.includes("does not support eth_newPendingTransactionFilter"),
    ),
    "Should log info about unsupported method",
  );
  assert.ok(
    infoMessages.some((msg) =>
      msg.includes("will continue to operate using Polymarket API polling"),
    ),
    "Should log info about fallback to API polling",
  );

  // Verify no error messages were logged
  const errorMessages = logMessages.filter((msg) => msg.startsWith("ERROR:"));
  assert.equal(
    errorMessages.length,
    0,
    "Should not log errors for unsupported RPC method",
  );
});

test("monitor skips low-price BUY trades and increments skippedLowPriceTrades", async () => {
  const now = Math.floor(Date.now() / 1000);
  const activities = [
    {
      type: "TRADE",
      timestamp: now,
      conditionId: "market-low-price",
      asset: "token-low-price",
      size: 1000,
      usdcSize: 120, // Above minTradeSizeUsd
      price: 0.03, // 3¢ - below default minBuyPrice of 50¢
      side: "buy",
      outcomeIndex: 0,
      transactionHash: "0xhash-low-price",
    },
  ];

  (fetchData as { httpGet: typeof fetchData.httpGet }).httpGet = async () =>
    activities;

  const detected: string[] = [];
  const debugLogs: string[] = [];
  const testLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: (msg: string) => debugLogs.push(msg),
  };

  const service = new MempoolMonitorService({
    client: {} as never,
    env: { ...baseEnv, requireConfirmed: false, minBuyPrice: 0.5 }, // 50¢ minimum
    logger: testLogger,
    onDetectedTrade: async (signal) => {
      detected.push(signal.marketId);
    },
  });

  const stats = {
    tradesSeen: 0,
    recentTrades: 0,
    eligibleTrades: 0,
    skippedSmallTrades: 0,
    skippedLowPriceTrades: 0,
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

  // Verify the low-price BUY was skipped
  assert.equal(
    stats.skippedLowPriceTrades,
    1,
    "Should increment skippedLowPriceTrades for low-price BUY",
  );
  assert.equal(
    stats.eligibleTrades,
    0,
    "Should not count low-price BUY as eligible",
  );
  assert.equal(
    detected.length,
    0,
    "Should not call onDetectedTrade for low-price BUY",
  );
});

test("monitor blocks SELL copy trades - only BUY orders are copied", async () => {
  const now = Math.floor(Date.now() / 1000);
  const activities = [
    {
      type: "TRADE",
      timestamp: now,
      conditionId: "market-sell",
      asset: "token-sell",
      size: 1000,
      usdcSize: 120, // Above minTradeSizeUsd
      price: 0.85, // 85¢ - good price, but this is a SELL
      side: "sell", // SELL should be BLOCKED for copy trading
      outcomeIndex: 0,
      transactionHash: "0xhash-sell",
    },
  ];

  (fetchData as { httpGet: typeof fetchData.httpGet }).httpGet = async () =>
    activities;

  const detected: string[] = [];
  const service = new MempoolMonitorService({
    client: {} as never,
    env: { ...baseEnv, requireConfirmed: false, minBuyPrice: 0.5 },
    logger,
    onDetectedTrade: async (signal) => {
      detected.push(signal.marketId);
    },
  });

  const stats = {
    tradesSeen: 0,
    recentTrades: 0,
    eligibleTrades: 0,
    skippedSmallTrades: 0,
    skippedLowPriceTrades: 0,
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

  // SELL should be BLOCKED - we only copy BUY orders
  assert.equal(stats.skippedOtherTrades, 1, "Should skip SELL trades");
  assert.equal(stats.eligibleTrades, 0, "SELL trade should NOT be eligible");
  assert.equal(detected.length, 0, "Should NOT call onDetectedTrade for SELL");
});
