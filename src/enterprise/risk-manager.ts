/**
 * Risk Manager - Enterprise Grade Risk Engine
 *
 * Centralized risk management with:
 * - Portfolio exposure limits (total, per-market, per-category)
 * - Circuit breakers (consecutive rejects, API health, drawdown)
 * - Cooldown awareness and caching
 * - Kill switch support
 * - 3-layer stop logic (local, volatility, portfolio)
 *
 * All orders MUST pass through RiskManager.evaluate() before execution.
 */

import * as fs from "fs";
import type { ConsoleLogger } from "../utils/logger.util";
import type {
  RiskDecision,
  OrderRequest,
  CircuitBreakerState,
  CooldownEntry,
  StrategyId,
} from "./types";

/**
 * Risk Manager Configuration
 * Sensible defaults built-in - only override what you need
 */
export interface RiskManagerConfig {
  // === Exposure Limits ===
  /** Max total portfolio exposure in USD (default: $500) */
  maxExposureUsd?: number;
  /** Max exposure per single market in USD (default: $100) */
  maxExposurePerMarketUsd?: number;
  /** Max exposure per category in USD (default: $200) */
  maxExposurePerCategoryUsd?: number;

  // === Drawdown Protection ===
  /** Max drawdown % before kill switch (default: 20%) */
  maxDrawdownPct?: number;
  /** Session starting balance for drawdown calc */
  sessionStartBalanceUsd?: number;

  // === Circuit Breakers ===
  /** Consecutive order rejects before pause (default: 5) */
  maxConsecutiveRejects?: number;
  /** Consecutive API errors before pause (default: 3) */
  maxConsecutiveApiErrors?: number;
  /** Seconds API can be unhealthy before pause (default: 60) */
  maxApiUnhealthySeconds?: number;
  /** Circuit breaker cooldown in seconds (default: 300) */
  circuitBreakerCooldownSeconds?: number;

  // === Order Constraints ===
  /** Minimum order size in USD (default: $1) */
  minOrderUsd?: number;
  /** Dust threshold - positions below this are ignored (default: $0.50) */
  dustThresholdUsd?: number;
  /** Max slippage in cents (default: 2¢) */
  maxSlippageCents?: number;

  // === Kill Switch ===
  /** File path - if exists, all trading stops */
  killSwitchFile?: string;

  // === Logging ===
  /** Log all risk decisions (default: false, set LOG_LEVEL=debug) */
  verboseLogging?: boolean;
}

/**
 * Default configuration values
 * Conservative but functional out of the box
 */
const DEFAULT_CONFIG: Required<RiskManagerConfig> = {
  maxExposureUsd: 500,
  maxExposurePerMarketUsd: 100,
  maxExposurePerCategoryUsd: 200,
  maxDrawdownPct: 20,
  sessionStartBalanceUsd: 0,
  maxConsecutiveRejects: 5,
  maxConsecutiveApiErrors: 3,
  maxApiUnhealthySeconds: 60,
  circuitBreakerCooldownSeconds: 300,
  minOrderUsd: 1,
  dustThresholdUsd: 0.5,
  maxSlippageCents: 2,
  killSwitchFile: "",
  verboseLogging: false,
};

export class RiskManager {
  private config: Required<RiskManagerConfig>;
  private logger: ConsoleLogger;

  // State tracking
  private circuitBreaker: CircuitBreakerState = {
    triggered: false,
    consecutiveRejects: 0,
    consecutiveApiErrors: 0,
  };

  // Exposure tracking
  private exposureByMarket: Map<string, number> = new Map();
  private exposureByCategory: Map<string, number> = new Map();
  private exposureByStrategy: Map<StrategyId, number> = new Map();
  private totalExposure: number = 0;

  // Cooldown cache
  private cooldownCache: Map<string, CooldownEntry> = new Map();

  // PnL tracking
  private sessionPnl: number = 0;
  private maxSessionDrawdown: number = 0;

  // API health
  private lastApiHealthy: number = Date.now();
  private apiHealthy: boolean = true;

  constructor(config: RiskManagerConfig, logger: ConsoleLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;

    this.logger.info(
      `[RiskManager] Initialized: maxExposure=$${this.config.maxExposureUsd}, ` +
        `maxPerMarket=$${this.config.maxExposurePerMarketUsd}, ` +
        `maxDrawdown=${this.config.maxDrawdownPct}%`,
    );
  }

