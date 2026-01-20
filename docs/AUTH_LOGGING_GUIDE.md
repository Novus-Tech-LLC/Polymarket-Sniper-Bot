# Auth Diagnostic System - Developer Guide

## Overview

This repository implements a **structured logging system** for authentication diagnostics that replaces noisy, repeated logs with a single comprehensive "Auth Story" per run.

## Key Components

### 1. Structured Logger (`src/utils/structured-logger.ts`)

Central logger with:
- **Correlation IDs**: `runId`, `reqId`, `attemptId`
- **Deduplication**: 5-second window for identical messages
- **Secret Redaction**: Automatic removal of sensitive data
- **Categories**: `STARTUP`, `IDENTITY`, `CRED_DERIVE`, `SIGN`, `HTTP`, `PREFLIGHT`, `SUMMARY`
- **Formats**: JSON (default) or pretty (human-readable)

```typescript
import { getLogger } from '../utils/structured-logger';

const logger = getLogger();

// Basic logging
logger.info('Starting auth', { category: 'STARTUP' });

// With context
logger.error('Auth failed', { 
  category: 'PREFLIGHT',
  httpStatus: 401,
  errorCode: 'HMAC_MISMATCH'
});
```

### 2. Auth Story (`src/clob/auth-story.ts`)

Consolidated auth summary that tracks:
- Identity configuration (signer, maker, funder, effective address)
- All authentication attempts with HTTP status and errors
- Credential fingerprints (no secrets - only suffixes/hashes/lengths)
- On-chain transactions (Safe/Proxy deployments, approvals)
- Final result with actionable reason

```typescript
import { initAuthStory } from '../clob/auth-story';

const authStory = initAuthStory({
  runId: generateRunId(),
  signerAddress: wallet.address,
  clobHost: 'https://clob.polymarket.com',
  chainId: 137
});

// Set identity
authStory.setIdentity({
  orderIdentity: { ... },
  l1AuthIdentity: { ... }
});

// Add attempts
authStory.addAttempt({
  attemptId: 'A',
  mode: 'EOA',
  sigType: 0,
  httpStatus: 401,
  errorTextShort: 'Invalid api key',
  success: false
});

// Set final result
authStory.setFinalResult({
  authOk: false,
  readyToTrade: false,
  reason: 'Credential verification failed: 401 Unauthorized'
});

// Print summary (ONE TIME at the end)
authStory.printSummary();
```

### 3. Auth Probe (`scripts/auth-probe-minimal.ts`)

Standalone diagnostic tool:
- Runs ONE auth attempt (derive + verify)
- Produces ONE Auth Story summary
- Exits with code 0 (success) or 1 (failure)
- CI-friendly

```bash
# Run auth probe
npm run auth:probe

# With verbose debug logs
LOG_LEVEL=debug npm run auth:probe

# With pretty formatting
LOG_FORMAT=pretty npm run auth:probe
```

### 4. Secret Leakage Prevention

**ESLint Rules** (`eslint.config.mjs`):
- Blocks `console.log` in auth-related files (use structured logger instead)
- Warns about potential secret logging in string literals

**Secret Check Script** (`scripts/check-no-secrets.sh`):
```bash
# Check for secret leakage patterns
npm run check:secrets

# Run lint with secret check
npm run lint:secrets
```

**Automatic Redaction** (in `structured-logger.ts`):
- `privateKey` → `[REDACTED len=64]`
- `apiKey` → `***abc123` (last 6 chars only)
- `secret` → `ab12...xy89 [len=88]` (first/last 4 chars)
- `passphrase` → `pass...word [len=24]` (first/last 4 chars)
- `signature` → `hash:a1b2c3d4` (SHA256 hash prefix)

## Usage Patterns

### Pattern 1: Preflight Checks (`src/polymarket/preflight.ts`)

