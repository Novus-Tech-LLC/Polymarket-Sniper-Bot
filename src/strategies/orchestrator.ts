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
 * MULTI-STRATEGY SYSTEM - Hybrid sequential + parallel execution
 *
 * EXECUTION MODEL:
 * - Phase 1 (Sequential): Capital-critical strategies that need guaranteed funds
 *   - Auto-Redeem: Frees up capital from resolved positions
 *   - Smart Hedging: Sells positions AND buys hedges atomically
 * - Phase 2 (Parallel): All other strategies compete for available capital
 *
 * This prevents race conditions where Smart Hedging sells positions to free up
 * capital for hedges, but other strategies "steal" that capital before the hedge executes.
 *
 * As you compound money and positions grow, the system scales:
 * - Position tracking refreshes every 5 seconds
 * - Strategy execution every 2 seconds
 * - Parallel sell execution for Quick Flip / Auto-Sell
 *
 * Strategy Priority:
 * 1. Auto-Redeem - Claim resolved positions (capital recovery) [SEQUENTIAL]
 * 2. Smart Hedging - Hedge risky positions (sells + buys atomically) [SEQUENTIAL]
 * 3. Universal Stop-Loss - Protect higher-tier positions [PARALLEL]
 * 4. Endgame Sweep - Buy 75-92¢ positions (scalping range) [PARALLEL]
 * 5. Auto-Sell - Sell at threshold (free up capital) [PARALLEL]
 * 6. Quick Flip - Take profits at target % [PARALLEL]
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
      const exceedMsg = smartHedgingConfig.allowExceedMaxForProtection
        ? `allowExceed=true, absMax=$${smartHedgingConfig.absoluteMaxHedgeUsd}`
        : `allowExceed=false`;
      this.logger.info(
        `[Orchestrator] 🛡️ Smart Hedging: ENABLED (trigger: -${smartHedgingConfig.triggerLossPct}%, max hedge: $${smartHedgingConfig.maxHedgeUsd}, ${exceedMsg}, reserve: ${smartHedgingConfig.reservePct}%)`,
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
      // Pass callback to get reserved balance from Smart Hedging
      // This ensures Endgame Sweep doesn't spend capital that Smart Hedging needs for hedges
      getReservedBalance: smartHedgingConfig.enabled
        ? () => this.smartHedgingStrategy.getRequiredReserve()
        : undefined,
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
   * EXECUTION MODEL:
   * - Phase 1 (Sequential): Capital-critical strategies that need guaranteed funds
   *   - Auto-Redeem: Frees up capital from resolved positions
   *   - Smart Hedging: Sells positions AND buys hedges (needs capital reservation)
   * - Phase 2 (Parallel): All other strategies that compete for available capital
   *
   * This prevents race conditions where Smart Hedging sells positions to free up
   * capital for hedges, but other strategies "steal" that capital before the hedge executes.
   */
  private async executeStrategies(): Promise<void> {
    this.logger.debug("[Orchestrator] Executing strategies (sequential + parallel phases)");

    try {
      // PHASE 1: Sequential execution for capital-critical strategies
      // These strategies need to complete atomically (sell + buy) without interference
      // Each strategy is wrapped in try-catch to prevent blocking subsequent execution
      
      // Priority 1: Auto-Redeem (claim resolved positions - highest priority for capital recovery)
      try {
        await this.executeWithLogging(
          "Auto-Redeem",
          1,
          () => this.autoRedeemStrategy.execute(),
          this.autoRedeemStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Auto-Redeem failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Priority 2: Smart Hedging (HEDGE risky tier positions instead of selling at loss)
      // MUST run sequentially: sells positions to free capital, then immediately uses it for hedges
      // Running in parallel would allow other strategies to "steal" the freed capital
      try {
        await this.executeWithLogging(
          "Smart Hedging",
          2,
          () => this.smartHedgingStrategy.execute(),
          this.smartHedgingStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Smart Hedging failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // PHASE 2: Parallel execution for remaining strategies
      // These can safely compete for available capital
      // Each strategy is wrapped with its name for proper error logging
      const parallelStrategies = [
        {
          name: "Universal Stop-Loss",
          priority: 3,
          execute: () => this.universalStopLossStrategy.execute(),
          enabled: this.universalStopLossStrategy.getStats().enabled,
        },
        {
          name: "Endgame Sweep",
          priority: 4,
          execute: () => this.endgameSweepStrategy.execute(),
          enabled: this.endgameSweepStrategy.getStats().enabled,
        },
        {
          name: "Auto-Sell",
          priority: 5,
          execute: () => this.autoSellStrategy.execute(),
          enabled: this.autoSellStrategy.getStats().enabled,
        },
        {
          name: "Quick Flip",
          priority: 6,
          execute: () => this.quickFlipStrategy.execute(),
          enabled: this.quickFlipStrategy.getStats().enabled,
        },
      ];

      const results = await Promise.allSettled(
        parallelStrategies.map((strategy) =>
          this.executeWithLogging(
            strategy.name,
            strategy.priority,
            strategy.execute,
            strategy.enabled,
          ),
        ),
      );

      // Log any failures with strategy names
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const strategyName = parallelStrategies[index].name;
          this.logger.error(
            `[Orchestrator] ${strategyName} failed: ${result.reason}`,
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
