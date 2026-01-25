# AutoRedeem Architecture: Why PositionTracker, Not On-Chain Scanning

## Overview

AutoRedeem uses `PositionTracker` as its source of truth for redeemable positions instead of directly scanning on-chain wallet holdings. This design choice is intentional and provides significant advantages in terms of reliability, efficiency, and correctness.

## Why Not Scan On-Chain Wallet Holdings Directly?

### 1. **State Complexity**

Scanning on-chain ERC-1155 token balances (Conditional Tokens) directly would require:
- Enumerating all possible tokenIds the user has ever held
- Querying balanceOf for each tokenId
- Mapping tokenIds back to conditionIds/marketIds for redemption
- Tracking which markets are resolved vs still active

The PositionTracker already maintains this mapping efficiently through Polymarket's Data API, which provides position data with metadata like `conditionId`, `marketId`, and `redeemable` flags.

### 2. **The Redeemable Flag Problem**

A raw on-chain scan cannot distinguish between:
- **ACTIVE positions**: Market still trading, shares have value
- **REDEEMABLE positions**: Market resolved, shares can be redeemed
- **CLOSED_NOT_REDEEMABLE**: Market ended but on-chain resolution not posted yet

PositionTracker solves this through its **strict redeemable state machine**.

### 3. **RPC Cost and Latency**

Directly querying on-chain state for every position on every cycle would:
- Require N RPC calls per position (balance check + payout check)
- Incur significant latency (100-500ms per call)
- Risk rate limiting from RPC providers

PositionTracker batches these efficiently and caches results.

---

## The Strict Redeemable State Machine

Located in `src/strategies/position-tracker.ts`, the state machine defines **non-negotiable state definitions**:

```typescript
/**
 * STRICT POSITION STATE MACHINE (Jan 2025 Refactor)
 *
 * NON-NEGOTIABLE STATE DEFINITIONS:
 *
 * ACTIVE:
 *   - Default state for all positions with shares > 0
 *   - Position remains ACTIVE unless we have EXPLICIT PROOF it's REDEEMABLE
 *   - Price near 1.0 does NOT imply resolved
 *   - Empty orderbook does NOT imply resolved
 *   - Gamma "winner" metadata does NOT imply redeemable (only market closed)
 *
 * REDEEMABLE:
 *   - Only if EITHER:
 *     (a) Data-API positions payload explicitly flags redeemable=true, OR
 *     (b) On-chain ConditionalTokens.payoutDenominator(conditionId) > 0
 *   - DO NOT infer from price ≈ 1.0
 *   - DO NOT infer from empty orderbook
 *   - DO NOT infer from Gamma "winner" field alone
 *
 * CLOSED_NOT_REDEEMABLE:
 *   - Market is closed/ended (Gamma says closed=true or end_date passed)
 *   - BUT on-chain resolution not yet posted (payoutDenominator == 0)
 *   - Trading strategies should STOP acting, but NOT treat as redeemable
 */
export type PositionState =
  | "ACTIVE"
  | "REDEEMABLE"
  | "CLOSED_NOT_REDEEMABLE"
  | "UNKNOWN";
```

### Redeemable Proof Sources

The state machine tracks HOW a position was determined to be redeemable:

```typescript
export type RedeemableProofSource =
  | "DATA_API_FLAG"        // Data-API returned redeemable=true AND on-chain verified
  | "DATA_API_UNCONFIRMED" // Data-API says redeemable but on-chain NOT verified
  | "ONCHAIN_DENOM"        // On-chain payoutDenominator > 0
  | "NONE";                // Not redeemable
```

**Critical**: `DATA_API_UNCONFIRMED` positions are routed to AutoSell (if bids exist), NOT AutoRedeem.

---

## How AutoRedeem Filters from PositionTracker

### Primary Filter: `getRedeemablePositions()`

In `src/strategies/auto-redeem.ts` (line 468-475):

```typescript
/**
 * Get positions that are marked as redeemable
 */
private getRedeemablePositions(): Position[] {
  return this.positionTracker
    .getPositions()
    .filter((pos) => pos.redeemable === true)
    .filter(
      (pos) => pos.size * pos.currentPrice >= this.config.minPositionUsd,
    );
}
```

