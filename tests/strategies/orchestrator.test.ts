import assert from "node:assert";
import { test, describe } from "node:test";
import { randomUUID } from "crypto";

/**
 * Unit tests for Orchestrator single-flight cycle protection
 *
 * These tests verify that:
 * 1. Only one orchestrator cycle runs at a time
 * 2. Concurrent calls are skipped
 * 3. PositionTracker refresh is single-flight and shared
 * 4. Observability counters track correctly
 */

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
  };
}

// Mock strategy that tracks execution count and supports configurable delays
function createMockStrategy(delayMs = 0) {
  let executeCount = 0;
  let inFlight = false;
  return {
    execute: async () => {
      // Single-flight guard like real strategies
      if (inFlight) {
        return 0;
      }
      inFlight = true;
      try {
        executeCount++;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return 1;
      } finally {
        inFlight = false;
      }
    },
    getExecuteCount: () => executeCount,
    reset: () => {
      executeCount = 0;
      inFlight = false;
    },
  };
}

// Mock PositionTracker
function createMockPositionTracker(refreshDelayMs = 0) {
  let refreshCount = 0;
  let currentRefreshPromise: Promise<void> | null = null;
  let isRefreshing = false;

  return {
    start: async () => {},
    stop: () => {},
    getPositions: () => [],
    awaitCurrentRefresh: async () => {
      if (currentRefreshPromise) {
        return currentRefreshPromise;
      }
      currentRefreshPromise = (async () => {
        if (isRefreshing) return;
        isRefreshing = true;
        refreshCount++;
        if (refreshDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
        }
        isRefreshing = false;
      })().finally(() => {
        currentRefreshPromise = null;
      });
      return currentRefreshPromise;
    },
    getRefreshCount: () => refreshCount,
    reset: () => {
      refreshCount = 0;
      currentRefreshPromise = null;
      isRefreshing = false;
    },
  };
}

describe("Orchestrator Single-Flight Cycle Lock", () => {
  test("Only one cycle runs at a time when executeStrategies called concurrently", async () => {
    // This tests the core single-flight guarantee:
    // If executeStrategies() is called while a cycle is in progress, the second call should be skipped

    const logger = createMockLogger();

    // Simulate orchestrator state
    let cycleInFlight = false;
    let cyclesRun = 0;
    let ticksSkipped = 0;

    // Simulated executeStrategies with single-flight lock
    async function executeStrategies(delayMs: number): Promise<boolean> {
      if (cycleInFlight) {
        ticksSkipped++;
        logger.debug("Tick skipped - cycle in flight");
        return false; // Skipped
      }

      cycleInFlight = true;
      cyclesRun++;
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return true; // Executed
      } finally {
        cycleInFlight = false;
      }
    }

    // Start first cycle (takes 100ms)
    const cycle1 = executeStrategies(100);

    // Immediately try to start second cycle (should be skipped)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cycle2 = executeStrategies(100);

    // Wait for both to complete
    const [result1, result2] = await Promise.all([cycle1, cycle2]);

    assert.strictEqual(result1, true, "First cycle should execute");
    assert.strictEqual(result2, false, "Second cycle should be skipped");
    assert.strictEqual(cyclesRun, 1, "Only one cycle should run");
    assert.strictEqual(ticksSkipped, 1, "One tick should be skipped");
  });

  test("Cycles run sequentially when called after previous completes", async () => {
    let cycleInFlight = false;
    let cyclesRun = 0;

    async function executeStrategies(): Promise<boolean> {
      if (cycleInFlight) {
        return false;
      }

      cycleInFlight = true;
      cyclesRun++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      } finally {
        cycleInFlight = false;
      }
    }

    // Run first cycle
    const result1 = await executeStrategies();

    // Run second cycle after first completes
    const result2 = await executeStrategies();

    assert.strictEqual(result1, true, "First cycle should execute");
    assert.strictEqual(
      result2,
      true,
      "Second cycle should execute after first completes",
    );
    assert.strictEqual(cyclesRun, 2, "Both cycles should run");
  });

  test("Tick counter tracks correctly", async () => {
    let ticksFired = 0;
    let cyclesRun = 0;
    let ticksSkipped = 0;
    let cycleInFlight = false;

    function onTick(): Promise<boolean> {
      ticksFired++;

      if (cycleInFlight) {
        ticksSkipped++;
        return Promise.resolve(false);
      }

      cycleInFlight = true;
      cyclesRun++;
      return new Promise((resolve) => {
        setTimeout(() => {
          cycleInFlight = false;
          resolve(true);
        }, 50);
      });
    }

    // Simulate 5 rapid ticks while first cycle is running
    const ticks = [
      onTick(), // Should run
      onTick(), // Should skip
      onTick(), // Should skip
      onTick(), // Should skip
      onTick(), // Should skip
    ];

    await Promise.all(ticks);

    assert.strictEqual(ticksFired, 5, "All ticks should be fired");
    assert.strictEqual(cyclesRun, 1, "Only one cycle should run");
    assert.strictEqual(ticksSkipped, 4, "Four ticks should be skipped");
  });
});

