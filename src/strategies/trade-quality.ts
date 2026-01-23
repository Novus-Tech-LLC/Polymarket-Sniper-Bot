/**
 * Trade Quality Analysis Module
 *
 * Provides smart decision-making for scalping vs holding based on:
 * - Entry price (higher price = easier to scalp, lower = hold for resolution)
 * - Spread quality (tight spreads = good for scalping)
 * - Liquidity depth (deep liquidity = safe to scalp)
 *
 * Key insight from user feedback:
 * - Buying at 46¢ or 50¢ is risky for scalping - too much uncertainty
 * - Buying at 75¢+ is better for scalping - clearer outcome, tighter spreads
 * - Buying at 90¢+ is ideal for scalping - near-certain, small edge but reliable
 *
 * The goal: Make $1+ per trade on scalps, or hold positions that are likely to win.
 */

/**
 * Trade quality score factors
 */
export interface TradeQualityFactors {
  /** Entry price (0-1 scale, where 0.93 = 93¢) */
  entryPrice: number;
  /** Bid-ask spread in basis points (e.g., 50 = 0.5%) */
  spreadBps?: number;
  /** Available liquidity in USD */
  liquidityUsd?: number;
  /** Position size in USD */
  positionSizeUsd?: number;
}

/**
 * Trade quality assessment result
 */
export interface TradeQualityAssessment {
  /** Overall quality score (0-100, higher is better for scalping) */
  score: number;
  /** Recommended action */
  action: "SCALP" | "HOLD" | "AVOID";
  /** Recommended minimum profit target percentage */
  minProfitTargetPct: number;
  /** Recommended stop loss percentage */
  stopLossPct: number;
  /** Confidence level in the assessment (0-1) */
  confidence: number;
  /** Reasoning for the assessment */
  reasons: string[];
}

/**
 * Price tier thresholds for trade quality assessment
 *
 * Based on user feedback:
 * - Trades at 46¢, 50¢ are harder to scalp (uncertain outcomes)
 * - Trades at 75¢+ have better scalp potential
 * - Trades at 90¢+ are near-certain, ideal for small reliable profits
 *
 * NOTE: Copy trades have additional protection via MIN_BUY_PRICE
 * which blocks buying low-probability positions entirely.
 */
export const PRICE_TIERS = {
  /** Premium tier: 90¢+ - Near certain, ideal for quick scalps */
  PREMIUM_MIN: 0.9,
  /** Quality tier: 80-90¢ - High probability, good for scalping */
  QUALITY_MIN: 0.8,
  /** Standard tier: 70-80¢ - Moderate probability, hold or scalp with care */
  STANDARD_MIN: 0.7,
  /** Speculative tier: 60-70¢ - Lower probability, prefer holding */
  SPECULATIVE_MIN: 0.6,
  /** Risky tier: <60¢ - High uncertainty, avoid scalping */
  RISKY_MAX: 0.6,
} as const;

/**
 * Spread quality thresholds (in basis points)
 */
export const SPREAD_TIERS = {
  /** Excellent spread: < 50bps (0.5%) */
  EXCELLENT_MAX: 50,
  /** Good spread: < 100bps (1%) */
  GOOD_MAX: 100,
  /** Acceptable spread: < 200bps (2%) */
  ACCEPTABLE_MAX: 200,
  /** Wide spread: > 200bps - poor scalp conditions */
  WIDE_MIN: 200,
} as const;

/**
 * Liquidity thresholds in USD
 */
export const LIQUIDITY_TIERS = {
  /** Deep liquidity: $10k+ - safe for larger scalps */
  DEEP_MIN: 10000,
  /** Good liquidity: $5k+ - safe for moderate scalps */
  GOOD_MIN: 5000,
  /** Thin liquidity: $2k+ - small scalps only */
  THIN_MIN: 2000,
  /** Illiquid: <$2k - avoid scalping */
  ILLIQUID_MAX: 2000,
} as const;

/**
 * Profit target recommendations based on entry price
 * Higher entry price = smaller profit target (more certain outcome)
 * Lower entry price = larger profit target (need more edge to justify risk)
 *
 * NOTE: For copy trades, low-price positions are blocked by MIN_BUY_PRICE.
 * These targets apply to positions from other strategies (endgame-sweep, etc.)
 */
