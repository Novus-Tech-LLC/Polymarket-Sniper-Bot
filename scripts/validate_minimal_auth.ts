#!/usr/bin/env ts-node

/**
 * Quick Validation Test for Minimal Auth
 *
 * This script validates that the minimal auth module:
 * 1. Exports the expected functions
 * 2. Has the correct Auth Story structure
 * 3. Returns proper error messages without PRIVATE_KEY
 * 4. Has no syntax errors
 */

import {
  authenticateMinimal,
  printAuthStory,
  createMinimalAuthConfigFromEnv,
  type AuthStory,
  type MinimalAuthResult,
  type MinimalAuthConfig,
} from "../src/clob/minimal-auth";

console.log("=".repeat(60));
console.log("MINIMAL AUTH VALIDATION TEST");
console.log("=".repeat(60) + "\n");

let passed = 0;
let failed = 0;

/**
 * Test function that properly handles both sync and async tests
 */
async function test(
  name: string,
  fn: () => boolean | Promise<boolean>,
): Promise<void> {
  try {
    const result = await fn();
    if (result) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ ${name} - Error: ${(error as Error).message}`);
    failed++;
  }
}

/**
 * Main test runner
 */
async function runTests(): Promise<void> {
  // Test 1: Module exports
  await test("Module exports authenticateMinimal function", () => {
    return typeof authenticateMinimal === "function";
  });

  await test("Module exports printAuthStory function", () => {
    return typeof printAuthStory === "function";
  });

  await test("Module exports createMinimalAuthConfigFromEnv function", () => {
    return typeof createMinimalAuthConfigFromEnv === "function";
  });

  // Test 2: Auth Story structure
  await test("Auth Story has required fields", async () => {
    const result = await authenticateMinimal({
      privateKey: "", // Empty to trigger error
      logLevel: "error", // Suppress logs
    });

    const story = result.story;
    const requiredFields = [
      "runId",
      "timestamp",
      "success",
      "signerAddress",
      "credentialsObtained",
      "verificationPassed",
      "durationMs",
    ];

    for (const field of requiredFields) {
      if (!(field in story)) {
        console.log(`   Missing field: ${field}`);
        return false;
      }
    }

    return true;
  });

  // Test 3: Error handling without PRIVATE_KEY
  await test("Handles missing private key gracefully", async () => {
    const result = await authenticateMinimal({
      privateKey: "",
      logLevel: "error",
    });

    return (
      !result.success &&
      result.story.errorMessage !== undefined &&
      result.story.errorMessage.includes("Private key")
    );
  });

  // Test 4: createMinimalAuthConfigFromEnv without PRIVATE_KEY
  await test("createMinimalAuthConfigFromEnv throws without PRIVATE_KEY", () => {
    // Save original env
    const originalPrivateKey = process.env.PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;

    try {
      createMinimalAuthConfigFromEnv();
      // Restore env
      if (originalPrivateKey) process.env.PRIVATE_KEY = originalPrivateKey;
      return false; // Should have thrown
    } catch (error) {
      // Restore env
      if (originalPrivateKey) process.env.PRIVATE_KEY = originalPrivateKey;
      return (error as Error).message.includes("PRIVATE_KEY");
    }
  });

  // Test 5: Auth Story includes runId
  await test("Auth Story includes unique runId", async () => {
    const result1 = await authenticateMinimal({
      privateKey: "",
      logLevel: "error",
    });
    const result2 = await authenticateMinimal({
      privateKey: "",
      logLevel: "error",
    });

    return (
      result1.story.runId !== result2.story.runId &&
      result1.story.runId.startsWith("run_")
    );
  });

  // Test 6: Auth Story duration is measured
  await test("Auth Story includes duration measurement", async () => {
    const result = await authenticateMinimal({
      privateKey: "",
      logLevel: "error",
    });

    return (
      typeof result.story.durationMs === "number" &&
      result.story.durationMs >= 0
    );
  });
}

// Run all tests and report results
runTests()
  .then(() => {
    console.log("\n" + "=".repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log("=".repeat(60));

    if (failed === 0) {
      console.log("\n✅ All validation tests passed!");
      console.log("\nThe minimal auth module is ready to use:");
      console.log("  npm run auth:probe");
      process.exit(0);
    } else {
      console.log("\n❌ Some validation tests failed");
      console.log("Please check the implementation");
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error("\n❌ Test runner error:", error);
    process.exit(1);
  });

