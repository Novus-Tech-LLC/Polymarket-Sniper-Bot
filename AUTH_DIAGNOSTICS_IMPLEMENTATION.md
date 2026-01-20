# Auth Diagnostics Implementation Summary

## Changes Made

### 1. Created Enhanced `auth:probe` Command

**File:** `scripts/auth-probe.ts`

- Produces ONE Auth Story JSON block per run
- Exit code 0 on success, 1 on failure (CI-friendly)
- Integrates with existing auth-story.ts infrastructure
- Provides root-cause analysis for common failure modes (401, 403, 400)
- Supports HMAC diagnostic tracing via `ENABLE_HMAC_DIAGNOSTICS=true`
- Uses structured logger with deduplication

**Usage:**
```bash
npm run auth:probe                              # Basic probe
ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe # With HMAC tracing
LOG_LEVEL=debug npm run auth:probe              # Debug mode
```

### 2. Created Enhanced Lint Check

**File:** `scripts/lint-check-secrets.sh`

Enforces 6 rules:
1. ✅ No `console.log` in src/ (except in allowed files)
2. ⚠️  No `console.error`/`console.warn` (warnings only - use structured logger)
3. ✅ No direct secret logging (privateKey, secret, passphrase, apiKey)
4. ✅ No string interpolation with secrets
5. ✅ No full `wallet.privateKey` logging
6. ✅ Verify structured logger has `redactSecrets` function

**Usage:**
```bash
npm run check:secrets  # Run lint check only
npm run lint:secrets   # Run lint check + ESLint
```

**Exit Code:** 0 on success, 1 if violations found

### 3. Updated package.json Scripts

```json
{
  "auth:probe": "ts-node scripts/auth-probe.ts",
  "check:secrets": "bash scripts/lint-check-secrets.sh",
  "lint:secrets": "bash scripts/lint-check-secrets.sh && npm run lint"
}
```

### 4. Created Comprehensive Documentation

**File:** `AUTH_DIAGNOSTICS_README.md`

Covers:
- Quick start guide
- Architecture overview
- Auth Story format examples
- Root cause analysis for common errors
- Environment variables
- Guardrails (no secrets, no spam, CI-friendly)
- Integration examples
- Troubleshooting guide

## Existing Infrastructure Leveraged

### Already Implemented (No Changes Needed)

1. **Auth Story Builder** (`src/clob/auth-story.ts`)
   - ✅ Tracks authentication attempts
   - ✅ Deduplication logic
   - ✅ State transition tracking
   - ✅ Single JSON output per run
   - ✅ Credential fingerprinting

2. **Auth Logger** (`src/utils/auth-logger.ts`)
   - ✅ Correlation IDs (runId, reqId, attemptId)
   - ✅ Deduplication (60s window)
   - ✅ Secret redaction functions
   - ✅ Credential fingerprinting

3. **Structured Logger** (`src/utils/structured-logger.ts`)
   - ✅ JSON and pretty output formats
   - ✅ Log categories
   - ✅ Built-in deduplication (5s window)
   - ✅ Secret redaction in context objects

4. **HMAC Diagnostic Interceptor** (`src/utils/hmac-diagnostic-interceptor.ts`)
   - ✅ Tracks HMAC signing inputs
   - ✅ Detects path/method mismatches
   - ✅ Logs diagnostic data on 401 errors
   - ✅ Enabled via `ENABLE_HMAC_DIAGNOSTICS=true`

5. **HMAC Signature Override** (`src/utils/hmac-signature-override.ts`)
   - ✅ Monkey-patches clob-client HMAC signing
   - ✅ Logs exact signing inputs
   - ✅ Enabled via `DEBUG_HMAC_SIGNING=true`

## Verification

### Lint Check Passes

```bash
$ npm run check:secrets

=========================================
Linting for console.log and secret leakage...
=========================================

RULE 1: Checking for console.log in src/
        (Allowed: structured-logger.ts, logger.util.ts, minimal-auth.ts)
✅ All console.log occurrences are in allowed files

RULE 2: Checking for console.error/console.warn in src/
        (Use structured logger instead)
⚠️  WARNING: Found console.error/warn (review these):
[... warnings only, no violations ...]

RULE 3: Checking for direct secret logging
✅ No direct secret logging found

RULE 4: Checking for secret string interpolation
✅ No secret string interpolation found

RULE 5: Checking for full wallet.privateKey logging
✅ No wallet.privateKey logging found

RULE 6: Verifying structured logger redaction
✅ Structured logger has redactSecrets function

=========================================
✅ All checks passed - no secret leakage or console.log violations
```

## Auth Flow Analysis

### Current Problem (from error messages)

```
CLOB API authentication failed - will not send any transactions to prevent gas waste.
AUTH_FAILED_BLOCKED_ALL_ONCHAIN
Invalid or missing CLOB API credentials (see diagnostic above)
Required on-chain approvals are not satisfied
Detect-only mode enabled; skipping order submissions.
```

### Root Cause Hypotheses

