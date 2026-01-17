import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderSubmissionController } from "../../src/utils/order-submission.util";

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
