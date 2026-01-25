# AutoRedeem Architecture: Direct On-Chain Scanning

## Overview

AutoRedeem **does NOT use PositionTracker**. Instead, it fetches wallet holdings directly from the Data API and uses on-chain `payoutDenominator` checks as the **sole authority** for redeemability.

## Why Not Use PositionTracker?

### 1. **Separation of Concerns**

AutoRedeem's responsibility is simple: find positions where `payoutDenominator > 0` on-chain and redeem them. It doesn't need:
- PositionTracker's complex state machine
- P&L calculations
- Orderbook data
- Price tracking

### 2. **On-Chain is the Only Authority**

The Data API's `redeemable` flag can be:
- Stale (not yet updated after market resolution)
- Incorrect (edge cases, bugs)
- Optimistic (set before on-chain resolution is posted)

Only the on-chain `payoutDenominator > 0` check is authoritative.

### 3. **Self-Contained Strategy**

By fetching directly from Data API and checking on-chain, AutoRedeem is:
- Independent of PositionTracker's refresh cycle
- Not affected by PositionTracker bugs or state issues
- Simpler to test and reason about

---

## The Strict Redeemable State Machine

AutoRedeem implements its own strict state machine in `checkOnChainResolved()`:

```typescript
/**
 * STRICT REDEEMABLE STATE MACHINE:
 * ================================
 * A position is ONLY redeemable if payoutDenominator(conditionId) > 0 on-chain.
 * - Data API `redeemable` flag is NOT trusted (can be stale or wrong)
 * - Price near 1.0 does NOT imply redeemable
 * - Empty orderbook does NOT imply redeemable
 * - Gamma "winner" field does NOT imply redeemable
 *
 * ONLY on-chain payoutDenominator > 0 is authoritative.
 */
```

### Implementation in `checkOnChainResolved()`

Located in `src/strategies/auto-redeem.ts`:

```typescript
private async checkOnChainResolved(conditionId: string): Promise<boolean> {
  // 1. Validate conditionId format (bytes32)
  if (!conditionId?.startsWith("0x") || conditionId.length !== 66) {
    return false;
  }

  // 2. Check cache (5-minute TTL to reduce RPC calls)
  const cached = this.payoutDenominatorCache.get(conditionId);
  if (cached && now - cached.checkedAt < 300_000) {
    return cached.resolved;
  }

  // 3. Query on-chain CTF contract
  const ctfContract = new Contract(ctfAddress, CTF_ABI, wallet.provider);
  const denominator = await ctfContract.payoutDenominator(conditionId);
  
  // 4. ONLY if denominator > 0 is position redeemable
  const isResolved = denominator > 0n;
  
  // 5. Cache result
  this.payoutDenominatorCache.set(conditionId, {
    resolved: isResolved,
    checkedAt: now,
  });

  return isResolved;
}
```

---

## How AutoRedeem Fetches Positions

### Step 1: Fetch from Data API

AutoRedeem calls the Data API `/positions` endpoint directly:

```typescript
private async fetchPositionsFromDataApi(): Promise<RedeemablePosition[]> {
  const walletAddress = resolveSignerAddress(this.client);
  const url = POLYMARKET_API.POSITIONS_ENDPOINT(walletAddress);
  const apiPositions = await httpGet<DataApiPosition[]>(url);
  
  // Map to minimal position format (tokenId, marketId, size, currentPrice)
  // Note: We do NOT filter by redeemable flag - on-chain check is authoritative
  return apiPositions
    .filter((p) => p.asset && p.conditionId && p.size > 0)
    .map((p) => ({
      tokenId: p.asset,
      marketId: p.conditionId,
      size: p.size,
      currentPrice: p.curPrice ?? 0,
    }));
}
```

### Step 2: Filter by On-Chain Status

```typescript
private async getRedeemablePositions(): Promise<RedeemablePosition[]> {
  // 1. Fetch all positions from Data API (source of tokenIds)
  const allPositions = await this.fetchPositionsFromDataApi();

  // 2. Filter by minimum value threshold
  const aboveMinValue = allPositions.filter(
    (pos) => pos.size * pos.currentPrice >= this.config.minPositionUsd,
  );

  // 3. Check on-chain payoutDenominator for each position
  // This is the AUTHORITATIVE check for redeemability
  const redeemable: RedeemablePosition[] = [];
  for (const pos of aboveMinValue) {
    const isOnChainResolved = await this.checkOnChainResolved(pos.marketId);
    if (isOnChainResolved) {
      redeemable.push(pos);
    }
  }

  return redeemable;
}
```

---

## On-Chain Preflight Check

Before EVERY redemption transaction, AutoRedeem verifies on-chain status:

```
┌─────────────────────────────────────────────────────────────────┐
│                    1. Fetch from Data API                        │
│         Get list of tokenIds/conditionIds in wallet              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                2. On-Chain Preflight Check                       │
│         For EACH position:                                       │
│         checkOnChainResolved(conditionId) must return true       │
│         ↓                                                       │
│         payoutDenominator > 0 required                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     REDEMPTION EXECUTED                          │
│         Only positions with payoutDenominator > 0                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Benefits of This Architecture

| Benefit | Description |
|---------|-------------|
| **Independence** | AutoRedeem is self-contained, not coupled to PositionTracker |
| **Accuracy** | On-chain check prevents failed redemptions |
| **Simplicity** | Single source of truth (on-chain payoutDenominator) |
| **Efficiency** | 5-minute cache reduces RPC calls |
| **Safety** | Never sends tx to unresolved markets |

---

## Related Files

- `src/strategies/auto-redeem.ts` - Redemption strategy with direct Data API fetch and on-chain checks
- `src/trading/exchange-abi.ts` - CTF contract ABI (includes `payoutDenominator`)
- `src/polymarket/contracts.ts` - Contract address resolution
- `src/constants/polymarket.constants.ts` - Data API endpoint URLs
