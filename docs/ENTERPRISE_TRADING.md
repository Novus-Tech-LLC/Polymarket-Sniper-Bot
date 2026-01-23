# Enterprise Trading System

A complete, risk-managed trading system for Polymarket designed for maximizing risk-adjusted PnL.

## Overview

The enterprise trading system provides:

- **Multi-mode execution**: Market-Making + Flow-Following + Inventory Control
- **Portfolio risk engine**: Exposure limits, circuit breakers, drawdown protection
- **Sequential execution**: Prevents stack issues and race conditions
- **Deterministic PnL accounting**: Real-time tracking of realized/unrealized P&L

## Quick Start

Set your strategy preset to use enterprise mode:

```bash
STRATEGY_PRESET=aggressive_enterprise
```

That's it! The system uses sensible defaults that work out of the box.

## Configuration

### Minimal Configuration (Recommended)

```bash
# Required
PRIVATE_KEY=your_private_key
RPC_URL=https://polygon-rpc.com
TARGET_ADDRESSES=0x...

# Enable enterprise mode
STRATEGY_PRESET=aggressive_enterprise

# Enable live trading (when ready)
LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

### Optional Overrides

Only change these if you need to fine-tune:

```bash
# Risk limits
MAX_EXPOSURE_USD=2000           # Total portfolio exposure (default: 2000)
MAX_DRAWDOWN_PCT=25             # Circuit breaker threshold (default: 25%)
MAX_SLIPPAGE_CENTS=3            # Max slippage allowed (default: 3)

# Kill switch
KILL_SWITCH_FILE=/data/KILL     # Create this file to halt all trading
```

## Strategies

### 1. Market Making (MM)

Places passive bids and asks to capture spread. Uses post-only orders to avoid taking fees.

- Entry: Quote around fair price with inventory-aware skew
- Exit: Mean-reversion when price returns to microprice band

### 2. Flow Following (FF)

Detects large trades/whale activity and follows momentum with strict slippage protection.

- Entry: Only on significant moves (>= MIN_MOVE_CENTS within window)
- Exit: Quick profit-taking with tight stops

### 3. Inventory & Correlation Controller (ICC)

Enforces portfolio constraints:

- Max exposure per market
- Max exposure per category
- Drawdown-based position reduction

## Risk Management

### Circuit Breakers

The system automatically pauses trading when:

1. **Consecutive Rejects**: Too many order rejections (default: 10)
2. **API Health**: CLOB/Gamma API unhealthy for too long (default: 60s)
3. **Drawdown**: Session drawdown exceeds limit (default: 25%)

Circuit breakers auto-reset after a cooldown period (default: 5 minutes).

### Exposure Limits

All orders must pass through the RiskManager which enforces:

| Limit | Default | ENV Override |
|-------|---------|--------------|
| Total Exposure | $2,000 | MAX_EXPOSURE_USD |
| Per-Market | $200 | MAX_EXPOSURE_PER_MARKET_USD |
| Per-Category | $500 | (not configurable) |

### Kill Switch

Create the kill switch file to immediately halt all trading:

```bash
touch /data/KILL  # Trading stops immediately
rm /data/KILL     # Trading resumes
```

## Execution

### Sequential Execution

All strategies run sequentially in priority order:

1. ICC - Enforce portfolio limits first
2. Stop-Loss / Hedging - Protect existing positions
3. MM - Spread capture (lower priority)
4. FF - Momentum capture (lowest priority)

This prevents:
- Stack overflow issues from parallel execution
- Race conditions for capital
- Conflicting orders on same market

### Cooldown Awareness

The system caches cooldown information from order rejections:

- Automatically skips tokens in cooldown
- Tracks cooldown expiry times
- Prevents spam during cooldown windows

## Monitoring

### Logs

Key log messages to watch:

```
[RiskManager] 🚨 CIRCUIT BREAKER TRIGGERED: ...  # Trading paused
[ExecutionEngine] ✅ MM BUY submitted: ...        # Order success
[ExecutionEngine] ❌ FF SELL failed: ...          # Order failure
[EnterpriseOrchestrator] Cycle #123: 5/7 orders successful  # Cycle summary
```

### PnL Summary

Every 5 minutes, the system logs a PnL summary:

```
=== PnL Summary ===
Realized: $45.23
Unrealized: $12.50
Fees: $0.89
Net: $56.84
Win Rate: 65.2% (15W / 8L)
Avg Win: $4.50 | Avg Loss: $2.10
--- By Strategy ---
  MM: R=$30.00 U=$8.00
  FF: R=$15.23 U=$4.50
```

## Presets Comparison

| Setting | Conservative | Balanced | Aggressive | Enterprise |
|---------|--------------|----------|------------|------------|
| Max Exposure | $200 | $500 | $2,000 | $2,000 |
| Max Per-Market | $50 | $100 | $200 | $200 |
| Max Drawdown | 10% | 15% | 25% | 25% |
| MM Enabled | ✅ | ✅ | ✅ | ✅ |
| FF Enabled | ❌ | ✅ | ✅ | ✅ |
| ICC Enabled | ✅ | ✅ | ✅ | ✅ |
| Sequential Exec | ✅ | ✅ | ✅ | ✅ |

## Troubleshooting

### "CIRCUIT_BREAKER: CONSECUTIVE_REJECTS"

Too many orders were rejected. Check:
1. Wallet has sufficient USDC balance
2. Approvals are set (run with APPROVALS_AUTO=true)
3. Not geoblocked

### "EXPOSURE_LIMIT" rejections

Portfolio is at capacity. The system will:
1. Wait for existing positions to close
2. Reduce position sizes automatically

### "COOLDOWN_CACHED" for all tokens

You may be hitting rate limits. The system automatically:
1. Caches cooldown until timestamps
2. Skips tokens in cooldown
3. Resumes when cooldowns expire

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 EnterpriseOrchestrator                  │
│                  (Sequential Execution)                 │
└─────────────────────────┬───────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │   ICC    │   │    MM    │   │    FF    │
    │ (Limits) │   │ (Spread) │   │ (Momen.) │
    └────┬─────┘   └────┬─────┘   └────┬─────┘
         │              │              │
         └──────────────┼──────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │   RiskManager   │
              │ (Gates all ord) │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ExecutionEngine  │
              │(Cooldown-aware) │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   postOrder()   │
              │ (Existing util) │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   CLOB API      │
              └─────────────────┘
```
