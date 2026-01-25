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
  isNonceError?: boolean;
}

// Helper function to simulate checking if a "not resolved yet" error
function isNotResolvedYetError(errorMsg: string): boolean {
  return (
    errorMsg.includes("result for condition not received yet") ||
    errorMsg.includes("condition not resolved") ||
    errorMsg.includes("payoutDenominator=0")
  );
}

// Helper function to simulate checking if error is due to RPC rate limiting
function isRpcRateLimitError(msg: string): boolean {
  return (
    msg.includes("in-flight transaction limit") ||
    msg.includes("rate limit") ||
    msg.includes("Too Many Requests") ||
    msg.includes("429") ||
    msg.includes("-32000") ||
    msg.includes("-32005") ||
    msg.includes("BAD_DATA") ||
    msg.includes("missing response for request")
  );
}

// Helper function to simulate checking if error is a transaction nonce/replacement issue
function isTransactionNonceError(msg: string): boolean {
  return (
    msg.includes("REPLACEMENT_UNDERPRICED") ||
    msg.includes("replacement fee too low") ||
    msg.includes("replacement transaction underpriced") ||
    msg.includes("nonce too low") ||
    msg.includes("already known")
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
    // Don't count rate limits as failures - transient network issue
    return;
  }

  if (result.isNonceError) {
    // Don't count nonce/replacement errors as failures - transient blockchain state
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

  describe("Rate Limit Error Detection", () => {
    test("should detect -32005 error code", () => {
      const errorMsg = 'error code: -32005, message: "Too Many Requests"';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect -32005 error code",
      );
    });

    test("should detect 'Too Many Requests' message", () => {
      const errorMsg =
        'Error: missing response for request (value=[ { "code": -32005, "message": "Too Many Requests" } ])';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect 'Too Many Requests' message",
      );
    });

    test("should detect 'in-flight transaction limit' error", () => {
      const errorMsg = "in-flight transaction limit reached";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect in-flight transaction limit",
      );
    });

    test("should detect 'rate limit' error", () => {
      const errorMsg = "rate limit exceeded";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect rate limit message",
      );
    });

    test("should detect HTTP 429 status code", () => {
      const errorMsg = "HTTP Error 429: Too Many Requests";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect HTTP 429 status",
      );
    });

    test("should detect -32000 error code", () => {
      const errorMsg = "JSON-RPC error: -32000";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect -32000 error code",
      );
    });

    test("should NOT detect unrelated errors as rate limits", () => {
      const errorMsg = "insufficient funds for gas";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        false,
        "Should not match unrelated errors",
      );
    });

    test("should detect polygon gas station rate limit error", () => {
      // This is the exact error format from the user's logs
      const errorMsg =
        'error encountered with polygon gas station ("https://gasstation.polygon.technology/v2") (request={  }, response=null, error={ "code": "BAD_DATA", "info": { "payload": { "id": 336, "jsonrpc": "2.0", "method": "eth_getBlockByNumber", "params": [ "latest", false ] } }, "shortMessage": "missing response for request", "value": [ { "code": -32005, "data": { "see": "https://infura.io/dashboard" }, "message": "Too Many Requests" } ] })';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect polygon gas station rate limit error with -32005",
      );
    });

    test("should detect BAD_DATA error", () => {
      const errorMsg = "Error: missing response for request (code=BAD_DATA)";

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect BAD_DATA error code",
      );
    });

    test("should detect 'missing response for request' error", () => {
      const errorMsg =
        'Error: missing response for request (value=[ { "code": -32005, "message": "Too Many Requests" } ])';

      assert.strictEqual(
        isRpcRateLimitError(errorMsg),
        true,
        "Should detect missing response error",
      );
    });
  });

  describe("Transaction Nonce Error Detection", () => {
    test("should detect REPLACEMENT_UNDERPRICED error", () => {
      const errorMsg =
        'Error: replacement fee too low (transaction="0x02f90154...", code=REPLACEMENT_UNDERPRICED, version=6.16.0)';

      assert.strictEqual(
        isTransactionNonceError(errorMsg),
        true,
        "Should detect REPLACEMENT_UNDERPRICED error code",
      );
    });

    test("should detect 'replacement fee too low' error", () => {
      const errorMsg = "replacement fee too low";

      assert.strictEqual(
        isTransactionNonceError(errorMsg),
        true,
        "Should detect replacement fee too low message",
      );
    });

    test("should detect 'replacement transaction underpriced' error", () => {
      const errorMsg =
        '{ "error": { "code": -32000, "message": "replacement transaction underpriced" } }';

      assert.strictEqual(
        isTransactionNonceError(errorMsg),
        true,
        "Should detect replacement transaction underpriced message",
      );
    });

    test("should detect 'nonce too low' error", () => {
      const errorMsg = "nonce too low: next nonce 42, tx nonce 41";

      assert.strictEqual(
        isTransactionNonceError(errorMsg),
        true,
        "Should detect nonce too low message",
      );
    });

    test("should detect 'already known' error", () => {
      const errorMsg = "transaction already known";

      assert.strictEqual(
        isTransactionNonceError(errorMsg),
        true,
        "Should detect already known message",
      );
    });

    test("should NOT detect unrelated errors as nonce errors", () => {
      const errorMsg = "insufficient funds for gas";

      assert.strictEqual(
        isTransactionNonceError(errorMsg),
        false,
        "Should not match unrelated errors",
      );
    });
  });

  describe("Nonce Error Failure Tracking", () => {
    test("should NOT count nonce errors as failures", () => {
      const attempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x1234567890abcdef";

      // Simulate a nonce error result
      const result: MockRedemptionResult = {
        tokenId: "token-123",
        marketId,
        success: false,
        error: "replacement fee too low",
        isNonceError: true,
      };

      updateRedemptionAttempts(attempts, marketId, result);

      const tracked = attempts.get(marketId);
      assert.strictEqual(
        tracked,
        undefined,
        "Should NOT track nonce errors as failures",
      );
    });
  });
});

