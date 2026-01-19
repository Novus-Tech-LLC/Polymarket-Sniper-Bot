# Auth Diagnostic Report - 2025-01-19

## Auth Story Summary

```json
{
  "runId": "UNKNOWN",
  "selectedMode": "EOA",
  "selectedSignatureType": 0,
  "signerAddress": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  "makerAddress": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  "funderAddress": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  "effectiveAddress": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "derivedCredFingerprint": {
    "apiKeySuffix": "...8031",
    "secretLen": 44,
    "passphraseLen": 8,
    "secretEncodingGuess": "base64url"
  },
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
      "maker": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
      "funder": "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1",
      "verifyEndpoint": "/balance-allowance",
      "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
      "usedAxiosParams": false,
      "httpStatus": 401,
      "errorTextShort": "Unauthorized/Invalid api key",
      "success": false
    }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "401 Unauthorized/Invalid api key - Credentials failed verification"
  }
}
```

---

## Root Cause Hypotheses

### **Hypothesis 1: API Key Not Registered (70% probability)**

**Evidence**:
- Error message is "Unauthorized/Invalid api key" (not "invalid signature")
- All auth headers are present (apiKey, passphrase, secret, signature)
- Credentials appear well-formed (base64url secret, proper lengths)

**Mechanism**:
The derived API key `68fef732...8031` does not exist in Polymarket's CLOB backend database.

**Possible Reasons**:
1. **Wallet has never traded**: Polymarket requires at least one on-chain trade before API credentials can be derived
2. **Cached credentials are stale**: Key was revoked/expired, but local cache still has old values
3. **Wrong derivation config**: Key was created with different signatureType (1 or 2) but we're using 0
4. **L1 auth mismatch**: Key was created with a different L1 auth address during initial derivation

**How to Confirm**:
```bash
# Check if wallet has any CLOB orders
curl "https://clob.polymarket.com/orders?maker=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1"

# Try deriving with L1 auth (should create new key if none exists)
npm run auth:probe -- --force-derive
```

---

### **Hypothesis 2: HMAC Signature Mismatch (20% probability)**

**Evidence**:
- Secret encoding is base64url with padding (length=44)
- Query params are included in signed path
- Complex canonicalization logic for query strings

**Mechanism**:
The HMAC signature computed locally (using `secret`) doesn't match what the server computes, even though the API key is valid.

**Possible Reasons**:
1. **Query string ordering bug**: Server uses different param order than our canonicalization
2. **URL encoding mismatch**: Special characters encoded differently
3. **Timestamp drift**: Local timestamp differs from what server accepts
4. **Secret encoding bug**: Secret is base64url, but we're treating it as base64

**How to Confirm**:
```bash
# Enable debug canonicalization logging
CLOB_DEBUG_CANON=true npm run auth:probe

# Check logs for:
# - signedPath vs actualPath mismatch
# - messageHash differences
# - encoding issues in query params
```

---

### **Hypothesis 3: Wrong API Key Selected (10% probability)**

**Evidence**:
- Credential caching system in use
- Cache key based on signerAddress + signatureType + funderAddress

**Mechanism**:
Cached credentials belong to a different configuration (e.g., different signatureType or funderAddress).

**Possible Reasons**:
1. **Cache key collision**: Hash collision or insufficient cache key dimensions
2. **Multi-wallet pollution**: Previous run with different wallet left stale cache
3. **Config drift**: Environment variables changed but cache wasn't cleared

**How to Confirm**:
```bash
# Clear cache and re-derive
rm -rf .credentials-cache
npm run auth:probe -- --force-derive
```

---

## Highest-Leverage Diagnostic Change

### **Enable HTTP Request/Response Tracing**

**Goal**: Capture the exact HTTP request sent to CLOB and the exact response body.

**Implementation**: The `auth-http-trace.util.ts` module already exists, but may not be enabled in the failing code path.

**Required Changes**:

1. **Enable tracing in `verifyCredentials` function** (`credential-derivation-v2.ts`):

