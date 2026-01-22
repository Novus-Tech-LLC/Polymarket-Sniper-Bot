# 401 Auth Failure - Next Steps

## What I Built

Given that your wallet **HAS TRADED** on Polymarket (ruling out "not registered"), the 401 error must be due to a **signature computation mismatch**.

I've implemented **surgical HMAC diagnostic instrumentation** that will show you the **exact mismatch** between what we sign vs what we send to the API.

## Files Created/Modified

### New Files

1. **`src/utils/hmac-diagnostic-interceptor.ts`**
   - Axios interceptor that captures HTTP requests
   - Compares signed path vs actual path sent
   - Outputs structured diagnostic on 401

2. **`src/utils/hmac-signature-override.ts`**
   - Wraps the official `buildPolyHmacSignature` function
   - Logs exact signing inputs (timestamp, method, path, body)
   - Tracks inputs for correlation with HTTP requests

3. **`scripts/test-hmac-diagnostic.js`**
   - Standalone test script to reproduce the 401
   - Enables full diagnostic tracing
   - Produces "Auth Story" output

4. **`HMAC_DIAGNOSTIC_FIX.md`**
   - Complete documentation of the fix
   - How to interpret diagnostic output
   - Fix strategies based on results

### Modified Files

1. **`src/infrastructure/clob-client.factory.ts`**
   - Added diagnostic installation at client creation
   - Gated by `ENABLE_HMAC_DIAGNOSTICS` env var

## How to Run

### Option 1: Run the test script (Recommended)

```bash
# Set your credentials
export PRIVATE_KEY="your_private_key"
export POLYMARKET_API_KEY="your_api_key"
export POLYMARKET_API_SECRET="your_api_secret"
export POLYMARKET_API_PASSPHRASE="your_passphrase"

# Optional: Set if using browser wallet
# export POLYMARKET_SIGNATURE_TYPE=2
# export POLYMARKET_PROXY_ADDRESS="your_proxy_address"

# Run diagnostic test
ENABLE_HMAC_DIAGNOSTICS=true \
DEBUG_HMAC_SIGNING=true \
node scripts/test-hmac-diagnostic.js
```

### Option 2: Enable in your existing bot

Add to your `.env` file:

```
ENABLE_HMAC_DIAGNOSTICS=true
DEBUG_HMAC_SIGNING=true
```

Then run your bot normally. The diagnostic will activate on any API call.

## What to Look For

### 1. Path Mismatch (Most Likely)

If you see this:

```
[WARN] [HmacDiag] MISMATCH DETECTED:
  Signed path:  /balance-allowance?asset_type=COLLATERAL&signature_type=0
  Actual path:  /balance-allowance?signature_type=0&asset_type=COLLATERAL
```

**Cause**: Query parameters are in different order between signing and HTTP request.

**Fix**: The patch needs to be extended to ensure ALL endpoints use canonical query param ordering. I can implement this once we confirm this is the issue.

### 2. Signature Type Mismatch

If the diagnostic shows `signatureType: 0` but you created your wallet via the Polymarket website (not MetaMask directly), you likely need:

```bash
export POLYMARKET_SIGNATURE_TYPE=2
export POLYMARKET_PROXY_ADDRESS="your_polymarket_proxy_address"
```

You can find your proxy address by:

1. Going to polymarket.com
2. Connecting your wallet
3. Looking at your profile - the deposit address is your proxy address

### 3. Complete Diagnostic on 401

On a 401 error, you'll get:

```json
{
  "signedPath": "/balance-allowance?asset_type=COLLATERAL&signature_type=0",
  "actualPath": "/balance-allowance?signature_type=0&asset_type=COLLATERAL",
  "pathMatch": false,
  "signedMethod": "GET",
  "actualMethod": "GET",
  "methodMatch": true,
  "bodyHash": null,
  "secretHash": "a3f8b2c1...",
  "timestamp": "1705680000",
  "signature": "Ab3Cd4Ef..."
}
```

**Send me this JSON** and I'll provide the exact fix.

## Security

✅ Secrets are SHA256 hashed before logging  
✅ Only first/last 4-8 chars of keys shown  
✅ Diagnostic mode is opt-in (disabled by default)

## Why This Is The Right Fix

The previous diagnostics showed:

- ✅ Wallet address is correct
- ✅ Secret is base64-encoded (length=44)
- ✅ API key and passphrase present
- ✅ Wallet has traded on Polymarket

But we **don't know** if the signed message matches the HTTP request. This diagnostic closes that gap by **intercepting both** and comparing them.

## Expected Timeline

1. **Run diagnostic** (5 minutes)
2. **Analyze output** (5 minutes)
3. **Implement fix** (10-30 minutes, depending on root cause)
4. **Verify fix** (5 minutes)

**Total: ~30-60 minutes to resolution**

## What Happens Next

After you run the diagnostic and share the output:

1. If **path mismatch**: I'll extend the patch to canonicalize query params everywhere
2. If **signature type wrong**: You'll need to set POLYMARKET_SIGNATURE_TYPE=2
3. If **something else**: The diagnostic will show it, and I'll provide a targeted fix

---

## Quick Start

```bash
cd /home/runner/work/Polymarket-Sniper-Bot/Polymarket-Sniper-Bot

# Compile
npm run build

# Run diagnostic (replace with your creds)
PRIVATE_KEY="your_key" \
POLYMARKET_API_KEY="your_key" \
POLYMARKET_API_SECRET="your_secret" \
POLYMARKET_API_PASSPHRASE="your_passphrase" \
ENABLE_HMAC_DIAGNOSTICS=true \
DEBUG_HMAC_SIGNING=true \
node scripts/test-hmac-diagnostic.js
```

**Share the output with me** and we'll nail down the exact issue.
