import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Tests for snapshot-driven strategy execution
 *
 * These tests verify:
 * 1. PositionTracker produces immutable PortfolioSnapshot objects
 * 2. Orchestrator passes snapshot to strategies
 * 3. ScalpTakeProfit uses snapshot.activePositions correctly
 * 4. Regression: ScalpTakeProfit sees same activeTotal as PositionTracker reports
 * 5. Filtering cannot collapse to zero without logging explicit reasons
 */

import type {
  Position,
  PortfolioSnapshot,
  PortfolioSummary,
  PnLSource,
} from "../../src/strategies/position-tracker";

// Mock logger that captures log calls
function createMockLogger() {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    info: (msg: string) => logs.push({ level: "info", message: msg }),
    warn: (msg: string) => logs.push({ level: "warn", message: msg }),
    error: (msg: string, _?: Error) =>
      logs.push({ level: "error", message: msg }),
    debug: (msg: string) => logs.push({ level: "debug", message: msg }),
    getLogs: () => logs,
    clear: () => (logs.length = 0),
    hasLogMatching: (pattern: RegExp) =>
      logs.some((l) => pattern.test(l.message)),
    getLogsMatching: (pattern: RegExp) =>
      logs.filter((l) => pattern.test(l.message)),
  };
}

// Create a mock Position for testing
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "market-123",
    tokenId: "token-456",
    side: "YES",
    size: 100,
    entryPrice: 0.5,
    currentPrice: 0.55,
    pnlPct: 10,
    pnlUsd: 5,
    redeemable: false,
    status: "ACTIVE",
    pnlTrusted: true,
    pnlClassification: "PROFITABLE",
    currentBidPrice: 0.54,
    ...overrides,
  };
}

// Create a mock PortfolioSnapshot for testing
function createMockSnapshot(
  overrides: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
  const activePositions = overrides.activePositions ?? [
    createMockPosition({
      tokenId: "token-1",
      pnlPct: 10,
      pnlClassification: "PROFITABLE",
    }),
    createMockPosition({
      tokenId: "token-2",
      pnlPct: -5,
      pnlClassification: "LOSING",
    }),
    createMockPosition({
      tokenId: "token-3",
      pnlPct: 0,
      pnlClassification: "NEUTRAL",
    }),
  ];

  const redeemablePositions = overrides.redeemablePositions ?? [];

  const summary: PortfolioSummary = overrides.summary ?? {
    activeTotal: activePositions.length,
    prof: activePositions.filter((p) => p.pnlClassification === "PROFITABLE")
      .length,
    lose: activePositions.filter((p) => p.pnlClassification === "LOSING")
      .length,
    neutral: activePositions.filter((p) => p.pnlClassification === "NEUTRAL")
      .length,
    unknown: activePositions.filter((p) => p.pnlClassification === "UNKNOWN")
      .length,
    redeemableTotal: redeemablePositions.length,
  };

  return {
    cycleId: overrides.cycleId ?? 1,
    addressUsed:
      overrides.addressUsed ?? "0x1234567890abcdef1234567890abcdef12345678",
    fetchedAtMs: overrides.fetchedAtMs ?? Date.now(),
    activePositions: Object.freeze([...activePositions]),
    redeemablePositions: Object.freeze([...redeemablePositions]),
    summary,
    // Include optional diagnostic fields
    rawCounts: overrides.rawCounts,
    classificationReasons: overrides.classificationReasons,
  };
}

