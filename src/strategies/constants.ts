/**
 * Strategy configuration constants
 * Extracted to avoid magic numbers and improve maintainability
 */

/**
 * Position Tracker constants
 *
 * For HFT with many positions, we need fast refresh rates.
 * As you compound and scale up, position count grows exponentially.
 * The system must handle 100s of positions without bottlenecking.
 */
export const POSITION_TRACKER_REFRESH_INTERVAL_MS = 5000; // 5 seconds - fast refresh for HFT

/**
 * Orchestrator constants
 *
 * Strategy execution must be fast to catch quick profit opportunities.
 * With many positions, we run strategies in PARALLEL not sequential.
 */
export const STRATEGY_EXECUTION_INTERVAL_MS = 2000; // 2 seconds - rapid execution for scalping

/**
 * Auto-Redeem check interval
 *
 * How often the auto-redeem strategy checks for redeemable positions.
 * Auto-redeem runs as part of the strategy orchestrator loop (every 2 seconds),
 * but internally throttles to this interval to avoid excessive blockchain calls.
 *
 * Default: 30 seconds (30000ms)
 * - Positions are checked against the position tracker which refreshes every 5 seconds
 * - Actual redemption requires blockchain transaction, so more frequent checks waste gas estimation
 * - 30 seconds is a reasonable balance between responsiveness and efficiency
 *
 * Can be overridden via AUTO_REDEEM_CHECK_INTERVAL_MS environment variable.
 */
export const AUTO_REDEEM_CHECK_INTERVAL_MS = 30000; // 30 seconds default

/**
 * Parallel execution settings
 * As positions scale, we need more concurrency
 */
export const MAX_PARALLEL_POSITION_CHECKS = 50; // Check up to 50 positions in parallel
export const MAX_PARALLEL_SELLS = 10; // Execute up to 10 sells in parallel

// Endgame Sweep constants
export const MAX_LIQUIDITY_USAGE_PCT = 0.1; // Use max 10% of available liquidity

/**
 * Fee constants (Polymarket trading fees as of 2024-2025)
 * @see https://docs.polymarket.com/polymarket-learn/trading/fees
 *
 * - Taker Fee: 0.01% (1 basis point) - paid when your order is immediately matched
 * - Maker Fee: 0% - paid when your limit order rests on the book
 *
 * For HFT scalping (taking liquidity), round-trip cost is only 0.02%!
 * This means even tiny edges of 0.1% are profitable.
 */
export const POLYMARKET_TAKER_FEE_BPS = 1; // 0.01% per trade (1 basis point)
export const POLYMARKET_MAKER_FEE_BPS = 0; // 0% for maker orders
export const POLYMARKET_FEE_BPS = 1; // Default to taker fee for conservative calculations
export const POLYMARKET_ROUND_TRIP_FEE_PCT = 0.02; // 0.02% total for buy + sell as taker (0.01% each)

/**
 * Calculate net profit after fees
 * @param grossProfitPct Gross profit percentage
 * @returns Net profit percentage after round-trip fees
 */
export function calculateNetProfit(grossProfitPct: number): number {
  return grossProfitPct - POLYMARKET_ROUND_TRIP_FEE_PCT;
}

/**
 * Check if a trade is profitable after fees
 * For HFT scalping with 0.02% round-trip fees, even small edges are profitable
 * @param grossProfitPct Gross profit percentage
 * @param minNetProfitPct Minimum acceptable net profit (default 0.1% for scalping)
 * @returns true if trade is profitable after fees
 */
export function isProfitableAfterFees(
  grossProfitPct: number,
  minNetProfitPct: number = 0.1,
): boolean {
  return calculateNetProfit(grossProfitPct) >= minNetProfitPct;
}

/**
 * Minimum profit thresholds for scalping
 *
 * IMPORTANT: Small profits are NOT worth the effort and risk.
 * Every trade has overhead: transaction fees, slippage risk, time.
 * Aim for at least $1 profit per trade to make it worthwhile.
 *
 * Examples on a $10 position:
 * - 10% gain = $1.00 profit (minimum acceptable)
 * - 15% gain = $1.50 profit (good)
 * - 25% gain = $2.50 profit (excellent)
 *
 * These thresholds ensure that trades generate meaningful profits.
 */

/**
 * Minimum absolute profit in USD for quick-flip sells
 * Trades below this profit threshold will be held longer
 * Default: $1.00 minimum profit per trade - anything less isn't worth it
 */
export const MIN_QUICK_FLIP_PROFIT_USD = 1.0;

/**
 * Default minimum profit percentage for quick-flip
 * 10% minimum to ensure meaningful dollar profits
 */
export const DEFAULT_QUICK_FLIP_TARGET_PCT = 10;

/**
 * Check if a trade meets minimum profit requirements
 * Both percentage AND absolute USD profit must be met
 *
 * NOTE: This function is provided for external use cases. The quick-flip strategy
 * uses position.pnlUsd directly from the position tracker for more accurate calculations.
 *
 * @param positionCostUsd Original position cost (size * entryPrice), NOT current market value
 * @param profitPct Profit percentage (gross)
 * @param minProfitPct Minimum profit percentage required
 * @param minProfitUsd Minimum absolute profit in USD required
 * @returns true if trade meets all profit requirements
 */
export function meetsMinProfitRequirements(
  positionCostUsd: number,
  profitPct: number,
  minProfitPct: number = DEFAULT_QUICK_FLIP_TARGET_PCT,
  minProfitUsd: number = MIN_QUICK_FLIP_PROFIT_USD,
): boolean {
  // Check percentage requirement
  if (profitPct < minProfitPct) {
    return false;
  }

  // Calculate absolute profit based on original investment
  const absoluteProfitUsd = (profitPct / 100) * positionCostUsd;

  // Check absolute profit requirement
  return absoluteProfitUsd >= minProfitUsd;
}
