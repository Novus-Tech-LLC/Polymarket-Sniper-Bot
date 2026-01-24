# Diagnostic Summary: Auto-Redeem and Profit Detection Issues

## Quick Summary

### Issue 1: RPC Rate Limit Blocking All Redemptions ⚠️
**Status:** CRITICAL - 15 positions stuck  
**Root Cause:** RPC provider's "in-flight transaction limit" for delegated accounts  
**Impact:** All redemption attempts fail, positions accumulate, capital locked  
**Fix Complexity:** LOW - Add error detection + extended cooldown  

### Issue 2: Profitable Positions Showing 0% P&L ⚠️
**Status:** HIGH - User can't see actual profit  
**Root Cause:** `fetchMarketOutcome()` API failures causing fallback to entryPrice  
**Impact:** Positions worth 95-100¢ show 0% profit (actually 50-90%+ profit)  
**Fix Complexity:** LOW - Use orderbook/price API instead of entryPrice  

---

## Detailed Analysis

### Issue 1: RPC Rate Limit Error

#### What the logs show:
```
[WARN] [AutoRedeem] Failed to redeem market 0xcfd9ada8573ab0e09b2fc3988fbeacb957d6f4b6c5d515a20336f68e46167f52: 
could not coalesce error (error={ "code": -32000, "message": "in-flight transaction limit reached for delegated accounts" }, payload={...}

[INFO] [AutoRedeem] ⚠️ 15 redeemable but 14 skipped: 
  0 already redeemed, 
  0 in cooldown, 
  14 max failures
```

#### Why this happens:

1. **RPC Provider Limitation**
   - Blockchain RPC providers (Alchemy, Infura, etc.) limit concurrent "in-flight" (pending) transactions
   - For delegated/meta-transaction accounts, this limit is very low (possibly 1-5 concurrent txs)
   - Error code -32000 is a standard JSON-RPC error for resource limits

2. **No Error Detection**
   - Code at `auto-redeem.ts:722-753` catches the error generically
   - No special handling for -32000 code
   - Treated same as any other failure

3. **Aggressive Retry**
   - 1-minute cooldown between retries
   - Max 3 failures before permanent block
   - RPC rate limits often last 15-60 minutes (or longer)
   - Bot hits rate limit → fails 3x in 3 minutes → blocks all positions

4. **No Backoff Strategy**
   - All 15 redemptions fired rapidly
   - Once first one hits rate limit, rest fail immediately
   - No throttling or queuing

#### Code locations:
- **Error thrown:** `auto-redeem.ts:681` - `ctfContract.redeemPositions()`
- **Generic catch:** `auto-redeem.ts:722` - catches all errors equally
- **Failure tracking:** `auto-redeem.ts:426` - increments failure count
- **Max failure check:** `auto-redeem.ts:266` - skips after 3 failures

---

### Issue 2: Zero Profit Display

#### What the logs show:
```
[SimpleQuickFlip] 📊 Positions: 26 total, 0 any profit, 0 at target (>=10%), 15 redeemable
```

But user has:
- Pistons: 27.5 shares @ 55¢ → now 95¢ = **73.45% profit** ✅
- Counter-Strike: 9.7 shares @ 52¢ → now 100¢ = **92.28% profit** ✅
- Kennesaw State: 9.7 shares @ 52¢ → now 100¢ = **92.31% profit** ✅
- Kings vs Cavaliers: 9.7 shares @ 52¢ → now 97¢ = **85.58% profit** ✅

#### Why this happens:

1. **Resolved Market Pricing Logic**
   ```typescript
   // position-tracker.ts:444-454
   if (!winningOutcome) {
     currentPrice = entryPrice;  // <-- BUG: Makes P&L = 0%
     resolvedCount++;
   }
   ```

2. **P&L Calculation**
   ```typescript
   // position-tracker.ts:562-563
   const pnlUsd = (currentPrice - entryPrice) * size;
   const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
   ```
   
   If `currentPrice = entryPrice`:
   - `pnlUsd = (0.55 - 0.55) * 27.5 = 0`
   - `pnlPct = 0%`
   
   Should be:
   - `pnlUsd = (0.95 - 0.55) * 27.5 = 11.00`
   - `pnlPct = 72.7%`

3. **Why fetchMarketOutcome() Fails**
   - Gamma API timeout (10s)
   - Market data incomplete
   - Network errors
   - API rate limits

4. **Circular Dependency Problem**
   ```
   Quick Flip ──(redeemable?)──> Skip ──> Auto-Redeem
        ↑                                      ↓
        │                                 (RPC rate limit)
        │                                      ↓
        └────────────────────────────────── BLOCKED
   ```
   
   Result: Positions stuck showing 0% profit, can't be sold OR redeemed

#### Code locations:
- **Fallback bug:** `position-tracker.ts:444` - sets `currentPrice = entryPrice`
- **P&L calc:** `position-tracker.ts:562-563`
- **Quick Flip skip:** `quick-flip-simple.ts:135` - skips redeemable positions
- **Outcome fetch:** `position-tracker.ts:777` - fetches from Gamma API

---

