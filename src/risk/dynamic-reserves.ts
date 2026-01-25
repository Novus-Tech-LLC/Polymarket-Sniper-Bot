/**
 * Dynamic Reserves / Capital Allocation Controller
 *
 * Prevents the bot from taking new positions when we lack sufficient reserves
 * to hedge or survive large adverse moves. Computed from live portfolio state
 * (positions + current prices) and gates new BUY orders until reserves are restored.
 *
 * RESERVE MODEL:
 * A) Base reserve: max(20, 0.05 * equityUsd)
 * B) Per-position reserve based on P&L tier and win probability:
 *    - Near-resolution or redeemable: 0
 *    - High win probability (currentPrice >= 85¢): min(0.5, notional * 0.02)
 *    - Catastrophic loss (>=50%): min(HEDGE_CAP_USD, notional * 1.0)
 *    - Hedge trigger loss (>=20%): min(HEDGE_CAP_USD, notional * 0.5)
 *    - Normal: min(2, notional * 0.1)
 * C) Liquidity penalty: 1.5x if NOT_TRADABLE_ON_CLOB
 * D) Total capped at MAX_RESERVE_USD
 *
 * HIGH WIN PROBABILITY TIER:
 * When a position's current price is high (≥85¢ by default), the probability
 * of winning is high, so minimal reserves are needed regardless of entry price
 * or P&L. This reflects the reduced risk of positions likely to resolve in our favor.
 *
 * GATING BEHAVIOR:
 * - RISK_OFF mode: block new BUY orders, allow SELL/hedge/redeem
 * - RISK_ON mode: allow all order types
 */

import type { ConsoleLogger } from "../utils/logger.util";
import type {
  PortfolioSnapshot,
  Position,
} from "../strategies/position-tracker";
import { LogDeduper } from "../utils/log-deduper.util";

// ============================================================
// CONFIGURATION TYPES
// ============================================================

/**
 * Dynamic Reserves Configuration
 */
export interface DynamicReservesConfig {
  /** Enable dynamic reserves gating (default: true) */
  enabled: boolean;

  /** Base reserve floor in USD (default: 20) */
  baseReserveFloorUsd: number;

  /** Base reserve as percentage of equity (default: 0.05 = 5%) */
  baseReserveEquityPct: number;

  /** Maximum reserve cap in USD (default: 200) */
  maxReserveUsd: number;

  /** Per-position hedge cap in USD - aligns with SMART_HEDGING_ABSOLUTE_MAX_USD (default: 25) */
  hedgeCapUsd: number;

  /** Loss % threshold to trigger hedge-tier reserve (default: 20) */
  hedgeTriggerLossPct: number;

  /** Loss % threshold for catastrophic-tier reserve (default: 50) */
  catastrophicLossPct: number;

  /** Multiplier for positions with no liquidity (default: 1.5) */
  illiquidityMultiplier: number;

  /** Reserve multiplier for normal (non-losing) positions (default: 0.1 = 10% of notional) */
  normalReservePct: number;

  /** Cap per-position normal reserve in USD (default: 2) */
  normalReserveCapUsd: number;

  /** Price threshold for high win probability tier (default: 0.85 = 85¢) */
  highWinProbPriceThreshold: number;

  /** Reserve multiplier for high win probability positions (default: 0.02 = 2% of notional) */
  highWinProbReservePct: number;

  /** Cap per-position high win probability reserve in USD (default: 0.5) */
  highWinProbReserveCapUsd: number;
}

/**
 * Default configuration - conservative but functional
 */
export const DEFAULT_RESERVES_CONFIG: DynamicReservesConfig = {
  enabled: true,
  baseReserveFloorUsd: 20,
  baseReserveEquityPct: 0.05,
  maxReserveUsd: 200,
  hedgeCapUsd: 25,
  hedgeTriggerLossPct: 20,
  catastrophicLossPct: 50,
  illiquidityMultiplier: 1.5,
  normalReservePct: 0.1,
  normalReserveCapUsd: 2,
  // High win probability positions (≥85¢) need minimal reserves
  highWinProbPriceThreshold: 0.85,
  highWinProbReservePct: 0.02,
  highWinProbReserveCapUsd: 0.5,
};

// ============================================================
// TYPES
// ============================================================

/**
 * Risk mode indicating whether new BUY orders are allowed
 */
export type RiskMode = "RISK_ON" | "RISK_OFF";

/**
 * Per-position reserve breakdown for debugging
 */
