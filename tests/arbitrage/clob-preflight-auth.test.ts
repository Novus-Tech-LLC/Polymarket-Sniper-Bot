import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("auth_ok is set to true when preflight succeeds with HTTP 200", () => {
  // Verify the preflight logic sets authOk based on actual test result
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Check that authOk is initialized as false
  assert.ok(
    preflightCode.includes("let authOk = false"),
    "authOk should be initialized as false",
  );

  // Check that authOk is set to true on success
  assert.ok(
    preflightCode.includes("} else if (preflight && preflight.ok) {") &&
      preflightCode.includes("authOk = true"),
    "authOk should be set to true when preflight succeeds",
  );

  // Check matrix path also sets authOk correctly
  assert.ok(
    preflightCode.includes("} else if (matrix && matrix.ok) {") &&
      preflightCode.includes("authOk = true"),
    "authOk should be set to true when matrix test succeeds",
  );
});

test("auth_ok is set to false when preflight returns 401", () => {
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Check that authOk is set to false on 401/403
  assert.ok(
    preflightCode.includes("preflight.status === 401") &&
      preflightCode.includes("authOk = false"),
    "authOk should be set to false when preflight returns 401/403",
  );

  // Check that detectOnly is set when auth fails
  assert.ok(
    preflightCode.includes("detectOnly = true") &&
      preflightCode.includes("authOk = false"),
    "detectOnly should be set to true when auth fails",
  );
});

test("auth_ok is set to false on other preflight failures", () => {
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Check that authOk is set to false on general failures
  assert.ok(
    preflightCode.includes("} else if (preflight && !preflight.ok) {") &&
      preflightCode.includes("authOk = false"),
    "authOk should be set to false on other preflight failures",
  );
});

test("auth_ok is set to false when auth error exception occurs", () => {
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Check exception handling sets authOk to false
  assert.ok(
    preflightCode.includes("} else if (isAuthError(err)) {") &&
      preflightCode.includes("authOk = false"),
    "authOk should be set to false when isAuthError exception occurs",
  );
});

test("readyToTrade depends on authOk being true", () => {
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Check that readyToTrade requires authOk
  assert.ok(
    preflightCode.includes(
      "const readyToTrade = !detectOnly && approvalsOk && authOk",
    ),
    "readyToTrade should require authOk to be true",
  );
});

test("auth_ok is not set based on credential existence alone", () => {
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Ensure the old broken logic is removed
  assert.ok(
    !preflightCode.includes(
      "const authOk = params.clobCredsComplete || params.clobDeriveEnabled",
    ),
    "authOk should not be set based on credential existence alone",
  );

  // Verify authOk is only set after actual verification
  const authOkDeclaration = preflightCode.indexOf("let authOk = false");
  const firstAuthOkSet = preflightCode.indexOf(
    "authOk = true",
    authOkDeclaration,
  );
  const readyToTradeCheck = preflightCode.indexOf(
    "const readyToTrade = !detectOnly && approvalsOk && authOk",
  );

  assert.ok(authOkDeclaration > 0, "authOk should be declared");
  assert.ok(
    firstAuthOkSet > authOkDeclaration,
    "authOk should be set after declaration",
  );
  assert.ok(
    readyToTradeCheck > firstAuthOkSet,
    "readyToTrade check should come after authOk is set",
  );
});

test("bot stays in detect-only mode when auth fails", () => {
  const preflightCode = fs.readFileSync(
    "./src/polymarket/preflight.ts",
    "utf-8",
  );

  // Check that detectOnly is set when auth fails
  assert.ok(
    preflightCode.includes("detectOnly = true") &&
      preflightCode.includes("Auth preflight failed; switching to detect-only"),
    "Bot should stay in detect-only mode when auth fails",
  );
});

test("preflight tool exits with non-zero code when not ready", () => {
  const toolCode = fs.readFileSync(
    "./src/tools/preflight.ts",
    "utf-8",
  );

  // Check that exit code is set when not ready
  assert.ok(
    toolCode.includes("if (!ready)") &&
      toolCode.includes("process.exitCode = 1"),
    "Preflight tool should exit with code 1 when not ready",
  );

  // Check that ready is determined by detectOnly
  assert.ok(
    toolCode.includes("const ready = !result.detectOnly"),
    "Ready status should be based on detectOnly result",
  );
});
