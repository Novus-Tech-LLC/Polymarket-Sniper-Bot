import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import { QuickFlipStrategy } from "./quick-flip";
import { AutoSellStrategy } from "./auto-sell";
import { EndgameSweepStrategy } from "./endgame-sweep";
import { AutoRedeemStrategy } from "./auto-redeem";
import {
  UniversalStopLossStrategy,
  type UniversalStopLossConfig,
} from "./universal-stop-loss";
import {
  SmartHedgingStrategy,
  type SmartHedgingConfig,
  DEFAULT_SMART_HEDGING_CONFIG,
} from "./smart-hedging";
import { getPerformanceTracker } from "./strategy-performance";
import type { QuickFlipConfig } from "./quick-flip";
import type { AutoSellConfig } from "./auto-sell";
import type { EndgameSweepConfig } from "./endgame-sweep";
import type { AutoRedeemConfig } from "./auto-redeem";
import {
  POSITION_TRACKER_REFRESH_INTERVAL_MS,
  STRATEGY_EXECUTION_INTERVAL_MS,
} from "./constants";

/**
 * Default Universal Stop-Loss configuration
 * Used when universalStopLossConfig is not provided to the orchestrator
 */
export const DEFAULT_UNIVERSAL_STOP_LOSS_CONFIG: UniversalStopLossConfig = {
  enabled: true,
  maxStopLossPct: 25, // Absolute ceiling - no position should lose more than 25%
  useDynamicTiers: true, // Use entry-price-based stop-loss tiers
};

export interface StrategyOrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  arbEnabled: boolean;
  monitorEnabled: boolean;
  quickFlipConfig: QuickFlipConfig;
  autoSellConfig: AutoSellConfig;
  endgameSweepConfig: EndgameSweepConfig;
  autoRedeemConfig: AutoRedeemConfig;
  universalStopLossConfig?: UniversalStopLossConfig;
  smartHedgingConfig?: SmartHedgingConfig;
  executionIntervalMs?: number;
}

/**
 * Strategy Orchestrator
 *
 * MULTI-STRATEGY SYSTEM - Runs ALL strategies in PARALLEL for maximum throughput
 *
 * As you compound money and positions grow, the system scales:
 * - All strategies execute concurrently (not sequentially)
 * - Position tracking refreshes every 5 seconds
 * - Strategy execution every 2 seconds
 * - Parallel sell execution for Quick Flip / Auto-Sell
 *
 * Strategy Priority (for capital allocation, but execution is parallel):
 * 1. Auto-Redeem - Claim resolved positions (capital recovery)
 * 2. Risk-Free Arb - YES + NO < $1.00 (runs in ARB engine loop)
 * 3. Endgame Sweep - Buy 75-92¢ positions (scalping range)
 * 4. Auto-Sell - Sell at threshold (free up capital)
 * 5. Quick Flip - Take profits at target %
 * 6. Whale Copy - Follow whale trades (runs in Monitor loop)
 *
 * The ARB engine and Monitor service run in their own continuous loops
 * alongside this orchestrator for maximum parallelism.
 */
