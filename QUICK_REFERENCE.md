# Quick Reference Card: Polymarket Bot Issues

## TL;DR
- **Issue 1:** RPC rate limit (-32000) blocks all redemptions → Add detection + 15-min cooldown
- **Issue 2:** Resolved positions show 0% profit → Use orderbook price instead of entryPrice

---

## Issue 1: RPC Rate Limit

### Symptom
```
Error: code: -32000, "in-flight transaction limit reached"
[AutoRedeem] ⚠️ 15 redeemable but 14 skipped: 14 max failures
```

### Root Cause
- Line `auto-redeem.ts:722-753` - No detection of -32000 error
- Line `auto-redeem.ts:90` - 1-min cooldown too short
- All 15 redemptions fail 3x in 3 minutes → blocked forever

### Fix Locations
1. **Line 90:** Add `RPC_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000`
2. **Line 722:** Check `err.code === -32000`, set `isRpcRateLimit` flag
3. **Line 336:** Use 15-min cooldown for RPC errors
4. **Line 426:** Track RPC errors separately

### Test
```bash
# Simulate error
const mockErr = { code: -32000, message: "in-flight transaction limit" };
# Verify: 15-min cooldown applied, log shows "RPC rate limit"
```

---

## Issue 2: Zero Profit Display

### Symptom
```
[SimpleQuickFlip] 📊 Positions: 26 total, 0 any profit
# But user has positions at 95-100¢ (should be 50-90% profit)
```

### Root Cause
- Line `position-tracker.ts:444-454` - Falls back to `currentPrice = entryPrice`
- Makes P&L = `(entryPrice - entryPrice) / entryPrice = 0%`

### Fix Location
**Replace lines 444-454** with:
```typescript
if (!winningOutcome) {
  try {
    // Try orderbook first
    if (!this.missingOrderbooks.has(tokenId)) {
      const orderbook = await this.client.getOrderBook(tokenId);
      if (orderbook.bids?.[0] && orderbook.asks?.[0]) {
        currentPrice = (parseFloat(orderbook.bids[0].price) + parseFloat(orderbook.asks[0].price)) / 2;
      } else {
        throw new Error("Empty orderbook");
      }
    } else {
      // Use price API
      currentPrice = await this.fetchPriceFallback(tokenId);
    }
  } catch (err) {
    // Last resort: entryPrice
    currentPrice = entryPrice;
    this.logger.warn(`⚠️ No price available for redeemable position, using entryPrice`);
  }
  resolvedCount++;
}
```

### Test
```bash
# Mock fetchMarketOutcome() to return null
# Verify: orderbook price used, P&L shows non-zero
```

---

## File Changes Summary

### `src/strategies/auto-redeem.ts`
- **Line 90:** Add RPC cooldown constant
- **Line 78-81:** Update `redemptionAttempts` type
- **Line 336-352:** Check RPC flag for cooldown
- **Line 426-438:** Track RPC errors
- **Line 722-753:** Detect -32000 error

### `src/strategies/position-tracker.ts`
- **Line 444-454:** Replace entryPrice fallback

---

## Expected Behavior

### Before
```
❌ 15 positions stuck (max failures)
❌ Profit shows 0% (wrong!)
❌ Capital locked: ~$500
```

### After
```
✅ Redemptions retry with 15-min cooldown
✅ Profit shows 50-90% (correct!)
✅ Capital freed: ~$500 over time
```

---

## Testing Checklist

- [ ] RPC error detected (check for -32000)
- [ ] 15-minute cooldown applied
- [ ] Log shows "RPC rate limit" message
- [ ] Orderbook price used for resolved positions
- [ ] P&L shows non-zero for 95-100¢ positions
- [ ] At least 1 redemption succeeds after cooldown
- [ ] No more "max failures" blocks

---

## Rollback Plan

If issues arise:
```bash
git checkout HEAD~1 src/strategies/auto-redeem.ts
git checkout HEAD~1 src/strategies/position-tracker.ts
# Redeploy
```

---

## Monitoring

Watch for:
- ✅ `[AutoRedeem] ⏸️ RPC rate limit hit` - working as intended
- ✅ `[AutoRedeem] ✅ Successfully redeemed` - redemptions succeeding
- ✅ `[PositionTracker] ⚠️ ...using orderbook price` - fallback working
- ❌ `[AutoRedeem] max failures` - still broken (shouldn't see this)
- ❌ `0 any profit` - still broken (shouldn't see this)

---

## Key Metrics

| Metric | Before | After Target |
|--------|--------|--------------|
| Positions blocked | 14/15 | 0/15 |
| Visible profit | $0 | ~$300 |
| Redemption success rate | 0% | >95% |
| Time to redeem 15 positions | ∞ | ~7-8 min |

---

## One-Liner Fixes

**Issue 1:** "Detect -32000, wait 15 min instead of 1 min"  
**Issue 2:** "Use orderbook price, not entryPrice"

---

## Implementation Time

- Fix 1: 15 minutes
- Fix 2: 20 minutes
- Testing: 30 minutes
- **Total: ~65 minutes**

---

## Priority

🔴 **CRITICAL** - Implement immediately

Blocks: $500+ capital recovery  
Affects: All resolved market positions  
Risk: LOW (minimal code changes)

---

**Ready to implement.** See `PROPOSED_FIXES.md` for detailed code changes.