  /**
   * Evaluate an order request against all risk rules
   * Returns approval decision with reason
   */
  evaluate(request: OrderRequest, category?: string): RiskDecision {
    const warnings: string[] = [];

    // 1. Kill switch check
    if (this.isKillSwitchActive()) {
      return {
        approved: false,
        reason: "KILL_SWITCH_ACTIVE",
      };
    }

    // 2. Circuit breaker check
    if (this.circuitBreaker.triggered) {
      if (this.shouldResetCircuitBreaker()) {
        this.resetCircuitBreaker();
      } else {
        return {
          approved: false,
          reason: `CIRCUIT_BREAKER: ${this.circuitBreaker.reason}`,
        };
      }
    }

    // 3. Cooldown check for this token
    const cooldown = this.cooldownCache.get(request.tokenId);
    if (cooldown && Date.now() < cooldown.cooldownUntil) {
      return {
        approved: false,
        reason: `COOLDOWN_ACTIVE: ${cooldown.reason} until ${new Date(cooldown.cooldownUntil).toISOString()}`,
      };
    }

    // 4. Minimum order size
    if (request.sizeUsd < this.config.minOrderUsd) {
      return {
        approved: false,
        reason: `ORDER_TOO_SMALL: $${request.sizeUsd.toFixed(2)} < min $${this.config.minOrderUsd}`,
      };
    }

    // 5. Slippage check
    if (
      request.expectedSlippage !== undefined &&
      request.expectedSlippage > this.config.maxSlippageCents
    ) {
      return {
        approved: false,
        reason: `SLIPPAGE_TOO_HIGH: ${request.expectedSlippage}¢ > max ${this.config.maxSlippageCents}¢`,
      };
    }

    // 6. Total exposure check (only for BUY orders)
    if (request.side === "BUY") {
      const projectedExposure = this.totalExposure + request.sizeUsd;
      if (projectedExposure > this.config.maxExposureUsd) {
        // Try to reduce size
        const availableExposure =
          this.config.maxExposureUsd - this.totalExposure;
        if (availableExposure >= this.config.minOrderUsd) {
          warnings.push(
            `Reduced size from $${request.sizeUsd.toFixed(2)} to $${availableExposure.toFixed(2)} due to exposure limit`,
          );
          return {
            approved: true,
            reason: "APPROVED_REDUCED_SIZE",
            adjustedSize: availableExposure / request.price,
            warnings,
          };
        }
        return {
          approved: false,
          reason: `EXPOSURE_LIMIT: $${projectedExposure.toFixed(2)} > max $${this.config.maxExposureUsd}`,
        };
      }

      // 7. Per-market exposure check
      const currentMarketExposure =
        this.exposureByMarket.get(request.marketId) ?? 0;
      const projectedMarketExposure = currentMarketExposure + request.sizeUsd;
      if (projectedMarketExposure > this.config.maxExposurePerMarketUsd) {
        const availableMarket =
          this.config.maxExposurePerMarketUsd - currentMarketExposure;
        if (availableMarket >= this.config.minOrderUsd) {
          warnings.push(
            `Reduced size due to per-market limit: $${availableMarket.toFixed(2)}`,
          );
          return {
            approved: true,
            reason: "APPROVED_REDUCED_SIZE",
            adjustedSize: availableMarket / request.price,
            warnings,
          };
        }
        return {
          approved: false,
          reason: `MARKET_EXPOSURE_LIMIT: $${projectedMarketExposure.toFixed(2)} > max $${this.config.maxExposurePerMarketUsd}`,
        };
      }

      // 8. Per-category exposure check
      if (category) {
        const currentCategoryExposure =
          this.exposureByCategory.get(category) ?? 0;
        const projectedCategoryExposure =
          currentCategoryExposure + request.sizeUsd;
        if (projectedCategoryExposure > this.config.maxExposurePerCategoryUsd) {
          warnings.push(
            `Category ${category} exposure high: $${projectedCategoryExposure.toFixed(2)}`,
          );
          // Don't block, just warn - category limits are softer
        }
      }
    }

    // 9. Drawdown check
    if (this.config.sessionStartBalanceUsd > 0) {
      const drawdownPct =
        (Math.abs(Math.min(0, this.sessionPnl)) /
          this.config.sessionStartBalanceUsd) *
        100;
      if (drawdownPct >= this.config.maxDrawdownPct) {
        this.triggerCircuitBreaker("MAX_DRAWDOWN_EXCEEDED");
        return {
          approved: false,
          reason: `DRAWDOWN_LIMIT: ${drawdownPct.toFixed(1)}% >= max ${this.config.maxDrawdownPct}%`,
        };
      }
    }

    // All checks passed
    if (this.config.verboseLogging) {
      this.logger.debug(
        `[RiskManager] APPROVED: ${request.strategyId} ${request.side} ` +
          `$${request.sizeUsd.toFixed(2)} on ${request.marketId.slice(0, 8)}...`,
      );
    }

    return {
      approved: true,
      reason: "APPROVED",
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Record order result to update state
   */
  recordOrderResult(
    request: OrderRequest,
    success: boolean,
    rejectCode?: string,
    cooldownUntil?: number,
  ): void {
    if (success) {
      // Reset consecutive failures
      this.circuitBreaker.consecutiveRejects = 0;

      // Update exposure tracking for BUY orders
      if (request.side === "BUY") {
        this.totalExposure += request.sizeUsd;
        this.exposureByMarket.set(
          request.marketId,
          (this.exposureByMarket.get(request.marketId) ?? 0) + request.sizeUsd,
        );
        this.exposureByStrategy.set(
          request.strategyId,
          (this.exposureByStrategy.get(request.strategyId) ?? 0) +
            request.sizeUsd,
        );
      } else {
        // SELL reduces exposure
        this.totalExposure = Math.max(0, this.totalExposure - request.sizeUsd);
        const marketExp = this.exposureByMarket.get(request.marketId) ?? 0;
        this.exposureByMarket.set(
          request.marketId,
          Math.max(0, marketExp - request.sizeUsd),
        );
      }
    } else {
      // Track failure
      this.circuitBreaker.consecutiveRejects++;

      // Cache cooldown if provided
      if (cooldownUntil) {
        const existing = this.cooldownCache.get(request.tokenId);
        this.cooldownCache.set(request.tokenId, {
          tokenId: request.tokenId,
          cooldownUntil,
          reason: rejectCode ?? "UNKNOWN",
          attempts: (existing?.attempts ?? 0) + 1,
        });
        this.logger.warn(
          `[RiskManager] Cooldown cached for ${request.tokenId}: ${rejectCode} until ${new Date(cooldownUntil).toISOString()}`,
        );
      }

      // Check circuit breaker threshold
      if (
        this.circuitBreaker.consecutiveRejects >=
        this.config.maxConsecutiveRejects
      ) {
        this.triggerCircuitBreaker(
          `CONSECUTIVE_REJECTS: ${this.circuitBreaker.consecutiveRejects}`,
        );
      }
    }
  }

  /**
   * Record PnL change (from position close or realized gain/loss)
   */
  recordPnl(pnl: number): void {
    this.sessionPnl += pnl;
    if (this.sessionPnl < 0) {
      this.maxSessionDrawdown = Math.max(
        this.maxSessionDrawdown,
        Math.abs(this.sessionPnl),
      );
    }
  }

  /**
   * Update exposure directly (for position sync from tracker)
   */
  syncExposure(
    marketExposures: Map<string, number>,
    categoryExposures: Map<string, number>,
  ): void {
    this.exposureByMarket = new Map(marketExposures);
    this.exposureByCategory = new Map(categoryExposures);
    this.totalExposure = Array.from(marketExposures.values()).reduce(
      (sum, v) => sum + v,
      0,
    );
  }

  /**
   * Report API health status
   */
  reportApiHealth(healthy: boolean): void {
    if (healthy) {
      this.lastApiHealthy = Date.now();
      this.circuitBreaker.consecutiveApiErrors = 0;
      this.apiHealthy = true;
    } else {
      this.circuitBreaker.consecutiveApiErrors++;
      this.apiHealthy = false;

      // Check if unhealthy too long
      const unhealthyMs = Date.now() - this.lastApiHealthy;
      if (unhealthyMs > this.config.maxApiUnhealthySeconds * 1000) {
        this.triggerCircuitBreaker(
          `API_UNHEALTHY: ${(unhealthyMs / 1000).toFixed(0)}s`,
        );
      }

      // Check consecutive errors
      if (
        this.circuitBreaker.consecutiveApiErrors >=
        this.config.maxConsecutiveApiErrors
      ) {
        this.triggerCircuitBreaker(
          `API_ERRORS: ${this.circuitBreaker.consecutiveApiErrors} consecutive`,
        );
      }
    }
  }

  /**
   * Check if kill switch file exists
   */
  private isKillSwitchActive(): boolean {
    if (!this.config.killSwitchFile) return false;
    try {
      return fs.existsSync(this.config.killSwitchFile);
    } catch {
      return false;
    }
  }

  /**
   * Trigger circuit breaker
   */
  private triggerCircuitBreaker(reason: string): void {
    if (this.circuitBreaker.triggered) return;

    this.circuitBreaker.triggered = true;
    this.circuitBreaker.reason = reason;
    this.circuitBreaker.triggeredAt = Date.now();
    this.circuitBreaker.resumeAt =
      Date.now() + this.config.circuitBreakerCooldownSeconds * 1000;

    this.logger.error(
      `[RiskManager] 🚨 CIRCUIT BREAKER TRIGGERED: ${reason}. ` +
        `Resume at ${new Date(this.circuitBreaker.resumeAt).toISOString()}`,
    );
  }

  /**
   * Check if circuit breaker should auto-reset
   */
  private shouldResetCircuitBreaker(): boolean {
    if (!this.circuitBreaker.resumeAt) return false;
    return Date.now() >= this.circuitBreaker.resumeAt;
  }

  /**
   * Reset circuit breaker
   */
  private resetCircuitBreaker(): void {
    this.logger.info("[RiskManager] Circuit breaker reset");
    this.circuitBreaker = {
      triggered: false,
      consecutiveRejects: 0,
      consecutiveApiErrors: 0,
    };
  }

  /**
   * Manual circuit breaker reset (for operators)
   */
  forceResetCircuitBreaker(): void {
    this.resetCircuitBreaker();
  }

  /**
   * Get current risk state for monitoring
   */
  getState(): {
    circuitBreaker: CircuitBreakerState;
    totalExposure: number;
    exposureUtilization: number;
    sessionPnl: number;
    maxDrawdown: number;
    apiHealthy: boolean;
    activeCooldowns: number;
  } {
    return {
      circuitBreaker: { ...this.circuitBreaker },
      totalExposure: this.totalExposure,
      exposureUtilization: this.totalExposure / this.config.maxExposureUsd,
      sessionPnl: this.sessionPnl,
      maxDrawdown: this.maxSessionDrawdown,
      apiHealthy: this.apiHealthy,
      activeCooldowns: this.cooldownCache.size,
    };
  }

  /**
   * Clean up expired cooldowns
   */
  cleanupCooldowns(): void {
    const now = Date.now();
    for (const [tokenId, entry] of this.cooldownCache) {
      if (now >= entry.cooldownUntil) {
        this.cooldownCache.delete(tokenId);
      }
    }
  }
}

/**
 * Create RiskManager with preset-based configuration
 */
export function createRiskManager(
  preset: "conservative" | "balanced" | "aggressive",
  logger: ConsoleLogger,
  overrides?: Partial<RiskManagerConfig>,
): RiskManager {
  const presetConfigs: Record<string, Partial<RiskManagerConfig>> = {
    conservative: {
      maxExposureUsd: 200,
      maxExposurePerMarketUsd: 50,
      maxExposurePerCategoryUsd: 100,
      maxDrawdownPct: 10,
      maxSlippageCents: 1,
    },
    balanced: {
      maxExposureUsd: 500,
      maxExposurePerMarketUsd: 100,
      maxExposurePerCategoryUsd: 200,
      maxDrawdownPct: 15,
      maxSlippageCents: 2,
    },
    aggressive: {
      maxExposureUsd: 2000,
      maxExposurePerMarketUsd: 200,
      maxExposurePerCategoryUsd: 500,
      maxDrawdownPct: 25,
      maxSlippageCents: 3,
    },
  };

  const config = {
    ...presetConfigs[preset],
    ...overrides,
  };

  return new RiskManager(config, logger);
}