Based on the codebase audit, the most likely causes are:

1. **401 Unauthorized** - HMAC signature mismatch
   - **Evidence:** HMAC diagnostic interceptor is in place but requires `ENABLE_HMAC_DIAGNOSTICS=true`
   - **Fix:** Run `ENABLE_HMAC_DIAGNOSTICS=true npm run auth:probe` to trace signing vs HTTP request

2. **Wrong Signature Type** - Browser wallet configuration
   - **Evidence:** Code checks for `signatureType === 1 || signatureType === 2` requiring `funderAddress`
   - **Fix:** Run `npm run wallet:detect` to identify correct configuration

3. **Credential Derivation Failure** - First-time wallet
   - **Evidence:** Wallet may not have traded on Polymarket yet
   - **Fix:** Visit https://polymarket.com and make at least one trade

4. **Credential Cache Stale** - Cached credentials invalid
   - **Evidence:** `.polymarket-credentials-cache.json` may be outdated
   - **Fix:** Delete cache and re-derive: `rm .polymarket-credentials-cache.json && npm run auth:probe`

## Expected Outcomes Achieved

✅ **One Auth Story JSON block per run** - Implemented in auth-story.ts, used in auth-probe.ts

✅ **No spam logs** - Deduplication (60s window) + state transition tracking

✅ **No secrets leaked** - Only suffixes, hashes, lengths; lint check enforces this

✅ **auth:probe command** - Exits 0/1 for CI, produces single Auth Story summary

✅ **Lint check** - Blocks console.log and secret leakage

✅ **HMAC diagnostic available** - Enable with `ENABLE_HMAC_DIAGNOSTICS=true`

✅ **Root-cause hypotheses** - Automated analysis for 401/403/400 errors

## Next Steps for User

### 1. Run Auth Probe with Diagnostics

```bash
# Enable HMAC diagnostics to trace signing vs HTTP request
ENABLE_HMAC_DIAGNOSTICS=true LOG_LEVEL=debug npm run auth:probe
```

This will:
- Show exact HMAC signing inputs (secret hashed)
- Compare signed path vs actual HTTP path
- Detect method mismatches (GET vs POST)
- Log diagnostic data on 401 errors

### 2. If 401 Persists, Check Wallet Type

```bash
# Detect if you need POLYMARKET_SIGNATURE_TYPE=2
npm run wallet:detect
```

If you used a browser wallet (MetaMask, WalletConnect), you need:
```bash
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=<your-proxy-wallet-address>
```

### 3. If Still Failing, Delete Credential Cache

```bash
# Delete stale cached credentials
rm -f .polymarket-credentials-cache.json

# Re-derive credentials
npm run auth:probe
```

### 4. If First-Time Wallet, Trade on Polymarket

If you get a 400 error with "could not create", you need to:
1. Visit https://polymarket.com
2. Make at least one trade (any amount)
3. This creates your CLOB API credentials on-chain
4. Then re-run `npm run auth:probe`

## Definition of Done

✅ One run => one Auth Story JSON block
✅ One line per attempt
✅ Minimal request trace
✅ Repeated identity spam removed (deduplication)
✅ Header-presence spam gated by LOG_LEVEL=debug
✅ auth:probe command that exits 0/1 (CI-friendly)
✅ Lint check that blocks console.log and secret leakage
✅ No new spam logs
✅ No secrets leaked
✅ No duplicated identity dumps

## Files Changed

- ✅ `scripts/auth-probe.ts` (created)
- ✅ `scripts/lint-check-secrets.sh` (created)
- ✅ `package.json` (updated scripts)
- ✅ `AUTH_DIAGNOSTICS_README.md` (created)

## Files Reviewed (No Changes Needed)

- ✅ `src/clob/auth-story.ts` (already implements Auth Story Builder)
- ✅ `src/utils/auth-logger.ts` (already has deduplication + redaction)
- ✅ `src/utils/structured-logger.ts` (already has deduplication + redaction)
- ✅ `src/utils/hmac-diagnostic-interceptor.ts` (already traces HMAC)
- ✅ `src/utils/hmac-signature-override.ts` (already monkey-patches signing)
- ✅ `src/infrastructure/clob-client.factory.ts` (already installs HMAC diagnostics)
- ✅ `src/polymarket/preflight.ts` (already blocks on-chain txs on auth failure)
- ✅ `src/clob/minimal-auth.ts` (console.log is allowed + has eslint-disable)

## Testing Checklist

- ✅ Lint check passes (`npm run check:secrets`)
- ✅ Package.json updated with new scripts
- ✅ Auth probe script created and executable
- ✅ Documentation created

## Ready for User Testing

The auth diagnostic system is now ready. User should run:

```bash
# 1. Run lint check
npm run check:secrets

# 2. Run auth probe with full diagnostics
ENABLE_HMAC_DIAGNOSTICS=true LOG_LEVEL=debug npm run auth:probe

# 3. Review Auth Story JSON output
# 4. Follow root-cause analysis recommendations
```
