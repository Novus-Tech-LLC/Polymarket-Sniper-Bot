# HMAC Signature Diagnostic Fix

## Problem

User reports **401 "Unauthorized/Invalid api key"** errors, but the wallet **HAS TRADED** on Polymarket successfully, ruling out "wallet not registered" as the cause.

The diagnostic data shows:

```
signatureType: 0
walletAddress: 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
apiKey: 68fef732...8031
secret: VqBuE3p6...B2E= (length=44)
passphrase: 5f7e...3308
secretEncoding: likely base64url (hasBase64Chars=false hasBase64UrlChars=true hasPadding=true)
```

## Root Cause Hypotheses (Ranked by Likelihood)

Since the wallet has traded, the credentials are **valid** but we're **computing the signature incorrectly**:

1. **Query param canonicalization bug** - The signed `requestPath` doesn't match the actual HTTP request path
2. **Secret encoding mismatch** - base64url vs base64 decoding issue (though clob-client already normalizes this)
3. **Wrong signature type** - Should be 1 or 2 for browser/Safe wallet instead of 0
4. **Timestamp drift** - Clock skew between client and server
5. **Body encoding issue** - JSON serialization differences

## Solution: HMAC Diagnostic Instrumentation

### What This Fix Does

Implements **surgical diagnostic tracing** to capture the **exact mismatch** between what we sign vs what we send:

1. **HMAC Signature Override** (`src/utils/hmac-signature-override.ts`)
   - Wraps `buildPolyHmacSignature` from `@polymarket/clob-client`
   - Logs exact signing inputs: timestamp, method, requestPath, body, secret (hashed)
   - Tracks inputs in-memory for correlation with HTTP requests

2. **HTTP Request Interceptor** (`src/utils/hmac-diagnostic-interceptor.ts`)
   - Axios interceptor that captures outgoing requests
   - Compares signed path vs actual path
   - Compares signed method vs actual method
   - On 401 errors, outputs a structured diagnostic

3. **Integration** (`src/infrastructure/clob-client.factory.ts`)
   - Installs both diagnostics when `ENABLE_HMAC_DIAGNOSTICS=true`
   - Zero overhead when disabled (default)

### How to Use

#### 1. Run the diagnostic test script:

```bash
ENABLE_HMAC_DIAGNOSTICS=true \
DEBUG_HMAC_SIGNING=true \
node scripts/test-hmac-diagnostic.js
```

#### 2. Review the output

**If there's a path mismatch, you'll see:**

```
[WARN] [HmacDiag] MISMATCH DETECTED:
  Signed path:  /balance-allowance?asset_type=COLLATERAL&signature_type=0
  Actual path:  /balance-allowance?signature_type=0&asset_type=COLLATERAL
  Signed method: GET
  Actual method: GET
```

**On 401, you'll get the full diagnostic:**

```json
{
  "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "actualPath": "/balance-allowance?signature_type=0&asset_type=COLLATERAL",
  "pathMatch": false,
  "signedMethod": "GET",
  "actualMethod": "GET",
  "methodMatch": true,
  "bodyHash": null,
  "secretHash": "a3f8b2c1d4e5f6g7",
  "timestamp": "1705680000",
  "signature": "Ab3Cd4Ef..."
}
```

### Expected Outcome

This diagnostic will reveal the **exact discrepancy** between signing inputs and HTTP requests. The most likely findings:

1. **Query param ordering mismatch** - We sign with params in one order, axios sends in another
2. **Missing/extra query params** - The patch may not apply to all endpoints
3. **Signature type mismatch** - The API expects a different signature type than we're using

### Fix Strategy Based on Diagnostic Output

#### If path mismatch is detected:

The patch in `patches/@polymarket+clob-client+5.2.1.patch` already fixes `getBalanceAllowance`, but may need to be extended to **all endpoints** that include query parameters.

**Action**: Extend `buildCanonicalQueryString` to all L2 auth endpoints in the patch.

#### If signature type is wrong:

The diagnostic shows `signatureType: 0` (EOA), but if the wallet was created via browser, it should be `2` (POLY_GNOSIS_SAFE).

**Action**: Set `POLYMARKET_SIGNATURE_TYPE=2` and `POLYMARKET_PROXY_ADDRESS=<your-proxy-address>`.

#### If secret encoding is wrong:

The HMAC function already normalizes base64url → base64 (lines 8-11 in `hmac.js`), but we can test alternative encodings.

**Action**: None needed - already handled by official client.

### Files Changed

1. **src/utils/hmac-diagnostic-interceptor.ts** (NEW)
   - HTTP interceptor for correlation
   - Auth Story diagnostic generator

2. **src/utils/hmac-signature-override.ts** (NEW)
   - Wraps buildPolyHmacSignature
   - Tracks signing inputs

3. **src/infrastructure/clob-client.factory.ts** (MODIFIED)
   - Installs diagnostics on client creation
   - Gated by `ENABLE_HMAC_DIAGNOSTICS` env var

4. **scripts/test-hmac-diagnostic.js** (NEW)
   - Standalone test harness
   - Reproduces 401 with full tracing

### Environment Variables

- `ENABLE_HMAC_DIAGNOSTICS=true` - Enable diagnostic interceptors
- `DEBUG_HMAC_SIGNING=true` - Log every HMAC signing operation
- `RUN_ID=<uuid>` - Optional correlation ID for Auth Story

### Security Notes

✅ **Secrets are hashed (SHA256) before logging** - No raw secrets in logs  
✅ **Only first/last chars of keys shown** - Redacted by default  
✅ **Diagnostic mode is opt-in** - Zero overhead when disabled

### Next Steps

1. Run the diagnostic script with user's credentials
2. Capture the exact mismatch from output
3. Implement targeted fix based on diagnostic results
4. Re-run to confirm fix

---

## Auth Story Output Format

When a 401 occurs, the system generates a single-line Auth Story:

```json
{
  "run_id": "test-20250119",
  "attempt": {
    "timestamp": "1705680000",
    "method": "GET",
    "requestPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    "statusCode": 401,
    "secretHash": "a3f8b2c1d4e5f6g7"
  }
}
```

This replaces the noisy log spam with a **single, actionable diagnostic line**.

---

## Definition of Done

✅ One run produces one Auth Story summary  
✅ Exact signing inputs vs HTTP request captured  
✅ No secret leakage in logs  
✅ Minimal performance overhead (gated by env var)  
✅ Reproducible test harness (scripts/test-hmac-diagnostic.js)
