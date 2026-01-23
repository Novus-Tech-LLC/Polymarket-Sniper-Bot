# Enterprise Trading System

A complete, risk-managed trading system for Polymarket designed for maximizing risk-adjusted PnL.

## Overview

The enterprise trading system is now **integrated into all strategy presets** (conservative, balanced, aggressive). Every preset provides:

- **Centralized RiskManager**: Gates all orders with exposure limits and circuit breakers
- **Market selection filter**: Only trades liquid, tight-spread markets
- **Sequential execution**: Prevents stack issues and race conditions
- **Deterministic PnL accounting**: Real-time tracking of realized/unrealized P&L

## Quick Start

Simply set your strategy preset - enterprise features are built-in:

```bash
# Use any preset - enterprise features are integrated
STRATEGY_PRESET=aggressive   # or balanced, conservative
```

That's it! The system uses sensible defaults that work out of the box.

## Configuration

### Minimal Configuration (Recommended)

```bash
# Required
PRIVATE_KEY=your_private_key
RPC_URL=https://polygon-rpc.com
TARGET_ADDRESSES=0x...

# Choose your preset (all use enterprise system)
STRATEGY_PRESET=aggressive  # or balanced, conservative

# Enable live trading (when ready)
LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

### Optional Overrides

Only change these if you need to fine-tune:

```bash
# Risk limits (override preset defaults)
MAX_EXPOSURE_USD=2000           # Total portfolio exposure
MAX_DRAWDOWN_PCT=25             # Circuit breaker threshold
MAX_SLIPPAGE_CENTS=3            # Max slippage allowed

# Kill switch
KILL_SWITCH_FILE=/data/KILL     # Create this file to halt all trading
```

## Strategies (Run Sequentially)

### 1. Market Making (MM)

Places passive bids and asks to capture spread. Uses post-only orders to avoid taking fees.

- Entry: Quote around fair price with inventory-aware skew
- Exit: Mean-reversion when price returns to microprice band

### 2. Flow Following (FF) - *Balanced/Aggressive only*

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

1. **Consecutive Rejects**: Too many order rejections
2. **API Health**: CLOB/Gamma API unhealthy for too long
3. **Drawdown**: Session drawdown exceeds limit

Circuit breakers auto-reset after a cooldown period (default: 5 minutes).

### Preset Risk Limits

| Setting | Conservative | Balanced | Aggressive |
|---------|--------------|----------|------------|
| Max Exposure | $200 | $500 | $2,000 |
| Max Per-Market | $50 | $100 | $200 |
| Max Drawdown | 10% | 15% | 25% |
| MM Enabled | ✅ | ✅ | ✅ |
| FF Enabled | ❌ | ✅ | ✅ |
| ICC Enabled | ✅ | ✅ | ✅ |

### Kill Switch

Create the kill switch file to immediately halt all trading:

```bash
touch /data/KILL  # Trading stops immediately
rm /data/KILL     # Trading resumes
```

## Execution

### Sequential Execution

All strategies run sequentially in priority order (prevents stack issues):

1. ICC - Enforce portfolio limits first
2. Stop-Loss / Hedging - Protect existing positions
3. MM - Spread capture (lower priority)
4. FF - Momentum capture (lowest priority)

### Cooldown Awareness

The system caches cooldown information from order rejections:

- Automatically skips tokens in cooldown
- Tracks cooldown expiry times
- Prevents spam during cooldown windows

## Monitoring

### Key Log Messages

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
--- By Strategy ---
  MM: R=$30.00 U=$8.00
  FF: R=$15.23 U=$4.50
```

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