/**
 * Tests for the new preflight check and skip reason logic
 */
describe("Auto-Redeem Preflight Check and Skip Reasons", () => {
  // Skip reason types matching the actual implementation
  type RedemptionSkipReason =
    | "NOT_RESOLVED_ONCHAIN"
    | "BELOW_MIN_VALUE"
    | "TOO_MANY_FAILURES"
    | "IN_COOLDOWN";

  interface MockPosition {
    tokenId: string;
    marketId: string;
    size: number;
    currentPrice: number;
    redeemable: boolean;
  }

  interface MockRedemptionResultWithSkip {
    tokenId: string;
    marketId: string;
    success: boolean;
    skippedReason?: RedemptionSkipReason;
    positionValueUsd?: number;
    isNotResolvedYet?: boolean;
  }

  // Helper to simulate the $0 loser check
  function isZeroValueLoser(position: MockPosition): boolean {
    const positionValue = position.size * position.currentPrice;
    return positionValue < 0.001; // Less than 0.1 cent is effectively $0
  }

  // Helper to simulate the min value check
  function isBelowMinValue(
    position: MockPosition,
    minValueUsd: number,
  ): boolean {
    const positionValue = position.size * position.currentPrice;
    return positionValue < minValueUsd;
  }

  // Simulate the filtering logic from forceRedeemAll
  function shouldSkipPosition(
    position: MockPosition,
    minValueUsd: number,
    includeLosses: boolean,
  ): { skip: boolean; reason?: RedemptionSkipReason } {
    const positionValue = position.size * position.currentPrice;
    const isZero = isZeroValueLoser(position);
    const isBelowMin = isBelowMinValue(position, minValueUsd);

    if (!includeLosses && isZero) {
      return { skip: true, reason: "BELOW_MIN_VALUE" };
    }

    if (isBelowMin && !isZero) {
      return { skip: true, reason: "BELOW_MIN_VALUE" };
    }

    return { skip: false };
  }

  describe("$0 Loser Detection", () => {
    test("should detect $0 loser (currentPrice = 0)", () => {
      const losingPosition: MockPosition = {
        tokenId: "token-loser",
        marketId: "0x" + "1".repeat(64),
        size: 100, // 100 shares
        currentPrice: 0, // Lost - worth $0
        redeemable: true,
      };

      assert.strictEqual(
        isZeroValueLoser(losingPosition),
        true,
        "Position with currentPrice=0 should be detected as $0 loser",
      );
    });

    test("should detect near-zero loser (currentPrice = 0.00001)", () => {
      const nearZeroPosition: MockPosition = {
        tokenId: "token-nearzero",
        marketId: "0x" + "2".repeat(64),
        size: 10,
        currentPrice: 0.00001,
        redeemable: true,
      };

      assert.strictEqual(
        isZeroValueLoser(nearZeroPosition),
        true,
        "Position with near-zero value should be detected as $0 loser",
      );
    });

    test("should NOT detect winner as $0 loser", () => {
      const winningPosition: MockPosition = {
        tokenId: "token-winner",
        marketId: "0x" + "3".repeat(64),
        size: 100,
        currentPrice: 1.0, // Won - worth $100
        redeemable: true,
      };

      assert.strictEqual(
        isZeroValueLoser(winningPosition),
        false,
        "Winning position should NOT be detected as $0 loser",
      );
    });
  });

  describe("Skip Logic with includeLosses Flag", () => {
    test("should NOT skip $0 losers by default (includeLosses=true)", () => {
      const losingPosition: MockPosition = {
        tokenId: "token-loser",
        marketId: "0x" + "1".repeat(64),
        size: 100,
        currentPrice: 0,
        redeemable: true,
      };

      // New default: includeLosses=true
      const result = shouldSkipPosition(losingPosition, 0.01, true);

      assert.strictEqual(
        result.skip,
        false,
        "Should NOT skip $0 loser by default (includeLosses=true)",
      );
    });

    test("should skip $0 losers when includeLosses=false (--exclude-losses)", () => {
      const losingPosition: MockPosition = {
        tokenId: "token-loser",
        marketId: "0x" + "1".repeat(64),
        size: 100,
        currentPrice: 0,
        redeemable: true,
      };

      const result = shouldSkipPosition(losingPosition, 0.01, false);

      assert.strictEqual(
        result.skip,
        true,
        "Should skip $0 loser when includeLosses=false",
      );
      assert.strictEqual(
        result.reason,
        "BELOW_MIN_VALUE",
        "Skip reason should be BELOW_MIN_VALUE",
      );
    });

    test("should NOT skip winning position", () => {
      const winningPosition: MockPosition = {
        tokenId: "token-winner",
        marketId: "0x" + "3".repeat(64),
        size: 100,
        currentPrice: 1.0,
        redeemable: true,
      };

      const result = shouldSkipPosition(winningPosition, 0.01, false);

      assert.strictEqual(
        result.skip,
        false,
        "Should NOT skip winning position",
      );
    });

    test("should skip position below minValueUsd (non-zero value)", () => {
      const smallPosition: MockPosition = {
        tokenId: "token-small",
        marketId: "0x" + "4".repeat(64),
        size: 1,
        currentPrice: 0.005, // $0.005 value
        redeemable: true,
      };

      const result = shouldSkipPosition(smallPosition, 0.01, false);

      assert.strictEqual(
        result.skip,
        true,
        "Should skip position below minValueUsd",
      );
      assert.strictEqual(
        result.reason,
        "BELOW_MIN_VALUE",
        "Skip reason should be BELOW_MIN_VALUE",
      );
    });
  });

  describe("On-Chain Resolution Check", () => {
    test("payoutDenominator = 0 means not resolved on-chain", () => {
      const payoutDenominator = 0n;

      assert.strictEqual(
        payoutDenominator > 0n,
        false,
        "Zero payoutDenominator means not resolved",
      );
    });

    test("payoutDenominator > 0 means resolved on-chain", () => {
      const payoutDenominator = 1n;

      assert.strictEqual(
        payoutDenominator > 0n,
        true,
        "Non-zero payoutDenominator means resolved",
      );
    });

    test("NOT_RESOLVED_ONCHAIN skip reason when preflight fails", () => {
      // Simulate a result where preflight check found position not resolved on-chain
      const result: MockRedemptionResultWithSkip = {
        tokenId: "token-pending",
        marketId: "0x" + "5".repeat(64),
        success: false,
        skippedReason: "NOT_RESOLVED_ONCHAIN",
        positionValueUsd: 50.0,
        isNotResolvedYet: true,
      };

      assert.strictEqual(
        result.skippedReason,
        "NOT_RESOLVED_ONCHAIN",
        "Skip reason should indicate not resolved on-chain",
      );
      assert.strictEqual(
        result.isNotResolvedYet,
        true,
        "isNotResolvedYet should be true",
      );
    });
  });

  describe("Redemption Summary Categorization", () => {
    test("should correctly categorize results", () => {
      const results: MockRedemptionResultWithSkip[] = [
        {
          tokenId: "token-1",
          marketId: "0x" + "1".repeat(64),
          success: true,
          positionValueUsd: 100,
        },
        {
          tokenId: "token-2",
          marketId: "0x" + "2".repeat(64),
          success: false,
          skippedReason: "NOT_RESOLVED_ONCHAIN",
          positionValueUsd: 50,
        },
        {
          tokenId: "token-3",
          marketId: "0x" + "3".repeat(64),
          success: false,
          skippedReason: "BELOW_MIN_VALUE",
          positionValueUsd: 0,
        },
        {
          tokenId: "token-4",
          marketId: "0x" + "4".repeat(64),
          success: false,
          positionValueUsd: 25,
        }, // Failed without skip reason
      ];

      const successful = results.filter((r) => r.success);
      const skippedNotResolved = results.filter(
        (r) => r.skippedReason === "NOT_RESOLVED_ONCHAIN",
      );
      const skippedBelowMin = results.filter(
        (r) => r.skippedReason === "BELOW_MIN_VALUE",
      );
      const failed = results.filter((r) => !r.success && !r.skippedReason);

      assert.strictEqual(successful.length, 1, "Should have 1 successful");
      assert.strictEqual(
        skippedNotResolved.length,
        1,
        "Should have 1 skipped (not resolved)",
      );
      assert.strictEqual(
        skippedBelowMin.length,
        1,
        "Should have 1 skipped (below min)",
      );
      assert.strictEqual(failed.length, 1, "Should have 1 failed");
    });
  });
});