This filters to positions where:
1. `redeemable === true` (set by PositionTracker's state machine)
2. Position value >= `minPositionUsd` config threshold

### Force Redeem Filter: `forceRedeemAll()`

For CLI-triggered redemption (line 247-256):

```typescript
async forceRedeemAll(includeLosses = true): Promise<RedemptionResult[]> {
  // Get all redeemable positions first (before min value filter)
  const allRedeemable = this.positionTracker
    .getPositions()
    .filter((pos) => pos.redeemable === true);

  if (allRedeemable.length === 0) {
    this.logger.info("[AutoRedeem] No redeemable positions found");
    return [];
  }
  // ...
}
```

---

## The On-Chain Preflight Check

**Even when PositionTracker says a position is redeemable**, AutoRedeem performs an on-chain verification before sending any transaction. This is the **preflight check**.

### Why Preflight?

1. **Data API Latency**: The Data API may mark positions redeemable before on-chain resolution is posted
2. **Race Conditions**: Market resolution happens asynchronously
3. **Failed Transaction Prevention**: Sending redemption tx to unresolved market wastes gas and fails

### Implementation

In `src/strategies/auto-redeem.ts` (lines 185-209):

```typescript
// === PREFLIGHT ON-CHAIN CHECK (Jan 2025 Fix) ===
// Verify payoutDenominator > 0 before attempting redemption.
// This makes AutoRedeem the source of truth during continuous runs
// instead of blindly trusting PositionTracker's redeemable flag.
const isOnChainResolved = await this.checkOnChainResolved(
  position.marketId,
);

if (!isOnChainResolved) {
  // Position is NOT resolved on-chain - skip and do not treat as redeemable
  skippedNotResolved++;
  const positionValue = position.size * position.currentPrice;
  this.logger.debug(
    `[AutoRedeem] ⏭️ SKIP (not resolved on-chain): tokenId=${position.tokenId.slice(0, 12)}... ` +
      `marketId=${position.marketId.slice(0, 16)}... value=$${positionValue.toFixed(2)} ` +
      `(payoutDenominator=0, will retry next cycle)`,
  );
  // ...
  continue;
}

// On-chain confirmed - proceed with redemption
const result = await this.redeemPositionWithRetry(position);
```

### The `checkOnChainResolved()` Method

Located at lines 374-463, this method:

1. **Validates conditionId format** (must be bytes32)
2. **Checks cache** to avoid redundant RPC calls (5-minute TTL)
3. **Queries CTF contract** for `payoutDenominator(conditionId)`
4. **Returns true only if** `payoutDenominator > 0`

```typescript
private async checkOnChainResolved(conditionId: string): Promise<boolean> {
  // Validate conditionId format (bytes32)
  if (!conditionId?.startsWith("0x") || conditionId.length !== 66) {
    return false;
  }

  // Check cache first
  const cached = this.payoutDenominatorCache.get(conditionId);
  if (cached && now - cached.checkedAt < 300_000) { // 5 min TTL
    return cached.resolved;
  }

  // Query on-chain
  const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet.provider);
  const denominator = await ctfContract.payoutDenominator(conditionId);
  
  const isResolved = denominator > 0n;
  
  // Cache result
  this.payoutDenominatorCache.set(conditionId, {
    resolved: isResolved,
    checkedAt: now,
  });

  return isResolved;
}
```

---

## Summary: The Three-Layer Safety Model

```
┌─────────────────────────────────────────────────────────────────┐
│                        LAYER 1: Data API                        │
│         PositionTracker fetches redeemable=true flag            │
│         ↓                                                       │
│         Filters to redeemable positions                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LAYER 2: State Machine                        │
│         Strict redeemable proof sources:                         │
│         - DATA_API_FLAG (verified)                               │
│         - ONCHAIN_DENOM (authoritative)                          │
│         - DATA_API_UNCONFIRMED → routes to AutoSell              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   LAYER 3: Preflight Check                       │
│         Before EVERY redemption tx:                              │
│         checkOnChainResolved(conditionId) must return true       │
│         ↓                                                       │
│         payoutDenominator > 0 required                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     REDEMPTION EXECUTED                          │
│         Only after passing all three layers                      │
└─────────────────────────────────────────────────────────────────┘
```

## Benefits of This Architecture

| Benefit | Description |
|---------|-------------|
| **Efficiency** | Single Data API call fetches all positions with metadata |
| **Accuracy** | State machine prevents false positives from price/book heuristics |
| **Safety** | Preflight prevents wasted gas on unresolved markets |
| **Caching** | Reduces RPC load with 5-minute TTL on payoutDenominator |
| **Auditability** | `redeemableProofSource` tracks how each decision was made |
| **Separation of Concerns** | PositionTracker handles state, AutoRedeem handles execution |

---

## Related Files

- `src/strategies/position-tracker.ts` - State machine and position management
- `src/strategies/auto-redeem.ts` - Redemption strategy with preflight checks
- `src/trading/exchange-abi.ts` - CTF contract ABI (includes `payoutDenominator`)
- `src/polymarket/contracts.ts` - Contract address resolution
