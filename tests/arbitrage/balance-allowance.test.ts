import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetType } from "@polymarket/clob-client";
import { buildBalanceAllowanceParams } from "../../src/utils/funds-allowance.util";

test("buildBalanceAllowanceParams uses asset_type=COLLATERAL without token_id", () => {
  const params = buildBalanceAllowanceParams(AssetType.COLLATERAL, "123");
  assert.equal(params.asset_type, AssetType.COLLATERAL);
  assert.equal(params.token_id, undefined);
});

test("buildBalanceAllowanceParams uses asset_type=CONDITIONAL with token_id", () => {
  const params = buildBalanceAllowanceParams(AssetType.CONDITIONAL, "456");
  assert.equal(params.asset_type, AssetType.CONDITIONAL);
  assert.equal(params.token_id, "456");
});
