import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for EndgameSweep strategy conflicting position detection logic
 * 
 * These tests verify the logic that prevents the bot from buying a different
 * outcome in a market when the user already has a winning position on another
 * outcome in that same market. This applies to:
 * - Binary markets (YES/NO): Won't buy NO if winning on YES
 * - Multi-outcome markets: Won't buy PlayerB if winning on PlayerA
 */

// Mock Position interface matching position-tracker.ts
interface Position {
  marketId: string;
  tokenId: string;
  side: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
  redeemable?: boolean;
}

/**
 * Simulates the getConflictingPosition logic from endgame-sweep.ts
 * Returns the conflicting position if there's a winning position in the same market with different tokenId
 */
function getConflictingPosition(
  positions: Position[],
  marketId: string,
  targetTokenId: string,
): { side: string; pnlPct: number; size: number } | null {
  for (const pos of positions) {
    // Check for positions in the same market but with a DIFFERENT token
    if (pos.marketId === marketId && pos.tokenId !== targetTokenId) {
      // Only block if the existing position is winning (positive P&L)
      if (pos.pnlPct >= 0) {
        return {
          side: pos.side,
          pnlPct: pos.pnlPct,
          size: pos.size,
        };
      }
    }
  }
  return null;
}

describe("EndgameSweep Conflicting Position Detection", () => {
  test("Should detect winning YES position when trying to buy NO", () => {
    // User has a winning YES position on Lakers (up 15%)
    const positions: Position[] = [
      {
        marketId: "lakers-vs-clippers-2024",
        tokenId: "yes-token-lakers",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.575, // 15% up
        pnlPct: 15,
        pnlUsd: 7.5,
      },
    ];

    // Trying to buy NO (opposite outcome) for the same market
    const conflict = getConflictingPosition(
      positions,
      "lakers-vs-clippers-2024",
      "no-token-lakers", // Different tokenId = opposite outcome
    );

    assert.ok(conflict !== null, "Should detect conflicting position");
    assert.strictEqual(conflict?.side, "YES", "Conflicting position should be YES");
    assert.strictEqual(conflict?.pnlPct, 15, "P&L should be 15%");
    assert.strictEqual(conflict?.size, 100, "Size should be 100");
  });

  test("Should detect winning NO position when trying to buy YES", () => {
    // User has a winning NO position
    const positions: Position[] = [
      {
        marketId: "some-market-123",
        tokenId: "no-token-123",
        side: "NO",
        size: 50,
        entryPrice: 0.3,
        currentPrice: 0.45, // 50% up
        pnlPct: 50,
        pnlUsd: 7.5,
      },
    ];

    // Trying to buy YES (opposite outcome)
    const conflict = getConflictingPosition(
      positions,
      "some-market-123",
      "yes-token-123",
    );

    assert.ok(conflict !== null, "Should detect conflicting position");
    assert.strictEqual(conflict?.side, "NO", "Conflicting position should be NO");
    assert.strictEqual(conflict?.pnlPct, 50, "P&L should be 50%");
  });

  test("Should NOT block buying when existing position is losing", () => {
    // User has a LOSING YES position (down 20%)
    // Smart hedging might kick in, but endgame-sweep should NOT block
    const positions: Position[] = [
      {
        marketId: "some-market-456",
        tokenId: "yes-token-456",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.4, // 20% down
        pnlPct: -20,
        pnlUsd: -10,
      },
    ];

    // Trying to buy NO - should be allowed since existing position is losing
    const conflict = getConflictingPosition(
      positions,
      "some-market-456",
      "no-token-456",
    );

    assert.strictEqual(
      conflict,
      null,
      "Should NOT block buying when existing position is losing",
    );
  });

  test("Should NOT block buying the same token (not inverse)", () => {
    // User has a winning YES position
    const positions: Position[] = [
      {
        marketId: "same-token-market",
        tokenId: "yes-token-same",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.6,
        pnlPct: 20,
        pnlUsd: 10,
      },
    ];

    // Trying to buy MORE of the same YES token - should be allowed
    const conflict = getConflictingPosition(
      positions,
      "same-token-market",
      "yes-token-same", // Same tokenId
    );

    assert.strictEqual(
      conflict,
      null,
      "Should NOT block buying more of the same token",
    );
  });

  test("Should NOT block buying in a different market", () => {
    // User has a winning YES position in market A
    const positions: Position[] = [
      {
        marketId: "market-A",
        tokenId: "yes-token-A",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.7,
        pnlPct: 40,
        pnlUsd: 20,
      },
    ];

    // Trying to buy in market B - completely unrelated, should be allowed
    const conflict = getConflictingPosition(
      positions,
      "market-B", // Different market
      "no-token-B",
    );

    assert.strictEqual(
      conflict,
      null,
      "Should NOT block buying in a different market",
    );
  });

  test("Should handle breakeven position (0% P&L) as winning", () => {
    // User has a breakeven position (0% P&L)
    // Should be treated as "winning" (non-negative) to be safe
    const positions: Position[] = [
      {
        marketId: "breakeven-market",
        tokenId: "yes-token-breakeven",
        side: "YES",
        size: 100,
        entryPrice: 0.5,
        currentPrice: 0.5, // Exactly breakeven
        pnlPct: 0,
        pnlUsd: 0,
      },
    ];

    // Trying to buy NO - should be blocked since P&L >= 0
    const conflict = getConflictingPosition(
      positions,
      "breakeven-market",
      "no-token-breakeven",
    );

    assert.ok(conflict !== null, "Should block buying inverse of breakeven position");
    assert.strictEqual(conflict?.pnlPct, 0, "P&L should be 0%");
  });

  test("Should handle empty positions array", () => {
    const positions: Position[] = [];

    const conflict = getConflictingPosition(
      positions,
      "any-market",
      "any-token",
    );

    assert.strictEqual(conflict, null, "Should return null for empty positions");
  });

  test("Should handle multiple positions in different markets", () => {
    // User has positions in multiple markets
    const positions: Position[] = [
      {
        marketId: "market-1",
        tokenId: "yes-token-1",
        side: "YES",
        size: 50,
        entryPrice: 0.4,
        currentPrice: 0.5,
        pnlPct: 25,
        pnlUsd: 5,
      },
      {
        marketId: "market-2",
        tokenId: "no-token-2",
        side: "NO",
        size: 75,
        entryPrice: 0.6,
        currentPrice: 0.4,
        pnlPct: -33.33,
        pnlUsd: -15,
      },
      {
        marketId: "market-3",
        tokenId: "yes-token-3",
        side: "YES",
        size: 100,
        entryPrice: 0.3,
        currentPrice: 0.6,
        pnlPct: 100,
        pnlUsd: 30,
      },
    ];

    // Try to buy NO in market-1 - should be blocked (winning YES exists)
    const conflict1 = getConflictingPosition(positions, "market-1", "no-token-1");
    assert.ok(conflict1 !== null, "Should block NO in market-1");
    assert.strictEqual(conflict1?.side, "YES");

    // Try to buy YES in market-2 - should NOT be blocked (NO is losing)
    const conflict2 = getConflictingPosition(positions, "market-2", "yes-token-2");
    assert.strictEqual(conflict2, null, "Should allow YES in market-2");

    // Try to buy NO in market-3 - should be blocked (winning YES exists)
    const conflict3 = getConflictingPosition(positions, "market-3", "no-token-3");
    assert.ok(conflict3 !== null, "Should block NO in market-3");
    assert.strictEqual(conflict3?.side, "YES");
    assert.strictEqual(conflict3?.pnlPct, 100);
  });
});

