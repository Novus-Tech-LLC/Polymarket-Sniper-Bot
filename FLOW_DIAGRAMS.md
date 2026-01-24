# Issue Flow Diagrams

## Current Broken Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     POSITION TRACKER                            │
│                                                                 │
│  1. Fetch positions from API                                   │
│  2. Mark as redeemable: true                                   │
│  3. Try fetchMarketOutcome() → FAILS ❌                         │
│  4. Fallback: currentPrice = entryPrice                        │
│  5. Calculate P&L: (entryPrice - entryPrice) = 0% ❌            │
│                                                                 │
│  Result: Position shows 0% profit (wrong!)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      QUICK FLIP STRATEGY                        │
│                                                                 │
│  1. Check positions                                            │
│  2. See: pnlPct = 0%, redeemable = true                        │
│  3. if (position.redeemable) { continue; } → SKIP ⏭️            │
│                                                                 │
│  Result: Won't touch resolved positions                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AUTO-REDEEM STRATEGY                         │
│                                                                 │
│  1. Find 15 redeemable positions                               │
│  2. For each: ctfContract.redeemPositions()                    │
│  3. RPC Provider: "Error -32000: in-flight limit" ❌            │
│  4. Retry after 1 min → FAIL again ❌                           │
│  5. Retry after 1 min → FAIL again ❌                           │
│  6. Max 3 failures reached → PERMANENT SKIP ⛔                  │
│                                                                 │
│  Result: All 15 positions blocked forever                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  USER STUCK:    │
                    │  ~$500 locked   │
                    │  0% profit shown│
                    │  Can't redeem   │
                    │  Can't sell     │
                    └─────────────────┘
```

---

## Fixed Flow (After Implementing Changes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     POSITION TRACKER                            │
│                                                                 │
│  1. Fetch positions from API                                   │
│  2. Mark as redeemable: true                                   │
│  3. Try fetchMarketOutcome() → FAILS ❌                         │
│  4. NEW: Try orderbook price → Success ✅                       │
│     currentPrice = (bid + ask) / 2 = 0.95                      │
│  5. Calculate P&L: (0.95 - 0.55) / 0.55 = 72.7% ✅             │
│                                                                 │
│  Result: Position shows correct 72.7% profit!                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      QUICK FLIP STRATEGY                        │
│                                                                 │
│  1. Check positions                                            │
│  2. See: pnlPct = 72.7%, redeemable = true                     │
│  3. if (position.redeemable) { continue; } → SKIP ⏭️            │
│     (Still skips - this is correct behavior)                   │
│                                                                 │
│  Result: Routes to auto-redeem (as intended)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AUTO-REDEEM STRATEGY                         │
│                                                                 │
│  1. Find 15 redeemable positions                               │
│  2. NEW: Check pending queue (0/1) ✅                           │
│  3. Take 1 position: ctfContract.redeemPositions()             │
│  4. RPC Provider: "Error -32000: in-flight limit" ❌            │
│  5. NEW: Detect -32000 error ✅                                 │
│  6. NEW: Set 15-min cooldown (not 1-min) ✅                     │
│  7. Wait 15 minutes...                                         │
│  8. Retry redemption → Success! ✅                              │
│  9. Take next position...                                      │
│                                                                 │
│  Result: Positions redeemed one-by-one over time               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  USER HAPPY:    │
                    │  Sees 72% profit│
                    │  Redemptions OK │
                    │  Capital freed  │
                    └─────────────────┘
```

---

## Error Detection Flow

### BEFORE (Generic Error Handling)
```
ctfContract.redeemPositions()
      │
      ▼
   [Error]
      │
      ▼
catch (err) {
  error = err.message
  return { success: false, error }
}
      │
      ▼
Track failure, 1-min cooldown
      │
      ▼
Retry... FAIL AGAIN
      │
      ▼
Retry... FAIL AGAIN
      │
      ▼
Max failures → BLOCKED FOREVER
```

### AFTER (RPC Error Detection)
```
ctfContract.redeemPositions()
      │
      ▼
   [Error -32000]
      │
      ▼
catch (err) {
  if (err.code === -32000) {
    error = "RPC_RATE_LIMIT"
    isRpcRateLimit = true ✅
  }
  return { success: false, error }
}
      │
      ▼
Track failure + RPC flag
      │
      ▼
Use 15-min cooldown (not 1-min) ✅
      │
      ▼
Wait 15 minutes...
      │
      ▼
Retry → Likely succeeds now ✅
```

---

## Pricing Fallback Flow

### BEFORE (entryPrice fallback = 0% P&L)
```
position.redeemable = true
      │
      ▼
fetchMarketOutcome(tokenId)
      │
      ├─ Success → 0.0 or 1.0 ✅
      │
      └─ FAIL → currentPrice = entryPrice ❌
                 │
                 ▼
          P&L = (0.55 - 0.55) / 0.55 = 0%
                 │
                 ▼
          User sees: "0 any profit" 😭
```

### AFTER (orderbook/price API fallback)
```
position.redeemable = true
      │
      ▼
fetchMarketOutcome(tokenId)
      │
      ├─ Success → 0.0 or 1.0 ✅
      │
      └─ FAIL ❌
          │
          ▼
     Try getOrderBook(tokenId)
          │
          ├─ Success → (bid + ask) / 2 = 0.95 ✅
          │    │
          │    ▼
          │  P&L = (0.95 - 0.55) / 0.55 = 72.7% ✅
          │    │
          │    ▼
          │  User sees: "4 any profit (avg +78%)" 😊
          │
          └─ FAIL ❌
              │
              ▼
         Try fetchPriceFallback(tokenId)
              │
              ├─ Success → price from API ✅
              │
              └─ FAIL → currentPrice = entryPrice
                        (last resort)
```