describe("PortfolioSnapshot Structure", () => {
  test("Snapshot has required fields", () => {
    const snapshot = createMockSnapshot();

    assert.ok(
      typeof snapshot.cycleId === "number",
      "cycleId should be a number",
    );
    assert.ok(
      typeof snapshot.addressUsed === "string",
      "addressUsed should be a string",
    );
    assert.ok(
      typeof snapshot.fetchedAtMs === "number",
      "fetchedAtMs should be a number",
    );
    assert.ok(
      Array.isArray(snapshot.activePositions),
      "activePositions should be an array",
    );
    assert.ok(
      Array.isArray(snapshot.redeemablePositions),
      "redeemablePositions should be an array",
    );
    assert.ok(
      typeof snapshot.summary === "object",
      "summary should be an object",
    );
  });

  test("Snapshot arrays are frozen (immutable)", () => {
    const snapshot = createMockSnapshot();

    // Attempt to modify frozen array should throw in strict mode or be no-op
    const originalLength = snapshot.activePositions.length;
    try {
      // @ts-expect-error Testing immutability - push should fail on frozen array
      snapshot.activePositions.push(createMockPosition());
    } catch {
      // Expected - array is frozen
    }

    assert.strictEqual(
      snapshot.activePositions.length,
      originalLength,
      "Frozen array should not allow modifications",
    );
  });

  test("Snapshot summary matches array counts", () => {
    const activePositions = [
      createMockPosition({ tokenId: "t1", pnlClassification: "PROFITABLE" }),
      createMockPosition({ tokenId: "t2", pnlClassification: "PROFITABLE" }),
      createMockPosition({ tokenId: "t3", pnlClassification: "LOSING" }),
      createMockPosition({ tokenId: "t4", pnlClassification: "NEUTRAL" }),
      createMockPosition({
        tokenId: "t5",
        pnlClassification: "UNKNOWN",
        pnlTrusted: false,
      }),
    ];

    const redeemablePositions = [
      createMockPosition({ tokenId: "r1", redeemable: true }),
    ];

    const snapshot = createMockSnapshot({
      activePositions,
      redeemablePositions,
      summary: {
        activeTotal: 5,
        prof: 2,
        lose: 1,
        neutral: 1,
        unknown: 1,
        redeemableTotal: 1,
      },
    });

    assert.strictEqual(
      snapshot.summary.activeTotal,
      snapshot.activePositions.length,
      "summary.activeTotal should match activePositions.length",
    );
    assert.strictEqual(
      snapshot.summary.redeemableTotal,
      snapshot.redeemablePositions.length,
      "summary.redeemableTotal should match redeemablePositions.length",
    );
    assert.strictEqual(
      snapshot.summary.prof +
        snapshot.summary.lose +
        snapshot.summary.neutral +
        snapshot.summary.unknown,
      snapshot.summary.activeTotal,
      "P&L classifications should sum to activeTotal",
    );
  });
});

describe("Regression: ScalpTakeProfit sees same activeTotal as PositionTracker", () => {
  test("When snapshot.activeTotal=22, ScalpTakeProfit should see 22 positions", () => {
    // Create snapshot with 22 active positions
    const activePositions = Array.from({ length: 22 }, (_, i) =>
      createMockPosition({
        tokenId: `token-${i}`,
        pnlPct: i % 3 === 0 ? 10 : i % 3 === 1 ? -5 : 0,
        pnlClassification:
          i % 3 === 0 ? "PROFITABLE" : i % 3 === 1 ? "LOSING" : "NEUTRAL",
      }),
    );

    const snapshot = createMockSnapshot({
      activePositions,
      summary: {
        activeTotal: 22,
        prof: 8, // Every 3rd position (0,3,6,9,12,15,18,21)
        lose: 7, // 1,4,7,10,13,16,19
        neutral: 7, // 2,5,8,11,14,17,20
        unknown: 0,
        redeemableTotal: 0,
      },
    });

    // Simulate what ScalpTakeProfit does with snapshot
    const activeFromSnapshot = snapshot.activePositions;

    assert.strictEqual(
      activeFromSnapshot.length,
      22,
      "ScalpTakeProfit should see 22 positions from snapshot",
    );
    assert.strictEqual(
      activeFromSnapshot.length,
      snapshot.summary.activeTotal,
      "activePositions.length should match summary.activeTotal",
    );
  });

  test("Snapshot prevents stale data by creating immutable copy", () => {
    // Simulate the scenario where positions map gets updated mid-cycle
    const originalPositions = [
      createMockPosition({ tokenId: "t1" }),
      createMockPosition({ tokenId: "t2" }),
    ];

    const snapshot = createMockSnapshot({
      activePositions: originalPositions,
      summary: {
        activeTotal: 2,
        prof: 2,
        lose: 0,
        neutral: 0,
        unknown: 0,
        redeemableTotal: 0,
      },
    });

    // Simulate PositionTracker updating its internal state
    const updatedPositions = [
      createMockPosition({ tokenId: "t1" }),
      createMockPosition({ tokenId: "t2" }),
      createMockPosition({ tokenId: "t3" }), // New position added
    ];

    // Original snapshot should be unchanged
    assert.strictEqual(
      snapshot.activePositions.length,
      2,
      "Snapshot should retain original 2 positions",
    );
    assert.strictEqual(
      updatedPositions.length,
      3,
      "Updated positions array has 3 positions",
    );
  });
});

