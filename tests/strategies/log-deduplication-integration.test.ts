import assert from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";
import {
  LogDeduper,
  SkipReasonAggregator,
  resetLogDeduper,
  HEARTBEAT_INTERVAL_MS,
} from "../../src/utils/log-deduper.util";

/**
 * Integration test: Proves that repeated cycles don't spam identical logs.
 *
 * This test simulates multiple orchestrator cycles with the same skip conditions
 * and verifies that logs are not emitted on every cycle.
 */
describe("Log Deduplication Integration", () => {
  let logDeduper: LogDeduper;
  const logs: string[] = [];

  // Mock logger that records all log calls
  const mockLogger = {
    info: (msg: string) => logs.push(`[INFO] ${msg}`),
    debug: (msg: string) => logs.push(`[DEBUG] ${msg}`),
    warn: (msg: string) => logs.push(`[WARN] ${msg}`),
    error: (msg: string) => logs.push(`[ERROR] ${msg}`),
  };

  beforeEach(() => {
    logs.length = 0;
    logDeduper = new LogDeduper();
  });

  afterEach(() => {
    resetLogDeduper();
  });

  test("SmartHedging pattern: aggregated skip summary is not spammed", () => {
    // Simulate 10 cycles with the same 5 positions being skipped
    const positions = [
      { tokenId: "token1", reason: "redeemable" },
      { tokenId: "token2", reason: "redeemable" },
      { tokenId: "token3", reason: "loss_below_trigger" },
      { tokenId: "token4", reason: "entry_price_high" },
      { tokenId: "token5", reason: "hold_time_short" },
    ];

    for (let cycle = 1; cycle <= 10; cycle++) {
      const skipAggregator = new SkipReasonAggregator();

      // Aggregate skip reasons
      for (const pos of positions) {
        skipAggregator.add(pos.tokenId, pos.reason);
      }

      // Only log if fingerprint changed or TTL expired (using short TTL for test)
      const fingerprint = skipAggregator.getFingerprint();
      if (logDeduper.shouldLogSummary("Hedging", fingerprint, 120_000)) {
        mockLogger.debug(
          `[SmartHedging] Skipped ${skipAggregator.getTotalCount()} positions: ${skipAggregator.getSummary()} (cycle=${cycle})`,
        );
      }
    }

    // Should only log ONCE since fingerprint is identical across all cycles
    const hedgingLogs = logs.filter((l) => l.includes("[SmartHedging]"));
    assert.strictEqual(
      hedgingLogs.length,
      1,
      `Expected 1 SmartHedging log, got ${hedgingLogs.length}: ${JSON.stringify(hedgingLogs)}`,
    );

    // Verify the log contains the aggregated summary
    assert.ok(hedgingLogs[0].includes("Skipped 5 positions"));
    assert.ok(hedgingLogs[0].includes("redeemable=2"));
  });

  test("SmartHedging pattern: logs immediately on fingerprint change", () => {
    // Cycle 1: Skip 3 positions
    let skipAggregator = new SkipReasonAggregator();
    skipAggregator.add("token1", "redeemable");
    skipAggregator.add("token2", "redeemable");
    skipAggregator.add("token3", "loss_below_trigger");

    let fingerprint = skipAggregator.getFingerprint();
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug(
        `[SmartHedging] Cycle 1: ${skipAggregator.getSummary()}`,
      );
    }

    // Cycle 2: Same positions - should NOT log
    skipAggregator = new SkipReasonAggregator();
    skipAggregator.add("token1", "redeemable");
    skipAggregator.add("token2", "redeemable");
    skipAggregator.add("token3", "loss_below_trigger");

    fingerprint = skipAggregator.getFingerprint();
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug(
        `[SmartHedging] Cycle 2: ${skipAggregator.getSummary()}`,
      );
    }

    // Cycle 3: One more position redeemable - fingerprint changes, SHOULD log
    skipAggregator = new SkipReasonAggregator();
    skipAggregator.add("token1", "redeemable");
    skipAggregator.add("token2", "redeemable");
    skipAggregator.add("token3", "redeemable"); // CHANGED from loss_below_trigger
    skipAggregator.add("token4", "loss_below_trigger");

    fingerprint = skipAggregator.getFingerprint();
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug(
        `[SmartHedging] Cycle 3: ${skipAggregator.getSummary()}`,
      );
    }

    const hedgingLogs = logs.filter((l) => l.includes("[SmartHedging]"));
    assert.strictEqual(
      hedgingLogs.length,
      2,
      `Expected 2 logs (cycle 1 and 3), got ${hedgingLogs.length}`,
    );

    // Verify cycle 1 and 3 logged, cycle 2 suppressed
    assert.ok(hedgingLogs[0].includes("Cycle 1"));
    assert.ok(hedgingLogs[1].includes("Cycle 3"));
  });

  test("ScalpTakeProfit pattern: no-book positions don't spam logs", () => {
    // Simulate 5 cycles where the same position has NO_BOOK status
    for (let cycle = 1; cycle <= 5; cycle++) {
      const skipAggregator = new SkipReasonAggregator();

      // Same 3 positions with NO_BOOK status each cycle
      skipAggregator.add("token1", "no_book");
      skipAggregator.add("token2", "no_book");
      skipAggregator.add("token3", "no_bid");

      const fingerprint = skipAggregator.getFingerprint();
      if (logDeduper.shouldLogSummary("Scalp", fingerprint)) {
        mockLogger.debug(
          `[ScalpTakeProfit] Skipped: ${skipAggregator.getSummary()} (cycle=${cycle})`,
        );
      }
    }

    const scalpLogs = logs.filter((l) => l.includes("[ScalpTakeProfit]"));
    assert.strictEqual(
      scalpLogs.length,
      1,
      `Expected 1 ScalpTakeProfit log, got ${scalpLogs.length}`,
    );
  });

  test("PositionTracker pattern: refresh skip is rate-limited", () => {
    // Simulate rapid refresh calls where each one is skipped
    for (let i = 0; i < 20; i++) {
      if (logDeduper.shouldLog("Tracker:skip_refresh_in_progress", 60_000)) {
        mockLogger.debug(
          "[PositionTracker] Refresh already in progress, skipping",
        );
      }
    }

    const trackerLogs = logs.filter((l) => l.includes("[PositionTracker]"));
    assert.strictEqual(
      trackerLogs.length,
      1,
      `Expected 1 PositionTracker log, got ${trackerLogs.length}`,
    );
  });

  test("Monitor pattern: summary log is rate-limited when no new trades", () => {
    const trader = "0x123";

    // Simulate 10 ticks where we fetch the same activities with no new trades
    for (let tick = 1; tick <= 10; tick++) {
      const summaryFingerprint = `${trader}:5:3:2`; // 5 trades, 3 too old, 2 processed

      if (
        logDeduper.shouldLog(
          `Monitor:summary:${trader}`,
          HEARTBEAT_INTERVAL_MS,
          summaryFingerprint,
        )
      ) {
        mockLogger.debug(
          `[Monitor] ${trader}: 5 trades (3 too old, 2 already processed)`,
        );
      }
    }

    const monitorLogs = logs.filter((l) => l.includes("[Monitor]"));
    assert.strictEqual(
      monitorLogs.length,
      1,
      `Expected 1 Monitor log, got ${monitorLogs.length}`,
    );
  });

  test("Orchestrator pattern: slow strategies log is rate-limited", () => {
    // Simulate 10 cycles where the same strategies are slow
    for (let cycle = 1; cycle <= 10; cycle++) {
      const slowStrategies = [
        { name: "Hedging", durationMs: 600 },
        { name: "Endgame", durationMs: 550 },
      ];

      const slowNamesFingerprint = slowStrategies
        .map((s) => s.name)
        .sort()
        .join(",");

      if (
        logDeduper.shouldLog(
          "Orchestrator:slow_strategies",
          HEARTBEAT_INTERVAL_MS,
          slowNamesFingerprint,
        )
      ) {
        mockLogger.debug(
          `[Orchestrator] Slow strategies: ${slowStrategies.map((s) => `${s.name}=${s.durationMs}ms`).join(", ")}`,
        );
      }
    }

    const orchestratorLogs = logs.filter((l) => l.includes("[Orchestrator]"));
    assert.strictEqual(
      orchestratorLogs.length,
      1,
      `Expected 1 Orchestrator log, got ${orchestratorLogs.length}`,
    );
  });

  test("State transition: logs when position becomes redeemable", () => {
    // Simulates state change tracking for a position
    const lastSkipReasonByTokenId = new Map<string, string>();
    const tokenId = "token123";

    // Cycle 1: Position is not redeemable
    let previousReason = lastSkipReasonByTokenId.get(tokenId);
    if (previousReason !== "active") {
      mockLogger.info(`[SmartHedging] Position ${tokenId} is active`);
      lastSkipReasonByTokenId.set(tokenId, "active");
    }

    // Cycle 2: Position becomes redeemable - state changed!
    previousReason = lastSkipReasonByTokenId.get(tokenId);
    if (previousReason !== "redeemable") {
      mockLogger.info(
        `[SmartHedging] 🔄 Position became redeemable: ${tokenId}`,
      );
      lastSkipReasonByTokenId.set(tokenId, "redeemable");
    }

    // Cycle 3-5: Position still redeemable - should NOT log again
    for (let cycle = 3; cycle <= 5; cycle++) {
      previousReason = lastSkipReasonByTokenId.get(tokenId);
      if (previousReason !== "redeemable") {
        mockLogger.info(`[SmartHedging] This should not appear`);
        lastSkipReasonByTokenId.set(tokenId, "redeemable");
      }
    }

    const stateLogs = logs.filter((l) => l.includes("token123"));
    assert.strictEqual(
      stateLogs.length,
      2,
      `Expected 2 state logs (active, then redeemable), got ${stateLogs.length}`,
    );
    assert.ok(stateLogs[0].includes("active"));
    assert.ok(stateLogs[1].includes("redeemable"));
  });

  test("Multiple components: logs are independent per component", () => {
    // Each component should have independent rate-limiting
    const fingerprint = '{"count":5}';

    // Log once for each component
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug("[SmartHedging] Summary");
    }
    if (logDeduper.shouldLogSummary("Scalp", fingerprint)) {
      mockLogger.debug("[ScalpTakeProfit] Summary");
    }
    if (logDeduper.shouldLogSummary("Monitor", fingerprint)) {
      mockLogger.debug("[Monitor] Summary");
    }

    // Try again - should all be suppressed
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug("[SmartHedging] Summary 2");
    }
    if (logDeduper.shouldLogSummary("Scalp", fingerprint)) {
      mockLogger.debug("[ScalpTakeProfit] Summary 2");
    }
    if (logDeduper.shouldLogSummary("Monitor", fingerprint)) {
      mockLogger.debug("[Monitor] Summary 2");
    }

    // Should have exactly 3 logs (one per component)
    assert.strictEqual(logs.length, 3);
    assert.ok(logs[0].includes("[SmartHedging]"));
    assert.ok(logs[1].includes("[ScalpTakeProfit]"));
    assert.ok(logs[2].includes("[Monitor]"));
  });

  test("MempoolMonitor pattern: change-based logging prevents spam", () => {
    // Simulate the MempoolMonitor's new change-based logging behavior
    // This mirrors the implementation in mempool-monitor.service.ts

    let lastLoggedSummaryHash: string | null = null;
    let lastLoggedAt = 0;
    const HEARTBEAT_MS = 60_000; // Matches MONITOR_HEARTBEAT_MS default

    // Helper function that mirrors the Monitor's shouldLog logic
    function shouldLogMonitorSummary(
      checkedAddresses: number,
      eligibleTrades: number,
      recentTrades: number,
      totalSkipped: number,
      failedCount: number,
      currentTime: number,
    ): { shouldLog: boolean; indicator: string } {
      const summaryHashObj = {
        addrs: checkedAddresses,
        eligible: eligibleTrades,
        recent: recentTrades,
        skipped: totalSkipped,
        failed: failedCount,
      };
      const summaryHash = JSON.stringify(summaryHashObj);

      const heartbeatElapsed = currentTime - lastLoggedAt >= HEARTBEAT_MS;
      const hashChanged = summaryHash !== lastLoggedSummaryHash;

      // ALWAYS log if there are failures or eligible trades
      const hasFailures = failedCount > 0;
      const hasEligibleTrades = eligibleTrades > 0;

      const shouldLog =
        hasFailures || hasEligibleTrades || hashChanged || heartbeatElapsed;

      if (shouldLog) {
        lastLoggedSummaryHash = summaryHash;
        lastLoggedAt = currentTime;
      }

      return { shouldLog, indicator: hashChanged ? "Δ" : "♥" };
    }

    const baseTime = Date.now();

    // Cycle 1: First call - should log (first_time)
    let result = shouldLogMonitorSummary(17, 0, 0, 1379, 0, baseTime);
    if (result.shouldLog) {
      mockLogger.info(
        `[Monitor] ✓ 17 addrs | eligible=0 recent=0 skipped=1379 (${result.indicator})`,
      );
    }
    assert.strictEqual(result.shouldLog, true, "First call should log");

    // Cycles 2-10: Same data (no eligible, no failures), no time elapsed - should NOT log
    for (let i = 2; i <= 10; i++) {
      result = shouldLogMonitorSummary(17, 0, 0, 1379, 0, baseTime + i * 1000); // 1 second intervals
      if (result.shouldLog) {
        mockLogger.info(
          `[Monitor] ✓ 17 addrs | eligible=0 recent=0 skipped=1379 (${result.indicator})`,
        );
      }
    }

    // Should only have 1 log so far (spam prevented!)
    let monitorLogs = logs.filter((l) => l.includes("[Monitor] ✓"));
    assert.strictEqual(
      monitorLogs.length,
      1,
      `Expected 1 Monitor log after 10 identical cycles, got ${monitorLogs.length}`,
    );

    // Cycle 11: Hash changed (different skipped count) - should log immediately
    // Note: We keep eligible=0 to test pure hash change behavior
    result = shouldLogMonitorSummary(17, 0, 0, 1380, 0, baseTime + 11000);
    if (result.shouldLog) {
      mockLogger.info(
        `[Monitor] ✓ 17 addrs | eligible=0 recent=0 skipped=1380 (${result.indicator})`,
      );
    }
    assert.strictEqual(
      result.shouldLog,
      true,
      "Hash change should trigger log",
    );
    assert.strictEqual(result.indicator, "Δ", "Should indicate change with Δ");

    // Cycle 12: Same as cycle 11 - should NOT log (no eligible, no failures, no hash change)
    result = shouldLogMonitorSummary(17, 0, 0, 1380, 0, baseTime + 12000);
    if (result.shouldLog) {
      mockLogger.info(
        `[Monitor] ✓ 17 addrs | eligible=0 recent=0 skipped=1380 (${result.indicator})`,
      );
    }
    assert.strictEqual(
      result.shouldLog,
      false,
      "Duplicate should be suppressed",
    );

    // Should have exactly 2 logs now
    monitorLogs = logs.filter((l) => l.includes("[Monitor] ✓"));
    assert.strictEqual(
      monitorLogs.length,
      2,
      `Expected 2 Monitor logs after hash change, got ${monitorLogs.length}`,
    );

    // Cycle 13: Heartbeat elapsed (60 seconds later) - should log
    result = shouldLogMonitorSummary(
      17,
      0,
      0,
      1380,
      0,
      baseTime + 12000 + HEARTBEAT_MS,
    );
    if (result.shouldLog) {
      mockLogger.info(
        `[Monitor] ✓ 17 addrs | eligible=0 recent=0 skipped=1380 (${result.indicator})`,
      );
    }
    assert.strictEqual(result.shouldLog, true, "Heartbeat should trigger log");
    assert.strictEqual(
      result.indicator,
      "♥",
      "Should indicate heartbeat with ♥",
    );

    // Should have exactly 3 logs now
    monitorLogs = logs.filter((l) => l.includes("[Monitor] ✓"));
    assert.strictEqual(
      monitorLogs.length,
      3,
      `Expected 3 Monitor logs after heartbeat, got ${monitorLogs.length}`,
    );
  });

  test("MempoolMonitor pattern: failures always bypass throttling", () => {
    // Reset state for this test
    let lastLoggedSummaryHash: string | null = null;
    let lastLoggedAt = 0;
    const HEARTBEAT_MS = 60_000;

    function shouldLogMonitorSummary(
      checkedAddresses: number,
      eligibleTrades: number,
      recentTrades: number,
      totalSkipped: number,
      failedCount: number,
      currentTime: number,
    ): boolean {
      const summaryHashObj = {
        addrs: checkedAddresses,
        eligible: eligibleTrades,
        recent: recentTrades,
        skipped: totalSkipped,
        failed: failedCount,
      };
      const summaryHash = JSON.stringify(summaryHashObj);

      const heartbeatElapsed = currentTime - lastLoggedAt >= HEARTBEAT_MS;
      const hashChanged = summaryHash !== lastLoggedSummaryHash;
      const hasFailures = failedCount > 0;
      const hasEligibleTrades = eligibleTrades > 0;

      const shouldLog =
        hasFailures || hasEligibleTrades || hashChanged || heartbeatElapsed;

      if (shouldLog) {
        lastLoggedSummaryHash = summaryHash;
        lastLoggedAt = currentTime;
      }

      return shouldLog;
    }

    const baseTime = Date.now();

    // First log establishes baseline
    let result = shouldLogMonitorSummary(17, 0, 0, 1379, 0, baseTime);
    assert.strictEqual(result, true, "First log should happen");

    // Same stats immediately after - should NOT log
    result = shouldLogMonitorSummary(17, 0, 0, 1379, 0, baseTime + 1000);
    assert.strictEqual(result, false, "Duplicate should be suppressed");

    // BUT if there's a failure, it ALWAYS logs (safety requirement)
    result = shouldLogMonitorSummary(17, 0, 0, 1379, 1, baseTime + 2000);
    assert.strictEqual(result, true, "Failures must always log");

    // And if there are eligible trades, it ALWAYS logs (important event)
    result = shouldLogMonitorSummary(17, 1, 1, 1378, 0, baseTime + 3000);
    assert.strictEqual(result, true, "Eligible trades must always log");
  });
});

