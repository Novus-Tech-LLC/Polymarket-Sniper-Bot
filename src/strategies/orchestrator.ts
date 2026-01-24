/**
 * Strategy Orchestrator
 *
 * Runs all strategies SEQUENTIALLY in priority order.
 * No parallel execution = no race conditions = no order stacking.
 *
 * SINGLE-FLIGHT GUARANTEE:
 * - Only ONE orchestrator cycle runs at a time (global lock)
 * - If a timer tick fires while a cycle is running, it is SKIPPED
 * - Each strategy also has its own in-flight guard to prevent re-entrancy
 * - PositionTracker refresh is single-flight and awaitable
 *
 * EXECUTION ORDER:
 * 1. Refresh PositionTracker (single-flight, awaited by all strategies)
 * 2. Auto-Redeem - Claim resolved positions (HIGHEST PRIORITY - get money back!)
 * 3. Smart Hedging - Hedge losing positions
 * 4. Universal Stop-Loss - Sell positions at max loss
 * 5. Scalp Take-Profit - Time-based profit taking with momentum checks
 * 6. Endgame Sweep - Buy high-confidence positions
 */

import { randomUUID } from "crypto";
import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import { LogDeduper, HEARTBEAT_INTERVAL_MS } from "../utils/log-deduper.util";
import {
  SmartHedgingStrategy,
  type SmartHedgingConfig,
  DEFAULT_HEDGING_CONFIG,
} from "./smart-hedging";
import {
  EndgameSweepStrategy,
  type EndgameSweepConfig,
  DEFAULT_ENDGAME_CONFIG,
} from "./endgame-sweep";
// Quick Flip module removed - functionality covered by ScalpTakeProfit
// import {
//   QuickFlipStrategy,
//   type QuickFlipConfig,
//   DEFAULT_QUICKFLIP_CONFIG,
// } from "./quick-flip";
import {
  ScalpTakeProfitStrategy,
  type ScalpTakeProfitConfig,
  DEFAULT_SCALP_TAKE_PROFIT_CONFIG,
} from "./scalp-take-profit";
import { AutoRedeemStrategy, type AutoRedeemConfig } from "./auto-redeem";
import {
  UniversalStopLossStrategy,
  type UniversalStopLossConfig,
} from "./universal-stop-loss";
import { RiskManager, createRiskManager } from "./risk-manager";
import { PnLLedger } from "./pnl-ledger";
import type { RelayerContext } from "../polymarket/relayer";

const POSITION_REFRESH_MS = 5000; // 5 seconds
const EXECUTION_INTERVAL_MS = 2000; // 2 seconds
const TICK_SKIPPED_LOG_INTERVAL_MS = 60_000; // Log "tick skipped" at most once per minute

export interface OrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  maxPositionUsd: number; // From MAX_POSITION_USD env
  riskPreset?: "conservative" | "balanced" | "aggressive";
  hedgingConfig?: Partial<SmartHedgingConfig>;
  endgameConfig?: Partial<EndgameSweepConfig>;
  // quickFlipConfig removed - module deprecated
  scalpConfig?: Partial<ScalpTakeProfitConfig>;
  autoRedeemConfig?: Partial<AutoRedeemConfig>;
  stopLossConfig?: Partial<UniversalStopLossConfig>;
}