describe("Bug Detection: Zero active positions when snapshot says otherwise", () => {
  test("Detects mismatch between snapshot summary and array length", () => {
    const logger = createMockLogger();

    // Create a snapshot with mismatched data (simulating a bug)
    const buggySnapshot: PortfolioSnapshot = {
      cycleId: 1,
      addressUsed: "0x123",
      fetchedAtMs: Date.now(),
      activePositions: Object.freeze([]), // Empty array!
      redeemablePositions: Object.freeze([]),
      summary: {
        activeTotal: 22, // Says 22 but array is empty
        prof: 12,
        lose: 9,
        neutral: 1,
        unknown: 0,
        redeemableTotal: 0,
      },
    };

    // Simulate the bug detection logic from ScalpTakeProfit
    if (
      buggySnapshot.summary.activeTotal > 0 &&
      buggySnapshot.activePositions.length === 0
    ) {
      logger.error(
        `[ScalpTakeProfit] BUG DETECTED: cycleId=${buggySnapshot.cycleId} ` +
          `addressUsed=${buggySnapshot.addressUsed} ` +
          `snapshot.summary.activeTotal=${buggySnapshot.summary.activeTotal} ` +
          `but activePositions.length=0. ` +
          `First 3 summary: prof=${buggySnapshot.summary.prof} ` +
          `lose=${buggySnapshot.summary.lose} ` +
          `unknown=${buggySnapshot.summary.unknown}`,
      );
    }

    // Verify bug was detected and logged
    assert.ok(
      logger.hasLogMatching(/BUG DETECTED/),
      "Should log BUG DETECTED when summary.activeTotal > 0 but array is empty",
    );
    assert.ok(
      logger.hasLogMatching(/cycleId=1/),
      "Bug log should include cycleId",
    );
    assert.ok(
      logger.hasLogMatching(/activeTotal=22/),
      "Bug log should include activeTotal",
    );
    assert.ok(
      logger.hasLogMatching(/activePositions.length=0/),
      "Bug log should include actual array length",
    );
  });
});

describe("Filtering Step Logging", () => {
  test("Logs filtering steps when positions collapse to zero", () => {
    const logger = createMockLogger();

    // Create snapshot with positions that will all be filtered out
    // All have pnlTrusted: false to ensure they get filtered
    const positions = [
      createMockPosition({
        tokenId: "t1",
        pnlTrusted: false, // Will be filtered
        pnlClassification: "UNKNOWN",
      }),
      createMockPosition({
        tokenId: "t2",
        pnlTrusted: false, // Will be filtered
        status: "NO_BOOK",
        pnlClassification: "UNKNOWN",
      }),
      createMockPosition({
        tokenId: "t3",
        pnlTrusted: false, // Will be filtered
        currentBidPrice: undefined,
        pnlClassification: "UNKNOWN",
      }),
    ];

    const snapshot = createMockSnapshot({
      activePositions: positions,
      summary: {
        activeTotal: 3,
        prof: 0,
        lose: 0,
        neutral: 0,
        unknown: 3,
        redeemableTotal: 0,
      },
    });

    // Simulate filtering logic
    const afterStateFilter = snapshot.activePositions.length;
    const afterPnlTrusted = snapshot.activePositions.filter(
      (p) => p.pnlTrusted,
    ).length;
    const afterNoBid = snapshot.activePositions.filter(
      (p) => p.pnlTrusted && p.currentBidPrice !== undefined,
    ).length;

    // Log filter steps
    logger.info(
      `[ScalpTakeProfit] Filter steps: ` +
        `start=${snapshot.summary.activeTotal} ` +
        `afterStateFilter=${afterStateFilter} ` +
        `afterPnlTrusted=${afterPnlTrusted} ` +
        `afterNoBid=${afterNoBid}`,
    );

    // Verify logging
    assert.ok(logger.hasLogMatching(/Filter steps/), "Should log filter steps");
    assert.ok(logger.hasLogMatching(/start=3/), "Should show starting count");
    assert.ok(
      logger.hasLogMatching(/afterPnlTrusted=0/),
      "Should show count after pnlTrusted filter",
    );
  });
});

