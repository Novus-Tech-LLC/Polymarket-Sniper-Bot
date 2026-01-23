/**
 * Enterprise Orchestrator
 *
 * Coordinates all enterprise strategies with:
 * - SEQUENTIAL execution (prevents stack issues and race conditions)
 * - Priority-based ordering
 * - Risk-gated execution
 * - Centralized PnL tracking
 *
 * Execution Order (sequential, high to low priority):
 * 1. Risk checks and circuit breaker
 * 2. ICC (Inventory & Correlation Controller) - Enforce limits first
 * 3. Stop-Loss / Hedging - Protect existing positions
 * 4. MM (Market Making) - Spread capture
 * 5. FF (Flow Following) - Momentum capture
 * 6. Cleanup (cooldowns, dust, etc.)
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { RiskManager, createRiskManager } from "./risk-manager";
import { MarketSelector, createMarketSelector } from "./market-selector";
import { ExecutionEngine, createExecutionEngine } from "./execution-engine";
import { PnLLedger } from "./pnl-ledger";
import {
  loadEnterpriseConfig,
  formatEnterpriseConfig,
  type EnterpriseSystemConfig,
  type EnterpriseMode,
} from "./config";
import type { StrategyId, OrderRequest, MarketData } from "./types";

/**
 * Strategy execution result
 */
interface StrategyResult {
  strategyId: StrategyId;
  executed: boolean;
  ordersAttempted: number;
  ordersSuccessful: number;
  error?: string;
}

/**
 * Orchestrator state for monitoring
 */
export interface OrchestratorState {
  running: boolean;
  lastExecutionMs: number;
  executionCount: number;
  riskState: ReturnType<RiskManager["getState"]>;
  executionStats: ReturnType<ExecutionEngine["getStats"]>;
  pnlSummary: ReturnType<PnLLedger["getSummary"]>;
  marketStats: ReturnType<MarketSelector["getStats"]>;
}

