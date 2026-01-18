# Patch Package Notes

## Active Patches

### @polymarket/clob-client@5.2.1

**Purpose**: Fix request canonicalization for CLOB authentication

**Problem**: The ClobClient library was creating HMAC signatures using only the endpoint path, but passing query parameters separately to axios. This caused a signature mismatch because:
1. The signature was computed on `/balance-allowance`
2. But axios sent the request to `/balance-allowance?asset_type=COLLATERAL&signature_type=0`
3. The server rejected with 401 "Unauthorized/Invalid api key"

**Solution**: 
- Added `buildCanonicalQueryString()` helper function that creates deterministic, sorted query strings
- Modified `getBalanceAllowance()` to:
  1. Build complete query string from params
  2. Include query string in `requestPath` passed to `createL2Headers` for signing
  3. Construct full URL manually (without using params object) to avoid axios re-serialization
  
**Result**: The signed path now exactly matches the actual HTTP request URL, ensuring signature validation succeeds.

**Files modified**:
- `dist/client.js`: Added helper function and patched `getBalanceAllowance()` method
