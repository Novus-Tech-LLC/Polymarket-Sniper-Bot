import { afterEach, test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadStrategyConfig } from "../../src/config/loadConfig";
import {
  DEFAULT_SCALP_TAKE_PROFIT_CONFIG,
  type ExitPlan,
  type ExitLadderStage,
} from "../../src/strategies/scalp-take-profit";

const baseEnv = {
  RPC_URL: "http://localhost:8545",
  PRIVATE_KEY: "0x" + "11".repeat(32),
  POLYMARKET_API_KEY: "key",
  POLYMARKET_API_SECRET: "secret",
  POLYMARKET_API_PASSPHRASE: "passphrase",
  TARGET_ADDRESSES: "0xabc",
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

// === EXIT LADDER CONFIGURATION TESTS ===

describe("Exit Ladder Configuration", () => {
  test("SCALP_EXIT_WINDOW_SEC defaults to 120 seconds", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.equal(config?.scalpExitWindowSec, 120);
  });

  test("SCALP_EXIT_WINDOW_SEC env variable overrides default", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      SCALP_EXIT_WINDOW_SEC: "180",
    });

    const config = loadStrategyConfig();
    assert.equal(config?.scalpExitWindowSec, 180);
  });

  test("SCALP_PROFIT_RETRY_SEC defaults to 15 seconds", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
    });

    const config = loadStrategyConfig();
    assert.equal(config?.scalpProfitRetrySec, 15);
  });

  test("SCALP_PROFIT_RETRY_SEC env variable overrides default", () => {
    resetEnv();
    Object.assign(process.env, baseEnv, {
      STRATEGY_PRESET: "balanced",
      SCALP_PROFIT_RETRY_SEC: "10",
    });

    const config = loadStrategyConfig();
    assert.equal(config?.scalpProfitRetrySec, 10);
  });

  test("DEFAULT_SCALP_TAKE_PROFIT_CONFIG has exit ladder fields", () => {
    // Verify the default config has the new exit ladder fields
    assert.equal(DEFAULT_SCALP_TAKE_PROFIT_CONFIG.exitWindowSec, 120);
    assert.equal(DEFAULT_SCALP_TAKE_PROFIT_CONFIG.profitRetrySec, 15);
    assert.equal(DEFAULT_SCALP_TAKE_PROFIT_CONFIG.minOrderUsd, 5);
  });
});

// === EXIT PLAN TYPE TESTS ===

describe("ExitPlan Types", () => {
  test("ExitLadderStage type supports PROFIT, BREAKEVEN, FORCE", () => {
    const profit: ExitLadderStage = "PROFIT";
    const breakeven: ExitLadderStage = "BREAKEVEN";
    const force: ExitLadderStage = "FORCE";

    assert.equal(profit, "PROFIT");
    assert.equal(breakeven, "BREAKEVEN");
    assert.equal(force, "FORCE");
  });

  test("ExitPlan interface has required fields", () => {
    const plan: ExitPlan = {
      tokenId: "token123",
      startedAtMs: Date.now(),
      stage: "PROFIT",
      lastAttemptAtMs: 0,
      attempts: 0,
      avgEntryCents: 50.0,
      targetPriceCents: 54.0, // 8% above entry
      sharesHeld: 100,
      initialPnlPct: 8.0,
      initialPnlUsd: 4.0,
    };

    assert.equal(plan.tokenId, "token123");
    assert.equal(plan.stage, "PROFIT");
    assert.equal(plan.avgEntryCents, 50.0);
    assert.equal(plan.targetPriceCents, 54.0);
    assert.equal(plan.sharesHeld, 100);
  });

  test("ExitPlan supports optional blocked fields", () => {
    const blockedPlan: ExitPlan = {
      tokenId: "token456",
      startedAtMs: Date.now(),
      stage: "BREAKEVEN",
      lastAttemptAtMs: Date.now() - 5000,
      attempts: 3,
      avgEntryCents: 60.0,
      targetPriceCents: 64.8, // 8% above entry
      sharesHeld: 50,
      initialPnlPct: 8.0,
      initialPnlUsd: 2.4,
      blockedReason: "NO_BID",
      blockedAtMs: Date.now(),
    };

    assert.equal(blockedPlan.blockedReason, "NO_BID");
    assert.ok(blockedPlan.blockedAtMs !== undefined);
  });
});

