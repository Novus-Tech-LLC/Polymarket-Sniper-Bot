# Polymarket CLOB Authentication Implementation Guide

## Overview

This document explains how Polymarket CLOB authentication works in this bot, covering L1 (API key derivation) and L2 (order/query authentication) flows, with special focus on Gnosis Safe and Proxy wallet modes.

## Authentication Layers

### L1 Authentication (API Key Derivation/Creation)

**Purpose:** Create or derive API credentials for a wallet

**Endpoints:**
- `POST /auth/api-key` - Create new API key
- `GET /auth/derive-api-key` - Derive existing API key

**Required Headers:**
```
POLY_ADDRESS: <signer_eoa_address>
POLY_SIGNATURE: <eip712_signature>
POLY_TIMESTAMP: <unix_timestamp_seconds>
POLY_NONCE: 0
```

**Key Points:**
1. **Always uses signer EOA address** - Even in Safe/Proxy mode, POLY_ADDRESS is the EOA that signs
2. **EIP-712 typed data signature** - Not HMAC
3. **Nonce is always 0** for L1 auth
4. **No L2 headers** - Must NOT include POLY_API_KEY or POLY_PASSPHRASE

**EIP-712 Domain & Types:**
```typescript
domain = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137  // Polygon mainnet
}

types = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" }
  ]
}

value = {
  address: <signer_address>,
  timestamp: "<unix_timestamp>",
  nonce: 0,
  message: "This message attests that I control the given wallet"
}
```

**Implementation:** `src/utils/l1-auth-headers.util.ts::buildL1Headers()`

---

### L2 Authentication (CLOB API Requests)

**Purpose:** Authenticate API requests for orders, balance queries, trades, etc.

**Endpoints:** All authenticated CLOB API endpoints (e.g., `/balance-allowance`, `/orders`, `/trades`)

**Required Headers:**
```
POLY_ADDRESS: <effective_address>
POLY_SIGNATURE: <hmac_sha256_signature>
POLY_TIMESTAMP: <unix_timestamp_seconds>
POLY_API_KEY: <api_key>
POLY_PASSPHRASE: <api_passphrase>
```

**Key Points:**
1. **POLY_ADDRESS depends on signature type:**
   - EOA mode (signatureType=0): signer address
   - Safe mode (signatureType=2): funder/proxy address
   - Proxy mode (signatureType=1): funder/proxy address
2. **HMAC-SHA256 signature** using API secret (NOT EIP-712)
3. **No POLY_NONCE** - L2 uses timestamp only

**HMAC Signature Generation:**

```typescript
// 1. Build message string
message = timestamp + method + requestPath + [body]
// Example: "1700000000GET/balance-allowance?asset_type=COLLATERAL&signature_type=0"

// 2. Decode secret from base64
secretBytes = Buffer.from(apiSecret, "base64")

// 3. Compute HMAC-SHA256
hmac = crypto.createHmac("sha256", secretBytes)
digest = hmac.update(message).digest()

// 4. Encode as base64url (NOT standard base64!)
signature = digest.toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
```

**Critical Details:**
- **Query parameters MUST be included** in requestPath for GET requests
- Query params MUST be sorted alphabetically: `asset_type=X&signature_type=Y`
- URL encoding: keys and values both encoded
- Secret is base64-encoded (standard base64, not base64url)
- Signature output is base64url-encoded (+ → -, / → _)

**Implementation:**
- Signature: `@polymarket/clob-client/dist/signing/hmac.js::buildPolyHmacSignature()`
- Headers: `@polymarket/clob-client/dist/headers/index.js::createL2Headers()`
- Path building: `src/utils/query-string.util.ts::buildSignedPath()`

---

## Gnosis Safe / Proxy Mode

### Configuration

For wallets using browser login (creates Gnosis Safe proxy):

```bash
# Environment variables
PRIVATE_KEY=<your_eoa_private_key>                    # EOA that signs transactions
POLYMARKET_SIGNATURE_TYPE=2                            # 2 = Gnosis Safe, 1 = Proxy
POLYMARKET_PROXY_ADDRESS=<your_safe_proxy_address>    # The proxy/Safe address
```

### Address Usage

| Context | EOA Mode (sigType=0) | Safe Mode (sigType=2) | Proxy Mode (sigType=1) |
|---------|---------------------|----------------------|----------------------|
| **L1 Auth** | Signer address | Signer address | Signer address |
| **L2 POLY_ADDRESS** | Signer address | Funder address | Funder address |
| **Order maker** | Signer address | Funder address | Funder address |
| **Signature creation** | Signer key | Signer key | Signer key |