describe("EndgameSweep Real-World Scenarios", () => {
  test("Lakers vs Clippers scenario - user up on Lakers, bot tries to buy Clippers", () => {
    // The original bug report: user was up on Lakers, bot bought inverse
    const positions: Position[] = [
      {
        marketId: "lakers-clippers-jan-2024",
        tokenId: "lakers-yes-token",
        side: "YES", // Lakers YES
        size: 200,
        entryPrice: 0.45,
        currentPrice: 0.65, // Up significantly
        pnlPct: 44.44,
        pnlUsd: 40,
      },
    ];

    // Bot tries to buy Clippers YES (which is Lakers NO equivalent)
    const conflict = getConflictingPosition(
      positions,
      "lakers-clippers-jan-2024",
      "clippers-yes-token", // Different token = opposite outcome
    );

    assert.ok(
      conflict !== null,
      "Should detect that buying Clippers conflicts with winning Lakers position",
    );
    assert.strictEqual(conflict?.side, "YES", "Original winning side is YES");
    assert.ok(conflict?.pnlPct > 0, "Position should be in profit");
  });

  test("Multi-outcome market with winning position", () => {
    // User has winning position on one player in a tennis match
    const positions: Position[] = [
      {
        marketId: "tennis-final-2024",
        tokenId: "player-a-token",
        side: "PlayerA",
        size: 100,
        entryPrice: 0.33, // 3-way market
        currentPrice: 0.6, // Winning
        pnlPct: 81.82,
        pnlUsd: 27,
      },
    ];

    // Bot tries to buy Player B - should be blocked
    const conflict = getConflictingPosition(
      positions,
      "tennis-final-2024",
      "player-b-token",
    );

    assert.ok(
      conflict !== null,
      "Should block buying different outcome in multi-outcome market",
    );
    assert.strictEqual(conflict?.side, "PlayerA");
  });
});