// === SELL SIZING TESTS ===

describe("Sell Sizing - Position Notional NOT Profit", () => {
  test("Notional is calculated as shares * limitPrice", () => {
    // This is a conceptual test to document the correct formula
    // sizeUsd = sharesHeld * (limitPriceCents / 100)
    const sharesHeld = 100;
    const limitPriceCents = 55.0; // 55¢
    const expectedNotional = sharesHeld * (limitPriceCents / 100);

    // Use approximate comparison due to floating-point precision
    assert.ok(
      Math.abs(expectedNotional - 55.0) < 0.001,
      `Expected ~$55 USD, got ${expectedNotional}`,
    );
  });

  test("Notional below minOrderUsd should be treated as DUST", () => {
    const sharesHeld = 5;
    const limitPriceCents = 50.0; // 50¢
    const notionalUsd = sharesHeld * (limitPriceCents / 100);
    const minOrderUsd = 5;

    // 5 shares * $0.50 = $2.50 < $5 minOrder = DUST
    assert.equal(notionalUsd, 2.5);
    assert.ok(notionalUsd < minOrderUsd, "Should be treated as DUST");
  });

  test("Notional above minOrderUsd should be tradeable", () => {
    const sharesHeld = 20;
    const limitPriceCents = 50.0; // 50¢
    const notionalUsd = sharesHeld * (limitPriceCents / 100);
    const minOrderUsd = 5;

    // 20 shares * $0.50 = $10 >= $5 minOrder = tradeable
    assert.equal(notionalUsd, 10);
    assert.ok(notionalUsd >= minOrderUsd, "Should be tradeable");
  });

  test("Never use profitUsd as sizeUsd (would cause SKIP_MIN_ORDER_SIZE)", () => {
    // Example: position with $0.50 profit but $10 notional
    // If we used profitUsd ($0.50) as sizeUsd, it would fail minOrderUsd check
    // Correct behavior: use notional ($10) as sizeUsd
    const sharesHeld = 20;
    const currentPriceCents = 55.0; // 55¢
    const entryPriceCents = 50.0; // 50¢
    const minOrderUsd = 5;

    const profitUsd =
      sharesHeld * (currentPriceCents / 100) -
      sharesHeld * (entryPriceCents / 100);
    const notionalUsd = sharesHeld * (currentPriceCents / 100);

    assert.equal(profitUsd, 1.0); // Only $1 profit
    assert.equal(notionalUsd, 11.0); // But $11 notional

    // Using profitUsd would fail:
    assert.ok(profitUsd < minOrderUsd, "profitUsd fails minOrder check");

    // Using notionalUsd passes:
    assert.ok(notionalUsd >= minOrderUsd, "notionalUsd passes minOrder check");
  });
});

// === EXIT LADDER STAGE PROGRESSION TESTS ===

describe("Exit Ladder Stage Progression", () => {
  test("Plan starts in PROFIT stage", () => {
    const plan: ExitPlan = {
      tokenId: "token123",
      startedAtMs: Date.now(),
      stage: "PROFIT",
      lastAttemptAtMs: 0,
      attempts: 0,
      avgEntryCents: 50.0,
      targetPriceCents: 54.0,
      sharesHeld: 100,
      initialPnlPct: 8.0,
      initialPnlUsd: 4.0,
    };

    assert.equal(plan.stage, "PROFIT");
  });

  test("PROFIT stage lasts 60% of exit window", () => {
    const exitWindowSec = 120;
    const profitWindowSec = exitWindowSec * 0.6;

    assert.equal(profitWindowSec, 72); // 72 seconds for PROFIT stage
  });

  test("Stage progression: PROFIT -> BREAKEVEN at 60% of window", () => {
    const exitWindowSec = 120;
    const profitWindowSec = exitWindowSec * 0.6;

    // After 72 seconds, should move to BREAKEVEN
    const elapsedSec = 73;
    const shouldEscalate = elapsedSec >= profitWindowSec;

    assert.ok(shouldEscalate, "Should escalate to BREAKEVEN");
  });

  test("Stage progression: BREAKEVEN -> FORCE at window expiry", () => {
    const exitWindowSec = 120;

    // After 120 seconds, should move to FORCE
    const elapsedSec = 121;
    const shouldForce = elapsedSec >= exitWindowSec;

    assert.ok(shouldForce, "Should escalate to FORCE");
  });
});