export const PROFIT_TARGETS = {
  /** Premium tier (90¢+): 5-10% target */
  PREMIUM: { minProfitPct: 5, maxProfitPct: 10, stopLossPct: 3 },
  /** Quality tier (80-90¢): 10-15% target */
  QUALITY: { minProfitPct: 10, maxProfitPct: 15, stopLossPct: 5 },
  /** Standard tier (70-80¢): 15-25% target */
  STANDARD: { minProfitPct: 15, maxProfitPct: 25, stopLossPct: 8 },
  /** Speculative tier (60-70¢): 25-40% target, prefer hold */
  SPECULATIVE: { minProfitPct: 25, maxProfitPct: 40, stopLossPct: 12 },
  /** Risky tier (<60¢): Hold for resolution, don't scalp */
  RISKY: { minProfitPct: 50, maxProfitPct: 100, stopLossPct: 20 },
} as const;

/**
 * Assess trade quality and determine scalp vs hold decision
 *
 * @param factors - The trade quality factors to assess
 * @returns Assessment with score, action, and recommendations
 */
export function assessTradeQuality(
  factors: TradeQualityFactors,
): TradeQualityAssessment {
  const reasons: string[] = [];
  let score = 0;
  let confidence = 0;

  // === Price Score (40 points max) ===
  const priceScore = calculatePriceScore(factors.entryPrice);
  score += priceScore.score;
  reasons.push(...priceScore.reasons);
  confidence += priceScore.confidence * 0.4;

  // === Spread Score (30 points max) ===
  if (factors.spreadBps !== undefined) {
    const spreadScore = calculateSpreadScore(factors.spreadBps);
    score += spreadScore.score;
    reasons.push(...spreadScore.reasons);
    confidence += spreadScore.confidence * 0.3;
  } else {
    // Without spread data, reduce confidence
    confidence += 0.15; // Half weight
    reasons.push("Spread data unavailable - reduced confidence");
  }

  // === Liquidity Score (30 points max) ===
  if (factors.liquidityUsd !== undefined) {
    const liquidityScore = calculateLiquidityScore(
      factors.liquidityUsd,
      factors.positionSizeUsd,
    );
    score += liquidityScore.score;
    reasons.push(...liquidityScore.reasons);
    confidence += liquidityScore.confidence * 0.3;
  } else {
    // Without liquidity data, reduce confidence
    confidence += 0.15; // Half weight
    reasons.push("Liquidity data unavailable - reduced confidence");
  }

  // === Determine Action and Profit Targets ===
  const { action, minProfitTargetPct, stopLossPct } = determineAction(
    factors.entryPrice,
    score,
  );

  if (action === "SCALP") {
    reasons.push(`Recommended: SCALP with ${minProfitTargetPct}% target`);
  } else if (action === "HOLD") {
    reasons.push(`Recommended: HOLD for resolution (entry price too low)`);
  } else {
    reasons.push(`Recommended: AVOID - poor scalp conditions`);
  }

  return {
    score: Math.round(score),
    action,
    minProfitTargetPct,
    stopLossPct,
    confidence: Math.min(1, confidence),
    reasons,
  };
}

/**
 * Calculate price-based quality score
 */
function calculatePriceScore(entryPrice: number): {
  score: number;
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  let confidence = 0;

  if (entryPrice >= PRICE_TIERS.PREMIUM_MIN) {
    score = 40;
    confidence = 1;
    reasons.push(
      `Premium tier entry (${(entryPrice * 100).toFixed(1)}¢): ideal for scalping`,
    );
  } else if (entryPrice >= PRICE_TIERS.QUALITY_MIN) {
    score = 32;
    confidence = 0.85;
    reasons.push(
      `Quality tier entry (${(entryPrice * 100).toFixed(1)}¢): good for scalping`,
    );
  } else if (entryPrice >= PRICE_TIERS.STANDARD_MIN) {
    score = 24;
    confidence = 0.7;
    reasons.push(
      `Standard tier entry (${(entryPrice * 100).toFixed(1)}¢): moderate scalp potential`,
    );
  } else if (entryPrice >= PRICE_TIERS.SPECULATIVE_MIN) {
    score = 15;
    confidence = 0.5;
    reasons.push(
      `Speculative tier entry (${(entryPrice * 100).toFixed(1)}¢): prefer holding`,
    );
  } else {
    score = 5;
    confidence = 0.3;
    reasons.push(
      `Risky tier entry (${(entryPrice * 100).toFixed(1)}¢): avoid scalping, hold for resolution`,
    );
  }

  return { score, confidence, reasons };
}

/**
 * Calculate spread-based quality score
 */