export interface PositionReserve {
  tokenId: string;
  marketId: string;
  notionalUsd: number;
  pnlPct: number;
  tier: "NONE" | "HIGH_WIN_PROB" | "NORMAL" | "HEDGE" | "CATASTROPHIC";
  baseReserve: number;
  liquidityMultiplier: number;
  finalReserve: number;
  reason: string;
}

/**
 * Reserve plan computed from portfolio state
 */
export interface ReservePlan {
  /** Current risk mode */
  mode: RiskMode;

  /** Total reserve required in USD */
  reserveRequired: number;

  /** Base reserve portion in USD */
  baseReserve: number;

  /** Position-based reserve portion in USD */
  positionReserve: number;

  /** Available cash (USDC balance) */
  availableCash: number;

  /** Shortfall = max(0, reserveRequired - availableCash) */
  shortfall: number;

  /** Per-position reserve breakdown (top 5 for logging) */
  topPositionReserves: PositionReserve[];

  /** Equity (position value + cash) used for base reserve calc */
  equityUsd: number;

  /** Timestamp when plan was computed */
  computedAtMs: number;
}

/**
 * Result of BUY gate check
 */
export interface BuyGateResult {
  /** Whether the BUY order is allowed */
  allowed: boolean;

  /** Reason for the decision */
  reason: string;

  /** Current reserve required */
  reserveRequired: number;

  /** Available cash */
  availableCash: number;

  /** Current shortfall (0 if allowed) */
  shortfall: number;

  /** Current risk mode */
  mode: RiskMode;
}

/**
 * Wallet balances needed for reserve calculation
 */
export interface WalletBalances {
  /** USDC balance */
  usdcBalance: number;

  /** Gas token (POL/MATIC) balance - for future use */
  gasBalance?: number;

  /** Any locked/in-flight amounts to exclude */
  lockedUsd?: number;
}

// ============================================================
// DYNAMIC RESERVES CONTROLLER
// ============================================================

/**
 * Dynamic Reserves Controller
 *
 * Computes required reserves from portfolio state and gates BUY orders
 * when reserves are insufficient.
 */
export class DynamicReservesController {
  private config: DynamicReservesConfig;
  private logger: ConsoleLogger;
  private logDeduper = new LogDeduper();

  // State tracking
  private lastMode: RiskMode = "RISK_ON";
  private lastPlan: ReservePlan | null = null;
  private modeChangeCount = 0;

  // Log deduplication TTLs
  private static readonly MODE_CHANGE_LOG_TTL_MS = 60_000; // Log mode changes once per minute
  private static readonly SHORTFALL_LOG_TTL_MS = 30_000; // Log shortfall details every 30s
  private static readonly STATUS_LOG_TTL_MS = 60_000; // Log wallet balance and reserves once per minute

  constructor(config: Partial<DynamicReservesConfig>, logger: ConsoleLogger) {
    this.config = { ...DEFAULT_RESERVES_CONFIG, ...config };
    this.logger = logger;

    this.logger.info(
      `[DynamicReserves] Initialized: baseFloor=$${this.config.baseReserveFloorUsd}, ` +
        `maxReserve=$${this.config.maxReserveUsd}, hedgeCap=$${this.config.hedgeCapUsd}`,
    );
  }

