export const ARB_PRESETS = {
  off: {
    ARB_ENABLED: false,
  },
  safe_small: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 1000,
    ARB_MIN_EDGE_BPS: 50, // 0.5% edge (very profitable with 0.01% fee)
    ARB_MIN_PROFIT_USD: 0.1,
    ARB_MIN_LIQUIDITY_USD: 2000,
    ARB_MAX_SPREAD_BPS: 200,
    ARB_TRADE_BASE_USD: 2,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 30,
    ARB_FEE_BPS: 1, // Correct: 0.01% per trade
    ARB_MAX_POSITION_USD: 10,
    ARB_MAX_WALLET_EXPOSURE_USD: 25,
    ARB_MAX_TRADES_PER_HOUR: 5000,
    ARB_MARKET_COOLDOWN_SECONDS: 5,
    ARB_MAX_CONSECUTIVE_FAILURES: 5,
    ARB_MAX_CONCURRENT_TRADES: 10,
    ARB_STARTUP_COOLDOWN_SECONDS: 30,
  },
  classic: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 500,
    ARB_MIN_EDGE_BPS: 30, // 0.3% edge
    ARB_MIN_PROFIT_USD: 0.1,
    ARB_MIN_LIQUIDITY_USD: 2000,
    ARB_MAX_SPREAD_BPS: 200,
    ARB_TRADE_BASE_USD: 5,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 30,
    ARB_FEE_BPS: 1, // Correct: 0.01% per trade
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 100,
    ARB_MAX_TRADES_PER_HOUR: 10000,
    ARB_MARKET_COOLDOWN_SECONDS: 2,
    ARB_MAX_CONSECUTIVE_FAILURES: 5,
    ARB_MAX_CONCURRENT_TRADES: 15,
    ARB_STARTUP_COOLDOWN_SECONDS: 10,
  },
  micro: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 250,
    ARB_MIN_EDGE_BPS: 20, // 0.2% edge (10x the fee!)
    ARB_MIN_PROFIT_USD: 0.05,
    ARB_MIN_LIQUIDITY_USD: 5000,
    ARB_MAX_SPREAD_BPS: 150,
    ARB_TRADE_BASE_USD: 3,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 20,
    ARB_FEE_BPS: 1, // Correct: 0.01% per trade
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 125,
    ARB_MAX_TRADES_PER_HOUR: 20000,
    ARB_MARKET_COOLDOWN_SECONDS: 1,
    ARB_MAX_CONSECUTIVE_FAILURES: 10,
    ARB_MAX_CONCURRENT_TRADES: 20,
    ARB_STARTUP_COOLDOWN_SECONDS: 5,
  },
  quality: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 1000,
    ARB_MIN_EDGE_BPS: 100, // 1% edge for higher quality trades
    ARB_MIN_PROFIT_USD: 0.25,
    ARB_MIN_LIQUIDITY_USD: 15000,
    ARB_MAX_SPREAD_BPS: 100,
    ARB_TRADE_BASE_USD: 8,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 20,
    ARB_FEE_BPS: 1, // Correct: 0.01% per trade
    ARB_MAX_POSITION_USD: 40,
    ARB_MAX_WALLET_EXPOSURE_USD: 200,
    ARB_MAX_TRADES_PER_HOUR: 5000,
    ARB_MARKET_COOLDOWN_SECONDS: 5,
    ARB_MAX_CONSECUTIVE_FAILURES: 5,
    ARB_MAX_CONCURRENT_TRADES: 10,
    ARB_STARTUP_COOLDOWN_SECONDS: 15,
  },
  late: {
    ARB_ENABLED: true,
    ARB_SCAN_INTERVAL_MS: 250,
    ARB_MIN_EDGE_BPS: 30, // 0.3% edge
    ARB_MIN_PROFIT_USD: 0.1,
    ARB_MIN_LIQUIDITY_USD: 3000,
    ARB_MAX_SPREAD_BPS: 250,
    ARB_TRADE_BASE_USD: 5,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 40,
    ARB_FEE_BPS: 1, // Correct: 0.01% per trade
    ARB_MAX_HOLD_MINUTES: 30,
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 120,
    ARB_MAX_TRADES_PER_HOUR: 15000,
    ARB_MARKET_COOLDOWN_SECONDS: 1,
    ARB_MAX_CONSECUTIVE_FAILURES: 10,
    ARB_MAX_CONCURRENT_TRADES: 15,
    ARB_STARTUP_COOLDOWN_SECONDS: 3,
  },
} as const;