## Why Both Issues Compound Each Other

```
USER STATE:
├─ 15 positions marked redeemable
├─ Actually worth 95-100¢ (big profits)
├─ Showing 0% P&L (wrong!)
│
BOT STATE:
├─ Quick Flip: "redeemable? → skip to auto-redeem"
├─ Auto-Redeem: "RPC rate limit → blocked after 3 failures"
│
RESULT:
└─ ~$500+ stuck, showing 0% profit, can't sell, can't redeem
```

---

## Minimal Fix Strategy

### Fix 1: RPC Rate Limit Detection (15 minutes)

**File:** `auto-redeem.ts`

1. Add error detection for -32000 code
2. Add 15-minute extended cooldown constant
3. Track RPC errors separately in `redemptionAttempts`
4. Use extended cooldown for RPC errors

**Changes:**
- Line 722: Add RPC error check
- Line 90: Add `RPC_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000`
- Line 336: Check `isRpcRateLimit` flag for cooldown
- Line 426: Track RPC errors with flag

**Risk:** LOW - Only affects error handling and timing  
**Impact:** HIGH - Unblocks all 15 stuck positions

### Fix 2: Better Resolved Position Pricing (20 minutes)

**File:** `position-tracker.ts`

1. Replace `currentPrice = entryPrice` with orderbook/price API fallback
2. Add try-catch around fallback pricing
3. Add warning logs for unknown outcomes

**Changes:**
- Line 444-454: Replace entryPrice fallback with orderbook/price API

**Risk:** MEDIUM - Might show stale prices if APIs lag  
**Impact:** HIGH - Shows correct profit for resolved positions

### Optional Fix 3: Transaction Queue (30 minutes)

**File:** `auto-redeem.ts`

1. Add `pendingRedemptions` Set
2. Add `maxConcurrentRedemptions = 1`
3. Check queue before redemption
4. Remove from queue in finally block

**Risk:** LOW - Only affects redemption order  
**Impact:** MEDIUM - Prevents future rate limit issues

---

## Testing Plan

### Test 1: RPC Rate Limit Detection
1. Simulate -32000 error in test
2. Verify extended cooldown applied
3. Verify log shows "RPC rate limit" message

### Test 2: Resolved Position Pricing
1. Mock `fetchMarketOutcome()` to return null
2. Verify orderbook price used
3. Verify correct P&L calculated

### Test 3: End-to-End
1. Run with actual resolved positions
2. Verify profit shows correctly
3. Verify redemption succeeds after cooldown

---

## Expected Outcomes After Fixes

### Before:
```
[SimpleQuickFlip] 📊 Positions: 26 total, 0 any profit, 0 at target
[AutoRedeem] ⚠️ 15 redeemable but 14 skipped: 14 max failures
```

### After:
```
[SimpleQuickFlip] 📊 Positions: 26 total, 4 any profit (avg +78%), 0 at target, 15 redeemable
[AutoRedeem] Found 15 redeemable position(s)
[AutoRedeem] ⏸️ RPC rate limit cooldown active - 12 min remaining
[AutoRedeem] Attempting to redeem 1 WINNING market (queued)
[AutoRedeem] ✓ Successfully redeemed market 0xcfd9... (~$42.50)
```

---

## Implementation Priority

### Priority 1 (CRITICAL - Do immediately):
✅ Fix 1: RPC rate limit detection + extended cooldown  
✅ Fix 2: Better resolved position pricing  

### Priority 2 (RECOMMENDED - Do soon):
⭕ Fix 3: Transaction queue

### Priority 3 (NICE TO HAVE):
⭕ Add structured error logging
⭕ Add Prometheus metrics for RPC errors
⭕ Add alert for consecutive RPC rate limits

---

## Files to Modify

1. **src/strategies/auto-redeem.ts**
   - Lines 90: Add constant
   - Lines 722-753: Add RPC error detection
   - Lines 426-438: Track RPC errors
   - Lines 336-352: Check extended cooldown

2. **src/strategies/position-tracker.ts**
   - Lines 444-454: Replace entryPrice fallback

---

## Estimated Time
- Analysis: 30 minutes ✅ (Complete)
- Fix 1 implementation: 15 minutes
- Fix 2 implementation: 20 minutes
- Testing: 30 minutes
- **Total: ~90 minutes**

---

## Questions for User

1. What RPC provider are you using? (Alchemy, Infura, other)
2. What tier/plan? (Free, Growth, Scale)
3. Are you using a delegated/meta-transaction setup?
4. Can you share the full error message with payload?
5. How long has this been happening?

---

## Additional Notes

- The bot has a fallback sell feature at 99.9¢ but it's also hitting the same RPC rate limit
- The 10-minute full reset cooldown might help but 15 positions × 3 failures each = 45 RPC calls in ~10 minutes, which is likely still over the limit
- Consider upgrading RPC tier or switching to a provider with higher limits for delegated accounts
- Long-term solution: Batch redemptions or use a different account structure

---

**Generated:** 2025-01-XX  
**Bot Version:** Based on src/strategies/auto-redeem.ts analysis  
**Analysis Duration:** 30 minutes
