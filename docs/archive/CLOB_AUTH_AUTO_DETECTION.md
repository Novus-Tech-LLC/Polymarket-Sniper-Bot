# CLOB Authentication Auto-Detection & Fallback System

## Overview

This document describes the new auto-detection and fallback system for CLOB authentication that was implemented to fix persistent 401 "Unauthorized/Invalid api key" errors, especially in Safe/proxy wallet modes.

## Problem Statement

Users were stuck in DETECT-ONLY mode due to CLOB authentication failures. The issues included:

1. **401 Unauthorized** "Unauthorized/Invalid api key" on `/balance-allowance`
2. **401 Unauthorized** "Invalid L1 Request headers" on `/auth/derive-api-key` and `/auth/api-key`
3. **Configuration complexity**: `signerAddress != effective/maker/funder` address in Safe mode required complex manual configuration
4. **No fallback**: System would fail on first auth attempt without trying alternatives

## Solution: Auto-Detection & Fallback System

### Core Principles

1. **Minimal Configuration**: Works with just `PRIVATE_KEY` and `CLOB_DERIVE_CREDS=true`
2. **Auto-Detection**: Automatically detects wallet mode (EOA vs Safe vs Proxy)
3. **Smart Fallback**: Tries multiple authentication combinations in a hard-coded ladder
4. **Caching**: Saves successful credentials with working parameters to `/data/clob-creds.json`
5. **Verification**: Only caches credentials that pass `/balance-allowance` verification

### Architecture

#### 1. Identity Resolution (`src/clob/identity-resolver.ts`)

Two key functions resolve identities for different purposes:

**`resolveOrderIdentity()`**: Returns order signing configuration

- `signatureTypeForOrders`: Which signature type to use (0=EOA, 1=PROXY, 2=SAFE)
- `makerAddress`: Who places the order
- `funderAddress`: Who funds the order
- `effectiveAddress`: What goes in POLY_ADDRESS header

**`resolveL1AuthIdentity()`**: Returns L1 auth configuration

- `signatureTypeForAuth`: Which signature type for L1 auth
- `l1AuthAddress`: Which address to use in L1 auth headers (POLY_ADDRESS)
- `signingAddress`: Which address actually signs (EOA from private key)

**Key Insight**: L1 auth address may differ from order maker/effective address. This is intentional and allows the fallback system to try different combinations.

#### 2. Fallback Ladder (`src/clob/auth-fallback.ts`)

Hard-coded fallback combinations tried in order:

```typescript
A) sigType=0 (EOA), l1Auth=signer      // Most common: standard wallet
B) sigType=2 (SAFE), l1Auth=signer     // Browser wallet with signer auth
C) sigType=2 (SAFE), l1Auth=effective  // Browser wallet with proxy auth
D) sigType=1 (PROXY), l1Auth=signer    // Legacy proxy with signer auth
E) sigType=1 (PROXY), l1Auth=effective // Legacy proxy with proxy auth
```

**Special Retry Logic**: If server returns 401 "Invalid L1 Request headers", immediately retry swapping l1Auth address for the same sigType.

#### 3. Credential Derivation with Fallback (`src/clob/credential-derivation-v2.ts`)

Main function: `deriveCredentialsWithFallback()`

**Flow:**

1. Check `/data/clob-creds.json` for cached credentials
2. If cached credentials exist, verify them via `/balance-allowance`
3. If cache invalid or missing, try each fallback combination in order
4. For each attempt:
   - Call `deriveApiKey()` (for existing wallets)
   - If that fails, call `createApiKey()` (for new wallets)
   - Verify returned credentials via `/balance-allowance`
   - If 401 "Invalid L1 Request headers", immediately swap l1Auth and retry
   - If 400 "Could not create api key", continue to next combination
5. Cache the first working credentials with parameters
6. If all attempts fail, generate comprehensive error summary

#### 4. Enhanced Credential Storage (`src/utils/credential-storage.util.ts`)

Cached credentials now include:

- `usedEffectiveForL1`: Whether effective address was used for L1 auth
- `signatureType`: Which signature type worked
- `funderAddress`: Funder/proxy address if applicable

This ensures cached credentials are only loaded when they match the current configuration.

### Configuration

#### Required (Minimal)

```env
PRIVATE_KEY=your_private_key
CLOB_DERIVE_CREDS=true
```

#### Optional Overrides (Rare)

Only needed in specific edge cases:

```env
# Force specific wallet mode (default: auto-detect)
CLOB_FORCE_WALLET_MODE=auto|eoa|safe|proxy

# Force specific L1 auth address (default: auto-fallback)
CLOB_FORCE_L1_AUTH=auto|signer|effective
```

#### Safe/Proxy Mode

For Gnosis Safe or proxy wallets:

```env
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x... # Your Safe/proxy address
```

The bot will automatically try both signer and effective addresses for L1 auth.

### Diagnostics

#### Auth Identity Log

A single concise line shows all addresses:

```
[Auth Identity] signerAddress=0x123... effectiveAddress=0x456... makerAddress=0x456... funderAddress=0x456... sigTypeForOrders=2 l1AuthAddress=0x123... sigTypeForAuth=2
```

#### Fallback Attempt Logs

```
[AuthFallback] Attempt 1/5: A) EOA + signer auth
[AuthFallback]   sigType=0 (EOA) l1Auth=0x123... signer=0x123...
[AuthFallback] ❌ Failed: A) EOA + signer auth (401) - Invalid L1 Request headers
```

