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
    logs.some((line) =>
      line.includes("Order size 10.00 USD is below minimum 50.00 USD"),
    ),
    "Should log warning about order size being below minimum",
  );
  assert.ok(
    logs.some((line) =>
      line.includes("Tip: Increase FRONTRUN_SIZE_MULTIPLIER"),
    ),
    "Should provide helpful tip",
  );
  assert.equal(
    postOrderCalled,
    false,
    "postOrder should not be called for orders below minimum",
  );
});

test("frontrun executes trade when MAX_POSITION_USD is set below MIN_ORDER_USD", async () => {
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

  // Simulate MAX_POSITION_USD=5 which is less than MIN_ORDER_USD=10
  const originalMaxPositionUsd = process.env.MAX_POSITION_USD;
  process.env.MAX_POSITION_USD = "5";

  try {
    const executor = new TradeExecutorService({
      client: { wallet: {} } as never,
      proxyWallet: "0x" + "11".repeat(20),
      env: { ...baseEnv, minOrderUsd: 10 }, // MIN_ORDER_USD=10
      logger,
    });

    // Target trade of 100 USD with 0.1 multiplier = 10 USD, but MAX_POSITION_USD=5 is used as fixed size
    // With the fix, this should execute because the effective minimum is adjusted to match MAX_POSITION_USD
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

    // Verify the order was executed (not skipped due to MIN_ORDER_USD conflict)
    assert.ok(
      logs.some((line) => line.includes("fixed by MAX_POSITION_USD")),
      "Should log that order uses fixed MAX_POSITION_USD size",
    );
    assert.ok(
      postOrderCalled,
      "postOrder should be called - effective min is adjusted to 5 USD (matching MAX_POSITION_USD)",
    );
    assert.ok(
      !logs.some((line) => line.includes("is below minimum")),
      "Should NOT log warning about order being below minimum when MAX_POSITION_USD is intentionally set low",
    );
  } finally {
    // Restore original env
    if (originalMaxPositionUsd !== undefined) {
      process.env.MAX_POSITION_USD = originalMaxPositionUsd;
    } else {
      delete process.env.MAX_POSITION_USD;
    }
  }
});

test("frontrun executes trade when FRONTRUN_MAX_SIZE_USD is set below MIN_ORDER_USD", async () => {
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
    env: { ...baseEnv, minOrderUsd: 10, frontrunMaxSizeUsd: 5 }, // FRONTRUN_MAX_SIZE_USD=5, MIN_ORDER_USD=10
    logger,
  });

  // Target trade of 100 USD with 0.1 multiplier = 10 USD, capped to 5 USD by FRONTRUN_MAX_SIZE_USD
  // With the fix, this should execute because the effective minimum is adjusted to match the cap
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

  // Verify the order was executed (not skipped due to MIN_ORDER_USD conflict)
  assert.ok(
    logs.some(
      (line) =>
        line.includes("capped from") && line.includes("FRONTRUN_MAX_SIZE_USD"),
    ),
    "Should log that order was capped by FRONTRUN_MAX_SIZE_USD",
  );
  assert.ok(
    postOrderCalled,
    "postOrder should be called - effective min is adjusted to 5 USD (matching FRONTRUN_MAX_SIZE_USD)",
  );
  assert.ok(
    !logs.some((line) => line.includes("is below minimum")),
    "Should NOT log warning about order being below minimum when FRONTRUN_MAX_SIZE_USD is intentionally set low",
  );
});

test("frontrun skips BUY trade when price is below MIN_BUY_PRICE threshold", async () => {
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

  // Mock postOrder - should NOT be called since price is too low
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
    env: { ...baseEnv, minBuyPrice: 0.15 }, // 15¢ minimum
    logger,
  });

  // Try to buy at 3¢ (0.03) - this should be blocked
  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-loser",
    tokenId: "token-loser",
    outcome: "YES",
    side: "BUY",
    sizeUsd: 100,
    price: 0.03, // 3¢ - way below the 15¢ minimum
    timestamp: Date.now(),
  });

  // Verify the order was skipped
  assert.ok(
    logs.some((line) =>
      line.includes("Skipping BUY - price 3.0¢ is below minimum 15.0¢"),
    ),
    "Should log warning about price being below minimum",
  );
  assert.ok(
    logs.some((line) => line.includes("prevents buying loser positions")),
    "Should mention loser position protection",
  );
  assert.equal(
    postOrderCalled,
    false,
    "postOrder should not be called for low-price BUY orders",
  );
});