  /**
   * Compute reserve plan from portfolio snapshot and wallet balances.
   * Call this once per orchestrator cycle.
   */
  computeReservePlan(
    snapshot: PortfolioSnapshot,
    balances: WalletBalances,
  ): ReservePlan {
    const computedAtMs = Date.now();

    // Calculate available cash
    const availableCash = Math.max(
      0,
      balances.usdcBalance - (balances.lockedUsd ?? 0),
    );

    // Calculate total position value (equity component)
    const positionValue = this.calculatePositionValue(snapshot.activePositions);
    const equityUsd = availableCash + positionValue;

    // A) Base reserve: max(floor, equityPct * equity)
    const baseReserve = Math.max(
      this.config.baseReserveFloorUsd,
      this.config.baseReserveEquityPct * equityUsd,
    );

    // B) Per-position reserves
    const positionReserves = this.computePositionReserves(
      snapshot.activePositions,
    );
    const totalPositionReserve = positionReserves.reduce(
      (sum, pr) => sum + pr.finalReserve,
      0,
    );

    // D) Total capped at max
    const reserveRequired = Math.min(
      baseReserve + totalPositionReserve,
      this.config.maxReserveUsd,
    );

    // Calculate shortfall
    const shortfall = Math.max(0, reserveRequired - availableCash);

    // Determine mode
    const mode: RiskMode = shortfall > 0 ? "RISK_OFF" : "RISK_ON";

    // Log mode changes (rate-limited)
    if (mode !== this.lastMode) {
      this.modeChangeCount++;
      if (
        this.logDeduper.shouldLog(
          "DynamicReserves:mode_change",
          DynamicReservesController.MODE_CHANGE_LOG_TTL_MS,
        )
      ) {
        this.logger.warn(
          `[DynamicReserves] mode=${this.lastMode}->${mode} shortfall=$${shortfall.toFixed(2)} ` +
            `reserveRequired=$${reserveRequired.toFixed(2)} available=$${availableCash.toFixed(2)}`,
        );
      }
    }

    // Log shortfall details when in RISK_OFF (rate-limited)
    if (
      mode === "RISK_OFF" &&
      this.logDeduper.shouldLog(
        "DynamicReserves:shortfall",
        DynamicReservesController.SHORTFALL_LOG_TTL_MS,
      )
    ) {
      const topReserves = positionReserves
        .sort((a, b) => b.finalReserve - a.finalReserve)
        .slice(0, 5);

      this.logger.info(
        `[DynamicReserves] RISK_OFF: Top reserve consumers: ${topReserves
          .map(
            (r) =>
              `${r.tokenId.slice(0, 8)}...(${r.tier},$${r.notionalUsd.toFixed(1)},${r.pnlPct.toFixed(1)}%)->$${r.finalReserve.toFixed(2)}`,
          )
          .join(", ")}`,
      );
    }

    // Log wallet balance and reserves status (rate-limited, INFO level for visibility)
    if (
      this.logDeduper.shouldLog(
        "DynamicReserves:status",
        DynamicReservesController.STATUS_LOG_TTL_MS,
      )
    ) {
      this.logger.info(
        `[DynamicReserves] balance=$${availableCash.toFixed(2)} reserves=$${reserveRequired.toFixed(2)} ` +
          `mode=${mode} equity=$${equityUsd.toFixed(2)} positions=${snapshot.activePositions.length}`,
      );
    }

    this.lastMode = mode;
    this.lastPlan = {
      mode,
      reserveRequired,
      baseReserve,
      positionReserve: totalPositionReserve,
      availableCash,
      shortfall,
      topPositionReserves: positionReserves
        .sort((a, b) => b.finalReserve - a.finalReserve)
        .slice(0, 5),
      equityUsd,
      computedAtMs,
    };

    return this.lastPlan;
  }

  /**
   * Check if a new BUY order is allowed based on current reserve state.
   * Call this at order submission time as a final gate.
   *
   * @param plan Optional pre-computed plan. If not provided, uses lastPlan.
   */
  canOpenNewBuy(plan?: ReservePlan): BuyGateResult {
    // Use provided plan or fall back to last computed plan
    const activePlan = plan ?? this.lastPlan;

    // If no plan available or disabled, allow by default
    if (!this.config.enabled || !activePlan) {
      return {
        allowed: true,
        reason: this.config.enabled ? "NO_PLAN_AVAILABLE" : "RESERVES_DISABLED",
        reserveRequired: 0,
        availableCash: 0,
        shortfall: 0,
        mode: "RISK_ON",
      };
    }

    // Check mode
    if (activePlan.mode === "RISK_OFF") {
      return {
        allowed: false,
        reason: "RISK_OFF_RESERVE_SHORTFALL",
        reserveRequired: activePlan.reserveRequired,
        availableCash: activePlan.availableCash,
        shortfall: activePlan.shortfall,
        mode: "RISK_OFF",
      };
    }

    return {
      allowed: true,
      reason: "RISK_ON",
      reserveRequired: activePlan.reserveRequired,
      availableCash: activePlan.availableCash,
      shortfall: 0,
      mode: "RISK_ON",
    };
  }

  /**
   * Get the last computed reserve plan (for external access)
   */
  getLastPlan(): ReservePlan | null {
    return this.lastPlan;
  }

  /**
   * Get current risk mode
   */
  getCurrentMode(): RiskMode {
    return this.lastPlan?.mode ?? "RISK_ON";
  }

