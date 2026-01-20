# Auth Failure Fix: Step-by-Step User Guide

## Problem
If you see this error:
```
[Preflight] ❌ READY_TO_TRADE=false PRIMARY_BLOCKER=AUTH_FAILED
[ERROR] [Preflight] ⚠️  PRIMARY STARTUP BLOCKER: Authentication failed
```

This means your bot cannot authenticate with Polymarket's CLOB API.

## Quick Diagnosis

### Step 1: Identify Your Wallet Type

Run the diagnostic command:
```bash
npm run auth:probe
```

This will show:
- Your signer address (from PRIVATE_KEY)
- Your wallet mode (EOA, SAFE, or PROXY)
- Which auth attempt succeeded/failed

### Step 2: Check Your Configuration

#### If You Use Browser Wallet (Polymarket.com)
Your wallet is a **Gnosis Safe**. You need BOTH addresses:

1. **Signer Address** (EOA) - Derived from your PRIVATE_KEY
2. **Proxy/Deposit Address** (Safe) - Shown in Polymarket UI as your "deposit address"

**Required Configuration:**
```bash
# .env file
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0xYOUR_SAFE_DEPOSIT_ADDRESS
```

**Example (from the issue):**
```bash
PRIVATE_KEY=0xabc...  # EOA signer: 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x52d7008a5Cb5661dFed5573BB34E69772CDf0346
```

#### If You Use Direct EOA Wallet
Your wallet is a standard Ethereum account (EOA). You only need:

```bash
# .env file
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
# No POLYMARKET_SIGNATURE_TYPE needed (defaults to 0)
# No POLYMARKET_PROXY_ADDRESS needed
```

## Step 3: Verify the Fix

After configuring, run:
```bash
npm run auth:probe
```

**Expected Output (Success):**
```
[INFO:run_abc123] Starting auth probe
[INFO:run_abc123] Identity configuration signatureType=2 signerAddress=0x9B98...5D1 funderAddress=0x52d7...346
[INFO:run_abc123] Attempting credential derivation attemptId=A
[INFO:run_abc123] ✅ Auth successful

========================================================
AUTH STORY SUMMARY
========================================================
Identity Configuration:
  selectedMode: SAFE
  signerAddress: 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
  makerAddress: 0x52d7008a5Cb5661dFed5573BB34E69772CDf0346

Authentication Attempts: 1
  [A] ✅ SUCCESS (Safe + effective auth)

Final Result: ✅
  authOk: true
  readyToTrade: true
  reason: OK
========================================================
```

Exit code: `0` (success)

**Expected Output (Failure):**
```
[ERROR:run_abc123] ❌ Credential derivation failed httpStatus=401 error=Invalid L1 Request headers

========================================================
AUTH STORY SUMMARY
========================================================
...
Final Result: ❌
  authOk: false
  readyToTrade: false
  reason: CREDENTIAL_DERIVATION_FAILED
========================================================
```

Exit code: `1` (failure)

## Step 4: Troubleshooting

### Error: "Could not create api key (wallet needs to trade first)"
**Solution:** 
1. Go to https://polymarket.com
2. Connect your wallet
3. Make at least ONE trade (buy/sell any market)
4. Wait 5 minutes
5. Retry `npm run auth:probe`

### Error: "Invalid L1 Request headers"
**Solution:**
You likely have the wrong configuration. Check:

1. **Signer address**: Run `node -e "console.log(require('ethers').Wallet.fromPhrase(process.env.PRIVATE_KEY).address)"` and verify it matches your expected EOA
2. **Proxy address**: Log into Polymarket.com and check your "deposit address" in account settings
3. **Signature type**: Browser wallets need `POLYMARKET_SIGNATURE_TYPE=2`

### Error: Still failing after correct configuration
1. Check `.env` file is in the repo root
2. Verify no typos in addresses (include `0x` prefix)
3. Run `npm run auth:probe` with debug:
   ```bash
   LOG_LEVEL=debug npm run auth:probe
   ```
4. Check the "Auth Story Summary" to see which attempts were made

## Common Mistakes

### ❌ WRONG: Using EOA address for POLYMARKET_PROXY_ADDRESS
```bash
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1  # EOA (wrong!)
```

### ✅ CORRECT: Using Safe deposit address for POLYMARKET_PROXY_ADDRESS
```bash
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x52d7008a5Cb5661dFed5573BB34E69772CDf0346  # Safe (correct!)
```

### ❌ WRONG: Missing signature type for browser wallet
```bash
PRIVATE_KEY=0xabc...
# Missing POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x52d7...
```

### ✅ CORRECT: Include signature type
```bash
PRIVATE_KEY=0xabc...
POLYMARKET_SIGNATURE_TYPE=2  # Required for browser wallets!
POLYMARKET_PROXY_ADDRESS=0x52d7...
```

## How to Find Your Addresses

### Finding Your EOA Signer Address
The signer address is derived from your PRIVATE_KEY:
```bash
node -e "console.log(new (require('ethers').Wallet)(process.env.PRIVATE_KEY).address)"
```

### Finding Your Safe Deposit Address
1. Go to https://polymarket.com
2. Connect your wallet
3. Click account/settings
4. Look for "Deposit Address" or "Trading Address"
5. Copy that address - it's your `POLYMARKET_PROXY_ADDRESS`

## Running the Bot After Fix

Once `npm run auth:probe` succeeds, start the bot:
```bash
npm start
```

You should see:
```
[Preflight] ✅ READY_TO_TRADE=true PRIMARY_BLOCKER=OK
```

## Technical Details

For developers interested in the fix details, see:
- `AUTH_ROOT_CAUSE_ANALYSIS.md` - Root cause analysis
- `AUTH_FIX_IMPLEMENTATION.md` - Implementation details
- `src/clob/credential-derivation-v2.ts` - Core fix

## Still Having Issues?

If you followed all steps and still see `AUTH_FAILED`:

1. Capture full diagnostic output:
   ```bash
   LOG_LEVEL=debug npm run auth:probe > auth_debug.log 2>&1
   ```

2. Create a GitHub issue with:
   - The `auth_debug.log` file (REMOVE your PRIVATE_KEY first!)
   - Your wallet addresses (signer and proxy/safe)
   - The "Auth Story Summary" from the log

3. Include this info:
   - Did you trade on Polymarket before?
   - Did you create your wallet via browser or CLI?
   - What signature type are you using?