function calculateSpreadScore(spreadBps: number): {
  score: number;
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  let confidence = 0;

  if (spreadBps <= SPREAD_TIERS.EXCELLENT_MAX) {
    score = 30;
    confidence = 1;
    reasons.push(`Excellent spread (${spreadBps}bps): ideal for scalping`);
  } else if (spreadBps <= SPREAD_TIERS.GOOD_MAX) {
    score = 24;
    confidence = 0.85;
    reasons.push(`Good spread (${spreadBps}bps): suitable for scalping`);
  } else if (spreadBps <= SPREAD_TIERS.ACCEPTABLE_MAX) {
    score = 15;
    confidence = 0.6;
    reasons.push(`Acceptable spread (${spreadBps}bps): scalp with caution`);
  } else {
    score = 5;
    confidence = 0.3;
    reasons.push(`Wide spread (${spreadBps}bps): poor scalp conditions`);
  }

  return { score, confidence, reasons };
}

/**
 * Calculate liquidity-based quality score
 */
function calculateLiquidityScore(
  liquidityUsd: number,
  positionSizeUsd?: number,
): { score: number; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  let confidence = 0;

  // Check absolute liquidity
  if (liquidityUsd >= LIQUIDITY_TIERS.DEEP_MIN) {
    score = 30;
    confidence = 1;
    reasons.push(
      `Deep liquidity ($${(liquidityUsd / 1000).toFixed(1)}k): safe for scalping`,
    );
  } else if (liquidityUsd >= LIQUIDITY_TIERS.GOOD_MIN) {
    score = 24;
    confidence = 0.85;
    reasons.push(
      `Good liquidity ($${(liquidityUsd / 1000).toFixed(1)}k): suitable for scalping`,
    );
  } else if (liquidityUsd >= LIQUIDITY_TIERS.THIN_MIN) {
    score = 15;
    confidence = 0.6;
    reasons.push(
      `Thin liquidity ($${(liquidityUsd / 1000).toFixed(1)}k): small scalps only`,
    );
  } else {
    score = 5;
    confidence = 0.3;
    reasons.push(
      `Illiquid market ($${liquidityUsd.toFixed(0)}): avoid scalping`,
    );
  }

  // Penalize if position size is large relative to liquidity
  if (positionSizeUsd !== undefined && positionSizeUsd > 0) {
    const sizeRatio = positionSizeUsd / liquidityUsd;
    if (sizeRatio > 0.1) {
      // Position is >10% of liquidity
      score -= 10;
      confidence -= 0.2;
      reasons.push(
        `Position size (${(sizeRatio * 100).toFixed(1)}% of liquidity) may cause slippage`,
      );
    }
  }

  return {
    score: Math.max(0, score),
    confidence: Math.max(0, confidence),
    reasons,
  };
}

/**
 * Determine action and profit targets based on entry price and score
 */
function determineAction(
  entryPrice: number,
  score: number,
): {
  action: "SCALP" | "HOLD" | "AVOID";
  minProfitTargetPct: number;
  stopLossPct: number;
} {
  // Very low scores = avoid
  if (score < 30) {
    return {
      action: "AVOID",
      minProfitTargetPct: PROFIT_TARGETS.RISKY.minProfitPct,
      stopLossPct: PROFIT_TARGETS.RISKY.stopLossPct,
    };
  }

  // Determine targets based on entry price tier
  if (entryPrice >= PRICE_TIERS.PREMIUM_MIN) {
    return {
      action: "SCALP",
      minProfitTargetPct: PROFIT_TARGETS.PREMIUM.minProfitPct,
      stopLossPct: PROFIT_TARGETS.PREMIUM.stopLossPct,
    };
  } else if (entryPrice >= PRICE_TIERS.QUALITY_MIN) {
    return {
      action: "SCALP",
      minProfitTargetPct: PROFIT_TARGETS.QUALITY.minProfitPct,
      stopLossPct: PROFIT_TARGETS.QUALITY.stopLossPct,
    };
  } else if (entryPrice >= PRICE_TIERS.STANDARD_MIN) {
    // Standard tier: scalp only if score is good
    if (score >= 50) {
      return {
        action: "SCALP",
        minProfitTargetPct: PROFIT_TARGETS.STANDARD.minProfitPct,
        stopLossPct: PROFIT_TARGETS.STANDARD.stopLossPct,
      };
    } else {
      return {
        action: "HOLD",
        minProfitTargetPct: PROFIT_TARGETS.STANDARD.minProfitPct,
        stopLossPct: PROFIT_TARGETS.STANDARD.stopLossPct,
      };
    }
  } else if (entryPrice >= PRICE_TIERS.SPECULATIVE_MIN) {
    // Speculative tier: hold unless exceptional conditions
    if (score >= 70) {
      return {
        action: "SCALP",
        minProfitTargetPct: PROFIT_TARGETS.SPECULATIVE.minProfitPct,
        stopLossPct: PROFIT_TARGETS.SPECULATIVE.stopLossPct,
      };
    } else {
      return {
        action: "HOLD",
        minProfitTargetPct: PROFIT_TARGETS.SPECULATIVE.minProfitPct,
        stopLossPct: PROFIT_TARGETS.SPECULATIVE.stopLossPct,
      };
    }
  } else {
    // Risky tier: avoid scalping entirely
    return {
      action: "HOLD",
      minProfitTargetPct: PROFIT_TARGETS.RISKY.minProfitPct,
      stopLossPct: PROFIT_TARGETS.RISKY.stopLossPct,
    };
  }
}

