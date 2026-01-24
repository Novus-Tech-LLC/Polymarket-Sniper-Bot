/**
 * Price Unit Utilities
 *
 * Centralized helpers for price unit normalization and formatting.
 * All prices in the system should be stored as DOLLARS in [0, 1].
 *
 * CRITICAL: This module ensures consistent price handling across:
 * - PositionTracker (Data-API prices)
 * - SmartHedging (orderbook prices)
 * - All logging and display
 *
 * RULES:
 * 1. Internal storage: ALWAYS dollars [0, 1]
 * 2. Display/logging: ALWAYS cents [0, 100] via formatCents()
 * 3. If a value is > 1, it's already in cents - convert via toDollars()
 */

/**
 * Orderbook quality assessment for a token.
 * Used to determine if orderbook prices can be trusted for P&L calculations.
 */
export type OrderbookQuality = "VALID" | "INVALID_BOOK" | "NO_BOOK";

/**
 * Result of orderbook quality assessment
 */
export interface OrderbookQualityResult {
  quality: OrderbookQuality;
  reason?: string;
}

/**
 * Near-resolution threshold in dollars.
 * Positions with currentPrice >= this are considered near-resolution winners.
 */
export const NEAR_RESOLUTION_THRESHOLD_DOLLARS = 0.995; // 99.5¢

/**
 * Minimum price in dollars for near-resolution classification.
 * Prevents false positives for low-priced positions.
 */
export const NEAR_RESOLUTION_MIN_PRICE_DOLLARS = 0.50; // 50¢

/**
 * Maximum price divergence between orderbook and Data-API before book is invalid.
 * If |bestBid - dataApiPrice| > this, the orderbook is considered stale/broken.
 */
export const MAX_BOOK_DIVERGENCE_DOLLARS = 0.30; // 30¢

/**
 * Threshold for detecting broken/invalid orderbooks.
 * If bestBid < this AND bestAsk > ASK_THRESHOLD, book is invalid.
 */
export const INVALID_BOOK_BID_THRESHOLD_DOLLARS = 0.05; // 5¢
export const INVALID_BOOK_ASK_THRESHOLD_DOLLARS = 0.95; // 95¢

/**
 * Convert a price value to dollars in [0, 1].
 *
 * If the value is > 1, it's assumed to be in cents and is divided by 100.
 * If the value is already in [0, 1], it's returned as-is.
 *
 * @param value - Price value (may be dollars or cents)
 * @returns Price in dollars [0, 1]
 *
 * @example
 * toDollars(0.65) // => 0.65 (already dollars)
 * toDollars(65)   // => 0.65 (was cents)
 * toDollars(100)  // => 1.0  (was cents)
 * toDollars(0.9995) // => 0.9995 (already dollars)
 */
export function toDollars(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    // Value is in cents, convert to dollars
    return Math.min(value / 100, 1);
  }
  // Value is already in dollars
  return value;
}

/**
 * Format a dollar price as cents for display.
 *
 * @param dollars - Price in dollars [0, 1]
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string with ¢ suffix
 *
 * @example
 * formatCents(0.65) // => "65.00¢"
 * formatCents(0.9995) // => "99.95¢"
 * formatCents(1.0) // => "100.00¢"
 * formatCents(0.01, 1) // => "1.0¢"
 */
export function formatCents(dollars: number, decimals: number = 2): string {
  const cents = dollars * 100;
  return `${cents.toFixed(decimals)}¢`;
}

/**
 * Check if a price is near resolution (close to 100%).
 *
 * A position is considered "near resolution" when:
 * 1. currentPrice >= NEAR_RESOLUTION_THRESHOLD_DOLLARS (99.5¢)
 * 2. currentPrice >= NEAR_RESOLUTION_MIN_PRICE_DOLLARS (50¢) - safety guard
 *
 * CRITICAL: Prices < 50¢ are NEVER classified as near-resolution.
 * This prevents false positives from broken/stale orderbook data.
 *
 * @param currentPriceDollars - Current price in dollars [0, 1]
 * @returns true if position is near resolution
 */
export function isNearResolution(currentPriceDollars: number): boolean {
  // Safety guard: NEVER classify prices < 50¢ as near-resolution
  if (currentPriceDollars < NEAR_RESOLUTION_MIN_PRICE_DOLLARS) {
    return false;
  }
  return currentPriceDollars >= NEAR_RESOLUTION_THRESHOLD_DOLLARS;
}

/**
 * Assess the quality of an orderbook for P&L calculations.
 *
 * Returns INVALID_BOOK when:
 * 1. bestBid < 5¢ AND bestAsk > 95¢ (wide spread suggesting broken book)
 * 2. |bestBid - dataApiPrice| > 30¢ (orderbook diverges from Data-API)
 *
 * Returns NO_BOOK when:
 * - bestBid is null/undefined
 *
 * Returns VALID otherwise.
 *
 * @param bestBidDollars - Best bid price in dollars (or undefined if no bids)
 * @param bestAskDollars - Best ask price in dollars (or undefined if no asks)
 * @param dataApiPriceDollars - Data-API mark price in dollars
 * @returns OrderbookQualityResult with quality and reason
 */
export function assessOrderbookQuality(
  bestBidDollars: number | undefined,
  bestAskDollars: number | undefined,
  dataApiPriceDollars: number | undefined,
): OrderbookQualityResult {
  // NO_BOOK: No bid available
  if (bestBidDollars === undefined || bestBidDollars === null) {
    return { quality: "NO_BOOK", reason: "no_bids_available" };
  }

  // INVALID_BOOK: Wide spread (bestBid < 5¢ AND bestAsk > 95¢)
  if (
    bestBidDollars < INVALID_BOOK_BID_THRESHOLD_DOLLARS &&
    bestAskDollars !== undefined &&
    bestAskDollars > INVALID_BOOK_ASK_THRESHOLD_DOLLARS
  ) {
    return {
      quality: "INVALID_BOOK",
      reason: `wide_spread: bid=${formatCents(bestBidDollars)} ask=${formatCents(bestAskDollars)}`,
    };
  }

  // INVALID_BOOK: Large divergence from Data-API price
  if (dataApiPriceDollars !== undefined) {
    const divergence = Math.abs(bestBidDollars - dataApiPriceDollars);
    if (divergence > MAX_BOOK_DIVERGENCE_DOLLARS) {
      return {
        quality: "INVALID_BOOK",
        reason: `price_divergence: bid=${formatCents(bestBidDollars)} dataApi=${formatCents(dataApiPriceDollars)} divergence=${formatCents(divergence)}`,
      };
    }
  }

  return { quality: "VALID" };
}

/**
 * Validate that a price is in the expected dollar range [0, 1].
 *
 * @param value - Price value to validate
 * @param context - Context string for error messages
 * @returns true if valid, false otherwise
 */
export function isValidDollarPrice(value: number): boolean {
  return typeof value === "number" && !isNaN(value) && value >= 0 && value <= 1;
}
