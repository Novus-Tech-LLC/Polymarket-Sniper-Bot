import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignedPath } from "../../src/utils/query-string.util";

test("buildSignedPath includes query string exactly as sent", () => {
  const { signedPath } = buildSignedPath("/balance-allowance", {
    asset_type: "COLLATERAL",
    token_id: "123",
  });
  assert.equal(
    signedPath,
    "/balance-allowance?asset_type=COLLATERAL&token_id=123",
  );
});