```typescript
// Before calling client.getBalanceAllowance(), create trace
const trace = traceAuthRequest({
  method: "GET",
  url: `${POLYMARKET_API.BASE_URL}${signedPath}`,
  endpoint: "/balance-allowance",
  params: queryParams,
  signedPath,
  headers: headers as Record<string, string>,
  signatureInput: {
    timestamp,
    method: "GET",
    path: signedPath,
  },
});

// After getting response/error
if (errorResponse.status === 401 || errorResponse.status === 403) {
  recordAuthResponse(trace, {
    status: errorResponse.status,
    error: errorResponse.error,
  });
  printAuthTrace(trace, params.structuredLogger);
}
```

2. **Capture full error response body** (not just error message):

```typescript
// In axios error handler
catch (error) {
  const status = extractStatusCode(error);
  const fullResponseBody = error.response?.data;
  
  logger.debug("Full error response", {
    category: "AUTH_ERROR",
    status,
    body: fullResponseBody, // May contain "key does not exist" or other details
  });
}
```

3. **Add response body to AuthRequestTrace**:

```typescript
export interface AuthRequestTrace {
  // ... existing fields ...
  
  responseBody?: unknown; // Full response body for 401/403
}
```

---

## Expected Output After Change

### **Scenario A: Key Not Registered**

```json
{
  "category": "AUTH_HTTP_TRACE",
  "reqId": "req_abc123",
  "method": "GET",
  "url": "https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "actualPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "pathMismatch": false,
  "status": 401,
  "errorMessage": "Unauthorized/Invalid api key",
  "responseBody": {
    "error": "Unauthorized/Invalid api key",
    "code": "KEY_NOT_FOUND",
    "message": "API key 68fef732...8031 does not exist in database"
  }
}
```

→ **Action**: Force credential creation with L1 auth (POST /auth/api-key)

---

### **Scenario B: Signature Mismatch**

```json
{
  "category": "AUTH_HTTP_TRACE",
  "reqId": "req_xyz789",
  "method": "GET",
  "url": "https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "actualPath": "/balance-allowance?signature_type=0&asset_type=COLLATERAL",
  "pathMismatch": true,
  "status": 401,
  "errorMessage": "Unauthorized/Invalid api key",
  "responseBody": {
    "error": "Unauthorized",
    "code": "INVALID_SIGNATURE",
    "message": "HMAC signature verification failed"
  }
}
```

→ **Action**: Fix query param canonicalization in `canonicalQuery()`

---

### **Scenario C: Wrong Secret Encoding**

```json
{
  "category": "AUTH_HTTP_TRACE",
  "reqId": "req_def456",
  "signatureInput": {
    "timestamp": 1737404123,
    "method": "GET",
    "path": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
    "messageHash": "a1b2c3d4e5f6g7h8"
  },
  "responseBody": {
    "error": "Unauthorized",
    "code": "INVALID_SIGNATURE",
    "expectedSignature": "abc123...",
    "receivedSignature": "def456..."
  }
}
```

→ **Action**: Check secret encoding (base64 vs base64url) in HMAC computation

---

## Immediate Next Steps

1. **Enable HTTP tracing** in `verifyCredentials()` (10 minutes)
2. **Run auth probe** with tracing enabled:
   ```bash
   CLOB_DEBUG_CANON=true LOG_LEVEL=debug npm run auth:probe
   ```
3. **Analyze trace output** to identify which scenario matches
4. **Take corrective action** based on scenario

---

## Long-Term Fixes

### **1. Prevent Log Spam**
- ✅ Already implemented: Rate-limited auth failure logging
- ✅ Already implemented: Credential fingerprint deduplication
- ✅ Already implemented: Single-flight derivation

### **2. Improve Error Messages**
- Add specific error codes (KEY_NOT_FOUND, INVALID_SIGNATURE, etc.)
- Map Polymarket error responses to actionable user messages

### **3. Add Retry Logic**
- Retry on transient failures (network, timeout)
- Don't retry on permanent failures (invalid key, signature mismatch)

### **4. Add CI Check**
- Run `auth:probe` in CI to catch auth regressions early
- Use mock CLOB server for deterministic testing

---

## Summary

**One Line**: 401 "Invalid api key" → most likely the API key doesn't exist in Polymarket's database, need to create it with L1 auth first.

**One Change**: Enable HTTP request/response tracing in `verifyCredentials()` to capture exact error response body.

**One Test**: Run `npm run auth:probe -- --force-derive --clear-cache` to force fresh credential creation.
