import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OrderSubmissionController,
  extractFillInfo,
} from "../../src/utils/order-submission.util";

const createLogger = () => {
  const logs: string[] = [];
  return {
    logs,
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
      debug: (message: string) => logs.push(message),
    },
  };
};

test("cloudflare block triggers cooldown and blocks further submits", async () => {
  const { logs, logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  let submitCalls = 0;
  const error = {
    status: 403,
    response: {
      status: 403,
      data: "<html><body>Cloudflare - Sorry, you have been blocked</body></html>",
      headers: {
        "cf-ray": "abc123",
        "content-type": "text/html",
      },
    },
  };

  const firstResult = await controller.submit({
    sizeUsd: 50,
    marketId: "market-1",
    logger,
    now: 1000,
    submit: async () => {
      submitCalls += 1;
      throw error;
    },
  });

  assert.equal(firstResult.status, "failed");
  assert.equal(firstResult.reason, "CLOUDFLARE_BLOCK");
  assert.ok(firstResult.blockedUntil);

  const secondResult = await controller.submit({
    sizeUsd: 50,
    marketId: "market-1",
    logger,
    now: 1500,
    submit: async () => {
      submitCalls += 1;
      return {};
    },
  });

  assert.equal(secondResult.status, "skipped");
  assert.equal(secondResult.reason, "CLOUDFLARE_BLOCK");
  assert.equal(submitCalls, 1);
  assert.ok(
    logs.some((line) =>
      line.includes("CLOB execution paused due to Cloudflare block until"),
    ),
  );
});

test("tiny orders are skipped before submission", async () => {
  const { logs, logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 10,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  const result = await controller.submit({
    sizeUsd: 5,
    marketId: "market-2",
    logger,
    now: 2000,
    submit: async () => {
      throw new Error("should_not_run");
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "SKIP_MIN_ORDER_SIZE");
  assert.ok(logs.some((line) => line.includes("SKIP_MIN_ORDER_SIZE")));
});

test("tiny orders are allowed when skipMinOrderSizeCheck is true", async () => {
  const { logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 10,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    duplicatePreventionMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  let submitCalled = false;
  const result = await controller.submit({
    sizeUsd: 2.87, // Below minOrderUsd of 10
    marketId: "market-liquidate",
    logger,
    now: 2000,
    skipMinOrderSizeCheck: true, // Allow small orders for liquidations
    submit: async () => {
      submitCalled = true;
      return { status: 200, order: { id: "liquidation-order-123" } };
    },
  });

  assert.equal(result.status, "submitted");
  assert.ok(submitCalled, "submit should have been called");
  assert.equal(result.orderId, "liquidation-order-123");
});

test("401 auth failure triggers cooldown backoff", async () => {
  const { logs, logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  let submitCalls = 0;
  const firstResult = await controller.submit({
    sizeUsd: 50,
    marketId: "market-auth",
    logger,
    now: 5000,
    submit: async () => {
      submitCalls += 1;
      const error = new Error("Unauthorized");
      (error as { response?: { status: number } }).response = { status: 401 };
      throw error;
    },
  });

  assert.equal(firstResult.status, "failed");
  assert.equal(firstResult.reason, "AUTH_UNAUTHORIZED");
  assert.ok(firstResult.blockedUntil);

  const secondResult = await controller.submit({
    sizeUsd: 50,
    marketId: "market-auth",
    logger,
    now: 5500,
    submit: async () => {
      submitCalls += 1;
      return {};
    },
  });

  assert.equal(secondResult.status, "skipped");
  assert.equal(secondResult.reason, "AUTH_BLOCK");
  assert.equal(submitCalls, 1);
  assert.ok(logs.some((line) => line.includes("auth failure")));
});

// Tests for extractFillInfo function
test("extractFillInfo extracts both takingAmount and makingAmount", () => {
  const response = {
    takingAmount: "100.5",
    makingAmount: "50.25",
    status: "MATCHED",
  };
  const result = extractFillInfo(response);
  assert.deepEqual(result, {
    takingAmount: "100.5",
    makingAmount: "50.25",
    status: "MATCHED",
  });
});

test("extractFillInfo defaults missing makingAmount to 0", () => {
  const response = {
    takingAmount: "100.5",
  };
  const result = extractFillInfo(response);
  assert.deepEqual(result, {
    takingAmount: "100.5",
    makingAmount: "0",
    status: undefined,
  });
});

test("extractFillInfo defaults missing takingAmount to 0", () => {
  const response = {
    makingAmount: "50.25",
  };
  const result = extractFillInfo(response);
  assert.deepEqual(result, {
    takingAmount: "0",
    makingAmount: "50.25",
    status: undefined,
  });
});

test("extractFillInfo returns undefined when neither field is present", () => {
  const response = {
    orderID: "abc123",
  };
  const result = extractFillInfo(response);
  assert.equal(result, undefined);
});

test("extractFillInfo handles empty response", () => {
  const result = extractFillInfo({});
  assert.equal(result, undefined);
});

// Tests for FOK order detection
test("FOK order with takingAmount=0 and makingAmount=0 is identified as killed", async () => {
  const { logs, logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    duplicatePreventionMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  const result = await controller.submit({
    sizeUsd: 50,
    marketId: "market-fok",
    logger,
    now: 10000,
    submit: async () => ({
      status: 200, // HTTP status code
      order: { id: "order123" }, // Required for isOrderAccepted
      takingAmount: "0",
      makingAmount: "0",
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "FOK_ORDER_KILLED");
  assert.equal(result.orderId, "order123");
  assert.ok(result.fillInfo);
  assert.equal(result.fillInfo?.takingAmount, "0");
  assert.equal(result.fillInfo?.makingAmount, "0");
  assert.ok(logs.some((line) => line.includes("FOK order killed")));
});

test("FOK order with non-zero takingAmount is treated as successful", async () => {
  const { logs, logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    duplicatePreventionMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  const result = await controller.submit({
    sizeUsd: 50,
    marketId: "market-fok-success",
    logger,
    now: 11000,
    submit: async () => ({
      status: 200, // HTTP status code
      order: { id: "order456" },
      takingAmount: "100.5",
      makingAmount: "50.25",
    }),
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.orderId, "order456");
  assert.ok(result.fillInfo);
  assert.equal(result.fillInfo?.takingAmount, "100.5");
  assert.equal(result.fillInfo?.makingAmount, "50.25");
  assert.ok(logs.some((line) => line.includes("Order filled")));
});

test("FOK order with non-zero makingAmount only is treated as successful", async () => {
  const { logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    duplicatePreventionMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  const result = await controller.submit({
    sizeUsd: 50,
    marketId: "market-fok-making",
    logger,
    now: 12000,
    submit: async () => ({
      status: 200,
      order: { id: "order789" },
      takingAmount: "0",
      makingAmount: "50.25",
    }),
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.orderId, "order789");
});

test("malformed response with empty string amounts is handled correctly", async () => {
  const { logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    duplicatePreventionMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  // Empty strings are expected to parse to NaN (malformed response).
  // Since we can't determine if the order was killed or filled, we allow it to proceed.
  const result = await controller.submit({
    sizeUsd: 50,
    marketId: "market-malformed",
    logger,
    now: 13000,
    submit: async () => ({
      status: 200,
      order: { id: "order-malformed" },
      takingAmount: "",
      makingAmount: "",
    }),
  });

  // With empty strings parsing to NaN, the order proceeds as submitted
  assert.equal(result.status, "submitted");
  assert.equal(result.orderId, "order-malformed");
});

test("response without fill info is handled correctly", async () => {
  const { logger } = createLogger();
  const controller = new OrderSubmissionController({
    minOrderUsd: 1,
    minIntervalMs: 0,
    maxPerHour: 100,
    marketCooldownMs: 0,
    duplicatePreventionMs: 0,
    cloudflareCooldownMs: 1000,
    authCooldownMs: 1000,
  });

  // Response without takingAmount/makingAmount should proceed as submitted
  const result = await controller.submit({
    sizeUsd: 50,
    marketId: "market-no-fill-info",
    logger,
    now: 14000,
    submit: async () => ({
      status: 200,
      order: { id: "order-no-fill" },
    }),
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.orderId, "order-no-fill");
  assert.equal(result.fillInfo, undefined);
});
