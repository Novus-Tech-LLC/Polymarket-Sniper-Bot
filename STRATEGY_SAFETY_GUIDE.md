# Strategy Safety Guide

## ⚠️ CRITICAL: Understanding MAX_POSITION_USD

### What This Setting Controls

`MAX_POSITION_USD` controls the **maximum USD per individual position**, NOT your total exposure.

### The Risk

**The strategy can buy MULTIPLE positions at once!**

If the bot finds 5 opportunities at the same time:

- With `MAX_POSITION_USD=50`: **$250 total** (5 × $50)
- With `MAX_POSITION_USD=100`: **$500 total** (5 × $100)
- With `MAX_POSITION_USD=200`: **$1,000 total** (5 × $200) ⚠️

### How to Stay Safe

#### 1. Start Small

**First-time users should start with $5-10 per position:**

```yaml
MAX_POSITION_USD: 5
```

This limits your exposure while you learn how the strategies work.

#### 2. Calculate Your Maximum Exposure

**Conservative estimate:**
Assume the bot could find 10 opportunities simultaneously.

```
Maximum possible exposure = MAX_POSITION_USD × 10
```

Examples:

- $5/position → $50 max exposure ✅ Safe for testing
- $10/position → $100 max exposure ✅ Conservative
- $25/position → $250 max exposure ⚠️ Moderate risk
- $50/position → $500 max exposure ⚠️ High risk
- $100/position → $1,000 max exposure 🚨 DANGER

#### 3. Consider Your Wallet Balance

**Rule of thumb:**

```
MAX_POSITION_USD should be ≤ (Wallet Balance / 20)
```

Examples:

- $100 wallet → Max $5/position
- $500 wallet → Max $25/position
- $1,000 wallet → Max $50/position
- $5,000 wallet → Max $250/position

#### 4. Use Preset Defaults

The built-in presets have safe defaults:

| Preset       | MAX_POSITION_USD | Est. Max Exposure |
| ------------ | ------------------------ | ----------------- |
| Conservative | $15                      | ~$150             |
| Balanced     | $25                      | ~$250             |
| Aggressive   | $50                      | ~$500             |

**Override if these are too high for your wallet!**

## Preset-Specific Safety

### Conservative Preset

```yaml
STRATEGY_PRESET: conservative
MAX_POSITION_USD: 15 # Override if needed
```

- Buys 98.5-99.5¢ positions (near-certain outcomes)
- Lower risk but can still buy multiple positions
- **Recommended wallet:** $300+ minimum

### Balanced Preset

```yaml
STRATEGY_PRESET: balanced
MAX_POSITION_USD: 25 # Override if needed
```

- Buys 98.5-99.5¢ positions (near-certain outcomes)
- Faster execution, more positions
- **Recommended wallet:** $500+ minimum

### Aggressive Preset

```yaml
STRATEGY_PRESET: aggressive
MAX_POSITION_USD: 50 # Override if needed
```

- Buys 85-95¢ positions (higher uncertainty)
- Much higher potential returns BUT higher risk
- Can buy many positions in this wider price range
- **Recommended wallet:** $1,000+ minimum
- **⚠️ WARNING:** This preset can easily buy 10-20 positions if markets are available

## How to Override Position Sizing

Even when using presets, you can override the position size:

```yaml
# Use balanced preset but limit position size to $10
STRATEGY_PRESET: balanced
MAX_POSITION_USD: 10
```

The bot will use balanced's other settings (scan intervals, thresholds, etc.) but limit each position to $10.

## Real Example: What Can Happen

### Scenario: Aggressive preset with default $50/position

**Hour 1:** Bot finds 3 opportunities at 90¢

- Buys 3 positions × $50 = **$150 deployed**

**Hour 2:** Bot finds 5 more opportunities at 87¢

- Buys 5 positions × $50 = **$250 deployed**
- **Total exposure: $400**

**Hour 3:** 2 positions from Hour 1 appreciate to 95¢

- Auto-sell triggers, frees up $100
- But bot immediately finds 4 new opportunities
- Buys 4 × $50 = **$200 deployed**
- **Total exposure still: $500**

### How to Prevent This

1. **Lower the position size:**

   ```yaml
   MAX_POSITION_USD: 10 # Max $100-200 exposure instead of $500
   ```

2. **Use ARB_MAX_WALLET_EXPOSURE_USD** (if available) to set a global cap

3. **Monitor your positions** and disable the strategy if too many accumulate

4. **Start with conservative preset** and smaller position sizes

## Testing Safely

### Week 1: Micro Testing

```yaml
STRATEGY_PRESET: conservative
MAX_POSITION_USD: 5
LIVE_TRADING: I_UNDERSTAND_THE_RISKS
```

- Maximum ~$50 exposure
- Learn how strategies work
- Verify P&L calculations

### Week 2-3: Small Scale

```yaml
STRATEGY_PRESET: balanced
MAX_POSITION_USD: 10
```

- Maximum ~$100 exposure
- Test with real but limited capital
- Monitor win rate and returns

### Week 4+: Production Scale

```yaml
STRATEGY_PRESET: balanced # or aggressive
MAX_POSITION_USD: 25 # or higher based on wallet
```

- Only increase after confirming profitability
- Never risk more than you can afford to lose

## Emergency: Disable the Strategy

If positions are accumulating too fast:

```yaml
# Stop new position buys
ENDGAME_SWEEP_ENABLED: false

# Or turn off all strategies
STRATEGY_PRESET: off
```

Restart the bot for changes to take effect.

## Summary: Key Safety Rules

1. ✅ **Always start with $5-10 per position**
2. ✅ **Calculate max exposure = position size × 10-20**
3. ✅ **Never risk more than 50% of your wallet**
4. ✅ **Monitor positions actively, especially first few days**
5. ✅ **Use conservative preset until you understand the system**
6. ✅ **Override defaults if they're too high for your wallet**
7. ⚠️ **Aggressive preset can deploy capital VERY quickly**
8. 🚨 **Never set position size > 10% of your wallet balance**

## Questions?

If you're unsure about position sizing:

- **Too small:** Start with $5 and increase gradually
- **Too big:** If you're nervous, it's too big - reduce it
- **Just right:** You're comfortable if all positions lose (unlikely but possible)

Remember: The goal is consistent small gains, not getting rich quick. Protect your capital first!
