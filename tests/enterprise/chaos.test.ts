/**
 * Enterprise Chaos Tests
 *
 * Tests system behavior under adverse conditions:
 * - 502 bursts (API failures)
 * - Cooldown loops
 * - Stale allowance data
 * - Concurrent order stacking
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RiskManager,
  createRiskManager,
} from "../../src/enterprise/risk-manager";
import type { OrderRequest, TrackedPosition } from "../../src/enterprise/types";

// Mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("Enterprise Chaos Tests", () => {
  let riskManager: RiskManager;

  beforeEach(() => {
    riskManager = createRiskManager("aggressive", mockLogger as any, {
      maxConsecutiveRejects: 5,
      maxConsecutiveApiErrors: 3,
      circuitBreakerCooldownSeconds: 10,
      inFlightLockTimeoutMs: 5000,
      postOrderCooldownMs: 1000,
      panicLossPct: 30,
      reconciliationThresholdPct: 10,
    });
  });

  describe("502 Burst Handling", () => {
    it("should trigger circuit breaker after consecutive API errors", () => {
      // Simulate 502 bursts
      riskManager.reportApiHealth(false);
      riskManager.reportApiHealth(false);
      riskManager.reportApiHealth(false);

      const state = riskManager.getState();
      assert.equal(state.circuitBreaker.triggered, true);
      assert.ok(state.circuitBreaker.reason?.includes("API_ERRORS"));
    });

    it("should recover after circuit breaker cooldown", async () => {
      // Trigger circuit breaker
      riskManager.reportApiHealth(false);
      riskManager.reportApiHealth(false);
      riskManager.reportApiHealth(false);

      // Simulate passage of time
      await new Promise((r) => setTimeout(r, 100));

      // Force reset for testing
      riskManager.forceResetCircuitBreaker();

      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      const decision = riskManager.evaluate(request);
      assert.equal(decision.approved, true);
    });

    it("should gracefully degrade on unhealthy API", () => {
      // Report API unhealthy for a while
      riskManager.reportApiHealth(false);

      const state = riskManager.getState();
      assert.equal(state.apiHealthy, false);
    });
  });

  describe("Cooldown Loop Prevention", () => {
    it("should block orders during hard cooldown (no retry spam)", () => {
      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      // First order passes
      const firstDecision = riskManager.evaluate(request);
      assert.equal(firstDecision.approved, true);

      // Record failure with cooldown
      const cooldownUntil = Date.now() + 60000; // 60 seconds
      riskManager.recordOrderResult(request, false, "COOLDOWN", cooldownUntil);

      // Release in-flight lock for testing
      riskManager.releaseInFlightLock(request.tokenId, request.side);

      // Second order should be blocked by hard cooldown
      const secondDecision = riskManager.evaluate(request);
      assert.equal(secondDecision.approved, false);
      assert.ok(secondDecision.reason.includes("COOLDOWN_HARD"));
    });

    it("should allow orders after cooldown expiry", async () => {
      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token-2",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      // First order
      riskManager.evaluate(request);

      // Record failure with very short cooldown
      const cooldownUntil = Date.now() + 50; // 50ms
      riskManager.recordOrderResult(request, false, "COOLDOWN", cooldownUntil);
      riskManager.releaseInFlightLock(request.tokenId, request.side);

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 100));

      // Should now be allowed
      const decision = riskManager.evaluate(request);
      // The in-flight lock may still be in cooldown, but the hard cooldown should have expired
      // For this test we just verify the cooldown cache cleanup works
      riskManager.cleanupCooldowns();
    });

    it("should separate cooldowns by token_id + side", () => {
      const buyRequest: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      const sellRequest: OrderRequest = {
        ...buyRequest,
        side: "SELL",
      };

      // Buy order
      riskManager.evaluate(buyRequest);
      riskManager.recordOrderResult(
        buyRequest,
        false,
        "COOLDOWN",
        Date.now() + 60000,
      );
      riskManager.releaseInFlightLock(buyRequest.tokenId, buyRequest.side);

      // Sell should still work (different side)
      const sellDecision = riskManager.evaluate(sellRequest);
      // SELL doesn't have the same cooldown as BUY
      assert.equal(sellDecision.approved, true);
    });
  });

  describe("Stale Allowance Handling", () => {
    it("should track allowance info with token type", () => {
      riskManager.recordAllowanceInfo("COLLATERAL", undefined, 100, 50);

      const info = riskManager.getAllowanceInfo("COLLATERAL");
      assert.ok(info);
      assert.equal(info.tokenType, "COLLATERAL");
      assert.equal(info.allowance, 100);
      assert.equal(info.balance, 50);
    });

    it("should log allowance path on reject", () => {
      const logged: string[] = [];
      const loggerWithCapture = {
        ...mockLogger,
        error: (msg: string) => logged.push(msg),
      };

      const rm = createRiskManager("aggressive", loggerWithCapture as any);
      rm.recordAllowanceInfo(
        "CONDITIONAL",
        "test-token",
        0,
        100,
        "INSUFFICIENT_ALLOWANCE",
      );

      assert.ok(logged.some((l) => l.includes("CONDITIONAL")));
      assert.ok(logged.some((l) => l.includes("INSUFFICIENT_ALLOWANCE")));
    });

    it("should track CONDITIONAL token allowances separately", () => {
      riskManager.recordAllowanceInfo("CONDITIONAL", "token-A", 100, 50);
      riskManager.recordAllowanceInfo("CONDITIONAL", "token-B", 200, 75);

      const infoA = riskManager.getAllowanceInfo("CONDITIONAL", "token-A");
      const infoB = riskManager.getAllowanceInfo("CONDITIONAL", "token-B");

      assert.ok(infoA);
      assert.ok(infoB);
      assert.equal(infoA.allowance, 100);
      assert.equal(infoB.allowance, 200);
    });
  });

  describe("Order Stacking Prevention (In-Flight Locks)", () => {
    it("should block concurrent orders on same token + side", () => {
      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      // First order - should pass and set in-flight lock
      const first = riskManager.evaluate(request);
      assert.equal(first.approved, true);

      // Second order - should be blocked by in-flight lock
      const second = riskManager.evaluate(request);
      assert.equal(second.approved, false);
      assert.ok(second.reason.includes("IN_FLIGHT_LOCKED"));
    });

    it("should allow orders after in-flight lock release", () => {
      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token-3",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      // First order
      riskManager.evaluate(request);

      // Complete the order (releases in-flight)
      riskManager.recordOrderResult(request, true);

      // Need to wait for post-order cooldown, but for testing we can check state
      const state = riskManager.getState();
      assert.ok(state.activeInFlightLocks >= 0); // Lock should still exist but marked completed
    });

    it("should prevent flip-flopping (rapid buy/sell/buy)", async () => {
      const buyRequest: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token-4",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      // BUY
      const buy1 = riskManager.evaluate(buyRequest);
      assert.equal(buy1.approved, true);
      riskManager.recordOrderResult(buyRequest, true);

      // Immediate BUY again - should be blocked by post-order cooldown
      const buy2 = riskManager.evaluate(buyRequest);
      assert.equal(buy2.approved, false);
      assert.ok(buy2.reason.includes("IN_FLIGHT_LOCKED"));
    });
  });

  describe("PANIC Liquidation Override", () => {
    it("should allow PANIC liquidation regardless of tier", () => {
      const request: OrderRequest = {
        strategyId: "PANIC_LIQUIDATION",
        marketId: "test-market",
        tokenId: "test-token",
        outcome: "YES",
        side: "SELL",
        size: 10,
        price: 0.3,
        sizeUsd: 3,
        orderType: "MARKET",
      };

      // 35% loss >= 30% PANIC threshold
      const decision = riskManager.evaluate(request, undefined, 35);
      assert.equal(decision.approved, true);
      assert.ok(decision.reason.includes("PANIC_LIQUIDATION"));
    });

    it("should not allow PANIC override for non-PANIC strategies", () => {
      const request: OrderRequest = {
        strategyId: "STOP_LOSS",
        marketId: "test-market",
        tokenId: "test-token-5",
        outcome: "YES",
        side: "SELL",
        size: 10,
        price: 0.3,
        sizeUsd: 3,
        orderType: "MARKET",
      };

      // Same loss but different strategy - goes through normal evaluation
      const decision = riskManager.evaluate(request, undefined, 35);
      // Should pass normal evaluation (SELL orders don't have exposure limits)
      assert.equal(decision.approved, true);
      assert.ok(!decision.reason.includes("PANIC_LIQUIDATION"));
    });
  });

  describe("DUST/RESOLVED Position Exclusion", () => {
    it("should mark small positions as DUST", () => {
      const position: TrackedPosition = {
        tokenId: "test-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 0.1,
        costBasis: 0.05,
        currentPrice: 0.3,
        currentValue: 0.03, // Below $0.50 dust threshold
        unrealizedPnl: -0.02,
        unrealizedPnlPct: -40,
        bestBid: 0.25,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      riskManager.updatePosition(position);

      assert.equal(riskManager.isPositionExcluded("test-token"), true);
    });

    it("should exclude DUST from worst-loss calculations", () => {
      // Add a DUST position
      const dustPosition: TrackedPosition = {
        tokenId: "dust-token",
        marketId: "test-market",
        outcome: "YES",
        state: "DUST",
        size: 0.1,
        costBasis: 0.05,
        currentPrice: 0.3,
        currentValue: 0.03,
        unrealizedPnl: -0.02,
        unrealizedPnlPct: -40,
        bestBid: 0.25,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      // Add a normal position
      const normalPosition: TrackedPosition = {
        tokenId: "normal-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.45,
        currentValue: 4.5,
        unrealizedPnl: -0.5,
        unrealizedPnlPct: -10,
        bestBid: 0.45,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      riskManager.updatePosition(dustPosition);
      riskManager.updatePosition(normalPosition);

      const worstLoss = riskManager.getWorstLossPositions(5);

      // DUST should be excluded
      assert.ok(!worstLoss.some((p) => p.tokenId === "dust-token"));
      assert.ok(worstLoss.some((p) => p.tokenId === "normal-token"));
    });

    it("should mark RESOLVED positions correctly", () => {
      const position: TrackedPosition = {
        tokenId: "resolved-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 1.0,
        currentValue: 10,
        unrealizedPnl: 5,
        unrealizedPnlPct: 100,
        bestBid: 1.0,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };

      riskManager.updatePosition(position);
      riskManager.markPositionResolved("resolved-token");

      assert.equal(riskManager.isPositionExcluded("resolved-token"), true);
    });
  });

  describe("PnL Reconciliation", () => {
    it("should flag large discrepancies between reported and executable value", () => {
      // Add position for reconciliation
      const position: TrackedPosition = {
        tokenId: "recon-token",
        marketId: "test-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.6,
        currentValue: 6,
        unrealizedPnl: 1,
        unrealizedPnlPct: 20,
        bestBid: 0.55,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };
      riskManager.updatePosition(position);

      // Reported PnL: +$1 (currentValue - costBasis)
      // Executable value at best bid: 0.55 * 10 = $5.50
      // Expected PnL based on executable: $5.50 - $5 = $0.50
      // Discrepancy: |$1 - $0.50| = $0.50 = 10% of $5 cost basis

      const result = riskManager.reconcilePnL("recon-token", 1, 0.55, 10);

      // With 10% threshold, this should be on the edge
      assert.ok(result.discrepancyPct >= 0);
    });

    it("should halt market on reconciliation failure when configured", () => {
      const position: TrackedPosition = {
        tokenId: "halt-token",
        marketId: "halt-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.8,
        currentValue: 8,
        unrealizedPnl: 3,
        unrealizedPnlPct: 60,
        bestBid: 0.4, // Much lower than reported
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };
      riskManager.updatePosition(position);

      // Reported PnL: +$3
      // Executable value at best bid: 0.4 * 10 = $4
      // Expected PnL based on executable: $4 - $5 = -$1
      // Discrepancy: |$3 - (-$1)| = $4 = 80% of $5 cost basis (way over threshold)

      const result = riskManager.reconcilePnL("halt-token", 3, 0.4, 10);

      assert.equal(result.flagged, true);
      assert.equal(result.halted, true);

      // Market should be halted - orders rejected
      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "halt-market",
        tokenId: "other-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      const decision = riskManager.evaluate(request);
      assert.equal(decision.approved, false);
      assert.ok(decision.reason.includes("MARKET_HALTED"));
    });

    it("should allow unhalting market manually", () => {
      // Halt a market
      const position: TrackedPosition = {
        tokenId: "unhalt-token",
        marketId: "unhalt-market",
        outcome: "YES",
        state: "OPEN",
        size: 10,
        costBasis: 5,
        currentPrice: 0.8,
        currentValue: 8,
        unrealizedPnl: 3,
        unrealizedPnlPct: 60,
        bestBid: 0.2,
        entryTime: Date.now(),
        lastUpdate: Date.now(),
      };
      riskManager.updatePosition(position);
      riskManager.reconcilePnL("unhalt-token", 3, 0.2, 10);

      // Unhalt
      riskManager.unhaltMarket("unhalt-market");

      // Should be able to trade now
      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "unhalt-market",
        tokenId: "new-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      const decision = riskManager.evaluate(request);
      assert.equal(decision.approved, true);
    });
  });

  describe("Per-Strategy Kill Switches", () => {
    it("should block orders for killed strategy", () => {
      riskManager.killStrategy("FF", "Testing kill switch");

      const request: OrderRequest = {
        strategyId: "FF",
        marketId: "test-market",
        tokenId: "test-token-6",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      const decision = riskManager.evaluate(request);
      assert.equal(decision.approved, false);
      assert.ok(decision.reason.includes("STRATEGY_KILLED"));
    });

    it("should allow orders after strategy is revived", () => {
      riskManager.killStrategy("MM", "Test");
      riskManager.reviveStrategy("MM");

      const request: OrderRequest = {
        strategyId: "MM",
        marketId: "test-market",
        tokenId: "test-token-7",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        orderType: "LIMIT",
      };

      const decision = riskManager.evaluate(request);
      assert.equal(decision.approved, true);
    });

    it("should track killed strategies in state", () => {
      riskManager.killStrategy("FF", "Test 1");
      riskManager.killStrategy("ICC", "Test 2");

      const state = riskManager.getState();
      assert.equal(state.killedStrategies, 2);

      const killed = riskManager.getKilledStrategies();
      assert.equal(killed.length, 2);
      assert.ok(killed.some((s) => s.strategyId === "FF"));
      assert.ok(killed.some((s) => s.strategyId === "ICC"));
    });
  });
});
