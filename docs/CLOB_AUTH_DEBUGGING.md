# CLOB Authentication Debugging Guide

This document provides detailed information for debugging CLOB (Central Limit Order Book) authentication issues in the Polymarket bot.

## Quick Diagnosis

### Symptom: 401 "Unauthorized/Invalid api key"

**Most Common Causes:**
1. **Signature mismatch** - Query parameters not included in signed path
2. **Wrong signature type** - Using EOA credentials with Safe/Proxy signature type (or vice versa)
3. **Expired/invalid credentials** - API keys need regeneration
4. **Never traded** - Wallet hasn't made any trades on polymarket.com yet

### Symptom: 401 "Invalid L1 Request headers"

**Most Common Causes:**
1. **Wrong L1 auth address** - Using effective address instead of signer (or vice versa)
2. **Missing headers** - POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, or POLY_NONCE not set
3. **EIP-712 signature mismatch** - Signing with wrong address or nonce

## Environment Variables for Debugging

### CLOB_DEBUG_CANON

Enable detailed canonicalization logging for HTTP requests to CLOB API.

```bash
CLOB_DEBUG_CANON=true
```

**What it logs:**
- HTTP method (GET, POST, etc.)
- Base URL and request path
- Query parameters (raw object and serialized string)
- Full URL that will be sent
- Whether signature includes query string
- Path digest (SHA256 hash for correlation)
- Redacted auth headers (first 8 + last 4 characters)

**Example output:**
```
[ClobHttpClient][Canon] ===== Request Canonicalization =====
[ClobHttpClient][Canon] METHOD: GET
[ClobHttpClient][Canon] baseURL: https://clob.polymarket.com
[ClobHttpClient][Canon] config.url: /balance-allowance
[ClobHttpClient][Canon] config.params: {"asset_type":"COLLATERAL","signature_type":0}
[ClobHttpClient][Canon] serializedQuery: asset_type=COLLATERAL&signature_type=0
[ClobHttpClient][Canon] pathWithQuery: /balance-allowance?asset_type=COLLATERAL&signature_type=0
[ClobHttpClient][Canon] absoluteURL: https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=0
[ClobHttpClient][Canon] signatureIncludesQuery: true
[ClobHttpClient][Canon] pathDigest: a1b2c3d4e5f6g7h8 (SHA256 of 'GET/balance-allowance?asset_type=COLLATERAL&signature_type=0')
[ClobHttpClient][Canon] authHeaders: POLY_ADDRESS, POLY_SIGNATURE, POLY_API_KEY, POLY_PASSPHRASE
[ClobHttpClient][Canon] POLY_API_KEY: 12345678...abcd
[ClobHttpClient][Canon] POLY_SIGNATURE: 0x1234ab...ef89
```

### DEBUG_HTTP_HEADERS

Enable HTTP header logging (already exists in the codebase).

```bash
DEBUG_HTTP_HEADERS=true
```

**What it logs:**
- All HTTP request headers sent to CLOB API
- Redacted values (first 4 + last 4 characters only)

### CLOB_DERIVE_CREDS

Enable automatic credential derivation from wallet.

```bash
CLOB_DERIVE_CREDS=true
```

**What it does:**
- Attempts to derive existing API keys via `/auth/derive-api-key`
- Falls back to creating new keys via `/auth/api-key` if none exist
- Uses fallback ladder to try different signature types and L1 auth addresses
- Caches successful configuration in `/data/clob-creds.json`

## Debugging Workflow

### Step 1: Enable All Debug Flags

```bash
# .env
CLOB_DEBUG_CANON=true
DEBUG_HTTP_HEADERS=true
CLOB_DERIVE_CREDS=true
```

### Step 2: Clear Cached Credentials

```bash
rm -f data/clob-creds.json
```

### Step 3: Run Preflight Check

```bash
npm run preflight
```

### Step 4: Analyze Logs

Look for these key indicators:

#### ✅ Successful Authentication Flow

```
[CLOB][Auth] mode=MODE_B_DERIVED signatureType=0 walletMode="EOA (direct wallet)"
[CredDerive] Starting credential derivation with fallback system
[CredDerive] Attempt 1/5: A) EOA + signer auth
[CredDerive] ✅ Success: A) EOA + signer auth
[CLOB] derived creds derivedKeyDigest=abc123 derivedKeySuffix=xyz789 signatureType=0
[ClobHttpClient][Canon] pathWithQuery: /balance-allowance?asset_type=COLLATERAL&signature_type=0
[CLOB] Auth header presence: api_key:true secret:true passphrase:true signature:true
```

#### ❌ Signature Mismatch

```
[CLOB][Diag][Sign] pathSigned=/balance-allowance?asset_type=COLLATERAL&signature_type=0
[ClobHttpClient][Canon] pathWithQuery: /balance-allowance?asset_type=COLLATERAL
# PROBLEM: Query params missing from actual request!
```

**Solution**: Ensure patch is applied correctly:
```bash
npm install  # Should show "Applying patches..."
```

#### ❌ Wrong Signature Type

```
[CLOB][Auth] mode=MODE_B_DERIVED signatureType=2 walletMode="Gnosis Safe"
[CredDerive] Verification failed: 401 Unauthorized
# Using Safe signature type but wallet is actually EOA
```

**Solution**: 
1. Delete cached credentials: `rm data/clob-creds.json`
2. Let auto-detection find correct signature type
3. OR: Explicitly set `POLYMARKET_SIGNATURE_TYPE=0` for EOA

#### ❌ Wrong L1 Auth Address

