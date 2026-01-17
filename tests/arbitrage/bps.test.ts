import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateEdgeBps,
  estimateProfitUsd,
} from "../../src/arbitrage/utils/bps";

test("calculateEdgeBps returns expected bps", () => {
  assert.equal(calculateEdgeBps(0.55, 0.55), 1000);
});

test("estimateProfitUsd accounts for fees and slippage", () => {
  const profit = estimateProfitUsd({
    sizeUsd: 10,
    edgeBps: 500,
    feeBps: 10,
    slippageBps: 20,
  });
  assert.ok(profit < 10 * 0.05);
});