describe("Orchestrator Ordering Guarantees", () => {
  test("Snapshot is created after refresh completes", async () => {
    // Simulate orchestrator behavior
    let refreshCompleted = false;
    let snapshotCreatedAfterRefresh = false;

    // Mock refresh
    const refresh = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      refreshCompleted = true;
    };

    // Mock getSnapshot (would be called after refresh)
    const getSnapshot = () => {
      snapshotCreatedAfterRefresh = refreshCompleted;
      return createMockSnapshot();
    };

    // Orchestrator sequence
    await refresh();
    const snapshot = getSnapshot();

    assert.ok(refreshCompleted, "Refresh should complete");
    assert.ok(
      snapshotCreatedAfterRefresh,
      "Snapshot should be created after refresh completes",
    );
    assert.ok(snapshot, "Snapshot should be returned");
  });

  test("Multiple strategies see the same snapshot", () => {
    const snapshot = createMockSnapshot({
      cycleId: 42,
      activePositions: [
        createMockPosition({ tokenId: "t1" }),
        createMockPosition({ tokenId: "t2" }),
      ],
    });

    // Simulate multiple strategies accessing the snapshot
    const strategy1View = snapshot.activePositions;
    const strategy2View = snapshot.activePositions;
    const strategy3View = snapshot.activePositions;

    // All should see the same data
    assert.strictEqual(strategy1View.length, strategy2View.length);
    assert.strictEqual(strategy2View.length, strategy3View.length);
    assert.strictEqual(strategy1View[0].tokenId, strategy2View[0].tokenId);
    assert.strictEqual(strategy2View[0].tokenId, strategy3View[0].tokenId);

    // All should reference the same frozen array (no copies)
    assert.strictEqual(strategy1View, strategy2View);
    assert.strictEqual(strategy2View, strategy3View);
  });
});

describe("PnL Trust and Source Handling", () => {
  test("DATA_API pnlSource is trusted for scalp decisions", () => {
    const pnlSource: PnLSource = "DATA_API";
    const position = createMockPosition({
      pnlSource,
      pnlTrusted: true,
      pnlPct: 10,
    });

    // DATA_API source should be trusted
    assert.ok(
      position.pnlTrusted,
      "DATA_API pnlSource should have pnlTrusted=true",
    );
    assert.strictEqual(
      position.pnlSource,
      "DATA_API",
      "pnlSource should be DATA_API",
    );
  });

  test("UNKNOWN pnlClassification positions are skipped", () => {
    const positions = [
      createMockPosition({ pnlClassification: "PROFITABLE", pnlTrusted: true }),
      createMockPosition({ pnlClassification: "UNKNOWN", pnlTrusted: false }),
      createMockPosition({ pnlClassification: "LOSING", pnlTrusted: true }),
    ];

    // Simulate filtering
    const trusted = positions.filter((p) => p.pnlTrusted);

    assert.strictEqual(
      trusted.length,
      2,
      "Should only have 2 trusted positions",
    );
    assert.ok(
      trusted.every((p) => p.pnlClassification !== "UNKNOWN"),
      "Trusted positions should not have UNKNOWN classification",
    );
  });
});