```
[CredDerive] Attempt 2/5: B) Safe + effective auth
[CredDerive] ❌ Failed: Invalid L1 Request headers
[CredDerive] Immediately retrying with swapped L1 auth address
[CredDerive] Attempt 2/5: B) Safe + effective auth (swapped)
[CredDerive] ✅ Success
```

**Note**: This is normal behavior. The bot automatically swaps L1 auth address when it detects this error.

### Step 5: Verify Signed Path Matches Actual Request

The **invariant** for successful auth: `pathSigned` must equal `pathWithQuery`

**Check logs for these lines:**
```
[CLOB][Diag][Sign] pathSigned=/balance-allowance?asset_type=COLLATERAL&signature_type=0
[ClobHttpClient][Canon] pathWithQuery: /balance-allowance?asset_type=COLLATERAL&signature_type=0
```

If these don't match exactly, authentication will fail with 401.

### Step 6: Verify Credentials Work

```bash
# After successful derivation, test with:
npm test -- tests/arbitrage/clob-credential-handling.test.ts
```

## Common Issues and Solutions

### Issue: "Patch not applying"

**Symptoms:**
```
No patch files found
```

**Solution:**
```bash
# Verify patch file exists
ls -la patches/@polymarket+clob-client+5.2.1.patch

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Should see:
# > patch-package 8.0.1
# > Applying patches...
# > @polymarket/clob-client@5.2.1 ✔
```

### Issue: "Wallet never traded"

**Symptoms:**
```
[CredDerive] ❌ Failed: Could not create api key (wallet needs to trade first)
```

**Solution:**
1. Visit https://polymarket.com
2. Connect your wallet
3. Make at least one trade (even $1 is fine)
4. Wait for transaction to confirm
5. Restart bot

### Issue: "Cached credentials expired"

**Symptoms:**
```
[CLOB] Credential verification failed with all signature types
```

**Solution:**
```bash
rm data/clob-creds.json
npm run preflight  # Will re-derive
```

### Issue: "Builder API keys vs CLOB keys"

**Symptoms:**
Authentication succeeds for `/auth/derive-api-key` but fails for `/balance-allowance`.

**Note**: Builder API keys and CLOB API keys are **different**:
- **Builder keys**: For gasless transactions (`@polymarket/builder-relayer-client`)
- **CLOB keys**: For order book trading (`@polymarket/clob-client`)

**Solution**: Use `CLOB_DERIVE_CREDS=true` to get the correct CLOB keys.

## Advanced Debugging

### Test Canonical Query String Building

```typescript
// tests/utils/query-string.test.ts
import { canonicalQuery, buildSignedPath } from "./src/utils/query-string.util";

const params = {
  asset_type: "COLLATERAL",
  signature_type: 0,
};

const { queryString, keys } = canonicalQuery(params);
console.log("Query string:", queryString);
// Expected: "asset_type=COLLATERAL&signature_type=0" (sorted alphabetically)

const { signedPath } = buildSignedPath("/balance-allowance", params);
console.log("Signed path:", signedPath);
// Expected: "/balance-allowance?asset_type=COLLATERAL&signature_type=0"
```

### Test Signature Generation

```typescript
// Check what gets signed
import { buildAuthMessageComponents } from "./src/clob/diagnostics";

const timestamp = Math.floor(Date.now() / 1000);
const method = "GET";
const path = "/balance-allowance?asset_type=COLLATERAL&signature_type=0";

const components = buildAuthMessageComponents(timestamp, method, path);
console.log("Message components:", components);
// Expected: { timestamp, method, path, body: "" }

// Full message string format:
const messageString = `${timestamp}${method}${path}`;
console.log("Message string:", messageString);
// This is what gets HMAC-signed
```

### Verify Patch Applied Correctly

```bash
# Check that buildCanonicalQueryString helper exists
grep -A 5 "buildCanonicalQueryString" node_modules/@polymarket/clob-client/dist/client.js

# Check that getBalanceAllowance uses it
grep -A 15 "async getBalanceAllowance" node_modules/@polymarket/clob-client/dist/client.js

# Look for: buildCanonicalQueryString(_params)
# Look for: requestPath = queryString ? `${endpoint}?${queryString}` : endpoint
```

## Testing Checklist

Before reporting an issue, verify:

- [ ] Patch is applied (check with `grep buildCanonicalQueryString node_modules/@polymarket/clob-client/dist/client.js`)
- [ ] Cached credentials cleared (`rm data/clob-creds.json`)
- [ ] Debug flags enabled (`CLOB_DEBUG_CANON=true DEBUG_HTTP_HEADERS=true`)
- [ ] Wallet has traded on polymarket.com at least once
- [ ] Using correct wallet type (EOA, Safe, or Proxy)
- [ ] RPC endpoint is working (`npm run preflight` shows server time)
- [ ] Logs show `pathSigned` matches `pathWithQuery` exactly

## Getting Help

If authentication still fails after following this guide:

1. **Capture logs** with all debug flags enabled
2. **Redact sensitive info** (private keys, API keys, secrets)
3. **Include**:
   - Full log output from `npm run preflight`
   - Your `.env` configuration (redacted)
   - Wallet type (EOA, Gnosis Safe, or Proxy)
   - Whether wallet has traded before
4. **Open an issue** with the above information

## Security Notes

- Never share full API keys or secrets in logs/issues
- Logs with `CLOB_DEBUG_CANON=true` show redacted values only (first 8 + last 4 chars)
- Delete `/data/clob-creds.json` before sharing logs
- Ensure `.env` is in `.gitignore`
