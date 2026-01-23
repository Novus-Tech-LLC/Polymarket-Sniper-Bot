/**
 * Simple Strategy Orchestrator
 *
 * Runs all strategies SEQUENTIALLY in priority order.
 * No parallel execution = no race conditions = no order stacking.
 *
 * EXECUTION ORDER:
 * 1. Auto-Redeem - Claim resolved positions
 * 2. Smart Hedging - Hedge losing positions
 * 3. Stop-Loss - Sell positions at max loss
 * 4. Endgame Sweep - Buy high-confidence positions
 * 5. Auto-Sell - Sell near resolution
 * 6. Quick Flip - Take profits
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
}

export class SimpleOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private riskManager: RiskManager;
  private pnlLedger: PnLLedger;

  private hedgingStrategy: SimpleSmartHedgingStrategy;
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

    // Initialize strategies with user config merged with defaults
    this.hedgingStrategy = new SimpleSmartHedgingStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_SIMPLE_HEDGING_CONFIG,
        maxHedgeUsd: config.maxPositionUsd,
        ...config.hedgingConfig,
      },
    });

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
   */
  private async executeStrategies(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // 1. Smart Hedging - protect losing positions
      await this.runStrategy("Hedging", () => this.hedgingStrategy.execute());

      // 2. Endgame Sweep - buy high-confidence positions
      await this.runStrategy("Endgame", () => this.endgameStrategy.execute());

      // 3. Quick Flip - take profits
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
