# Polymarket Sniper Bot

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)

**Automated trading bot for Polymarket with mempool monitoring and priority execution**

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Contributing](#-contributing)

</div>

---

## Contact 

| Platform | Link |
|----------|------|
| 📱 Telegram | [t.me/novustch](https://t.me/novustch) |
| 📲 WhatsApp | [wa.me/14105015750](https://wa.me/14105015750) |
| 💬 Discord | [discordapp.com/users/985432160498491473](https://discordapp.com/users/985432160498491473)

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
- [Features](#-features)
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

Polymarket Sniper Bot is a sophisticated automated trading system designed for the Polymarket prediction market platform. It monitors the Polygon mempool and Polymarket API for pending trades from target addresses, then executes orders with higher priority gas pricing to frontrun target transactions.

### Key Capabilities

- **Real-time Mempool Monitoring**: Subscribes to pending transactions on Polygon network
- **Hybrid Detection**: Combines mempool monitoring with API polling for comprehensive trade detection
- **Priority Execution**: Configurable gas price multipliers for competitive frontrunning
- **Intelligent Sizing**: Proportional frontrun sizing based on target trade size
- **Error Handling**: Robust retry mechanisms and error recovery
- **Balance Management**: Automatic balance validation before trade execution

## ✨ Features

- 🔍 **Mempool Monitoring**: Real-time detection of pending transactions to Polymarket contracts
- 📊 **API Integration**: Hybrid approach combining mempool and API monitoring for faster detection
- ⚡ **Priority Execution**: Configurable gas price multipliers for frontrunning
- 💰 **Smart Sizing**: Proportional frontrun sizing (configurable multiplier)
- 🛡️ **Error Handling**: Comprehensive error handling with retry logic
- 📈 **Trade Filtering**: Minimum trade size thresholds to focus on profitable opportunities
- 🔄 **Balance Validation**: Automatic checks for sufficient USDC and POL balances
- 📝 **Structured Logging**: Color-coded console logging with debug support
- 🐳 **Docker Support**: Containerized deployment with Docker and Docker Compose
- 🔧 **CLI Tools**: Utility commands for allowance management and manual operations

## 🏗️ Architecture

### Project Structure

```
polymarket-sniper-bot/
├── src/
│   ├── app/              # Application entry point
│   ├── cli/              # CLI commands and utilities
│   ├── config/           # Configuration management
│   ├── constants/        # Application constants
│   ├── domain/           # Domain models and types
│   ├── errors/           # Custom error classes
│   ├── infrastructure/  # External service integrations
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
git clone https://github.com/your-org/polymarket-sniper-bot.git
cd polymarket-sniper-bot

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

Create a `.env` file in the project root (preset-first quick start):

```env
RPC_URL=https://polygon-mainnet...
PRIVATE_KEY=your_bot_wallet_privatekey
COLLATERAL_TOKEN_ADDRESS=0x2791...
MODE=both
ARB_PRESET=safe_small
MONITOR_PRESET=balanced
POLYMARKET_API_KEY=your_clob_api_key
POLYMARKET_API_SECRET=your_clob_api_secret
POLYMARKET_API_PASSPHRASE=your_clob_api_passphrase
```

> ✅ **Note:** To actually run the monitor loop you still need `TARGET_ADDRESSES` and `PUBLIC_KEY`. The quick start above is intentionally minimal to highlight presets.
> ✅ **Note:** `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, and `POLYMARKET_API_PASSPHRASE` are required for CLOB access.

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

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | Polygon RPC endpoint (must support pending tx monitoring) | `https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID` |
| `PRIVATE_KEY` | Your wallet private key | `your_private_key` |
| `COLLATERAL_TOKEN_ADDRESS` | USDC / USDC.e contract | `0x2791...` |
| `MODE` | `mempool`, `arb`, or `both` | `both` |
| `ARB_PRESET` | Arbitrage preset name | `safe_small` |
| `MONITOR_PRESET` | Monitor preset name | `balanced` |
| `MONITOR_REQUIRE_CONFIRMED` | Require confirmed trades before acting | `true` |
| `MIN_ORDER_USD` | Minimum order size before submission | `10` |
| `ORDER_SUBMIT_MIN_INTERVAL_MS` | Min ms between submits | `20000` |
| `ORDER_SUBMIT_MAX_PER_HOUR` | Max submits per hour | `20` |
| `ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS` | Per-market cooldown seconds | `300` |
| `CLOUDFLARE_COOLDOWN_SECONDS` | Pause submits after Cloudflare block | `3600` |
| `TARGET_ADDRESSES` | (Monitor only) Comma-separated addresses to monitor | `0xabc...,0xdef...` |
| `PUBLIC_KEY` | (Monitor only) Your Polygon wallet address | `your_wallet_address` |
| `ARB_DEBUG_TOP_N` | (Arb only) Log top N pre-filter candidates each scan | `0` |

### WireGuard (optional)

Enable WireGuard if your RPC or Polymarket connectivity requires a VPN tunnel. The bot can build a config from env vars or accept a full config blob.

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

> Docker: WireGuard requires `NET_ADMIN` and `/dev/net/tun` access (see `docker-compose.yml`) and a writable
> `/proc/sys/net/ipv4/conf/all/src_valid_mark` (set via `--sysctl net.ipv4.conf.all.src_valid_mark=1` when needed).
> Ensure `ip6tables-restore` is available in the container if you use IPv6 addresses/allowed IPs; otherwise remove IPv6 entries.

### Presets

Defaults: `ARB_PRESET=safe_small` and `MONITOR_PRESET=balanced`.

**Arbitrage presets**

| Name | What it does | Frequency | Risk |
|------|---------------|-----------|------|
| `off` | Disables arbitrage loop | N/A | None |
| `safe_small` | Small sizing + conservative caps | 2s scan | Low |
| `classic` | Balanced sizing and caps | 2s scan | Medium |
| `micro` | Faster scans, lower edge threshold | 1.5s scan | Medium |
| `quality` | Higher edge + liquidity filters | 2.5s scan | Low |
| `late` | Faster scans, more spread tolerance | 1s scan | Medium |

**Monitor presets**

| Name | What it does | Frequency | Risk |
|------|---------------|-----------|------|
| `off` | Disables mempool monitor | N/A | None |
| `conservative` | Higher minimum trade size | 2s poll | Low |
| `balanced` | Default hybrid thresholds | 2s poll | Medium |
| `active` | Lower minimum trade size | 1s poll | Higher |
| `test` | Very low thresholds for testing | 2s poll | Highest |

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

| Command | Description |
|---------|-------------|
| `npm run dev` | Development mode with TypeScript |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run compiled production build |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix ESLint errors automatically |
| `npm run format` | Format code with Prettier |
| `npm run check-allowance` | Check token allowance |
| `npm run verify-allowance` | Verify token allowance |
| `npm run set-token-allowance` | Set token allowance |
| `npm run manual-sell` | Manual sell command |
| `npm run simulate` | Run trading simulations |
| `npm run arbitrage` | Run the arbitrage engine |
| `npm run test` | Run unit/integration tests |

## 📚 Documentation

- **[Complete Guide](./docs/GUIDE.md)**: Detailed setup, configuration, and troubleshooting
- **[Architecture Overview](#-architecture)**: System design and component overview
- **[API Reference](./docs/API.md)**: (Coming soon) Detailed API documentation

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
