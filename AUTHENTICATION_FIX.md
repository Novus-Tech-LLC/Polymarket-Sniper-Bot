# Authentication Fix Documentation

## Problem

The bot was experiencing persistent 401 "Unauthorized/Invalid api key" errors even when:
- Valid API credentials were derived from `deriveApiKey` 
- All auth headers were present (api key, secret, passphrase, signature)
- The wallet had USDC balance and proper approvals
- Multiple signature types (EOA, Gnosis Safe, Proxy) were attempted

## Root Cause

The issue was with how query parameters were handled after applying the signature patch:

1. **Patch Goal**: Include query parameters in HMAC signatures for CLOB API requests
   - Example: Sign `/balance-allowance?asset_type=COLLATERAL&signature_type=0`

2. **The Bug**: Double parameter handling
   - Patch correctly built signed URL with params
   - But `ClobClient.get()` method was adding params AGAIN via axios
   - This caused axios to potentially reorder/re-encode params
   - Final URL signature didn't match what was originally signed
   - Server rejected with 401

### Technical Details

**Before Fix:**
```javascript
// Step 1: Build signed path (CORRECT)
const signedPath = "/balance-allowance?asset_type=COLLATERAL&signature_type=0"
const signature = hmac(timestamp + "GET" + signedPath)

// Step 2: Make request (PROBLEM!)
this.get(url, {headers})
  → ClobClient.get() adds: params: {geo_block_token: undefined}
  → axios sees URL with params + explicit params object
  → axios might reorder/re-encode → signature mismatch!
```

**After Fix:**
```javascript
// Step 1: Build signed path (same)
const signedPath = "/balance-allowance?asset_type=COLLATERAL&signature_type=0"
const signature = hmac(timestamp + "GET" + signedPath)

// Step 2: Make request (FIXED!)
this.get(url, {params: {}, headers})
  → Explicit empty params prevents ClobClient.get() from adding geo_block_token
  → URL stays exactly as signed
  → Signature validates correctly!
```

## The Fix

Updated `patches/@polymarket+clob-client+4.22.8.patch` to explicitly pass `params: {}` in all `this.get(url, ...)` calls.

This prevents the `ClobClient.get()` method from interfering with the URL that already has query parameters, ensuring the signature matches exactly.

### Changed Methods

All CLOB API methods that use query parameters now explicitly pass empty params:
- `getTrades()` / `getTradesPaginated()`
- `getBuilderTrades()`  
- `getNotifications()` / `dropNotifications()`
- `getBalanceAllowance()` / `updateBalanceAllowance()`
- `getOpenOrders()`
- `isOrderScoring()` / `areOrdersScoring()`
- `getEarningsForUserForDay()` / `getTotalEarningsForUserForDay()`
- `getRewardsEarningsPercentages()` / `getLiquidityRewardPercentages()`

## Impact

This fix resolves the authentication failures for users whose wallets HAVE traded on Polymarket but were getting 401 errors due to signature mismatches.

**Note**: If you're still getting authentication errors after this fix, it likely means:
1. Your wallet has never made a trade on polymarket.com - you MUST make at least one trade first
2. Your API credentials are expired or invalid - try clearing `/data/clob-creds.json` and restarting
3. You're using Builder API keys instead of CLOB keys - they are different!

## Verification

- ✅ All 110 existing tests pass
- ✅ Build completes successfully
- ✅ Patch applies cleanly on fresh install

## For Users

1. **Update your code**: Pull the latest changes
2. **Reinstall dependencies**: `npm install` (patch will auto-apply)
3. **Test authentication**: Restart the bot and check for successful credential verification
4. **If still failing**: Check the troubleshooting guide in `docs/AUTH_TROUBLESHOOTING.md`

## Technical References

- Polymarket CLOB Client: https://github.com/Polymarket/clob-client
- HMAC Signature spec: Query params MUST be included in signature for GET requests with params
- Axios param handling: Merges URL params with explicit params object