/**
 * Tests for cycle-aware log deduplication.
 * These tests verify that:
 * 1. Calling with the same cycleId produces at most 1 log
 * 2. Fingerprint changes within same cycle don't trigger multiple logs
 * 3. New cycles can trigger logs if fingerprint changed or heartbeat elapsed
 */
describe("Cycle-Aware Log Deduplication", () => {
  let logDeduper: LogDeduper;
  const logs: string[] = [];

  const mockLogger = {
    info: (msg: string) => logs.push(`[INFO] ${msg}`),
    debug: (msg: string) => logs.push(`[DEBUG] ${msg}`),
    warn: (msg: string) => logs.push(`[WARN] ${msg}`),
    error: (msg: string) => logs.push(`[ERROR] ${msg}`),
  };

  beforeEach(() => {
    logs.length = 0;
    logDeduper = new LogDeduper();
  });

  afterEach(() => {
    resetLogDeduper();
  });

  test("shouldLogForCycle: first call logs, subsequent calls in same cycle are suppressed", () => {
    // First call in cycle 1 - should log
    let result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(result, true, "First call in cycle should log");

    // Second call in same cycle - should be suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(
      result,
      false,
      "Second call in same cycle should be suppressed",
    );

    // Third call in same cycle - should be suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(
      result,
      false,
      "Third call in same cycle should be suppressed",
    );

    // Fourth call in same cycle with DIFFERENT fingerprint - should STILL be suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      "fingerprint2",
    );
    assert.strictEqual(
      result,
      false,
      "Fingerprint change in same cycle should still be suppressed",
    );
  });

  test("shouldLogForCycle: new cycle with unchanged fingerprint is suppressed until heartbeat", () => {
    // Cycle 1 - first log
    let result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(result, true, "First call logs");

    // Cycle 2 - same fingerprint, no heartbeat elapsed - should be suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      2,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(
      result,
      false,
      "Same fingerprint, no heartbeat - suppressed",
    );

    // Cycle 3 - same fingerprint, no heartbeat - suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      3,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(result, false, "Same fingerprint still suppressed");

    // Verify last cycleId is tracked
    assert.strictEqual(
      logDeduper.getLastCycleId("Monitor:detail"),
      3,
      "Last cycle ID should be 3",
    );
  });

  test("shouldLogForCycle: new cycle with changed fingerprint logs immediately", () => {
    // Cycle 1 - first log
    let result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      "fingerprint1",
    );
    assert.strictEqual(result, true, "First call logs");

    // Cycle 2 - different fingerprint - should log immediately
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      2,
      60_000,
      "fingerprint2",
    );
    assert.strictEqual(result, true, "Fingerprint changed - should log");

    // Cycle 3 - same as cycle 2 fingerprint - suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      3,
      60_000,
      "fingerprint2",
    );
    assert.strictEqual(
      result,
      false,
      "Same fingerprint as last log - suppressed",
    );

    // Cycle 4 - another fingerprint change - should log
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      4,
      60_000,
      "fingerprint3",
    );
    assert.strictEqual(result, true, "Another fingerprint change - should log");
  });

  test("Monitor detail log simulation: calling twice in same cycle produces 1 log max", () => {
    // Simulate Monitor's detail log behavior in a single orchestrator cycle
    for (let callNum = 1; callNum <= 5; callNum++) {
      const cycleId = 1; // Same cycle for all calls
      const fingerprint = `trades=100,skipped=50`;

      if (
        logDeduper.shouldLogForCycle(
          "Monitor:detail",
          cycleId,
          60_000,
          fingerprint,
        )
      ) {
        mockLogger.debug(
          `[Monitor] Detail: trades=100 skipped=50 (call ${callNum})`,
        );
      }
    }

    const detailLogs = logs.filter((l) => l.includes("[Monitor] Detail"));
    assert.strictEqual(
      detailLogs.length,
      1,
      "Should only log once per cycle despite 5 calls",
    );
  });

  test("PositionTracker refresh simulation: calling twice in same cycle produces 1 log max", () => {
    // Simulate PositionTracker's processed log behavior
    for (let callNum = 1; callNum <= 3; callNum++) {
      const cycleId = 1; // Same cycle
      const fingerprint = JSON.stringify({
        success: 10,
        resolved: 2,
        active: 8,
      });

      if (
        logDeduper.shouldLogForCycle(
          "Tracker:processed",
          cycleId,
          60_000,
          fingerprint,
        )
      ) {
        mockLogger.debug(
          `[PositionTracker] ✓ Processed 10 positions (call ${callNum})`,
        );
      }
    }

    const processedLogs = logs.filter((l) =>
      l.includes("[PositionTracker] ✓ Processed"),
    );
    assert.strictEqual(
      processedLogs.length,
      1,
      "Should only log once per cycle despite 3 calls",
    );
  });

  test("Repeated cycles with unchanged fingerprint do not log details every time", () => {
    const fingerprint = JSON.stringify({ trades: 100, skipped: 50 });

    // Simulate 10 orchestrator cycles with same fingerprint
    for (let cycleId = 1; cycleId <= 10; cycleId++) {
      if (
        logDeduper.shouldLogForCycle(
          "Monitor:detail",
          cycleId,
          60_000,
          fingerprint,
        )
      ) {
        mockLogger.debug(`[Monitor] Detail: (cycle ${cycleId})`);
      }
    }

    const detailLogs = logs.filter((l) => l.includes("[Monitor] Detail"));
    // Should only log on first cycle since fingerprint never changed and heartbeat didn't elapse
    assert.strictEqual(
      detailLogs.length,
      1,
      "Should only log once across 10 cycles with same fingerprint",
    );
    assert.ok(
      detailLogs[0].includes("cycle 1"),
      "First log should be from cycle 1",
    );
  });

  test("Heartbeat elapsed triggers log even with unchanged fingerprint", () => {
    const fingerprint = "unchanged_fingerprint";
    const shortHeartbeat = 100; // 100ms for testing

    // Cycle 1 - first log
    let result = logDeduper.shouldLogForCycle(
      "Test:heartbeat",
      1,
      shortHeartbeat,
      fingerprint,
    );
    assert.strictEqual(result, true, "First call logs");

    // Cycle 2 immediately - suppressed
    result = logDeduper.shouldLogForCycle(
      "Test:heartbeat",
      2,
      shortHeartbeat,
      fingerprint,
    );
    assert.strictEqual(result, false, "Immediate call suppressed");

    // Wait for heartbeat to elapse
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Cycle 3 after heartbeat - should log
        result = logDeduper.shouldLogForCycle(
          "Test:heartbeat",
          3,
          shortHeartbeat,
          fingerprint,
        );
        assert.strictEqual(result, true, "Heartbeat elapsed - should log");
        resolve();
      }, 150);
    });
  });

  test("Different keys are tracked independently for cycle-aware logging", () => {
    const fingerprint = "same_fingerprint";

    // Cycle 1 - log for Monitor
    let result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      fingerprint,
    );
    assert.strictEqual(result, true, "Monitor logs on cycle 1");

    // Cycle 1 - log for Tracker (separate key)
    result = logDeduper.shouldLogForCycle(
      "Tracker:processed",
      1,
      60_000,
      fingerprint,
    );
    assert.strictEqual(result, true, "Tracker also logs on cycle 1");

    // Cycle 1 - second call to Monitor - suppressed
    result = logDeduper.shouldLogForCycle(
      "Monitor:detail",
      1,
      60_000,
      fingerprint,
    );
    assert.strictEqual(
      result,
      false,
      "Monitor second call in cycle 1 suppressed",
    );

    // Cycle 1 - second call to Tracker - suppressed
    result = logDeduper.shouldLogForCycle(
      "Tracker:processed",
      1,
      60_000,
      fingerprint,
    );
    assert.strictEqual(
      result,
      false,
      "Tracker second call in cycle 1 suppressed",
    );
  });
});
