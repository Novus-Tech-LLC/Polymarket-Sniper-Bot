# Auth Diagnostics System

## Overview

This repository implements a **high-signal, low-noise authentication diagnostic system** for the Polymarket CLOB API. It produces a single "Auth Story" JSON block per run with:

- **Correlation IDs** (runId, reqId, attemptId)
- **Deduplication** (60s window) - no spam logs
- **Secret Redaction** - only shows last 4-6 chars, hashes, and lengths
- **HMAC Signature Diagnostics** - traces signing vs HTTP request mismatches
- **Root-Cause Hypotheses** - actionable diagnostics for common failure modes

## Quick Start

### Run Auth Probe

```bash
# Basic auth probe (exit 0 on success, 1 on failure)
npm run auth:probe

# With HMAC diagnostic tracing
ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe

# With debug logging
LOG_LEVEL=debug npm run auth:probe

# Combined (full diagnostic mode)
ENABLE_HMAC_DIAGNOSTICS=true LOG_LEVEL=debug npm run auth:probe
```

### Check for Secret Leakage

```bash
# Run lint check for console.log and secret leakage
npm run check:secrets

# Run lint check + ESLint
npm run lint:secrets
```

## Architecture

### Core Components

1. **Auth Story Builder** (`src/clob/auth-story.ts`)
   - Centralized tracking of authentication attempts
   - Single JSON output per run
   - Deduplication logic
   - State transition tracking (prints summary only on auth state change)

2. **Auth Logger** (`src/utils/auth-logger.ts`)
   - Correlation IDs (runId, reqId, attemptId)
   - Deduplication (60s window)
   - Secret redaction functions
   - Credential fingerprinting

3. **Structured Logger** (`src/utils/structured-logger.ts`)
   - JSON and pretty output formats
   - Log categories (STARTUP, IDENTITY, CRED_DERIVE, SIGN, HTTP, PREFLIGHT, SUMMARY)
   - Built-in deduplication (5s window)
   - Secret redaction in context objects

4. **HMAC Diagnostic Interceptor** (`src/utils/hmac-diagnostic-interceptor.ts`)
   - Tracks HMAC signing inputs vs actual HTTP requests
   - Detects path/method mismatches (common cause of 401s)
   - Logs diagnostic data on 401 errors
   - Enabled via `ENABLE_HMAC_DIAGNOSTICS=true`

5. **HMAC Signature Override** (`src/utils/hmac-signature-override.ts`)
   - Monkey-patches `@polymarket/clob-client` HMAC signing
   - Logs exact signing inputs (with secret hashed)
   - Enables correlation with HTTP interceptor
   - Enabled via `DEBUG_HMAC_SIGNING=true`

### Scripts

- **`scripts/auth-probe.ts`** - Main auth diagnostic command
- **`scripts/lint-check-secrets.sh`** - Enforces no console.log, no secret leakage

## Auth Story Format

### Example Success

```json
{
  "runId": "run_1234567890_abc123",
  "selectedMode": "EOA",
  "selectedSignatureType": 0,
  "signerAddress": "0x1234...",
  "makerAddress": "0x1234...",
  "effectiveAddress": "0x1234...",
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "derivedCredFingerprint": {
    "apiKeySuffix": "abc123",
    "secretLen": 64,
    "passphraseLen": 32,
    "secretEncodingGuess": "base64"
  },
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x1234...",
      "maker": "0x1234...",
      "funder": undefined,
      "verifyEndpoint": "/balance-allowance",
      "signedPath": "/balance-allowance",
      "usedAxiosParams": false,
      "httpStatus": 200,
      "success": true
    }
  ],
  "finalResult": {
    "authOk": true,
    "readyToTrade": true,
    "reason": "Authentication successful"
  },
  "onchainTxs": [],
  "onchainBlocked": false
}
```

### Example Failure (401)

```json
{
  "runId": "run_1234567890_abc123",
  "selectedMode": "EOA",
  "selectedSignatureType": 0,
  "signerAddress": "0x1234...",
  "makerAddress": "0x1234...",
  "effectiveAddress": "0x1234...",
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "derivedCredFingerprint": {
    "apiKeySuffix": "abc123",
    "secretLen": 64,
    "passphraseLen": 32,
    "secretEncodingGuess": "base64"
  },
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x1234...",
      "maker": "0x1234...",
      "funder": undefined,
      "verifyEndpoint": "/balance-allowance",
      "signedPath": "/balance-allowance",
      "usedAxiosParams": false,
      "httpStatus": 401,
      "errorTextShort": "Unauthorized",
      "success": false
    }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "Authentication failed - see attempts above"
  },
  "onchainTxs": [],
  "onchainBlocked": true
}
```

## Root Cause Analysis

The auth probe automatically provides diagnostic analysis for common failure modes:

### 401 Unauthorized

**Most Likely Causes:**
1. HMAC signature mismatch (check secret encoding, message format, timestamp)
2. Invalid API credentials (try deleting `.polymarket-credentials-cache.json`)
3. Wallet address mismatch (L1 auth header != actual wallet)
4. Wrong signature type (browser wallets need `POLYMARKET_SIGNATURE_TYPE=2` + `POLYMARKET_PROXY_ADDRESS`)

**Diagnostic Steps:**
```bash
# Enable HMAC diagnostics to trace signing vs HTTP request
ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe

# Detect correct wallet configuration (existing command)
npm run wallet:detect

# Delete credential cache and re-derive
rm -f .polymarket-credentials-cache.json
npm run auth:probe
```

