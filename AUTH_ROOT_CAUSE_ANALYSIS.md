# Root Cause Analysis: 401 Auth Failure

## Summary
The bot fails to authenticate with CLOB API, returning `401 Unauthorized` during credential derivation phase. The bot attempts to derive API credentials from the private key but fails due to L1 authentication header mismatch.

## User Configuration
```
Wallet (EOA signer):  0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
Proxy/Funder address: 0x52d7008a5Cb5661dFed5573BB34E69772CDf0346
USDC balance: ✅ Satisfied
Approvals: ✅ Satisfied
```

## Root Cause

### Issue #1: L1 Auth Address Selection
The credential derivation uses `createOrDeriveApiKey()` which requires **L1 authentication headers** (POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP). The system must determine which address to use:
- Option A: Signer address (EOA) `0x9B98...5D1`
- Option B: Effective/proxy address `0x52d7...346`

**Current behavior:** The fallback ladder tries both, but the logic may not be covering all combinations correctly.

### Issue #2: Wallet Type Auto-Detection
The user has a **Gnosis Safe wallet** (signature type 2) but the system may be attempting with wrong signature type first, causing unnecessary failures.

From the user's addresses:
- `0x52d7...346` is likely a Polymarket-created Gnosis Safe (deposit address shown in browser)
- `0x9B98...5D1` is the EOA private key owner

### Issue #3: Missing Diagnostic Output
The current auth flow produces verbose logs but doesn't produce the **single Auth Story summary** per run that shows exactly:
1. Which signature type was attempted
2. Which L1 auth address was used
3. What the HTTP status/error was
4. Which attempt succeeded (if any)

## Required Fixes

### Fix #1: Ensure L1 Auth Header Uses Correct Address
**File:** `src/clob/credential-derivation-v2.ts`

The system needs to use the **proxy/effective address** for L1 auth when signature type is SAFE (2):
```typescript
// For SAFE mode: L1 auth = proxy address (NOT signer)
// For EOA mode: L1 auth = signer address
```

### Fix #2: Add Structured Auth Story Output
**Files:** 
- `src/clob/credential-derivation-v2.ts`
- `src/polymarket/preflight.ts`

Must produce ONE JSON block per run:
```json
{
  "runId": "run_abc123",
  "selectedMode": "SAFE",
  "signerAddress": "0x9B98...5D1",
  "makerAddress": "0x52d7...346",
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x9B98...5D1",
      "httpStatus": 401,
      "success": false
    },
    {
      "attemptId": "B",
      "mode": "SAFE",
      "sigType": 2,
      "l1Auth": "0x52d7...346",
      "httpStatus": 200,
      "success": true
    }
  ],
  "finalResult": {
    "authOk": true,
    "readyToTrade": true
  }
}
```

### Fix #3: Deduplicate Repetitive Logs
Current logs spam identity information on every attempt. Must suppress after first occurrence.

## Expected Outcome After Fix
```
[INFO] Starting credential derivation
[INFO] Identity: mode=SAFE signer=0x9B98...5D1 maker=0x52d7...346
[INFO] Attempt A (EOA mode, l1Auth=signer): 401 Failed
[INFO] Attempt B (SAFE mode, l1Auth=effective): 200 Success ✅
[INFO] ✅ Credential derivation successful!

AUTH_STORY_JSON: {
  "runId": "run_abc123",
  "selectedMode": "SAFE",
  "attempts": 2,
  "successAttempt": "B"
}

[Preflight] ✅ READY_TO_TRADE=true PRIMARY_BLOCKER=OK
```

## Next Steps
1. ✅ Identify exact L1 auth address logic
2. ⏳ Fix L1 auth address selection for SAFE mode
3. ⏳ Add Auth Story summary output
4. ⏳ Deduplicate repetitive identity logs
5. ⏳ Add `npm run auth:probe` command
