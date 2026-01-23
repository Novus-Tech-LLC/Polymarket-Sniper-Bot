import { test } from "node:test";
import assert from "node:assert/strict";
import { SmartHedgingStrategy, DEFAULT_SMART_HEDGING_CONFIG } from "../../src/strategies/smart-hedging";

// Mock logger that tracks messages
const createMockLogger = () => {
  const messages: string[] = [];
  return {
    info: (msg: string) => messages.push(`[INFO] ${msg}`),
    warn: (msg: string) => messages.push(`[WARN] ${msg}`),
    error: (msg: string) => messages.push(`[ERROR] ${msg}`),
    debug: (msg: string) => messages.push(`[DEBUG] ${msg}`),
    messages,
  };
};

// Mock position tracker
const mockPositionTracker = {
  getPositions: () => [],
  hasPosition: () => false,
} as any;

test("SmartHedgingStrategy auto-corrects maxHedgeUsd when absoluteMaxHedgeUsd is lower", () => {
  const mockLogger = createMockLogger();
  
  // Simulate user's config: aggressive preset (maxHedgeUsd=50) with absoluteMaxHedgeUsd=25
  const userConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    maxHedgeUsd: 50,  // From aggressive preset
    absoluteMaxHedgeUsd: 25,  // User's env override
  };

  // Should NOT throw - should auto-correct instead
  const strategy = new SmartHedgingStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: userConfig,
  });

  // Verify the config was auto-corrected via getStats()
  const stats = strategy.getStats();
  assert.equal(stats.maxHedgeUsd, 25, "maxHedgeUsd should be auto-corrected to absoluteMaxHedgeUsd");
  
  // Also verify via the logged message
  const autoAdjustMessage = mockLogger.messages.find(m => m.includes("Auto-adjusting maxHedgeUsd"));
  assert.ok(autoAdjustMessage, "Should log auto-adjustment message");
  assert.ok(autoAdjustMessage.includes("from $50 to $25"), "Should show correct values in message");
});

test("SmartHedgingStrategy does not auto-correct when absoluteMaxHedgeUsd is already >= maxHedgeUsd", () => {
  const mockLogger = createMockLogger();
  
  // Normal config where absoluteMaxHedgeUsd >= maxHedgeUsd
  const normalConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    maxHedgeUsd: 10,
    absoluteMaxHedgeUsd: 100,
  };

  new SmartHedgingStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: normalConfig,
  });

  // Should NOT log auto-adjustment message
  const autoAdjustMessage = mockLogger.messages.find(m => m.includes("Auto-adjusting maxHedgeUsd"));
  assert.equal(autoAdjustMessage, undefined, "Should NOT log auto-adjustment message when config is valid");
});

test("SmartHedgingStrategy auto-corrects minHedgeUsd when it exceeds auto-corrected maxHedgeUsd", () => {
  const mockLogger = createMockLogger();
  
  // Edge case: minHedgeUsd is valid against original maxHedgeUsd but exceeds absoluteMaxHedgeUsd
  const userConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    minHedgeUsd: 30,  // Valid against original maxHedgeUsd=50
    maxHedgeUsd: 50,  // From preset
    absoluteMaxHedgeUsd: 25,  // User's env override - lower than minHedgeUsd!
  };

  // Should NOT throw - should auto-correct both values
  const strategy = new SmartHedgingStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: userConfig,
  });

  // Verify both values were auto-corrected via getStats()
  const stats = strategy.getStats();
  assert.equal(stats.maxHedgeUsd, 25, "maxHedgeUsd should be auto-corrected to absoluteMaxHedgeUsd");
  
  // Verify log messages
  const maxAdjustMessage = mockLogger.messages.find(m => m.includes("Auto-adjusting maxHedgeUsd"));
  const minAdjustMessage = mockLogger.messages.find(m => m.includes("Auto-adjusting minHedgeUsd"));
  
  assert.ok(maxAdjustMessage, "Should log maxHedgeUsd auto-adjustment message");
  assert.ok(maxAdjustMessage.includes("from $50 to $25"), "Should show correct maxHedgeUsd values");
  
  assert.ok(minAdjustMessage, "Should log minHedgeUsd auto-adjustment message");
  assert.ok(minAdjustMessage.includes("from $30 to $25"), "Should show correct minHedgeUsd values");
});

test("SmartHedgingStrategy throws error when absoluteMaxHedgeUsd is negative or zero", () => {
  const mockLogger = createMockLogger();
  
  // Invalid config with negative absoluteMaxHedgeUsd
  const invalidConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    maxHedgeUsd: 10,
    absoluteMaxHedgeUsd: -1,  // Invalid: negative value
  };

  // Should throw error for negative absoluteMaxHedgeUsd
  assert.throws(
    () => new SmartHedgingStrategy({
      client: {} as any,
      logger: mockLogger as any,
      positionTracker: mockPositionTracker,
      config: invalidConfig,
    }),
    /absoluteMaxHedgeUsd must be > 0/,
    "Should throw error for negative absoluteMaxHedgeUsd"
  );

  // Also test with zero
  const zeroConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    maxHedgeUsd: 10,
    absoluteMaxHedgeUsd: 0,  // Invalid: zero value
  };

  assert.throws(
    () => new SmartHedgingStrategy({
      client: {} as any,
      logger: mockLogger as any,
      positionTracker: mockPositionTracker,
      config: zeroConfig,
    }),
    /absoluteMaxHedgeUsd must be > 0/,
    "Should throw error for zero absoluteMaxHedgeUsd"
  );
});
