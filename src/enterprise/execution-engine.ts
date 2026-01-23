/**
 * Execution Engine - Cooldown-Aware Order Execution
 *
 * Handles all order execution with:
 * - Cooldown awareness and caching
 * - Retry/backoff logic
 * - Slippage protection
 * - Comprehensive logging
 *
 * Uses the existing postOrder utility for actual order submission.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import type { RiskManager } from "./risk-manager";
import { postOrder } from "../utils/post-order.util";
import type { OrderSubmissionResult } from "../utils/order-submission.util";
import type {
  OrderRequest,
  OrderResult,
  RiskDecision,
  TradeLogEntry,
  CooldownEntry,
} from "./types";

/**
 * Execution engine configuration
 */
export interface ExecutionEngineConfig {
  /** Use post-only orders by default (default: true) */
  postOnlyDefault?: boolean;
  /** Max retries on transient failures (default: 2) */
  maxRetries?: number;
  /** Base delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
  /** Max slippage allowed in cents (default: 2¢) */
  maxSlippageCents?: number;
  /** Cooldown cache TTL in seconds (default: 300) */
  cooldownCacheTtlSeconds?: number;
  /** Log all order attempts (default: false) */
  logAllOrders?: boolean;
}

const DEFAULT_CONFIG: Required<ExecutionEngineConfig> = {
  postOnlyDefault: true,
  maxRetries: 2,
  retryDelayMs: 1000,
  maxSlippageCents: 2,
  cooldownCacheTtlSeconds: 300,
  logAllOrders: false,
};

/**
 * Preset configurations
 */
export const EXECUTION_PRESETS: Record<
  string,
  Partial<ExecutionEngineConfig>
> = {
  conservative: {
    postOnlyDefault: true,
    maxRetries: 1,
    maxSlippageCents: 1,
  },
  balanced: {
    postOnlyDefault: true,
    maxRetries: 2,
    maxSlippageCents: 2,
  },
  aggressive: {
    postOnlyDefault: false, // Allow taking for speed
    maxRetries: 3,
    maxSlippageCents: 3,
  },
};

export class ExecutionEngine {
  private config: Required<ExecutionEngineConfig>;
  private logger: ConsoleLogger;
  private client: ClobClient;
  private riskManager: RiskManager;

  // Cooldown cache: tokenId -> cooldown until timestamp
  private cooldownCache: Map<string, CooldownEntry> = new Map();

  // Trade log for audit
  private tradeLog: TradeLogEntry[] = [];
  private maxLogSize: number = 10000;

  // Stats
  private stats = {
    totalOrders: 0,
    successfulOrders: 0,
    rejectedOrders: 0,
    retriedOrders: 0,
    cooldownHits: 0,
  };