### 403 Forbidden

**Possible Causes:**
1. Account restricted or banned by Polymarket
2. Geographic restrictions (VPN/geoblock issue)
3. Rate limiting (too many failed auth attempts)

### 400 Bad Request

**Possible Causes:**
1. Wallet has not traded on Polymarket yet
   - **Solution:** Visit https://polymarket.com and make at least one trade
   - The first trade creates your CLOB API credentials on-chain

## Environment Variables

### Auth Configuration

- `PRIVATE_KEY` - EOA private key (required)
- `POLYMARKET_SIGNATURE_TYPE` - Signature type (0=EOA, 1=Proxy, 2=Safe)
- `POLYMARKET_PROXY_ADDRESS` - Proxy/Safe wallet address (required for sig type 1 or 2)
- `CLOB_HOST` - CLOB API host (default: https://clob.polymarket.com)

### Diagnostic Flags

- `ENABLE_HMAC_DIAGNOSTICS=true` - Enable HMAC signature tracing
- `DEBUG_HMAC_SIGNING=true` - Log exact HMAC signing inputs
- `LOG_LEVEL=debug` - Enable debug logging
- `LOG_FORMAT=pretty` - Human-readable logs (default: json)

## Guardrails

### No Secret Leakage

- **Never** logs full private keys, API keys, secrets, or passphrases
- Only logs suffixes (last 4-6 chars), hashes, and lengths
- Automatic redaction in structured logger
- Lint check enforces no secret leakage

### No Spam Logs

- **Deduplication** - Repeated messages suppressed (60s window for auth logger, 5s for structured logger)
- **State Transitions** - Auth Story summary printed only on state changes (auth OK → failed or vice versa)
- **Single Output** - One Auth Story JSON block per run

### CI-Friendly

- **Exit Codes** - `auth:probe` exits 0 on success, 1 on failure
- **Lint Check** - `npm run check:secrets` exits 1 if violations found
- **Reproducible** - Same environment = same diagnostic output

## Integration

### In Your Code

```typescript
import { initAuthStory, getAuthStory } from './clob/auth-story';
import { getLogger } from './utils/structured-logger';

// Initialize auth story at start of auth flow
const authStory = initAuthStory({
  runId: generateRunId(),
  signerAddress: wallet.address,
  clobHost: 'https://clob.polymarket.com',
  chainId: 137,
});

// Track attempts
authStory.addAttempt({
  attemptId: 'A',
  mode: 'EOA',
  sigType: 0,
  l1Auth: wallet.address,
  maker: wallet.address,
  funder: undefined,
  verifyEndpoint: '/balance-allowance',
  signedPath: '/balance-allowance',
  usedAxiosParams: false,
  httpStatus: 200,
  success: true,
});

// Set final result
authStory.setFinalResult({
  authOk: true,
  readyToTrade: true,
  reason: 'Authentication successful',
});

// Print summary (deduplicated - only on state transitions)
authStory.printSummary();
```

### Use Structured Logger

```typescript
import { getLogger } from './utils/structured-logger';

const logger = getLogger();

// Logs are automatically deduplicated and redacted
logger.info('Authentication attempt', {
  category: 'PREFLIGHT',
  attemptId: 'A',
  httpStatus: 200,
});
```

## Testing

```bash
# Run auth probe
npm run auth:probe

# Run with diagnostics
ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe

# Check for secret leakage
npm run check:secrets

# Run full test suite
npm test
```

## Definition of Done

- ✅ One Auth Story JSON block per run
- ✅ No spam logs (deduplication + state transitions)
- ✅ No secrets leaked (only suffixes, hashes, lengths)
- ✅ HMAC diagnostic tracing available (`ENABLE_HMAC_DIAGNOSTICS=true`)
- ✅ Exit code 0/1 for CI (`auth:probe`)
- ✅ Lint check blocks console.log and secret leakage (`check:secrets`)
- ✅ Root-cause hypotheses for 401/403/400 errors

## Troubleshooting

### Q: Auth probe exits 1 but I don't see why

**A:** Run with debug logging:
```bash
LOG_LEVEL=debug npm run auth:probe
```

### Q: I'm getting 401 but credentials look correct

**A:** Enable HMAC diagnostics to trace signing vs HTTP request:
```bash
ENABLE_HMAC_DIAGNOSTICS=true LOG_LEVEL=debug npm run auth:probe
```

Check for path mismatches in the output.

### Q: How do I know if my wallet needs POLYMARKET_SIGNATURE_TYPE=2?

**A:** Run wallet detection:
```bash
npm run wallet:detect
```

If you used a browser wallet (MetaMask, WalletConnect) to create your Polymarket account, you need:
```bash
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=<your-proxy-wallet-address>
```

### Q: Lint check fails with console.log violations

**A:** Replace `console.log` with structured logger:
```typescript
// Before
console.log('Auth attempt', status);

// After
import { getLogger } from '../utils/structured-logger';
const logger = getLogger();
logger.info('Auth attempt', { category: 'PREFLIGHT', status });
```

## Further Reading

- [AUTH_STORY_README.md](./AUTH_STORY_README.md) - Auth Story implementation guide
- [GAS_WASTE_PREVENTION_README.md](./GAS_WASTE_PREVENTION_README.md) - How auth failures block on-chain txs
- [RUNBOOK.md](./RUNBOOK.md) - Full operational runbook
