# Safe/Proxy Wallet Credential Verification Fix

## Problem

When using Gnosis Safe (signature_type=2) or Proxy (signature_type=1) wallet modes, credential derivation succeeds but verification always fails with 401 Unauthorized.

### Root Cause

- Credential derivation uses `effectiveSigner` (returns Safe/proxy address via Proxy wrapper)
- Credential verification uses `params.wallet` (returns EOA address directly)
- This causes POLY_ADDRESS header mismatch between derivation and verification
- Result: API rejects verification requests because wallet addresses don't match

## Solution

Ensure the same wallet identity is used consistently throughout both derivation AND verification flows.

### Changes Made

#### 1. Fix in `attemptDerive()` (lines 569-593)

**Before:**

```typescript
const isValid = await verifyCredentials({
  creds,
  wallet: params.wallet, // ❌ Uses EOA address
  signatureType: params.attempt.signatureType,
  // ...
});
```

**After:**

```typescript
const isValid = await verifyCredentials({
  creds,
  wallet: effectiveSigner, // ✅ Uses Safe/proxy address for Safe/Proxy modes
  signatureType: params.attempt.signatureType,
  // ...
});
```

#### 2. Fix in Cached Credential Verification (lines 755-785)

**Before:**

```typescript
const isValid = await verifyCredentials({
  creds: cachedCreds,
  wallet, // ❌ Uses EOA address directly
  signatureType: params.signatureType ?? orderIdentity.signatureTypeForOrders,
  // ...
});
```

**After:**

```typescript
// Build effectiveSigner for Safe/Proxy modes
const signatureType =
  params.signatureType ?? orderIdentity.signatureTypeForOrders;
const needsEffectiveSigner =
  signatureType === SignatureType.POLY_PROXY ||
  signatureType === SignatureType.POLY_GNOSIS_SAFE;

const verificationWallet = needsEffectiveSigner
  ? buildEffectiveSigner(wallet, orderIdentity.effectiveAddress)
  : wallet;

const isValid = await verifyCredentials({
  creds: cachedCreds,
  wallet: verificationWallet, // ✅ Uses correct wallet identity
  signatureType,
  // ...
});
```

#### 3. Added Defensive Logging

- Logs wallet address before verification in `attemptDerive()` (lines 588-599)
- Logs whether effectiveSigner was built for cached verification (lines 781-790)
- Helps diagnose any future wallet address mismatches

## Behavior By Wallet Mode

### EOA Mode (signature_type=0)

- `effectiveSigner` = `wallet` (no proxy needed)
- No behavior change

### Proxy Mode (signature_type=1)

- `effectiveSigner` = Proxy wrapper returning proxy address
- Verification now uses same proxy address as derivation
- **Fixes 401 errors**

### Safe Mode (signature_type=2)

- `effectiveSigner` = Proxy wrapper returning Safe address
- Verification now uses same Safe address as derivation
- **Fixes 401 errors**

## Testing Recommendations

1. Test with EOA wallet (signature_type=0) - should work as before
2. Test with Proxy wallet (signature_type=1) - verification should now succeed
3. Test with Safe wallet (signature_type=2) - verification should now succeed
4. Test cached credential verification for all modes
5. Verify logs show correct wallet addresses in all scenarios

## Files Modified

- `src/clob/credential-derivation-v2.ts`

## Impact

- **Minimal**: Only changes the wallet identity used for verification
- **Safe**: No changes to derivation logic or credential creation
- **Targeted**: Only affects Safe/Proxy modes; EOA mode unchanged