```typescript
// Initialize auth story at START of run
const runId = generateRunId();
const authStory = initAuthStory({ runId, signerAddress, clobHost, chainId });

// Set identity ONCE
authStory.setIdentity({ orderIdentity, l1AuthIdentity });

// Add attempts as they occur
authStory.addAttempt({ attemptId: 'A', httpStatus: 200, success: true });
authStory.addAttempt({ attemptId: 'B', httpStatus: 401, success: false });

// Set final result ONCE at end
authStory.setFinalResult({ authOk: false, readyToTrade: false, reason: 'AUTH_FAILED' });

// Print summary ONCE at end
authStory.printSummary();
```

### Pattern 2: Credential Derivation

```typescript
const logger = getLogger();

// Log once at start
logger.info('Attempting credential derivation', { 
  category: 'CRED_DERIVE',
  attemptId: 'A'
});

try {
  const creds = await client.createOrDeriveApiKey();
  
  // Log success with fingerprint (NO SECRETS)
  logger.info('Credentials obtained', {
    category: 'CRED_DERIVE',
    apiKeySuffix: creds.key.slice(-6),
    secretLength: creds.secret.length
  });
  
  // Add to auth story
  authStory.setCredentialFingerprint(createCredentialFingerprint(creds));
  
} catch (error) {
  // Log error once
  logger.error('Credential derivation failed', {
    category: 'CRED_DERIVE',
    httpStatus: error.response?.status,
    error: error.message
  });
}
```

### Pattern 3: HMAC Diagnostics

```typescript
// Track signing inputs (NO SECRETS in logs)
logger.debug('HMAC signature generation', {
  category: 'SIGN',
  method: 'POST',
  path: '/auth/api-key',
  timestamp: Date.now(),
  secretHash: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8)
});

// On 401, log mismatch (safe to log paths/methods)
logger.warn('HMAC signature mismatch', {
  category: 'HTTP',
  signedPath: '/auth/api-key',
  actualPath: '/auth/api-key?some=param',
  pathMatch: false
});
```

## Anti-Patterns (DO NOT DO)

❌ **Repeated Identity Dumps**
```typescript
// BAD: Logs identity on every function call
function authenticate() {
  logger.info(`Signer: ${signerAddress}`);
  logger.info(`Maker: ${makerAddress}`);
  logger.info(`Funder: ${funderAddress}`);
  // ... repeated 20+ times in logs
}
```

✅ **Log Identity ONCE**
```typescript
// GOOD: Log identity once at initialization
authStory.setIdentity({ orderIdentity, l1AuthIdentity });
// Identity is in the Auth Story summary at the end
```

---

❌ **Logging Full Secrets**
```typescript
// BAD: Exposes secrets in logs
logger.debug(`API Key: ${creds.key}`);
logger.debug(`Secret: ${creds.secret}`);
```

✅ **Log Fingerprints Only**
```typescript
// GOOD: Redacted fingerprint
logger.debug('Credentials obtained', {
  category: 'CRED_DERIVE',
  apiKeySuffix: creds.key.slice(-6),  // Last 6 chars only
  secretLength: creds.secret.length    // Length only
});
```

---

❌ **Using console.log in Auth Files**
```typescript
// BAD: Bypasses structured logging
console.log('Starting auth');
console.error('Auth failed:', error);
```

✅ **Use Structured Logger**
```typescript
// GOOD: Structured, deduplicated, redacted
const logger = getLogger();
logger.info('Starting auth', { category: 'STARTUP' });
logger.error('Auth failed', { category: 'PREFLIGHT', error: error.message });
```

---

❌ **Printing Summary Multiple Times**
```typescript
// BAD: Prints Auth Story on every retry
for (let i = 0; i < 5; i++) {
  await attemptAuth();
  authStory.printSummary(); // NO!
}
```

✅ **Print Summary ONCE**
```typescript
// GOOD: Print summary once at the end
for (let i = 0; i < 5; i++) {
  await attemptAuth();
  authStory.addAttempt({ ... });
}
authStory.printSummary(); // Once at end
```

## Debugging Tips

### 1. Enable Debug Logs
```bash
LOG_LEVEL=debug npm run auth:probe
```

### 2. Use Pretty Format
```bash
LOG_FORMAT=pretty npm run auth:probe
```

### 3. Check for Secret Leakage
```bash
npm run check:secrets
```

