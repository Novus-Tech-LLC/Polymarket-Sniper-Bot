# Auth Story - Expected Output Format

This document describes the **Auth Story** format - a single, structured summary of authentication attempts that replaces noisy runtime logs.

## Design Goals

1. **One Run => One Summary** - Each authentication run produces ONE consolidated summary block
2. **No Secrets** - Only safe identifiers: suffixes (last 4-6 chars), hashes, and lengths
3. **Minimal Noise** - Repeated identity dumps and header-presence spam eliminated
4. **Root-Cause Clarity** - Users immediately see what went wrong and how to fix it
5. **CI-Friendly** - Exit code 0/1 for automated testing

## Auth Story Structure

```json
{
  "runId": "run_1234567890_a1b2c3d4",
  "selectedMode": "EOA|SAFE|PROXY",
  "selectedSignatureType": 0,
  "signerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "makerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "funderAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "effectiveAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "derivedCredFingerprint": {
    "apiKeySuffix": "abc123",
    "secretLen": 88,
    "passphraseLen": 64,
    "secretEncodingGuess": "base64"
  },
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      "maker": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      "funder": null,
      "verifyEndpoint": "/auth/api-key",
      "signedPath": "/auth/api-key",
      "usedAxiosParams": false,
      "httpStatus": 200,
      "success": true
    },
    {
      "attemptId": "B",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      "maker": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      "funder": null,
      "verifyEndpoint": "/balance-allowance",
      "signedPath": "/balance-allowance?asset_type=COLLATERAL",
      "usedAxiosParams": false,
      "httpStatus": 401,
      "errorCode": "HMAC_MISMATCH",
      "errorTextShort": "Invalid api key",
      "success": false
    }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "Credential verification failed: 401 Unauthorized - HMAC signature mismatch"
  },
  "onchainTxs": [],
  "onchainBlocked": true
}
```

## Human-Readable Summary Output

### Success Case

```
========================================================
AUTH STORY SUMMARY
========================================================
Identity Configuration:
  selectedMode: EOA
  selectedSignatureType: 0
  signerAddress: 0x742d35...f0bEb
  makerAddress: 0x742d35...f0bEb
  effectiveAddress: 0x742d35...f0bEb

CLOB Configuration:
  clobHost: https://clob.polymarket.com
  chainId: 137

Derived Credential Fingerprint:
  apiKeySuffix: abc123
  secretLen: 88
  passphraseLen: 64
  secretEncodingGuess: base64

Authentication Attempts: 2
  [A] ✅ SUCCESS
  [B] ✅ SUCCESS

On-chain Transactions: None

Final Result: ✅
  authOk: true
  readyToTrade: true
  reason: Authentication successful - ready to trade
========================================================
```

### Failure Case (401 - HMAC Mismatch)

```
========================================================
AUTH STORY SUMMARY
========================================================
Identity Configuration:
  selectedMode: EOA
  selectedSignatureType: 0
  signerAddress: 0x742d35...f0bEb
  makerAddress: 0x742d35...f0bEb
  effectiveAddress: 0x742d35...f0bEb

CLOB Configuration:
  clobHost: https://clob.polymarket.com
  chainId: 137

Derived Credential Fingerprint:
  apiKeySuffix: abc123
  secretLen: 88
  passphraseLen: 64
  secretEncodingGuess: base64

Authentication Attempts: 2
  [A] ✅ SUCCESS (credential derivation)
  [B] ❌ FAILED (401 Unauthorized - Invalid api key)

⛔ On-chain Transactions: BLOCKED (auth failed)
   Reason: CLOB API auth failed - no on-chain transactions were sent to prevent gas waste

Final Result: ❌
  authOk: false
  readyToTrade: false
  reason: Credential verification failed: 401 Unauthorized - HMAC signature mismatch

Root-cause analysis:
   401 Unauthorized - MOST LIKELY CAUSES:
   1. HMAC signature mismatch (check secret encoding, message format, timestamp)
   2. Invalid API credentials (try deleting .polymarket-credentials-cache.json and re-derive)
   3. Wallet address mismatch (L1 auth header != actual wallet)
   4. Wrong signature type (browser wallets need POLYMARKET_SIGNATURE_TYPE=2 + POLYMARKET_PROXY_ADDRESS)
   Run: npm run wallet:detect  # to identify correct configuration
========================================================
```

### Failure Case (Wallet Not Activated)

