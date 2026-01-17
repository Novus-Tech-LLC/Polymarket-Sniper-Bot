import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSizeUsd } from "../../src/arbitrage/utils/sizing";

test("computeSizeUsd respects caps and scaling", () => {
  const result = computeSizeUsd({
    baseUsd: 5,
    edgeBps: 500,
    mode: "linear",
    maxPositionUsd: 10,
    maxWalletExposureUsd: 12,
    currentMarketExposureUsd: 6,
    currentWalletExposureUsd: 3,
  });
  assert.equal(result.sizeUsd, 4);
  assert.equal(result.sizeTier, 1);
});
