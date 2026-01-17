import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPreflightIssue } from "../../src/clob/diagnostics";

test("classifyPreflightIssue distinguishes auth errors", () => {
  assert.equal(
    classifyPreflightIssue({ status: 401, message: "unauthorized" }),
    "AUTH",
  );
});

test("classifyPreflightIssue distinguishes invalid asset type", () => {
  assert.equal(
    classifyPreflightIssue({ status: 400, message: "Invalid asset type" }),
    "PARAM",
  );
});

test("classifyPreflightIssue distinguishes insufficient balance/allowance", () => {
  assert.equal(
    classifyPreflightIssue({ status: 400, message: "not enough balance" }),
    "FUNDS",
  );
});

test("classifyPreflightIssue distinguishes network errors", () => {
  assert.equal(
    classifyPreflightIssue({ code: "ECONNRESET", message: "socket hang up" }),
    "NETWORK",
  );
});
