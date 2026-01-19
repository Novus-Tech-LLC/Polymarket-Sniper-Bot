# Minimal CLOB Authentication - Migration Guide

## Overview

This document describes the **minimal authentication approach** that matches the working Polymarket/agents Python repository. This replaces the complex 100+ iteration fallback system with a simple, reliable authentication flow.

## Philosophy

The Python agents repository does authentication in **3 lines of code**:

```python
self.client = ClobClient(self.clob_url, key=self.private_key, chain_id=self.chain_id)
self.credentials = self.client.create_or_derive_api_creds()
self.client.set_api_creds(self.credentials)
```

That's it. **No fallbacks. No retries. No complexity.** Just works.

Our TypeScript implementation follows the same pattern:

```typescript
const client = new ClobClient(CLOB_HOST, CHAIN_ID, asClobSigner(wallet));
const creds = await client.createOrDeriveApiKey();
client.setApiCreds(creds);
```

## What Was Removed

### ❌ Complex Systems (REMOVED)
- **Fallback ladder** (5 combinations: EOA/Safe/Proxy with different L1 auth)
- **Exponential backoff** (30s, 60s, 2m, 5m, 10m)
- **Signature type auto-detection** (trying all 3 types)
- **L1/L2 auth identity resolution** with swapping
- **Address override mechanisms**
- **Complex credential caching** with invalidation
- **Rate-limited logging** with deduplication

### ✅ Simple System (NEW)
- **One call** to `createOrDeriveApiKey()`
- **One verification** with `/balance-allowance`
- **One Auth Story** summary per run
- **Simple error handling** (if fails, log and return)

## Files

### New Files (Minimal Auth)
- `src/clob/minimal-auth.ts` - Core minimal auth implementation (~300 lines)
- `src/infrastructure/minimal-client-factory.ts` - Minimal client factory
- `scripts/minimal_auth_probe.ts` - Auth probe using minimal approach

### Legacy Files (Complex - To Be Deprecated)
- `src/clob/credential-derivation-v2.ts` (1007 lines) - Complex fallback system
- `src/clob/auth-fallback.ts` (323 lines) - Hard-coded 5-attempt ladder
- `src/clob/identity-resolver.ts` (332 lines) - Identity resolution logic
- `src/clob/diagnostics.ts` (1371 lines) - Verbose diagnostic logging
- `src/infrastructure/clob-client.factory.ts` - Complex client factory

### Keep As-Is
- `src/clob/simple-auth.ts` (317 lines) - Middle ground, uses `createOrDeriveApiKey()` but still has caching/verification
- `src/clob/polymarket-auth.ts` (354 lines) - OOP wrapper, reasonable complexity

## Usage

### Basic Authentication

```typescript
import { authenticateMinimal, printAuthStory } from "./src/clob/minimal-auth";

const result = await authenticateMinimal({
  privateKey: process.env.PRIVATE_KEY!,
  signatureType: 0, // Optional: 0=EOA, 1=Proxy, 2=GnosisSafe
  funderAddress: undefined, // Optional: For Proxy/Safe modes
  logLevel: "info", // Optional: "debug", "info", "error"
});

if (result.success) {
  console.log("✅ Auth successful!");
  console.log("Client ready:", result.client);
} else {
  console.log("❌ Auth failed:", result.story.errorMessage);
}

// Print structured Auth Story
printAuthStory(result.story);
```

### Create Client (Minimal Factory)

```typescript
import { createMinimalPolymarketClient } from "./src/infrastructure/minimal-client-factory";

const client = await createMinimalPolymarketClient({
  rpcUrl: "https://polygon-rpc.com",
  privateKey: process.env.PRIVATE_KEY!,
  deriveApiKey: true, // Let SDK derive credentials
  logger: myLogger,
});

if (!client.executionDisabled) {
  // Client is ready for trading
  const balance = await client.getBalanceAllowance({
    asset_type: "COLLATERAL",
  });
}
```

### Auth Probe Command

Run the minimal auth probe:

```bash
npm run auth:probe
# or
PRIVATE_KEY=0x... npm run auth:probe
```

For verbose output:

```bash
LOG_LEVEL=debug npm run auth:probe
```

## Environment Variables

### Required
- `PRIVATE_KEY` - Your wallet private key

### Optional
- `POLYMARKET_SIGNATURE_TYPE` - Signature type (0=EOA, 1=Proxy, 2=GnosisSafe)
- `POLYMARKET_PROXY_ADDRESS` - Proxy/funder address (for Proxy/Safe modes)
- `LOG_LEVEL` - Logging level (debug, info, error)

### Legacy (Still Supported in Old Factory)
- `CLOB_DERIVE_CREDS` - Enable credential derivation (default: true)
- `CLOB_SIGNATURE_TYPE` - Legacy name for POLYMARKET_SIGNATURE_TYPE
- `CLOB_FUNDER_ADDRESS` - Legacy name for POLYMARKET_PROXY_ADDRESS

## Auth Story Format

Each authentication run produces a single structured JSON summary:

```json
{
  "runId": "run_1234567890_abc123",
  "timestamp": "2025-01-20T10:30:00.000Z",
  "success": true,
  "signerAddress": "0x1234...5678",
  "signatureType": 0,
  "funderAddress": null,
  "credentialsObtained": true,
  "apiKeySuffix": "***abc123",
  "verificationPassed": true,
  "errorMessage": null,
  "durationMs": 1234
}
```

