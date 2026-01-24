import assert from "node:assert";
import { test, describe } from "node:test";
import {
  DEFAULT_HEDGING_CONFIG,
  type SmartHedgingConfig,
} from "../../src/strategies/smart-hedging";

/**
 * Unit tests for Smart Hedging Strategy - Near-Close Behavior
 *
 * These tests verify the time-aware hedging logic that applies stricter
 * thresholds near market close to prevent unnecessary hedges.
 */

describe("Smart Hedging Near-Close Logic", () => {
  // Helper function to simulate the near-close decision logic
  // This mirrors the logic in SmartHedgingStrategy.execute()
  function shouldHedgePosition(
    config: SmartHedgingConfig,
    position: {
      entryPrice: number;
      currentPrice: number;
      pnlPct: number;
      marketEndTime?: number;
    },
    now: number,
  ): { shouldHedge: boolean; reason: string } {
    const lossPct = Math.abs(position.pnlPct);

    // Check if position meets basic loss threshold
    if (position.pnlPct > -config.triggerLossPct) {
      return { shouldHedge: false, reason: "Loss below trigger threshold" };
    }

    // If no market end time, use normal hedging rules
    if (!position.marketEndTime || position.marketEndTime <= now) {
      return { shouldHedge: true, reason: "Normal hedging (no end time)" };
    }

    const minutesToClose = (position.marketEndTime - now) / (60 * 1000);

    // No-hedge window: inside last N minutes, don't hedge at all
    if (minutesToClose <= config.noHedgeWindowMinutes) {
      if (lossPct >= config.forceLiquidationPct) {
        return {
          shouldHedge: false,
          reason: "No-hedge window - liquidate instead",
        };
      }
      return { shouldHedge: false, reason: "No-hedge window - skip" };
    }

    // Near-close window: apply stricter thresholds
    if (minutesToClose <= config.nearCloseWindowMinutes) {
      const priceDropCents =
        (position.entryPrice - position.currentPrice) * 100;
      const meetsDropThreshold =
        priceDropCents >= config.nearClosePriceDropCents;
      const meetsLossThreshold = lossPct >= config.nearCloseLossPct;

      if (!meetsDropThreshold && !meetsLossThreshold) {
        return {
          shouldHedge: false,
          reason: "Near-close window - thresholds not met",
        };
      }
      return { shouldHedge: true, reason: "Near-close hedge triggered" };
    }

    // Outside near-close window: normal hedging
    return { shouldHedge: true, reason: "Normal hedging" };
  }

  describe("No-Hedge Window (last 3 minutes)", () => {
    test("should not hedge position when 2 minutes from close", () => {
      const now = Date.now();
      const marketEndTime = now + 2 * 60 * 1000; // 2 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.6,
          currentPrice: 0.45,
          pnlPct: -25, // 25% loss (triggers normal hedging at 20%)
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge in no-hedge window",
      );
      assert.ok(
        result.reason.includes("No-hedge window"),
        `Expected reason to include 'No-hedge window', got: ${result.reason}`,
      );
    });

    test("should not hedge position when 1 minute from close", () => {
      const now = Date.now();
      const marketEndTime = now + 1 * 60 * 1000; // 1 minute from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.7,
          currentPrice: 0.4,
          pnlPct: -42, // 42% loss
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge when 1 minute from close",
      );
    });

    test("should not hedge position when 30 seconds from close", () => {
      const now = Date.now();
      const marketEndTime = now + 0.5 * 60 * 1000; // 30 seconds from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.8,
          currentPrice: 0.5,
          pnlPct: -37.5,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge when 30 seconds from close",
      );
    });

    test("should trigger liquidation logic for catastrophic loss in no-hedge window", () => {
      const now = Date.now();
      const marketEndTime = now + 2 * 60 * 1000; // 2 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.8,
          currentPrice: 0.35,
          pnlPct: -56.25, // 56.25% loss (above 50% liquidation threshold)
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge even with catastrophic loss (liquidate instead)",
      );
      assert.ok(
        result.reason.includes("liquidate"),
        `Expected reason to mention liquidation, got: ${result.reason}`,
      );
    });
  });

  describe("Near-Close Window (last 15 minutes)", () => {
    test("should skip hedge when loss is 25% but price drop is only 8¢", () => {
      const now = Date.now();
      const marketEndTime = now + 10 * 60 * 1000; // 10 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.32, // Entry at 32¢
          currentPrice: 0.24, // Current at 24¢ (8¢ drop, 25% loss)
          pnlPct: -25,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should skip hedge - 25% loss does not meet 30% threshold, 8¢ drop does not meet 12¢ threshold",
      );
    });

    test("should hedge when price drop is >= 12¢", () => {
      const now = Date.now();
      const marketEndTime = now + 10 * 60 * 1000; // 10 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.6, // Entry at 60¢
          currentPrice: 0.47, // Current at 47¢ (13¢ drop)
          pnlPct: -21.67,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should hedge - 13¢ drop meets >= 12¢ threshold",
      );
    });

    test("should hedge when loss >= 30%", () => {
      const now = Date.now();
      const marketEndTime = now + 10 * 60 * 1000; // 10 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.3, // Entry at 30¢
          currentPrice: 0.2, // Current at 20¢ (10¢ drop, but 33% loss)
          pnlPct: -33.33,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should hedge - 33% loss meets >= 30% threshold",
      );
    });

    test("should hedge when both thresholds are met", () => {
      const now = Date.now();
      const marketEndTime = now + 10 * 60 * 1000; // 10 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5, // Entry at 50¢
          currentPrice: 0.35, // Current at 35¢ (15¢ drop, 30% loss)
          pnlPct: -30,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should hedge - both thresholds met",
      );
    });

    test("should not hedge when exactly at 15 minute mark with minor loss", () => {
      const now = Date.now();
      const marketEndTime = now + 15 * 60 * 1000; // Exactly 15 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.4,
          currentPrice: 0.3, // 10¢ drop, 25% loss
          pnlPct: -25,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge - at 15 min mark, thresholds not met",
      );
    });

    test("should apply near-close rules at 5 minutes from close", () => {
      const now = Date.now();
      const marketEndTime = now + 5 * 60 * 1000; // 5 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.35,
          currentPrice: 0.27, // 8¢ drop, 22.8% loss
          pnlPct: -22.86,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge at 5min - 8¢ drop and 22.8% loss don't meet thresholds",
      );
    });
  });

  describe("Normal Hedging (outside near-close window)", () => {
    test("should hedge with 20% loss when 30 minutes from close", () => {
      const now = Date.now();
      const marketEndTime = now + 30 * 60 * 1000; // 30 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5,
          currentPrice: 0.38, // 24% loss
          pnlPct: -24,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should hedge - outside near-close window, meets 20% trigger",
      );
    });

    test("should hedge with 20% loss when no market end time", () => {
      const now = Date.now();

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5,
          currentPrice: 0.38,
          pnlPct: -24,
          marketEndTime: undefined,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should hedge - no end time, use normal rules",
      );
    });

    test("should hedge with 20% loss when 1 hour from close", () => {
      const now = Date.now();
      const marketEndTime = now + 60 * 60 * 1000; // 1 hour from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.6,
          currentPrice: 0.46, // 23.3% loss
          pnlPct: -23.33,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should hedge - 1 hour from close, normal rules apply",
      );
    });

    test("should not hedge when loss is below 20% threshold", () => {
      const now = Date.now();
      const marketEndTime = now + 30 * 60 * 1000; // 30 minutes from now

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5,
          currentPrice: 0.42, // 16% loss
          pnlPct: -16,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "Should not hedge - 16% loss is below 20% threshold",
      );
    });
  });

  describe("Edge Cases", () => {
    test("should handle market that has already closed", () => {
      const now = Date.now();
      const marketEndTime = now - 5 * 60 * 1000; // 5 minutes ago

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5,
          currentPrice: 0.35,
          pnlPct: -30,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Should use normal rules when market end time has passed",
      );
    });

    test("should handle exactly at boundary between no-hedge and near-close", () => {
      const now = Date.now();
      // Exactly 3 minutes (180,000ms) - this should be the boundary
      const marketEndTime = now + 3 * 60 * 1000;

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5,
          currentPrice: 0.35,
          pnlPct: -30,
          marketEndTime,
        },
        now,
      );

      // At exactly 3 minutes, it's still in no-hedge window (<=)
      assert.strictEqual(
        result.shouldHedge,
        false,
        "At exactly 3 minutes, should be in no-hedge window",
      );
    });

    test("should handle exactly at boundary between near-close and normal", () => {
      const now = Date.now();
      // Just over 15 minutes (should be outside near-close window)
      const marketEndTime = now + 15 * 60 * 1000 + 1000; // 15 min + 1 second

      const result = shouldHedgePosition(
        DEFAULT_HEDGING_CONFIG,
        {
          entryPrice: 0.5,
          currentPrice: 0.38, // 24% loss
          pnlPct: -24,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "Just outside 15 min window should use normal hedging",
      );
    });
  });

  describe("Custom Configuration", () => {
    test("should respect custom nearCloseWindowMinutes", () => {
      const customConfig: SmartHedgingConfig = {
        ...DEFAULT_HEDGING_CONFIG,
        nearCloseWindowMinutes: 10, // Shorter window
      };

      const now = Date.now();
      const marketEndTime = now + 12 * 60 * 1000; // 12 minutes from now

      const result = shouldHedgePosition(
        customConfig,
        {
          entryPrice: 0.5,
          currentPrice: 0.38,
          pnlPct: -24,
          marketEndTime,
        },
        now,
      );

      // 12 min is outside 10 min window, so normal rules apply
      assert.strictEqual(
        result.shouldHedge,
        true,
        "12 min should be outside custom 10 min near-close window",
      );
    });

    test("should respect custom noHedgeWindowMinutes", () => {
      const customConfig: SmartHedgingConfig = {
        ...DEFAULT_HEDGING_CONFIG,
        noHedgeWindowMinutes: 5, // Longer no-hedge window
      };

      const now = Date.now();
      const marketEndTime = now + 4 * 60 * 1000; // 4 minutes from now

      const result = shouldHedgePosition(
        customConfig,
        {
          entryPrice: 0.5,
          currentPrice: 0.35,
          pnlPct: -30,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        false,
        "4 min should be inside custom 5 min no-hedge window",
      );
    });

    test("should respect custom nearClosePriceDropCents", () => {
      const customConfig: SmartHedgingConfig = {
        ...DEFAULT_HEDGING_CONFIG,
        nearClosePriceDropCents: 8, // Lower threshold
      };

      const now = Date.now();
      const marketEndTime = now + 10 * 60 * 1000; // 10 minutes from now

      const result = shouldHedgePosition(
        customConfig,
        {
          entryPrice: 0.4,
          currentPrice: 0.31, // 9¢ drop
          pnlPct: -22.5,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "9¢ drop should meet custom 8¢ threshold",
      );
    });

    test("should respect custom nearCloseLossPct", () => {
      const customConfig: SmartHedgingConfig = {
        ...DEFAULT_HEDGING_CONFIG,
        nearCloseLossPct: 25, // Lower threshold
      };

      const now = Date.now();
      const marketEndTime = now + 10 * 60 * 1000; // 10 minutes from now

      const result = shouldHedgePosition(
        customConfig,
        {
          entryPrice: 0.4,
          currentPrice: 0.29, // 27.5% loss
          pnlPct: -27.5,
          marketEndTime,
        },
        now,
      );

      assert.strictEqual(
        result.shouldHedge,
        true,
        "27.5% loss should meet custom 25% threshold",
      );
    });
  });
});

