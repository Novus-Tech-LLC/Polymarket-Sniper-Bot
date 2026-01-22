# Startup Diagnostics Guide

## Overview

This guide explains how to understand and troubleshoot bot startup issues. The bot performs comprehensive preflight checks at startup and produces clear diagnostic output to help identify blockers.

## Understanding the Startup Flow

### 1. Initialization

- Load environment variables
- Validate PRIVATE_KEY
- Initialize structured logging
- Create Auth Story builder (tracks all auth attempts)

### 2. Identity Resolution

- Derive signer address from PRIVATE_KEY
- Determine wallet mode (EOA, Safe, or Proxy)
- Resolve effective trading address
- Log identity configuration

### 3. Authentication Check

- Attempt CLOB API credential derivation or use provided credentials
- Verify credentials with `/balance-allowance` endpoint
- Record all attempts in Auth Story
- Set `auth_ok=true` if successful, `auth_ok=false` if failed

### 4. Approvals Check

- Check USDC balance
- Verify token allowances for trading contracts
- Check ERC1155 approvals (if needed)
- Set `approvals_ok=true` if all checks pass

### 5. Final Status

- Determine `ready_to_trade` status
- Identify PRIMARY_BLOCKER if not ready
- Print comprehensive summary
- Print Auth Story JSON

## Reading the Preflight Summary

### Success Case

```
[Preflight][Summary] ========================================
[Preflight][Summary] ✅ Auth: PASSED
[Preflight][Summary] ✅ Approvals: PASSED
[Preflight][Summary] ⚪ Relayer: DISABLED
[Preflight][Summary] ✅ Ready to Trade: YES
[Preflight][Summary] ========================================
[Preflight] ✅ READY_TO_TRADE=true PRIMARY_BLOCKER=OK
```

**Meaning:**

- ✅ Auth: CLOB API credentials are valid and verified
- ✅ Approvals: All token approvals and balance checks passed
- ⚪ Relayer: Optional builder/relayer not configured (this is OK)
- ✅ Ready to Trade: Bot can execute trades

### Auth Failure Case

```
[Preflight][Summary] ========================================
[Preflight][Summary] ❌ Auth: FAILED
[Preflight][Summary] ✅ Approvals: PASSED
[Preflight][Summary] ⚪ Relayer: DISABLED
[Preflight][Summary] ❌ Ready to Trade: NO
[Preflight][Summary] ========================================
[Preflight] ❌ READY_TO_TRADE=false PRIMARY_BLOCKER=AUTH_FAILED
[Preflight] ⚠️  PRIMARY STARTUP BLOCKER: Authentication failed
[Preflight] ⚠️  Note: Approvals may show as OK, but trading is blocked by auth failure
[Preflight] ⚠️  Run 'npm run auth:diag' for detailed authentication diagnostics
```

**Key Points:**

- Even though ✅ Approvals: PASSED, trading is BLOCKED
- Auth is the PRIMARY_BLOCKER - fix this first
- Approvals check on-chain permissions (independent of CLOB auth)
- Run `npm run auth:diag` for detailed diagnostics

## Primary Blockers Explained

### AUTH_FAILED ❌

**What it means:**

- CLOB API authentication failed
- Credentials are invalid, missing, or failed verification

**Common causes:**

1. Wallet has never traded on Polymarket
   - Solution: Visit https://polymarket.com and make at least 1 trade
2. Invalid credentials in environment
   - Solution: Set `CLOB_DERIVE_CREDS=true` to auto-derive credentials
3. Cached credentials expired
   - Solution: Delete `/data/clob-creds.json` and restart
4. Wrong wallet address
   - Solution: Verify PRIVATE_KEY matches your Polymarket wallet

**Diagnostics:**

```bash
# Run comprehensive auth diagnostic
npm run auth:diag

# Check auth probe output
npm run auth:probe

# View cached credentials (if any)
cat /data/clob-creds.json
```

### APPROVALS_FAILED ❌

**What it means:**

- On-chain token approvals missing or insufficient
- Or insufficient USDC balance

**Common causes:**

1. Token allowances not set
   - Solution: Run `npm run set-token-allowance`
2. Insufficient USDC balance
   - Solution: Add USDC to your wallet
3. Allowance expired or revoked
   - Solution: Re-approve with `npm run set-token-allowance`

**Diagnostics:**

```bash
# Check current allowances and balance
npm run check-allowance

# Set approvals
npm run set-token-allowance
```

### GEOBLOCKED ❌

**What it means:**

- Your IP address is in a restricted region

**Solution:**

1. Use a VPN from an allowed region
2. Or set `SKIP_GEOBLOCK_CHECK=true` (not recommended, may violate ToS)

### LIVE_TRADING_DISABLED ⚪

**What it means:**

- Safety flag not set (intentional)

**Solution:**

- Set `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS` to enable trading

## Auth Story JSON

Every startup produces a single Auth Story JSON with all auth attempts:

```json
{
  "runId": "run_1706745600_abc123",
  "selectedMode": "EOA",
  "selectedSignatureType": 0,
  "signerAddress": "0x1234...5678",
  "makerAddress": "0x1234...5678",
  "funderAddress": undefined,
  "effectiveAddress": "0x1234...5678",
  "clobHost": "https://clob.polymarket.com",
  "chainId": 137,
  "derivedCredFingerprint": {
    "apiKeySuffix": "xyz789",
    "secretLen": 88,
    "passphraseLen": 32,
    "secretEncodingGuess": "base64"
  },
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "sigType": 0,
      "l1Auth": "0x1234...5678",
      "maker": "0x1234...5678",
      "funder": undefined,
      "verifyEndpoint": "/balance-allowance",
      "signedPath": "/balance-allowance?asset_type=COLLATERAL",
      "usedAxiosParams": false,
      "httpStatus": 401,
      "errorTextShort": "Unauthorized/Invalid api key",
      "success": false
    }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "AUTH_FAILED"
  }
}
```

**Key fields:**

- `runId`: Unique identifier for this startup
- `selectedMode`: Wallet mode (EOA, SAFE, or PROXY)
- `attempts[]`: All authentication attempts with details
- `finalResult`: Overall auth status and reason

## Mempool Monitor Status

### RPC Supports Mempool Monitoring

```
[Monitor] ✅ RPC endpoint supports real-time mempool monitoring via eth_newPendingTransactionFilter
[Monitor] Subscribing to pending transactions for real-time detection...
```

**Meaning:**

- Your RPC endpoint supports real-time mempool monitoring
- Bot will detect pending transactions immediately
- Best case scenario for frontrunning

### RPC Does NOT Support Mempool Monitoring

```
[Monitor] ===================================================================
[Monitor] ℹ️  RPC Capability: eth_newPendingTransactionFilter NOT supported
[Monitor] ===================================================================
[Monitor] This RPC endpoint does not support real-time mempool monitoring.
[Monitor] This is expected and NORMAL for many RPC providers, including:
[Monitor]   • Alchemy Free Tier
[Monitor]   • Infura Free Tier
[Monitor]   • QuickNode (some plans)
[Monitor]   • Most public RPC endpoints
[Monitor]
[Monitor] ✅ FALLBACK MODE: The bot will use Polymarket API polling instead.
[Monitor] This provides reliable trade detection via the Polymarket API,
[Monitor] checking for recent activity at regular intervals.
```

**Meaning:**

- Your RPC endpoint does NOT support mempool monitoring
- This is **NORMAL** and **EXPECTED** for most free-tier RPC providers
- The bot automatically falls back to Polymarket API polling
- Trading still works - just using API instead of mempool
- **No action needed** - this is not an error

**To upgrade to real-time mempool monitoring:**

- Alchemy Growth or Scale plan with eth_subscribe
- Infura with WebSocket support
- QuickNode with stream add-on
- Your own Polygon node

## Troubleshooting Workflow

### Step 1: Identify the Primary Blocker

Look for this line:

```
[Preflight] ❌ READY_TO_TRADE=false PRIMARY_BLOCKER=AUTH_FAILED
```

### Step 2: Focus on the Primary Blocker

- Ignore other checks that passed
- Fix the primary blocker first
- Example: If AUTH_FAILED, don't worry about approvals yet

### Step 3: Run Diagnostics

```bash
# For AUTH_FAILED
npm run auth:diag

# For APPROVALS_FAILED
npm run check-allowance
```

### Step 4: Apply Fix

Follow the specific fix for your blocker (see above)

### Step 5: Restart and Verify

```bash
npm run dev
```

Look for:

```
[Preflight] ✅ READY_TO_TRADE=true PRIMARY_BLOCKER=OK
```

## Common Questions

### Q: Why do approvals show OK when auth fails?

**A:** Auth and approvals are **independent checks**:

- Auth = Can I communicate with CLOB API?
- Approvals = Do I have on-chain token permissions?

Both must pass, but they're checked separately.

### Q: My mempool monitor says "NOT supported" - is this bad?

**A:** No! This is normal for most RPC providers. The bot automatically uses API polling instead, which works fine.

### Q: How do I know if my fix worked?

**A:** Restart the bot and look for:

- `✅ Auth: PASSED`
- `✅ Ready to Trade: YES`
- `PRIMARY_BLOCKER=OK`

### Q: Where can I find detailed auth diagnostics?

**A:** Run `npm run auth:diag` - it produces a comprehensive diagnostic report.

### Q: What if I see multiple blockers?

**A:** Fix them in order:

1. AUTH_FAILED (most critical)
2. APPROVALS_FAILED
3. GEOBLOCKED
4. LIVE_TRADING_DISABLED (intentional safety flag)

## Getting Help

If you're still stuck after following this guide:

1. Run `npm run auth:diag` and save the output
2. Check the Auth Story JSON in your logs
3. Review the [README Authentication section](README.md#troubleshooting-401-unauthorizedinvalid-api-key-errors)
4. Open an issue with:
   - Full preflight summary output
   - Auth Story JSON
   - Output from `npm run auth:diag`
   - PRIMARY_BLOCKER value