export class StrategyOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private universalStopLossStrategy: UniversalStopLossStrategy;
  private smartHedgingStrategy: SmartHedgingStrategy;
  private quickFlipStrategy: QuickFlipStrategy;
  private autoSellStrategy: AutoSellStrategy;
  private endgameSweepStrategy: EndgameSweepStrategy;
  private autoRedeemStrategy: AutoRedeemStrategy;
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
    this.executionIntervalMs =
      config.executionIntervalMs ?? STRATEGY_EXECUTION_INTERVAL_MS;

    // Initialize position tracker
    this.positionTracker = new PositionTracker({
      client: config.client,
      logger: config.logger,
      refreshIntervalMs: POSITION_TRACKER_REFRESH_INTERVAL_MS,
    });

    // Initialize Smart Hedging FIRST (so we know if it's enabled for stop-loss config)
    const smartHedgingConfig =
      config.smartHedgingConfig ?? DEFAULT_SMART_HEDGING_CONFIG;
    this.smartHedgingStrategy = new SmartHedgingStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: smartHedgingConfig,
    });

    if (smartHedgingConfig.enabled) {
      this.logger.info(
        `[Orchestrator] 🛡️ Smart Hedging: ENABLED (trigger: -${smartHedgingConfig.triggerLossPct}%, max hedge: $${smartHedgingConfig.maxHedgeUsd}, reserve: ${smartHedgingConfig.reservePct}%)`,
      );
    }

    // Initialize Universal Stop-Loss (SAFETY NET - runs on higher-tier positions)
    // When smart hedging is enabled, skip risky tier positions (they'll be hedged instead)
    const universalStopLossConfig =
      config.universalStopLossConfig ?? DEFAULT_UNIVERSAL_STOP_LOSS_CONFIG;
    
    // Auto-configure: skip risky tier if smart hedging is enabled
    const stopLossConfigWithHedging = {
      ...universalStopLossConfig,
      skipRiskyTierForHedging: smartHedgingConfig.enabled,
    };

    this.universalStopLossStrategy = new UniversalStopLossStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: stopLossConfigWithHedging,
    });

    if (universalStopLossConfig.enabled) {
      const hedgingNote = smartHedgingConfig.enabled 
        ? " (risky tier → smart hedging)" 
        : "";
      this.logger.info(
        `[Orchestrator] 🛡️ Universal Stop-Loss: ENABLED (max: ${universalStopLossConfig.maxStopLossPct}%, dynamic tiers: ${universalStopLossConfig.useDynamicTiers ? "ON" : "OFF"})${hedgingNote}`,
      );
    }

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

    // Log safety warning about position sizing
    if (config.endgameSweepConfig.enabled) {
      const maxPos = config.endgameSweepConfig.maxPositionUsd;
      if (maxPos > 50) {
        this.logger.warn(
          `⚠️  MAX_POSITION_USD is set to $${maxPos} - this is VERY HIGH and may deplete your wallet quickly!`,
        );
      }
      this.logger.info(
        `[Orchestrator] Endgame Sweep: Max $${maxPos} per position (can buy multiple positions simultaneously)`,
      );
    }

    this.endgameSweepStrategy = new EndgameSweepStrategy({
      client: config.client,
      logger: config.logger,
      config: config.endgameSweepConfig,
      positionTracker: this.positionTracker, // Pass position tracker to check existing positions
    });

    // Initialize auto-redeem strategy (claims resolved positions)
    this.autoRedeemStrategy = new AutoRedeemStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: config.autoRedeemConfig,
    });

    if (config.autoRedeemConfig.enabled) {
      this.logger.info(
        `[Orchestrator] Auto-Redeem: Enabled (min position: $${config.autoRedeemConfig.minPositionUsd})`,
      );
    }

    // Register strategies for performance tracking
    this.initializePerformanceTracking(config);
  }

  /**
   * Initialize performance tracking for dynamic allocation
   */
  private initializePerformanceTracking(
    config: StrategyOrchestratorConfig,
  ): void {
    const tracker = getPerformanceTracker();

    // Register each strategy with base allocation
    // Allocations are percentages that will be dynamically adjusted based on ROI
    if (config.autoRedeemConfig.enabled) {
      tracker.registerStrategy("auto-redeem", 20, 100);
    }
    // Register smart hedging for risky tier positions
    const smartHedgingConfig =
      config.smartHedgingConfig ?? DEFAULT_SMART_HEDGING_CONFIG;
    if (smartHedgingConfig.enabled) {
      tracker.registerStrategy("smart-hedging", 25, smartHedgingConfig.maxHedgeUsd);
    }
    if (config.endgameSweepConfig.enabled) {
      tracker.registerStrategy(
        "endgame-sweep",
        30,
        config.endgameSweepConfig.maxPositionUsd,
      );
    }
    if (config.autoSellConfig.enabled) {
      tracker.registerStrategy("auto-sell", 20, 100);
    }
    if (config.quickFlipConfig.enabled) {
      tracker.registerStrategy("quick-flip", 30, 100);
    }

    this.logger.info(
      "[Orchestrator] 📊 Performance tracking initialized for dynamic allocation",
    );
  }

  /**
   * Start the strategy orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("[Orchestrator] ⚠️ Already running");
      return;
    }

    this.logger.info("[Orchestrator] 🚀 Starting strategy orchestrator");
    this.isRunning = true;

    // Start position tracker and await initial refresh to ensure data is available
    await this.positionTracker.start();

    // Run initial execution
    await this.executeStrategies();

    // Set up periodic execution
    this.executionTimer = setInterval(() => {
      this.executeStrategies().catch((err) => {
        this.logger.error("[Orchestrator] Execution failed", err as Error);
      });
    }, this.executionIntervalMs);

    // Log performance summary periodically
    setInterval(
      () => {
        const tracker = getPerformanceTracker();
        const summary = tracker.getSummary();
        if (summary !== "No strategies tracked") {
          this.logger.info(`[Orchestrator] 📊 Performance:\n${summary}`);
        }
        tracker.pruneHistory(); // Clean up old data
      },
      5 * 60 * 1000,
    ); // Every 5 minutes

    this.logger.info(
      `[Orchestrator] ✅ Started (execution interval: ${this.executionIntervalMs}ms)`,
    );
  }

  /**
   * Get the position tracker instance
   * Used by TradeExecutorService to check existing positions before buying
   */
  getPositionTracker(): PositionTracker {
    return this.positionTracker;
  }

  /**
   * Stop the strategy orchestrator
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.logger.info("[Orchestrator] 🛑 Stopping strategy orchestrator");

    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.positionTracker.stop();
    this.isRunning = false;

    this.logger.info("[Orchestrator] ✅ Stopped");
  }

  /**
   * Execute all strategies in priority order
   *
   * For HFT with many positions, we run strategies in PARALLEL
   * to maximize throughput and catch opportunities faster.
   *
   * Priority still matters for capital allocation, but execution is concurrent.
   */
  private async executeStrategies(): Promise<void> {
    this.logger.debug("[Orchestrator] Executing strategies in parallel");

    try {
      // Run ALL strategies in parallel for maximum speed
      // Each strategy handles its own position checking and execution
      const results = await Promise.allSettled([
        // Priority 1: Auto-Redeem (claim resolved positions - highest priority for capital recovery)
        this.executeWithLogging(
          "Auto-Redeem",
          1,
          () => this.autoRedeemStrategy.execute(),
          this.autoRedeemStrategy.getStats().enabled,
        ),

        // Priority 2: Smart Hedging (HEDGE risky tier positions instead of selling at loss)
        // Runs BEFORE stop-loss to prevent risky positions from being sold
        this.executeWithLogging(
          "Smart Hedging",
          2,
          () => this.smartHedgingStrategy.execute(),
          this.smartHedgingStrategy.getStats().enabled,
        ),

        // Priority 3: Universal Stop-Loss (SAFETY NET - protects higher-tier positions)
        // Only applies to positions NOT already hedged by Smart Hedging
        this.executeWithLogging(
          "Universal Stop-Loss",
          3,
          () => this.universalStopLossStrategy.execute(),
          this.universalStopLossStrategy.getStats().enabled,
        ),

        // Priority 4: Endgame Sweep (buy high-probability positions)
        this.executeWithLogging(
          "Endgame Sweep",
          4,
          () => this.endgameSweepStrategy.execute(),
          this.endgameSweepStrategy.getStats().enabled,
        ),

        // Priority 5: Auto-Sell (free up capital at threshold)
        this.executeWithLogging(
          "Auto-Sell",
          5,
          () => this.autoSellStrategy.execute(),
          this.autoSellStrategy.getStats().enabled,
        ),

        // Priority 6: Quick Flip (take profits at target)
        this.executeWithLogging(
          "Quick Flip",
          6,
          () => this.quickFlipStrategy.execute(),
          this.quickFlipStrategy.getStats().enabled,
        ),
      ]);

      // Log any failures
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          this.logger.error(
            `[Orchestrator] Strategy ${index + 1} failed: ${result.reason}`,
          );
        }
      });

      // Log summary
      const totalExecuted = results.filter(
        (r) => r.status === "fulfilled" && (r.value as number) > 0,
      ).length;

      if (totalExecuted > 0) {
        this.logger.debug(
          `[Orchestrator] ${totalExecuted} strategies executed trades`,
        );
      }

      // Note: ARB engine (Priority 2) and Monitor (Priority 6) run in their own loops
      this.logger.debug(
        `[Orchestrator] ARB=${this.arbEnabled ? "active" : "off"} Monitor=${this.monitorEnabled ? "active" : "off"}`,
      );
    } catch (err) {
      this.logger.error(
        "[Orchestrator] Error during strategy execution",
        err as Error,
      );
    }
  }

  /**
   * Execute a strategy with logging
   */
  private async executeWithLogging(
    name: string,
    priority: number,
    execute: () => Promise<number>,
    enabled: boolean,
  ): Promise<number> {
    if (!enabled) {
      this.logger.debug(
        `[Orchestrator] ${name} is disabled (Priority ${priority})`,
      );
      return 0;
    }

    try {
      const count = await execute();
      if (count > 0) {
        this.logger.info(
          `[Orchestrator] 💰 Priority ${priority}: ${name} executed ${count} trade(s)`,
        );
      }
      return count;
    } catch (err) {
      this.logger.error(`[Orchestrator] ${name} failed`, err as Error);
      throw err;
    }
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    isRunning: boolean;
    arbEnabled: boolean;
    monitorEnabled: boolean;
    universalStopLossStats: ReturnType<UniversalStopLossStrategy["getStats"]>;
    smartHedgingStats: ReturnType<SmartHedgingStrategy["getStats"]>;
    quickFlipStats: ReturnType<QuickFlipStrategy["getStats"]>;
    autoSellStats: ReturnType<AutoSellStrategy["getStats"]>;
    endgameSweepStats: ReturnType<EndgameSweepStrategy["getStats"]>;
    autoRedeemStats: ReturnType<AutoRedeemStrategy["getStats"]>;
    trackedPositions: number;
  } {
    return {
      isRunning: this.isRunning,
      arbEnabled: this.arbEnabled,
      monitorEnabled: this.monitorEnabled,
      universalStopLossStats: this.universalStopLossStrategy.getStats(),
      smartHedgingStats: this.smartHedgingStrategy.getStats(),
      quickFlipStats: this.quickFlipStrategy.getStats(),
      autoSellStats: this.autoSellStrategy.getStats(),
      endgameSweepStats: this.endgameSweepStrategy.getStats(),
      autoRedeemStats: this.autoRedeemStrategy.getStats(),
      trackedPositions: this.positionTracker.getPositions().length,
    };
  }

  /**
   * Get access to the auto-redeem strategy for manual redemptions
   */
  getAutoRedeemStrategy(): AutoRedeemStrategy {
    return this.autoRedeemStrategy;
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
