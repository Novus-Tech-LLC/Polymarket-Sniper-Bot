import assert from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";
import {
  LogDeduper,
  SkipReasonAggregator,
  resetLogDeduper,
  getLogDeduper,
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
      mockLogger.debug(`[SmartHedging] Cycle 1: ${skipAggregator.getSummary()}`);
    }

    // Cycle 2: Same positions - should NOT log
    skipAggregator = new SkipReasonAggregator();
    skipAggregator.add("token1", "redeemable");
    skipAggregator.add("token2", "redeemable");
    skipAggregator.add("token3", "loss_below_trigger");

    fingerprint = skipAggregator.getFingerprint();
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug(`[SmartHedging] Cycle 2: ${skipAggregator.getSummary()}`);
    }

    // Cycle 3: One more position redeemable - fingerprint changes, SHOULD log
    skipAggregator = new SkipReasonAggregator();
    skipAggregator.add("token1", "redeemable");
    skipAggregator.add("token2", "redeemable");
    skipAggregator.add("token3", "redeemable"); // CHANGED from loss_below_trigger
    skipAggregator.add("token4", "loss_below_trigger");

    fingerprint = skipAggregator.getFingerprint();
    if (logDeduper.shouldLogSummary("Hedging", fingerprint)) {
      mockLogger.debug(`[SmartHedging] Cycle 3: ${skipAggregator.getSummary()}`);
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
        mockLogger.debug("[PositionTracker] Refresh already in progress, skipping");
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

      if (logDeduper.shouldLog(`Monitor:summary:${trader}`, HEARTBEAT_INTERVAL_MS, summaryFingerprint)) {
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

      if (logDeduper.shouldLog("Orchestrator:slow_strategies", HEARTBEAT_INTERVAL_MS, slowNamesFingerprint)) {
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
});
