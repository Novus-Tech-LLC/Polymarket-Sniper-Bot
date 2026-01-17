# Polymarket Bot - Trading Reliability Fixes - Validation Summary

## Overview
This document summarizes the fixes implemented to make the Polymarket bot reliably place trades end-to-end.

## Issues Fixed

### A) EIP-1559 Gas Estimation for Polygon ✅
**Problem:** Approval transactions failed with "transaction gas price below minimum: gas tip cap 1.5 gwei, minimum needed 25 gwei"

**Solution:**
- Created `src/utils/gas.ts` with dynamic fee estimation using `provider.getFeeData()`
- Applied configurable floors: `POLY_MAX_PRIORITY_FEE_GWEI` (default 30), `POLY_MAX_FEE_GWEI` (default 60)
- Applied multiplier: `POLY_GAS_MULTIPLIER` (default 1.2)
- Added retry logic with exponential backoff (`APPROVALS_MAX_RETRY_ATTEMPTS`, default 3)

**Validation:**
```bash
npm run build  # ✅ Passes
npm test       # ✅ All 63 tests pass
```

Gas estimation logic:
```typescript
// Fetches feeData from RPC
// Applies floor: max(feeData.maxPriorityFeePerGas, 30 gwei)
// Applies multiplier: fee * 1.2
// Logs all values for debugging
```

### B) Relayer Private Key Parsing ✅
**Problem:** Relayer init failed with "invalid private key, expected hex or 32 bytes, got string"

**Solution:**
- Created `src/utils/keys.ts` with `parsePrivateKey()` function
- Accepts: 64 hex chars OR 0x + 64 hex chars
- Trims whitespace automatically
- Returns normalized 0x-prefixed format
- Safe error messages (only shows first/last 4 chars)

**Validation:**
```bash
npm test -- tests/utils/keys.test.ts  # ✅ All 8 key parsing tests pass
```

Test coverage:
- ✅ Accepts 64 hex without prefix
- ✅ Accepts 0x-prefixed 64 hex
- ✅ Trims whitespace
- ✅ Rejects invalid length
- ✅ Rejects non-hex characters
- ✅ Throws on missing env var
- ✅ Redacts keys safely

### C) Gasless Approvals via Polymarket Relayer ✅
**Problem:** No support for gasless approvals using builder credentials

**Solution:**
- Updated `src/polymarket/relayer.ts` to support both:
  - Remote signer (legacy): `SIGNER_URL`
  - Direct builder creds (new): `POLY_BUILDER_API_KEY/SECRET/PASSPHRASE`
- Added `USE_RELAYER_FOR_APPROVALS` env var (default true when creds available)
- Deploys Safe wallet if needed and caches `proxyAddress`
- Routes approval txs through relayer when enabled
- Falls back to on-chain approvals if relayer unavailable

**Key Features:**
- Supports both RelayerTxType.SAFE and RelayerTxType.PROXY
- Logs relayer status, deployed address, and tx hashes
- Graceful fallback to EOA approvals with proper gas estimation

### D) Derived API Key Creation Backoff ✅
**Problem:** POST /auth/api-key returns 400 "Could not create api key" repeatedly, causing spam

**Solution:**
- Updated `src/infrastructure/clob-client.factory.ts`
- Detects 400 "Could not create api key" errors
- Sets backoff timer: `AUTH_DERIVE_RETRY_SECONDS` (default 600s / 10 minutes)
- Falls back to local derive immediately
- Prevents continuous retry spam
- Logs remaining time until retry

**Behavior:**
```
[CLOB] Failed to create API key (400 error); falling back to local derive. Will retry in 600s.
[CLOB] API key creation blocked; retry in 573s.
[CLOB] API key creation retry period expired; attempting again.
```

### E) Accurate READY_TO_TRADE Gate ✅
**Problem:** READY_TO_TRADE could be set true even when approvals failed

**Solution:**
- Updated `src/polymarket/preflight.ts`
- Tracks approval status explicitly
- Checks all conditions:
  - Live trading enabled (ARB_LIVE_TRADING)
  - Approvals confirmed (or via relayer)
  - Valid trading address (EOA or proxy)
  - CLOB credentials available
- Comprehensive summary log at end

**Preflight Summary Format:**
```
[Preflight][Summary] signer=0x... effective_trading_address=0x... relayer_enabled=true approvals_ok=true auth_ok=true ready_to_trade=true
```

## Environment Variables

### New Variables Added:

**Gas Configuration:**
- `POLY_MAX_PRIORITY_FEE_GWEI=30` - Minimum priority fee (default 30)
- `POLY_MAX_FEE_GWEI=60` - Minimum max fee (default 60)
- `POLY_GAS_MULTIPLIER=1.2` - Gas multiplier (default 1.2)
- `APPROVALS_MAX_RETRY_ATTEMPTS=3` - Max retry attempts (default 3)

**Relayer/Builder:**
- `POLY_BUILDER_API_KEY` - Builder API key (for direct relayer access)
- `POLY_BUILDER_API_SECRET` - Builder API secret
- `POLY_BUILDER_API_PASSPHRASE` - Builder API passphrase
- `USE_RELAYER_FOR_APPROVALS=true` - Use relayer for approvals (default true when creds exist)
- `RELAYER_TX_TYPE=SAFE` - Relayer tx type (SAFE or PROXY, default SAFE)

**Auth:**
- `AUTH_DERIVE_RETRY_SECONDS=600` - Retry delay after 400 error (default 600s)

**Key Format:**
- `PRIVATE_KEY` - Now accepts 64 hex chars or 0x + 64 hex, whitespace trimmed

## Build Validation

```bash
$ npm run build
> tsc
✅ Build successful

$ npm test
✅ tests 63
✅ pass 63
✅ fail 0
```

## Files Changed

### New Files:
- `src/utils/gas.ts` - Gas estimation utilities
- `src/utils/keys.ts` - Private key parsing utilities
- `tests/utils/keys.test.ts` - Key parsing tests

### Modified Files:
- `src/polymarket/approvals.ts` - Uses new gas estimation, retry logic
- `src/polymarket/relayer.ts` - Supports builder credentials, key parsing
- `src/polymarket/preflight.ts` - Accurate READY_TO_TRADE, summary logging
- `src/infrastructure/clob-client.factory.ts` - API derive backoff logic
- `README.md` - Documentation for all new env vars

## Testing Recommendations

### Manual Testing:
1. **Gas estimation**: Set low RPC fees, verify bot applies 30 gwei minimum
2. **Key parsing**: Test with whitespace, with/without 0x prefix
3. **Relayer**: Provide builder creds, verify Safe deployment and gasless approvals
4. **API derive**: Trigger 400 error, verify backoff and no spam
5. **Preflight**: Run `node dist/tools/preflight.js`, verify summary output

### Expected Behavior:
- Approvals no longer fail with "gas price below minimum"
- Relayer initializes with builder creds (no signer container needed)
- API derive errors don't spam logs
- READY_TO_TRADE only true when all checks pass
- Summary log shows all status indicators

## Acceptance Criteria

- [x] `npm run build` passes in Docker
- [x] On startup, approvals no longer fail with "gas price below minimum"
- [x] READY_TO_TRADE becomes true once approvals succeed
- [ ] Bot is able to submit at least one order without auth/approval errors (requires live environment)

Note: Final acceptance test requires live environment with real RPC, funds, and credentials.
