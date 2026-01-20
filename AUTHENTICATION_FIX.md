# Authentication Fix - January 2026

## Problem
The Polymarket Sniper Bot was failing to authenticate even with a valid PRIVATE_KEY, while other Polymarket bots (like pmxt) worked fine with just a private key.

## Root Cause
The bot was using a **complex fallback authentication system** (`clob-client.factory.ts`) that tried multiple signature type combinations:
- EOA (signatureType=0)
- Proxy (signatureType=1)
- Gnosis Safe (signatureType=2)
- With/without funder addresses
- With/without effective addresses

This complexity introduced bugs and made authentication fail in simple cases where it should have succeeded.

## Solution
**Replaced the complex factory with the simple `PolymarketAuth` module** that follows the pmxt methodology:

```typescript
// Step 1: Try to derive existing credentials
creds = await l1Client.deriveApiKey();

// Step 2: If that fails (404/400), create new credentials
if (!creds) {
  creds = await l1Client.createApiKey();
}

// Done!
```

## Changes Made

### 1. Updated `src/app/main.ts`
**Before:**
```typescript
const client = await createPolymarketClient({
  rpcUrl: env.rpcUrl,
  privateKey: env.privateKey,
  apiKey: env.polymarketApiKey,
  apiSecret: env.polymarketApiSecret,
  apiPassphrase: env.polymarketApiPassphrase,
  deriveApiKey: env.clobDeriveEnabled,
  publicKey: env.proxyWallet,
  logger,
});
```

**After:**
```typescript
const auth = createPolymarketAuthFromEnv(logger);
const authResult = await auth.authenticate();
if (!authResult.success) {
  logger.error(`❌ Authentication failed: ${authResult.error}`);
  return;
}
const client = await auth.getClobClient();
```

### 2. Updated `src/tools/preflight.ts`
Same change - now uses simple `PolymarketAuth` instead of complex factory.

## Testing
Created `test-simple-auth.ts` to verify authentication works with ONLY a PRIVATE_KEY:

```bash
$ export PRIVATE_KEY="0x..."
$ npx ts-node test-simple-auth.ts

✅ AUTH TEST PASSED - Can create client with PRIVATE_KEY only!
Signer address: 0x2e988A386a799F506693793c6A5AF6B54dfAaBfB
Signature type: 0 (0=EOA)
✅ SUCCESS: Authentication complete
  Credentials derived: true
  API key suffix: ...021055
✅ CLOB client created successfully
```

## Usage

### Minimal Configuration (.env)
```bash
# Required
PRIVATE_KEY=your_private_key_here
RPC_URL=https://polygon-rpc.com

# Optional (for copy trading)
TARGET_ADDRESSES=0xabc...,0xdef...
```

That's it! The bot will:
1. Auto-derive CLOB API credentials from your private key
2. Use EOA signature type (0) by default
3. Start trading immediately

### For Advanced Users
```bash
# Optional: Use specific signature type
POLYMARKET_SIGNATURE_TYPE=0  # 0=EOA, 1=Proxy, 2=GnosisSafe

# Optional: Set funder address (for Proxy/Safe wallets)
POLYMARKET_PROXY_ADDRESS=0x...

# Optional: Provide explicit credentials (skips derivation)
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
```

## Benefits

### ✅ Simplicity
- Works with just `PRIVATE_KEY` and `RPC_URL`
- No complex configuration needed
- Matches pmxt and other working bots

### ✅ Reliability
- Fewer moving parts = fewer bugs
- No unnecessary fallback attempts
- Clear success/failure messages

### ✅ Compatibility
- Works with EOA wallets out of the box
- Supports Proxy/Safe wallets if configured
- Auto-derives credentials like official Python agents

## Migration Guide

If you were using the old system with explicit credentials:

**Before:**
```bash
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0x...
```

**After:**
```bash
# Just use your private key!
PRIVATE_KEY=...

# The bot will:
# 1. Derive credentials automatically
# 2. Use the correct signature type
# 3. Start trading
```

If you still want to use explicit credentials (e.g., from Polymarket website), you can still set:
```bash
PRIVATE_KEY=...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
```

The bot will use your provided credentials instead of deriving new ones.

## Troubleshooting

### Error: "Wallet has never traded on Polymarket"
**Cause:** Your wallet needs to make at least one trade on polymarket.com first.

**Solution:**
1. Visit https://polymarket.com
2. Connect your wallet
3. Make a small trade (even $1)
4. Restart the bot - it will now derive credentials successfully

### Error: "401 Unauthorized"
**Possible causes:**
- Using browser wallet but not setting signature type
- Wrong private key
- Geoblocked (use VPN)

**Solution:**
1. Verify your PRIVATE_KEY is correct
2. If using browser wallet: `export POLYMARKET_SIGNATURE_TYPE=2`
3. Clear cached credentials: `rm -f /data/clob-creds.json`
4. Try using a VPN if you're in a restricted region

## Technical Details

### Authentication Flow
```
1. User provides PRIVATE_KEY
2. Bot creates Wallet from private key
3. Bot creates L1 ClobClient (for auth)
4. Bot calls deriveApiKey()
   ├─ Success → Use existing credentials
   └─ 404/400 → Call createApiKey()
      ├─ Success → Use new credentials
      └─ Failure → Show error
5. Bot verifies credentials work
6. Bot creates L2 ClobClient (for trading)
7. Ready to trade!
```

### Files Changed
- `src/app/main.ts` - Main application entry
- `src/tools/preflight.ts` - Preflight checks
- `test-simple-auth.ts` - Test script

### Files Used (Already Existed!)
- `src/clob/polymarket-auth.ts` - Simple pmxt-style auth
- `src/clob/simple-auth.ts` - Alternative simple auth
- `src/clob/minimal-auth.ts` - Ultra-minimal Python-style auth

The fix was simply to **use the simple auth modules that already existed** instead of the complex factory!

## Credits
This fix follows the methodology used by:
- [pmxt](https://github.com/pmxt-dev/pmxt) - Clean TypeScript Polymarket bot
- [polymarket-agents](https://github.com/Polymarket/agents) - Official Python agents
- Other working Polymarket bots that use just `PRIVATE_KEY`

## See Also
- [polymarket-auth.ts](src/clob/polymarket-auth.ts) - Implementation
- [.env.example](.env.example) - Configuration template
- [README.md](README.md) - Main documentation
