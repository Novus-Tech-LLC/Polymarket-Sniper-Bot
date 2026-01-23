/**
 * Simple Strategy Orchestrator
 *
 * Runs all strategies SEQUENTIALLY in priority order.
 * No parallel execution = no race conditions = no order stacking.
 *
 * EXECUTION ORDER:
 * 1. Auto-Redeem - Claim resolved positions (HIGHEST PRIORITY - get money back!)
 * 2. Smart Hedging - Hedge losing positions
 * 3. Universal Stop-Loss - Sell positions at max loss
 * 4. Endgame Sweep - Buy high-confidence positions
 * 5. Quick Flip - Take profits
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import {
  SimpleSmartHedgingStrategy,
  type SimpleSmartHedgingConfig,
  DEFAULT_SIMPLE_HEDGING_CONFIG,
} from "./smart-hedging-simple";
import {
  SimpleEndgameSweepStrategy,
  type SimpleEndgameSweepConfig,
  DEFAULT_SIMPLE_ENDGAME_CONFIG,
} from "./endgame-sweep-simple";
import {
  SimpleQuickFlipStrategy,
  type SimpleQuickFlipConfig,
  DEFAULT_SIMPLE_QUICKFLIP_CONFIG,
} from "./quick-flip-simple";
import { AutoRedeemStrategy, type AutoRedeemConfig } from "./auto-redeem";
import { UniversalStopLossStrategy, type UniversalStopLossConfig } from "./universal-stop-loss";
import { RiskManager, createRiskManager } from "./risk-manager";
import { PnLLedger } from "./pnl-ledger";

const POSITION_REFRESH_MS = 5000; // 5 seconds
const EXECUTION_INTERVAL_MS = 2000; // 2 seconds

export interface SimpleOrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  maxPositionUsd: number; // From MAX_POSITION_USD env
  riskPreset?: "conservative" | "balanced" | "aggressive";
  hedgingConfig?: Partial<SimpleSmartHedgingConfig>;
  endgameConfig?: Partial<SimpleEndgameSweepConfig>;
  quickFlipConfig?: Partial<SimpleQuickFlipConfig>;
  autoRedeemConfig?: Partial<AutoRedeemConfig>;
  stopLossConfig?: Partial<UniversalStopLossConfig>;
}

export class SimpleOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private riskManager: RiskManager;
  private pnlLedger: PnLLedger;

  // All strategies
  private autoRedeemStrategy: AutoRedeemStrategy;
  private hedgingStrategy: SimpleSmartHedgingStrategy;
  private stopLossStrategy: UniversalStopLossStrategy;
  private endgameStrategy: SimpleEndgameSweepStrategy;
  private quickFlipStrategy: SimpleQuickFlipStrategy;

  private executionTimer?: NodeJS.Timeout;
  private isRunning = false;

  constructor(config: SimpleOrchestratorConfig) {
    this.client = config.client;
    this.logger = config.logger;

    // Initialize core components
    const riskPreset = config.riskPreset ?? "balanced";
    this.riskManager = createRiskManager(riskPreset, this.logger, {
      maxExposurePerMarketUsd: config.maxPositionUsd,
      maxExposureUsd: config.maxPositionUsd * 10,
    });

    this.pnlLedger = new PnLLedger(this.logger);

    this.positionTracker = new PositionTracker({
      client: config.client,
      logger: config.logger,
      refreshIntervalMs: POSITION_REFRESH_MS,
    });

    // === INITIALIZE ALL STRATEGIES ===

    // 1. Auto-Redeem - Claim resolved positions (HIGHEST PRIORITY)
    this.autoRedeemStrategy = new AutoRedeemStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        enabled: true,
        minPositionUsd: 0.01, // Redeem anything
        checkIntervalMs: 30000, // Check every 30s
        ...config.autoRedeemConfig,
      },
    });

    // 2. Smart Hedging - Hedge losing positions
    const hedgingConfig = {
      ...DEFAULT_SIMPLE_HEDGING_CONFIG,
      maxHedgeUsd: config.maxPositionUsd,
      ...config.hedgingConfig,
    };
    this.hedgingStrategy = new SimpleSmartHedgingStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: hedgingConfig,
    });

    // 3. Universal Stop-Loss - Protect against big losses
    // When Smart Hedging is enabled, skip positions it handles (entry < maxEntryPrice)
    const smartHedgingEnabled = hedgingConfig.enabled;
    this.stopLossStrategy = new UniversalStopLossStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        enabled: true,
        maxStopLossPct: 25, // Max 25% loss
        useDynamicTiers: true,
        minHoldSeconds: 60, // Wait 60s before stop-loss
        // Skip positions that Smart Hedging handles (below its maxEntryPrice)
        skipForSmartHedging: smartHedgingEnabled,
        hedgingMaxEntryPrice: hedgingConfig.maxEntryPrice,
        ...config.stopLossConfig,
      },
    });

    // 4. Endgame Sweep - Buy high-confidence positions
    this.endgameStrategy = new SimpleEndgameSweepStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_SIMPLE_ENDGAME_CONFIG,
        maxPositionUsd: config.maxPositionUsd,
        ...config.endgameConfig,
      },
    });

    // 5. Quick Flip - Take profits
    this.quickFlipStrategy = new SimpleQuickFlipStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_SIMPLE_QUICKFLIP_CONFIG,
        ...config.quickFlipConfig,
      },
    });

    this.logger.info(
      `[SimpleOrchestrator] Initialized with maxPosition=$${config.maxPositionUsd}`,
    );
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.logger.info("[SimpleOrchestrator] 🚀 Starting...");

    // Start position tracking
    await this.positionTracker.start();

    // Start strategy execution loop
    this.isRunning = true;
    this.executionTimer = setInterval(
      () => this.executeStrategies(),
      EXECUTION_INTERVAL_MS,
    );

    this.logger.info("[SimpleOrchestrator] ✅ Started");
  }

  /**
   * Execute all strategies sequentially
   * ORDER MATTERS - higher priority strategies run first
   */
  private async executeStrategies(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // 1. Auto-Redeem - HIGHEST PRIORITY - get money back from resolved positions
      await this.runStrategy("AutoRedeem", () => this.autoRedeemStrategy.execute());

      // 2. Smart Hedging - protect losing positions by buying opposite side
      await this.runStrategy("Hedging", () => this.hedgingStrategy.execute());

      // 3. Universal Stop-Loss - sell positions exceeding max loss threshold
      await this.runStrategy("StopLoss", () => this.stopLossStrategy.execute());

      // 4. Endgame Sweep - buy high-confidence positions (85-99¢)
      await this.runStrategy("Endgame", () => this.endgameStrategy.execute());

      // 5. Quick Flip - take profits when target reached
      await this.runStrategy("QuickFlip", () => this.quickFlipStrategy.execute());
    } catch (err) {
      this.logger.error(
        `[SimpleOrchestrator] Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Run a single strategy with error handling
   */
  private async runStrategy(
    name: string,
    execute: () => Promise<number>,
  ): Promise<void> {
    try {
      const count = await execute();
      if (count > 0) {
        this.logger.info(`[SimpleOrchestrator] ${name}: ${count} action(s)`);
      }
    } catch (err) {
      this.logger.error(
        `[SimpleOrchestrator] ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (!this.isRunning) return;

    this.logger.info("[SimpleOrchestrator] 🛑 Stopping...");

    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.positionTracker.stop();
    this.isRunning = false;

    this.logger.info("[SimpleOrchestrator] ✅ Stopped");
  }

  /**
   * Get components for external access
   */
  getPositionTracker(): PositionTracker {
    return this.positionTracker;
  }

  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  getPnLLedger(): PnLLedger {
    return this.pnlLedger;
  }
}

/**
 * Create a simple orchestrator from env config
 */
export function createSimpleOrchestrator(
  client: ClobClient,
  logger: ConsoleLogger,
  maxPositionUsd: number,
  riskPreset: "conservative" | "balanced" | "aggressive" = "balanced",
): SimpleOrchestrator {
  return new SimpleOrchestrator({
    client,
    logger,
    maxPositionUsd,
    riskPreset,
  });
}
