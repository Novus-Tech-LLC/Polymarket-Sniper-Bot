# Auth Diagnostic & Log Consolidation - Implementation Summary

## Overview

This implementation consolidates authentication logging to produce a single high-signal Auth Story summary per run, eliminates spam logs, redacts secrets, and enforces logging best practices through automated validation.

## Changes Made

### 1. Central Auth Logger (`src/utils/auth-logger.ts`)

**Purpose**: Centralized authentication logging with correlation IDs and deduplication.

**Features**:
- **Correlation IDs**: Every log has `runId`, `reqId`, and `attemptId` for tracing
- **Deduplication**: Suppresses repeated messages within 60-second window
- **Secret Redaction**: Automatic redaction of API keys, secrets, passphrases
- **Structured Output**: JSON-formatted logs compatible with log aggregation tools

**Key Functions**:
```typescript
// Create auth logger with run ID
const logger = new AuthLogger(runId);

// Log with automatic deduplication
logger.info("message", { category: "IDENTITY", reqId });

// Redact secrets safely
redactApiKey(apiKey)      // Returns: ***abc123
redactSecret(secret)      // Returns: [REDACTED len=64]
createCredentialFingerprint(creds)  // Safe credential metadata
```

### 2. Refactored Minimal Auth (`src/clob/minimal-auth.ts`)

**Changes**:
- ✅ Replaced all `console.log` with structured `AuthLogger`
- ✅ Added correlation IDs to every log statement
- ✅ Enhanced Auth Story with attempt details and fingerprints
- ✅ Automatic deduplication prevents repeated logs
- ✅ All secrets redacted before logging

**New Auth Story Format**:
```json
{
  "runId": "run_1705689453_abc123",
  "timestamp": "2026-01-19T18:00:00.000Z",
  "signerAddress": "0x9B98...5D1",
  "signatureType": 0,
  "funderAddress": undefined,
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "credentialsObtained": true,
  "derivedCredFingerprint": {
    "apiKeySuffix": "...8031",
    "secretLen": 64,
    "secretEncodingGuess": "base64url"
  },
  "verificationPassed": true,
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "httpStatus": 200,
      "success": true
    }
  ],
  "success": true,
  "durationMs": 1234
}
```

### 3. Enhanced Auth Probe (`scripts/minimal_auth_probe.ts`)

**Changes**:
- ✅ JSON-only output mode (default) for easy parsing
- ✅ Pretty mode for human readability (`AUTH_STORY_FORMAT=pretty`)
- ✅ Structured logs go to stderr, Auth Story to stdout
- ✅ CI-friendly exit codes (0=success, 1=failure)

**Usage**:
```bash
# JSON output (for parsing/CI)
npm run auth:probe

# Pretty output (for humans)
AUTH_STORY_FORMAT=pretty npm run auth:probe

# Parse JSON output
npm run auth:probe | jq '.success'
```

### 4. Logging Validation (`scripts/validate_auth_logging.ts`)

**Purpose**: Automated validation that auth files follow logging best practices.

**Checks**:
- ❌ **No console.log**: Detects direct console usage in auth files
- ❌ **No secrets**: Detects unredacted API keys, secrets, passphrases
- ✅ **Structured logging**: Enforces use of structured logger

**Usage**:
```bash
# Run validation
npm run auth:validate-logging

# Example output:
✅ All auth files pass logging validation!
   Checked 8 files

# Or if issues found:
❌ Found 3 logging violations:

📢 Console.log usage (2):
   src/clob/credential-derivation-v2.ts:45
     console.log("Deriving credentials...")

🔒 Potential secret leakage (1):
   src/utils/auth-diagnostic.util.ts:123
     logger.info(`API Key: ${apiKey}`)
```

### 5. ESLint Rules (`eslint.config.mjs`)

**Added strict rules for auth files**:
```javascript
{
  files: [
    'src/clob/credential-derivation-v2.ts',
    'src/clob/auth-fallback.ts',
    'src/utils/clob-auth-headers.util.ts',
    'src/utils/l1-auth-headers.util.ts',
    'src/utils/auth-diagnostic.util.ts',
    'src/infrastructure/clob-client.factory.ts',
  ],
  rules: {
    'no-console': 'error', // Block console.log in auth files
  },
}
```

### 6. Package Scripts (`package.json`)

**New script**:
```json
{
  "auth:validate-logging": "ts-node scripts/validate_auth_logging.ts"
}
```

## Benefits

### Before (Noisy Logs)
```
[CLOB] Auth mode=MODE_B_DERIVED signatureType=0...
[CLOB] Signer address: 0x9B98...
[CLOB] Effective address: 0x9B98...
[CLOB] Funder address: none
[CLOB] API key present: true
[CLOB] Secret present: true
[CLOB] Passphrase present: true
[CLOB] Auth header presence: POLY-SIGNATURE=present,...
[CLOB] Derived creds derivedKeyDigest=sha256:...
[CLOB] Auth attempt A: EOA mode, sigType=0
[CLOB] Request failed: 401 Unauthorized
[CLOB] Auth attempt B: SAFE mode, sigType=2
[CLOB] Request failed: 401 Unauthorized
...
```