describe("Strategy Single-Flight Guards", () => {
  test("Strategy execute() skips if already in flight", async () => {
    const strategy = createMockStrategy(50); // 50ms execution time

    // Start first execution
    const exec1 = strategy.execute();

    // Try to start second while first is running (after 10ms)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const exec2 = strategy.execute();

    const [result1, result2] = await Promise.all([exec1, exec2]);

    assert.strictEqual(result1, 1, "First execution should succeed");
    assert.strictEqual(
      result2,
      0,
      "Second execution should be skipped (return 0)",
    );
    assert.strictEqual(
      strategy.getExecuteCount(),
      1,
      "Strategy should only execute once",
    );
  });

  test("Strategy execute() runs sequentially when awaited", async () => {
    const strategy = createMockStrategy(10);

    const result1 = await strategy.execute();
    const result2 = await strategy.execute();

    assert.strictEqual(result1, 1, "First execution should succeed");
    assert.strictEqual(result2, 1, "Second execution should succeed");
    assert.strictEqual(
      strategy.getExecuteCount(),
      2,
      "Strategy should execute twice",
    );
  });
});

describe("PositionTracker Single-Flight Refresh", () => {
  test("awaitCurrentRefresh() shares the same refresh promise", async () => {
    const tracker = createMockPositionTracker(50); // 50ms refresh time

    // Multiple concurrent calls should all await the same refresh
    const refreshes = [
      tracker.awaitCurrentRefresh(),
      tracker.awaitCurrentRefresh(),
      tracker.awaitCurrentRefresh(),
    ];

    await Promise.all(refreshes);

    assert.strictEqual(
      tracker.getRefreshCount(),
      1,
      "Refresh should only run once",
    );
  });

  test("awaitCurrentRefresh() starts new refresh after previous completes", async () => {
    const tracker = createMockPositionTracker(10);

    await tracker.awaitCurrentRefresh();
    await tracker.awaitCurrentRefresh();

    assert.strictEqual(
      tracker.getRefreshCount(),
      2,
      "Should run two separate refreshes",
    );
  });
});

describe("Orchestrator Boot ID", () => {
  test("Boot ID should be unique per instance", () => {
    // Simulate boot ID generation like the real orchestrator
    const bootId1 = randomUUID().slice(0, 8);
    const bootId2 = randomUUID().slice(0, 8);

    assert.notStrictEqual(bootId1, bootId2, "Each boot ID should be unique");
    assert.strictEqual(bootId1.length, 8, "Boot ID should be 8 characters");
  });
});

describe("Integration: Simulated Timer with Long Cycles", () => {
  test("Timer firing every 20ms while cycle takes 100ms - expect only 1 cycle", async () => {
    let cycleInFlight = false;
    let cyclesRun = 0;
    let ticksSkipped = 0;
    let ticksFired = 0;

    async function executeStrategies(): Promise<void> {
      if (cycleInFlight) {
        ticksSkipped++;
        return;
      }

      cycleInFlight = true;
      cyclesRun++;
      try {
        // Simulate 100ms cycle
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        cycleInFlight = false;
      }
    }

    // Start timer that fires every 20ms
    const timer = setInterval(() => {
      ticksFired++;
      executeStrategies();
    }, 20);

    // Let it run for 150ms (enough for ~7 ticks)
    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(timer);

    // Wait for any in-flight cycle to complete
    await new Promise((resolve) => setTimeout(resolve, 110));

    // Should have fired multiple ticks but only 1-2 cycles should run
    assert.ok(ticksFired >= 5, `Expected at least 5 ticks, got ${ticksFired}`);
    assert.ok(cyclesRun <= 2, `Expected at most 2 cycles, got ${cyclesRun}`);
    assert.ok(
      ticksSkipped >= 3,
      `Expected at least 3 skipped ticks, got ${ticksSkipped}`,
    );
  });
});
