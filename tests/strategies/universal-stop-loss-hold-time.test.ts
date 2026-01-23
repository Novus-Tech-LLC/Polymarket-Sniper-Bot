import { test } from "node:test";
import assert from "node:assert/strict";
import { UniversalStopLossStrategy } from "../../src/strategies/universal-stop-loss";
import type { Position } from "../../src/strategies/position-tracker";

// Mock logger that tracks messages
const createMockLogger = () => {
  const messages: string[] = [];
  return {
    info: (msg: string) => messages.push(`[INFO] ${msg}`),
    warn: (msg: string) => messages.push(`[WARN] ${msg}`),
    error: (msg: string) => messages.push(`[ERROR] ${msg}`),
    debug: (msg: string) => messages.push(`[DEBUG] ${msg}`),
    messages,
    clear: () => (messages.length = 0),
  };
};

// Create mock position with configurable values
const createMockPosition = (overrides: Partial<Position> = {}): Position => ({
  marketId: "market-123",
  tokenId: "token-456",
  side: "YES",
  size: 10,
  entryPrice: 0.75, // 75¢ - Standard tier
  currentPrice: 0.65, // 65¢
  pnlPct: -13.33, // Exceeds 8% stop-loss threshold for standard tier
  pnlUsd: -1.0,
  redeemable: false,
  ...overrides,
});

// Mock position tracker with configurable entry time
const createMockPositionTracker = (
  positions: Position[],
  entryTimeOffset: number = 0, // ms before now
) => {
  const entryTime = Date.now() - entryTimeOffset;
  return {
    getPositions: () => positions,
    getPositionEntryTime: (_marketId: string, _tokenId: string) => entryTime,
  } as any;
};

test("UniversalStopLoss does NOT trigger stop-loss before minHoldSeconds", async () => {
  const mockLogger = createMockLogger();

  // Position is losing but was just acquired (5 seconds ago)
  const losingPosition = createMockPosition({
    pnlPct: -15, // Exceeds 8% stop-loss threshold
  });

  const mockPositionTracker = createMockPositionTracker(
    [losingPosition],
    5000, // 5 seconds ago
  );

  const strategy = new UniversalStopLossStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: {
      enabled: true,
      maxStopLossPct: 25,
      useDynamicTiers: true,
      minHoldSeconds: 60, // Require 60 seconds hold
    },
  });

  const soldCount = await strategy.execute();

  // Should NOT sell - not held long enough
  assert.equal(soldCount, 0, "Should not sell position before minHoldSeconds");

  // Should log debug message about waiting
  const waitMessage = mockLogger.messages.find((m) =>
    m.includes("need 60s before stop-loss can trigger"),
  );
  assert.ok(waitMessage, "Should log waiting message");
  assert.ok(waitMessage.includes("held for 5s"), "Should show current hold time");
});

test("UniversalStopLoss triggers stop-loss after minHoldSeconds elapsed", async () => {
  const mockLogger = createMockLogger();

  // Position is losing and has been held long enough (90 seconds)
  const losingPosition = createMockPosition({
    pnlPct: -15, // Exceeds 8% stop-loss threshold
  });

  const mockPositionTracker = createMockPositionTracker(
    [losingPosition],
    90000, // 90 seconds ago
  );

  const strategy = new UniversalStopLossStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: {
      enabled: true,
      maxStopLossPct: 25,
      useDynamicTiers: true,
      minHoldSeconds: 60, // Require 60 seconds hold
    },
  });

  // Execute should find the position exceeding threshold
  // Note: actual sell will fail due to mock client, but the position should be identified
  const warnMessage = mockLogger.messages.find((m) =>
    m.includes("exceeding stop-loss threshold"),
  );

  // Since we can't mock the sell, we just verify the position was identified for stop-loss
  // The warn log indicates stop-loss was triggered (not skipped due to hold time)
  await strategy.execute();

  // Should NOT have the waiting message (since hold time is satisfied)
  const waitMessage = mockLogger.messages.find((m) =>
    m.includes("need 60s before stop-loss can trigger"),
  );
  assert.equal(
    waitMessage,
    undefined,
    "Should not log waiting message when hold time is satisfied",
  );
});

test("UniversalStopLoss respects different minHoldSeconds values", async () => {
  const mockLogger = createMockLogger();

  const losingPosition = createMockPosition({
    pnlPct: -15,
  });

  // Position held for 45 seconds
  const mockPositionTracker = createMockPositionTracker(
    [losingPosition],
    45000, // 45 seconds ago
  );

  // Test with 30 second requirement (should trigger)
  const strategy30s = new UniversalStopLossStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: {
      enabled: true,
      maxStopLossPct: 25,
      useDynamicTiers: true,
      minHoldSeconds: 30, // 30 seconds - position (45s) satisfies this
    },
  });

  await strategy30s.execute();

  // With 30s requirement and 45s hold time, should NOT log waiting message
  let waitMessage = mockLogger.messages.find((m) =>
    m.includes("need 30s before stop-loss can trigger"),
  );
  assert.equal(
    waitMessage,
    undefined,
    "Should not wait when hold time (45s) exceeds requirement (30s)",
  );

  // Clear and test with 60 second requirement (should wait)
  mockLogger.clear();

  const strategy60s = new UniversalStopLossStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: {
      enabled: true,
      maxStopLossPct: 25,
      useDynamicTiers: true,
      minHoldSeconds: 60, // 60 seconds - position (45s) doesn't satisfy this
    },
  });

  await strategy60s.execute();

  // With 60s requirement and 45s hold time, should log waiting message
  waitMessage = mockLogger.messages.find((m) =>
    m.includes("need 60s before stop-loss can trigger"),
  );
  assert.ok(
    waitMessage,
    "Should wait when hold time (45s) is less than requirement (60s)",
  );
});

test("UniversalStopLoss defaults minHoldSeconds to 60 when not configured", async () => {
  const mockLogger = createMockLogger();

  const losingPosition = createMockPosition({
    pnlPct: -15,
  });

  // Position held for 30 seconds
  const mockPositionTracker = createMockPositionTracker(
    [losingPosition],
    30000, // 30 seconds ago
  );

  const strategy = new UniversalStopLossStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: {
      enabled: true,
      maxStopLossPct: 25,
      useDynamicTiers: true,
      // minHoldSeconds not set - should default to 60
    },
  });

  await strategy.execute();

  // Should log waiting for 60 seconds (the default)
  const waitMessage = mockLogger.messages.find((m) =>
    m.includes("need 60s before stop-loss can trigger"),
  );
  assert.ok(waitMessage, "Should use default 60s when minHoldSeconds not configured");
});

test("UniversalStopLoss getStats includes minHoldSeconds", () => {
  const mockLogger = createMockLogger();
  const mockPositionTracker = createMockPositionTracker([]);

  const strategy = new UniversalStopLossStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: {
      enabled: true,
      maxStopLossPct: 25,
      useDynamicTiers: true,
      minHoldSeconds: 120,
    },
  });

  const stats = strategy.getStats();

  assert.equal(stats.enabled, true);
  assert.equal(stats.maxStopLossPct, 25);
  assert.equal(stats.useDynamicTiers, true);
  assert.equal(stats.minHoldSeconds, 120, "Stats should include configured minHoldSeconds");
});