### After (Single Auth Story)
```json
{
  "runId": "run_1705689453_abc123",
  "signerAddress": "0x9B98...5D1",
  "selectedMode": "EOA",
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "derivedCredFingerprint": {
    "apiKeySuffix": "...8031",
    "secretLen": 64
  },
  "attempts": [
    { "attemptId": "A", "mode": "EOA", "sigType": 0, "httpStatus": 401, "success": false }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "AUTH_FAILED: 401 Unauthorized"
  },
  "durationMs": 1234
}
```

## Key Improvements

### 1. Noise Reduction
- **Before**: 50+ log lines per auth attempt
- **After**: 1 JSON block per run

### 2. Secret Safety
- **Before**: API keys, secrets visible in logs
- **After**: All secrets redacted (only suffix/length shown)

### 3. Deduplication
- **Before**: Same message repeated 10+ times
- **After**: One log + suppression counter

### 4. Correlation
- **Before**: No way to trace related logs
- **After**: Every log has `runId`, `reqId`, `attemptId`

### 5. Validation
- **Before**: Manual code review required
- **After**: Automated validation catches violations

## Testing

### Run Auth Probe
```bash
# Test JSON output
npm run auth:probe

# Test pretty output
AUTH_STORY_FORMAT=pretty npm run auth:probe

# Verify exit code
npm run auth:probe && echo "Success" || echo "Failed"
```

### Run Validation
```bash
# Check logging practices
npm run auth:validate-logging

# Run ESLint
npm run lint
```

### Expected Output (Success)
```json
{
  "runId": "run_1737316800_a1b2c3",
  "timestamp": "2026-01-19T18:00:00.000Z",
  "success": true,
  "signerAddress": "0x9B98...5D1",
  "signatureType": 0,
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "credentialsObtained": true,
  "derivedCredFingerprint": {
    "apiKeySuffix": "...8031",
    "secretLen": 64,
    "secretEncodingGuess": "base64url"
  },
  "verificationPassed": true,
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "httpStatus": 200,
      "success": true
    }
  ],
  "durationMs": 1234
}
```

### Expected Output (Failure)
```json
{
  "runId": "run_1737316800_x9y8z7",
  "timestamp": "2026-01-19T18:00:00.000Z",
  "success": false,
  "signerAddress": "0x9B98...5D1",
  "signatureType": 0,
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "credentialsObtained": true,
  "derivedCredFingerprint": {
    "apiKeySuffix": "...8031",
    "secretLen": 64,
    "secretEncodingGuess": "base64url"
  },
  "verificationPassed": false,
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "httpStatus": 401,
      "errorTextShort": "Unauthorized/Invalid api key",
      "success": false
    }
  ],
  "errorMessage": "Verification failed: 401 Unauthorized",
  "durationMs": 1234
}
```

## CI Integration

### Pre-commit Hook (Recommended)
```bash
# .git/hooks/pre-commit
#!/bin/bash
npm run auth:validate-logging || exit 1
```

### GitHub Actions
```yaml
- name: Validate Auth Logging
  run: npm run auth:validate-logging

- name: Run Auth Probe
  run: npm run auth:probe
  env:
    PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}
```

## File Checklist

✅ Created:
- `src/utils/auth-logger.ts` - Central auth logger with deduplication
- `scripts/validate_auth_logging.ts` - Automated logging validation

✅ Modified:
- `src/clob/minimal-auth.ts` - Refactored to use structured logger
- `scripts/minimal_auth_probe.ts` - Enhanced with JSON-only output
- `eslint.config.mjs` - Added no-console rule for auth files
- `package.json` - Added auth:validate-logging script

✅ Constraints Met:
- ✅ No changes to core auth logic (credential derivation, signing)
- ✅ Minimal changes (only logging/diagnostic code)
- ✅ Preserved existing Auth Story structure
- ✅ Used existing structured logger from `src/utils/structured-logger.ts`

## Rollback Plan

If issues arise:
```bash
# Revert changes
git revert <commit-hash>

# Or disable validation temporarily
# Comment out in package.json:
# "auth:validate-logging": "..."
```

## Future Enhancements

1. **Add request tracing**: Include full HTTP request/response in Auth Story for 401s
2. **Add metrics**: Track auth success rate, latency, error types
3. **Add alerting**: Notify on repeated auth failures
4. **Add caching**: Cache successful auth configs to speed up subsequent attempts

## Contact

For questions or issues with auth diagnostics:
- Check Auth Story JSON output first
- Run `npm run auth:validate-logging` to check for violations
- Enable debug logging: `LOG_LEVEL=debug npm run auth:probe`
