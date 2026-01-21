/**
 * Strategy configuration constants
 * Extracted to avoid magic numbers and improve maintainability
 */

// Position Tracker constants
export const POSITION_TRACKER_REFRESH_INTERVAL_MS = 30000; // 30 seconds

// Orchestrator constants
export const STRATEGY_EXECUTION_INTERVAL_MS = 60000; // 60 seconds

// Endgame Sweep constants
export const MAX_LIQUIDITY_USAGE_PCT = 0.1; // Use max 10% of available liquidity

// Fee constants (Polymarket trading fees)
export const POLYMARKET_FEE_BPS = 10; // 0.1% per trade (10 basis points)
export const POLYMARKET_ROUND_TRIP_FEE_PCT = 0.2; // 0.2% total for buy + sell (0.1% each)

/**
 * Calculate net profit after fees
 * @param grossProfitPct Gross profit percentage
 * @returns Net profit percentage after 0.2% round-trip fees
 */
export function calculateNetProfit(grossProfitPct: number): number {
  return grossProfitPct - POLYMARKET_ROUND_TRIP_FEE_PCT;
}

/**
 * Check if a trade is profitable after fees
 * @param grossProfitPct Gross profit percentage
 * @param minNetProfitPct Minimum acceptable net profit (default 0.5%)
 * @returns true if trade is profitable after fees
 */
export function isProfitableAfterFees(
  grossProfitPct: number,
  minNetProfitPct: number = 0.5
): boolean {
  return calculateNetProfit(grossProfitPct) >= minNetProfitPct;
}
