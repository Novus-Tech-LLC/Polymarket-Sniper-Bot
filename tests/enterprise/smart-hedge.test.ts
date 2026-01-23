/**
 * Enterprise Smart Hedge Tests
 *
 * Tests for:
 * - Hedge allowed/disallowed boundaries
 * - PANIC override behavior
 * - Reserve failure paths
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  EnterpriseSmartHedge,
  DEFAULT_SMART_HEDGE_CONFIG,
  type MarketConditions,
  type EnterpriseSmartHedgeConfig,
} from "../../src/enterprise/smart-hedge";
import { createRiskManager } from "../../src/enterprise/risk-manager";
import type { TrackedPosition } from "../../src/enterprise/types";

// Mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Mock execution engine
function createMockExecutionEngine(shouldSucceed: boolean = true) {
  return {
    executeOrder: async () => ({
      success: shouldSucceed,
      orderId: "test-order",
      status: shouldSucceed ? "submitted" : "rejected",
      rejectReason: shouldSucceed ? undefined : "MOCK_REJECT",
    }),
    getStats: () => ({}),
  };
}

describe("EnterpriseSmartHedge", () => {
  let smartHedge: EnterpriseSmartHedge;
  let riskManager: ReturnType<typeof createRiskManager>;
  let mockExecutionEngine: ReturnType<typeof createMockExecutionEngine>;

  const defaultConfig: Partial<EnterpriseSmartHedgeConfig> = {
    enabled: true,
    hedgeWindowMinLossPct: 5,
    hedgeWindowMaxLossPct: 20,
    panicLossPct: 25,
    maxHedgeSpreadCents: 5,
    minHedgeDepthUsd: 50,
    maxHedgeCostCents: 70, // Allow expensive hedges for testing
    maxHedgeFraction: 0.3,
    minHedgeUsd: 1,
    maxHedgeUsd: 50,
    verboseLogging: false,
  };

  const defaultMarket: MarketConditions = {
    spread: 2, // 2 cents
    bidDepth: 100,
    askDepth: 100,
    bestBid: 0.4,
    bestAsk: 0.42,
  };

  beforeEach(() => {
    riskManager = createRiskManager("aggressive", mockLogger as any);
    mockExecutionEngine = createMockExecutionEngine(true);
    smartHedge = new EnterpriseSmartHedge(
      defaultConfig,
      mockLogger as any,
      riskManager,
      mockExecutionEngine as any,
    );
  });

  describe("Hedge Window Boundaries", () => {
    it("should skip when loss is below minimum threshold", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.48, // Only 4% loss
        currentValue: 4.8,
        unrealizedPnl: -0.2,
        unrealizedPnlPct: -4, // Below 5% minimum
        bestBid: 0.48,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "skipped");
      assert.ok(decision.reason.includes("< min"));
    });

    it("should skip when loss exceeds maximum threshold", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.35,
        currentValue: 3.5,
        unrealizedPnl: -1.5,
        unrealizedPnlPct: -22, // Above 20% maximum
        bestBid: 0.35,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "skipped");
      assert.ok(decision.reason.includes("> max"));
    });

    it("should allow hedge when loss is within window", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15, // Within 5-20% window
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "success");
    });

    it("should correctly identify hedge window", () => {
      assert.equal(smartHedge.isInHedgeWindow(4), false); // Below min
      assert.equal(smartHedge.isInHedgeWindow(5), true); // At min
      assert.equal(smartHedge.isInHedgeWindow(12), true); // In window
      assert.equal(smartHedge.isInHedgeWindow(20), true); // At max
      assert.equal(smartHedge.isInHedgeWindow(21), false); // Above max
    });
  });

  describe("PANIC Override Behavior", () => {
    it("should trigger PANIC and disable hedging at panic threshold", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.35,
        currentValue: 3.5,
        unrealizedPnl: -1.5,
        unrealizedPnlPct: -25, // At 25% PANIC threshold
        bestBid: 0.35,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "panic");
      assert.ok(decision.reason.includes("PANIC"));
    });

    it("should trigger PANIC when loss exceeds threshold", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.3,
        currentValue: 3.0,
        unrealizedPnl: -2.0,
        unrealizedPnlPct: -30, // 30% > 25% PANIC
        bestBid: 0.3,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "panic");
    });

    it("should correctly identify PANIC state", () => {
      assert.equal(smartHedge.isInPanic(20), false);
      assert.equal(smartHedge.isInPanic(24.9), false);
      assert.equal(smartHedge.isInPanic(25), true); // At threshold
      assert.equal(smartHedge.isInPanic(30), true);
      assert.equal(smartHedge.isInPanic(50), true);
    });

    it("should check PANIC before any other conditions", async () => {
      // Even with perfect market conditions, PANIC should trigger
      const perfectMarket: MarketConditions = {
        spread: 0.5,
        bidDepth: 1000,
        askDepth: 1000,
        bestBid: 0.5,
        bestAsk: 0.505,
      };

      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.35,
        currentValue: 3.5,
        unrealizedPnl: -1.5,
        unrealizedPnlPct: -26, // In PANIC
        bestBid: 0.35,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        perfectMarket,
        1000, // Plenty of reserves
      );

      assert.equal(decision.outcome, "panic");
    });
  });

  describe("Market Conditions", () => {
    it("should skip when spread is too wide", async () => {
      const wideSpreadMarket: MarketConditions = {
        spread: 10, // 10 cents > 5 cent max
        bidDepth: 100,
        askDepth: 100,
        bestBid: 0.35,
        bestAsk: 0.45,
      };

      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        wideSpreadMarket,
        100,
      );

      assert.equal(decision.outcome, "skipped");
      assert.ok(decision.reason.includes("Spread"));
    });

    it("should skip when depth is insufficient", async () => {
      const shallowMarket: MarketConditions = {
        spread: 2,
        bidDepth: 20, // Below 50 minimum
        askDepth: 20,
        bestBid: 0.4,
        bestAsk: 0.42,
      };

      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        shallowMarket,
        100,
      );

      assert.equal(decision.outcome, "skipped");
      assert.ok(decision.reason.includes("depth"));
    });
  });

  describe("Reserve Management", () => {
    it("should fail when reserves are insufficient", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        0.5, // Only $0.50 available
      );

      assert.equal(decision.outcome, "no_reserve");
      assert.ok(decision.reason.includes("Insufficient"));
    });

    it("should succeed when reserves are sufficient", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100, // Plenty of reserves
      );

      assert.equal(decision.outcome, "success");
    });
  });

  describe("Hedge Execution Failures", () => {
    it("should abort when execution fails", async () => {
      // Create new smartHedge with failing execution engine
      const failingEngine = createMockExecutionEngine(false);
      const failingSmartHedge = new EnterpriseSmartHedge(
        defaultConfig,
        mockLogger as any,
        riskManager,
        failingEngine as any,
      );

      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await failingSmartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "aborted");
      assert.ok(decision.reason.includes("failed"));
    });
  });

  describe("Statistics and Observability", () => {
    it("should track decision statistics", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      // Success case
      await smartHedge.evaluatePosition(position, defaultMarket, 100);

      // Skip case (below window)
      position.unrealizedPnlPct = -2;
      await smartHedge.evaluatePosition(position, defaultMarket, 100);

      // Panic case
      position.unrealizedPnlPct = -30;
      await smartHedge.evaluatePosition(position, defaultMarket, 100);

      const stats = smartHedge.getStats();
      assert.equal(stats.totalDecisions, 3);
      assert.equal(stats.successCount, 1);
      assert.equal(stats.skippedCount, 1);
      assert.equal(stats.panicCount, 1);
    });

    it("should return recent decisions", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.42,
        currentValue: 4.2,
        unrealizedPnl: -0.8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      await smartHedge.evaluatePosition(position, defaultMarket, 100);

      const decisions = smartHedge.getRecentDecisions(5);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].positionId, "test-token");
    });
  });

  describe("Hedge Size Calculation", () => {
    it("should respect maxHedgeFraction limit", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 100, // Large position
        costBasis: 50,
        currentPrice: 0.42,
        currentValue: 42, // $42 position
        unrealizedPnl: -8,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      // Max hedge should be 30% of $42 = $12.60, but capped at maxHedgeUsd = $50
      // Since 30% of 42 = 12.6 < 50, hedge should be ~$12.60
      assert.equal(decision.outcome, "success");
      assert.ok(decision.hedgeCostUsd <= 50);
    });

    it("should skip when calculated hedge is below minimum", async () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 2, // Tiny position
        costBasis: 1,
        currentPrice: 0.42,
        currentValue: 0.84, // $0.84 position
        unrealizedPnl: -0.16,
        unrealizedPnlPct: -15,
        bestBid: 0.42,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      // With config showing minHedgeUsd: 1
      // 30% of $0.84 = $0.25, which is < $1 min
      const decision = await smartHedge.evaluatePosition(
        position,
        defaultMarket,
        100,
      );

      assert.equal(decision.outcome, "skipped");
      assert.ok(decision.reason.includes("< min"));
    });
  });
});