### 4. View Deduplication Stats
```typescript
// Suppressed logs appear as:
// (suppressed 15 identical log messages)
```

### 5. Correlation IDs
All logs include `runId` for tracing a single preflight run:
```json
{
  "timestamp": "2025-01-19T12:34:56.789Z",
  "level": "error",
  "message": "Auth failed",
  "context": {
    "runId": "run_1234567890_a1b2c3d4",
    "attemptId": "A",
    "category": "PREFLIGHT"
  }
}
```

## Testing

### Unit Tests
```bash
npm test -- tests/arbitrage/auth-story.test.ts
```

### Integration Tests
```bash
# Test auth probe with mock credentials
PRIVATE_KEY=0x1234... npm run auth:probe

# Expect exit code 1 (failure) and Auth Story JSON
```

### CI/CD
```bash
# Run in CI with JSON logs
LOG_FORMAT=json npm run auth:probe | tee auth-probe.log

# Check exit code
if [ $? -eq 0 ]; then
  echo "Auth passed"
else
  echo "Auth failed - see auth-probe.log"
fi
```

## Migration Guide

### From Old Logger to Structured Logger

**Before:**
```typescript
console.log('[INFO] Starting auth');
console.error('[ERROR] Auth failed', error);
```

**After:**
```typescript
import { getLogger } from '../utils/structured-logger';

const logger = getLogger();
logger.info('Starting auth', { category: 'STARTUP' });
logger.error('Auth failed', { category: 'PREFLIGHT', error: error.message });
```

### From Repeated Logs to Auth Story

**Before:**
```typescript
// Logs identity 20+ times
logger.info(`Signer: ${signerAddress}`);
logger.info(`Maker: ${makerAddress}`);
// ... repeated on every function call
```

**After:**
```typescript
// Log identity ONCE in Auth Story
authStory.setIdentity({ orderIdentity, l1AuthIdentity });
// ... at end:
authStory.printSummary(); // Identity appears in summary
```

## Guardrails

### 1. ESLint Enforcement
- `no-console: error` in auth files
- Warns about potential secret logging

### 2. Secret Check Script
- Runs on every CI build
- Blocks PRs with secret leakage

### 3. Automatic Redaction
- Structured logger redacts secrets automatically
- No way to bypass (unless using console.log directly, which is blocked)

### 4. State Transition Detection
- Auth Story summary prints only on state change (auth success → fail or fail → success)
- Prevents spam while ensuring users see critical changes

## FAQ

**Q: Why can't I use console.log?**
A: `console.log` bypasses structured logging, deduplication, and secret redaction. Use `getLogger()` instead.

**Q: How do I log a secret safely?**
A: Use fingerprints:
```typescript
logger.debug('Credential check', {
  apiKeySuffix: creds.key.slice(-6),  // Last 6 chars
  secretLength: creds.secret.length,   // Length only
  // Note: Even hash prefixes should be used judiciously in production
  secretHash: crypto.createHash('sha256').update(creds.secret).digest('hex').slice(0, 8)
});
```

**Q: Why is my log not appearing?**
A: Check:
1. Log level (`LOG_LEVEL=debug` to see debug logs)
2. Deduplication (identical logs within 5 seconds are suppressed)
3. Category filtering (use correct category)

**Q: How do I trace a single run?**
A: Every log has a `runId`. Search logs by `runId` to see all logs from one preflight run.

**Q: Can I disable deduplication?**
A: Deduplication is always on (5-second window). If you need repeated logs, change the message slightly.

## References

- [AUTH_STORY_EXAMPLE.md](./AUTH_STORY_EXAMPLE.md) - Example Auth Story output
- [src/utils/structured-logger.ts](./src/utils/structured-logger.ts) - Structured logger implementation
- [src/clob/auth-story.ts](./src/clob/auth-story.ts) - Auth Story implementation
- [scripts/auth-probe-minimal.ts](./scripts/auth-probe-minimal.ts) - Auth probe command
- [scripts/check-no-secrets.sh](./scripts/check-no-secrets.sh) - Secret leakage checker
