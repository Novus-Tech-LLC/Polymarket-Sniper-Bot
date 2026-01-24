# Proposed Minimal Fixes

## Fix 1: Handle RPC Rate Limit (-32000) Errors

### Changes to `auto-redeem.ts`

#### 1.1: Add RPC Error Detection

**Location:** `auto-redeem.ts:722-753` (catch block in `redeemPosition()`)

**Current code:**
```typescript
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);

  // Handle specific error cases
  if (errorMsg.includes("insufficient funds")) {
    return { ... };
  }

  if (errorMsg.includes("execution reverted") || errorMsg.includes("revert")) {
    return { ... };
  }

  return {
    tokenId: position.tokenId,
    marketId: position.marketId,
    success: false,
    error: errorMsg,
  };
}
```

**Proposed fix:**
```typescript
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  const errorObj = err as any;

  // Check for RPC rate limit error (-32000)
  // This error means "in-flight transaction limit reached"
  const isRpcRateLimit =
    errorObj?.code === -32000 ||
    errorMsg.includes("in-flight transaction limit") ||
    errorMsg.includes("code: -32000");

  if (isRpcRateLimit) {
    return {
      tokenId: position.tokenId,
      marketId: position.marketId,
      success: false,
      error: "RPC_RATE_LIMIT: In-flight transaction limit reached. Will retry with extended cooldown.",
    };
  }

  // Handle specific error cases
  if (errorMsg.includes("insufficient funds")) {
    return { ... };
  }

  if (errorMsg.includes("execution reverted") || errorMsg.includes("revert")) {
    return { ... };
  }

  return {
    tokenId: position.tokenId,
    marketId: position.marketId,
    success: false,
    error: errorMsg,
  };
}
```

#### 1.2: Add Extended Cooldown for RPC Rate Limits

**Location:** `auto-redeem.ts:89-90` (constants section)

**Current:**
```typescript
private static readonly MAX_REDEMPTION_FAILURES = 3;
private static readonly REDEMPTION_RETRY_COOLDOWN_MS = 1 * 60 * 1000; // 1 minute
```

**Proposed addition:**
```typescript
private static readonly MAX_REDEMPTION_FAILURES = 3;
private static readonly REDEMPTION_RETRY_COOLDOWN_MS = 1 * 60 * 1000; // 1 minute
private static readonly RPC_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes for RPC rate limits
```

#### 1.3: Use Extended Cooldown for RPC Rate Limit Errors

**Location:** `auto-redeem.ts:426-438` (failure tracking in `execute()`)

**Current:**
```typescript
} else {
  // Track failure by marketId
  const currentAttempts = this.redemptionAttempts.get(marketId) || {
    lastAttempt: 0,
    failures: 0,
  };
  this.redemptionAttempts.set(marketId, {
    lastAttempt: Date.now(),
    failures: currentAttempts.failures + 1,
  });
  this.logger.warn(
    `[AutoRedeem] Failed to redeem market ${marketId}: ${result.error}`,
  );
}
```

**Proposed fix:**
```typescript
} else {
  // Track failure by marketId
  const currentAttempts = this.redemptionAttempts.get(marketId) || {
    lastAttempt: 0,
    failures: 0,
  };
  
  // Use extended cooldown for RPC rate limit errors
  const isRpcRateLimit = result.error?.includes("RPC_RATE_LIMIT");
  
  this.redemptionAttempts.set(marketId, {
    lastAttempt: Date.now(),
    failures: currentAttempts.failures + 1,
    isRpcRateLimit, // Track if this was an RPC error
  });
  
  if (isRpcRateLimit) {
    this.logger.warn(
      `[AutoRedeem] ⏸️ RPC rate limit hit for market ${marketId}. Will retry after ${Math.round(AutoRedeemStrategy.RPC_RATE_LIMIT_COOLDOWN_MS / 60000)}min cooldown.`,
    );
  } else {
    this.logger.warn(
      `[AutoRedeem] Failed to redeem market ${marketId}: ${result.error}`,
    );
  }
}
```

#### 1.4: Check RPC Rate Limit Cooldown

**Location:** `auto-redeem.ts:336-352` (cooldown check in `execute()`)