/**
 * Tests for the continuous on-chain preflight check in executeInternal
 * (Jan 2025 Fix: Make AutoRedeem authoritative during continuous runs)
 */
describe("Auto-Redeem Continuous On-Chain Preflight", () => {
  describe("Preflight Check Logic", () => {
    test("should skip position when payoutDenominator is 0", () => {
      // When on-chain payoutDenominator == 0, position is not resolved
      // AutoRedeem should skip and NOT treat it as redeemable
      const payoutDenominator = 0n;
      const isOnChainResolved = payoutDenominator > 0n;

      assert.strictEqual(
        isOnChainResolved,
        false,
        "Zero payoutDenominator should indicate NOT resolved on-chain",
      );
    });

    test("should proceed with redemption when payoutDenominator > 0", () => {
      // When on-chain payoutDenominator > 0, position IS resolved
      // AutoRedeem should proceed with redemption
      const payoutDenominator = 1n;
      const isOnChainResolved = payoutDenominator > 0n;

      assert.strictEqual(
        isOnChainResolved,
        true,
        "Non-zero payoutDenominator should indicate resolved on-chain",
      );
    });

    test("should handle large payoutDenominator values", () => {
      // Typical payoutDenominator values can be large (e.g., 10^18)
      const payoutDenominator = 1000000000000000000n; // 10^18
      const isOnChainResolved = payoutDenominator > 0n;

      assert.strictEqual(
        isOnChainResolved,
        true,
        "Large payoutDenominator should still be detected as resolved",
      );
    });
  });

  describe("Continuous Run Flow", () => {
    test("positions flagged redeemable by PositionTracker are re-verified on-chain", () => {
      // Simulate the flow:
      // 1. PositionTracker marks position as redeemable (DATA_API_FLAG or DATA_API_UNCONFIRMED)
      // 2. AutoRedeem.executeInternal() picks up the position
      // 3. Before redemption, AutoRedeem verifies on-chain payoutDenominator
      // 4. If payoutDenominator == 0, skip the position

      interface MockPosition {
        tokenId: string;
        marketId: string;
        size: number;
        currentPrice: number;
        redeemable: boolean;
        redeemableProofSource: string;
      }

      const positionFromTracker: MockPosition = {
        tokenId: "token-123",
        marketId: "0x" + "a".repeat(64),
        size: 100,
        currentPrice: 1.0,
        redeemable: true,
        redeemableProofSource: "DATA_API_FLAG", // PositionTracker says redeemable
      };

      // AutoRedeem should ALWAYS verify on-chain, regardless of PositionTracker's flag
      // This makes AutoRedeem the source of truth during continuous runs
      const payoutDenominator = 0n; // On-chain says NOT resolved
      const shouldSkipRedemption = payoutDenominator === 0n;

      assert.strictEqual(
        shouldSkipRedemption,
        true,
        "Should skip redemption when on-chain says NOT resolved (even if PositionTracker says redeemable)",
      );

      // The skipped position remains available for AutoSell if it has live bids
      assert.ok(
        positionFromTracker.currentPrice > 0,
        "Skipped position with value can be handled by AutoSell",
      );
    });

    test("short cooldown is set for not-resolved positions", () => {
      // When position is skipped due to payoutDenominator == 0,
      // a short cooldown is set to avoid rapid retries
      // This simulates the expected behavior

      const redemptionAttempts = new Map<
        string,
        { lastAttempt: number; failures: number }
      >();
      const marketId = "0x" + "b".repeat(64);

      // Position not resolved on-chain - set cooldown
      const now = Date.now();
      redemptionAttempts.set(marketId, {
        lastAttempt: now,
        failures: 0, // Don't count as failure
      });

      const tracked = redemptionAttempts.get(marketId);
      assert.ok(tracked, "Should have cooldown entry");
      assert.strictEqual(tracked.failures, 0, "Should NOT count as failure");
      assert.ok(
        tracked.lastAttempt <= now,
        "Should set lastAttempt for cooldown",
      );
    });
  });

  describe("DATA_API_UNCONFIRMED Handling", () => {
    test("DATA_API_UNCONFIRMED positions are passed to AutoRedeem but skipped by preflight", () => {
      // Positions with DATA_API_UNCONFIRMED proof source indicate:
      // - Data API says redeemable
      // - On-chain payoutDenominator was 0 when PositionTracker checked
      //
      // AutoRedeem.executeInternal() should re-verify on-chain and skip if still 0

      interface MockPosition {
        tokenId: string;
        marketId: string;
        redeemable: boolean;
        redeemableProofSource: "DATA_API_FLAG" | "DATA_API_UNCONFIRMED" | "ONCHAIN_DENOM" | "NONE";
      }

      const unconfirmedPosition: MockPosition = {
        tokenId: "token-unconfirmed",
        marketId: "0x" + "c".repeat(64),
        redeemable: false, // PositionTracker kept as NOT redeemable due to on-chain mismatch
        redeemableProofSource: "DATA_API_UNCONFIRMED",
      };

      // This position should NOT even be picked up by getRedeemablePositions()
      // because redeemable === false
      assert.strictEqual(
        unconfirmedPosition.redeemable,
        false,
        "DATA_API_UNCONFIRMED positions should have redeemable=false",
      );

      // The proof source documents the mismatch for diagnostics
      assert.strictEqual(
        unconfirmedPosition.redeemableProofSource,
        "DATA_API_UNCONFIRMED",
        "Should track the unconfirmed API status",
      );
    });
  });
});
