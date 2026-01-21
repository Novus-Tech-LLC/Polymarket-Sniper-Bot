import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPreflightIssue,
  classifyPreflightSeverity,
} from "../../src/clob/diagnostics";

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
  assert.equal(
    classifyPreflightIssue({ status: 429, message: "Too Many Requests" }),
    "NETWORK",
  );
});

test("classifyPreflightSeverity marks 401/403 as FATAL", () => {
  assert.equal(
    classifyPreflightSeverity({ status: 401, issue: "AUTH", code: null }),
    "FATAL",
  );
  assert.equal(
    classifyPreflightSeverity({ status: 403, issue: "AUTH", code: null }),
    "FATAL",
  );
});

test("classifyPreflightSeverity marks network errors as TRANSIENT", () => {
  assert.equal(
    classifyPreflightSeverity({
      status: undefined,
      issue: "NETWORK",
      code: "ECONNRESET",
    }),
    "TRANSIENT",
  );
  assert.equal(
    classifyPreflightSeverity({
      status: undefined,
      issue: "NETWORK",
      code: "ETIMEDOUT",
    }),
    "TRANSIENT",
  );
  assert.equal(
    classifyPreflightSeverity({
      status: 429,
      issue: "NETWORK",
      code: null,
    }),
    "TRANSIENT",
  );
});

test("classifyPreflightSeverity marks 500+ errors as TRANSIENT", () => {
  assert.equal(
    classifyPreflightSeverity({ status: 500, issue: "UNKNOWN", code: null }),
    "TRANSIENT",
  );
  assert.equal(
    classifyPreflightSeverity({ status: 502, issue: "UNKNOWN", code: null }),
    "TRANSIENT",
  );
  assert.equal(
    classifyPreflightSeverity({ status: 503, issue: "UNKNOWN", code: null }),
    "TRANSIENT",
  );
});

test("classifyPreflightSeverity marks 429 rate limit as TRANSIENT", () => {
  assert.equal(
    classifyPreflightSeverity({ status: 429, issue: "UNKNOWN", code: null }),
    "TRANSIENT",
  );
});

test("classifyPreflightSeverity marks param/funds/unknown errors as NON_FATAL", () => {
  assert.equal(
    classifyPreflightSeverity({ status: 400, issue: "PARAM", code: null }),
    "NON_FATAL",
  );
  assert.equal(
    classifyPreflightSeverity({ status: 400, issue: "FUNDS", code: null }),
    "NON_FATAL",
  );
  assert.equal(
    classifyPreflightSeverity({ status: undefined, issue: "UNKNOWN", code: null }),
    "NON_FATAL",
  );
});

test("classifyPreflightSeverity marks unknown status codes as NON_FATAL", () => {
  assert.equal(
    classifyPreflightSeverity({ status: 418, issue: "UNKNOWN", code: null }),
    "NON_FATAL",
  );
});