**Current:**
```typescript
// Check cooldown for normal retry (not at max failures yet)
const cooldownTimeSinceAttempt = Date.now() - attempts.lastAttempt;
if (
  cooldownTimeSinceAttempt <
  AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS
) {
  skippedCooldown++;
  const remainingCooldown = Math.ceil(
    (AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS -
      cooldownTimeSinceAttempt) /
      1000,
  );
  this.logger.debug(
    `[AutoRedeem] ⏳ Market ${marketId.slice(0, 16)}... in cooldown (${attempts.failures} failures, ${remainingCooldown}s remaining)`,
  );
  continue;
}
```

**Proposed fix:**
```typescript
// Check cooldown for normal retry (not at max failures yet)
const cooldownTimeSinceAttempt = Date.now() - attempts.lastAttempt;
const cooldownMs = (attempts as any).isRpcRateLimit
  ? AutoRedeemStrategy.RPC_RATE_LIMIT_COOLDOWN_MS
  : AutoRedeemStrategy.REDEMPTION_RETRY_COOLDOWN_MS;

if (cooldownTimeSinceAttempt < cooldownMs) {
  skippedCooldown++;
  const remainingCooldown = Math.ceil((cooldownMs - cooldownTimeSinceAttempt) / 1000);
  const cooldownType = (attempts as any).isRpcRateLimit ? "RPC rate limit" : "retry";
  this.logger.debug(
    `[AutoRedeem] ⏳ Market ${marketId.slice(0, 16)}... in ${cooldownType} cooldown (${attempts.failures} failures, ${remainingCooldown}s remaining)`,
  );
  continue;
}
```

#### 1.5: Update redemptionAttempts Type

**Location:** `auto-redeem.ts:78-81`

**Current:**
```typescript
private redemptionAttempts: Map<
  string,
  { lastAttempt: number; failures: number }
> = new Map();
```

**Proposed:**
```typescript
private redemptionAttempts: Map<
  string,
  { lastAttempt: number; failures: number; isRpcRateLimit?: boolean }
> = new Map();
```

---

## Fix 2: Better Resolved Position Pricing

### Changes to `position-tracker.ts`

#### 2.1: Use Orderbook Price as Fallback for Resolved Markets

**Location:** `position-tracker.ts:444-454`

**Current:**
```typescript
if (!winningOutcome) {
  // Cannot determine outcome from Gamma API, but position is marked redeemable
  // Use entry price as fallback - the redemption will succeed/fail on chain
  // This ensures positions aren't silently dropped when outcome API is unavailable
  currentPrice = entryPrice;  // <-- BUG: Makes P&L = 0%
  resolvedCount++;
  if (!wasCached) {
    this.logger.debug(
      `[PositionTracker] Redeemable position with unknown outcome: tokenId=${tokenId}, side=${side}, using entryPrice=${entryPrice} as fallback`,
    );
  }
}
```