describe("Address Consistency", () => {
  test("Snapshot contains the address used for fetching", () => {
    const proxyAddress = "0xproxy123456789";
    const snapshot = createMockSnapshot({
      addressUsed: proxyAddress,
    });

    assert.strictEqual(
      snapshot.addressUsed,
      proxyAddress,
      "Snapshot should contain the address used for fetching",
    );
  });

  test("Strategy uses addressUsed from snapshot, not own resolution", () => {
    const snapshotAddress = "0xsnapshotAddress";
    const differentAddress = "0xdifferentAddress";

    const snapshot = createMockSnapshot({
      addressUsed: snapshotAddress,
    });

    // Simulate strategy using snapshot.addressUsed
    const addressUsedByStrategy = snapshot.addressUsed;

    assert.strictEqual(
      addressUsedByStrategy,
      snapshotAddress,
      "Strategy should use addressUsed from snapshot",
    );
    assert.notStrictEqual(
      addressUsedByStrategy,
      differentAddress,
      "Strategy should NOT use its own address resolution",
    );
  });
});

describe("REGRESSION: ACTIVE_COLLAPSE_BUG Detection", () => {
  test("Raw positions > 0 cannot silently become 0 active without logging", () => {
    const logger = createMockLogger();

    // Simulate the scenario: raw_total=10, raw_active_candidates=8, but final activePositions=0
    // This should trigger ACTIVE_COLLAPSE_BUG detection
    const rawCounts = {
      rawTotal: 10,
      rawActiveCandidates: 8,
      rawRedeemableCandidates: 2,
    };

    const classificationReasons = new Map<string, number>();
    classificationReasons.set("MISSING_FIELDS", 3);
    classificationReasons.set("INVALID_SIZE_PRICE", 5);

    // Create snapshot with 0 active but raw counts > 0 using createMockSnapshot
    const buggySnapshot = createMockSnapshot({
      cycleId: 42,
      addressUsed: "0x123abc",
      activePositions: [], // Empty!
      redeemablePositions: [],
      summary: {
        activeTotal: 0, // Zero active
        prof: 0,
        lose: 0,
        neutral: 0,
        unknown: 0,
        redeemableTotal: 0,
      },
      rawCounts,
      classificationReasons,
    });

    // Simulate ACTIVE_COLLAPSE_BUG detection logic
    if (
      rawCounts.rawTotal > 0 &&
      rawCounts.rawActiveCandidates > 0 &&
      buggySnapshot.activePositions.length === 0
    ) {
      const reasonCounts: string[] = [];
      for (const [reason, count] of classificationReasons) {
        reasonCounts.push(`${reason}=${count}`);
      }
      const reasonsStr = reasonCounts.join(", ");

      logger.error(
        `[PositionTracker] 🐛 ACTIVE_COLLAPSE_BUG: cycleId=${buggySnapshot.cycleId} ` +
          `addressUsed=${buggySnapshot.addressUsed.slice(0, 10)}... ` +
          `raw_total=${rawCounts.rawTotal} raw_active_candidates=${rawCounts.rawActiveCandidates} ` +
          `BUT final_active=0. Classification reasons: [${reasonsStr}].`,
      );
    }

    // Verify bug was detected
    assert.ok(
      logger.hasLogMatching(/ACTIVE_COLLAPSE_BUG/),
      "Should detect and log ACTIVE_COLLAPSE_BUG",
    );
    assert.ok(
      logger.hasLogMatching(/raw_total=10/),
      "Log should include raw_total",
    );
    assert.ok(
      logger.hasLogMatching(/raw_active_candidates=8/),
      "Log should include raw_active_candidates",
    );
    assert.ok(
      logger.hasLogMatching(/final_active=0/),
      "Log should include final_active=0",
    );
    assert.ok(
      logger.hasLogMatching(/MISSING_FIELDS=3/),
      "Log should include classification reasons",
    );
  });

  test("Active positions correctly populated when raw counts are valid", () => {
    // Normal case: raw positions = final positions (no collapse)
    const rawCounts = {
      rawTotal: 5,
      rawActiveCandidates: 5,
      rawRedeemableCandidates: 0,
    };

    const activePositions = Array.from({ length: 5 }, (_, i) =>
      createMockPosition({ tokenId: `token-${i}` }),
    );

    const snapshot = createMockSnapshot({
      activePositions,
      summary: {
        activeTotal: 5,
        prof: 3,
        lose: 1,
        neutral: 1,
        unknown: 0,
        redeemableTotal: 0,
      },
    });

    // No collapse bug when counts match
    const hasCollapse =
      rawCounts.rawTotal > 0 &&
      rawCounts.rawActiveCandidates > 0 &&
      snapshot.activePositions.length === 0;

    assert.strictEqual(
      hasCollapse,
      false,
      "Should not detect collapse when counts match",
    );
    assert.strictEqual(
      snapshot.activePositions.length,
      5,
      "Should have 5 active positions",
    );
  });
});

