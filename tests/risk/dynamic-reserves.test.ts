import assert from "node:assert";
import { test, describe } from "node:test";
import {
  createDynamicReservesController,
  DEFAULT_RESERVES_CONFIG,
  type WalletBalances,
} from "../../src/risk/dynamic-reserves";
import type {
  PortfolioSnapshot,
  Position,
  PortfolioSummary,
} from "../../src/strategies/position-tracker";

/**
 * Unit tests for Dynamic Reserves / Capital Allocation Controller
 */

// Mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Helper to create a mock position
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "market-1",
    tokenId: "token-1",
    side: "YES",
    size: 100,
    entryPrice: 0.5,
    currentPrice: 0.5,
    pnlPct: 0,
    pnlUsd: 0,
    pnlTrusted: true,
    pnlClassification: "NEUTRAL",
    ...overrides,
  };
}

// Helper to create a mock snapshot
function createMockSnapshot(
  positions: Position[],
  overrides: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
  const summary: PortfolioSummary = {
    activeTotal: positions.length,
    prof: positions.filter((p) => p.pnlPct > 0).length,
    lose: positions.filter((p) => p.pnlPct < 0).length,
    neutral: positions.filter((p) => p.pnlPct === 0).length,
    unknown: 0,
    redeemableTotal: 0,
  };

  return {
    cycleId: 1,
    addressUsed: "0x123",
    fetchedAtMs: Date.now(),
    activePositions: Object.freeze(positions),
    redeemablePositions: Object.freeze([]),
    summary,
    ...overrides,
  };
}

