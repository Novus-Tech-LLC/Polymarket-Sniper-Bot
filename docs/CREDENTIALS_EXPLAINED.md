# Understanding Polymarket API Credentials

## The Problem You're Facing

You have Builder API keys from Polymarket and are getting "401 Unauthorized/Invalid api key" errors. This is because **Builder API keys cannot be used for trading**.

## Two Separate Credential Systems

Polymarket uses **TWO COMPLETELY DIFFERENT** credential systems:

### 1. CLOB API Credentials (What You Need for Trading)

**Purpose:** Authenticate API requests to place orders, check balances, manage positions

**Required for:** ALL trading activity, including this auto-trading bot

**How to get them:**

- **ONLY OPTION:** Use `CLOB_DERIVE_CREDS=true` in your `.env` file
- The bot will automatically create them using L1 authentication (signing with your private key)
- **There is NO web UI to manually generate these**

**Environment Variables:**

```bash
# Don't set these manually - let the bot derive them:
# POLYMARKET_API_KEY=...
# POLYMARKET_API_SECRET=...
# POLYMARKET_API_PASSPHRASE=...

# Instead, use:
CLOB_DERIVE_CREDS=true
PRIVATE_KEY=your_wallet_private_key
```

**Official Documentation:** https://docs.polymarket.com/developers/CLOB/authentication

### 2. Builder API Credentials (What You Have)

**Purpose:**

- Order attribution on the Builder Leaderboard
- Optional gasless approval transactions via relayer

**Required for:**

- ONLY if you're building an app that routes orders for OTHER users
- Leaderboard tracking and grants competition
- NOT required for personal auto-trading

**Environment Variables:**

```bash
# These are optional - only for leaderboard attribution:
POLY_BUILDER_API_KEY=your_builder_key
POLY_BUILDER_API_SECRET=your_builder_secret
POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase
```

**Official Documentation:** https://docs.polymarket.com/developers/builders/order-attribution

### How to Enable the Relayer (Gasless Approvals)

If your logs show `⚪ Relayer: DISABLED`, this is **normal** - the bot works fine without it.

**What the relayer does:**
- Enables gasless approval transactions (you don't pay gas for token approvals)
- Uses Polymarket's infrastructure to relay transactions

**What happens without the relayer:**
- Approvals use direct contract calls (you pay gas, typically ~0.01-0.05 MATIC)
- Trading still works normally
- You may see: `[AutoRedeem] ⚠️ Relayer not available - using direct contract calls`

**To enable the relayer, you need ONE of:**

1. **Builder API credentials (all 3 required):**
   ```bash
   POLY_BUILDER_API_KEY=your_builder_key
   POLY_BUILDER_API_SECRET=your_builder_secret
   POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase
   ```
   Get these from: https://docs.polymarket.com/developers/builders/builder-profile

2. **Or a remote signer service:**
   ```bash
   SIGNER_URL=http://signer:8080/sign
   SIGNER_AUTH_TOKEN=optional_token  # if your signer requires auth
   ```

**Important:** Builder credentials are **different** from CLOB credentials (`POLYMARKET_API_*`). You can have both configured - they serve different purposes.

## The Solution

Based on your logs showing "401 Unauthorized/Invalid api key", you're likely using Builder keys as CLOB keys. Here's how to fix it:

### Step 1: Update Your .env File

```bash
# REMOVE any POLYMARKET_API_* variables (these are what's causing the 401 error)
# POLYMARKET_API_KEY=...
# POLYMARKET_API_SECRET=...
# POLYMARKET_API_PASSPHRASE=...

# ADD this line to auto-derive CLOB credentials:
CLOB_DERIVE_CREDS=true

# Keep your wallet private key:
PRIVATE_KEY=your_wallet_private_key_here

# You can OPTIONALLY keep Builder keys if you want leaderboard tracking:
# POLY_BUILDER_API_KEY=your_builder_key
# POLY_BUILDER_API_SECRET=your_builder_secret
# POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase
```

### Step 2: Important - First Trade Requirement

If your wallet has **NEVER** traded on Polymarket before:

1. Visit https://polymarket.com
2. Connect your wallet (the one from your `PRIVATE_KEY`)
3. Make **at least ONE small trade** (even $1) on any market
4. Wait for the transaction to confirm on-chain (1-2 minutes)
5. Then restart the bot

**Why?** Polymarket's API cannot create credentials for wallets that have never interacted with the platform. This is a one-time requirement.

### Step 3: Clear Cache and Restart

```bash
# Clear any old cached credentials:
rm -f /data/clob-creds.json
rm -f ./data/clob-creds.json

# Restart the bot:
npm start
```

## What the Bot Does Automatically

When `CLOB_DERIVE_CREDS=true`:

1. Bot signs a message with your private key (L1 authentication)
2. Bot calls Polymarket API: `GET /auth/derive-api-key` or `POST /auth/api-key`
3. Polymarket returns CLOB API credentials (key, secret, passphrase)
4. Bot caches them in `/data/clob-creds.json` for reuse
5. Bot uses these credentials for all trading API requests (L2 authentication)

## Common Mistakes

❌ **WRONG:** Using Builder keys as CLOB keys

```bash
# This will NOT work:
POLYMARKET_API_KEY=<builder_api_key>
POLYMARKET_API_SECRET=<builder_api_secret>
POLYMARKET_API_PASSPHRASE=<builder_api_passphrase>
```

✅ **CORRECT:** Let the bot derive CLOB credentials

```bash
# This WILL work:
CLOB_DERIVE_CREDS=true
PRIVATE_KEY=your_wallet_private_key

# Builder keys are separate and optional:
POLY_BUILDER_API_KEY=<builder_api_key>
POLY_BUILDER_API_SECRET=<builder_api_secret>
POLY_BUILDER_API_PASSPHRASE=<builder_api_passphrase>
```

## FAQ

**Q: Can I manually create CLOB API keys on the website?**  
A: No. There is no web UI. They must be created/derived programmatically using L1 authentication (signing with your private key).

**Q: Do I need Builder API keys for auto-trading?**  
A: No. Builder keys are only for order attribution when building apps for other users. For personal trading, you only need CLOB credentials (which the bot auto-derives).

**Q: What if I get "Could not create api key" error?**  
A: Your wallet has never traded on Polymarket. Make at least one trade on https://polymarket.com first (see Step 2 above).

**Q: How do I know if my credentials are working?**  
A: Check the logs for:

```
[Preflight][Summary] ... auth_ok=true ready_to_trade=true
```

**Q: Can I use the same credentials on multiple bots?**  
A: No. Each wallet needs its own CLOB credentials derived from its private key.

## References

- **CLOB Authentication:** https://docs.polymarket.com/developers/CLOB/authentication
- **Placing Your First Order:** https://docs.polymarket.com/quickstart/first-order
- **Builder Order Attribution:** https://docs.polymarket.com/developers/builders/order-attribution
- **Builder Profile:** https://docs.polymarket.com/developers/builders/builder-profile
