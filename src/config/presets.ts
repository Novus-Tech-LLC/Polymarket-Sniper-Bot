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
  },
  conservative: {
    STRATEGY_ENABLED: true,
    // Combines ARB + MONITOR settings
    ARB_ENABLED: true,
    MONITOR_ENABLED: true,
    // Quick Flip settings - aim for meaningful profits
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 15, // 15% target on position size, with at least $0.50 profit per trade
    QUICK_FLIP_STOP_LOSS_PCT: 5, // 5% stop loss
    QUICK_FLIP_MIN_HOLD_SECONDS: 60,
    QUICK_FLIP_MIN_PROFIT_USD: 0.5, // Minimum $0.50 profit per trade
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
    // Rate limits
    ORDER_SUBMIT_MAX_PER_HOUR: 30,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 10000,
    // Existing ARB settings (from safe_small)
    ARB_SCAN_INTERVAL_MS: 2000,
    ARB_MIN_EDGE_BPS: 120,
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
    // Quick Flip settings - aim for meaningful profits
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 10, // 10% gain target - ensures $0.50+ profit on $5 positions
    QUICK_FLIP_STOP_LOSS_PCT: 5, // 5% stop loss (proportional to target)
    QUICK_FLIP_MIN_HOLD_SECONDS: 30,
    QUICK_FLIP_MIN_PROFIT_USD: 0.25, // Minimum $0.25 profit per trade
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
    // Rate limits (higher for more trades)
    ORDER_SUBMIT_MAX_PER_HOUR: 60,
    ORDER_SUBMIT_MIN_INTERVAL_MS: 5000,
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 60,
    // Existing ARB settings (from micro, optimized)
    ARB_SCAN_INTERVAL_MS: 1500,
    ARB_MIN_EDGE_BPS: 50,
    ARB_MIN_PROFIT_USD: 0.1, // Increased from 0.05 - minimum 10 cents profit
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
     * HIGH-FREQUENCY SCALPING STRATEGY
     *
     * Fee structure (2024-2025):
     * - Taker: 0.01% (1 bps)
     * - Maker: 0%
     * - Round-trip: 0.02%
     *
     * IMPORTANT: While fees are low, 5-cent profits on $5 trades are not meaningful.
     * Aim for at least 5% gains ($0.25+ on $5) to make trades worthwhile.
     *
     * Key strategies:
     * 1. Spread scalping - profit from bid/ask gaps
     * 2. Unity constraint arb - YES + NO should = $1.00
     * 3. Tail-end trading - mispriced contracts near resolution
     * 4. Momentum scalps - ride quick price movements
     */

    // Quick Flip - SCALPING WITH MEANINGFUL PROFITS
    // 5% target ensures at least $0.25 profit on $5 positions
    QUICK_FLIP_ENABLED: true,
    QUICK_FLIP_TARGET_PCT: 5, // 5% gross (was 2% - too small for meaningful profit)
    QUICK_FLIP_STOP_LOSS_PCT: 3, // 3% stop - balanced risk/reward
    QUICK_FLIP_MIN_HOLD_SECONDS: 0, // Exit immediately when target hit
    QUICK_FLIP_MIN_PROFIT_USD: 0.15, // Minimum $0.15 profit per trade (aggressive allows smaller)

    // Auto-sell when price spikes
    AUTO_SELL_ENABLED: true,
    AUTO_SELL_THRESHOLD: 0.95, // Lock in gains at 95¢
    AUTO_SELL_MIN_HOLD_SECONDS: 0,

    // Endgame sweep - 80-90¢ range for scalping
    // More volatility = more scalping opportunities
    ENDGAME_SWEEP_ENABLED: true,
    ENDGAME_MIN_PRICE: 0.75, // Buy at 75¢+ (25% upside potential)
    ENDGAME_MAX_PRICE: 0.92, // Up to 92¢ (room for quick exits)
    MAX_POSITION_USD: 100, // Larger positions for scalping

    // Auto-redeem resolved positions
    AUTO_REDEEM_ENABLED: true,
    AUTO_REDEEM_MIN_POSITION_USD: 0.01,

    /**
     * RATE LIMITS - HIGH THROUGHPUT
     * Polymarket limits: 9,000 req/10sec general, 36,000/10min sustained for orders
     * That's 216,000 orders/hour sustained capacity
     *
     * For HFT, we want:
     * - Minimal delays (but not zero - avoid spam detection)
     * - High concurrency for parallel execution
     * - Smart throttling to stay under limits
     */
    ORDER_SUBMIT_MAX_PER_HOUR: 100000, // 100k/hour (under 216k limit)
    ORDER_SUBMIT_MIN_INTERVAL_MS: 10, // 10ms between orders (100/sec max)
    ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS: 0, // No per-market cooldown

    /**
     * ARBITRAGE SETTINGS - MEANINGFUL VOLUME
     * With 0.01% taker fee, edges are profitable - but aim for bigger ones
     */
    ARB_SCAN_INTERVAL_MS: 100, // Scan 10x/second
    ARB_MIN_EDGE_BPS: 50, // 0.5% edge (was 0.1% - too thin for meaningful profit)
    ARB_MIN_PROFIT_USD: 0.1, // Minimum 10 cents profit per arb trade
    ARB_MAX_SPREAD_BPS: 10000, // Permissive spread tolerance
    ARB_FEE_BPS: 1, // Correct fee: 0.01% per side
    ARB_SLIPPAGE_BPS: 20, // Account for 0.2% slippage
    ARB_TRADE_BASE_USD: 25, // Larger base size for scalping
    ARB_MAX_POSITION_USD: 200,
    ARB_MAX_WALLET_EXPOSURE_USD: 2000,
    ARB_MAX_TRADES_PER_HOUR: 100000,
    ARB_MARKET_COOLDOWN_SECONDS: 0,
    ARB_MAX_CONSECUTIVE_FAILURES: 20, // Higher tolerance for fast trading
    ARB_MAX_CONCURRENT_TRADES: 25, // Parallel execution
    ARB_STARTUP_COOLDOWN_SECONDS: 0,

    // Monitor settings - fast scanning
    FETCH_INTERVAL: 1,
    MIN_TRADE_SIZE_USD: 1,
    MIN_ORDER_USD: 1,
    FRONTRUN_MAX_SIZE_USD: 500,
    MONITOR_REQUIRE_CONFIRMED: false,
  },
} as const;

export type ArbPresetName = keyof typeof ARB_PRESETS;
export type MonitorPresetName = keyof typeof MONITOR_PRESETS;
export type StrategyPresetName = keyof typeof STRATEGY_PRESETS;

export const DEFAULT_ARB_PRESET: ArbPresetName = "safe_small";
export const DEFAULT_MONITOR_PRESET: MonitorPresetName = "balanced";
export const DEFAULT_STRATEGY_PRESET: StrategyPresetName = "off";