```
========================================================
AUTH STORY SUMMARY
========================================================
Identity Configuration:
  selectedMode: EOA
  selectedSignatureType: 0
  signerAddress: 0x742d35...f0bEb
  makerAddress: 0x742d35...f0bEb
  effectiveAddress: 0x742d35...f0bEb

CLOB Configuration:
  clobHost: https://clob.polymarket.com
  chainId: 137

Authentication Attempts: 1
  [A] ❌ FAILED (400 Bad Request - Could not create api key)

⛔ On-chain Transactions: BLOCKED (auth failed)
   Reason: CLOB API auth failed - no on-chain transactions were sent to prevent gas waste

Final Result: ❌
  authOk: false
  readyToTrade: false
  reason: Credential derivation failed: Wallet has not traded on Polymarket yet

Root-cause analysis:
   400 Bad Request - Wallet has not traded on Polymarket yet
   SOLUTION: Visit https://polymarket.com and make at least one trade
   The first trade creates your CLOB API credentials on-chain
========================================================
```

## Key Differences from Old Logs

### ❌ OLD (Noisy, Repeated):
```
[INFO] Identity resolved: EOA mode
[INFO] Signer address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[INFO] Maker address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[INFO] Funder address: undefined
[INFO] Effective address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[INFO] Attempting credential derivation
[INFO] Identity resolved: EOA mode
[INFO] Signer address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[INFO] Maker address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[ERROR] Auth failed: 401 Unauthorized
[ERROR] Invalid api key
[INFO] Identity resolved: EOA mode
[INFO] Signer address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
... (repeated 20+ times)
```

### ✅ NEW (Clean, Structured):
```
[INFO] [STARTUP] Starting auth probe
[INFO] [IDENTITY] Identity configuration signatureType=0 signerAddress=0x742d35...f0bEb
[INFO] [CRED_DERIVE] Attempting credential derivation via createOrDeriveApiKey()
[INFO] [CRED_DERIVE] Credentials obtained successfully apiKeySuffix=abc123 secretLength=88
[INFO] [PREFLIGHT] Verifying credentials with /balance-allowance
[ERROR] [PREFLIGHT] ❌ Credential verification failed httpStatus=401 error=Invalid api key
[ERROR] [SUMMARY] Root-cause analysis:
   401 Unauthorized - MOST LIKELY CAUSES:
   1. HMAC signature mismatch (check secret encoding, message format, timestamp)
   ...

========================================================
AUTH STORY SUMMARY
========================================================
... (single comprehensive summary as shown above)
```

## Implementation Requirements

### 1. Deduplication
- Identical log messages within 5-second window are suppressed
- Suppression counter emitted at DEBUG level: `(suppressed 15 identical log messages)`

### 2. Secret Redaction
- Private keys: `[REDACTED len=64]`
- API keys: `***abc123` (last 6 chars only)
- Secrets: `ab12...xy89 [len=88]` (first/last 4 chars)
- Signatures: `hash:a1b2c3d4` (SHA256 hash prefix)

### 3. Correlation IDs
- `runId`: Unique per preflight run (`run_1234567890_a1b2c3d4`)
- `reqId`: Unique per HTTP request (`req_1234567890_abc`)
- `attemptId`: Letter per auth attempt (`A`, `B`, `C`, `D`, `E`)

### 4. Log Categories
- `STARTUP`: Process initialization
- `IDENTITY`: Address/wallet type resolution
- `CRED_DERIVE`: Credential derivation
- `SIGN`: HMAC signature generation
- `HTTP`: HTTP request/response
- `PREFLIGHT`: Pre-flight checks
- `SUMMARY`: Final auth story summary

### 5. Exit Codes
- `0`: Authentication successful
- `1`: Authentication failed (with root-cause in Auth Story)

## Usage

```bash
# Run auth probe with structured logs (JSON)
npm run auth:probe

# Run auth probe with pretty logs (human-readable)
LOG_FORMAT=pretty npm run auth:probe

# Run auth probe with verbose diagnostics
LOG_LEVEL=debug npm run auth:probe

# Run auth probe in CI (JSON logs, exits 0/1)
npm run auth:probe | tee auth-probe.log
echo "Exit code: $?"
```

## Integration with Preflight

The `ensureTradingReady()` function in `preflight.ts` now:

1. Initializes an Auth Story at the start of each run
2. Adds attempts as they occur
3. Sets final result based on auth outcome
4. Prints the Auth Story summary once at the end
5. Does NOT print repeated identity dumps during execution

## State Transition Detection

The Auth Story summary is printed **only on state transitions**:
- First process start (always)
- Auth state change: `authOk` false→true or true→false

This prevents spam while ensuring users see critical changes immediately.