describe("Default Configuration Values", () => {
  test("default config has correct near-close values", () => {
    assert.strictEqual(
      DEFAULT_HEDGING_CONFIG.nearCloseWindowMinutes,
      15,
      "nearCloseWindowMinutes should default to 15",
    );
    assert.strictEqual(
      DEFAULT_HEDGING_CONFIG.nearClosePriceDropCents,
      12,
      "nearClosePriceDropCents should default to 12",
    );
    assert.strictEqual(
      DEFAULT_HEDGING_CONFIG.nearCloseLossPct,
      30,
      "nearCloseLossPct should default to 30",
    );
    assert.strictEqual(
      DEFAULT_HEDGING_CONFIG.noHedgeWindowMinutes,
      3,
      "noHedgeWindowMinutes should default to 3",
    );
  });

  test("default trigger loss is 20%", () => {
    assert.strictEqual(
      DEFAULT_HEDGING_CONFIG.triggerLossPct,
      20,
      "triggerLossPct should default to 20%",
    );
  });

  test("default force liquidation is 50%", () => {
    assert.strictEqual(
      DEFAULT_HEDGING_CONFIG.forceLiquidationPct,
      50,
      "forceLiquidationPct should default to 50%",
    );
  });
});

describe("Smart Hedging Liquidation Candidate Filtering", () => {
  // Helper type to represent a position for testing
  interface TestPosition {
    marketId: string;
    tokenId: string;
    side: string;
    size: number;
    entryPrice: number;
    currentPrice: number;
    pnlPct: number;
    pnlUsd: number;
    redeemable?: boolean;
  }

  /**
   * Helper function to simulate the getLiquidationCandidates logic in SmartHedgingStrategy.
   * Filters positions to find candidates suitable for liquidation, excluding already hedged
   * positions and positions in cooldown.
   *
   * @param positions - Array of positions to filter
   * @param entryTimes - Map of position keys to entry timestamps
   * @param hedgedPositions - Set of position keys that have already been hedged
   * @param cooldownPositions - Map of position keys to cooldown expiration timestamps
   * @param config - Configuration with triggerLossPct and minHoldSeconds thresholds
   * @returns Array of positions suitable for liquidation, sorted by worst loss first
   */
  function filterLiquidationCandidates(
    positions: TestPosition[],
    entryTimes: Map<string, number>,
    hedgedPositions: Set<string>,
    cooldownPositions: Map<string, number>,
    config: {
      triggerLossPct: number;
      minHoldSeconds: number;
    },
  ): TestPosition[] {
    const now = Date.now();

    // First filter by basic criteria (like PositionTracker.getLiquidationCandidates)
    const baseCandidates = positions
      .filter((pos) => {
        // Must be active (not redeemable)
        if (pos.redeemable) return false;

        // Must be losing
        if (pos.pnlPct >= 0) return false;

        // Must have valid side info
        if (!pos.side || pos.side.trim() === "") return false;

        // Must meet minimum loss threshold
        if (Math.abs(pos.pnlPct) < config.triggerLossPct) return false;

        // Must have been held for minimum time
        const key = `${pos.marketId}-${pos.tokenId}`;
        const entryTime = entryTimes.get(key);
        if (entryTime) {
          const holdSeconds = (now - entryTime) / 1000;
          if (holdSeconds < config.minHoldSeconds) return false;
        }

        return true;
      })
      .sort((a, b) => a.pnlPct - b.pnlPct);

    // Then filter out already hedged and positions in cooldown
    return baseCandidates.filter((pos) => {
      const key = `${pos.marketId}-${pos.tokenId}`;

      // Skip if already hedged
      if (hedgedPositions.has(key)) return false;

      // Skip if in cooldown
      const cooldownUntil = cooldownPositions.get(key);
      if (cooldownUntil && now < cooldownUntil) return false;

      return true;
    });
  }

  test("Excludes already hedged positions", () => {
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.2,
        pnlPct: -50,
        pnlUsd: -10,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", Date.now() - 300000);
    entryTimes.set("m2-t2", Date.now() - 300000);

    const hedgedPositions = new Set<string>(["m1-t1"]); // m1 already hedged
    const cooldownPositions = new Map<string, number>();

    const candidates = filterLiquidationCandidates(
      positions,
      entryTimes,
      hedgedPositions,
      cooldownPositions,
      { triggerLossPct: 20, minHoldSeconds: 60 },
    );

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude already hedged position",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m2",
      "Should only include non-hedged position",
    );
  });

  test("Excludes positions in cooldown", () => {
    const now = Date.now();
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.2,
        pnlPct: -50,
        pnlUsd: -10,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", now - 300000);
    entryTimes.set("m2-t2", now - 300000);

    const hedgedPositions = new Set<string>();
    const cooldownPositions = new Map<string, number>();
    cooldownPositions.set("m2-t2", now + 300000); // m2 in cooldown for 5 more minutes

    const candidates = filterLiquidationCandidates(
      positions,
      entryTimes,
      hedgedPositions,
      cooldownPositions,
      { triggerLossPct: 20, minHoldSeconds: 60 },
    );

    assert.strictEqual(
      candidates.length,
      1,
      "Should exclude position in cooldown",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m1",
      "Should only include non-cooldown position",
    );
  });

  test("Includes positions with expired cooldown", () => {
    const now = Date.now();
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -20,
      },
    ];
    const entryTimes = new Map<string, number>();
    entryTimes.set("m1-t1", now - 300000);

    const hedgedPositions = new Set<string>();
    const cooldownPositions = new Map<string, number>();
    cooldownPositions.set("m1-t1", now - 1000); // Cooldown expired 1 second ago

    const candidates = filterLiquidationCandidates(
      positions,
      entryTimes,
      hedgedPositions,
      cooldownPositions,
      { triggerLossPct: 20, minHoldSeconds: 60 },
    );

    assert.strictEqual(
      candidates.length,
      1,
      "Should include position with expired cooldown",
    );
  });

  test("Combines all filters correctly", () => {
    const now = Date.now();
    const positions: TestPosition[] = [
      {
        marketId: "m1",
        tokenId: "t1",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      }, // Profitable - skip
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.2,
        pnlPct: -50,
        pnlUsd: -10,
      }, // Hedged - skip
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.6,
        currentPrice: 0.42,
        pnlPct: -30,
        pnlUsd: -13.5,
      }, // In cooldown - skip
      {
        marketId: "m4",
        tokenId: "t4",
        side: "",
        size: 40,
        entryPrice: 0.5,
        currentPrice: 0.3,
        pnlPct: -40,
        pnlUsd: -8,
      }, // No side - skip
      {
        marketId: "m5",
        tokenId: "t5",
        side: "NO",
        size: 60,
        entryPrice: 0.7,
        currentPrice: 0.35,
        pnlPct: -50,
        pnlUsd: -21,
      }, // Valid candidate
      {
        marketId: "m6",
        tokenId: "t6",
        side: "YES",
        size: 30,
        entryPrice: 0.3,
        currentPrice: 0.27,
        pnlPct: -10,
        pnlUsd: -0.9,
      }, // Below threshold - skip
      {
        marketId: "m7",
        tokenId: "t7",
        side: "NO",
        size: 80,
        entryPrice: 0.8,
        currentPrice: 0.4,
        pnlPct: -50,
        pnlUsd: -32,
        redeemable: true,
      }, // Redeemable - skip
    ];
    const entryTimes = new Map<string, number>();
    positions.forEach((p) =>
      entryTimes.set(`${p.marketId}-${p.tokenId}`, now - 300000),
    );

    const hedgedPositions = new Set<string>(["m2-t2"]);
    const cooldownPositions = new Map<string, number>();
    cooldownPositions.set("m3-t3", now + 300000);

    const candidates = filterLiquidationCandidates(
      positions,
      entryTimes,
      hedgedPositions,
      cooldownPositions,
      { triggerLossPct: 20, minHoldSeconds: 60 },
    );

    assert.strictEqual(
      candidates.length,
      1,
      "Should only include one valid candidate",
    );
    assert.strictEqual(
      candidates[0].marketId,
      "m5",
      "Should be the valid losing position",
    );
  });
});