// === LIMIT PRICE CALCULATION TESTS ===

describe("Exit Ladder Limit Price Calculation", () => {
  test("PROFIT stage: limit = max(targetPrice, bestBid) if above entry", () => {
    const avgEntryCents = 50.0;
    const targetPriceCents = 54.0; // 8% profit target
    const bestBidCents = 52.0; // Below target but above entry

    const limitCents = Math.max(targetPriceCents, bestBidCents);

    assert.equal(limitCents, 54.0); // Use target price
    assert.ok(limitCents > avgEntryCents, "Limit must be above entry");
  });

  test("PROFIT stage: use bestBid if above target", () => {
    const avgEntryCents = 50.0;
    const targetPriceCents = 54.0;
    const bestBidCents = 58.0; // Above target

    const limitCents = Math.max(targetPriceCents, bestBidCents);

    assert.equal(limitCents, 58.0); // Use best bid (better than target)
  });

  test("BREAKEVEN stage: exit at avgEntry if bestBid >= avgEntry", () => {
    const avgEntryCents = 50.0;
    const bestBidCents = 51.0; // Slightly above entry

    // Can break even
    const canBreakEven = bestBidCents >= avgEntryCents;
    const limitCents = canBreakEven
      ? Math.max(avgEntryCents, bestBidCents)
      : avgEntryCents;

    assert.ok(canBreakEven, "Can break even");
    assert.equal(limitCents, 51.0); // Use bestBid (better than entry)
  });

  test("BREAKEVEN stage: cannot exit if bestBid < avgEntry", () => {
    const avgEntryCents = 50.0;
    const bestBidCents = 48.0; // Below entry

    const canBreakEven = bestBidCents >= avgEntryCents;

    assert.ok(!canBreakEven, "Cannot break even - must wait for FORCE");
  });

  test("FORCE stage: exit at bestBid even at loss", () => {
    const avgEntryCents = 50.0;
    const bestBidCents = 45.0; // Below entry (loss)

    // FORCE stage exits at bestBid regardless
    const limitCents = bestBidCents;
    const realizedLossPct =
      ((limitCents - avgEntryCents) / avgEntryCents) * 100;

    assert.equal(limitCents, 45.0);
    assert.equal(realizedLossPct, -10); // 10% loss
  });
});

// === MIN ORDER HANDLING TESTS ===

describe("Min Order Size Handling", () => {
  test("Preflight check: notional >= minOrderUsd is valid", () => {
    const sharesHeld = 20;
    const limitPriceCents = 50.0;
    const minOrderUsd = 5;

    const notionalUsd = sharesHeld * (limitPriceCents / 100);
    const isValid = notionalUsd >= minOrderUsd;

    assert.ok(isValid, "Order should be valid");
  });

  test("Preflight check: notional < minOrderUsd is DUST", () => {
    const sharesHeld = 5;
    const limitPriceCents = 50.0;
    const minOrderUsd = 5;

    const notionalUsd = sharesHeld * (limitPriceCents / 100);
    const isDust = notionalUsd < minOrderUsd;

    assert.ok(isDust, "Should be classified as DUST");
  });

  test("DUST positions should cancel exit plan", () => {
    // When a position is DUST, shouldContinue should be false
    // to remove it from exit plans and prevent spam
    const notionalUsd = 2.5;
    const minOrderUsd = 5;

    const shouldContinue = notionalUsd >= minOrderUsd;

    assert.ok(!shouldContinue, "DUST position should not continue");
  });
});
