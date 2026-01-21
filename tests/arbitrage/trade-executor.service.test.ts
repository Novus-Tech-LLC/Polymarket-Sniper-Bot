import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { TradeExecutorService } from "../../src/services/trade-executor.service";
import type { RuntimeEnv } from "../../src/config/env";
import * as balanceUtils from "../../src/utils/get-balance.util";
import * as postOrderUtils from "../../src/utils/post-order.util";

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

const originalGetUsdBalanceApprox = balanceUtils.getUsdBalanceApprox;
const originalGetPolBalance = balanceUtils.getPolBalance;
const originalPostOrder = postOrderUtils.postOrder;

afterEach(() => {
  (
    balanceUtils as {
      getUsdBalanceApprox: typeof balanceUtils.getUsdBalanceApprox;
    }
  ).getUsdBalanceApprox = originalGetUsdBalanceApprox;
  (
    balanceUtils as { getPolBalance: typeof balanceUtils.getPolBalance }
  ).getPolBalance = originalGetPolBalance;
  (postOrderUtils as { postOrder: typeof postOrderUtils.postOrder }).postOrder =
    originalPostOrder;
});

test("frontrun logs success when order is accepted", async () => {
  const logs: string[] = [];
  const logger = {
    info: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
    error: (message: string) => logs.push(message),
    debug: (message: string) => logs.push(message),
  };

  (
    balanceUtils as {
      getUsdBalanceApprox: typeof balanceUtils.getUsdBalanceApprox;
    }
  ).getUsdBalanceApprox = async () => 500;
  (
    balanceUtils as { getPolBalance: typeof balanceUtils.getPolBalance }
  ).getPolBalance = async () => 5;
  (postOrderUtils as { postOrder: typeof postOrderUtils.postOrder }).postOrder =
    async () => ({
      status: "submitted",
      statusCode: 200,
      orderId: "order-123",
    });

  const executor = new TradeExecutorService({
    client: { wallet: {} } as never,
    proxyWallet: "0x" + "11".repeat(20),
    env: baseEnv,
    logger,
  });

  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-1",
    tokenId: "token-1",
    outcome: "YES",
    side: "BUY",
    sizeUsd: 100,
    price: 0.5,
    timestamp: Date.now(),
  });

  assert.ok(logs.some((line) => line.includes("Successfully executed")));
});

test("frontrun skips trade when order size is below MIN_ORDER_USD", async () => {
  const logs: string[] = [];
  const logger = {
    info: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
    error: (message: string) => logs.push(message),
    debug: (message: string) => logs.push(message),
  };

  (
    balanceUtils as {
      getUsdBalanceApprox: typeof balanceUtils.getUsdBalanceApprox;
    }
  ).getUsdBalanceApprox = async () => 500;
  (
    balanceUtils as { getPolBalance: typeof balanceUtils.getPolBalance }
  ).getPolBalance = async () => 5;

  // Mock postOrder - should NOT be called since order is too small
  let postOrderCalled = false;
  (postOrderUtils as { postOrder: typeof postOrderUtils.postOrder }).postOrder =
    async () => {
      postOrderCalled = true;
      return {
        status: "submitted",
        statusCode: 200,
        orderId: "order-123",
      };
    };

  const executor = new TradeExecutorService({
    client: { wallet: {} } as never,
    proxyWallet: "0x" + "11".repeat(20),
    env: { ...baseEnv, minOrderUsd: 50 }, // Set minimum to 50 USD
    logger,
  });

  // Target trade of 100 USD with 0.1 multiplier = 10 USD frontrun order
  // This should be below the 50 USD minimum
  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-1",
    tokenId: "token-1",
    outcome: "YES",
    side: "BUY",
    sizeUsd: 100,
    price: 0.5,
    timestamp: Date.now(),
  });

  // Verify the order was skipped
  assert.ok(
    logs.some((line) => line.includes("Order size 10.00 USD is below minimum 50.00 USD")),
    "Should log warning about order size being below minimum",
  );
  assert.ok(
    logs.some((line) => line.includes("Tip: Increase FRONTRUN_SIZE_MULTIPLIER")),
    "Should provide helpful tip",
  );
  assert.equal(postOrderCalled, false, "postOrder should not be called for orders below minimum");
});
