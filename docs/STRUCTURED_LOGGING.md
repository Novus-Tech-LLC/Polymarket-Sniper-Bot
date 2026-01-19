# Structured Logging and Authentication Diagnostics

## Overview

The bot now includes a comprehensive structured logging system that makes debugging authentication issues trivial. All logs include correlation IDs and can be output in JSON or human-readable format.

## Environment Variables

### Logging Configuration

- `LOG_FORMAT`: Output format
  - `json` (default): Structured JSON logs, one per line
  - `pretty`: Human-readable colored output
- `LOG_LEVEL`: Minimum log level to output
  - `error`: Only errors
  - `warn`: Warnings and errors
  - `info` (default): Info, warnings, and errors
  - `debug`: All logs including verbose diagnostics

### Authentication Configuration

- `CLOB_FORCE_WALLET_MODE`: Force specific wallet mode
  - `auto` (default): Auto-detect
  - `eoa`: Force EOA mode
  - `safe`: Force Gnosis Safe mode
  - `proxy`: Force proxy mode
- `CLOB_FORCE_SIGNATURE_TYPE`: Force signature type (0=EOA, 1=PROXY, 2=SAFE)

## Authentication Probe Command

Test authentication without running the full bot:

```bash
# Run auth probe with pretty output
LOG_FORMAT=pretty npm run clob:probe

# Run auth probe with JSON output
LOG_FORMAT=json npm run clob:probe

# Run with debug logging
LOG_LEVEL=debug npm run clob:probe

# Run matrix mode (tests all combinations)
DEBUG_PREFLIGHT_MATRIX=true npm run clob:matrix
```

## Example Log Output

### Pretty Format (LOG_FORMAT=pretty)

```
[INFO] [STARTUP] [run_1705623743672_a1b2c3d4] Starting authentication probe
[INFO] [IDENTITY] [run_1705623743672_a1b2c3d4] Auto-detected wallet mode: EOA walletMode=eoa signatureType=0
[INFO] [CRED_DERIVE] [run_1705623743672_a1b2c3d4] [attempt:A] Starting credential derivation attemptId=A mode=EOA sigType=0
[INFO] [CRED_DERIVE] [run_1705623743672_a1b2c3d4] [attempt:A] Credentials derived successfully
[DEBUG] [HTTP] [run_1705623743672_a1b2c3d4] [req_1705623743800_e5f6a7] Outgoing signed request method=GET fullUrl=https://clob.polymarket.com/balance-allowance signedPath=/balance-allowance?asset_type=COLLATERAL isSigned=true
[DEBUG] [HTTP] [run_1705623743672_a1b2c3d4] [req_1705623743800_e5f6a7] Response received (success) status=200 latencyMs=123
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] ========================================================
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] AUTH STORY SUMMARY
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] ========================================================
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] Identity Configuration: selectedMode=EOA selectedSignatureType=0 signerAddress=0x1234...5678
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] Authentication Attempts: 1
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4]   [A] ✅ SUCCESS mode=EOA sigType=0 httpStatus=200
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] Final Result: ✅ authOk=true readyToTrade=true reason=All checks passed
```

### JSON Format (LOG_FORMAT=json)

```json
{"timestamp":"2024-01-18T23:55:43.672Z","level":"info","message":"Starting authentication probe","context":{"runId":"run_1705623743672_a1b2c3d4","category":"STARTUP"}}
{"timestamp":"2024-01-18T23:55:43.680Z","level":"info","message":"Auto-detected wallet mode: EOA","context":{"runId":"run_1705623743672_a1b2c3d4","category":"IDENTITY","walletMode":"eoa","signatureType":0}}
{"timestamp":"2024-01-18T23:55:43.685Z","level":"info","message":"Starting credential derivation","context":{"runId":"run_1705623743672_a1b2c3d4","category":"CRED_DERIVE","attemptId":"A","mode":"EOA","sigType":0}}
{"timestamp":"2024-01-18T23:55:43.890Z","level":"info","message":"Credentials derived successfully","context":{"runId":"run_1705623743672_a1b2c3d4","category":"CRED_DERIVE","attemptId":"A"}}
{"timestamp":"2024-01-18T23:55:43.900Z","level":"debug","message":"Outgoing signed request","context":{"runId":"run_1705623743672_a1b2c3d4","category":"HTTP","reqId":"req_1705623743800_e5f6a7","method":"GET","fullUrl":"https://clob.polymarket.com/balance-allowance","isSigned":true}}
{"timestamp":"2024-01-18T23:55:44.023Z","level":"debug","message":"Response received (success)","context":{"runId":"run_1705623743672_a1b2c3d4","category":"HTTP","reqId":"req_1705623743800_e5f6a7","status":200,"latencyMs":123}}
{"timestamp":"2024-01-18T23:55:44.025Z","level":"info","message":"========================================================","context":{"runId":"run_1705623743672_a1b2c3d4","category":"SUMMARY"}}
{"timestamp":"2024-01-18T23:55:44.026Z","level":"info","message":"AUTH STORY SUMMARY","context":{"runId":"run_1705623743672_a1b2c3d4","category":"SUMMARY"}}
{"timestamp":"2024-01-18T23:55:44.027Z","level":"info","message":"Final Result: ✅","context":{"runId":"run_1705623743672_a1b2c3d4","category":"SUMMARY","authOk":true,"readyToTrade":true,"reason":"All checks passed"}}
```

