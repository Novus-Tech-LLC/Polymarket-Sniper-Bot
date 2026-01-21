import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import { QuickFlipStrategy } from "./quick-flip";
import { AutoSellStrategy } from "./auto-sell";
import { EndgameSweepStrategy } from "./endgame-sweep";
import type { QuickFlipConfig } from "./quick-flip";
import type { AutoSellConfig } from "./auto-sell";
import type { EndgameSweepConfig } from "./endgame-sweep";

export interface StrategyOrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  arbEnabled: boolean;
  monitorEnabled: boolean;
  quickFlipConfig: QuickFlipConfig;
  autoSellConfig: AutoSellConfig;
  endgameSweepConfig: EndgameSweepConfig;
  executionIntervalMs?: number;
}

export interface StrategyOpportunity {
  priority: number;
  strategyName: string;
  description: string;
  expectedProfitPct?: number;
  execute: () => Promise<void>;
}

/**
 * Strategy Orchestrator
 * Executes strategies in priority order to maximize returns while managing risk
 * 
 * Priority Order:
 * 1. Risk-Free Arb (existing YES/NO < $1.00)
 * 2. Endgame Sweep (buy 98-99¢)
 * 3. Auto-Sell at 99¢ (free up capital)
 * 4. Quick Flip (sell at +5% gain)
 * 5. Whale Copy (existing monitor strategy)
 */
export class StrategyOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private quickFlipStrategy: QuickFlipStrategy;
  private autoSellStrategy: AutoSellStrategy;
  private endgameSweepStrategy: EndgameSweepStrategy;
  private arbEnabled: boolean;
  private monitorEnabled: boolean;
  private executionIntervalMs: number;
  private executionTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(config: StrategyOrchestratorConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.arbEnabled = config.arbEnabled;
    this.monitorEnabled = config.monitorEnabled;
    this.executionIntervalMs = config.executionIntervalMs ?? 60000; // 60 seconds default

    // Initialize position tracker
    this.positionTracker = new PositionTracker({
      client: config.client,
      logger: config.logger,
      refreshIntervalMs: 30000, // Refresh positions every 30 seconds
    });

    // Initialize strategies
    this.quickFlipStrategy = new QuickFlipStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: config.quickFlipConfig,
    });

    this.autoSellStrategy = new AutoSellStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: config.autoSellConfig,
    });

    this.endgameSweepStrategy = new EndgameSweepStrategy({
      client: config.client,
      logger: config.logger,
      config: config.endgameSweepConfig,
    });
  }

  /**
   * Start the strategy orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("[Orchestrator] Already running");
      return;
    }

    this.logger.info("[Orchestrator] Starting strategy orchestrator");
    this.isRunning = true;

    // Start position tracker
    await this.positionTracker.start();

    // Run initial execution
    await this.executeStrategies();

    // Set up periodic execution
    this.executionTimer = setInterval(() => {
      this.executeStrategies().catch((err) => {
        this.logger.error("[Orchestrator] Execution failed", err as Error);
      });
    }, this.executionIntervalMs);

    this.logger.info(
      `[Orchestrator] Started (execution interval: ${this.executionIntervalMs}ms)`
    );
  }

  /**
   * Stop the strategy orchestrator
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.logger.info("[Orchestrator] Stopping strategy orchestrator");
    
    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.positionTracker.stop();
    this.isRunning = false;

    this.logger.info("[Orchestrator] Stopped");
  }

  /**
   * Execute all strategies in priority order
   */
  private async executeStrategies(): Promise<void> {
    this.logger.debug("[Orchestrator] Executing strategies");

    try {
      // Priority 1: Risk-Free Arb (handled by existing arbitrage engine)
      // This runs continuously in its own loop
      if (this.arbEnabled) {
        this.logger.debug("[Orchestrator] ARB engine is active (Priority 1)");
      }

      // Priority 2: Endgame Sweep (buy 98-99¢)
      const endgameCount = await this.endgameSweepStrategy.execute();
      if (endgameCount > 0) {
        this.logger.info(
          `[Orchestrator] Priority 2: Endgame Sweep executed ${endgameCount} trades`
        );
      }

      // Priority 3: Auto-Sell at 99¢ (free up capital)
      const autoSellCount = await this.autoSellStrategy.execute();
      if (autoSellCount > 0) {
        this.logger.info(
          `[Orchestrator] Priority 3: Auto-Sell executed ${autoSellCount} trades`
        );
      }

      // Priority 4: Quick Flip (sell at +5% gain)
      const quickFlipCount = await this.quickFlipStrategy.execute();
      if (quickFlipCount > 0) {
        this.logger.info(
          `[Orchestrator] Priority 4: Quick Flip executed ${quickFlipCount} trades`
        );
      }

      // Priority 5: Whale Copy (handled by existing monitor service)
      // This runs continuously in its own loop
      if (this.monitorEnabled) {
        this.logger.debug("[Orchestrator] Monitor service is active (Priority 5)");
      }

      this.logger.debug("[Orchestrator] Strategy execution complete");
    } catch (err) {
      this.logger.error(
        "[Orchestrator] Error during strategy execution",
        err as Error
      );
    }
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    isRunning: boolean;
    arbEnabled: boolean;
    monitorEnabled: boolean;
    quickFlipStats: ReturnType<QuickFlipStrategy["getStats"]>;
    autoSellStats: ReturnType<AutoSellStrategy["getStats"]>;
    endgameSweepStats: ReturnType<EndgameSweepStrategy["getStats"]>;
    trackedPositions: number;
  } {
    return {
      isRunning: this.isRunning,
      arbEnabled: this.arbEnabled,
      monitorEnabled: this.monitorEnabled,
      quickFlipStats: this.quickFlipStrategy.getStats(),
      autoSellStats: this.autoSellStrategy.getStats(),
      endgameSweepStats: this.endgameSweepStrategy.getStats(),
      trackedPositions: this.positionTracker.getPositions().length,
    };
  }

  /**
   * Check if a trade should be executed based on orchestrator state
   * This can be called by ARB engine to check if it should proceed
   */
  canExecuteTrade(strategyName: string): boolean {
    // Always allow if orchestrator is not running
    if (!this.isRunning) {
      return true;
    }

    // ARB and MONITOR strategies can always execute
    // They run independently but are coordinated by priority
    if (strategyName === "arb" || strategyName === "monitor") {
      return true;
    }

    return false;
  }
}
