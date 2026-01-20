# Auth Story - Quick Start

## What Problem Does This Solve?

**Before**: Users experiencing 401 auth errors saw 1000+ lines of noisy logs with repeated identity dumps and no clear root-cause.

**After**: Users see ONE comprehensive "Auth Story" summary with clear diagnostics and actionable fix suggestions.

## Example

### Old Logs (Noisy)
```
[INFO] Identity resolved: EOA mode
[INFO] Signer address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[INFO] Identity resolved: EOA mode
[INFO] Signer address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
[ERROR] Auth failed: 401 Unauthorized
... (repeated 20+ times)
```

### New Logs (Clean)
```
[INFO] [STARTUP] Starting auth probe
[INFO] [CRED_DERIVE] Credentials obtained apiKeySuffix=abc123
[ERROR] [PREFLIGHT] Verification failed httpStatus=401

========================================================
AUTH STORY SUMMARY
========================================================
Authentication Attempts: 2
  [A] ✅ SUCCESS (credential derivation)
  [B] ❌ FAILED (401 Unauthorized)

Root-cause analysis:
   1. HMAC signature mismatch
   2. Wrong signature type
   3. Wallet address mismatch
========================================================
```

## Quick Start

### Run Auth Probe
```bash
npm run auth:probe
```

### Fix 401 Errors
1. Delete cache: `rm .polymarket-credentials-cache.json`
2. Detect wallet type: `npm run wallet:detect`
3. Set correct config and restart

### Check for Secret Leakage
```bash
npm run check:secrets
```

## Key Features

✅ **One Summary Per Run** - No repeated identity dumps  
✅ **No Secrets in Logs** - Automatic redaction  
✅ **Root-Cause Analysis** - Clear diagnostics for 401/400/403  
✅ **95% Log Reduction** - 1000+ lines → ~50 lines  
✅ **CI-Friendly** - Exit code 0/1 for automation  

## Documentation

- **Quick Reference**: [AUTH_STORY_QUICKREF.md](AUTH_STORY_QUICKREF.md)
- **Developer Guide**: [docs/AUTH_LOGGING_GUIDE.md](docs/AUTH_LOGGING_GUIDE.md)
- **Examples**: [AUTH_STORY_EXAMPLE.md](AUTH_STORY_EXAMPLE.md)
- **Implementation**: [IMPLEMENTATION_AUTH_STORY.md](IMPLEMENTATION_AUTH_STORY.md)
- **Delivery Summary**: [DELIVERY_SUMMARY.md](DELIVERY_SUMMARY.md)