---

## Redemption Queue Flow (Optional Fix 3)

### WITHOUT QUEUE (Current)
```
execute() called
      │
      ▼
For each of 15 markets:
  ├─ redeemPositions() → RPC call
  ├─ redeemPositions() → RPC call
  ├─ redeemPositions() → RPC call
  ├─ ... (15 concurrent calls)
  │
  ▼
RPC Provider: "TOO MANY IN-FLIGHT!" ❌
All 15 fail instantly
```

### WITH QUEUE (After Fix 3)
```
execute() called
      │
      ▼
Check queue: 0/1 pending
      │
      ▼
Take 1 market:
  redeemPositions() → RPC call
  Add to pending set
      │
      ▼
Wait for completion (30-60s)
      │
      ▼
Remove from pending set
      │
      ▼
Next execution cycle:
  Take 1 more market
  Repeat...
      │
      ▼
Result: 1 redemption every ~30s
15 markets = ~7-8 minutes total ✅
```

---

## State Transition Diagram

```
Market Resolves
      │
      ▼
┌─────────────┐
│  REDEEMABLE │ ← Position marked redeemable
└─────────────┘
      │
      ├───────────────────────┬───────────────────────┐
      │                       │                       │
      ▼                       ▼                       ▼
┌──────────┐          ┌──────────┐          ┌──────────┐
│ ATTEMPT  │          │ ATTEMPT  │          │ ATTEMPT  │
│    1     │──FAIL──▶ │    2     │──FAIL──▶ │    3     │
│ (0 min)  │          │ (+1 min) │          │ (+2 min) │
└──────────┘          └──────────┘          └──────────┘
      │                       │                       │
      │                       │                       └──FAIL──▶ BEFORE: BLOCKED FOREVER ❌
      │                       │                                  AFTER:  15-min cooldown ✅
      │                       │
      ▼                       ▼
  SUCCESS ✅             SUCCESS ✅
      │                       │
      ▼                       ▼
┌──────────────────────────────────┐
│   REDEEMED (USDC RECOVERED)      │
└──────────────────────────────────┘
```

---

## Cooldown Timeline Comparison

### BEFORE (1-minute cooldown)
```
Time    Action                          Result
──────  ──────────────────────────────  ─────────────
00:00   Attempt 1: redeemPositions()    FAIL (-32000)
01:00   Attempt 2: redeemPositions()    FAIL (-32000)  ← Still rate limited!
02:00   Attempt 3: redeemPositions()    FAIL (-32000)  ← Still rate limited!
02:00   Max failures → BLOCKED          ❌

Total: 3 attempts in 2 minutes, all fail, position blocked
```

### AFTER (15-minute RPC cooldown)
```
Time    Action                          Result
──────  ──────────────────────────────  ─────────────
00:00   Attempt 1: redeemPositions()    FAIL (-32000)
00:00   Detect RPC error → 15min wait   ⏸️
15:00   Attempt 2: redeemPositions()    SUCCESS ✅   ← Rate limit likely reset

Total: 2 attempts in 15 minutes, succeeds
```

---

## Decision Tree: When to Redeem vs Sell

```
Position detected
      │
      ▼
Is redeemable?
      │
  ┌───┴───┐
  │       │
  NO      YES
  │       │
  │       ▼
  │   Current price?
  │       │
  │   ┌───┴────┐
  │   │        │
  │  <99¢    ≥99¢
  │   │        │
  │   │        └──▶ AUTO-REDEEM (on-chain)
  │   │
  │   └──▶ Wait for resolution
  │
  ▼
Current price?
  │
  ├─ Below entry → SMART HEDGING (protection)
  │
  ├─ Above target → QUICK FLIP (profit taking)
  │
  └─ Between → HOLD (wait for target)
```

---

## System Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR                            │
│                 (runs every 2 seconds)                       │
└──────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ POSITION      │    │  QUICK FLIP   │    │ AUTO-REDEEM   │
│ TRACKER       │───▶│  STRATEGY     │    │  STRATEGY     │
│               │    │               │    │               │
│ Refreshes     │    │ Profit taking │    │ Redemptions   │
│ every 30s     │    │ for profits   │    │ for resolved  │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────────────────────────────────────────────────┐
│                    POLYMARKET API                         │
│  - positions API (get current positions)                  │
│  - orderbook API (get current prices)                     │
│  - gamma API (get market outcomes)                        │
└───────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────┐
│                   BLOCKCHAIN RPC                          │
│  - CTF contract (redeemPositions)                        │
│  - USDC contract (balanceOf)                             │
│  - Rate limit: Low for delegated accounts! ⚠️             │
└───────────────────────────────────────────────────────────┘
```

---

**Key Insight:** The entire system depends on:
1. Position tracker getting correct prices
2. Auto-redeem successfully calling RPC
3. If either fails, positions get stuck

**The Fix:** Make both components more resilient:
- Position tracker: Better price fallbacks
- Auto-redeem: Detect + handle RPC rate limits
