# Authentication Troubleshooting Guide

This guide helps you diagnose and fix authentication issues when `auth_ok=false` and `READY_TO_TRADE=false`.

## Understanding the Error

When the bot shows:

```
[Preflight] READY_TO_TRADE=false reason=CHECKS_FAILED
[Preflight][Summary] ... auth_ok=false ...
```

The bot will now display a **detailed diagnostic** explaining exactly what went wrong and how to fix it.

## Common Scenarios

### Scenario 1: "Using Builder API keys instead of CLOB API keys"

**Symptoms:**

- User-provided credentials fail with 401 "Invalid api key"
- Diagnostic shows: `WRONG_KEY_TYPE` (high confidence)

**Cause:**
You're using **Builder API credentials** (`POLY_BUILDER_API_KEY`) as CLOB credentials (`POLYMARKET_API_KEY`). These are two different types of keys:

- **Builder keys**: For gasless relayer transactions (optional feature)
  - Get from: https://docs.polymarket.com/developers/builders/builder-profile
  - Used for: Gasless approvals via the relayer
  - Environment variables: `POLY_BUILDER_API_KEY`, `POLY_BUILDER_API_SECRET`, `POLY_BUILDER_API_PASSPHRASE`

- **CLOB keys**: For placing orders on the order book (required for trading)
  - Get from: Set `CLOB_DERIVE_CREDS=true` - bot creates them automatically via L1 authentication
  - Used for: Submitting orders, checking balances, managing positions
  - Environment variables: `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`
  - Reference: https://docs.polymarket.com/developers/CLOB/authentication

**Solution:**

1. Remove any `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, and `POLYMARKET_API_PASSPHRASE` from your `.env`
2. Set `CLOB_DERIVE_CREDS=true` to automatically derive CLOB credentials
3. Ensure `PRIVATE_KEY` is set correctly
4. Restart the bot - it will automatically create CLOB credentials using L1 authentication

---

### Scenario 2: "Wallet has never traded on Polymarket"

**Symptoms:**

- Derive mode enabled but fails with 400 "Could not create api key"
- Diagnostic shows: `WALLET_NOT_ACTIVATED` (high confidence)

**Cause:**
Polymarket's API cannot create credentials for wallets that have never interacted with the platform. This is a one-time requirement.

**Solution:**

1. Visit https://polymarket.com
2. Connect the wallet that matches your `PRIVATE_KEY`
3. Make **at least one small trade** on any market (even $1)
4. Wait for the transaction to confirm on-chain (usually 1-2 minutes)
5. Restart the bot - it will automatically create and cache API credentials

**Why this is required:**
The Polymarket API needs to register your wallet address in their system before it can create API credentials. A successful trade registers your wallet.

---

### Scenario 3: "API keys expired or revoked"

**Symptoms:**

- User-provided credentials fail with 401 "Unauthorized"
- Diagnostic shows: `EXPIRED_CREDENTIALS` (medium confidence)

**Cause:**
Your CLOB API keys may be:

- Expired
- Revoked
- Cached but no longer valid

**Solution:**
Clear the credential cache and let the bot regenerate:

1. Delete cached credentials: `rm -f /data/clob-creds.json`
2. Ensure `CLOB_DERIVE_CREDS=true` is set in `.env`
3. Remove any manual `POLYMARKET_API_KEY/SECRET/PASSPHRASE` from `.env`
4. Restart the bot - it will automatically create new credentials

**Why this works:**

- CLOB API credentials can only be created/derived programmatically (no web UI exists)
- The bot automatically creates them using L1 authentication (signing with your private key)
- See: https://docs.polymarket.com/developers/CLOB/authentication

---

### Scenario 4: "Wrong wallet binding"

**Symptoms:**

- Both user-provided AND derived credentials fail
- Diagnostic shows: `WRONG_WALLET_BINDING` (medium confidence)

**Cause:**
The API keys in your `.env` file are bound to a different wallet address than the one derived from your `PRIVATE_KEY`.

**Solution:**

1. Verify your `PRIVATE_KEY` is correct
2. If you set `PUBLIC_KEY`, make sure it matches the address derived from `PRIVATE_KEY`
3. Either:
   - **Option A**: Remove `POLYMARKET_API_KEY/SECRET/PASSPHRASE` and use `CLOB_DERIVE_CREDS=true`
   - **Option B**: Generate new CLOB keys for this specific wallet at CLOB_DERIVE_CREDS=true (there is no web UI to manually generate CLOB API keys)

**To check your wallet address:**

```bash
# Run the bot with any command and check the logs:
[Preflight] signer=0x... effective_trading_address=0x...
```

---

### Scenario 5: "Derived credentials failed verification"

**Symptoms:**

- Derive mode enabled
- Credentials created but fail verification
- Diagnostic shows: `DERIVE_FAILED` (high confidence)

**Cause:**
The server created API credentials but they don't work. This can happen due to:

- Server-side synchronization issues
- Corrupted cached credentials
- Wallet permission problems

**Solution:**

1. Clear the credential cache:
   ```bash
   rm -f /data/clob-creds.json
   # or
   rm -f ./data/clob-creds.json
   ```
2. Restart the bot to retry credential derivation
3. If it fails again, check that your wallet has traded on Polymarket at least once (see Scenario 2)
4. Try enabling detailed diagnostics: `CLOB_PREFLIGHT_MATRIX=true`

---

### Scenario 6: "Network connectivity issues"

**Symptoms:**

- Auth failures with network-related error messages
- Diagnostic shows: `NETWORK_ERROR` (high confidence)

**Cause:**
Cannot reach Polymarket API or RPC endpoint

**Solution:**

1. Check your internet connection
2. Verify `RPC_URL` is accessible:
   ```bash
   curl -X POST $RPC_URL -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   ```
3. Verify Polymarket CLOB API is accessible:
   ```bash
   curl https://clob.polymarket.com/markets
   ```
4. If using a VPN, ensure it's properly configured
5. Check for firewall rules blocking outbound HTTPS traffic

---

## Understanding Context-Aware Warnings

The bot now provides **context-aware warnings** that only show the actual problems, not generic advice.

### Example 1: Only auth is the problem

```
⚠️  TRADING DISABLED - Running in DETECT-ONLY mode
Active blockers:
  1. Invalid or missing CLOB API credentials (see diagnostic above)