#### Success Log

```
[AuthFallback] ✅ Success: B) Safe + signer auth
[CredStorage] Saved credentials to /data/clob-creds.json (signer=0x123... sigType=2 l1Auth=signer)
```

#### Failure Summary

If all attempts fail:

```
[AuthFallback] ========================================================
[AuthFallback] ALL CREDENTIAL DERIVATION ATTEMPTS FAILED
[AuthFallback] ========================================================
[AuthFallback] A) EOA + signer auth [401]: Invalid L1 Request headers
[AuthFallback] B) Safe + signer auth [401]: Invalid L1 Request headers
[AuthFallback] C) Safe + effective auth [400]: Could not create api key
[AuthFallback] D) Proxy + signer auth [401]: Unauthorized
[AuthFallback] E) Proxy + effective auth [401]: Unauthorized
[AuthFallback] ========================================================
[AuthFallback] POSSIBLE CAUSES:
[AuthFallback]   1. Wallet has never traded on Polymarket
[AuthFallback]   2. Incorrect funder/proxy address for Safe/Proxy mode
[AuthFallback]   3. Private key doesn't match expected wallet
[AuthFallback]   4. Network connectivity issues
[AuthFallback] ========================================================
[AuthFallback] TO FIX:
[AuthFallback]   1. Visit https://polymarket.com and connect wallet
[AuthFallback]   2. Make at least one small trade ($1+)
[AuthFallback]   3. Wait for transaction confirmation (1-2 min)
[AuthFallback]   4. Restart bot
[AuthFallback] ========================================================
```

## Testing

### Unit Tests

1. **Identity Resolver** (`tests/arbitrage/identity-resolver.test.ts`): 15 tests
   - Wallet mode detection
   - Order identity resolution
   - L1 auth identity resolution
   - Forced overrides

2. **Auth Fallback** (`tests/arbitrage/auth-fallback.test.ts`): 14 tests
   - Fallback ladder order
   - Error detection (401, 400)
   - Status code extraction
   - Error message extraction
   - Signature type labels

3. **Credential Derivation** (`tests/arbitrage/credential-derivation-fallback.test.ts`): 8 behavioral tests
   - 401 retry with swapped address
   - 400 handling (wallet needs trading)
   - Successful verification
   - Failed verification (not cached)
   - Cache loading
   - Fallback order
   - Failure summary

### Mock HTTP Scenarios

The tests verify behavior for:

- 401 "Invalid L1 Request headers" → immediate retry with swapped address
- 400 "Could not create api key" → continue to next fallback
- Successful verification → cache and stop
- Failed verification → don't cache, continue

## Benefits

1. **Zero Configuration for Most Users**: Just `PRIVATE_KEY` and `CLOB_DERIVE_CREDS=true`
2. **Automatic Safe Mode Support**: No complex configuration for proxy wallets
3. **Robust Fallback**: Tries multiple combinations before failing
4. **Fast Startup**: Cached credentials are loaded and verified first
5. **Clear Diagnostics**: Comprehensive logs show exactly what was tried and why it failed
6. **No Breaking Changes**: Existing configurations continue to work

## Migration Guide

### Before (Complex Configuration Required)

```env
PRIVATE_KEY=...
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x...
CLOB_SIGNATURE_TYPE=2
CLOB_FUNDER_ADDRESS=0x...
CLOB_POLY_ADDRESS_OVERRIDE=0x...
# Many env vars, easy to misconfigure
```

### After (Minimal Configuration)

```env
PRIVATE_KEY=...
CLOB_DERIVE_CREDS=true
# Optional for Safe/proxy:
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x...
# Bot auto-detects and tries all combinations
```

## Files Changed

### New Files

- `src/clob/identity-resolver.ts` - Identity resolution functions
- `src/clob/auth-fallback.ts` - Fallback ladder and helpers
- `src/clob/credential-derivation-v2.ts` - New derivation with fallback
- `tests/arbitrage/identity-resolver.test.ts` - Identity tests
- `tests/arbitrage/auth-fallback.test.ts` - Fallback tests
- `tests/arbitrage/credential-derivation-fallback.test.ts` - Derivation tests

### Modified Files

- `src/infrastructure/clob-client.factory.ts` - Uses new derivation system
- `src/utils/credential-storage.util.ts` - Enhanced with fallback metadata
- `.env.example` - Added new optional overrides with documentation
- `README.md` - Updated with auto-detection explanation and troubleshooting

## Acceptance Criteria

✅ In Safe mode where signer != effective, bot can derive/create + verify creds OR produces a precise actionable error showing which attempts failed and why

✅ No long list of env vars required - just `PRIVATE_KEY` and `CLOB_DERIVE_CREDS=true`

✅ Successful attempt is cached to `/data/clob-creds.json` and reused on next run

✅ 401 "Invalid L1 Request headers" triggers immediate retry with swapped l1Auth address

✅ 400 "Could not create api key" continues to next fallback combination

✅ Failed verification credentials are not cached

✅ Comprehensive diagnostics show all addresses and fallback attempts

✅ Clear error summary when all attempts fail with actionable instructions

## Future Enhancements

Possible future improvements:

1. Add telemetry to track which fallback combinations succeed most often
2. Support for additional wallet types (e.g., hardware wallets)
3. GUI for credential management
4. Automatic credential rotation