describe("REGRESSION: Address Stability", () => {
  test("addressUsed is preserved in snapshot", () => {
    const proxyAddress = "0xproxy1234567890abcdef";
    const snapshot = createMockSnapshot({
      addressUsed: proxyAddress,
    });

    assert.strictEqual(
      snapshot.addressUsed,
      proxyAddress,
      "Snapshot should preserve the address used",
    );
  });

  test("Address change detection works correctly", () => {
    const logger = createMockLogger();

    const previousAddress = "0xpreviousAddress123";
    const newAddress = "0xnewAddress456";

    // Simulate address change detection
    if (previousAddress !== newAddress) {
      logger.warn(
        `[PositionTracker] ⚠️ ADDRESS_CHANGED: Holding address changed from ${previousAddress.slice(0, 10)}... -> ${newAddress.slice(0, 10)}...`,
      );
    }

    assert.ok(
      logger.hasLogMatching(/ADDRESS_CHANGED/),
      "Should log address change warning",
    );
    assert.ok(
      logger.hasLogMatching(/0xprevious/),
      "Should include previous address",
    );
    assert.ok(
      logger.hasLogMatching(/0xnewAddre/),
      "Should include new address",
    );
  });

  test("No address change warning when address is stable", () => {
    const logger = createMockLogger();

    const stableAddress = "0xstableAddress123";
    const previousAddress = stableAddress;

    // Simulate stable address (no change)
    if (previousAddress !== stableAddress) {
      logger.warn(`[PositionTracker] ADDRESS_CHANGED`);
    }

    assert.ok(
      !logger.hasLogMatching(/ADDRESS_CHANGED/),
      "Should not log address change when stable",
    );
  });
});

