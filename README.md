# Polymarket Sniper Bot

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)

**Automated trading bot for Polymarket with mempool monitoring and priority execution**

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Contributing](#-contributing)

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [Requirements](#-requirements)
- [Scripts](#-scripts)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [Support](#-support)
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

Create a `.env` file in the project root:

```env
# Required
TARGET_ADDRESSES=0xabc...,0xdef...    # Target addresses to frontrun (comma-separated)
PUBLIC_KEY=your_bot_wallet             # Public address of your bot wallet
PRIVATE_KEY=your_bot_wallet_privatekey # Private key of above address
RPC_URL=https://polygon-mainnet...     # Polygon RPC endpoint

# Optional
FETCH_INTERVAL=1                       # Polling interval (seconds)
MIN_TRADE_SIZE_USD=100                 # Minimum trade size to frontrun (USD)
FRONTRUN_SIZE_MULTIPLIER=0.5           # Frontrun size as % of target (0.0-1.0)
GAS_PRICE_MULTIPLIER=1.2               # Gas price multiplier for priority
USDC_CONTRACT_ADDRESS=0x2791...        # USDC contract (default: Polygon mainnet)
```

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
| `TARGET_ADDRESSES` | Comma-separated target addresses to frontrun | `0xabc...,0xdef...` |
| `PUBLIC_KEY` | Your Polygon wallet address | `your_wallet_address` |
| `PRIVATE_KEY` | Your wallet private key | `your_private_key` |
| `RPC_URL` | Polygon RPC endpoint (must support pending tx monitoring) | `https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID` |

### Optional Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FETCH_INTERVAL` | `1` | Polling frequency in seconds |
| `MIN_TRADE_SIZE_USD` | `100` | Minimum trade size to frontrun (USD) |
| `FRONTRUN_SIZE_MULTIPLIER` | `0.5` | Frontrun size as % of target (0.0-1.0) |
| `GAS_PRICE_MULTIPLIER` | `1.2` | Gas price multiplier for priority (e.g., 1.2 = 20% higher) |
| `RETRY_LIMIT` | `3` | Maximum retry attempts for failed orders |
| `USDC_CONTRACT_ADDRESS` | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | USDC contract on Polygon |

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

## Support 

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
