import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthMessageString } from "../../src/clob/diagnostics";

test("buildAuthMessageString concatenates timestamp, method, path, and body", () => {
  const message = buildAuthMessageString({
    timestamp: 1700000000,
    method: "GET",
    path: "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  });
  assert.equal(
    message,
    "1700000000GET/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  );
});

test("buildAuthMessageString appends body when provided", () => {
  const message = buildAuthMessageString({
    timestamp: 1700000001,
    method: "POST",
    path: "/orders",
    body: '{"foo":"bar"}',
  });
  assert.equal(message, '1700000001POST/orders{"foo":"bar"}');
});