export const MONITOR_PRESETS = {
  off: {
    MONITOR_ENABLED: false,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  conservative: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 250,
    TRADE_MULTIPLIER: 0.2,
    RETRY_LIMIT: 1,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 15,
    FRONTRUN_SIZE_MULTIPLIER: 0.1,
    FRONTRUN_MAX_SIZE_USD: 25,
    GAS_PRICE_MULTIPLIER: 1.08,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  balanced: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 75,
    TRADE_MULTIPLIER: 0.2,
    RETRY_LIMIT: 1,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 15,
    FRONTRUN_SIZE_MULTIPLIER: 0.1,
    FRONTRUN_MAX_SIZE_USD: 50,
    GAS_PRICE_MULTIPLIER: 1.08,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  active: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 25,
    TRADE_MULTIPLIER: 0.15,
    RETRY_LIMIT: 1,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 10,
    FRONTRUN_SIZE_MULTIPLIER: 0.05,
    FRONTRUN_MAX_SIZE_USD: 100,
    GAS_PRICE_MULTIPLIER: 1.05,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
  test: {
    MONITOR_ENABLED: true,
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 5,
    TRADE_MULTIPLIER: 0.05,
    RETRY_LIMIT: 0,
    TRADE_AGGREGATION_ENABLED: false,
    FRONTRUN_SIZE_MULTIPLIER: 0.02,
    FRONTRUN_MAX_SIZE_USD: 10,
    GAS_PRICE_MULTIPLIER: 1.02,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
} as const;

export const STRATEGY_PRESETS = {
  /**
   * OFF preset - All strategies disabled
   * Use this for testing or when you want manual-only trading
   */
  off: {
    STRATEGY_ENABLED: false,
    ARB_ENABLED: false,
    MONITOR_ENABLED: false,
    QUICK_FLIP_ENABLED: false,
    QUICK_FLIP_TARGET_PCT: 5,
    QUICK_FLIP_STOP_LOSS_PCT: 3,
    QUICK_FLIP_MIN_HOLD_SECONDS: 30,
    AUTO_SELL_ENABLED: false,
    AUTO_SELL_THRESHOLD: 0.99,
    AUTO_SELL_MIN_HOLD_SECONDS: 120,
    ENDGAME_SWEEP_ENABLED: false,
    ENDGAME_MIN_PRICE: 0.98,
    ENDGAME_MAX_PRICE: 0.995,
    MAX_POSITION_USD: 25,
    AUTO_REDEEM_ENABLED: false,
    AUTO_REDEEM_MIN_POSITION_USD: 0.1,
    // Smart Hedging - disabled in "off" preset (STRATEGY_ENABLED=false disables all strategies)
    SMART_HEDGING_ENABLED: false,
    SMART_HEDGING_TRIGGER_LOSS_PCT: 20,
    SMART_HEDGING_MAX_HEDGE_USD: 10,
    SMART_HEDGING_RESERVE_PCT: 20,
  },
  conservative: {
    STRATEGY_ENABLED: true,
    // Combines ARB + MONITOR settings
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    // Quick Flip settings - aim for substantial profits to justify trades
    // Don't trade unless you're making real money
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 30, // 30% target - $3 profit on $10 positions
    QUICK_FLIP_STOP_LOSS_PCT: 15, // 15% stop loss (2:1 reward/risk)
    QUICK_FLIP_MIN_HOLD_SECONDS: 60,
    QUICK_FLIP_MIN_PROFIT_USD: 2.0, // Minimum $2.00 profit per trade
    // Auto-sell settings
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.997, // 99.7¢ (only if price improves above endgame purchases)
    AUTO_SELL_MIN_HOLD_SECONDS: 300, // Hold at least 5 minutes before auto-selling
    // Endgame sweep settings
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.985, // 98.5¢
    ENDGAME_MAX_PRICE: 0.995, // 99.5¢ (auto-sell threshold is higher to avoid conflict)
    MAX_POSITION_USD: 15, // Conservative position sizing
    // Auto-Redeem settings (claim resolved positions)
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.1, // Skip dust below 10 cents
    /**
     * SMART HEDGING - Conservative settings
     * Instead of selling risky positions at a loss, hedge by buying the opposing side
     * This limits max loss to the spread paid, not the full position value
     */
    SMART_HEDGING_ENABLED: true, // ENABLED BY DEFAULT
    SMART_HEDGING_TRIGGER_LOSS_PCT: 20, // Hedge when position drops 20%
    SMART_HEDGING_MAX_HEDGE_USD: 10, // Max $10 per hedge
    SMART_HEDGING_RESERVE_PCT: 25, // Keep 25% reserve for hedging (conservative)
    // Rate limits
    ORDER_SUBMIT_MAX_PER_HOUR: 30,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 10000,
    // Existing ARB settings
    ARB_SCAN_INTERVAL_MS: 2000,
    ARB_MIN_EDGE_BPS: 300, // 3% minimum edge
    ARB_MIN_PROFIT_USD: 1.0, // Minimum $1 profit per arb
    ARB_MAX_SPREAD_BPS: 300,
    ARB_TRADE_BASE_USD: 3,
    ARB_MAX_POSITION_USD: 15,
    ARB_MAX_WALLET_EXPOSURE_USD: 50,
    ARB_MAX_TRADES_PER_HOUR: 2000,
    ARB_MAX_CONCURRENT_TRADES: 8,
    ARB_MARKET_COOLDOWN_SECONDS: 10,
    // Existing Monitor settings (from balanced)
    FETCH_INTERVAL: 2,
    MIN_TRADE_SIZE_USD: 50,
    TRADE_MULTIPLIER: 0.15,
    MONITOR_REQUIRE_CONFIRMED: true,
  },
  balanced: {
    STRATEGY_ENABLED: true,
    // Combines ARB + MONITOR settings
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    // Quick Flip settings - aim for substantial profits
    // Every trade should be worth your time
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 20, // 20% gain target - $2 profit on $10 positions
    QUICK_FLIP_STOP_LOSS_PCT: 10, // 10% stop loss (2:1 reward/risk)
    QUICK_FLIP_MIN_HOLD_SECONDS: 30,
    QUICK_FLIP_MIN_PROFIT_USD: 1.0, // Minimum $1.00 profit per trade
    // Auto-sell settings
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.996, // 99.6¢ (above endgame max to avoid conflict)
    AUTO_SELL_MIN_HOLD_SECONDS: 120, // Hold at least 2 minutes before auto-selling
    // Endgame sweep settings
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.985, // 98.5¢ (ensures 1.3% net profit minimum after 0.2% fees)
    ENDGAME_MAX_PRICE: 0.995, // 99.5¢ (auto-sell threshold is higher)
    MAX_POSITION_USD: 25, // Balanced position sizing
    // Auto-Redeem settings (claim resolved positions)
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.1, // Skip dust below 10 cents
    /**
     * SMART HEDGING - Balanced settings
     * Instead of selling risky positions at a loss, hedge by buying the opposing side
     */
    SMART_HEDGING_ENABLED: true, // ENABLED BY DEFAULT
    SMART_HEDGING_TRIGGER_LOSS_PCT: 20, // Hedge when position drops 20%
    SMART_HEDGING_MAX_HEDGE_USD: 15, // Max $15 per hedge (balanced)
    SMART_HEDGING_RESERVE_PCT: 20, // Keep 20% reserve for hedging
    // Rate limits (higher for more trades)
    ORDER_SUBMIT_MAX_PER_HOUR: 60,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 5000,
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 60,
    // Existing ARB settings
    ARB_SCAN_INTERVAL_MS: 1500,
    ARB_MIN_EDGE_BPS: 200, // 2% minimum edge
    ARB_MIN_PROFIT_USD: 1.0, // Minimum $1 profit per arb
    ARB_MIN_LIQUIDITY_USD: 3000,
    ARB_MAX_SPREAD_BPS: 10000, // Very permissive
    ARB_TRADE_BASE_USD: 5,
    ARB_SIZE_SCALING: "sqrt",
    ARB_SLIPPAGE_BPS: 20,
    ARB_FEE_BPS: 1, // Correct: 0.01% per trade
    ARB_MAX_POSITION_USD: 25,
    ARB_MAX_WALLET_EXPOSURE_USD: 150,
    ARB_MAX_TRADES_PER_HOUR: 20000,
    ARB_MARKET_COOLDOWN_SECONDS: 2,
    ARB_MAX_CONSECUTIVE_FAILURES: 10,
    ARB_MAX_CONCURRENT_TRADES: 20,
    ARB_STARTUP_COOLDOWN_SECONDS: 5,
    ARB_DEBUG_TOP_N: 10,
    // Monitor settings - fast scanning
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 1, // Low minimum to catch more
    MIN_ORDER_USD: 1,
    TRADE_MULTIPLIER: 0.15,
    TRADE_AGGREGATION_ENABLED: true,
    TRADE_AGGREGATION_WINDOW_SECONDS: 10,
    FRONTRUN_SIZE_MULTIPLIER: 0.05,
    FRONTRUN_MAX_SIZE_USD: 100,
    GAS_PRICE_MULTIPLIER: 1.05,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
  aggressive: {
    STRATEGY_ENABLED: true,
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    /**
     * PROFITABLE SCALPING STRATEGY (v2 - Optimized)
     *
     * KEY INSIGHTS FROM TRADING DATA:
     * - Buying at 46¢, 50¢ is RISKY for scalping (too uncertain)
     * - Buying at 75¢+ is BETTER (clearer outcome, tighter spreads)
     * - Buying at 85¢+ is IDEAL for scalping (near-certain, reliable profits)
     *
     * STRATEGY:
     * 1. Focus on HIGH-CONFIDENCE entries (85¢+) for scalping
     * 2. Scale profit targets with entry price (lower entry = higher target)
     * 3. Quick exits on premium tier entries (90¢+)
     * 4. Hold speculative entries for resolution instead of scalping
     *
     * Target: $1+ profit per trade on $5-10 positions (10-20% return)
     */

    // Quick Flip - DYNAMIC SCALPING
    // Higher entry price = lower target needed (more certain)
    // Lower entry price = hold for resolution or larger move
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 10, // Base 10% target - adjusted dynamically based on entry
    QUICK_FLIP_STOP_LOSS_PCT: 5, // 5% stop - 2:1 risk/reward ratio
    QUICK_FLIP_MIN_HOLD_SECONDS: 0, // Exit immediately when target hit
    QUICK_FLIP_MIN_PROFIT_USD: 1.0, // Minimum $1.00 profit per trade
    /** Enable dynamic profit targets based on entry price (uses trade-quality module) */
    QUICK_FLIP_DYNAMIC_TARGETS: true,

    // Auto-sell when price reaches high confidence
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.96, // Lock in gains at 96¢ (tighter than before)
    AUTO_SELL_MIN_HOLD_SECONDS: 0,

    /**
     * ENDGAME SWEEP - OPTIMIZED FOR PROFITABLE SCALPING
     *
     * IMPORTANT CHANGE: Raised minimum price from 75¢ to 85¢
     * - 85¢+ entries have ~85% win probability
     * - Tighter spreads = easier scalps
     * - Less capital at risk per trade
     * - More predictable outcomes
     */
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.85, // Buy at 85¢+ only (safer entries, better scalp success)
    ENDGAME_MAX_PRICE: 0.94, // Up to 94¢ (room for quick exits)
    MAX_POSITION_USD: 50, // Moderate positions - less risk per trade

    // Auto-redeem resolved positions
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.01,

    /**
     * SMART HEDGING - Aggressive settings
     *
     * REPLACES stop-loss for risky tier positions (<60¢ entry)
     * Instead of selling at a 20% loss, hedge by buying the opposing side
     * This caps maximum loss to the spread paid, not the full position
     *
     * Example: Buy YES at 50¢, drops to 30¢
     * - Old way: Sell at 30¢ = -40% loss
     * - New way: Buy NO at 70¢, ONE side ALWAYS pays $1
     * - Max loss is capped at the spread (~10-20%) vs full loss
     */
    SMART_HEDGING_ENABLED: true, // ENABLED BY DEFAULT - make money, not lose it!
    SMART_HEDGING_TRIGGER_LOSS_PCT: 20, // Hedge when position drops 20%
    SMART_HEDGING_MAX_HEDGE_USD: 25, // Max $25 per hedge (aggressive)
    SMART_HEDGING_RESERVE_PCT: 15, // Keep 15% reserve for hedging (less conservative)

    /**
     * RATE LIMITS - HIGH THROUGHPUT
     * Polymarket limits: 9,000 req/10sec general, 36,000/10min sustained for orders
     * That's 216,000 orders/hour sustained capacity
     */
    ORDER_SUBMIT_MAX_PER_HOUR: 100000, // 100k/hour (under 216k limit)
    ORDER_SUBMIT_MIN_INTERVAL_MS: 10, // 10ms between orders (100/sec max)
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 0, // No per-market cooldown

    /**
     * ARBITRAGE SETTINGS - QUALITY OVER QUANTITY
     * Focus on higher-edge trades rather than volume
     */
    ARB_SCAN_INTERVAL_MS: 100, // Scan 10x/second
    ARB_MIN_EDGE_BPS: 200, // 200bps (2%) minimum edge (up from 150bps) for better profits
    ARB_MIN_PROFIT_USD: 1.0, // Minimum $1 profit per arb trade
    ARB_MAX_SPREAD_BPS: 500, // Tighter spread requirement (500bps = 5% max)
    ARB_FEE_BPS: 1, // Correct fee: 0.01% per side
    ARB_SLIPPAGE_BPS: 20, // Account for 0.2% slippage
    ARB_TRADE_BASE_USD: 15, // Smaller base size for more controlled risk
    ARB_MAX_POSITION_USD: 100, // Reduced from 200 - less risk per position
    ARB_MAX_WALLET_EXPOSURE_USD: 500, // Reduced from 2000 - better risk management
    ARB_MAX_TRADES_PER_HOUR: 50000, // Reduced - focus on quality
    ARB_MARKET_COOLDOWN_SECONDS: 1, // Small cooldown to avoid overtrading one market
    ARB_MAX_CONSECUTIVE_FAILURES: 10, // Lower tolerance - don't chase losses
    ARB_MAX_CONCURRENT_TRADES: 15, // Reduced from 25
    ARB_STARTUP_COOLDOWN_SECONDS: 0,

    // Monitor settings - fast scanning
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 5, // Higher minimum to filter noise
    MIN_ORDER_USD: 5, // Match trade size minimum
    FRONTRUN_MAX_SIZE_USD: 200, // Reduced from 500
    MONITOR_REQUIRE_CONFIRMED: false,
  },

  /**
   * AGGRESSIVE_ENTERPRISE Mode
   *
   * Full enterprise-grade trading system with:
   * - Multi-mode execution (Market-Making + Flow-Following + Inventory Control)
   * - Portfolio risk engine with exposure limits and circuit breakers
   * - Post-only where possible, strict slippage bounds
   * - Deterministic PnL accounting
   *
   * This mode enables all enterprise strategies and uses the enterprise
   * orchestrator for sequential, risk-gated execution.
   *
   * Key differences from 'aggressive':
   * - Centralized risk management (RiskManager gates all orders)
   * - Market selection filter (only trade liquid, tight-spread markets)
   * - Sequential execution (prevents stack issues and race conditions)
   * - Circuit breakers (consecutive rejects, API health, drawdown)
   */
  aggressive_enterprise: {
    STRATEGY_ENABLED: true,
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,

    // === RISK LIMITS ===
    // These are enforced by the enterprise RiskManager
    MAX_EXPOSURE_USD: 2000, // Total portfolio exposure
    MAX_EXPOSURE_PER_MARKET_USD: 200, // Per-market limit
    MAX_DRAWDOWN_PCT: 25, // Circuit breaker triggers at 25% drawdown

    // === QUICK FLIP (Scalping) ===
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 10,
    QUICK_FLIP_STOP_LOSS_PCT: 5,
    QUICK_FLIP_MIN_HOLD_SECONDS: 0,
    QUICK_FLIP_MIN_PROFIT_USD: 1.0,
    QUICK_FLIP_DYNAMIC_TARGETS: true,

    // === AUTO-SELL ===
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.96,
    AUTO_SELL_MIN_HOLD_SECONDS: 0,

    // === ENDGAME SWEEP ===
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.85,
    ENDGAME_MAX_PRICE: 0.94,
    MAX_POSITION_USD: 100, // Per-position limit (also enforced by RiskManager)

    // === AUTO-REDEEM ===
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.01,

    // === SMART HEDGING ===
    SMART_HEDGING_ENABLED: true,
    SMART_HEDGING_TRIGGER_LOSS_PCT: 20,
    SMART_HEDGING_MAX_HEDGE_USD: 50,
    SMART_HEDGING_RESERVE_PCT: 15,

    // === RATE LIMITS ===
    ORDER_SUBMIT_MAX_PER_HOUR: 100000,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 10,
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 0,

    // === ARBITRAGE ===
    ARB_SCAN_INTERVAL_MS: 100,
    ARB_MIN_EDGE_BPS: 200,
    ARB_MIN_PROFIT_USD: 1.0,
    ARB_MAX_SPREAD_BPS: 500,
    ARB_FEE_BPS: 1,
    ARB_SLIPPAGE_BPS: 20,
    ARB_TRADE_BASE_USD: 15,
    ARB_MAX_POSITION_USD: 100,
    ARB_MAX_WALLET_EXPOSURE_USD: 2000,
    ARB_MAX_TRADES_PER_HOUR: 50000,
    ARB_MARKET_COOLDOWN_SECONDS: 1,
    ARB_MAX_CONSECUTIVE_FAILURES: 10,
    ARB_MAX_CONCURRENT_TRADES: 15,
    ARB_STARTUP_COOLDOWN_SECONDS: 0,

    // === MONITOR ===
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 5,
    MIN_ORDER_USD: 1,
    FRONTRUN_MAX_SIZE_USD: 200,
    MONITOR_REQUIRE_CONFIRMED: false,

    // === ENTERPRISE FLAGS ===
    // Enable enterprise orchestrator with sequential execution
    ENTERPRISE_MODE: "aggressive",
    ENTERPRISE_ENABLE_MM: true, // Market Making strategy
    ENTERPRISE_ENABLE_FF: true, // Flow Following strategy
    ENTERPRISE_ENABLE_ICC: true, // Inventory & Correlation Controller
  },
} as const;

export type ArbPresetName = keyof typeof ARB_PRESETS;
export type MonitorPresetName = keyof typeof MONITOR_PRESETS;
export type StrategyPresetName = keyof typeof STRATEGY_PRESETS;

export const DEFAULT_ARB_PRESET: ArbPresetName = "safe_small";
export const DEFAULT_MONITOR_PRESET: MonitorPresetName = "balanced";
export const DEFAULT_STRATEGY_PRESET: StrategyPresetName = "off";