/**
 * Check if a trade should be taken based on entry price
 * Simple helper for strategies to quickly filter bad entries
 *
 * @param entryPrice - Entry price (0-1 scale)
 * @param minPrice - Minimum acceptable price (default 0.7 = 70¢)
 * @returns true if trade should be considered
 */
export function shouldTakeTrade(
  entryPrice: number,
  minPrice: number = PRICE_TIERS.STANDARD_MIN,
): boolean {
  return entryPrice >= minPrice;
}

/**
 * Get dynamic profit target based on entry price
 * Lower entry = higher target required (more uncertainty)
 *
 * @param entryPrice - Entry price (0-1 scale)
 * @returns Recommended profit target percentage
 */
export function getDynamicProfitTarget(entryPrice: number): number {
  if (entryPrice >= PRICE_TIERS.PREMIUM_MIN) {
    return PROFIT_TARGETS.PREMIUM.minProfitPct;
  } else if (entryPrice >= PRICE_TIERS.QUALITY_MIN) {
    return PROFIT_TARGETS.QUALITY.minProfitPct;
  } else if (entryPrice >= PRICE_TIERS.STANDARD_MIN) {
    return PROFIT_TARGETS.STANDARD.minProfitPct;
  } else if (entryPrice >= PRICE_TIERS.SPECULATIVE_MIN) {
    return PROFIT_TARGETS.SPECULATIVE.minProfitPct;
  } else {
    return PROFIT_TARGETS.RISKY.minProfitPct;
  }
}

/**
 * Get dynamic stop loss based on entry price
 * Lower entry = wider stop loss (more volatility expected)
 *
 * @param entryPrice - Entry price (0-1 scale)
 * @returns Recommended stop loss percentage
 */
export function getDynamicStopLoss(entryPrice: number): number {
  if (entryPrice >= PRICE_TIERS.PREMIUM_MIN) {
    return PROFIT_TARGETS.PREMIUM.stopLossPct;
  } else if (entryPrice >= PRICE_TIERS.QUALITY_MIN) {
    return PROFIT_TARGETS.QUALITY.stopLossPct;
  } else if (entryPrice >= PRICE_TIERS.STANDARD_MIN) {
    return PROFIT_TARGETS.STANDARD.stopLossPct;
  } else if (entryPrice >= PRICE_TIERS.SPECULATIVE_MIN) {
    return PROFIT_TARGETS.SPECULATIVE.stopLossPct;
  } else {
    return PROFIT_TARGETS.RISKY.stopLossPct;
  }
}

/**
 * Calculate expected return considering the probability implied by price
 *
 * @param entryPrice - Entry price (0-1 scale)
 * @param profitIfWin - Profit if the position resolves to $1 (as percentage)
 * @returns Expected return percentage (can be negative)
 */
export function calculateExpectedReturn(
  entryPrice: number,
  profitIfWin?: number,
): number {
  // Entry price implies probability of winning
  // If we buy at 80¢, there's ~80% chance of winning
  const winProbability = entryPrice;
  const loseProbability = 1 - entryPrice;

  // If we win, we get $1 per share (so profit = 1 - entryPrice)
  // If we lose, we lose entryPrice
  const winProfit = profitIfWin ?? ((1 - entryPrice) / entryPrice) * 100;
  const lossAmount = 100; // Lose entire position

  // Expected return = P(win) * profit% - P(lose) * loss%
  const expectedReturn =
    winProbability * winProfit - loseProbability * lossAmount;

  return expectedReturn;
}