**Key Insight:** Safe/Proxy mode means:
- You sign with your EOA private key (PRIVATE_KEY)
- L1 auth uses your EOA address
- L2 requests use the Safe/Proxy address as POLY_ADDRESS
- Orders are placed as the Safe/Proxy address (maker/funder)

### Example: Safe Mode

```typescript
// Setup
const signerEOA = "0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1"  // Your EOA
const safeProxy = "0xb403364076a14e239452f0cb4273bd6814314ce3"  // Your Safe

// L1 Auth (derive API key)
POST /auth/derive-api-key
Headers:
  POLY_ADDRESS: 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1  ← Signer EOA
  POLY_SIGNATURE: 0x... (EIP-712 signed by signerEOA)
  POLY_TIMESTAMP: 1700000000
  POLY_NONCE: 0

// L2 Auth (balance query)
GET /balance-allowance?asset_type=COLLATERAL&signature_type=2
Headers:
  POLY_ADDRESS: 0xb403364076a14e239452f0cb4273bd6814314ce3  ← Safe Proxy
  POLY_SIGNATURE: abc123... (HMAC signature)
  POLY_TIMESTAMP: 1700000000
  POLY_API_KEY: api_key_here
  POLY_PASSPHRASE: passphrase_here
```

---

## Common Issues & Solutions

### Issue 1: "Invalid L1 Request headers" (401)

**Symptoms:** L1 endpoints (derive/create API key) return 401 with this message

**Cause:** L2 headers (POLY_API_KEY, POLY_PASSPHRASE) being sent to L1 endpoints

**Solution:**
- Ensure `createL1Headers()` is used (NOT `createL2Headers()`)
- Verify no code is adding credentials to L1 requests
- L1 endpoints should use wallet signer, not credentials

**Check:** `src/utils/l1-auth-headers.util.ts` - should return only 4 headers

---

### Issue 2: L2 requests fail with 401 (HMAC mismatch)

**Symptoms:** Balance queries, order submission return 401

**Common Causes:**

1. **Query parameters not included in signature**
   - Fix: Use `buildSignedPath()` to include query string in path
   - The patch in `patches/@polymarket+clob-client+4.22.8.patch` fixes this

2. **Wrong secret decoding**
   - Polymarket secrets are base64 (standard, not base64url)
   - Check for `+` or `/` characters (base64) vs `-` or `_` (base64url)
   - Module auto-detects: `src/clob/diagnostics.ts::detectSecretDecodingMode()`

3. **Wrong POLY_ADDRESS in Safe mode**
   - Must use funder/proxy address for L2, not signer
   - Identity resolver handles this: `src/clob/identity-resolver.ts`

4. **Query parameter ordering**
   - Must be sorted alphabetically
   - Implementation: `src/utils/query-string.util.ts::buildSignedPath()`

---

### Issue 3: "Could not create api key" (400)

**Symptoms:** L1 createApiKey returns 400 with this message

**Cause:** Wallet has never made a trade on Polymarket

**Solution:**
1. Visit polymarket.com
2. Connect your wallet
3. Make at least one trade (any amount)
4. Try again - the bot will derive credentials successfully

---

## Testing Authentication

### Smoke Test Script

Run the standalone smoke test to verify auth works:

```bash
# Basic EOA mode
export PRIVATE_KEY=0x...
ts-node scripts/clob_auth_smoke_test.ts

# Safe mode with funder
export PRIVATE_KEY=0x...
export CLOB_SIGNATURE_TYPE=2
export CLOB_FUNDER=0x...
ts-node scripts/clob_auth_smoke_test.ts
```

**What it tests:**
1. Environment validation
2. Wallet connection
3. L1 authentication (derive/create API key)
4. L2 authentication (balance-allowance query)
5. Outputs "AUTH OK" if all pass

---

### Unit Tests

Run unit tests for auth components:

```bash
# All auth-related tests
npm test

# Specific test suites
npm test -- tests/arbitrage/l1-vs-l2-headers.test.ts
npm test -- tests/arbitrage/l2-signature-message.test.ts
npm test -- tests/arbitrage/l1-auth-headers.test.ts
```

---

## Credential Caching

**Cache File:** `/data/clob-creds.json`

**Format:**
```json
{
  "key": "api_key_here",
  "secret": "base64_secret_here",
  "passphrase": "passphrase_here",
  "signatureType": 0,
  "signerAddress": "0x...",
  "funderAddress": "0x...",
  "usedEffectiveForL1": false,
  "cachedAt": "2024-01-18T09:00:00.000Z"
}
```

