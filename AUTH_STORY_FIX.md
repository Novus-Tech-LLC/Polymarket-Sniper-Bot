# Auth Story: Missing API Credentials Fix

## Problem Summary

Orders failed with "Missing API credentials" error even though authentication succeeded at startup.

## Root Cause

The credential flow had a gap:

1. ✅ `PolymarketAuth.getClobClient()` creates CLOB client WITH credentials
2. ✅ Credentials are stored on the client instance as `client.creds`
3. ❌ `withAuthRetry()` → `initializeApiCreds()` doesn't check `client.creds`
4. ❌ Error thrown: "Missing API credentials"

## The Fix

Modified `src/infrastructure/clob-auth.ts` to check three sources for credentials (in priority order):

### `initializeApiCreds()` flow:

1. Provided credentials (parameter) → apply and cache ✅
2. Cached credentials (from previous call) → apply ✅
3. **NEW**: Client instance credentials (`client.creds`) → cache and return ✅
4. None found → throw error ❌

### `refreshApiCreds()` flow:

1. Cached credentials → apply ✅
2. **NEW**: Client instance credentials → cache and apply ✅
3. None found → throw error ❌

## Changes Made

```
src/infrastructure/clob-auth.ts:
  - Added client.creds check in initializeApiCreds() (lines 20-25)
  - Added client.creds check in refreshApiCreds() (lines 36-43)
  - Credentials found on client are cached for future use

tests/arbitrage/clob-auth-client-creds.test.ts:
  - Test: initializeApiCreds recognizes client credentials ✅
  - Test: refreshApiCreds recognizes client credentials ✅
  - Test: client credentials are cached for future use ✅
  - Test: provided credentials have priority over client credentials ✅
```

## Test Results

```
✔ All existing clob-auth tests pass (2 tests)
✔ All new credential recognition tests pass (4 tests)
✔ Build succeeds with no TypeScript errors
✔ Linting passes (only pre-existing warnings)
```

## Auth Flow (After Fix)

```
Startup:
  1. PolymarketAuth.getApiCredentials() → derives creds from L1 signature
  2. PolymarketAuth.getClobClient() → creates ClobClient with creds
  3. Client stored with credentials: client.creds = { key, secret, passphrase }

Order Submission:
  1. postOrder() → withAuthRetry(client, operation)
  2. withAuthRetry() → initializeApiCreds(client)
  3. initializeApiCreds() checks:
     a. providedCreds? No
     b. cachedCreds? No (first call)
     c. client.creds? YES ✅ → cache and return
  4. Order operation succeeds ✅

Subsequent Orders:
  1. withAuthRetry() → initializeApiCreds(client)
  2. initializeApiCreds() checks:
     a. providedCreds? No
     b. cachedCreds? YES ✅ → use cached
  3. Order operation succeeds ✅
```

## Expected Logs (After Fix)

```
[INFO] ✅ Authentication successful
[INFO] [PolymarketAuth] API credentials obtained: key=...b68031
[INFO] Creating CLOB client with credentials
[INFO] Order submitted successfully
```

## No More Logs Like This

```
❌ [WARN] [CLOB] Order submission failed (unknown): Missing API credentials...
```

## Security Notes

- No secrets logged (only key suffixes shown)
- Credentials are stored in memory only
- Client instance credentials have same lifecycle as the client
- Cache is cleared with resetApiCredsCache() if needed

## Minimal Change Philosophy

This fix follows the principle of minimal invasive change:

- Only 14 lines added (7 in each function)
- No changes to external interfaces
- No changes to credential derivation logic
- No changes to client construction
- Just checks one more place before throwing error

## Definition of Done ✅

- [x] One minimal code change to fix the root cause
- [x] Credentials flow from auth → client → order submission
- [x] All existing tests pass
- [x] New tests verify the fix
- [x] No TypeScript compilation errors
- [x] No new linting errors
- [x] Changes committed with clear message
- [x] Auth Story documented