```

### Example 2: Multiple blockers

```
⚠️  TRADING DISABLED - Running in DETECT-ONLY mode
Active blockers:
  1. Invalid or missing CLOB API credentials (see diagnostic above)
  2. Required on-chain approvals are not satisfied
```

### Example 3: Only ARB_LIVE_TRADING is the blocker

```
⚠️  TRADING DISABLED - Running in DETECT-ONLY mode
Active blockers:
  1. ARB_LIVE_TRADING not set to 'I_UNDERSTAND_THE_RISKS'
```

**Key insight:** The bot will **NOT** show "ARB_LIVE_TRADING not set" if there are other problems (auth, approvals, geoblock). This prevents misleading diagnostics.

---

## Diagnostic Output Format

When authentication fails, you'll see output like this:

```
=================================================================
🔍 AUTHENTICATION FAILURE DIAGNOSTIC
=================================================================
Cause: WALLET_NOT_ACTIVATED (confidence: high)

Derived credential creation failed with "Could not create api key".
This occurs when the wallet has never traded on Polymarket.

Recommended Actions:
  1. Visit https://polymarket.com and connect your wallet
  2. Make at least ONE small trade on any market (even $1)
  3. Wait for the transaction to confirm on-chain
  4. Restart the bot - it will automatically create API credentials
  5. This is a one-time setup requirement for new wallets
=================================================================
```

---

## Quick Reference: Environment Variables

### CLOB Authentication (Required for Trading)

**Mode A: Explicit Keys**

```bash
POLYMARKET_API_KEY=your_clob_api_key
POLYMARKET_API_SECRET=your_clob_api_secret
POLYMARKET_API_PASSPHRASE=your_clob_passphrase
```

**Mode B: Derived Keys (Recommended)**

```bash
CLOB_DERIVE_CREDS=true
# Remove POLYMARKET_API_KEY/SECRET/PASSPHRASE when using derived mode
```

### Builder API (Optional, for Gasless Approvals)

```bash
POLY_BUILDER_API_KEY=your_builder_key
POLY_BUILDER_API_SECRET=your_builder_secret
POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase
```

### Live Trading Gate

```bash
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

---

## Advanced Diagnostics

### Enable comprehensive auth matrix testing

Set this to test all possible auth configurations:

```bash
CLOB_PREFLIGHT_MATRIX=true
```

This will test:

- Multiple signature types (EOA, POLY_PROXY)
- Different secret encodings (base64, base64url, raw)
- Different signature encodings
- User-provided vs derived credentials

The output will show which combination works.

### Force auth preflight even without credentials

```bash
CLOB_AUTH_FORCE=true
```

### Customize retry delay after derive failures

```bash
AUTH_DERIVE_RETRY_SECONDS=600  # Default: 10 minutes
```

---

## Still Having Issues?

1. Check the full logs for the detailed diagnostic output
2. Verify all environment variables are set correctly (see `.env.example`)
3. Ensure your wallet has sufficient POL for gas and USDC for trading
4. Try the quickstart guide: https://github.com/telix5000/Polymarket-Sniper-Bot#quickstart
5. Open an issue on GitHub with:
   - The diagnostic output (redact sensitive data!)
   - Your environment variable names (NOT values)
   - The error messages from the logs