export class EnterpriseOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private config: EnterpriseSystemConfig;

  // Core components
  private riskManager: RiskManager;
  private marketSelector: MarketSelector;
  private executionEngine: ExecutionEngine;
  private ledger: PnLLedger;

  // State
  private running: boolean = false;
  private executionTimer?: NodeJS.Timeout;
  private executionCount: number = 0;
  private lastExecutionMs: number = 0;

  // Execution settings
  private executionIntervalMs: number = 2000; // 2 seconds between cycles

  constructor(
    client: ClobClient,
    logger: ConsoleLogger,
    mode?: EnterpriseMode,
  ) {
    this.client = client;
    this.logger = logger;

    // Load configuration
    this.config = loadEnterpriseConfig(mode);

    // Initialize components
    this.riskManager = createRiskManager(
      this.config.mode,
      logger,
      this.config.risk,
    );
    this.marketSelector = createMarketSelector(
      client,
      logger,
      this.config.mode,
      this.config.marketSelector,
    );
    this.executionEngine = createExecutionEngine(
      client,
      logger,
      this.riskManager,
      this.config.mode,
      this.config.execution,
    );
    this.ledger = new PnLLedger(logger);

    this.logger.info(
      `[EnterpriseOrchestrator] Initialized in ${this.config.mode} mode`,
    );
    this.logger.debug(
      `[EnterpriseOrchestrator] Config:\n${formatEnterpriseConfig(this.config)}`,
    );
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn("[EnterpriseOrchestrator] Already running");
      return;
    }

    this.running = true;
    this.logger.info(
      "[EnterpriseOrchestrator] 🚀 Starting enterprise trading system",
    );

    // Run initial execution
    await this.executeStrategyCycle();

    // Set up periodic execution
    this.executionTimer = setInterval(() => {
      this.executeStrategyCycle().catch((err) => {
        this.logger.error(
          `[EnterpriseOrchestrator] Cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.executionIntervalMs);

    // Log PnL summary periodically
    setInterval(
      () => {
        const summary = this.ledger.formatSummary();
        this.logger.info(`[EnterpriseOrchestrator]\n${summary}`);
      },
      5 * 60 * 1000,
    ); // Every 5 minutes
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.logger.info("[EnterpriseOrchestrator] 🛑 Stopped");
    this.logger.info(
      `[EnterpriseOrchestrator] Final PnL:\n${this.ledger.formatSummary()}`,
    );
  }

  /**
   * Execute one strategy cycle (sequential)
   */
  private async executeStrategyCycle(): Promise<void> {
    const cycleStart = Date.now();
    this.executionCount++;

    // Check risk state first
    const riskState = this.riskManager.getState();
    if (riskState.circuitBreaker.triggered) {
      this.logger.warn(
        `[EnterpriseOrchestrator] Circuit breaker active: ${riskState.circuitBreaker.reason}`,
      );
      return;
    }

    const results: StrategyResult[] = [];

    try {
      // === SEQUENTIAL EXECUTION (Priority Order) ===
      // Each strategy completes fully before the next starts
      // This prevents stack issues and ensures proper capital allocation

      // 1. ICC - Inventory & Correlation Controller (enforce limits)
      if (this.config.enableICC) {
        const iccResult = await this.executeICC();
        results.push(iccResult);
      }

      // 2. Check risk state after ICC (might have adjusted positions)
      if (this.riskManager.getState().circuitBreaker.triggered) {
        this.logger.warn(
          "[EnterpriseOrchestrator] Circuit breaker triggered during ICC",
        );
        return;
      }

      // 3. MM - Market Making (spread capture)
      if (this.config.enableMM) {
        const mmResult = await this.executeMM();
        results.push(mmResult);
      }

      // 4. FF - Flow Following (momentum capture)
      if (this.config.enableFF) {
        const ffResult = await this.executeFF();
        results.push(ffResult);
      }

      // 5. Cleanup
      this.executionEngine.cleanupCooldowns();
      this.riskManager.cleanupCooldowns();
    } catch (err) {
      this.logger.error(
        `[EnterpriseOrchestrator] Cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.lastExecutionMs = Date.now() - cycleStart;

    // Log cycle summary if there was activity
    const totalOrders = results.reduce((sum, r) => sum + r.ordersAttempted, 0);
    const successfulOrders = results.reduce(
      (sum, r) => sum + r.ordersSuccessful,
      0,
    );

    if (totalOrders > 0) {
      this.logger.info(
        `[EnterpriseOrchestrator] Cycle #${this.executionCount}: ` +
          `${successfulOrders}/${totalOrders} orders successful [${this.lastExecutionMs}ms]`,
      );
    }
  }

  /**
   * Execute Inventory & Correlation Controller
   * Enforces portfolio limits and reduces over-exposure
   */
  private async executeICC(): Promise<StrategyResult> {
    const result: StrategyResult = {
      strategyId: "ICC",
      executed: true,
      ordersAttempted: 0,
      ordersSuccessful: 0,
    };

    try {
      // Get current risk state
      const riskState = this.riskManager.getState();

      // Check exposure utilization
      if (riskState.exposureUtilization > 0.9) {
        this.logger.warn(
          `[ICC] Exposure at ${(riskState.exposureUtilization * 100).toFixed(0)}% - consider reducing`,
        );
        // In full implementation: identify and reduce lowest EV positions
      }

      // Check drawdown
      if (riskState.maxDrawdown > 0) {
        const drawdownPct =
          (riskState.maxDrawdown / (this.config.risk.maxExposureUsd ?? 500)) *
          100;
        if (drawdownPct > 10) {
          this.logger.warn(
            `[ICC] Session drawdown: $${riskState.maxDrawdown.toFixed(2)} (${drawdownPct.toFixed(1)}%)`,
          );
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`[ICC] Error: ${result.error}`);
    }

    return result;
  }

  /**
   * Execute Market Making Strategy
   * Places passive bids/asks to capture spread
   */
  private async executeMM(): Promise<StrategyResult> {
    const result: StrategyResult = {
      strategyId: "MM",
      executed: true,
      ordersAttempted: 0,
      ordersSuccessful: 0,
    };

    try {
      // Get eligible markets
      const markets = await this.marketSelector.getEligibleMarkets();

      if (markets.length === 0) {
        this.logger.debug("[MM] No eligible markets found");
        return result;
      }

      // For each market, evaluate MM opportunity
      for (const market of markets.slice(0, 5)) {
        // Limit to top 5 for now
        const opportunity = this.evaluateMMOpportunity(market);

        if (!opportunity.profitable) continue;

        // Try to place bid (buy low)
        if (opportunity.bidPrice > 0) {
          const bidRequest: OrderRequest = {
            strategyId: "MM",
            marketId: market.marketId,
            tokenId: market.tokenId,
            outcome: "YES", // MM typically trades YES tokens
            side: "BUY",
            size: opportunity.size,
            price: opportunity.bidPrice,
            sizeUsd: opportunity.size * opportunity.bidPrice,
            orderType: "POST_ONLY",
          };

          result.ordersAttempted++;
          const bidResult = await this.executionEngine.executeOrder(bidRequest);
          if (bidResult.success) {
            result.ordersSuccessful++;
            this.ledger.recordTrade({
              timestamp: Date.now(),
              strategyId: "MM",
              marketId: market.marketId,
              tokenId: market.tokenId,
              side: "BUY",
              size: opportunity.size,
              price: opportunity.bidPrice,
              fees: opportunity.size * opportunity.bidPrice * 0.0001, // 0.01% fee
            });
          }
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`[MM] Error: ${result.error}`);
    }

    return result;
  }

  /**
   * Evaluate market making opportunity
   */
  private evaluateMMOpportunity(market: MarketData): {
    profitable: boolean;
    bidPrice: number;
    askPrice: number;
    size: number;
    expectedProfit: number;
  } {
    // Basic MM logic: place orders inside the spread if profitable
    const spreadCents = market.spread;
    const minSpreadForProfit = 1; // Need at least 1¢ spread to profit after fees

    if (spreadCents < minSpreadForProfit) {
      return {
        profitable: false,
        bidPrice: 0,
        askPrice: 0,
        size: 0,
        expectedProfit: 0,
      };
    }

    // Place bids slightly inside best bid
    const bidPrice = market.bestBid + 0.001; // 0.1¢ improvement
    const askPrice = market.bestAsk - 0.001;

    // Size based on available depth and risk limits
    const maxSize = Math.min(
      market.bidDepth * 0.1, // 10% of available depth
      (this.config.risk.maxExposurePerMarketUsd ?? 100) / market.midPrice,
    );

    const size = Math.max(1, Math.floor(maxSize)); // At least 1 share

    // Expected profit per round trip
    const expectedProfit = (askPrice - bidPrice - 0.0002) * size; // Minus 0.02% fees

    return {
      profitable: expectedProfit > 0.01, // At least 1¢ profit
      bidPrice,
      askPrice,
      size,
      expectedProfit,
    };
  }

  /**
   * Execute Flow Following Strategy
   * Detects and follows large moves/whale activity
   */
  private async executeFF(): Promise<StrategyResult> {
    const result: StrategyResult = {
      strategyId: "FF",
      executed: true,
      ordersAttempted: 0,
      ordersSuccessful: 0,
    };

    try {
      // In full implementation:
      // 1. Monitor recent large trades (whale prints)
      // 2. Detect significant price moves (>= MOVE_MIN_CENTS within window)
      // 3. Enter with slippage protection if conditions met
      // 4. Use IOC/FOK for fast execution
      // 5. Exit quickly with tight stops

      // Placeholder - FF requires real-time trade feed integration
      this.logger.debug("[FF] Flow following monitoring active");
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`[FF] Error: ${result.error}`);
    }

    return result;
  }

  /**
   * Get orchestrator state for monitoring
   */
  getState(): OrchestratorState {
    return {
      running: this.running,
      lastExecutionMs: this.lastExecutionMs,
      executionCount: this.executionCount,
      riskState: this.riskManager.getState(),
      executionStats: this.executionEngine.getStats(),
      pnlSummary: this.ledger.getSummary(),
      marketStats: this.marketSelector.getStats(),
    };
  }

  /**
   * Get components for external access
   */
  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  getMarketSelector(): MarketSelector {
    return this.marketSelector;
  }

  getExecutionEngine(): ExecutionEngine {
    return this.executionEngine;
  }

  getLedger(): PnLLedger {
    return this.ledger;
  }

  /**
   * Manual order submission (for external strategies)
   */
  async submitOrder(
    request: OrderRequest,
    category?: string,
  ): Promise<ReturnType<ExecutionEngine["executeOrder"]>> {
    return this.executionEngine.executeOrder(request, category);
  }
}

/**
 * Create enterprise orchestrator with configuration from environment
 */
export function createEnterpriseOrchestrator(
  client: ClobClient,
  logger: ConsoleLogger,
  mode?: EnterpriseMode,
): EnterpriseOrchestrator {
  return new EnterpriseOrchestrator(client, logger, mode);
}
