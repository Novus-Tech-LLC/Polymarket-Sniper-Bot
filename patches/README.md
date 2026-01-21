# Patch Package Notes

## Active Patches

### @polymarket/clob-client@5.2.1

This patch includes two critical fixes:

#### Fix 1: Request Canonicalization for CLOB Authentication

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

#### Fix 2: createOrDeriveApiKey() Workaround

**Purpose**: Fix API key derivation order to prevent failures when keys already exist

**Problem**: The `createOrDeriveApiKey()` method tries to create a new API key first, then falls back to deriving. When an API key already exists, `createApiKey()` fails, causing the entire method to fail before attempting `deriveApiKey()`.

**Solution**:

- Changed `createOrDeriveApiKey()` to try `deriveApiKey()` first (for existing keys)
- Only falls back to `createApiKey()` if derivation fails (for new wallets)
- Uses try-catch pattern for proper error handling

**Result**: Existing wallets can successfully derive their API keys without errors.

**References**:

- [Polymarket/clob-client#202](https://github.com/Polymarket/clob-client/issues/202)
- [Polymarket/clob-client#209](https://github.com/Polymarket/clob-client/issues/209)
- [IQAIcom/mcp-polymarket#37](https://github.com/IQAIcom/mcp-polymarket/pull/37)

**Files modified**:

- `dist/client.js`: Added `buildCanonicalQueryString()` helper, patched `getBalanceAllowance()` and `createOrDeriveApiKey()` methods
