# Complete Guide

## Table of Contents

- [Finding Target Wallets](#finding-target-wallets)
- [Installation](#installation)
- [Configuration](#configuration)
- [Funding Your Wallet](#funding-your-wallet)
- [Running the Bot](#running-the-bot)
- [How It Works](#how-it-works)
- [Position Tracking](#position-tracking)
- [Simulation & Backtesting](#simulation--backtesting)
- [Troubleshooting](#troubleshooting)
- [Deployment](#deployment)
- [Disclaimer](#disclaimer)

---

## Finding Target Wallets

To identify successful traders to track, you can use these resources:

- **Polymarket Leaderboard**: https://polymarket.com/leaderboard - Official leaderboard showing top performers on Polymarket
- **Predictfolio**: https://predictfolio.com/ - Analytics platform for prediction market traders and portfolios
- **Polygonscan**: https://polygonscan.com - Explore wallet addresses and transaction history
- **Dune Analytics**: https://dune.com - Community-created dashboards for Polymarket trading data

### How to Find Profitable Traders

1. **Check Polymarket Leaderboard**:
   - Visit https://polymarket.com/leaderboard
   - Sort by "All Time P&L" or "30 Day P&L"
   - Click on trader profiles to see their wallet addresses
   - Look for consistent, high-volume traders

2. **Use Predictfolio for Analysis**:
   - Browse top traders with proven track records
   - Analyze their trading strategies and success rates
   - Copy wallet addresses from successful traders

3. **Verify Trader Activity**:
   - Check that target addresses are actively trading
   - Look for consistent patterns (size, frequency)
   - Avoid addresses with irregular or suspicious activity

4. **Recommended Approach**:
   - Start with 3-5 target addresses
   - Mix between different trading styles
   - Monitor their performance for 1-2 days before adding to bot

---

## Installation

### Prerequisites

- Node.js 18 or higher
- npm or yarn package manager
- Polygon wallet with USDC balance
- POL/MATIC for gas fees

### Steps

1. Clone the repository:

```bash
git clone https://github.com/telix5000/Polymarket-Sniper-Bot.git
cd Polymarket-Sniper-Bot
```

2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

---

## Configuration

### Environment Variables

Create a `.env` file in the project root with the following variables:

### ⚠️ API Credentials (Important!)

There are TWO different credential systems in Polymarket:

1. **CLOB Credentials** (for trading): `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`
2. **Builder Credentials** (for gasless transactions): `POLY_BUILDER_API_KEY`, etc.

**These are NOT interchangeable!** The most common error is using Builder keys as CLOB keys.

**Recommended Setup:** Use `CLOB_DERIVE_CREDS=true` to automatically derive CLOB credentials from your private key. This is the official Polymarket recommendation.

#### Required

| Variable            | Description                                                      | Example                                                |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `TARGET_ADDRESSES`  | Comma-separated target addresses to frontrun                     | `0xabc...,0xdef...`                                    |
| `PRIVATE_KEY`       | Your wallet private key                                          | `your_private_key`                                     |
| `RPC_URL`           | Polygon RPC endpoint (must support pending tx monitoring)        | `https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID` |
| `CLOB_DERIVE_CREDS` | Set to `true` to derive CLOB keys from private key (recommended) | `true`                                                 |

#### Optional

| Variable                           | Default                                      | Description                                                  |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `PUBLIC_KEY`                       | (derived)                                    | Your Polygon wallet address (auto-derived if omitted)        |
| `POLYMARKET_API_KEY`               | -                                            | CLOB API key (omit if using `CLOB_DERIVE_CREDS=true`)        |
| `POLYMARKET_API_SECRET`            | -                                            | CLOB API secret (omit if using `CLOB_DERIVE_CREDS=true`)     |
| `POLYMARKET_API_PASSPHRASE`        | -                                            | CLOB API passphrase (omit if using `CLOB_DERIVE_CREDS=true`) |
| `POLY_BUILDER_API_KEY`             | -                                            | Builder API key (for gasless transactions, optional)         |
| `POLY_BUILDER_API_SECRET`          | -                                            | Builder API secret (for gasless transactions, optional)      |
| `POLY_BUILDER_API_PASSPHRASE`      | -                                            | Builder API passphrase (for gasless transactions, optional)  |
| `FETCH_INTERVAL`                   | `1`                                          | Polling frequency in seconds                                 |
| `MIN_TRADE_SIZE_USD`               | `100`                                        | Minimum trade size to frontrun (USD)                         |
| `FRONTRUN_SIZE_MULTIPLIER`         | `0.5`                                        | Frontrun size as % of target (0.0-1.0)                       |
| `GAS_PRICE_MULTIPLIER`             | `1.2`                                        | Gas price multiplier for priority (e.g., 1.2 = 20% higher)   |
| `TRADE_MULTIPLIER`                 | `1.0`                                        | Legacy: Position size multiplier (kept for compatibility)    |
| `RETRY_LIMIT`                      | `3`                                          | Maximum retry attempts for failed orders                     |
| `TRADE_AGGREGATION_ENABLED`        | `false`                                      | Enable trade aggregation                                     |
| `TRADE_AGGREGATION_WINDOW_SECONDS` | `300`                                        | Time window for aggregating trades (seconds)                 |
| `COLLATERAL_TOKEN_ADDRESS`         | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | USDC/USDC.e contract on Polygon                              |
| `MONGO_URI`                        | -                                            | MongoDB connection string (optional)                         |
| `OPENVPN_ENABLED`                  | `false`                                      | Enable OpenVPN setup on startup                              |
| `OPENVPN_CONFIG`                   | -                                            | Full OpenVPN config contents (optional if file mounted)      |
| `OPENVPN_CONFIG_PATH`              | `/etc/openvpn/openvpn.conf`                  | OpenVPN config path                                          |
| `OPENVPN_AUTH_PATH`                | `/etc/openvpn/auth.txt`                      | OpenVPN auth file path                                       |
| `OPENVPN_USERNAME`                 | -                                            | OpenVPN username (requires password)                         |
| `OPENVPN_PASSWORD`                 | -                                            | OpenVPN password (requires username)                         |
| `OPENVPN_EXTRA_ARGS`               | -                                            | Extra args passed to `openvpn`                               |
| `WIREGUARD_ENABLED`                | `false`                                      | Enable WireGuard setup on startup                            |
| `WIREGUARD_INTERFACE_NAME`         | `wg0`                                        | WireGuard interface name                                     |
| `WIREGUARD_CONFIG_PATH`            | `/etc/wireguard/wg0.conf`                    | Config path written at startup                               |
| `WIREGUARD_CONFIG`                 | -                                            | Full WireGuard config contents (overrides per-field vars)    |
| `WIREGUARD_ADDRESS`                | -                                            | Interface Address (comma-separated)                          |
| `WIREGUARD_PRIVATE_KEY`            | -                                            | Interface private key                                        |
| `WIREGUARD_MTU`                    | -                                            | MTU (optional)                                               |
| `WIREGUARD_DNS`                    | -                                            | DNS servers (comma-separated)                                |
| `WIREGUARD_PEER_PUBLIC_KEY`        | -                                            | Peer public key                                              |
| `WIREGUARD_PEER_PRESHARED_KEY`     | -                                            | Peer preshared key (optional)                                |
| `WIREGUARD_PEER_ENDPOINT`          | -                                            | Peer endpoint (host:port)                                    |
| `WIREGUARD_ALLOWED_IPS`            | -                                            | Allowed IP ranges                                            |
| `WIREGUARD_PERSISTENT_KEEPALIVE`   | -                                            | Persistent keepalive interval (seconds)                      |
| `WIREGUARD_FORCE_RESTART`          | `false`                                      | Force `wg-quick down` before `up`                            |

### Example `.env` File (Recommended - Derived Credentials)

```env
# Required
TARGET_ADDRESSES=0x1234567890abcdef1234567890abcdef12345678,0xabcdef1234567890abcdef1234567890abcdef12
PRIVATE_KEY=your_privatekey_key_here
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID

# CLOB Authentication (recommended: derive from private key)
CLOB_DERIVE_CREDS=true
# Do NOT set POLYMARKET_API_* when using CLOB_DERIVE_CREDS=true

# Trading settings
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
FETCH_INTERVAL=1
MIN_TRADE_SIZE_USD=100
FRONTRUN_SIZE_MULTIPLIER=0.5
GAS_PRICE_MULTIPLIER=1.2
RETRY_LIMIT=3

# Token contract (usually don't need to change)
COLLATERAL_TOKEN_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

### Example `.env` File (With Builder Credentials for Gasless Approvals)

```env
# Required
TARGET_ADDRESSES=0x1234567890abcdef1234567890abcdef12345678
PRIVATE_KEY=your_privatekey_key_here
RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID

# CLOB Authentication (derive from private key)
CLOB_DERIVE_CREDS=true

# Builder credentials (optional - for gasless approval transactions)
# Get these from: https://docs.polymarket.com/developers/builders/builder-profile
POLY_BUILDER_API_KEY=your_builder_key
POLY_BUILDER_API_SECRET=your_builder_secret
POLY_BUILDER_API_PASSPHRASE=your_builder_passphrase

# Trading settings
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS

# OpenVPN (optional)
OPENVPN_ENABLED=true
OPENVPN_CONFIG=client\nproto udp\nremote europe3.vpn.airdns.org 443\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\ncipher AES-256-GCM\nauth SHA512\nkey-direction 1\n<ca>\n...\n</ca>\n<tls-auth>\n...\n</tls-auth>\n
OPENVPN_USERNAME=your_airvpn_username
OPENVPN_PASSWORD=your_airvpn_password

# WireGuard (optional)
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

> Note: OpenVPN and WireGuard are mutually exclusive; if both are enabled, OpenVPN takes priority.

> Note: WireGuard setup requires privileged mode plus `NET_ADMIN` and `/dev/net/tun` access (see Docker Compose example). Device access must be granted at runtime; it cannot be baked into the image.
> Ensure `ip6tables-restore` is installed in the container if you use IPv6 addresses/allowed IPs; otherwise remove IPv6 entries.

---

## Funding Your Wallet

### Requirements

You need two types of funds on your Polygon wallet:

1. **USDC** - For trading positions
2. **POL/MATIC** - For gas fees

### Steps

1. **Bridge or acquire USDC on Polygon:**
   - Use Polygon Bridge to transfer USDC from Ethereum
   - Or purchase USDC directly on Polygon via DEX
   - Recommended minimum: $100-500 USDC for testing

2. **Fund gas (POL/MATIC):**
   - Ensure you have at least 0.2-1.0 POL/MATIC for gas (frontrunning requires higher gas)
   - You can buy POL/MATIC on exchanges or use Polygon faucets
   - Higher gas balances recommended for competitive frontrunning

3. **Verify funding:**
   - Check your wallet balance on PolygonScan
   - Confirm both USDC and POL/MATIC are present
   - Set `PUBLIC_KEY` in `.env` to this funded address

### Getting RPC URL

**Important:** For frontrunning, you need an RPC endpoint that supports pending transaction monitoring.

You can get a free RPC endpoint from:

- [Infura](https://infura.io) - Free tier available (supports pending tx)
- [Alchemy](https://alchemy.com) - Free tier available (supports pending tx)
- [QuickNode](https://quicknode.com) - Free tier available (supports pending tx)

**Note:** Some free tier RPC providers may have rate limits. For production frontrunning, consider premium providers with WebSocket support.

---

## Running the Bot

### Development Mode

```bash
npm run dev
```

Runs with TypeScript directly using `ts-node`. Useful for development and debugging.

### Production Mode

```bash
npm run build
npm start
```

Compiles TypeScript to JavaScript first, then runs the compiled code. Recommended for production.

### Docker Deployment

**Build and run:**

```bash
docker build -t polymarket-sniper-bot .
docker run --env-file .env polymarket-sniper-bot
```

**Using Docker Compose:**

```bash
docker-compose up -d
```

### Cloud Deployment

Set environment variables through your platform's configuration:

- **Render:** Add environment variables in dashboard
- **Fly.io:** `fly secrets set KEY=value`
- **Kubernetes:** Use ConfigMaps and Secrets
- **AWS/GCP/Azure:** Use their respective secret management services

---

## How It Works

### Workflow

1. **Mempool Monitoring** - Bot monitors Polygon mempool for pending transactions to Polymarket contracts
2. **API Monitoring** - Simultaneously polls Polymarket API for recent orders from target addresses (hybrid approach)
3. **Signal Detection** - When pending trades are detected, creates `TradeSignal` objects with transaction details
4. **Frontrun Sizing** - Calculates frontrun size as percentage of target trade:
   - Uses `FRONTRUN_SIZE_MULTIPLIER` (default: 50% of target)
   - Validates sufficient balance
5. **Priority Execution** - Submits market orders with higher gas prices to execute before target transaction
6. **Error Handling** - Retries failed orders up to `RETRY_LIMIT`

### Frontrun Sizing Formula

```
calculated_size = target_trade_size * FRONTRUN_SIZE_MULTIPLIER
max_size = min(FRONTRUN_MAX_SIZE_USD, MAX_POSITION_USD)
frontrun_size = min(calculated_size, max_size)
```

The frontrun size is capped by the **lower** of `FRONTRUN_MAX_SIZE_USD` and `MAX_POSITION_USD`. This ensures that if you've set `MAX_POSITION_USD=5` to limit your position sizes, frontrun orders will also respect that limit.

Example: If target trade is $540, multiplier is 0.1, and `MAX_POSITION_USD=5`:
- Calculated size: $540 × 0.1 = $54
- Max size: min($50 default, $5 endgame) = $5
- Final frontrun size: min($54, $5) = $5 (capped by MAX_POSITION_USD)

This ensures your maximum exposure per trade is controlled regardless of target trade size.

### Gas Price Strategy

The bot uses a gas price multiplier to ensure priority execution:

```
your_gas_price = target_gas_price * GAS_PRICE_MULTIPLIER
```

Default multiplier is 1.2 (20% higher), ensuring your transaction is prioritized in the mempool.

### Order Types

- **FOK (Fill-or-Kill)** - Order must fill completely or be cancelled
- Orders are placed at best available price (market orders)
- Gas prices are automatically adjusted for priority execution

---

## Position Tracking

### Current Implementation

The bot automatically:

- Tracks processed transaction hashes to avoid duplicates
- Calculates frontrun position sizes based on target trade
- Handles both BUY and SELL signals
- Monitors mempool and API simultaneously for faster detection

### Planned Features

Future enhancements may include:

- MongoDB persistence for trade history
- Position aggregation per market/outcome
- Proportional sell engine that mirrors trader exits
- Realized vs unrealized PnL breakdown
- Position tracking dashboard

### Manual Position Management

You can check your positions on:

- Polymarket website (your profile)
- PolygonScan (token balances)
- Polymarket API: `https://data-api.polymarket.com/positions?user=YOUR_ADDRESS`

---

## Simulation & Backtesting

### Overview

The bot includes infrastructure for simulation and backtesting, allowing you to:

- Test different `FRONTRUN_SIZE_MULTIPLIER` values
- Evaluate `GAS_PRICE_MULTIPLIER` impact on success rate
- Test different `MIN_TRADE_SIZE_USD` thresholds
- Measure performance metrics and profitability

### Running Simulations

```bash
npm run simulate
```

### Implementation Steps

To implement full backtesting:

1. **Data Collection:**
   - Fetch historical trades for tracked traders
   - Get historical market prices
   - Collect order book snapshots

2. **Simulation Logic:**
   - Reconstruct sequences of buys/sells
   - Apply your sizing rules
   - Include transaction costs
   - Handle slippage

3. **Metrics:**
   - Total PnL
   - Win rate
   - Maximum drawdown
   - Sharpe ratio
   - Capacity limits

### Suggested Approach

- Start with small time windows (1 day, 1 week)
- Test different frontrun multipliers (0.3, 0.5, 0.7)
- Test different gas multipliers (1.1, 1.2, 1.5)
- Test different minimum trade sizes ($50, $100, $500)
- Compare results across different target addresses
- Measure success rate (how often frontrun executes before target)
- Identify optimal settings before going live

---

## Troubleshooting

### 401 "Unauthorized/Invalid api key" Error

**Symptoms:** Bot shows `ready_to_trade=false` and logs `401 Unauthorized/Invalid api key`

**Most Common Cause:** Using Builder API keys instead of CLOB API keys.

**Solutions:**

1. **Use derived credentials (recommended):**

   ```env
   CLOB_DERIVE_CREDS=true
   # Remove or comment out POLYMARKET_API_* variables
   ```

2. **Verify you're using the right credential type:**
   - `POLYMARKET_API_*` = CLOB credentials (for trading)
   - `POLY_BUILDER_*` = Builder credentials (for gasless transactions)
   - These are NOT interchangeable!

3. **Check the preflight summary in logs:**

   ```
   [Preflight][Summary] ... auth_ok=false ...
   ```

   - `auth_ok=false` means CLOB authentication failed
   - `relayer_enabled=false` means Builder credentials are missing (this is OK for basic trading)

4. **Ensure your wallet has interacted with Polymarket:**
   - The CLOB may reject credentials if the wallet has never traded
   - Try making a small trade via the Polymarket website first

5. **If using explicit CLOB credentials:**
   - Verify they were created using the `@polymarket/clob-client` library
   - They should NOT be from the Builder profile page

### Bot Not Detecting Trades

**Symptoms:** Bot runs but no trades are frontrun

**Solutions:**

1. Verify `TARGET_ADDRESSES` are correct and active traders
2. Check that target addresses have recent activity on Polymarket
3. Verify RPC URL supports pending transaction monitoring
4. Check `MIN_TRADE_SIZE_USD` - trades below this threshold are ignored
5. Increase `FETCH_INTERVAL` if network is slow (but this may reduce frontrun opportunities)
6. Check logs for API errors
7. Verify RPC URL is working: `curl $RPC_URL`
8. Ensure RPC provider supports `eth_getPendingTransactions` or similar

### Orders Not Submitting

**Symptoms:** Trades detected but orders fail

**Solutions:**

1. **Check USDC balance:**
   - Ensure sufficient USDC in wallet
   - Verify balance on PolygonScan

2. **Check gas funds:**
   - Ensure POL/MATIC balance > 0.2 (frontrunning requires higher gas)
   - Top up if needed
   - Monitor gas prices - higher gas = better frontrun success rate

3. **Verify RPC URL:**
   - Test endpoint is accessible
   - Check rate limits
   - Try alternative RPC provider

4. **Verify credentials:**
   - Confirm `PRIVATE_KEY` matches `PUBLIC_KEY`
   - Check private key format (no 0x prefix)
   - Ensure wallet has proper permissions

5. **Check market conditions:**
   - Verify market is still active
   - Check if order book has liquidity
   - Ensure price hasn't moved significantly

### Connection Issues

**Symptoms:** Bot can't connect to APIs

**Solutions:**

1. Check internet connection
2. Verify RPC URL is correct
3. Check if Polymarket API is accessible
4. Review firewall settings
5. Try different RPC provider

### High Gas Costs

**Solutions:**

1. Adjust `GAS_PRICE_MULTIPLIER` - lower values (e.g., 1.1) reduce costs but may reduce success rate
2. Increase `MIN_TRADE_SIZE_USD` to only frontrun larger, more profitable trades
3. Monitor gas prices and trade during low-traffic periods
4. Consider reducing `FRONTRUN_SIZE_MULTIPLIER` to use less capital per trade

### Performance Issues

**Solutions:**

1. Increase `FETCH_INTERVAL` if CPU usage is high
2. Reduce number of tracked traders
3. Optimize RPC endpoint (use premium providers)
4. Consider using WebSocket subscriptions (future feature)

---

## Deployment

### Local Deployment

```bash
npm run build
npm start
```

### Docker

**Build:**

```bash
docker build -t polymarket-frontrun-bot .
```

**Run:**

```bash
docker run --env-file .env -d --name polymarket-bot polymarket-sniper-bot
```

**Stop:**

```bash
docker stop polymarket-bot
```

### Production Considerations

1. **Security:**
   - Never commit `.env` file
   - Use environment variable management
   - Rotate private keys regularly
   - Use hardware wallets if possible

2. **Monitoring:**
   - Set up logging aggregation
   - Monitor bot health
   - Track trade execution rates
   - Alert on errors

3. **Reliability:**
   - Use process managers (PM2, systemd)
   - Set up auto-restart on crashes
   - Monitor system resources
   - Keep dependencies updated

4. **Backup:**
   - Backup configuration files
   - Document your setup
   - Keep wallet recovery phrases secure

---

## Additional Resources

- [Polymarket Documentation](https://docs.polymarket.com)
- [CLOB Client Library](https://github.com/Polymarket/clob-client)
- [Polygon Documentation](https://docs.polygon.technology)

---