## Example 401 Authentication Failure

```
[ERROR] [HTTP] [run_1705623743672_a1b2c3d4] [req_1705623743800_e5f6a7] Response error status=401 errorText=Invalid api key latencyMs=89
[WARN] [CRED_DERIVE] [run_1705623743672_a1b2c3d4] [attempt:A] Attempt failed errorCode=WRONG_KEY_TYPE httpStatus=401
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] AUTH STORY SUMMARY
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4]   [A] ❌ FAILED (WRONG_KEY_TYPE) mode=EOA sigType=0 httpStatus=401 errorTextShort=Invalid api key
[INFO] [SUMMARY] [run_1705623743672_a1b2c3d4] Final Result: ❌ authOk=false readyToTrade=false reason=Authentication failed
```

## Key Features

### 1. Correlation IDs

Every log entry includes correlation IDs for tracing:
- **RUN_ID**: Unique per execution (e.g., `run_1705623743672_a1b2c3d4`)
- **REQ_ID**: Unique per HTTP request (e.g., `req_1705623743800_e5f6a7`)
- **ATTEMPT_ID**: Unique per auth attempt (A, B, C, D, E)

### 2. Log Categories

Logs are tagged with categories for filtering:
- `STARTUP`: Application initialization
- `IDENTITY`: Wallet identity resolution
- `CRED_DERIVE`: Credential derivation
- `SIGN`: Message signing operations
- `HTTP`: HTTP requests and responses
- `PREFLIGHT`: Pre-flight checks
- `SUMMARY`: Authentication story summary

### 3. Automatic Deduplication

Repeated identical messages within a 5-second window are automatically suppressed:
```
[INFO] [IDENTITY] Wallet mode detected: EOA
(suppressed 3 repeats)
```

### 4. Secret Redaction

Sensitive data is automatically redacted:
- **Private keys**: `[REDACTED len=66]`
- **API keys**: `***abc123` (last 6 chars only)
- **Secrets**: `base...cret [len=88]` (first/last 4 chars + length)
- **Passphrases**: `pass...word` (first/last 4 chars)
- **Signatures**: `hash:a1b2c3d4` (SHA256 hash prefix only)

### 5. Auth Story Summary

At the end of each run, a comprehensive AUTH STORY is printed showing:
- Identity configuration (mode, signature type, addresses)
- Credential fingerprint (API key suffix, secret length/encoding)
- All authentication attempts (A..E) with results
- Final authentication status and reason

## Troubleshooting with Structured Logs

### Finding the Issue

1. **Look for the RUN_ID** in the logs to track a specific execution
2. **Check the SUMMARY** at the end for the complete authentication story
3. **Look for ERROR or WARN** logs with details about what failed
4. **Check HTTP logs** for request/response details (enable with `LOG_LEVEL=debug`)

### Common Issues

#### 401 Unauthorized
Check the AUTH STORY summary for:
- `errorCode=WRONG_KEY_TYPE`: Using wrong credentials (Builder vs CLOB keys)
- `errorCode=WRONG_SIGNATURE_TYPE`: Wrong signature type (0/1/2)
- `usedAxiosParams=true`: Bug - query params in wrong place

#### Wallet Not Activated
```
[A] ❌ FAILED (WALLET_NOT_ACTIVATED) errorTextShort=Could not create api key
```
Solution: Make at least one trade on Polymarket to activate the wallet.

#### Identity Mismatch
Check that all addresses in the Identity Configuration match:
```
Identity Configuration: signerAddress=0x1234...5678 makerAddress=0x1234...5678 effectiveAddress=0x1234...5678
```

## Filtering Logs

### Filter by Category (JSON format)
```bash
npm run clob:probe | jq 'select(.context.category == "HTTP")'
```

### Filter by Log Level
```bash
npm run clob:probe | jq 'select(.level == "error" or .level == "warn")'
```

### Filter by RUN_ID
```bash
npm run clob:probe | jq 'select(.context.runId == "run_1705623743672_a1b2c3d4")'
```

### Extract Auth Story Summary
```bash
npm run clob:probe | jq 'select(.context.category == "SUMMARY")'
```

## Integration with Existing Code

The structured logging system is fully backward compatible. All existing code continues to work with the old `Logger` interface. The new `StructuredLogger` is optional and can be adopted gradually.

To use structured logging in your code:

```typescript
import { getLogger } from "./utils/structured-logger";

const logger = getLogger();

// Simple logging
logger.info("Operation completed");

// With structured context
logger.info("Authentication succeeded", {
  category: "CRED_DERIVE",
  attemptId: "A",
  mode: "EOA",
  httpStatus: 200,
});

// Child logger with base context
const childLogger = logger.child({ 
  category: "HTTP",
  reqId: "req_123" 
});
childLogger.debug("Making request", { url: "https://api.example.com" });
```