  /**
   * Get controller statistics
   */
  getStats(): {
    enabled: boolean;
    currentMode: RiskMode;
    modeChangeCount: number;
    lastPlanAge: number | null;
  } {
    return {
      enabled: this.config.enabled,
      currentMode: this.getCurrentMode(),
      modeChangeCount: this.modeChangeCount,
      lastPlanAge: this.lastPlan
        ? Date.now() - this.lastPlan.computedAtMs
        : null,
    };
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Calculate total position value from active positions
   */
  private calculatePositionValue(positions: readonly Position[]): number {
    return positions.reduce((sum, pos) => {
      // Use currentPrice * size as notional value
      const notional = pos.currentPrice * pos.size;
      return sum + notional;
    }, 0);
  }

  /**
   * Compute per-position reserves based on P&L tier, win probability, and liquidity
   */
  private computePositionReserves(
    positions: readonly Position[],
  ): PositionReserve[] {
    return positions.map((pos) => {
      const notionalUsd = pos.currentPrice * pos.size;
      const pnlPct = pos.pnlPct;

      // Skip redeemable or near-resolution positions (no reserve needed)
      if (pos.redeemable || pos.nearResolutionCandidate) {
        return {
          tokenId: pos.tokenId,
          marketId: pos.marketId,
          notionalUsd,
          pnlPct,
          tier: "NONE" as const,
          baseReserve: 0,
          liquidityMultiplier: 1,
          finalReserve: 0,
          reason: pos.redeemable ? "REDEEMABLE" : "NEAR_RESOLUTION",
        };
      }

      // Determine tier and base reserve
      let tier: "HIGH_WIN_PROB" | "NORMAL" | "HEDGE" | "CATASTROPHIC";
      let baseReserve: number;
      let reason: string;

      // pnlPct is negative for losses (e.g., -25 means 25% loss)
      // Convert to absolute value for clearer threshold comparisons
      const lossPct = Math.abs(Math.min(0, pnlPct)); // Only count losses (pnlPct <= 0)

      // HIGH WIN PROBABILITY CHECK (takes precedence over loss tiers)
      // When current price is high (e.g., ≥85¢), the probability of winning is high,
      // so we need minimal reserves regardless of entry price or P&L.
      // This reflects the reduced risk of positions likely to resolve in our favor.
      if (pos.currentPrice >= this.config.highWinProbPriceThreshold) {
        tier = "HIGH_WIN_PROB";
        baseReserve = Math.min(
          this.config.highWinProbReserveCapUsd,
          notionalUsd * this.config.highWinProbReservePct,
        );
        reason = `HIGH_WIN_PROB_${(pos.currentPrice * 100).toFixed(0)}¢`;
      } else if (lossPct >= this.config.catastrophicLossPct) {
        // Catastrophic loss tier: assume worst-case hedge attempt
        tier = "CATASTROPHIC";
        baseReserve = Math.min(this.config.hedgeCapUsd, notionalUsd * 1.0);
        reason = `CATASTROPHIC_LOSS_${lossPct.toFixed(0)}%`;
      } else if (lossPct >= this.config.hedgeTriggerLossPct) {
        // Hedge trigger tier: 50% of notional
        tier = "HEDGE";
        baseReserve = Math.min(this.config.hedgeCapUsd, notionalUsd * 0.5);
        reason = `HEDGE_TIER_${lossPct.toFixed(0)}%`;
      } else {
        // Normal tier: small buffer for volatility
        tier = "NORMAL";
        baseReserve = Math.min(
          this.config.normalReserveCapUsd,
          notionalUsd * this.config.normalReservePct,
        );
        reason = "NORMAL_BUFFER";
      }

      // Liquidity penalty: positions that can't be easily exited on CLOB require higher reserves
      // Check both executionStatus (primary) and bookStatus (fallback) for robustness
      // since executionStatus may not always be populated by all callers
      const isIlliquid =
        pos.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
        pos.bookStatus === "NO_BOOK_404" ||
        pos.bookStatus === "EMPTY_BOOK";

      const liquidityMultiplier = isIlliquid
        ? this.config.illiquidityMultiplier
        : 1;

      if (isIlliquid) {
        reason += `_ILLIQUID`;
      }

      const finalReserve = baseReserve * liquidityMultiplier;

      return {
        tokenId: pos.tokenId,
        marketId: pos.marketId,
        notionalUsd,
        pnlPct,
        tier,
        baseReserve,
        liquidityMultiplier,
        finalReserve,
        reason,
      };
    });
  }
}

/**
 * Create a DynamicReservesController from partial config
 */
export function createDynamicReservesController(
  logger: ConsoleLogger,
  config?: Partial<DynamicReservesConfig>,
): DynamicReservesController {
  return new DynamicReservesController(config ?? {}, logger);
}
