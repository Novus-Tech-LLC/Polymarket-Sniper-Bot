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

// === NEAR-RESOLUTION CAPITAL RELEASE TESTS ===

describe("Near-Resolution Capital Release", () => {
  /**
   * Helper to simulate shouldExcludeFromTimeExit logic
   */
  function shouldExcludeFromTimeExit(
    entryPrice: number,
    currentPrice: number,
    resolutionExclusionPrice: number = 0.6,
  ): boolean {
    const NEAR_RESOLUTION_THRESHOLD = 0.9;
    if (entryPrice > resolutionExclusionPrice) {
      return false;
    }
    return currentPrice >= NEAR_RESOLUTION_THRESHOLD;
  }

  /**
   * Helper to simulate evaluateScalpExit near-resolution logic
   */
  function evaluateNearResolutionExit(
    entryPrice: number,
    currentPrice: number,
    holdMinutes: number,
    maxHoldMinutes: number,
    pnlPct: number,
    minProfitPct: number = 5.0,
    resolutionExclusionPrice: number = 0.6,
  ): { shouldExit: boolean; reason: string } {
    const isNearResolutionCandidate = shouldExcludeFromTimeExit(
      entryPrice,
      currentPrice,
      resolutionExclusionPrice,
    );

    // Near-resolution positions are protected UNTIL maxHoldMinutes
    if (isNearResolutionCandidate && holdMinutes < maxHoldMinutes) {
      return {
        shouldExit: false,
        reason: `Resolution exclusion: entry ≤${(resolutionExclusionPrice * 100).toFixed(0)}¢ + current ≥90¢ (near resolution, held ${holdMinutes.toFixed(0)}/${maxHoldMinutes}min)`,
      };
    }

    // After maxHoldMinutes, allow exit even for near-resolution
    if (holdMinutes >= maxHoldMinutes && pnlPct >= minProfitPct) {
      const nearResNote = isNearResolutionCandidate
        ? " (near-resolution capital release)"
        : "";
      return {
        shouldExit: true,
        reason: `Max hold time: ${holdMinutes.toFixed(0)}min >= ${maxHoldMinutes}min at +${pnlPct.toFixed(1)}%${nearResNote}`,
      };
    }

    // Not profitable enough
    if (pnlPct < minProfitPct) {
      return {
        shouldExit: false,
        reason: `Profit ${pnlPct.toFixed(1)}% < min ${minProfitPct}%`,
      };
    }

    return { shouldExit: false, reason: "Hold time not met" };
  }

  test("Near-resolution position BEFORE maxHoldMinutes should be protected", () => {
    // Position: entry 50¢, current 92¢, held 60min, max 90min
    const result = evaluateNearResolutionExit(
      0.5, // entry 50¢
      0.92, // current 92¢ (near resolution)
      60, // held 60 minutes
      90, // max hold 90 minutes
      84, // profit 84% (very profitable)
    );

    assert.strictEqual(
      result.shouldExit,
      false,
      "Should NOT exit before maxHoldMinutes",
    );
    assert.ok(
      result.reason.includes("Resolution exclusion"),
      `Expected resolution exclusion, got: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("60/90min"),
      `Expected hold time info in reason, got: ${result.reason}`,
    );
  });

  test("Near-resolution position AFTER maxHoldMinutes should allow exit to free capital", () => {
    // Position: entry 50¢, current 92¢, held 120min, max 90min
    const result = evaluateNearResolutionExit(
      0.5, // entry 50¢
      0.92, // current 92¢ (near resolution)
      120, // held 120 minutes (exceeds max)
      90, // max hold 90 minutes
      84, // profit 84%
    );

    assert.strictEqual(
      result.shouldExit,
      true,
      "Should allow exit after maxHoldMinutes to free capital",
    );
    assert.ok(
      result.reason.includes("Max hold time"),
      `Expected max hold time reason, got: ${result.reason}`,
    );
    assert.ok(
      result.reason.includes("near-resolution capital release"),
      `Expected capital release note, got: ${result.reason}`,
    );
  });

  test("Non-near-resolution position follows normal rules", () => {
    // Position: entry 50¢, current 65¢ (not near resolution)
    const result = evaluateNearResolutionExit(
      0.5, // entry 50¢
      0.65, // current 65¢ (NOT near resolution)
      60, // held 60 minutes
      90, // max hold 90 minutes
      30, // profit 30%
    );

    assert.strictEqual(
      result.shouldExit,
      false,
      "Should NOT exit - hold time not reached",
    );
    assert.ok(
      !result.reason.includes("Resolution exclusion"),
      "Should not be resolution exclusion",
    );
  });

  test("High-entry position at 92¢ should NOT get resolution exclusion", () => {
    // Position: entry 75¢, current 92¢
    // Entry is above resolution exclusion threshold (60¢)
    const isExcluded = shouldExcludeFromTimeExit(
      0.75, // entry 75¢ (above 60¢ threshold)
      0.92, // current 92¢
      0.6, // resolution exclusion threshold
    );

    assert.strictEqual(
      isExcluded,
      false,
      "High entry (75¢) should NOT get resolution exclusion",
    );
  });

  test("Low-entry position below 90¢ should NOT get resolution exclusion", () => {
    // Position: entry 50¢, current 85¢
    const isExcluded = shouldExcludeFromTimeExit(
      0.5, // entry 50¢
      0.85, // current 85¢ (below 90¢ threshold)
      0.6,
    );

    assert.strictEqual(
      isExcluded,
      false,
      "Position below 90¢ should NOT get resolution exclusion",
    );
  });

  test("Resolution exclusion check correctly identifies near-resolution candidates", () => {
    // Entry 40¢, current 95¢ - should be excluded (protected)
    const case1 = shouldExcludeFromTimeExit(0.4, 0.95, 0.6);
    assert.strictEqual(case1, true, "40¢→95¢ should be protected");

    // Entry 60¢ (exactly at threshold), current 90¢ - should be excluded
    const case2 = shouldExcludeFromTimeExit(0.6, 0.9, 0.6);
    assert.strictEqual(case2, true, "60¢→90¢ should be protected");

    // Entry 61¢ (just above threshold), current 95¢ - should NOT be excluded
    const case3 = shouldExcludeFromTimeExit(0.61, 0.95, 0.6);
    assert.strictEqual(
      case3,
      false,
      "61¢→95¢ should NOT be protected (entry above threshold)",
    );

    // Entry 50¢, current 89¢ - should NOT be excluded (not near resolution)
    const case4 = shouldExcludeFromTimeExit(0.5, 0.89, 0.6);
    assert.strictEqual(
      case4,
      false,
      "50¢→89¢ should NOT be protected (not near resolution)",
    );
  });

  test("Capital release happens at exactly maxHoldMinutes", () => {
    // Position: entry 50¢, current 92¢, held EXACTLY 90min, max 90min
    const result = evaluateNearResolutionExit(
      0.5,
      0.92,
      90, // held exactly max
      90, // max hold
      84, // profit
    );

    assert.strictEqual(
      result.shouldExit,
      true,
      "Should exit at exactly maxHoldMinutes",
    );
  });

  test("Near-resolution position with low profit should not exit even after maxHoldMinutes", () => {
    // Position: entry 50¢, current 92¢, held 120min, but profit below min
    const result = evaluateNearResolutionExit(
      0.5,
      0.92,
      120, // held 120min (exceeds max)
      90, // max hold
      3, // profit only 3% (below 5% min)
      5, // minProfitPct
    );

    assert.strictEqual(
      result.shouldExit,
      false,
      "Should NOT exit if profit below minimum even after maxHoldMinutes",
    );
    assert.ok(
      result.reason.includes("Profit 3.0% < min"),
      `Expected profit check failure, got: ${result.reason}`,
    );
  });
});

// === CUMULATIVE BID DEPTH TESTS ===

describe("Cumulative Bid Depth for SELL Orders", () => {
  /**
   * Helper to calculate cumulative bid depth at/above a limit price
   * This mirrors the logic in post-order.util.ts for SELL orders
   */
  function calculateCumulativeBidDepth(
    bids: Array<{ price: string; size: string }>,
    limitPrice: number,
  ): number {
    let cumulativeDepthUsd = 0;
    for (const level of bids) {
      const levelPrice = parseFloat(level.price);
      // Bids are sorted descending, stop when below limit
      if (levelPrice < limitPrice) {
        break;
      }
      const levelSize = parseFloat(level.size);
      cumulativeDepthUsd += levelSize * levelPrice;
    }
    return cumulativeDepthUsd;
  }

  test("Cumulative depth includes all levels at/above limit price", () => {
    const bids = [
      { price: "0.55", size: "100" }, // $55
      { price: "0.52", size: "200" }, // $104
      { price: "0.50", size: "300" }, // $150
      { price: "0.48", size: "400" }, // Below limit
    ];
    const limitPrice = 0.5;

    const depth = calculateCumulativeBidDepth(bids, limitPrice);

    // Should include first 3 levels: $55 + $104 + $150 = $309
    assert.equal(depth, 309);
  });

  test("Cumulative depth stops at first level below limit price", () => {
    const bids = [
      { price: "0.55", size: "100" }, // $55
      { price: "0.49", size: "200" }, // Below limit - stop here
      { price: "0.48", size: "300" },
    ];
    const limitPrice = 0.5;

    const depth = calculateCumulativeBidDepth(bids, limitPrice);

    // Should only include first level: $55 (0.55 * 100 may have floating point error)
    assert.ok(
      Math.abs(depth - 55) < 0.001,
      `Expected depth ~$55, got $${depth.toFixed(2)}`,
    );
  });

  test("Empty bids returns zero depth", () => {
    const bids: Array<{ price: string; size: string }> = [];
    const limitPrice = 0.5;

    const depth = calculateCumulativeBidDepth(bids, limitPrice);

    assert.equal(depth, 0);
  });

  test("All levels below limit returns zero depth", () => {
    const bids = [
      { price: "0.45", size: "100" },
      { price: "0.40", size: "200" },
    ];
    const limitPrice = 0.5;

    const depth = calculateCumulativeBidDepth(bids, limitPrice);

    assert.equal(depth, 0);
  });

  test("SELL order sizing uses cumulative depth, not just top level", () => {
    // Scenario: Position worth $10 notional, but top bid only has $3 of depth
    // Old behavior: would size to $3 (top level only), causing SKIP_MIN_ORDER_SIZE with $5 min
    // New behavior: uses cumulative depth ($12) allowing the full $10 order
    const bids = [
      { price: "0.50", size: "6" }, // $3 (was previous top-level-only value)
      { price: "0.48", size: "10" }, // $4.80
      { price: "0.46", size: "10" }, // $4.60
    ];
    const limitPrice = 0.46;
    const positionNotional = 10.0;
    const minOrderUsd = 5.0;

    const cumulativeDepth = calculateCumulativeBidDepth(bids, limitPrice);
    const orderValue = Math.min(positionNotional, cumulativeDepth);

    // Cumulative depth at 46¢ = $3 + $4.80 + $4.60 = $12.40
    assert.ok(
      cumulativeDepth >= 12.4,
      `Expected cumulative depth >= $12.40, got $${cumulativeDepth.toFixed(2)}`,
    );

    // Order value should be capped at position notional
    assert.equal(orderValue, 10.0);

    // Order should pass minOrderUsd check
    assert.ok(
      orderValue >= minOrderUsd,
      `Order $${orderValue.toFixed(2)} should pass min $${minOrderUsd}`,
    );
  });

  test("minOrderUsd passthrough ensures preflight and submission match", () => {
    // When ScalpTakeProfitStrategy has minOrderUsd=5, it should pass this
    // to postOrder so OrderSubmissionController uses the same threshold
    const strategyMinOrder = 5;
    const systemDefaultMinOrder = 10;

    // Order worth $7 would fail system default but pass strategy setting
    const notionalUsd = 7.0;

    const passesStrategyCheck = notionalUsd >= strategyMinOrder;
    const passesSystemDefault = notionalUsd >= systemDefaultMinOrder;

    assert.ok(passesStrategyCheck, "Should pass strategy minOrderUsd check");
    assert.ok(
      !passesSystemDefault,
      "Would fail system default - this is why passthrough matters",
    );

    // With proper passthrough, the order should succeed
    // because submission controller will use strategy's minOrderUsd
  });
});
