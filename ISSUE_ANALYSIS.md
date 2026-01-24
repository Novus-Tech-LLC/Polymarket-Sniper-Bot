# Polymarket Sniper Bot - Issue Analysis

## Issue 1: "in-flight transaction limit reached for delegated accounts" Error

### Root Cause
The error `"code": -32000, "message": "in-flight transaction limit reached for delegated accounts"` is an **RPC provider rate limit** from the blockchain node (likely Alchemy, Infura, or similar).

**Location:** `auto-redeem.ts:681` calls `ctfContract.redeemPositions()` which submits transactions to the blockchain.

**What's happening:**
1. Auto-redeem tries to redeem 15 positions
2. Each redemption calls `ctfContract.redeemPositions()` which submits a transaction
3. The RPC provider has a limit on concurrent "in-flight" (pending) transactions for delegated/meta-transaction accounts
4. Once the limit is hit (appears to be quite low), all subsequent calls fail with -32000
5. Failures are tracked in `redemptionAttempts` Map with max 3 failures
6. After 3 failures, positions are skipped permanently (until 10-minute reset)

**Why 14 positions hit "max failures":**
```
[AutoRedeem] ⚠️ 15 redeemable but 14 skipped: 
  0 already redeemed, 
  0 in cooldown, 
  14 max failures
```
This suggests all 14 positions failed 3+ times due to the RPC rate limit.

### Key Problems

1. **No RPC error detection:** The error is caught generically in the catch block at line 722-753
2. **No backoff strategy:** Once rate-limited, the bot continues to hammer the RPC with redemption attempts every 30 seconds
3. **No batching:** Each market redemption is a separate transaction, causing multiple in-flight txs
4. **Fast retry:** 1-minute cooldown is too short for RPC rate limits (which may be hourly or daily)

### Evidence from Code

```typescript
// auto-redeem.ts:681-687 - Where the error occurs
const tx = (await ctfContract.redeemPositions(
  usdcAddress,
  parentCollectionId,
  conditionId,
  indexSets,
  { gasLimit: AutoRedeemStrategy.DEFAULT_GAS_LIMIT },
)) as TransactionResponse;
```

The error is caught at line 722 but there's no specific handling for RPC rate limit errors:

```typescript
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  
  // Only checks for insufficient funds and revert errors
  // NO CHECK FOR RPC RATE LIMIT (-32000)
```

---

## Issue 2: Profit Detection Showing "0 any profit"

### Root Cause
Positions showing **0 profit** when they should show 50-90%+ profit is a **resolved market pricing issue**.

**What's happening:**
1. User has positions in **resolved markets** (Pistons 95¢, Counter-Strike 100¢, etc.)
2. Position tracker marks them as `redeemable: true`
3. For redeemable positions, position-tracker sets `currentPrice` based on winning outcome:
   - If position won: `currentPrice = 1.0` (100¢)
   - If position lost: `currentPrice = 0.0` (0¢)
4. **BUG:** If `fetchMarketOutcome()` returns `null` (API error or can't determine winner), it falls back to `currentPrice = entryPrice`
5. This makes P&L = 0% even though the position is actually worth 95-100¢

**Evidence:**

From `position-tracker.ts:444-454`:
```typescript
if (!winningOutcome) {
  // Cannot determine outcome from Gamma API
  // BUG: Uses entryPrice as fallback
  currentPrice = entryPrice;  // <-- This makes P&L = 0%
  resolvedCount++;
  if (!wasCached) {
    this.logger.debug(
      `[PositionTracker] Redeemable position with unknown outcome: tokenId=${tokenId}, side=${side}, using entryPrice=${entryPrice} as fallback`,
    );
  }
}
```

P&L calculation at line 562:
```typescript
const pnlUsd = (currentPrice - entryPrice) * size;
const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
```

If `currentPrice = entryPrice`, then:
- `pnlUsd = 0`
- `pnlPct = 0%`

### Why fetchMarketOutcome() is Failing

From `position-tracker.ts:777-831`, `fetchMarketOutcome()` queries the Gamma API:
```typescript
const url = `${POLYMARKET_API.GAMMA_API_BASE_URL}/markets?clob_token_ids=${encodedTokenId}`;
const markets = await httpGet<GammaMarketResponse[]>(url, {
  timeout: PositionTracker.API_TIMEOUT_MS,
});
```

**Possible failure reasons:**
1. Gamma API timeout (10s timeout)
2. Gamma API returns empty array
3. Market data missing `outcomePrices` field
4. Parse error when reading outcome data

### Additional Issue: Quick Flip Skips Redeemable Positions

From `quick-flip-simple.ts:133-137`:
```typescript
// STRATEGY GATE: Skip resolved positions - route to AutoRedeem only
if (position.redeemable) {
  continue;
}
```

This means:
- Quick Flip completely ignores resolved positions
- Auto-redeem is supposed to handle them
- But if auto-redeem hits the RPC rate limit, **nothing processes them**
- User is stuck with positions showing 0% profit that can't be redeemed

---

## Summary

### Issue 1: RPC Rate Limit
- **Problem:** No detection or handling of -32000 RPC rate limit errors
- **Impact:** All 15 redeemable positions fail and get permanently blocked
- **Fix Required:** Add RPC error detection, exponential backoff, and longer cooldowns

### Issue 2: Zero Profit Display
- **Problem:** `fetchMarketOutcome()` failures cause resolved positions to show 0% P&L
- **Impact:** User can't see actual profit on 95-100¢ positions
- **Fix Required:** Better fallback pricing for resolved markets (use orderbook or price API)

### Critical Flow Issue
The bot has a **circular dependency problem**:
1. Quick Flip won't touch redeemable positions (sends to auto-redeem)
2. Auto-redeem hits RPC rate limit and blocks all positions
3. Position tracker can't determine profit (fetchMarketOutcome fails)
4. User has ~$500+ in positions stuck showing 0% profit

---

## Recommended Fixes

### Fix 1: RPC Rate Limit Detection
Add specific error handling for -32000 errors with exponential backoff.

### Fix 2: Better Resolved Position Pricing
When `fetchMarketOutcome()` fails, use orderbook or price API as fallback instead of entryPrice.

### Fix 3: Emergency Fallback Sell
Already implemented but may need RPC-aware throttling to avoid rate limits.

### Fix 4: Better Logging
Add structured error logging to diagnose why Gamma API calls fail.

### Fix 5: Transaction Queuing
Instead of firing all redemptions at once, queue them with rate limiting.