test("frontrun blocks SELL copy trades - only BUY orders are copied", async () => {
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

  // Mock postOrder - should NOT be called for SELL (blocked)
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
    env: { ...baseEnv, minBuyPrice: 0.15 },
    logger,
  });

  // SELL trade - should be BLOCKED (we only copy BUY orders)
  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-sell",
    tokenId: "token-sell",
    outcome: "YES",
    side: "SELL",
    sizeUsd: 100,
    price: 0.85, // Good price, but SELL should still be blocked
    timestamp: Date.now(),
  });

  // Verify the SELL order was BLOCKED
  assert.ok(
    logs.some((line) => line.includes("Skipping SELL copy trade")),
    "Should log that SELL copy trades are blocked",
  );
  assert.ok(
    logs.some((line) => line.includes("only BUY orders are copied")),
    "Should explain that only BUY orders are copied",
  );
  assert.equal(
    postOrderCalled,
    false,
    "postOrder should NOT be called for SELL copy trades",
  );
});

test("frontrun allows BUY trade when price is above MIN_BUY_PRICE threshold", async () => {
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

  // Mock postOrder - SHOULD be called for BUY above threshold
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
    env: { ...baseEnv, minBuyPrice: 0.15 }, // 15¢ minimum
    logger,
  });

  // BUY at 50¢ (0.50) - this should be ALLOWED (above minimum)
  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-good",
    tokenId: "token-good",
    outcome: "YES",
    side: "BUY",
    sizeUsd: 100,
    price: 0.5, // 50¢ - well above the 15¢ minimum
    timestamp: Date.now(),
  });

  // Verify the BUY order was executed
  assert.ok(
    logs.some((line) => line.includes("Successfully executed")),
    "BUY orders above minimum price should be executed",
  );
  assert.ok(
    postOrderCalled,
    "postOrder should be called for BUY orders above minimum price",
  );
});

test("frontrun allows low-price BUY when scalpLowPriceThreshold is set", async () => {
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

  // Mock postOrder - SHOULD be called because scalpLowPriceThreshold allows it
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
    env: {
      ...baseEnv,
      minBuyPrice: 0.5, // 50¢ minimum normally
      scalpLowPriceThreshold: 0.2, // But allow scalping at ≤20¢
    },
    logger,
  });

  // Try to buy at 5¢ (0.05) - normally blocked by 50¢ minimum, but allowed by scalp threshold
  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-scalp",
    tokenId: "token-scalp",
    outcome: "YES",
    side: "BUY",
    sizeUsd: 100,
    price: 0.05, // 5¢ - below minBuyPrice (50¢) but within scalpLowPriceThreshold (20¢)
    timestamp: Date.now(),
  });

  // Verify the order was allowed due to scalp threshold
  assert.ok(
    logs.some((line) => line.includes("Low-price scalp allowed")),
    "Should log that low-price scalp is allowed",
  );
  assert.ok(
    logs.some((line) => line.includes("5.0¢ ≤ 20¢ threshold")),
    "Should show price is within scalp threshold",
  );
  assert.ok(
    postOrderCalled,
    "postOrder should be called when scalpLowPriceThreshold allows the buy",
  );
});

test("frontrun blocks low-price BUY when price exceeds scalpLowPriceThreshold", async () => {
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

  // Mock postOrder - should NOT be called
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
    env: {
      ...baseEnv,
      minBuyPrice: 0.5, // 50¢ minimum
      scalpLowPriceThreshold: 0.2, // Scalp threshold at 20¢
    },
    logger,
  });

  // Try to buy at 30¢ - above scalp threshold (20¢) but below minBuyPrice (50¢)
  // This should be BLOCKED because 30¢ > 20¢ threshold, so it falls back to minBuyPrice check
  await executor.frontrunTrade({
    trader: "0xabc",
    marketId: "market-mid",
    tokenId: "token-mid",
    outcome: "YES",
    side: "BUY",
    sizeUsd: 100,
    price: 0.3, // 30¢ - above scalpLowPriceThreshold (20¢), below minBuyPrice (50¢)
    timestamp: Date.now(),
  });

  // Verify the order was blocked
  assert.ok(
    logs.some((line) =>
      line.includes("Skipping BUY - price 30.0¢ is below minimum 50.0¢"),
    ),
    "Should be blocked by minBuyPrice since price exceeds scalpLowPriceThreshold",
  );
  assert.equal(
    postOrderCalled,
    false,
    "postOrder should NOT be called when price exceeds scalp threshold and is below minBuyPrice",
  );
});