### Fields
- `runId` - Unique identifier for this auth attempt
- `timestamp` - ISO 8601 timestamp
- `success` - Overall success (true/false)
- `signerAddress` - Wallet address
- `signatureType` - Signature mode (0=EOA, 1=Proxy, 2=Safe)
- `funderAddress` - Funder address (for Proxy/Safe modes)
- `credentialsObtained` - Whether credentials were retrieved
- `apiKeySuffix` - Last 6 chars of API key (redacted)
- `verificationPassed` - Whether `/balance-allowance` succeeded
- `errorMessage` - Error message if failed
- `durationMs` - Total duration in milliseconds

## Migration Path

### Phase 1: Add Minimal Auth (✅ DONE)
1. Created `minimal-auth.ts` with Python agents approach
2. Created `minimal-client-factory.ts` for client creation
3. Created `minimal_auth_probe.ts` for testing
4. Updated `package.json` with new commands

### Phase 2: Validate (NEXT)
1. Test minimal auth with different wallet types:
   - EOA wallets
   - Proxy wallets (signatureType=1)
   - Gnosis Safe wallets (signatureType=2)
2. Run auth probe: `npm run auth:probe`
3. Compare with legacy: `npm run auth:probe:simple`

### Phase 3: Migrate Main App (FUTURE)
1. Update `src/app/main.ts` to use `createMinimalPolymarketClient`
2. Update other services to use minimal factory
3. Remove legacy factory dependencies

### Phase 4: Cleanup (FUTURE)
1. Mark legacy files as deprecated
2. Add warnings when using complex auth
3. Eventually remove:
   - `credential-derivation-v2.ts`
   - `auth-fallback.ts`
   - `identity-resolver.ts`
   - Complex parts of `clob-client.factory.ts`

## Benefits

### Simplicity
- **~300 lines** vs **~3,500 lines** (90% reduction)
- **1 function call** vs **5-attempt fallback ladder**
- **Simple errors** vs **complex diagnostic trees**

### Reliability
- **Matches working Python implementation**
- **No custom logic** - lets SDK handle complexity
- **Predictable behavior** - same flow every time

### Maintainability
- **Easy to understand** - any developer can read it
- **Easy to debug** - single Auth Story shows everything
- **Easy to test** - one code path to test

### Security
- **No secret leakage** - only shows last 4-6 chars
- **Minimal logging** - Auth Story contains only essentials
- **No verbose dumps** - no repeated identity logs

## Troubleshooting

### "Wallet must trade on Polymarket first"
- Visit https://polymarket.com
- Connect your wallet
- Make at least one trade
- Retry authentication

### "Verification failed: 401 Unauthorized"
- Check `POLYMARKET_SIGNATURE_TYPE` is correct
- For browser wallets, try `POLYMARKET_SIGNATURE_TYPE=2`
- For Safe/Proxy, also set `POLYMARKET_PROXY_ADDRESS`

### "Credentials incomplete"
- Wallet may not have traded on Polymarket
- SDK returned incomplete credentials
- Check network connectivity

## Comparison: Complex vs Minimal

| Feature | Complex Auth (OLD) | Minimal Auth (NEW) |
|---------|-------------------|-------------------|
| Lines of code | ~3,500 | ~300 |
| Attempts | 5 (fallback ladder) | 1 |
| Signature detection | Yes (tries all 3) | No (use configured) |
| Address swapping | Yes | No |
| Exponential backoff | Yes | No |
| Caching | Complex invalidation | Simple (optional) |
| Logging | Verbose, repeated | Single Auth Story |
| Matches Python | No | Yes ✅ |

## References

- [Polymarket/agents Python repo](https://github.com/Polymarket/agents) - Working reference implementation
- [@polymarket/clob-client](https://github.com/Polymarket/clob-client) - Official TypeScript SDK
- [Original issue](https://github.com/telix5000/Polymarket-Sniper-Bot/issues) - Context on auth complexity problem

## Testing

Run the minimal auth probe:

```bash
# Basic test
npm run auth:probe

# With debug logging
LOG_LEVEL=debug npm run auth:probe

# Test specific signature type
POLYMARKET_SIGNATURE_TYPE=2 npm run auth:probe

# Test with Safe/Proxy
POLYMARKET_SIGNATURE_TYPE=2 POLYMARKET_PROXY_ADDRESS=0x... npm run auth:probe
```

Expected output:

```
============================================================
POLYMARKET MINIMAL AUTH PROBE
Python Agents Style - Simple & Working
============================================================

ℹ️ [MinimalAuth] Authenticating wallet 0x1234...5678
ℹ️ [MinimalAuth] Calling createOrDeriveApiKey()...
ℹ️ [MinimalAuth] Credentials obtained (key: ***abc123)
ℹ️ [MinimalAuth] Verifying credentials with /balance-allowance...
ℹ️ [MinimalAuth] ✅ Auth successful (1234ms)

============================================================
AUTH STORY
============================================================
{
  "runId": "run_1234567890_abc123",
  "timestamp": "2025-01-20T10:30:00.000Z",
  "success": true,
  "signerAddress": "0x1234...5678",
  ...
}
============================================================
✅ Authentication successful - ready to trade
============================================================
```

## Support

If you encounter issues:

1. Run with debug logging: `LOG_LEVEL=debug npm run auth:probe`
2. Check the Auth Story JSON output
3. Compare with legacy: `npm run auth:probe:simple`
4. Check if wallet has traded on Polymarket
5. Verify environment variables are set correctly

## License

Apache-2.0 (same as parent project)
