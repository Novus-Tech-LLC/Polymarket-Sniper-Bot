# Auth Fix Summary - 401 Unauthorized Resolution

## Date: 2026-01-20

## Problem
Bot fails authentication with `401 Unauthorized` during CLOB credential derivation. Users with Gnosis Safe wallets (created via browser) cannot derive API credentials even though USDC balance and approvals are satisfied.

## Root Cause
**L1 Authentication Header Mismatch**

The `attemptDerive()` function in `credential-derivation-v2.ts` was passing the EOA wallet directly to `ClobClient` constructor, which means the POLY_ADDRESS header in L1 auth requests always used the signer's EOA address.

For Gnosis Safe wallets (signature type 2), when `useEffectiveForL1=true`, the L1 auth should use the **proxy/effective address** (the Safe deposit address), NOT the signer's EOA address.

### Code Issue (Line 440):
```typescript
// BEFORE (INCORRECT):
const client = new ClobClient(
  POLYMARKET_API.BASE_URL,
  Chain.POLYGON,
  asClobSigner(params.wallet), // ❌ Always uses EOA address
  undefined,
  params.attempt.signatureType,
  params.funderAddress,
);
```

The ClobClient internally calls `signer.getAddress()` to populate POLY_ADDRESS header. When we pass the EOA wallet directly, it returns the EOA address even for Safe mode.

## Fix Applied

### 1. Add Effective Signer Proxy (credential-derivation-v2.ts)
```typescript
/**
 * Build effective signer proxy for L1 auth
 * When useEffectiveForL1=true, proxy the wallet to return the effective address
 */
function buildEffectiveSigner(
  wallet: Wallet,
  effectiveAddress: string,
): Wallet {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === "getAddress") {
        return async () => effectiveAddress;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}
```

### 2. Use Effective Signer in attemptDerive()
```typescript
// Determine the L1 auth address for this attempt
const l1AuthAddress = params.attempt.useEffectiveForL1
  ? params.orderIdentity.effectiveAddress
  : params.l1AuthIdentity.signingAddress;

// Build effective signer if needed (for L1 auth headers)
const effectiveSigner = params.attempt.useEffectiveForL1
  ? buildEffectiveSigner(params.wallet, l1AuthAddress)
  : params.wallet;

// ✅ Use effectiveSigner (not params.wallet) so L1 auth headers use correct address
const client = new ClobClient(
  POLYMARKET_API.BASE_URL,
  Chain.POLYGON,
  asClobSigner(effectiveSigner), // ✅ Now respects useEffectiveForL1
  undefined,
  params.attempt.signatureType,
  params.funderAddress,
);
```

### 3. Enhanced Diagnostic Logging
Added context to show exactly which L1 auth address is used:
```typescript
log("debug", "Creating CLOB client for credential derivation", {
  logger: params.logger,
  structuredLogger: params.structuredLogger,
  context: {
    category: "CRED_DERIVE",
    attemptId: params.attemptId,
    signatureType: params.attempt.signatureType,
    l1AuthAddress,
    useEffectiveForL1: params.attempt.useEffectiveForL1,
  },
});
```

## Supporting Changes

### 1. Central Auth Logger (auth-logger.util.ts)
- Deduplication of repeated messages within 60s window
- No secrets in logs (only last 4-6 chars, hashes, lengths)
- Structured logging with correlation IDs

### 2. Auth Probe Command (scripts/auth-probe-minimal.ts)
```bash
npm run auth:probe
```
Produces ONE auth attempt and ONE Auth Story summary:
- No log spam
- Shows exact configuration used
- Exits with 0/1 for CI-friendly testing

### 3. Auth Story Summary (clob/auth-story.ts)
Already exists - now properly utilized to show:
- Identity configuration
- All attempts with details
- Final result and reason

## Expected Behavior After Fix

### User with Gnosis Safe (Browser Wallet)
```
Config:
  PRIVATE_KEY=0xabc...          (EOA signer)
  POLYMARKET_SIGNATURE_TYPE=2    (Safe)
  POLYMARKET_PROXY_ADDRESS=0x52d7...346 (Safe deposit address)

Before Fix:
  Attempt B (Safe + signer auth): 401 ❌ Invalid L1 Request headers
  Attempt C (Safe + effective auth): 401 ❌ Invalid L1 Request headers
  Result: AUTH_FAILED

After Fix:
  Attempt B (Safe + signer auth): 401 ❌ Invalid L1 Request headers
  Attempt C (Safe + effective auth): 200 ✅ Success
  Result: AUTH_OK, READY_TO_TRADE=true
```

### User with EOA Wallet
```
Config:
  PRIVATE_KEY=0xabc...          (EOA signer)
  (No POLYMARKET_SIGNATURE_TYPE or POLYMARKET_PROXY_ADDRESS)

Before & After Fix:
  Attempt A (EOA + signer auth): 200 ✅ Success
  Result: AUTH_OK, READY_TO_TRADE=true
```

## Validation

### Test Commands
```bash
# Minimal auth probe (one attempt, one summary)
npm run auth:probe

# Full matrix test (all signature types and L1 auth combos)
npm run clob:matrix

# Run preflight checks
npm start
```

### Expected Output (Success Case)
```
[INFO] Starting credential derivation
[INFO] Identity: mode=SAFE signer=0x9B98...5D1 maker=0x52d7...346
[INFO] Attempt A (EOA + signer): 401 Failed
[INFO] Attempt B (Safe + signer): 401 Failed
[INFO] Attempt C (Safe + effective): 200 Success ✅
[INFO] ✅ Credential derivation successful!

========================================================
AUTH STORY SUMMARY
========================================================
Identity Configuration:
  selectedMode: SAFE
  signerAddress: 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
  makerAddress: 0x52d7008a5Cb5661dFed5573BB34E69772CDf0346
  
Authentication Attempts: 3
  [A] ❌ FAILED (EOA + signer)
  [B] ❌ FAILED (Safe + signer) 
  [C] ✅ SUCCESS (Safe + effective)
  
Final Result: ✅
  authOk: true
  readyToTrade: true
  reason: OK
========================================================

[Preflight] ✅ READY_TO_TRADE=true PRIMARY_BLOCKER=OK
```

## Files Modified
1. `src/clob/credential-derivation-v2.ts` - Core fix + diagnostics
2. `src/utils/auth-logger.util.ts` - NEW: Deduplicated logging
3. `scripts/auth-probe-minimal.ts` - NEW: Minimal auth probe command
4. `package.json` - Added `auth:probe` script
5. `AUTH_ROOT_CAUSE_ANALYSIS.md` - NEW: Root cause documentation

## Regression Risk
**Low** - The fix only affects the signer passed to ClobClient during credential derivation:
- Existing EOA mode behavior unchanged (useEffectiveForL1=false)
- Safe/Proxy modes now correctly use effective address when needed
- Fallback ladder already had the right attempts, just needed correct implementation

## Next Steps After Deployment
1. User should set environment variables:
   ```bash
   POLYMARKET_SIGNATURE_TYPE=2
   POLYMARKET_PROXY_ADDRESS=0x52d7008a5Cb5661dFed5573BB34E69772CDf0346
   ```
2. Run `npm run auth:probe` to verify
3. If successful, run `npm start` to begin trading

## Security Notes
- No secrets logged (auth-logger sanitizes all credentials)
- Structured logging includes only safe metadata
- Auth Story output contains no private keys or full secrets
