# Dual Preflight Fix - Bot Trading Disabled Issue

## Issue Summary

The trading bot initially reported `READY_TO_TRADE=true` with both auth and approvals passing, but shortly after would disable trading with `APPROVALS_FAILED` and the error "Wallet provider is required". This caused the bot to run in detect-only mode despite having valid credentials and approvals.

## Root Causes

### 1. Dual Preflight Execution (MODE=both)

When `MODE=both` is set, the application starts both the ARB (arbitrage) engine and the MEMPOOL monitor. This caused `ensureTradingReady()` to be called twice:

1. **First call** (arbitrage/runtime.ts:71): ✅ PASSES 
2. **Second call** (app/main.ts:77): ❌ FAILS

The second call would fail because the wallet lacked a provider, causing approval checks to fail.

**User Feedback**: "This should just one preflight if this is the case. why have two if only one needs to pass?"

### 2. Wallet Provider Missing

The issue was in how the wallet was being initialized:

**Before:**
```typescript
// app/main.ts (WRONG)
const clobClient = await auth.getClobClient();
const { Wallet } = await import("ethers");
const wallet = new Wallet(env.privateKey);  // ❌ No provider!
const client = Object.assign(clobClient, { wallet });
```

This created a wallet **without** an Ethereum provider, which is required for:
- Balance queries (`getPolBalance`, `getUsdBalanceApprox`)
- Approval checks (`ensureApprovals`)
- On-chain transactions

### 3. PolymarketAuth Wallet Initialization

The `PolymarketAuth` class was creating wallets without providers:

**Before:**
```typescript
// polymarket-auth.ts (INCOMPLETE)
this.signer = new Wallet(privateKey);  // ❌ No provider!
```

## Solution: Single Preflight Architecture

Instead of running preflight twice with caching workarounds, we now run it **ONCE** at the application level before starting any engines.

### New Architecture

```
MODE=both startup
  │
  ├─ [MAIN.TS] Run authentication ONCE
  ├─ [MAIN.TS] Create client with provider ONCE  
  ├─ [MAIN.TS] Run ensureTradingReady() ONCE
  │
  ├─ Pass authenticated client to ARB engine ✅
  │   └─ [ARB] Receives client, SKIPS preflight
  │
  └─ Pass authenticated client to MEMPOOL monitor ✅
      └─ [MEMPOOL] Receives client, SKIPS preflight
```

## Fixes Applied

### Fix 1: Updated PolymarketAuth

**File:** `src/clob/polymarket-auth.ts`

**Changes:**
- Added optional `rpcUrl` parameter to `PolymarketCredentials` interface
- Updated constructor to create wallet with `JsonRpcProvider` when RPC URL is provided
- Updated `getClobClient()` to return client with attached wallet
- Updated `createPolymarketAuthFromEnv()` to read `RPC_URL` from environment

**After:**
```typescript
// polymarket-auth.ts (COMPLETE)
if (credentials.rpcUrl) {
  const provider = new JsonRpcProvider(credentials.rpcUrl);
  this.signer = new Wallet(privateKey, provider);  // ✅ With provider!
}
```

**Benefits:**
- Wallet now has proper provider for blockchain interactions
- Balance queries work correctly
- Approval checks function properly

### Fix 2: Removed Duplicate Wallet Creation

**Files:** `src/app/main.ts`, `src/tools/preflight.ts`

**Changes:**
- Removed manual wallet creation: `new Wallet(env.privateKey)`
- Use wallet from CLOB client directly: `await auth.getClobClient()`

**After:**
```typescript
// app/main.ts (CORRECT)
const client = await auth.getClobClient();  // ✅ Already has wallet with provider
```

**Benefits:**
- No more wallet without provider
- Consistent wallet usage across codebase
- Eliminates provider-related errors

### Fix 3: Single Preflight Execution

**Files:** `src/app/main.ts`, `src/arbitrage/runtime.ts`

**Changes:**

**main.ts** - Runs preflight once at top level:
```typescript
// Run authentication and preflight ONCE before starting any engines
const auth = createPolymarketAuthFromEnv(logger);
const authResult = await auth.authenticate();
const client = await auth.getClobClient();
const tradingReady = await ensureTradingReady({ client, ... });

// Pass pre-authenticated client to engines
if (mode === "arb" || mode === "both") {
  await startArbitrageEngine(cliOverrides, client, tradingReady);
}
if (mode === "mempool" || mode === "both") {
  // Use same client for MEMPOOL
}
```

**runtime.ts** - Accepts pre-authenticated client:
```typescript
export async function startArbitrageEngine(
  overrides: Record<string, string | undefined> = {},
  preAuthenticatedClient?: ClobClient & { wallet: Wallet },
  preflightResult?: { detectOnly: boolean; authOk: boolean; ... },
): Promise<ArbitrageEngine | null> {
  // Use pre-authenticated client if provided (MODE=both)
  if (preAuthenticatedClient && preflightResult) {
    logger.info("[ARB] ⚡ Using pre-authenticated client (preflight skipped)");
    client = preAuthenticatedClient;
    tradingReady = preflightResult;
  } else {
    // Standalone ARB mode - create client and run preflight
    client = await createPolymarketClient({...});
    tradingReady = await ensureTradingReady({...});
  }
}
```

**Benefits:**
- Preflight runs ONCE (not twice) in MODE=both
- Simpler architecture - single source of truth
- No caching workarounds needed
- Better performance - less redundant work
- Easier to debug - single execution path