describe("DynamicReservesController", () => {
  describe("computeReservePlan", () => {
    test("returns RISK_ON when cash exceeds required reserve", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: 5, // Profitable
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      assert.equal(plan.mode, "RISK_ON");
      assert.equal(plan.shortfall, 0);
      assert(plan.availableCash >= plan.reserveRequired);
    });

    test("returns RISK_OFF when cash is below required reserve", () => {
      const controller = createDynamicReservesController(mockLogger);
      // Multiple losing positions requiring reserves
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: -25, // Losing 25% - hedge tier
        }),
        createMockPosition({
          tokenId: "token-2",
          size: 100,
          currentPrice: 0.5,
          pnlPct: -55, // Losing 55% - catastrophic tier
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 5 }; // Very low balance

      const plan = controller.computeReservePlan(snapshot, balances);

      assert.equal(plan.mode, "RISK_OFF");
      assert(plan.shortfall > 0);
    });

    test("redeemable positions do not contribute to reserves", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.99,
          pnlPct: 50,
          redeemable: true,
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 30 };

      const plan = controller.computeReservePlan(snapshot, balances);

      // Should be RISK_ON since redeemable position has 0 reserve
      assert.equal(plan.mode, "RISK_ON");
      // Position reserve should be 0 for redeemable
      const positionReserves = plan.topPositionReserves;
      const tokenReserve = positionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.tier, "NONE");
      assert.equal(tokenReserve?.finalReserve, 0);
    });

    test("near-resolution candidates do not contribute to reserves", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.995,
          pnlPct: 50,
          nearResolutionCandidate: true,
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 30 };

      const plan = controller.computeReservePlan(snapshot, balances);

      // Should be RISK_ON since near-resolution has 0 reserve
      assert.equal(plan.mode, "RISK_ON");
      const positionReserves = plan.topPositionReserves;
      const tokenReserve = positionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.tier, "NONE");
      assert.equal(tokenReserve?.finalReserve, 0);
    });

    test("catastrophic losses require full hedge reserve", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: -55, // 55% loss - catastrophic
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      // Find the reserve for this position
      const tokenReserve = plan.topPositionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.tier, "CATASTROPHIC");
      // Catastrophic tier = min(hedgeCapUsd, notional * 1.0)
      // notional = 100 * 0.5 = 50, hedgeCapUsd = 25 (default)
      // So reserve = min(25, 50) = 25
      assert.equal(
        tokenReserve?.baseReserve,
        DEFAULT_RESERVES_CONFIG.hedgeCapUsd,
      );
    });

    test("hedge trigger losses require 50% of notional reserve", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: -25, // 25% loss - hedge tier
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      const tokenReserve = plan.topPositionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.tier, "HEDGE");
      // Hedge tier = min(hedgeCapUsd, notional * 0.5)
      // notional = 100 * 0.5 = 50
      // reserve = min(25, 50 * 0.5) = min(25, 25) = 25
      assert.equal(
        tokenReserve?.baseReserve,
        DEFAULT_RESERVES_CONFIG.hedgeCapUsd,
      );
    });

    test("normal positions have small buffer reserve", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: 5, // Small profit - normal tier
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      const tokenReserve = plan.topPositionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.tier, "NORMAL");
      // Normal tier = min(normalReserveCapUsd, notional * 0.1)
      // notional = 100 * 0.5 = 50
      // reserve = min(2, 50 * 0.1) = min(2, 5) = 2
      assert.equal(
        tokenReserve?.baseReserve,
        DEFAULT_RESERVES_CONFIG.normalReserveCapUsd,
      );
    });

    test("illiquid positions have 1.5x multiplier on reserve", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: -25, // Hedge tier
          executionStatus: "NOT_TRADABLE_ON_CLOB",
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      const tokenReserve = plan.topPositionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.liquidityMultiplier, 1.5);
      // Base reserve = 25 (hedge tier)
      // Final = 25 * 1.5 = 37.5
      assert.equal(tokenReserve?.finalReserve, 37.5);
    });

    test("base reserve is max of floor and equity percentage", () => {
      const controller = createDynamicReservesController(mockLogger, {
        baseReserveFloorUsd: 20,
        baseReserveEquityPct: 0.05,
      });
      // Large position value should trigger equity-based reserve
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 10000,
          currentPrice: 1.0, // $10,000 position
          pnlPct: 5,
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 1000 };

      const plan = controller.computeReservePlan(snapshot, balances);

      // Equity = 1000 + 10000 = 11000
      // Base reserve = max(20, 0.05 * 11000) = max(20, 550) = 550
      assert.equal(plan.baseReserve, 550);
    });

    test("reserve is capped at maxReserveUsd", () => {
      const controller = createDynamicReservesController(mockLogger, {
        maxReserveUsd: 50,
      });
      // Create many losing positions to exceed cap
      const positions = Array.from({ length: 10 }, (_, i) =>
        createMockPosition({
          tokenId: `token-${i}`,
          size: 100,
          currentPrice: 0.5,
          pnlPct: -55, // Catastrophic
        }),
      );
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      // Total should be capped at 50
      assert(plan.reserveRequired <= 50);
    });

    test("locked funds reduce available cash", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [createMockPosition()];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = {
        usdcBalance: 100,
        lockedUsd: 80, // 80 locked
      };

      const plan = controller.computeReservePlan(snapshot, balances);

      assert.equal(plan.availableCash, 20); // 100 - 80
    });
  });

  describe("canOpenNewBuy", () => {
    test("allows BUY when in RISK_ON mode", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [createMockPosition()];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      controller.computeReservePlan(snapshot, balances);
      const result = controller.canOpenNewBuy();

      assert.equal(result.allowed, true);
      assert.equal(result.mode, "RISK_ON");
      assert.equal(result.shortfall, 0);
    });

    test("blocks BUY when in RISK_OFF mode", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 100,
          currentPrice: 0.5,
          pnlPct: -55, // Catastrophic
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 5 }; // Very low

      controller.computeReservePlan(snapshot, balances);
      const result = controller.canOpenNewBuy();

      assert.equal(result.allowed, false);
      assert.equal(result.reason, "RISK_OFF_RESERVE_SHORTFALL");
      assert.equal(result.mode, "RISK_OFF");
      assert(result.shortfall > 0);
    });

    test("allows BUY when reserves are disabled", () => {
      const controller = createDynamicReservesController(mockLogger, {
        enabled: false,
      });

      const result = controller.canOpenNewBuy();

      assert.equal(result.allowed, true);
      assert.equal(result.reason, "RESERVES_DISABLED");
    });

    test("allows BUY when no plan is computed", () => {
      const controller = createDynamicReservesController(mockLogger);

      // Don't compute a plan
      const result = controller.canOpenNewBuy();

      assert.equal(result.allowed, true);
      assert.equal(result.reason, "NO_PLAN_AVAILABLE");
    });

    test("uses provided plan instead of last computed", () => {
      const controller = createDynamicReservesController(mockLogger);

      // Create a RISK_OFF plan directly
      const riskOffPlan = {
        mode: "RISK_OFF" as const,
        reserveRequired: 100,
        baseReserve: 20,
        positionReserve: 80,
        availableCash: 10,
        shortfall: 90,
        topPositionReserves: [],
        equityUsd: 100,
        computedAtMs: Date.now(),
      };

      const result = controller.canOpenNewBuy(riskOffPlan);

      assert.equal(result.allowed, false);
      assert.equal(result.mode, "RISK_OFF");
    });
  });

  describe("getStats", () => {
    test("returns current state", () => {
      const controller = createDynamicReservesController(mockLogger);
      const positions = [createMockPosition()];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      controller.computeReservePlan(snapshot, balances);
      const stats = controller.getStats();

      assert.equal(stats.enabled, true);
      assert.equal(stats.currentMode, "RISK_ON");
      assert.equal(typeof stats.modeChangeCount, "number");
      assert.notEqual(stats.lastPlanAge, null);
    });
  });

  describe("configuration", () => {
    test("uses default config when none provided", () => {
      const controller = createDynamicReservesController(mockLogger);
      const stats = controller.getStats();

      assert.equal(stats.enabled, DEFAULT_RESERVES_CONFIG.enabled);
    });

    test("merges partial config with defaults", () => {
      const controller = createDynamicReservesController(mockLogger, {
        hedgeCapUsd: 50,
      });
      const positions = [
        createMockPosition({
          tokenId: "token-1",
          size: 200,
          currentPrice: 0.5,
          pnlPct: -55, // Catastrophic
        }),
      ];
      const snapshot = createMockSnapshot(positions);
      const balances: WalletBalances = { usdcBalance: 100 };

      const plan = controller.computeReservePlan(snapshot, balances);

      // Catastrophic with custom hedgeCapUsd = 50
      // notional = 200 * 0.5 = 100
      // reserve = min(50, 100) = 50
      const tokenReserve = plan.topPositionReserves.find(
        (r) => r.tokenId === "token-1",
      );
      assert.equal(tokenReserve?.baseReserve, 50);
    });
  });
});