/**
 * Tests for hedge fallback behavior when insufficient funds
 *
 * These tests verify that the strategy correctly attempts to free funds by
 * selling profitable positions before falling back to selling the losing position.
 */
describe("Smart Hedging Insufficient Funds Fallback Logic", () => {
  // Helper type for test positions
  interface TestPosition {
    marketId: string;
    tokenId: string;
    side: string;
    size: number;
    entryPrice: number;
    currentPrice: number;
    pnlPct: number;
    pnlUsd: number;
    redeemable?: boolean;
  }

  /**
   * Simulates the fallback logic when hedge fails with INSUFFICIENT_BALANCE_OR_ALLOWANCE.
   * Returns the action taken and the position(s) affected.
   */
  function simulateFallbackLogic(
    losingPosition: TestPosition,
    profitableCandidates: TestPosition[],
    hedgedPositions: Set<string>,
    retryHedgeSuccess: boolean,
  ): {
    action:
      | "sold_profitable_and_hedged"
      | "sold_profitable_then_sold_losing"
      | "sold_losing_directly";
    soldPositions: string[];
  } {
    // Filter out already hedged positions
    const sellableProfits = profitableCandidates.filter((p) => {
      const key = `${p.marketId}-${p.tokenId}`;
      return !hedgedPositions.has(key);
    });

    const soldPositions: string[] = [];

    if (sellableProfits.length > 0) {
      // Would sell lowest-profit position first (already sorted)
      const profitToSell = sellableProfits[0];
      soldPositions.push(`${profitToSell.marketId}-${profitToSell.tokenId}`);

      if (retryHedgeSuccess) {
        return { action: "sold_profitable_and_hedged", soldPositions };
      } else {
        // Retry failed, fall through to sell losing
        soldPositions.push(
          `${losingPosition.marketId}-${losingPosition.tokenId}`,
        );
        return { action: "sold_profitable_then_sold_losing", soldPositions };
      }
    }

    // No profitable positions to sell, sell losing directly
    soldPositions.push(`${losingPosition.marketId}-${losingPosition.tokenId}`);
    return { action: "sold_losing_directly", soldPositions };
  }

  test("Should sell profitable position and retry hedge when profitable candidates exist", () => {
    const losingPosition: TestPosition = {
      marketId: "m1",
      tokenId: "t1",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.35,
      pnlPct: -30,
      pnlUsd: -15,
    };

    // Profitable candidates sorted by lowest profit first
    const profitableCandidates: TestPosition[] = [
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.44,
        pnlPct: 10,
        pnlUsd: 2,
      }, // Lowest profit - sell this first
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.3,
        currentPrice: 0.45,
        pnlPct: 50,
        pnlUsd: 11.25,
      },
    ];

    const result = simulateFallbackLogic(
      losingPosition,
      profitableCandidates,
      new Set(),
      true, // Retry succeeds
    );

    assert.strictEqual(
      result.action,
      "sold_profitable_and_hedged",
      "Should sell profitable and retry hedge successfully",
    );
    assert.strictEqual(
      result.soldPositions.length,
      1,
      "Should only sell one profitable position",
    );
    assert.strictEqual(
      result.soldPositions[0],
      "m2-t2",
      "Should sell the lowest-profit position first",
    );
  });

  test("Should fall through to sell losing when retry fails", () => {
    const losingPosition: TestPosition = {
      marketId: "m1",
      tokenId: "t1",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.35,
      pnlPct: -30,
      pnlUsd: -15,
    };

    const profitableCandidates: TestPosition[] = [
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.44,
        pnlPct: 10,
        pnlUsd: 2,
      },
    ];

    const result = simulateFallbackLogic(
      losingPosition,
      profitableCandidates,
      new Set(),
      false, // Retry fails
    );

    assert.strictEqual(
      result.action,
      "sold_profitable_then_sold_losing",
      "Should sell profitable, fail retry, then sell losing",
    );
    assert.strictEqual(
      result.soldPositions.length,
      2,
      "Should sell both profitable and losing positions",
    );
    assert.strictEqual(
      result.soldPositions[0],
      "m2-t2",
      "Should sell profitable first",
    );
    assert.strictEqual(
      result.soldPositions[1],
      "m1-t1",
      "Should sell losing second",
    );
  });

  test("Should sell losing directly when no profitable candidates exist", () => {
    const losingPosition: TestPosition = {
      marketId: "m1",
      tokenId: "t1",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.35,
      pnlPct: -30,
      pnlUsd: -15,
    };

    const profitableCandidates: TestPosition[] = []; // No profitable positions

    const result = simulateFallbackLogic(
      losingPosition,
      profitableCandidates,
      new Set(),
      false,
    );

    assert.strictEqual(
      result.action,
      "sold_losing_directly",
      "Should sell losing directly when no profitable candidates",
    );
    assert.strictEqual(
      result.soldPositions.length,
      1,
      "Should only sell the losing position",
    );
    assert.strictEqual(
      result.soldPositions[0],
      "m1-t1",
      "Should sell the losing position",
    );
  });

  test("Should exclude already hedged positions from profitable candidates", () => {
    const losingPosition: TestPosition = {
      marketId: "m1",
      tokenId: "t1",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.35,
      pnlPct: -30,
      pnlUsd: -15,
    };

    const profitableCandidates: TestPosition[] = [
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.44,
        pnlPct: 10,
        pnlUsd: 2,
      }, // Already hedged
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.3,
        currentPrice: 0.45,
        pnlPct: 50,
        pnlUsd: 11.25,
      }, // Not hedged
    ];

    const hedgedPositions = new Set(["m2-t2"]); // m2 is already hedged

    const result = simulateFallbackLogic(
      losingPosition,
      profitableCandidates,
      hedgedPositions,
      true,
    );

    assert.strictEqual(
      result.action,
      "sold_profitable_and_hedged",
      "Should sell non-hedged profitable and retry",
    );
    assert.strictEqual(
      result.soldPositions[0],
      "m3-t3",
      "Should sell m3 (not hedged) instead of m2 (hedged)",
    );
  });

  test("Should sell losing directly when all profitable candidates are already hedged", () => {
    const losingPosition: TestPosition = {
      marketId: "m1",
      tokenId: "t1",
      side: "YES",
      size: 100,
      entryPrice: 0.5,
      currentPrice: 0.35,
      pnlPct: -30,
      pnlUsd: -15,
    };

    const profitableCandidates: TestPosition[] = [
      {
        marketId: "m2",
        tokenId: "t2",
        side: "NO",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.44,
        pnlPct: 10,
        pnlUsd: 2,
      },
      {
        marketId: "m3",
        tokenId: "t3",
        side: "YES",
        size: 75,
        entryPrice: 0.3,
        currentPrice: 0.45,
        pnlPct: 50,
        pnlUsd: 11.25,
      },
    ];

    // All profitable candidates already hedged
    const hedgedPositions = new Set(["m2-t2", "m3-t3"]);

    const result = simulateFallbackLogic(
      losingPosition,
      profitableCandidates,
      hedgedPositions,
      false,
    );

    assert.strictEqual(
      result.action,
      "sold_losing_directly",
      "Should sell losing directly when all profitable are hedged",
    );
    assert.strictEqual(
      result.soldPositions.length,
      1,
      "Should only sell losing position",
    );
    assert.strictEqual(
      result.soldPositions[0],
      "m1-t1",
      "Should sell the losing position",
    );
  });
});