**Behavior:**
1. On startup, bot loads cached credentials
2. Verifies them with `/balance-allowance`
3. If valid, uses cached credentials (skip derivation)
4. If invalid (401/403), clears cache and re-derives
5. Saves newly derived credentials to cache

**Manual Clear:**
```bash
rm /data/clob-creds.json
# Bot will re-derive on next startup
```

---

## Fallback Ladder

The bot tries multiple configurations if auth fails:

```typescript
const FALLBACK_LADDER = [
  { signatureType: 0, useEffectiveForL1: false },  // EOA + signer auth
  { signatureType: 2, useEffectiveForL1: false },  // Safe + signer auth
  { signatureType: 2, useEffectiveForL1: true },   // Safe + effective auth
  { signatureType: 1, useEffectiveForL1: false },  // Proxy + signer auth
  { signatureType: 1, useEffectiveForL1: true },   // Proxy + effective auth
];
```

**Implementation:** `src/clob/credential-derivation-v2.ts::deriveCredentialsWithFallback()`

**Behavior:**
1. Try each combination in order
2. On "Invalid L1 Request headers", immediately try swapping L1 auth address
3. Verify credentials with `/balance-allowance` before caching
4. Cache first successful combination
5. Skip subsequent attempts once one succeeds

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Application Layer                                   │
│  - src/app/main.ts                                  │
│  - src/arbitrage/runtime.ts                         │
└────────────────┬────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────┐
│ Client Factory                                      │
│  src/infrastructure/clob-client.factory.ts          │
│  - Creates ClobClient with credentials              │
│  - Handles derive vs explicit mode                  │
│  - Manages signature type detection                 │
└────────────────┬────────────────────────────────────┘
                 │
          ┌──────┴──────┐
          │             │
          v             v
┌──────────────┐  ┌──────────────────────────┐
│ L1 Auth      │  │ L2 Auth                  │
│ (Derive/     │  │ (Orders/Queries)         │
│  Create Key) │  │                          │
└──────┬───────┘  └──────────┬───────────────┘
       │                     │
       v                     v
┌──────────────────┐  ┌──────────────────────────┐
│ L1 Headers       │  │ L2 Headers               │
│ l1-auth-headers  │  │ @polymarket/clob-client  │
│  .util.ts        │  │  /headers/index.js       │
│                  │  │                          │
│ - EIP-712        │  │ - HMAC-SHA256            │
│ - 4 headers      │  │ - 5 headers              │
│ - Signer address │  │ - Effective address      │
└──────────────────┘  └────────┬─────────────────┘
                               │
                        ┌──────┴──────┐
                        │             │
                        v             v
              ┌──────────────┐  ┌──────────────┐
              │ Query String │  │ HMAC Signing │
              │ Builder      │  │ (with patch) │
              │ query-string │  │ diagnostics  │
              │  .util.ts    │  │  .ts         │
              └──────────────┘  └──────────────┘
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/utils/l1-auth-headers.util.ts` | Build EIP-712 L1 auth headers |
| `src/infrastructure/clob-client.factory.ts` | Main client creation & orchestration |
| `src/clob/credential-derivation-v2.ts` | Fallback ladder for credential derivation |
| `src/clob/identity-resolver.ts` | Resolve signer vs effective address |
| `src/clob/diagnostics.ts` | HMAC signing, secret decoding, diagnostics |
| `src/utils/query-string.util.ts` | Canonical query string for L2 signatures |
| `src/utils/credential-storage.util.ts` | Cache credentials to disk |
| `patches/@polymarket+clob-client+4.22.8.patch` | Fix query param handling |
| `scripts/clob_auth_smoke_test.ts` | Standalone auth test |

---

## Summary

✅ **L1 Auth (Derive/Create API Key):**
- Uses EIP-712 typed data signature
- Only 4 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE
- Always uses signer EOA address (even in Safe mode)
- Never includes POLY_API_KEY or POLY_PASSPHRASE

✅ **L2 Auth (Orders/Queries):**
- Uses HMAC-SHA256 signature with API secret
- 5 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
- POLY_ADDRESS is funder/proxy in Safe/Proxy mode, signer in EOA mode
- Query parameters MUST be included in signature message

✅ **Safe/Proxy Mode:**
- Signer EOA signs everything (L1 and L2)
- L1 uses signer address for POLY_ADDRESS
- L2 uses funder/proxy address for POLY_ADDRESS
- Orders placed as funder/proxy (maker address)

✅ **Implementation:**
- Patch correctly includes query params in L2 signatures
- Secret decoding auto-detects base64 vs base64url
- Fallback ladder tries multiple configurations
- Credentials cached and verified on startup
- Enhanced diagnostics on auth failures
