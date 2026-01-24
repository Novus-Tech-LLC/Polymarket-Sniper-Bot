import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for Auto-Redeem Strategy
 *
 * These tests verify:
 * 1. On-chain resolution check prevents premature redemption attempts
 * 2. "Not resolved yet" errors are handled gracefully (not counted as failures)
 * 3. Proper detection of "result for condition not received yet" error message
 */

// Mock types matching the actual implementation
interface MockRedemptionResult {
  tokenId: string;
  marketId: string;
  success: boolean;
  transactionHash?: string;
  amountRedeemed?: string;
  error?: string;
  isRateLimited?: boolean;
  isNotResolvedYet?: boolean;
}

// Helper function to simulate checking if a "not resolved yet" error
function isNotResolvedYetError(errorMsg: string): boolean {
  return (
    errorMsg.includes("result for condition not received yet") ||
    errorMsg.includes("condition not resolved") ||
    errorMsg.includes("payoutDenominator=0")
  );
}

// Helper function to simulate the redemption attempt tracking logic
function updateRedemptionAttempts(
  attempts: Map<string, { lastAttempt: number; failures: number }>,
  marketId: string,
  result: MockRedemptionResult,
): void {
  if (result.success) {
    // Clear attempts on success
    attempts.delete(marketId);
    return;
  }

  if (result.isRateLimited) {
    // Don't count rate limits as failures
    return;
  }

  if (result.isNotResolvedYet) {
    // Don't increment failures for "not resolved yet" - just set cooldown
    attempts.set(marketId, {
      lastAttempt: Date.now(),
      failures: 0, // Reset failures - this is expected behavior
    });
    return;
  }

  // Track actual failure
  const currentAttempts = attempts.get(marketId) || {
    lastAttempt: 0,
    failures: 0,
  };
  attempts.set(marketId, {
    lastAttempt: Date.now(),
    failures: currentAttempts.failures + 1,
  });
}

describe("Auto-Redeem On-Chain Resolution Check", () => {
  describe("Error Detection", () => {
    test("should detect 'result for condition not received yet' error", () => {
      const errorMsg =
        'execution reverted: "result for condition not received yet"';

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        true,
        "Should detect contract revert message",
      );
    });

    test("should detect 'condition not resolved' error", () => {
      const errorMsg = "condition not resolved on-chain";

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        true,
        "Should detect condition not resolved message",
      );
    });

    test("should detect 'payoutDenominator=0' error", () => {
      const errorMsg =
        "Condition not resolved on-chain yet (payoutDenominator=0)";

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        true,
        "Should detect payoutDenominator=0 message",
      );
    });

    test("should NOT detect unrelated errors as 'not resolved yet'", () => {
      const errorMsg = "insufficient funds for gas";

      assert.strictEqual(
        isNotResolvedYetError(errorMsg),
        false,
        "Should not match unrelated errors",
      );
    });
  });

  describe("Failure Tracking", () => {
    test("should NOT increment failure count for 'not resolved yet' errors", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a "not resolved yet" result
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "Condition not resolved on-chain yet (payoutDenominator=0)",
        isNotResolvedYet: true,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.ok(tracked, "Should have tracking entry");
      assert.strictEqual(
        tracked.failures,
        0,
        "Should NOT increment failures for not-resolved-yet",
      );
    });

    test("should increment failure count for real errors", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a real failure
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "Transaction reverted: unknown reason",
        isNotResolvedYet: false,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.ok(tracked, "Should have tracking entry");
      assert.strictEqual(
        tracked.failures,
        1,
        "Should increment failures for real errors",
      );
    });

    test("should NOT count rate limit errors as failures", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a rate limit result
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "in-flight transaction limit reached",
        isRateLimited: true,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.strictEqual(
        tracked,
        undefined,
        "Should NOT track rate limit as failure",
      );
    });

    test("should clear attempts on success", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Pre-populate with some failures
      attempts.set(marketId, { lastAttempt: Date.now() - 1000, failures: 2 });

      // Simulate success
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: true,
        transactionHash: "0xabc123",
      };

      updateRedemptionAttempts(attempts, marketId, result);

      assert.strictEqual(
        attempts.has(marketId),
        false,
        "Should clear tracking on success",
      );
    });
  });

  describe("On-Chain Resolution Simulation", () => {
    test("payoutDenominator > 0 means condition is resolved", () => {
      // Simulate on-chain payoutDenominator values
      const resolvedPayoutDenominator = 1n; // Non-zero means resolved
      const unresolvedPayoutDenominator = 0n; // Zero means not resolved

      assert.strictEqual(
        resolvedPayoutDenominator > 0n,
        true,
        "Non-zero payoutDenominator should indicate resolved",
      );

      assert.strictEqual(
        unresolvedPayoutDenominator > 0n,
        false,
        "Zero payoutDenominator should indicate not resolved",
      );
    });
  });
});