### Fix 4: Removed Preflight Caching

**File:** `src/polymarket/preflight.ts`

**Changes:**
- Removed global `preflightCache` variable
- Removed cache TTL constant
- Removed cache hit/miss logic
- Simplified function to just run preflight

**Before:**
```typescript
// Check cache, run preflight, store result
if (cache && cache.signerAddress === signer && ...) {
  return cache.result;
}
// ... run preflight ...
preflightCache = { timestamp, signerAddress, result };
return result;
```

**After:**
```typescript
// Simply run preflight once
export const ensureTradingReady = async (params) => {
  // ... run preflight ...
  return { detectOnly, authOk, approvalsOk, geoblockPassed };
};
```

**Benefits:**
- Cleaner code - no cache management
- No stale cache issues
- Single execution model
- Easier to reason about

## Technical Flow

### Before (BROKEN)

```
MODE=both startup
  ├─ Start ARB engine
  │   ├─ Create wallet (no provider) ❌
  │   ├─ Run preflight #1: PASS (by luck)
  │   └─ Cache result
  │
  └─ Start MEMPOOL monitor
      ├─ Create wallet (no provider) ❌
      ├─ Run preflight #2: FAIL
      │   └─ getPolBalance fails: "Wallet provider is required"
      └─ Switch to DETECT_ONLY mode ❌
```

### After (FIXED)

```
MODE=both startup
  ├─ [MAIN] Authenticate ONCE
  ├─ [MAIN] Create client with provider ✅
  ├─ [MAIN] Run preflight ONCE: PASS ✅
  │
  ├─ Start ARB engine (receives client)
  │   ├─ Detects pre-authenticated client
  │   ├─ Logs: "⚡ Using pre-authenticated client"
  │   ├─ SKIPS client creation
  │   ├─ SKIPS preflight
  │   └─ Trading enabled ✅
  │
  └─ Start MEMPOOL monitor (receives client)
      ├─ Uses same authenticated client
      ├─ SKIPS preflight
      └─ Trading enabled ✅
```

## Verification

### Build Status
```bash
npm run build
# ✅ Builds successfully
```

### Expected Behavior

When running with `MODE=both`:
1. Main.ts authenticates and runs preflight ONCE
2. ARB engine receives pre-authenticated client
3. ARB engine logs: "⚡ Using pre-authenticated client from main (preflight already completed)"
4. ARB engine SKIPS its own preflight
5. MEMPOOL monitor uses same client
6. MEMPOOL monitor SKIPS its own preflight
7. Both engines use wallets with providers
8. Trading enabled if preflight passed

### Log Example

```
[INFO] Starting Polymarket runtime mode=both
[INFO] 🔐 Authenticating with Polymarket...
[INFO] ✅ Authentication successful
[INFO] 🔍 Running preflight checks...
[INFO] [Preflight][Summary] ✅ Auth: PASSED
[INFO] [Preflight][Summary] ✅ Approvals: PASSED
[INFO] [Preflight][Summary] ✅ Ready to Trade: YES
[INFO] [ARB] ⚡ Using pre-authenticated client from main (preflight already completed)
[INFO] ✅ ARB TRADING ENABLED - Engine will execute trades
[INFO] ✅ MEMPOOL TRADING ENABLED - Bot will submit orders
```

## Modes of Operation

### MODE=arb (ARB only)
- ARB engine creates its own client
- ARB engine runs its own preflight
- No changes to existing behavior

### MODE=mempool (MEMPOOL only)
- Main creates client once
- Main runs preflight once
- MEMPOOL uses that client
- No changes to existing behavior

### MODE=both (ARB + MEMPOOL)
- ✅ Main creates client ONCE
- ✅ Main runs preflight ONCE
- ✅ ARB receives pre-authenticated client
- ✅ MEMPOOL receives pre-authenticated client
- ✅ No duplicate work
- ✅ Trading enabled correctly

## Environment Variables

The fix requires the `RPC_URL` environment variable to be set:

```bash
# Required for wallet provider initialization
RPC_URL=https://polygon-rpc.com
# or
rpc_url=https://polygon-rpc.com
```

If not set, the wallet will be created without a provider and a warning will be logged, but trading may still fail during balance/approval checks.

## Related Files

- `src/app/main.ts` - Main entry point with single preflight
- `src/clob/polymarket-auth.ts` - Wallet initialization with provider
- `src/arbitrage/runtime.ts` - ARB engine accepting pre-auth client
- `src/polymarket/preflight.ts` - Simplified preflight (no cache)
- `src/tools/preflight.ts` - Preflight diagnostic tool
- `src/utils/get-balance.util.ts` - Balance queries requiring provider

## Impact

### Positive
- ✅ Trading no longer disabled after successful startup
- ✅ MODE=both now works correctly
- ✅ No duplicate preflight runs - cleaner logs
- ✅ Better performance - less redundant work
- ✅ Simpler architecture - easier to understand
- ✅ No caching complexity
- ✅ Single source of truth

### Potential Issues
- ⚠️ Requires RPC_URL environment variable
- ⚠️ Changes ARB engine signature (backwards compatible via optional params)

## Testing Recommendations

1. ✅ Test with MODE=arb only (standalone mode)
2. ✅ Test with MODE=mempool only
3. ✅ Test with MODE=both (key test case)
4. Test with missing RPC_URL
5. Test with invalid RPC_URL
6. Verify logs show single preflight run
7. Verify "Using pre-authenticated client" message appears
8. Monitor for no "Wallet provider is required" errors
