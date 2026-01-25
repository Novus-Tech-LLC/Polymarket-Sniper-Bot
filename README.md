# Polymarket Sniper Bot

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)

**Automated trading bot for Polymarket with adaptive learning and smart execution**

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Contributing](#-contributing)

</div>

---

## ✨ What's New

- 💵 **Auto-Redeem Positions** - Automatically claim resolved market positions (wins and losses) for USDC
- 🚪 **On-Chain Exit Strategy** - Route NOT_TRADABLE positions to on-chain redemption when CLOB is unavailable
- ⛓️ **On-Chain Trading Mode** - Bypass CLOB API entirely and trade directly on Polygon blockchain
- 🧠 **Adaptive Learning System** - Learns from trade outcomes to prevent bad trades
- 🔐 **Simplified Authentication** - Uses `createOrDeriveApiKey()` for clean credential management
- 📊 **Clean Logging** - ✅ for success, ❌ for failures - easy to troubleshoot
- 🛡️ **Rate-Limited Error Logs** - No more log spam on repeated auth failures
- ⚡ **Single-Flight Derivation** - Prevents concurrent credential derivation attempts

## 💵 Auto-Redeem Positions (New)

When a market resolves, your positions can be redeemed for USDC. Previously, this had to be done manually. Now, the bot **automatically claims your wins and losses** so your capital isn't sitting idle.

### How It Works

1. **Position Tracking**: The bot monitors all your positions through the Data API (refreshes every 5 seconds)
2. **Resolution Detection**: When a market resolves, positions are marked as "redeemable"
3. **Automatic Redemption**: The bot checks for redeemable positions every **30 seconds** (configurable) and calls the CTF contract's `redeemPositions()` to claim USDC
4. **Capital Recovery**: Immediately frees up capital for new trades

### When Does Auto-Redeem Run?

| Event | Frequency |
|-------|-----------|
| **At startup** | Once when the bot starts |
| **During operation** | Every 30 seconds (configurable via `AUTO_REDEEM_CHECK_INTERVAL_MS`) |
| **Manual trigger** | Anytime via `npm run redeem` |

**Note**: The bot must be running for auto-redeem to work. If you stop the bot, positions won't be redeemed until you restart it or manually trigger redemption.

### Configuration

Auto-redeem is **enabled by default** in all strategy presets (`conservative`, `balanced`, `aggressive`).

```bash
# Auto-redeem is automatically enabled when using strategy presets
STRATEGY_PRESET=balanced

# Or configure manually via environment variables:
AUTO_REDEEM_ENABLED=true              # Enable/disable auto-redeem
AUTO_REDEEM_MIN_POSITION_USD=0.10     # Skip dust positions below this value
AUTO_REDEEM_CHECK_INTERVAL_MS=30000   # How often to check (default: 30 seconds)
                                      # Lower = more responsive, more API calls
                                      # Higher = less responsive, fewer API calls
```

### Manual Redemption

You can also manually trigger redemption of all resolved positions:

```bash
# Manually redeem all resolved positions
npm run redeem
```

### Priority

Auto-redeem runs as **Priority 1** in the strategy orchestrator, ensuring resolved positions are claimed before any other trading strategies execute. This maximizes capital availability.

### Benefits

- 💰 **Automatic Capital Recovery** - No waiting for Polymarket's 4pm UTC settlement
- ⚡ **Immediate USDC Availability** - Claimed funds ready for new trades instantly
- 🔄 **Set and Forget** - No manual intervention required
- 🧹 **Dust Prevention** - Skip tiny positions to save on gas costs

## 🚪 On-Chain Exit Strategy (New)

Handles positions that **cannot be traded on CLOB** (e.g., `executionStatus=NOT_TRADABLE_ON_CLOB`, `bookStatus=NO_BOOK_404/EMPTY_BOOK/BOOK_ANOMALY`) but still have high current price (≥99¢). These positions are stuck—AutoSell skips them because CLOB doesn't accept orders, but they may still be redeemable on-chain if the market has resolved.

### When Is It Used?

The OnChainExit strategy kicks in when:

1. **AutoSell skips the position** - Position has `executionStatus=NOT_TRADABLE_ON_CLOB`
2. **Price is high** - `currentPrice ≥ 99¢` (configurable threshold)
3. **Market is resolved on-chain** - `payoutDenominator > 0` in the CTF contract

### What Happens

1. **Detection**: OnChainExit scans active positions that AutoSell skipped
2. **On-Chain Check**: Verifies the market is resolved by checking `payoutDenominator`
3. **Route to Redemption**: If resolved, the position is flagged for AutoRedeem to claim

### Safety Checks

- ✅ **Never attempts exit on unresolved markets** - Only acts when `payoutDenominator > 0`
- ✅ **Respects price threshold** - Only high-value positions (≥99¢) are considered
- ✅ **No double-processing** - AutoSell and OnChainExit don't process the same position
- ✅ **Behind feature flag** - Can be disabled via `ON_CHAIN_EXIT_ENABLED=false`

### Configuration

```bash
# On-chain exit is enabled by default
ON_CHAIN_EXIT_ENABLED=true              # Enable/disable on-chain exit strategy
ON_CHAIN_EXIT_PRICE_THRESHOLD=0.99      # Price threshold (0-1 scale, default: 99¢)
ON_CHAIN_EXIT_MIN_POSITION_USD=0.01     # Skip positions below this value
```

### Log Output

When OnChainExit processes positions, you'll see logs like:

```
[OnChainExit] scanned=5 found_redeemable=1 skipped_tradable=3 skipped_below_threshold=0 skipped_not_redeemable=1
[OnChainExit] ✅ ON-CHAIN REDEEMABLE FOUND: tokenId=0xabc123... marketId=0xdef456... currentPrice=99.5¢ value=$50.00 payoutDenominator=1 (AutoRedeem will claim on next cycle)
```

**Skip Reasons:**
- `TRADABLE_ON_CLOB` - Position is tradable via CLOB (AutoSell handles it)
- `BELOW_PRICE_THRESHOLD` - Price below configured threshold
- `NOT_REDEEMABLE_ONCHAIN` - Market not resolved on-chain yet (will retry next cycle)
- `RPC_ERROR` - Error checking on-chain state

### Execution Order

OnChainExit runs in the orchestrator after AutoSell but before AutoRedeem:

1. SellEarly (99.9¢+)
2. AutoSell (99¢+ tradable positions)
3. **OnChainExit** (99¢+ NOT_TRADABLE positions → checks on-chain redeemability)
4. AutoRedeem (claims REDEEMABLE positions)
5. Smart Hedging, Stop-Loss, etc.

## ⛓️ On-Chain Trading Mode (New - Framework Ready)

Trade directly on the Polygon blockchain without CLOB API dependencies. The complete infrastructure is implemented - only the final order matching component needs additional integration.

### Current Status

**✅ Complete Infrastructure**:

- Configuration system with TRADE_MODE switching
- Balance and allowance verification
- Automatic USDC approval
- Price protection and validation
- Comprehensive error handling
- Status checking CLI command

**⚠️ Needs Integration**: Direct order filling requires access to signed maker orders (not available in public orderbook endpoint).

### What Works Now

```bash
# Check your on-chain trading readiness
npm run onchain:status

# Shows:
# - Wallet address and balance
# - USDC balance
# - Exchange approval status
# - Network information
```

### Path to Production

To enable live on-chain trading, integrate with one of:

1. **CLOB Order API**: Access authenticated `/orders` endpoint for signed maker orders
2. **Market Making**: Create and match your own counter-orders on-chain
3. **Aggregator Pattern**: Build orders from on-chain events

See `src/trading/onchain-executor.ts` for detailed implementation options.

### Mode Comparison

| Feature              | CLOB Mode (default)           | On-Chain Mode (experimental)                |
| -------------------- | ----------------------------- | ------------------------------------------- |
| **Status**           | ✅ Fully functional           | ⚠️ Infrastructure ready, integration needed |
| **API Credentials**  | Required (or derived)         | ❌ Not needed                               |
| **Rate Limits**      | Yes (36k orders/10min)        | ❌ None (only gas)                          |
| **Authentication**   | Complex (EOA/Proxy/Safe)      | ✅ Simple (just wallet)                     |
| **Execution**        | Via CLOB API                  | Direct blockchain (pending integration)     |
| **Transparency**     | Order IDs                     | Transaction hashes (when complete)          |
| **Setup Complexity** | Moderate                      | Minimal (when complete)                     |
| **Best For**         | All trading (current default) | Future: simple reliable trades              |

**Note**: On-chain mode currently returns `NOT_IMPLEMENTED` and requires additional integration work to execute actual trades. See `ONCHAIN_TRADING_IMPLEMENTATION.md` for details.

### Technical Details

On-chain mode infrastructure uses Polymarket's CTF Exchange smart contracts directly:

- **CTF Exchange**: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- **Neg Risk Exchange**: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- **CTF Contract**: `0x4d97dcd97ec945f40cf65f87097ace5ea0476045`
- **USDC.e**: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

The framework includes:

1. Balance and allowance verification
2. Automatic USDC approval handling
3. Price protection and validation
4. Transaction building (pending order matching integration)

**Current Status**: Infrastructure complete, but order execution requires integration with signed maker orders (see implementation docs).

### Configuration

```bash
# Trade Mode (defaults to CLOB - fully functional)
TRADE_MODE=clob              # Default - uses Polymarket CLOB API
# TRADE_MODE=onchain         # Experimental - on-chain infrastructure (not yet complete)

# Required for CLOB mode (default)
PRIVATE_KEY=0x...            # Your wallet private key
RPC_URL=https://polygon-rpc.com
# API credentials auto-derived from PRIVATE_KEY

# Optional overrides
COLLATERAL_TOKEN_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
POLY_CTF_EXCHANGE_ADDRESS=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
```

### When to Use Each Mode

**CLOB Mode (DEFAULT - Recommended):**

- ✅ Fully functional trading
- Works with all order types
- Automatic credential derivation from PRIVATE_KEY
- Proven, reliable execution
- **Use this for actual trading**

**On-Chain Mode (Experimental):**

- ⚠️ Infrastructure in place but incomplete
- Currently returns `NOT_IMPLEMENTED`
- Will offer: Direct blockchain transactions, no API keys, no rate limits
- **Only for development/testing of on-chain integration**
- See `ONCHAIN_TRADING_IMPLEMENTATION.md` for completion roadmap

## Contact

| Platform    | Link                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------ |
| 📱 Telegram | [t.me/novustch](https://t.me/novustch)                                                     |
| 📲 WhatsApp | [wa.me/14105015750](https://wa.me/14105015750)                                             |
| 💬 Discord  | [discordapp.com/users/985432160498491473](https://discordapp.com/users/985432160498491473) |

<div align="left">
    <a href="https://t.me/novustch" target="_blank"><img alt="Telegram"
        src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white"/></a>
    <a href="https://wa.me/14105015750" target="_blank"><img alt="WhatsApp"
        src="https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white"/></a>
    <a href="https://discordapp.com/users/985432160498491473" target="_blank"><img alt="Discord"
        src="https://img.shields.io/badge/Discord-7289DA?style=for-the-badge&logo=discord&logoColor=white"/></a>
</div>

Feel free to reach out for implementation assistance or integration support.

## 📋 Table of Contents

- [Overview](#-overview)
- [What's New](#-whats-new)
- [On-Chain Trading Mode](#️-on-chain-trading-mode-new)
- [Features](#-features)
- [Adaptive Learning](#-adaptive-learning)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [Requirements](#-requirements)
- [Scripts](#-scripts)
- [Arbitrage Mode (RAM + tmpfs)](#-arbitrage-mode-ram--tmpfs)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [License](#-license)
- [Disclaimer](#-disclaimer)

## 🎯 Overview

Polymarket Sniper Bot is a sophisticated automated trading system designed for the Polymarket prediction market platform. It uses **adaptive learning** to improve trade decisions over time, tracking outcomes and adjusting parameters based on historical performance.

### Key Capabilities

- **Adaptive Learning**: Learns from trade outcomes to avoid repeated mistakes
- **Smart Trade Evaluation**: Confidence-based trade decisions with size adjustments
- **Market Avoidance**: Automatically avoids markets with consecutive losses
- **Clean Authentication**: Simple `createOrDeriveApiKey()` approach
- **Rate-Limited Logging**: No log spam on auth failures
- **Real-time Arbitrage**: Intra-market arbitrage detection (YES + NO < $1.00)

## ✨ Features

- 🧠 **Adaptive Learning**: Learns optimal parameters from winning trades
- 🔍 **Mempool Monitoring**: Real-time detection of pending transactions
- 📊 **API Integration**: Hybrid approach combining mempool and API monitoring
- ⚡ **Priority Execution**: Configurable gas price multipliers for frontrunning
- 💰 **Smart Sizing**: Confidence-based size adjustments (0.25x - 2.0x)
- 🛡️ **Risk Management**: Market avoidance after consecutive losses
- 📈 **Trade Filtering**: Minimum edge/spread thresholds based on historical success
- 🔄 **Balance Validation**: Automatic checks for sufficient USDC and POL balances
- 📝 **Clean Logging**: ✅/❌ indicators for easy troubleshooting
- 🐳 **Docker Support**: Containerized deployment with Docker and Docker Compose

## 🧠 Adaptive Learning

The bot includes an **Adaptive Trade Learning System** that:

### How It Works

1. **Records all trades** with entry price, size, edge, spread, and timing
2. **Tracks outcomes** (win/loss/breakeven) and updates statistics
3. **Calculates confidence scores** for each market based on historical performance
4. **Adjusts trade parameters** based on what has worked:
   - Increases size on high-confidence trades
   - Decreases size on low-confidence trades
   - Avoids markets with repeated losses

### Trade Evaluation

Before each trade, the system evaluates:

```
✅ Market win rate (historical)
✅ Edge vs effective threshold (learned from winners)
✅ Spread vs effective threshold (learned from winners)
✅ Time of day (best/worst hours)
✅ Liquidity levels
```

### Market Avoidance

After **3 consecutive losses** on a market, it's automatically avoided for 30 minutes:

```
[Learn] ⛔ Market 0x1234abcd... added to avoid list (3 losses)
[ARB] ⛔ Skip (learner) market=0x1234abcd... confidence=0% reasons: ❌ Market avoided (3 losses, 28m remaining)
```

### Learning Summary

The bot prints a summary showing learned parameters:

```
═══════════════════════════════════════════════════
📊 ADAPTIVE LEARNING SUMMARY
═══════════════════════════════════════════════════
   Total Trades: 47
   ✅ Win Rate: 68.1% (32W/15L/0BE)
   💰 Total P/L: $+127.45
   📈 Avg/Trade: $+2.71
   ⏰ Best Hour: 14:00 UTC
   📊 Min Edge: 45bps | Max Spread: 180bps
═══════════════════════════════════════════════════
```

## 🏗️ Architecture

### Project Structure

```
polymarket-sniper-bot/
├── src/
│   ├── app/              # Application entry point
│   ├── arbitrage/        # Arbitrage engine and strategies
│   │   ├── learning/     # Adaptive learning system
│   │   ├── strategy/     # Trading strategies
│   │   ├── risk/         # Risk management
│   │   └── executor/     # Trade execution
│   ├── cli/              # CLI commands and utilities
│   ├── clob/             # CLOB authentication
│   │   └── simple-auth.ts # Simplified auth module
│   ├── config/           # Configuration management
│   ├── infrastructure/   # External service integrations
│   ├── services/         # Core business logic
│   └── utils/            # Utility functions
├── docs/                 # Documentation
├── docker-compose.yml    # Docker Compose configuration
├── Dockerfile           # Docker image definition
└── package.json         # Project dependencies
```

### System Flow

```
┌─────────────────┐
│  Mempool Monitor│
│   Service       │
└────────┬────────┘
         │
         ├─────────────────┐
         │                 │
         ▼                 ▼
┌─────────────────┐  ┌──────────────┐
│  Pending TX     │  │  API Polling │
│  Detection      │  │  (Activity)  │
└────────┬────────┘  └──────┬───────┘
         │                  │
         └──────────┬───────┘
                    │
                    ▼
         ┌──────────────────┐
         │  Trade Signal    │
         │  Generation      │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │  Trade Executor  │
         │  Service         │
         └────────┬─────────┘
                  │
                  ├──────────────┐
                  │              │
                  ▼              ▼
         ┌──────────────┐  ┌──────────────┐
         │  Balance     │  │  Order       │
         │  Validation  │  │  Execution   │
         └──────────────┘  └──────────────┘
```

### Core Components

- **MempoolMonitorService**: Monitors Polygon mempool for pending transactions
- **TradeExecutorService**: Executes frontrun trades with priority gas pricing
- **ClobClientFactory**: Creates and configures Polymarket CLOB client instances
- **Configuration**: Centralized environment variable management
- **Error Handling**: Custom error classes for better error management

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm
- Polygon wallet with USDC balance
- POL/MATIC for gas fees
- RPC endpoint supporting pending transaction monitoring

### Installation

```bash
# Clone the repository
git clone https://github.com/telix5000/Polymarket-Sniper-Bot.git
cd Polymarket-Sniper-Bot

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

Following [pmxt's methodology](https://github.com/pmxt-dev/pmxt/blob/main/core/docs/SETUP_POLYMARKET.md), the most you need is a **private key**. Everything else has sensible defaults!

Create a `.env` file with just the essentials:

```env
# Required: Your Polygon wallet private key
PRIVATE_KEY=your_bot_wallet_privatekey

# Required: Polygon RPC endpoint
RPC_URL=https://polygon-mainnet...

# Required: Addresses to monitor (for copy trading)
TARGET_ADDRESSES=0xabc...,0xdef...
```

That's it! The bot automatically:

- ✅ Derives CLOB API credentials from your private key (enabled by default)
- ✅ Uses EOA signature type (0) by default
- ✅ Uses the official Polygon USDC.e address and decimals
- ✅ Auto-detects your wallet type and auth method

> 📖 **Full configuration options:** See [.env.example](./.env.example) for all available settings.

### ⚠️ Understanding API Credentials (IMPORTANT)

Polymarket uses **TWO DIFFERENT credential systems** - confusing them will cause authentication failures:

#### 1. CLOB API Credentials (Required for ALL Trading)

These credentials are used to place and manage orders on the Polymarket CLOB (Central Limit Order Book). **YOU MUST HAVE THESE TO TRADE.**

**Purpose:** Authenticate API requests to place orders, check balances, manage positions

**Environment Variables:**

- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_API_PASSPHRASE`

**How to get them:**

- **RECOMMENDED METHOD:** Set `CLOB_DERIVE_CREDS=true` to automatically derive credentials from your private key
- The bot uses an intelligent **auto-detection and fallback system** to find the correct authentication method
- This is the official Polymarket recommendation per their docs: https://docs.polymarket.com/developers/CLOB/authentication
- **Note:** There is NO web UI to manually generate CLOB API keys - they must be created/derived programmatically using L1 authentication

**Auto-Detection & Fallback System (v2):**
The bot automatically detects your wallet type and tries multiple authentication combinations:

1. Auto-detects wallet mode: EOA (standard wallet) vs Safe (Gnosis Safe) vs Proxy (legacy)
2. Tries hard-coded fallback ladder in order until one works:
   - A) EOA + signer auth
   - B) Safe + signer auth
   - C) Safe + effective auth
   - D) Proxy + signer auth
   - E) Proxy + effective auth
3. Caches the first working combination to `/data/clob-creds.json`
4. Loads cached credentials first on next startup (verified before use)
5. If server returns 401 "Invalid L1 Request headers", immediately retries with swapped L1 auth address
6. Only caches credentials that pass verification via `/balance-allowance`

**Minimal Optional Overrides:**
Only needed in rare cases - auto-detection is recommended:

- `CLOB_FORCE_WALLET_MODE=auto|eoa|safe|proxy` - Force specific wallet mode (default: auto)
- `CLOB_FORCE_L1_AUTH=auto|signer|effective` - Force specific L1 auth address (default: auto)

> ✅ **Safe Mode Support:** In Safe/proxy mode where `signer != effective`, the bot handles this automatically and derives/verifies credentials with the correct combination. No complex configuration required!

> ⚠️ **CRITICAL:** Builder API credentials CANNOT be used as CLOB credentials. They authenticate completely different systems.

#### 2. Builder API Credentials (Optional - For Order Attribution & Gasless Transactions)

These credentials are for the Polymarket Builder program and are **ONLY** needed if you're building an app that routes orders for OTHER users and want:

- Order attribution on the Builder Leaderboard
- Gasless approval transactions via the relayer

**Purpose:** Track your builder volume, compete for grants, enable gasless approvals

**Environment Variables:**

- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_API_SECRET`
- `POLY_BUILDER_API_PASSPHRASE`

**When to use:**

- Building an application for other users (not for personal trading)
- Want gasless approval transactions via the relayer (optional optimization)
- Want to compete on the Builder Leaderboard
- Can be obtained from: https://docs.polymarket.com/developers/builders/builder-profile

**When NOT needed:**

- Personal auto-trading (like this bot for your own wallet)
- Basic trading functionality

> 📖 **Per Polymarket Docs:** "If you're building an app that routes orders for your users, you can add builder credentials to get attribution on the Builder Leaderboard" - [Source](https://docs.polymarket.com/quickstart/first-order)

#### Credential Setup Guide

**Option A: Just Private Key (Simplest - like pmxt)**

```env
# That's it! CLOB credentials are auto-derived by default
PRIVATE_KEY=your_64_hex_char_private_key
```

**Option B: Explicit CLOB Credentials (Advanced)**

```env
# Use explicit CLOB credentials (NOT builder credentials!)
POLYMARKET_API_KEY=your_clob_api_key
POLYMARKET_API_SECRET=your_clob_api_secret
POLYMARKET_API_PASSPHRASE=your_clob_api_passphrase
PRIVATE_KEY=your_64_hex_char_private_key
```

**Option C: With Builder Credentials (Full Feature Set)**

```env
# Just private key for CLOB credentials (auto-derived)
PRIVATE_KEY=your_64_hex_char_private_key

# Builder credentials for gasless approvals (optional)
POLY_BUILDER_API_KEY=your_builder_api_key
POLY_BUILDER_API_SECRET=your_builder_api_secret
POLY_BUILDER_API_PASSPHRASE=your_builder_api_passphrase
```

#### Troubleshooting 401 "Unauthorized/Invalid api key" Errors

If you see this error, follow these steps:

1. **Understand which credentials you need:**
   - **For personal auto-trading:** You need CLOB API credentials (NOT Builder keys)
   - **Builder keys cannot authenticate trading requests** - they're only for leaderboard attribution
   - The 401 error from `/balance-allowance` means your **CLOB credentials** are invalid or missing

2. **Try auto-derived credentials (recommended):**

   ```env
   # ✅ CORRECT - Auto-derive CLOB credentials with smart fallback:
   CLOB_DERIVE_CREDS=true
   PRIVATE_KEY=your_private_key
   # Remove or comment out POLYMARKET_API_* variables

   # Builder keys are optional and separate:
   POLY_BUILDER_API_KEY=<your_builder_api_key>
   POLY_BUILDER_API_SECRET=<your_builder_secret>
   POLY_BUILDER_API_PASSPHRASE=<your_builder_passphrase>
   ```

3. **For Safe/Proxy wallets:**
   The bot auto-detects wallet mode, but you can force it if needed:

   ```env
   # For Gnosis Safe (browser wallet):
   POLYMARKET_SIGNATURE_TYPE=2
   POLYMARKET_PROXY_ADDRESS=0x... # Your Safe/proxy address (REQUIRED for Safe/Proxy modes)
   # The bot will automatically try both signer and effective addresses for L1 auth

   # Optional overrides (rarely needed):
   # CLOB_FORCE_WALLET_MODE=safe
   # CLOB_FORCE_L1_AUTH=auto
   ```

   > **⚠️ IMPORTANT:** Safe/Proxy modes (signature_type=1 or 2) **REQUIRE** `POLYMARKET_PROXY_ADDRESS` to be set.
   > Without it, the bot will skip Safe/Proxy authentication attempts and only try EOA mode.

4. **If you're using Builder keys as CLOB keys:**

   ```env
   # ❌ WRONG - This will NOT work:
   POLYMARKET_API_KEY=<your_builder_api_key>
   POLYMARKET_API_SECRET=<your_builder_secret>
   POLYMARKET_API_PASSPHRASE=<your_builder_passphrase>

   # ✅ CORRECT - Use derived CLOB credentials:
   CLOB_DERIVE_CREDS=true
   # Remove or comment out POLYMARKET_API_* variables

   # Builder keys are optional and separate:
   POLY_BUILDER_API_KEY=<your_builder_api_key>
   POLY_BUILDER_API_SECRET=<your_builder_secret>
   POLY_BUILDER_API_PASSPHRASE=<your_builder_passphrase>
   ```

5. **Verify your wallet has traded on Polymarket:**
   - The CLOB may reject credentials if the wallet has never interacted with Polymarket
   - Try making a small trade via the Polymarket website first
   - The bot's fallback system will try all combinations and tell you which failed

6. **Check the logs for detailed diagnostics:**

   ```
   [Auth Identity] signerAddress=0x... effectiveAddress=0x... makerAddress=0x... funderAddress=0x...
   [AuthFallback] Attempt 1/5: A) EOA + signer auth
   [AuthFallback] ✅ Success: A) EOA + signer auth
   ```

   - Look for the "Auth Identity" line showing all addresses
   - Check which fallback attempts were tried
   - The bot will generate a comprehensive failure summary if all attempts fail

7. **Use the authentication test harness:**

   ```bash
   # Basic test
   npm run test-auth

   # Test with specific wallet type
   npm run test-auth -- --signature-type 2 --funder 0xYourSafeAddress

   # Test with verbose logging and trade history check
   npm run test-auth -- --verbose --check-history
   ```

   The test harness will:
   - Test L1 authentication (derive/create API keys)
   - Test L2 authentication (balance-allowance verification)
   - Show exactly which stage fails (L1 or L2)
   - Provide actionable troubleshooting steps
   - Optionally verify on-chain trade history
   - See [test-auth-harness.js](./test-auth-harness.js) for full documentation

8. **Check the preflight summary:**
   ```
   [Preflight][Summary] ... auth_ok=false ready_to_trade=false
   ```

   - `auth_ok=false` means CLOB authentication failed
   - `relayer_enabled=false` means Builder credentials are missing (this is OK for basic trading)
   - **See [Authentication Troubleshooting Guide](docs/AUTH_TROUBLESHOOTING.md) for detailed diagnostics and solutions**

### Debugging CLOB Authentication

When experiencing persistent 401 Unauthorized errors or identity contamination issues, use the **CLOB Authentication Probe** for deterministic, instrumented diagnostics:

#### CLOB Auth Probe Tool

The probe tool performs a minimal, controlled authentication test with detailed diagnostics:

**Basic Usage:**

```bash
# Run the authentication probe
npm run clob:probe

# Or with explicit environment variables
PRIVATE_KEY=0x... DEBUG_AUTH_PROBE=true npm run clob:probe
```

**What it does:**

1. Derives CLOB credentials from `PRIVATE_KEY`
2. Forces EOA identity (signatureType=0, no Safe/proxy contamination)
3. Makes a single GET `/balance-allowance` call
4. Prints a redacted debug bundle with:
   - Identity details (signer, wallet, maker, funder addresses)
   - Request details (URL, signed path, headers)
   - Credential details (API key prefix/suffix, secret encoding)
   - Signing details (timestamp, message digest, signature encoding)
   - Self-check validation results
5. Exits with code 0 (success) or 1 (failure)

**Environment Variables:**

- `PRIVATE_KEY` (required) - Your wallet private key
- `CLOB_HOST` (optional) - CLOB API host (default: https://clob.polymarket.com)
- `CHAIN_ID` (optional) - Chain ID (default: 137 for Polygon)
- `SIGNATURE_TYPE_FORCE` (optional) - Force signature type (default: 0 for EOA)
- `POLY_ADDRESS_FORCE` (optional) - Force specific wallet address
- `DEBUG_AUTH_PROBE` (optional) - Enable debug output (default: true)

**Identity Matrix Testing:**

Test multiple identity configurations in one run:

```bash
# Run identity matrix test
npm run clob:matrix

# Or with Safe/Proxy addresses
SAFE_ADDRESS=0x... PROXY_ADDRESS=0x... npm run clob:matrix
```

The matrix mode tests:

1. **EOA mode**: sigType=0, wallet=signer, maker=signer, funder=null
2. **Safe mode** (if `SAFE_ADDRESS` provided): sigType=2, wallet=signer, maker=safe, funder=safe
3. **Proxy mode** (if `PROXY_ADDRESS` provided): sigType=1, wallet=signer, maker=proxy, funder=proxy

**Interpreting Results:**

**Success (200 OK):**

```
✅ AUTH_PROBE_OK
  Status: 200
  Response: {"balance":"1000.000000","allowance":"1000.000000"}

[Interpretation] Authentication successful - credentials and identity are correct
```

- Your configuration is correct
- The bot should be able to authenticate successfully
- Check other potential issues (funds, allowances, etc.)

**Failure (401 Unauthorized):**

```
❌ AUTH_PROBE_FAIL
  Status: 401
  Error: {"error":"Unauthorized/Invalid api key"}

[Interpretation]
  401 Unauthorized - Most likely causes:
    1. HMAC signature mismatch (check secret encoding, message format)
    2. Invalid API credentials (regenerate with deriveApiKey)
    3. Wallet address mismatch (POLY_ADDRESS header != actual wallet)
    4. Timestamp skew (check system clock)
```

**Common Issues Detected:**

- **funderAddress not null**: Indicates Safe/proxy contamination in EOA mode
- **Query string not in signed path**: Missing parameters in HMAC signature
- **Secret encoding mismatch**: Using base64 instead of base64url (or vice versa)
- **Timestamp skew**: System clock differs significantly from server time

**Debug Bundle Example:**

```
[Identity - EOA Hard Lock]
  signerAddress:  0x1234...5678
  walletAddress:  0x1234...5678
  makerAddress:   0x1234...5678
  funderAddress:  undefined (MUST be undefined)

[Credentials - Redacted]
  apiKey:         abcd1234...wxyz (len=36)
  secret:         ABCD1234...WXYZ (len=88, encoding=base64)
  passphrase:     pass...word

[Self-Check]
  queryInPath:    ✅
  funderIsNull:   ✅
  sigTypeIsZero:  ✅
  OVERALL:        ✅ PASS
```

### Quickstart (AirVPN/WireGuard already handled), enable builder relayer + approvals

Live trading is locked behind an explicit opt-in and on-chain approvals. The bot now supports **gasless relayer approvals** via a separate signer container that holds builder API credentials.

**Minimum required environment variables**

- `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS`
- `PRIVATE_KEY` (64 hex chars or 0x + 64 hex chars, whitespace is trimmed)
- `RPC_URL`
- `COLLATERAL_TOKEN_ADDRESS` (USDC.e on Polygon)
- `CLOB_DERIVE_CREDS=true` (recommended - derive CLOB credentials from private key)

**Optional but recommended:**

- `POLY_CTF_ADDRESS` (CTF ERC1155 contract, defaults to official address)
- `POLY_CTF_EXCHANGE_ADDRESS` (spender for USDC + ERC1155 approvals, defaults to official address)
- `APPROVALS_AUTO=true` (auto-approve on startup)
- `APPROVAL_MIN_USDC=1000` (minimum allowance target)
- `APPROVAL_MAX_UINT=true` (approve max uint256)

**Gas fee configuration (EIP-1559 for Polygon)**

- `POLY_MAX_PRIORITY_FEE_GWEI=30` (minimum priority fee in gwei, default 30)
- `POLY_MAX_FEE_GWEI=60` (minimum max fee in gwei, default 60)
- `POLY_GAS_MULTIPLIER=1.2` (gas fee multiplier, default 1.2)
- `APPROVALS_MAX_RETRY_ATTEMPTS=3` (max retry attempts for approval txs, default 3)

**Relayer signing (optional - for gasless approvals)**

- `SIGNER_URL=http://signer:8080/sign` (optional, for remote signer)
- `RELAYER_URL=https://relayer-v2.polymarket.com/` (default)
- `USE_RELAYER_FOR_APPROVALS=true` (default true when builder creds are present)
- `RELAYER_TX_TYPE=SAFE` (default SAFE, can be PROXY)

The bot can use builder credentials directly (no signer container needed):

- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_API_SECRET`
- `POLY_BUILDER_API_PASSPHRASE`

Or use a remote signer container (legacy method):

- `SIGNER_URL=http://signer:8080/sign`
- `SIGNER_AUTH_TOKEN` (optional)

**CLOB API credentials**

- `CLOB_DERIVE_CREDS=true` (derive API key from private key, recommended)
- `AUTH_DERIVE_RETRY_SECONDS=600` (retry delay after 400 error, default 600s/10min)

Or provide explicit credentials:

- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_API_PASSPHRASE`

Approvals flow (startup preflight):

- `APPROVALS_AUTO=false`: prints exact approval instructions and stays detect-only.
- `APPROVALS_AUTO=dryrun`: prints the calldata/tx params it would send and stays detect-only.
- `APPROVALS_AUTO=true`: sends approval txs once (via relayer if configured), then continues if confirmed.

#### Contract addresses (official defaults)

These defaults are now baked into the config and can still be overridden via env vars if needed:

- `POLY_USDCE_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- `POLY_CTF_ADDRESS=0x4d97dcd97ec945f40cf65f87097ace5ea0476045`
- `POLY_CTF_EXCHANGE_ADDRESS=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- `POLY_NEG_RISK_CTF_EXCHANGE_ADDRESS=0xC5d563A36AE78145C45a50134d48A1215220f80a`
- `POLY_NEG_RISK_ADAPTER_ADDRESS=0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

Dry-run approvals example:

```env
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
APPROVALS_AUTO=dryrun
APPROVAL_MIN_USDC=1000
POLY_CTF_EXCHANGE_ADDRESS=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
POLY_CTF_ADDRESS=0x4d97dcd97ec945f40cf65f87097ace5ea0476045
```

If builder credentials are provided or a signer is configured, the bot can use **gasless approvals via the Polymarket relayer**. Otherwise, it falls back to **on-chain approvals via your EOA** using the configured `RPC_URL` with proper EIP-1559 gas estimation.

### Preflight CLI

Run a full trading preflight (CLOB auth, relayer deployment, approvals, and balances):

```bash
npm run build
node dist/tools/preflight.js
```

**Preflight Summary Output**

The preflight process now outputs a comprehensive summary at the end:

```
[Preflight][Summary] ========================================
[Preflight][Summary] ✅ Auth: PASSED
[Preflight][Summary] ✅ Approvals: PASSED
[Preflight][Summary] ⚪ Relayer: DISABLED
[Preflight][Summary] ✅ Ready to Trade: YES
[Preflight][Summary] ========================================
[Preflight][Summary] signer=0x... effective_trading_address=0x... relayer_enabled=false approvals_ok=true auth_ok=true ready_to_trade=true
```

Where:

- `signer`: Your EOA address derived from PRIVATE_KEY
- `effective_trading_address`: The address that will be used for trading (EOA or Safe proxy)
- `relayer_enabled`: Whether relayer/builder credentials are configured
- `approvals_ok`: Whether all required token approvals are in place
- `auth_ok`: Whether CLOB API credentials are available (explicit or derived)
- `ready_to_trade`: Overall readiness status (true = can execute trades)

### Understanding Startup Blockers

The bot checks multiple conditions at startup. When `ready_to_trade=false`, the `PRIMARY_BLOCKER` indicates the root cause:

**Common Blockers (in priority order):**

1. **`PRIMARY_BLOCKER=AUTH_FAILED`** ❌

   ```
   [Preflight] ❌ READY_TO_TRADE=false PRIMARY_BLOCKER=AUTH_FAILED
   [Preflight] ⚠️  PRIMARY STARTUP BLOCKER: Authentication failed
   [Preflight] ⚠️  Note: Approvals may show as OK, but trading is blocked by auth failure
   [Preflight] ⚠️  Run 'npm run auth:diag' for detailed authentication diagnostics
   ```

   - **What it means:** CLOB API credentials are invalid, missing, or failed verification
   - **Why approvals show OK:** Approvals check your on-chain token permissions, which are independent of CLOB auth
   - **Next steps:**
     - Run `npm run auth:diag` for detailed diagnostics
     - Check if your wallet has traded on Polymarket (required for credential derivation)
     - Verify `PRIVATE_KEY` is correct
     - Clear cached credentials: `rm -f /data/clob-creds.json`
     - Review [Authentication Troubleshooting Guide](#troubleshooting-401-unauthorizedinvalid-api-key-errors)

2. **`PRIMARY_BLOCKER=APPROVALS_FAILED`** ❌

   ```
   [Preflight] ❌ READY_TO_TRADE=false PRIMARY_BLOCKER=APPROVALS_FAILED
   ```

   - **What it means:** Your wallet lacks required token approvals or insufficient balance
   - **Next steps:**
     - Check USDC balance with `npm run check-allowance`
     - Set approvals with `npm run set-token-allowance`
     - Ensure you have sufficient USDC for trading

3. **`PRIMARY_BLOCKER=GEOBLOCKED`** ❌

   ```
   [Preflight] ❌ READY_TO_TRADE=false PRIMARY_BLOCKER=GEOBLOCKED
   ```

   - **What it means:** Your IP address is in a restricted region per Polymarket's geo-restrictions
   - **Next steps:**
     - Use a VPN or proxy from an allowed region
     - Set `SKIP_GEOBLOCK_CHECK=true` (not recommended, may violate ToS)

4. **`PRIMARY_BLOCKER=LIVE_TRADING_DISABLED`** ⚪
   ```
   [Preflight] ⚪ READY_TO_TRADE=false PRIMARY_BLOCKER=LIVE_TRADING_DISABLED
   ```

   - **What it means:** Safety flag is not set (intentional)
   - **Next steps:**
     - Set `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS` to enable live trading
     - This is a safety measure to prevent accidental real-money trading

**Important:** The bot will show `approvals_ok=true` even when `auth_ok=false` because these are **independent checks**:

- **Auth check** = Can I communicate with CLOB API?
- **Approvals check** = Do I have on-chain token permissions?

Both must pass for `ready_to_trade=true`, but the auth failure is the **primary blocker** if it fails first.

### Auth Story Summary

Every startup produces a single "Auth Story" JSON summary showing all authentication attempts:

```json
{
  "runId": "run_1234567890_abc123",
  "selectedMode": "EOA",
  "signerAddress": "0x...",
  "clobHost": "https://clob.polymarket.com",
  "attempts": [
    {
      "attemptId": "A",
      "mode": "EOA",
      "httpStatus": 401,
      "success": false,
      "errorTextShort": "Unauthorized/Invalid api key"
    }
  ],
  "finalResult": {
    "authOk": false,
    "readyToTrade": false,
    "reason": "AUTH_FAILED"
  }
}
```

This summary is printed once per startup and includes all relevant diagnostic information without exposing secrets.

## CLOB Auth Diagnostics

The bot ships with safe diagnostics to help debug persistent `401 Unauthorized/Invalid api key` errors **without logging secrets**. The diagnostics are logged at startup and during the preflight auth call.

**What you’ll see**

- `[Keys]` private key format validation (no key exposure)
- `[Gas]` RPC feeData and selected gas parameters for EIP-1559
- `[Relayer]` relayer/builder configuration status
- `[CLOB]` API key creation backoff timer (for derived credentials)
- `[CLOB][Diag]` identity summary: derived signer address, configured public key, match status, chain ID, host, signature type, funder/maker addresses, masked API key ID, and key/secret/passphrase presence booleans.
- `[CLOB][Diag][AuthFunds]` auth+funds summary: derived signer, configured public key match, effective `POLY_ADDRESS`, signature type, funder/proxy address, and credential mode (`explicit` vs `derived`).
- `[CLOB][Diag][Sign]` signing summary: method/path/body flags, message hash (sha256 prefix), secret hash (sha256 prefix of decoded bytes), and the signature/secret encoding modes.
- `[CLOB][Preflight]` status: runs a one-time auth call to `/balance-allowance?asset_type=COLLATERAL`, backing off on failures to avoid spam.
- `[CLOB][401]` compact failure line: safe snapshot of address, signature type, funder, decoding/encoding modes, message hash, and key ID suffix.

**How to interpret failures**

If preflight fails with 401, the logs will classify the likely root cause as one of:

- `MISMATCHED_ADDRESS` (PUBLIC_KEY doesn’t match derived signer)
- `WRONG_SIGNATURE_TYPE` (signature type doesn’t align with the provided signer)
- `SECRET_ENCODING` (secret looks base64url but decoding mode differs)
- `MESSAGE_CANONICALIZATION` (path/body mismatch in signature inputs)
- `SERVER_REJECTED_CREDS` (credentials rejected server-side)

When a 401 occurs, the runtime automatically switches to detect-only mode.

**⚠️ Important:** The bot now uses **severity-based classification** for preflight errors:

- **FATAL** (401/403): Blocks trading - credentials are invalid
- **TRANSIENT** (network/server errors): Allows trading - temporary issues
- **NON_FATAL** (bad params, unknown): Allows trading - credentials are valid

See [Preflight Severity Guide](docs/PREFLIGHT_SEVERITY_GUIDE.md) for details on how the bot handles different failure types.

### Balance/Allowance API params

Polymarket’s `/balance-allowance` endpoint requires the following query parameters:

- `asset_type=COLLATERAL` (no `token_id` required) — for USDC collateral checks.
- `asset_type=CONDITIONAL&token_id=<tokenId>` — for conditional tokens (YES/NO) checks.

The bot signs **the exact path + querystring** it sends (e.g. `/balance-allowance?asset_type=COLLATERAL`), so mismatched params will fail preflight.

### Common failure modes (and next steps)

- **401 Unauthorized** → Check API key/secret/passphrase, `PUBLIC_KEY`, `signature_type`, and `POLY_ADDRESS` alignment.
- **400 Invalid asset type** → Ensure `asset_type` is `COLLATERAL` or `CONDITIONAL` and include `token_id` for conditional tokens.
- **400 Insufficient balance/allowance** → Top up collateral and/or approve spending for the collateral or conditional token.

## 🧮 Arbitrage Mode (RAM + tmpfs)

The arbitrage engine is a first-class runtime mode designed for **RAM-first state** with optional snapshots and JSONL decision logs stored in a tmpfs-mounted `/data` directory. No database is used.

### Run Mode

```bash
# Arbitrage only
MODE=arb yarn arbitrage

# Mempool only (default)
MODE=mempool npm run dev

# Both loops (isolated logging + loops)
MODE=both npm run dev
```

`MODE` controls whether the arbitrage engine is enabled; `MODE=arb` or `MODE=both` turns it on.

### Example `.env` for Arbitrage (Preset-based)

```env
MODE=arb
RPC_URL=https://polygon-mainnet...
PRIVATE_KEY=your_wallet_private_key
PUBLIC_KEY=your_wallet_public_key
COLLATERAL_TOKEN_ADDRESS=0x2791...
ARB_PRESET=classic
CLOB_DERIVE_CREDS=true
POLYMARKET_API_KEY=your_clob_api_key
POLYMARKET_API_SECRET=your_clob_api_secret
POLYMARKET_API_PASSPHRASE=your_clob_api_passphrase

# Optional safe overrides (see Advanced Overrides)
ARB_DRY_RUN=true
ARB_MAX_WALLET_EXPOSURE_USD=50
```

### How to Find Your Collateral Token (USDC vs USDC.e)

The bot **must** know which stablecoin contract it is trading against so it can:

- Check your **balance** accurately.
- Verify and set **allowances** correctly.
- Format sizes with the correct **decimals**.

This is why `COLLATERAL_TOKEN_ADDRESS` and `COLLATERAL_TOKEN_DECIMALS` exist. Your **wallet address is not enough**—the wallet is just an owner; the collateral token is a separate smart contract.

#### Step 1 — Identify which collateral Polymarket is using

Polymarket runs on Polygon and currently uses **USDC‑style tokens**. Two common variants exist:

- **USDC (native, Circle-issued)**
- **USDC.e (bridged)**

You must provide the address of the one **actually used for settlement** in your environment.

#### Step 2 — Get the contract address from a trusted source

Use **one of these** (pick the one you are comfortable with):

1. **Polymarket / official docs**  
   Look for “collateral token” or “USDC contract” in official Polymarket docs or announcements.
   - This is the most authoritative source if they publish it.

2. **PolygonScan (most direct)**
   - Go to https://polygonscan.com
   - Search for **USDC** and **USDC.e** in the token search bar.
   - Open each token page and compare **symbol + issuer**:
     - USDC (Circle) usually shows **Circle** as the verified issuer.
     - USDC.e is a bridged token and will show a **different issuer**.
   - Copy the **contract address** from the token page.

3. **Your wallet UI**
   - If your wallet already shows a USDC/USDC.e balance, open the token details.
   - Most wallets show the **token contract address** in the asset details.
   - Copy that contract address.

#### Step 3 — Confirm decimals (usually 6)

USDC and USDC.e are both **6‑decimals** tokens on Polygon in nearly all cases.  
Unless you are using a non‑USDC collateral, you should set:

```
COLLATERAL_TOKEN_DECIMALS=6
```

#### Step 4 — Set the env vars

Example:

```env
COLLATERAL_TOKEN_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
COLLATERAL_TOKEN_DECIMALS=6
```

If you already hold **USDC.e**, you should use the **USDC.e token contract address** from the methods above.  
If you don’t set this, the bot defaults to Polygon USDC, which **may not match** your balance/allowance.

### Docker Compose (tmpfs `/data`)

`/data` can be mounted as a **tmpfs** for faster, volatile state. Contents are **ephemeral** and cleared on container restart.

```yaml
services:
  polymarket-arb:
    build: .
    environment:
      - MODE=arb
      - ARB_PRESET=safe_small
      - ARB_DRY_RUN=true
      - RPC_URL=${RPC_URL}
      - PRIVATE_KEY=${PRIVATE_KEY}
      - COLLATERAL_TOKEN_ADDRESS=${COLLATERAL_TOKEN_ADDRESS}
    tmpfs:
      - /data:size=32m,mode=0700
```

### Operational Safety Notes

- **Kill switch:** touching `/data/KILL` halts new trade submissions immediately (scans/logs continue).
- **Circuit breaker:** trading stops after `ARB_MAX_CONSECUTIVE_FAILURES` to prevent runaway errors.
- **Caps:** per-market and total wallet exposure caps are enforced on every decision.
- **Idempotency:** opportunity fingerprints are cached (10 min TTL) to avoid double-firing.
- **No secrets in logs:** only structured trade decisions + high-level events are logged.
- **Conservative defaults:** the default sizing and caps are intentionally small; scale only after validating fill rates, slippage, and net edge.
- **Cloudflare protection:** if the CLOB endpoint responds with a Cloudflare block (HTTP 403 + HTML), the bot pauses order submission for `CLOUDFLARE_COOLDOWN_SECONDS` while continuing to monitor/detect trades.
- **Order throttling:** order submission enforces `ORDER_SUBMIT_MIN_INTERVAL_MS`, `ORDER_SUBMIT_MAX_PER_HOUR`, and per-market cooldowns to avoid hammering endpoints.

### Troubleshooting

- If **no trades happen**, confirm `MODE=arb` or `MODE=both` and `ARB_DRY_RUN=true` (or `ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS`).
- If **decisions log is empty**, ensure `/data` is writable and `ARB_DECISIONS_LOG` is set.
- If **trades are blocked**, check for `/data/KILL`, low POL balance, or breached exposure caps.

#### CLOB Allowance Bug Workaround

**Symptom**: You see warnings like:

```
[WARN] [CLOB] Order skipped (INSUFFICIENT_BALANCE_OR_ALLOWANCE): need=0.87 have=93002583.00 allowance=0.00
```

**Cause**: The Polymarket CLOB API has a [known bug](https://github.com/Polymarket/clob-client/issues/128) where `getBalanceAllowance()` returns `allowance=0` even when on-chain approvals are correctly set to unlimited.

**Solution**: The bot now includes a workaround that trusts on-chain approval verification from preflight checks instead of the CLOB API response. This is **enabled by default**.

To verify it's working, look for logs like:

```
[Preflight][Approvals][USDC] ✅ spender=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E allowance=unlimited
[CLOB][TrustMode] Bypassing CLOB allowance check - trusting on-chain approvals verified in preflight
```

To disable this workaround (not recommended):

```bash
TRUST_ONCHAIN_APPROVALS=false
```

**Related Issues**:

- [Polymarket clob-client #128](https://github.com/Polymarket/clob-client/issues/128) - "getBalanceAllowance returns 0"
- [Polymarket py-clob-client #102](https://github.com/Polymarket/py-clob-client/issues/102) - "Allowance function says balance 0"
- [Polymarket py-clob-client #109](https://github.com/Polymarket/py-clob-client/issues/109) - "Not Enough Balance / Allowance Error"

### Running the Bot

```bash
# Development mode
npm run dev

# Production mode
npm run build && npm start
```

### Docker Deployment

```bash
# Using Docker Compose
docker-compose up -d

# Or using Docker directly
docker build -t polymarket-sniper-bot .
docker run --env-file .env polymarket-sniper-bot
```

## ⚙️ Configuration

### Required Environment Variables

| Variable                               | Description                                                                 | Example                                                |
| -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `RPC_URL`                              | Polygon RPC endpoint (must support pending tx monitoring)                   | `https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID` |
| `PRIVATE_KEY`                          | Your wallet private key                                                     | `your_private_key`                                     |
| `COLLATERAL_TOKEN_ADDRESS`             | USDC / USDC.e contract                                                      | `0x2791...`                                            |
| `MODE`                                 | `mempool`, `arb`, or `both`                                                 | `both`                                                 |
| `ARB_PRESET`                           | Arbitrage preset name                                                       | `safe_small`                                           |
| `MONITOR_PRESET`                       | Monitor preset name                                                         | `balanced`                                             |
| `MONITOR_REQUIRE_CONFIRMED`            | Require confirmed trades before acting                                      | `true`                                                 |
| `MIN_ORDER_USD`                        | Minimum order size before submission                                        | `10`                                                   |
| `ORDER_SUBMIT_MIN_INTERVAL_MS`         | Min ms between submits                                                      | `20000`                                                |
| `ORDER_SUBMIT_MAX_PER_HOUR`            | Max submits per hour                                                        | `20`                                                   |
| `ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS` | Per-market cooldown seconds                                                 | `300`                                                  |
| `CLOUDFLARE_COOLDOWN_SECONDS`          | Pause submits after Cloudflare block                                        | `3600`                                                 |
| `TARGET_ADDRESSES`                     | (Monitor only) Comma-separated addresses to monitor                         | `0xabc...,0xdef...`                                    |
| `PUBLIC_KEY`                           | (Optional) Wallet address override; derived from `PRIVATE_KEY` when omitted | `your_wallet_address`                                  |
| `ARB_DEBUG_TOP_N`                      | (Arb only) Log top N pre-filter candidates each scan                        | `0`                                                    |

### Relayer + approvals (recommended)

| Variable                             | Description                                | Example                              |
| ------------------------------------ | ------------------------------------------ | ------------------------------------ |
| `RELAYER_URL`                        | Polymarket relayer endpoint                | `https://relayer-v2.polymarket.com/` |
| `SIGNER_URL`                         | Remote signer endpoint in Docker network   | `http://signer:8080/sign`            |
| `SIGNER_AUTH_TOKEN`                  | (Optional) Bearer token shared with signer | `my-token`                           |
| `POLY_CTF_ADDRESS`                   | CTF ERC1155 contract                       | `0x4d97...`                          |
| `POLY_CTF_EXCHANGE_ADDRESS`          | CTF exchange spender                       | `0x4bFb...`                          |
| `POLY_NEG_RISK_CTF_EXCHANGE_ADDRESS` | Neg-risk CTF exchange spender              | `0xC5d...`                           |
| `POLY_NEG_RISK_ADAPTER_ADDRESS`      | Neg-risk adapter                           | `0xd91E...`                          |
| `APPROVAL_MIN_USDC`                  | Minimum USDC approval threshold            | `1000`                               |
| `APPROVAL_MAX_UINT`                  | Approve `maxUint256`                       | `true`                               |
| `APPROVALS_AUTO`                     | Auto-approve on startup                    | `true`                               |

### WireGuard (optional)

Enable WireGuard if your RPC or Polymarket connectivity requires a VPN tunnel. The bot can build a config from env vars or accept a full config blob.

### OpenVPN (optional)

Use OpenVPN if your provider ships `.ovpn` configs (e.g., AirVPN). OpenVPN and WireGuard are mutually exclusive; if both are enabled, OpenVPN takes priority.

**Supported env vars**

- `OPENVPN_ENABLED` (default `false`)
- `OPENVPN_CONFIG` (full config contents; optional if you mount a config file)
- `OPENVPN_CONFIG_PATH` (default `/etc/openvpn/openvpn.conf`)
- `OPENVPN_AUTH_PATH` (default `/etc/openvpn/auth.txt`)
- `OPENVPN_USERNAME`
- `OPENVPN_PASSWORD`
- `OPENVPN_EXTRA_ARGS` (extra args passed to `openvpn`, e.g. `--verb 3`)

**Example (AirVPN-style config + env auth)**

```env
OPENVPN_ENABLED=true
OPENVPN_CONFIG=client\nproto udp\nremote europe3.vpn.airdns.org 443\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\ncipher AES-256-GCM\nauth SHA512\nkey-direction 1\n<ca>\n...\n</ca>\n<tls-auth>\n...\n</tls-auth>\n
OPENVPN_USERNAME=your_airvpn_username
OPENVPN_PASSWORD=your_airvpn_password
```

> Docker: OpenVPN requires `NET_ADMIN` and `/dev/net/tun` access (see `docker-compose.yml`). Device access must be granted at runtime; it cannot be baked into the image.

**Supported env vars**

- `WIREGUARD_ENABLED` (default `false`)
- `WIREGUARD_INTERFACE_NAME` (default `wg0`)
- `WIREGUARD_CONFIG_PATH` (default `/etc/wireguard/<interface>.conf`)
- `WIREGUARD_CONFIG` (full config; overrides per-field vars)
- `WIREGUARD_ADDRESS`
- `WIREGUARD_PRIVATE_KEY`
- `WIREGUARD_MTU`
- `WIREGUARD_DNS`
- `WIREGUARD_PEER_PUBLIC_KEY`
- `WIREGUARD_PEER_PRESHARED_KEY`
- `WIREGUARD_PEER_ENDPOINT`
- `WIREGUARD_ALLOWED_IPS`
- `WIREGUARD_PERSISTENT_KEEPALIVE`
- `WIREGUARD_FORCE_RESTART` (default `false`)

**Example (per-field env vars)**

```env
WIREGUARD_ENABLED=true
WIREGUARD_INTERFACE_NAME=wg0
WIREGUARD_ADDRESS=10.151.22.111/32,fd7d:76ee:e68f:a993:c4ca:f41:f871:35b4/128
WIREGUARD_PRIVATE_KEY=your_private_key
WIREGUARD_MTU=1320
WIREGUARD_DNS=10.128.0.1,fd7d:76ee:e68f:a993::1
WIREGUARD_PEER_PUBLIC_KEY=your_peer_public_key
WIREGUARD_PEER_PRESHARED_KEY=your_preshared_key
WIREGUARD_PEER_ENDPOINT=europe3.vpn.airdns.org:1637
WIREGUARD_ALLOWED_IPS=0.0.0.0/0,::/0
WIREGUARD_PERSISTENT_KEEPALIVE=15
WIREGUARD_FORCE_RESTART=false
```

> Docker: WireGuard requires privileged mode **and** `NET_ADMIN` + `/dev/net/tun` access (see `docker-compose.yml`). Device access must be granted at runtime; it cannot be baked into the image.
> Ensure `ip6tables-restore` is available in the container if you use IPv6 addresses/allowed IPs; otherwise remove IPv6 entries.

### Presets

Defaults: `ARB_PRESET=safe_small` and `MONITOR_PRESET=balanced`.

**Arbitrage presets**

| Name         | What it does                        | Frequency | Risk   |
| ------------ | ----------------------------------- | --------- | ------ |
| `off`        | Disables arbitrage loop             | N/A       | None   |
| `safe_small` | Small sizing + conservative caps    | 2s scan   | Low    |
| `classic`    | Balanced sizing and caps            | 2s scan   | Medium |
| `micro`      | Faster scans, lower edge threshold  | 1.5s scan | Medium |
| `quality`    | Higher edge + liquidity filters     | 2.5s scan | Low    |
| `late`       | Faster scans, more spread tolerance | 1s scan   | Medium |

**Monitor presets**

| Name           | What it does                    | Frequency | Risk    |
| -------------- | ------------------------------- | --------- | ------- |
| `off`          | Disables mempool monitor        | N/A       | None    |
| `conservative` | Higher minimum trade size       | 2s poll   | Low     |
| `balanced`     | Default hybrid thresholds       | 2s poll   | Medium  |
| `active`       | Lower minimum trade size        | 1s poll   | Higher  |
| `test`         | Very low thresholds for testing | 2s poll   | Highest |

`MONITOR_REQUIRE_CONFIRMED` is `true` for `conservative`/`balanced` and `false` for `active`/`test`.

### Advanced Overrides (Allowlist)

Presets are the default. Only a short list of overrides are allowed unless you explicitly enable unsafe overrides.

**Arbitrage safe overrides**

- `ARB_DRY_RUN`
- `ARB_LIVE_TRADING`
- `ARB_MAX_WALLET_EXPOSURE_USD`
- `ARB_MAX_POSITION_USD`
- `ARB_MAX_TRADES_PER_HOUR`
- `ARB_MAX_SPREAD_BPS`
- `ARB_KILL_SWITCH_FILE`
- `ARB_DECISIONS_LOG`
- `ARB_MIN_POL_GAS`
- `ARB_SCAN_INTERVAL_MS`
- `ARB_DEBUG_TOP_N`

**Monitor safe overrides**

- `MIN_TRADE_SIZE_USD`
- `TRADE_MULTIPLIER`
- `FETCH_INTERVAL`
- `GAS_PRICE_MULTIPLIER`
- `MONITOR_REQUIRE_CONFIRMED`
- `MIN_ORDER_USD`
- `ORDER_SUBMIT_MIN_INTERVAL_MS`
- `ORDER_SUBMIT_MAX_PER_HOUR`
- `ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS`
- `CLOUDFLARE_COOLDOWN_SECONDS`

To override anything else, set `ARB_ALLOW_UNSAFE_OVERRIDES=true`. The bot will warn when unsafe or legacy overrides are used.

`ARB_MAX_SPREAD_BPS` can be overridden without abandoning presets so you can tune spread tolerance while keeping the preset baseline.

`ARB_DEBUG_TOP_N` logs a ranked pre-filter snapshot each scan (market_id, yesBid/yesAsk, noBid/noAsk, sum, edge_bps, spread_bps, liquidity).

### Legacy Environment Variables

Legacy `ARB_*` and monitor thresholds still work, but the README intentionally steers you to presets. If legacy vars are detected without a preset, the bot switches to `preset=custom` and logs a warning.

### Changelog (Recent)

- Added preset-based configuration for arbitrage + monitor modes to reduce env tuning.

### Finding Target Wallets

To identify successful traders to track:

- **Polymarket Leaderboard**: https://polymarket.com/leaderboard
- **Predictfolio**: https://predictfolio.com/ - Analytics platform for prediction market traders

## 📋 Requirements

- **Node.js**: 18 or higher
- **Polygon Wallet**: With USDC balance for trading
- **POL/MATIC**: For gas fees (recommended: 0.2-1.0 POL)
- **RPC Endpoint**: Must support pending transaction monitoring (Infura, Alchemy, QuickNode)

## 📜 Scripts

| Command                       | Description                      |
| ----------------------------- | -------------------------------- |
| `npm run dev`                 | Development mode with TypeScript |
| `npm run build`               | Compile TypeScript to JavaScript |
| `npm start`                   | Run compiled production build    |
| `npm run lint`                | Run ESLint                       |
| `npm run lint:fix`            | Fix ESLint errors automatically  |
| `npm run format`              | Format code with Prettier        |
| `npm run check-allowance`     | Check token allowance            |
| `npm run verify-allowance`    | Verify token allowance           |
| `npm run set-token-allowance` | Set token allowance              |
| `npm run manual-sell`         | Manual sell command              |
| `npm run simulate`            | Run trading simulations          |
| `npm run arbitrage`           | Run the arbitrage engine         |
| `npm run test`                | Run unit/integration tests       |

## 🩺 Troubleshooting Authentication

If you encounter authentication errors (401 "Unauthorized/Invalid api key"), run the diagnostic tool:

```bash
node diagnose-auth.js
```

This will:

- ✅ Check your environment variables
- ✅ Verify wallet connection and balance
- ✅ Test Polymarket API connectivity
- ✅ Attempt credential derivation and verification
- ✅ Auto-detect the correct signature type
- ✅ Provide actionable error messages

### Common Issues

**"Unauthorized/Invalid api key" Error**

- **Cause**: Query parameter signature mismatch (fixed in latest version)
- **Solution**: Pull latest changes and run `npm install` to apply the updated patch

**"Could not create api key" Error**

- **Cause**: Wallet has never traded on Polymarket
- **Solution**:
  1. Visit https://polymarket.com
  2. Connect your wallet (the one from PRIVATE_KEY)
  3. Make at least ONE small trade (even $1)
  4. Wait for transaction confirmation (1-2 minutes)
  5. Restart the bot

**Still Having Issues?**
See [Authentication Fix Documentation](./AUTHENTICATION_FIX.md) for detailed technical information about the recent authentication fix.

## 🔧 Advanced Troubleshooting: 401 Errors

If you're getting **401 "Unauthorized/Invalid api key"** errors despite having valid credentials and having traded on Polymarket, use the **HMAC Diagnostic Tool**:

### Quick Diagnostic

```bash
# Enable diagnostic tracing
ENABLE_HMAC_DIAGNOSTICS=true \
DEBUG_HMAC_SIGNING=true \
node scripts/test-hmac-diagnostic.js
```

This will show you the **exact mismatch** between what we sign vs what we send to the API.

**Common Issues & Fixes:**

1. **Query Parameter Order Mismatch**
   - **Symptom**: Diagnostic shows different param order in signed vs actual path
   - **Fix**: Already patched in `patches/@polymarket+clob-client+5.2.1.patch`
   - **Action**: Run `npm install` to apply patch

2. **Wrong Signature Type**
   - **Symptom**: You created your wallet via Polymarket website (not MetaMask directly)
   - **Fix**: Set `POLYMARKET_SIGNATURE_TYPE=2` and `POLYMARKET_PROXY_ADDRESS=<your-proxy-address>`
   - **How to find proxy address**: Go to polymarket.com → Connect wallet → Profile → Deposit address

3. **Detailed Diagnostic Output**
   - See **[HMAC Diagnostic Fix](./HMAC_DIAGNOSTIC_FIX.md)** for complete documentation
   - See **[Next Steps](./NEXT_STEPS_401_FIX.md)** for step-by-step guidance

## 📚 Documentation

- **[Complete Guide](./docs/GUIDE.md)**: Detailed setup, configuration, and troubleshooting
- **[Authentication Troubleshooting](./docs/AUTH_TROUBLESHOOTING.md)**: Fixing authentication issues
- **[Credentials Explained](./docs/CREDENTIALS_EXPLAINED.md)**: Understanding CLOB vs Builder credentials
- **[Authentication Fix](./AUTHENTICATION_FIX.md)**: Technical details about the authentication fix
- **[HMAC Diagnostic Fix](./HMAC_DIAGNOSTIC_FIX.md)**: Advanced 401 error diagnostics
- **[Next Steps for 401 Errors](./NEXT_STEPS_401_FIX.md)**: Step-by-step troubleshooting guide
- **[Architecture Overview](#-architecture)**: System design and component overview

## 🤝 Contributing

Contributions are welcome! Please see our [Contributing Guidelines](./CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Follow TypeScript best practices
- Use ESLint and Prettier for code formatting
- Write meaningful commit messages
- Add tests for new features

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](./LICENSE) file for details.

## ⚠️ Disclaimer

**This software is provided as-is for educational and research purposes only.**

- Trading involves substantial risk of loss
- Past performance does not guarantee future results
- Use at your own risk
- The authors and contributors are not responsible for any financial losses
- Always test thoroughly in a safe environment before using real funds
- Ensure compliance with local regulations and terms of service

---

<div align="center">

**Built with ❤️ for the Polymarket community**

[⭐ Star this repo](https://github.com/Novus-Tech-LLC/Polymarket-Sniper-Bot) if you find it helpful!

</div>