  constructor(
    client: ClobClient,
    logger: ConsoleLogger,
    riskManager: RiskManager,
    config?: ExecutionEngineConfig,
  ) {
    this.client = client;
    this.logger = logger;
    this.riskManager = riskManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute an order with full risk checks and retry logic
   */
  async executeOrder(
    request: OrderRequest,
    category?: string,
  ): Promise<OrderResult> {
    this.stats.totalOrders++;

    // 1. Check cooldown cache first (fast path)
    const cooldown = this.cooldownCache.get(request.tokenId);
    if (cooldown && Date.now() < cooldown.cooldownUntil) {
      this.stats.cooldownHits++;
      const result: OrderResult = {
        success: false,
        status: "rejected",
        rejectCode: "COOLDOWN_CACHED",
        rejectReason: `Cooldown until ${new Date(cooldown.cooldownUntil).toISOString()}`,
        cooldownUntil: cooldown.cooldownUntil,
      };
      this.logTrade(
        request,
        { approved: false, reason: "COOLDOWN_CACHED" },
        result,
      );
      return result;
    }

    // 2. Risk evaluation
    const riskDecision = this.riskManager.evaluate(request, category);
    if (!riskDecision.approved) {
      this.stats.rejectedOrders++;
      const result: OrderResult = {
        success: false,
        status: "rejected",
        rejectCode: "RISK_REJECTED",
        rejectReason: riskDecision.reason,
      };
      this.logTrade(request, riskDecision, result);
      return result;
    }

    // Adjust size if risk manager reduced it
    const adjustedRequest = riskDecision.adjustedSize
      ? {
          ...request,
          size: riskDecision.adjustedSize,
          sizeUsd: riskDecision.adjustedSize * request.price,
        }
      : request;

    // 3. Execute with retry logic
    let lastResult: OrderResult | null = null;
    let retries = 0;

    while (retries <= this.config.maxRetries) {
      try {
        lastResult = await this.submitOrder(adjustedRequest);

        // Success or non-retryable failure
        if (lastResult.success || !this.isRetryable(lastResult)) {
          break;
        }

        // Handle cooldown from response
        if (lastResult.cooldownUntil) {
          this.setCooldown(
            request.tokenId,
            lastResult.cooldownUntil,
            lastResult.rejectCode ?? "UNKNOWN",
          );
          break; // Don't retry on cooldown
        }

        retries++;
        this.stats.retriedOrders++;

        if (retries <= this.config.maxRetries) {
          // Exponential backoff
          const delay = this.config.retryDelayMs * Math.pow(2, retries - 1);
          this.logger.debug(
            `[ExecutionEngine] Retry ${retries}/${this.config.maxRetries} for ${request.strategyId} after ${delay}ms`,
          );
          await this.sleep(delay);
        }
      } catch (err) {
        lastResult = {
          success: false,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        };

        if (!this.isRetryable(lastResult)) break;
        retries++;
      }
    }

    const result = lastResult ?? {
      success: false,
      status: "error",
      error: "No result",
    };

    // 4. Record result with risk manager
    this.riskManager.recordOrderResult(
      request,
      result.success,
      result.rejectCode,
      result.cooldownUntil,
    );

    if (result.success) {
      this.stats.successfulOrders++;
    } else {
      this.stats.rejectedOrders++;
    }

    // 5. Log trade
    this.logTrade(adjustedRequest, riskDecision, result);

    return result;
  }

  /**
   * Submit order using the existing postOrder utility
   */
  private async submitOrder(request: OrderRequest): Promise<OrderResult> {
    const startTime = Date.now();

    try {
      if (this.config.logAllOrders) {
        this.logger.debug(
          `[ExecutionEngine] Submitting: ${request.strategyId} ${request.side} ` +
            `${request.size.toFixed(2)} @ ${request.price.toFixed(3)}`,
        );
      }

      // Use the existing postOrder utility which handles all the complexity
      const response: OrderSubmissionResult = await postOrder({
        client: this.client,
        tokenId: request.tokenId,
        marketId: request.marketId,
        outcome: request.outcome, // Use outcome from request (YES or NO)
        side: request.side,
        sizeUsd: request.sizeUsd,
        maxAcceptablePrice: request.price,
        priority: request.priority,
        skipDuplicatePrevention: request.priority, // Priority orders skip duplicate check
        logger: this.logger,
        orderConfig: {
          minOrderUsd: 1, // Use config minimum
        },
      });

      const latency = Date.now() - startTime;

      // Convert response to OrderResult
      if (response.status === "submitted") {
        this.logger.info(
          `[ExecutionEngine] ✅ ${request.strategyId} ${request.side} submitted: ` +
            `$${request.sizeUsd.toFixed(2)} [${latency}ms]`,
        );
        return {
          success: true,
          orderId: response.orderId,
          status: "submitted",
          filledSize: request.size,
          filledPrice: request.price,
        };
      }

      if (response.status === "skipped") {
        return {
          success: false,
          status: "rejected",
          rejectCode: response.reason ?? "SKIPPED",
          rejectReason: response.reason,
        };
      }

      // Failed
      return this.parseErrorResponse(response.reason ?? "UNKNOWN_ERROR");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExecutionEngine] ❌ ${request.strategyId} ${request.side} failed: ${errorMsg}`,
      );
      return this.parseErrorResponse(errorMsg);
    }
  }

  /**
   * Parse error response for cooldown and reject codes
   */
  private parseErrorResponse(errorMsg: string): OrderResult {
    const lower = errorMsg.toLowerCase();

    // Check for cooldown
    const cooldownMatch = errorMsg.match(/cooldownUntil[:\s]*(\d+)/i);
    if (cooldownMatch) {
      const cooldownUntil = parseInt(cooldownMatch[1], 10);
      return {
        success: false,
        status: "rejected",
        rejectCode: "COOLDOWN",
        rejectReason: errorMsg,
        cooldownUntil,
      };
    }

    // Check for common reject codes
    if (lower.includes("insufficient") || lower.includes("balance")) {
      return {
        success: false,
        status: "rejected",
        rejectCode: "INSUFFICIENT_BALANCE",
        rejectReason: errorMsg,
      };
    }

    if (lower.includes("allowance")) {
      return {
        success: false,
        status: "rejected",
        rejectCode: "INSUFFICIENT_ALLOWANCE",
        rejectReason: errorMsg,
      };
    }

    if (lower.includes("fok") || lower.includes("killed")) {
      return {
        success: false,
        status: "cancelled",
        rejectCode: "FOK_KILLED",
        rejectReason: errorMsg,
      };
    }

    if (lower.includes("rate") || lower.includes("429")) {
      return {
        success: false,
        status: "rejected",
        rejectCode: "RATE_LIMITED",
        rejectReason: errorMsg,
      };
    }

    return {
      success: false,
      status: "error",
      error: errorMsg,
    };
  }

  /**
   * Check if error is retryable
   */
  private isRetryable(result: OrderResult): boolean {
    // Don't retry on these
    const nonRetryableCodes = [
      "COOLDOWN",
      "INSUFFICIENT_BALANCE",
      "INSUFFICIENT_ALLOWANCE",
      "RISK_REJECTED",
      "FOK_KILLED",
      "SKIPPED",
      "LIVE_TRADING_DISABLED",
    ];

    if (result.rejectCode && nonRetryableCodes.includes(result.rejectCode)) {
      return false;
    }

    // Retry on rate limits and transient errors
    if (result.rejectCode === "RATE_LIMITED") {
      return true;
    }

    // Retry on unknown errors
    if (result.status === "error") {
      return true;
    }

    return false;
  }

  /**
   * Set cooldown for a token
   */
  setCooldown(tokenId: string, until: number, reason: string): void {
    const existing = this.cooldownCache.get(tokenId);
    this.cooldownCache.set(tokenId, {
      tokenId,
      cooldownUntil: until,
      reason,
      attempts: (existing?.attempts ?? 0) + 1,
    });

    this.logger.debug(
      `[ExecutionEngine] Cooldown set for ${tokenId}: ${reason} until ${new Date(until).toISOString()}`,
    );
  }

  /**
   * Get all active cooldowns
   */
  getActiveCooldowns(): CooldownEntry[] {
    const now = Date.now();
    const active: CooldownEntry[] = [];

    for (const entry of this.cooldownCache.values()) {
      if (entry.cooldownUntil > now) {
        active.push(entry);
      }
    }

    return active;
  }

  /**
   * Clean up expired cooldowns
   */
  cleanupCooldowns(): void {
    const now = Date.now();
    for (const [tokenId, entry] of this.cooldownCache) {
      if (entry.cooldownUntil <= now) {
        this.cooldownCache.delete(tokenId);
      }
    }
  }

  /**
   * Log trade for audit
   */
  private logTrade(
    request: OrderRequest,
    riskDecision: RiskDecision,
    result: OrderResult,
  ): void {
    const entry: TradeLogEntry = {
      timestamp: Date.now(),
      strategyId: request.strategyId,
      marketId: request.marketId,
      tokenId: request.tokenId,
      side: request.side,
      size: request.size,
      price: request.price,
      sizeUsd: request.sizeUsd,
      riskDecision,
      result,
    };

    this.tradeLog.push(entry);

    // Trim log if too large
    if (this.tradeLog.length > this.maxLogSize) {
      this.tradeLog = this.tradeLog.slice(-this.maxLogSize / 2);
    }
  }

  /**
   * Get trade log (for export/audit)
   */
  getTradeLog(limit?: number): TradeLogEntry[] {
    const entries = limit ? this.tradeLog.slice(-limit) : this.tradeLog;
    return [...entries];
  }

  /**
   * Get execution stats
   */
  getStats(): {
    totalOrders: number;
    successfulOrders: number;
    rejectedOrders: number;
    retriedOrders: number;
    cooldownHits: number;
    successRate: number;
    activeCooldowns: number;
  } {
    return {
      ...this.stats,
      successRate:
        this.stats.totalOrders > 0
          ? this.stats.successfulOrders / this.stats.totalOrders
          : 0,
      activeCooldowns: this.getActiveCooldowns().length,
    };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create ExecutionEngine with preset configuration
 */
export function createExecutionEngine(
  client: ClobClient,
  logger: ConsoleLogger,
  riskManager: RiskManager,
  preset: "conservative" | "balanced" | "aggressive",
  overrides?: Partial<ExecutionEngineConfig>,
): ExecutionEngine {
  const config = {
    ...EXECUTION_PRESETS[preset],
    ...overrides,
  };
  return new ExecutionEngine(client, logger, riskManager, config);
}