export class Orchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private riskManager: RiskManager;
  private pnlLedger: PnLLedger;

  // All strategies
  private autoRedeemStrategy: AutoRedeemStrategy;
  private hedgingStrategy: SmartHedgingStrategy;
  private stopLossStrategy: UniversalStopLossStrategy;
  private scalpStrategy: ScalpTakeProfitStrategy;
  private endgameStrategy: EndgameSweepStrategy;
  // quickFlipStrategy removed - module deprecated

  private executionTimer?: NodeJS.Timeout;
  private isRunning = false;

  // === SINGLE-FLIGHT CYCLE LOCK ===
  // Prevents overlapping orchestrator cycles (re-entrancy protection)
  private cycleInFlight = false;
  private cycleId = 0;

  // Unique boot ID to detect multiple orchestrator instances
  private readonly bootId: string;

  // === OBSERVABILITY COUNTERS ===
  private ticksFired = 0;
  private cyclesRun = 0;
  private ticksSkippedDueToInflight = 0;
  private lastTickSkippedLogAt = 0;

  // === LOG DEDUPLICATION ===
  // Prevents repetitive logging of slow strategies
  private logDeduper = new LogDeduper();
  // Track last logged slow strategies for change detection
  private lastSlowStrategiesFingerprint = "";

  constructor(config: OrchestratorConfig) {
    this.client = config.client;
    this.logger = config.logger;

    // Generate unique boot ID to detect multiple orchestrator instances
    this.bootId = randomUUID().slice(0, 8);
    this.logger.info(
      `[Orchestrator] Boot ID: ${this.bootId} - only ONE instance should exist`,
    );

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

    // Extract relayer context from client (set by preflight if available)
    const relayerContext = (
      config.client as { relayerContext?: RelayerContext }
    ).relayerContext;

    // 1. Auto-Redeem - Claim resolved positions (HIGHEST PRIORITY)
    // Uses relayer for gasless redemptions when available (recommended)
    this.autoRedeemStrategy = new AutoRedeemStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      relayer: relayerContext,
      config: {
        enabled: true,
        minPositionUsd: 0.01, // Redeem anything
        checkIntervalMs: 30000, // Check every 30s
        ...config.autoRedeemConfig,
      },
    });

    // 2. Smart Hedging - Hedge losing positions
    const hedgingConfig = {
      ...DEFAULT_HEDGING_CONFIG,
      maxHedgeUsd: config.maxPositionUsd,
      ...config.hedgingConfig,
    };
    this.hedgingStrategy = new SmartHedgingStrategy({
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
    this.endgameStrategy = new EndgameSweepStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_ENDGAME_CONFIG,
        maxPositionUsd: config.maxPositionUsd,
        ...config.endgameConfig,
      },
    });

    // 5. Scalp Take-Profit - Time-and-momentum-based profit taking
    // Enabled by default - takes profits on positions after holding 45-90 min
    // with 5%+ profit, or captures sudden spikes (15%+ in 10 min)
    // CRITICAL: Never forces time-exit on ≤60¢ entries that reach 90¢+
    this.scalpStrategy = new ScalpTakeProfitStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_SCALP_TAKE_PROFIT_CONFIG,
        ...config.scalpConfig,
      },
    });

    // Quick Flip module removed - ScalpTakeProfit handles profit-taking

    this.logger.info(
      `[Orchestrator] Initialized with maxPosition=$${config.maxPositionUsd}`,
    );
  }

  /**
   * Start the orchestrator
   * Creates exactly ONE timer for the execution loop.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(
        `[Orchestrator] Already running (bootId=${this.bootId}), ignoring duplicate start()`,
      );
      return;
    }

    this.logger.info(
      `[Orchestrator] 🚀 Starting... (bootId=${this.bootId})`,
    );

    // Start position tracking
    await this.positionTracker.start();

    // Start strategy execution loop - SINGLE TIMER
    this.isRunning = true;
    this.executionTimer = setInterval(
      () => this.onTick(),
      EXECUTION_INTERVAL_MS,
    );

    this.logger.info(
      `[Orchestrator] ✅ Started with ${EXECUTION_INTERVAL_MS}ms interval (bootId=${this.bootId})`,
    );
  }

  /**
   * Timer tick handler
   * Implements single-flight protection: skips if a cycle is already running
   */
  private onTick(): void {
    this.ticksFired++;

    // SINGLE-FLIGHT GUARD: Skip if cycle already in flight
    if (this.cycleInFlight) {
      this.ticksSkippedDueToInflight++;

      // Rate-limit "tick skipped" logging to once per minute
      const now = Date.now();
      if (now - this.lastTickSkippedLogAt >= TICK_SKIPPED_LOG_INTERVAL_MS) {
        this.logger.debug(
          `[Orchestrator] Tick skipped - cycle in flight (skipped=${this.ticksSkippedDueToInflight} total)`,
        );
        this.lastTickSkippedLogAt = now;
      }
      return;
    }

    // Start a new cycle (fire-and-forget, but guarded)
    this.executeStrategies().catch((err) => {
      this.logger.error(
        `[Orchestrator] Cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Execute all strategies sequentially
   * ORDER MATTERS - higher priority strategies run first
   *
   * SINGLE-FLIGHT GUARANTEE:
   * - Sets cycleInFlight=true at start, false at end
   * - If already in flight (should not happen due to onTick guard), returns immediately
   * - Each strategy is invoked exactly once per cycle
   */
  private async executeStrategies(): Promise<void> {
    if (!this.isRunning) return;

    // Double-check single-flight (belt-and-suspenders with onTick guard)
    if (this.cycleInFlight) {
      this.logger.warn(
        `[Orchestrator] executeStrategies called while cycle in flight - skipping`,
      );
      return;
    }

    // Acquire cycle lock
    this.cycleInFlight = true;
    this.cycleId++;
    this.cyclesRun++;
    const currentCycleId = this.cycleId;
    const cycleStartTime = Date.now();

    this.logger.debug(
      `[Orchestrator] cycle=${currentCycleId} start (ticksFired=${this.ticksFired}, skipped=${this.ticksSkippedDueToInflight})`,
    );

    const strategyTimings: Array<{ name: string; durationMs: number }> = [];

    try {
      // Phase 1: Refresh positions (single-flight, shared by all strategies)
      // This ensures all strategies see consistent position data
      const refreshStart = Date.now();
      await this.positionTracker.awaitCurrentRefresh();
      strategyTimings.push({
        name: "PositionRefresh",
        durationMs: Date.now() - refreshStart,
      });

      // Phase 2: Risk checks and redemption
      // 1. Auto-Redeem - HIGHEST PRIORITY - get money back from resolved positions
      await this.runStrategyTimed(
        "AutoRedeem",
        () => this.autoRedeemStrategy.execute(),
        strategyTimings,
      );

      // Phase 3: Risk management
      // 2. Smart Hedging - protect losing positions by buying opposite side
      await this.runStrategyTimed(
        "Hedging",
        () => this.hedgingStrategy.execute(),
        strategyTimings,
      );

      // 3. Universal Stop-Loss - sell positions exceeding max loss threshold
      await this.runStrategyTimed(
        "StopLoss",
        () => this.stopLossStrategy.execute(),
        strategyTimings,
      );

      // Phase 4: Trading strategies
      // 4. Scalp Take-Profit - time-based profit taking with momentum checks
      await this.runStrategyTimed(
        "ScalpTakeProfit",
        () => this.scalpStrategy.execute(),
        strategyTimings,
      );

      // 5. Endgame Sweep - buy high-confidence positions (85-99¢)
      await this.runStrategyTimed(
        "Endgame",
        () => this.endgameStrategy.execute(),
        strategyTimings,
      );

      // Quick Flip removed - functionality covered by ScalpTakeProfit
    } catch (err) {
      this.logger.error(
        `[Orchestrator] Error in cycle=${currentCycleId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Release cycle lock
      this.cycleInFlight = false;

      const cycleDuration = Date.now() - cycleStartTime;
      this.logger.debug(
        `[Orchestrator] cycle=${currentCycleId} end duration=${cycleDuration}ms (skippedTicks=${this.ticksSkippedDueToInflight})`,
      );

      // Log slow strategies (> 500ms) for diagnostics - rate-limited with change detection
      const slowStrategies = strategyTimings.filter((s) => s.durationMs > 500);
      if (slowStrategies.length > 0) {
        // Create fingerprint from slow strategy names (not durations, to avoid constant change)
        const slowNamesFingerprint = slowStrategies
          .map((s) => s.name)
          .sort()
          .join(",");

        // Log only if the set of slow strategies changed or TTL expired
        if (this.logDeduper.shouldLog("Orchestrator:slow_strategies", HEARTBEAT_INTERVAL_MS, slowNamesFingerprint)) {
          this.logger.debug(
            `[Orchestrator] Slow strategies: ${slowStrategies.map((s) => `${s.name}=${s.durationMs}ms`).join(", ")}`,
          );
        }
      }
    }
  }

  /**
   * Run a single strategy with timing and error handling
   */
  private async runStrategyTimed(
    name: string,
    execute: () => Promise<number>,
    timings: Array<{ name: string; durationMs: number }>,
  ): Promise<void> {
    const start = Date.now();
    try {
      const count = await execute();
      if (count > 0) {
        this.logger.info(`[Orchestrator] ${name}: ${count} action(s)`);
      }
    } catch (err) {
      this.logger.error(
        `[Orchestrator] ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      timings.push({ name, durationMs: Date.now() - start });
    }
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (!this.isRunning) return;

    this.logger.info(
      `[Orchestrator] 🛑 Stopping... (bootId=${this.bootId})`,
    );

    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.positionTracker.stop();
    this.isRunning = false;

    this.logger.info(
      `[Orchestrator] ✅ Stopped. Stats: ticksFired=${this.ticksFired}, cyclesRun=${this.cyclesRun}, skipped=${this.ticksSkippedDueToInflight}`,
    );
  }

  /**
   * Get orchestrator statistics for observability
   */
  getStats(): {
    bootId: string;
    ticksFired: number;
    cyclesRun: number;
    ticksSkippedDueToInflight: number;
    cycleInFlight: boolean;
    currentCycleId: number;
  } {
    return {
      bootId: this.bootId,
      ticksFired: this.ticksFired,
      cyclesRun: this.cyclesRun,
      ticksSkippedDueToInflight: this.ticksSkippedDueToInflight,
      cycleInFlight: this.cycleInFlight,
      currentCycleId: this.cycleId,
    };
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
 * Create an orchestrator from env config
 */
export function createOrchestrator(
  client: ClobClient,
  logger: ConsoleLogger,
  maxPositionUsd: number,
  riskPreset: "conservative" | "balanced" | "aggressive" = "balanced",
): Orchestrator {
  return new Orchestrator({
    client,
    logger,
    maxPositionUsd,
    riskPreset,
  });
}