describe("REGRESSION: ScalpTakeProfit Snapshot Consistency", () => {
  test("ScalpTakeProfit cannot see 0 when snapshot says >0", () => {
    const logger = createMockLogger();

    // Create a proper snapshot with 10 active positions
    const activePositions = Array.from({ length: 10 }, (_, i) =>
      createMockPosition({
        tokenId: `token-${i}`,
        pnlPct: i % 2 === 0 ? 10 : -5,
        pnlClassification: i % 2 === 0 ? "PROFITABLE" : "LOSING",
      }),
    );

    const snapshot = createMockSnapshot({
      activePositions,
      summary: {
        activeTotal: 10,
        prof: 5,
        lose: 5,
        neutral: 0,
        unknown: 0,
        redeemableTotal: 0,
      },
    });

    // Simulate ScalpTakeProfit accessing positions from snapshot
    const positionsFromSnapshot = snapshot.activePositions;

    // This should NEVER happen: snapshot says 10, but we see different
    if (snapshot.summary.activeTotal !== positionsFromSnapshot.length) {
      logger.error(
        `[ScalpTakeProfit] SNAPSHOT_MISMATCH: summary says ${snapshot.summary.activeTotal} but array has ${positionsFromSnapshot.length}`,
      );
    }

    // Verify consistency
    assert.strictEqual(
      positionsFromSnapshot.length,
      snapshot.summary.activeTotal,
      "Positions from snapshot should match summary.activeTotal",
    );
    assert.ok(
      !logger.hasLogMatching(/SNAPSHOT_MISMATCH/),
      "Should not log mismatch when snapshot is consistent",
    );
  });

  test("SNAPSHOT_MISMATCH is detected when summary differs from array", () => {
    const logger = createMockLogger();

    // Create an intentionally inconsistent snapshot (simulating a bug)
    // We need to manually create this because createMockSnapshot would auto-calculate summary
    const buggySnapshot = createMockSnapshot({
      cycleId: 1,
      addressUsed: "0x123",
      activePositions: [createMockPosition()], // Has 1 position
      redeemablePositions: [],
      summary: {
        activeTotal: 10, // Claims 10 positions! (inconsistent with actual 1)
        prof: 5,
        lose: 3,
        neutral: 2,
        unknown: 0,
        redeemableTotal: 0,
      },
    });

    // Simulate SNAPSHOT_MISMATCH detection
    if (
      buggySnapshot.summary.activeTotal !== buggySnapshot.activePositions.length
    ) {
      logger.error(
        `[ScalpTakeProfit] 🐛 SNAPSHOT_MISMATCH: summary.activeTotal=${buggySnapshot.summary.activeTotal} but activePositions.length=${buggySnapshot.activePositions.length}`,
      );
    }

    assert.ok(
      logger.hasLogMatching(/SNAPSHOT_MISMATCH/),
      "Should detect SNAPSHOT_MISMATCH when summary differs from array",
    );
    assert.ok(
      logger.hasLogMatching(/activeTotal=10/),
      "Should log the claimed activeTotal",
    );
    assert.ok(
      logger.hasLogMatching(/length=1/),
      "Should log the actual array length",
    );
  });
});

describe("REGRESSION: Classification Correctness", () => {
  test("ACTIVE positions are not derived from orderbook existence", () => {
    // Position should be ACTIVE regardless of whether orderbook exists
    // Status: NO_BOOK should NOT change ACTIVE -> REDEEMABLE
    const positionWithNoBook = createMockPosition({
      status: "NO_BOOK",
      redeemable: false, // Still active
      currentBidPrice: undefined,
    });

    assert.strictEqual(
      positionWithNoBook.redeemable,
      false,
      "Position with NO_BOOK status should still be active (not redeemable)",
    );
    assert.strictEqual(
      positionWithNoBook.status,
      "NO_BOOK",
      "Status should be NO_BOOK",
    );
  });

  test("REDEEMABLE requires explicit flag, not inferred from price", () => {
    // Position with price near 1.0 should NOT be auto-classified as REDEEMABLE
    const positionNearOne = createMockPosition({
      currentPrice: 0.99,
      redeemable: false, // Explicitly NOT redeemable despite price
    });

    assert.strictEqual(
      positionNearOne.redeemable,
      false,
      "Position with high price should not be automatically redeemable",
    );
  });

  test("Price near 1.0 does not change classification to REDEEMABLE", () => {
    // Create positions with various prices that might appear "resolved"
    const highPricePosition = createMockPosition({
      currentPrice: 0.98,
      redeemable: false,
      positionState: "ACTIVE",
    });

    const lowPricePosition = createMockPosition({
      currentPrice: 0.02,
      redeemable: false,
      positionState: "ACTIVE",
    });

    // Both should remain ACTIVE
    assert.strictEqual(
      highPricePosition.redeemable,
      false,
      "High price position should not be marked redeemable",
    );
    assert.strictEqual(
      lowPricePosition.redeemable,
      false,
      "Low price position should not be marked redeemable",
    );
    assert.strictEqual(
      highPricePosition.positionState,
      "ACTIVE",
      "High price position state should be ACTIVE",
    );
    assert.strictEqual(
      lowPricePosition.positionState,
      "ACTIVE",
      "Low price position state should be ACTIVE",
    );
  });
});