**Proposed fix:**
```typescript
if (!winningOutcome) {
  // Cannot determine outcome from Gamma API, but position is marked redeemable
  // Try to fetch current price from orderbook or price API as fallback
  // This provides better P&L estimates while waiting for outcome resolution
  try {
    // Attempt orderbook fetch first
    if (!this.missingOrderbooks.has(tokenId)) {
      try {
        const orderbook = await this.client.getOrderBook(tokenId);
        if (orderbook.bids?.[0] && orderbook.asks?.[0]) {
          const bestBid = parseFloat(orderbook.bids[0].price);
          const bestAsk = parseFloat(orderbook.asks[0].price);
          currentPrice = (bestBid + bestAsk) / 2;
          this.logger.info(
            `[PositionTracker] ⚠️ Redeemable position with unknown outcome - using orderbook price ${(currentPrice * 100).toFixed(1)}¢: tokenId=${tokenId}, side=${side}`,
          );
        } else {
          throw new Error("Empty orderbook");
        }
      } catch (orderbookErr) {
        this.missingOrderbooks.add(tokenId);
        // Fall back to price API
        currentPrice = await this.fetchPriceFallback(tokenId);
        this.logger.info(
          `[PositionTracker] ⚠️ Redeemable position with unknown outcome - using price API ${(currentPrice * 100).toFixed(1)}¢: tokenId=${tokenId}, side=${side}`,
        );
      }
    } else {
      // Orderbook known to be missing, use price API
      currentPrice = await this.fetchPriceFallback(tokenId);
      this.logger.info(
        `[PositionTracker] ⚠️ Redeemable position with unknown outcome - using price API ${(currentPrice * 100).toFixed(1)}¢: tokenId=${tokenId}, side=${side}`,
      );
    }
  } catch (fallbackErr) {
    // All pricing methods failed - use entry price as last resort
    currentPrice = entryPrice;
    this.logger.warn(
      `[PositionTracker] ⚠️ Redeemable position with unknown outcome AND no price available - using entryPrice=${entryPrice}: tokenId=${tokenId}, side=${side}, error=${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
    );
  }
  resolvedCount++;
}
```

---

## Fix 3: Add Transaction Queue for Redemptions (Optional but Recommended)

### Purpose
Prevent multiple concurrent transactions from hitting RPC rate limits.

### Changes to `auto-redeem.ts`

#### 3.1: Add Transaction Queue State

**Location:** `auto-redeem.ts:86` (after checkIntervalMs)

**Add:**
```typescript
// Track pending transactions to avoid RPC rate limit
private pendingRedemptions: Set<string> = new Set();
private maxConcurrentRedemptions: number = 1; // Process 1 at a time to avoid rate limit
```

#### 3.2: Check Queue Before Redemption

**Location:** `auto-redeem.ts:410` (before attempting redemption)

**Add:**
```typescript
// Skip if we're already processing maximum concurrent redemptions
if (this.pendingRedemptions.size >= this.maxConcurrentRedemptions) {
  this.logger.debug(
    `[AutoRedeem] ⏸️ Queue full (${this.pendingRedemptions.size}/${this.maxConcurrentRedemptions}) - deferring market ${marketId.slice(0, 16)}...`,
  );
  continue;
}

// Mark as pending
this.pendingRedemptions.add(marketId);

attemptedRedemptions++;
```

#### 3.3: Remove from Queue After Redemption

**Location:** `auto-redeem.ts:416-453` (after redemption attempt)

**Update:**
```typescript
try {
  const result = await this.redeemPosition(position);

  if (result.success) {
    // Mark entire market as redeemed
    this.redeemedMarkets.add(marketId);
    redeemedCount++;
    this.logger.info(
      `[AutoRedeem] ✓ Successfully redeemed market ${marketId} (~$${totalValueUsd.toFixed(2)}) (tx: ${result.transactionHash})`,
    );
  } else {
    // Track failure...
  }
} catch (err) {
  // Handle error...
} finally {
  // Always remove from pending queue
  this.pendingRedemptions.delete(marketId);
}
```

---

## Summary of Changes

### Auto-Redeem (`auto-redeem.ts`)
1. Add RPC rate limit error detection (check for -32000 code)
2. Add 15-minute extended cooldown for RPC rate limit errors
3. Use extended cooldown instead of 1-minute cooldown for RPC errors
4. Add transaction queue to prevent concurrent redemptions (optional)

### Position Tracker (`position-tracker.ts`)
1. Replace `entryPrice` fallback with orderbook/price API fallback for resolved positions
2. Add warning logs when outcome cannot be determined

### Expected Results

**Issue 1 - RPC Rate Limit:**
- Bot will detect -32000 errors
- Apply 15-minute cooldown instead of 1-minute
- Reduce log spam about failed redemptions
- Eventually succeed when rate limit window resets

**Issue 2 - Zero Profit:**
- Positions at 95-100¢ will show correct profit percentage
- Users can see actual value of redeemable positions
- Better decision-making for manual intervention

### Risk Assessment

**Low risk changes:**
- Error detection and cooldown logic (doesn't change redemption flow)
- Logging improvements

**Medium risk changes:**
- Fallback pricing logic (might show incorrect prices if APIs are stale)
- Transaction queue (might slow down redemptions but prevents rate limits)

### Testing Recommendations

1. Test with a position in a resolved market
2. Verify profit shows correctly even if Gamma API fails
3. Test redemption with simulated RPC rate limit error
4. Verify cooldown increases to 15 minutes for RPC errors
