import { test } from "node:test";
import assert from "node:assert/strict";
import { isLiveTradingEnabled } from "../../src/utils/live-trading.util";

test("isLiveTradingEnabled returns false when no env vars set", () => {
  // Save original values
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;
  const originalArbLiveTradingLower = process.env.arb_live_trading;
  const originalLiveTradingLower = process.env.live_trading;

  try {
    // Clear all env vars
    delete process.env.ARB_LIVE_TRADING;
    delete process.env.LIVE_TRADING;
    delete process.env.arb_live_trading;
    delete process.env.live_trading;

    const result = isLiveTradingEnabled();
    assert.equal(result, false);
  } finally {
    // Restore original values
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    if (originalArbLiveTradingLower !== undefined)
      process.env.arb_live_trading = originalArbLiveTradingLower;
    if (originalLiveTradingLower !== undefined)
      process.env.live_trading = originalLiveTradingLower;
  }
});

test("isLiveTradingEnabled returns true when ARB_LIVE_TRADING is set correctly", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    delete process.env.LIVE_TRADING;
    process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    else delete process.env.ARB_LIVE_TRADING;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
  }
});

test("isLiveTradingEnabled returns true when LIVE_TRADING is set correctly", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    delete process.env.ARB_LIVE_TRADING;
    process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    else delete process.env.LIVE_TRADING;
  }
});

test("isLiveTradingEnabled returns true when arb_live_trading (lowercase) is set correctly", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalArbLiveTradingLower = process.env.arb_live_trading;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    delete process.env.ARB_LIVE_TRADING;
    delete process.env.LIVE_TRADING;
    process.env.arb_live_trading = "I_UNDERSTAND_THE_RISKS";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    if (originalArbLiveTradingLower !== undefined)
      process.env.arb_live_trading = originalArbLiveTradingLower;
    else delete process.env.arb_live_trading;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
  }
});

test("isLiveTradingEnabled returns true when live_trading (lowercase) is set correctly", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;
  const originalLiveTradingLower = process.env.live_trading;

  try {
    delete process.env.ARB_LIVE_TRADING;
    delete process.env.LIVE_TRADING;
    process.env.live_trading = "I_UNDERSTAND_THE_RISKS";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    if (originalLiveTradingLower !== undefined)
      process.env.live_trading = originalLiveTradingLower;
    else delete process.env.live_trading;
  }
});

test("isLiveTradingEnabled returns false when ARB_LIVE_TRADING has wrong value", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    delete process.env.LIVE_TRADING;
    process.env.ARB_LIVE_TRADING = "true";

    const result = isLiveTradingEnabled();
    assert.equal(result, false);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    else delete process.env.ARB_LIVE_TRADING;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
  }
});

test("isLiveTradingEnabled returns false when LIVE_TRADING has wrong value", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    delete process.env.ARB_LIVE_TRADING;
    process.env.LIVE_TRADING = "yes";

    const result = isLiveTradingEnabled();
    assert.equal(result, false);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    else delete process.env.LIVE_TRADING;
  }
});

test("isLiveTradingEnabled returns true when both ARB_LIVE_TRADING and LIVE_TRADING are set correctly (OR logic)", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    else delete process.env.ARB_LIVE_TRADING;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    else delete process.env.LIVE_TRADING;
  }
});

test("isLiveTradingEnabled returns true when ARB_LIVE_TRADING is correct but LIVE_TRADING is wrong", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
    process.env.LIVE_TRADING = "wrong_value";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    else delete process.env.ARB_LIVE_TRADING;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    else delete process.env.LIVE_TRADING;
  }
});

test("isLiveTradingEnabled returns true when LIVE_TRADING is correct but ARB_LIVE_TRADING is wrong", () => {
  const originalArbLiveTrading = process.env.ARB_LIVE_TRADING;
  const originalLiveTrading = process.env.LIVE_TRADING;

  try {
    process.env.ARB_LIVE_TRADING = "wrong_value";
    process.env.LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

    const result = isLiveTradingEnabled();
    assert.equal(result, true);
  } finally {
    if (originalArbLiveTrading !== undefined)
      process.env.ARB_LIVE_TRADING = originalArbLiveTrading;
    else delete process.env.ARB_LIVE_TRADING;
    if (originalLiveTrading !== undefined)
      process.env.LIVE_TRADING = originalLiveTrading;
    else delete process.env.LIVE_TRADING;
  }
});
