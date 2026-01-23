/**
 * Strategy Performance Tracker
 *
 * Tracks ROI and performance metrics for each strategy to enable
 * DYNAMIC ALLOCATION - shift capital to strategies that are performing best.
 *
 * As you compound and scale:
 * - Track wins/losses per strategy
 * - Calculate rolling ROI
 * - Adjust position sizing based on performance
 * - Reduce allocation to underperforming strategies
 */

export interface StrategyMetrics {
  name: string;
  tradesExecuted: number;
  tradesSuccessful: number;
  tradesFailed: number;
  totalProfitUsd: number;
  totalLossUsd: number;
  netProfitUsd: number;
  winRate: number; // 0-1
  avgProfitPerTrade: number;
  avgLossPerTrade: number;
  roi: number; // percentage
  lastUpdated: number;
}

export interface StrategyAllocation {
  name: string;
  baseAllocationPct: number; // Base allocation (e.g., 25%)
  currentAllocationPct: number; // Adjusted based on performance
  maxPositionUsd: number; // Current max position size
  enabled: boolean;
}

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Track performance and dynamically adjust strategy allocations
 */
export class StrategyPerformanceTracker {
  private metrics: Map<string, StrategyMetrics> = new Map();
  private allocations: Map<string, StrategyAllocation> = new Map();
  private tradeHistory: Map<string, TradeRecord[]> = new Map();
  private lookbackMs: number;
  private rebalanceIntervalMs: number;
  private lastRebalance: number = 0;

  constructor(
    config: {
      lookbackMs?: number;
      rebalanceIntervalMs?: number;
    } = {},
  ) {
    this.lookbackMs = config.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.rebalanceIntervalMs = config.rebalanceIntervalMs ?? 60 * 60 * 1000; // 1 hour default
  }

  /**
   * Initialize a strategy for tracking
   */
  registerStrategy(
    name: string,
    baseAllocationPct: number,
    maxPositionUsd: number,
  ): void {
    this.metrics.set(name, {
      name,
      tradesExecuted: 0,
      tradesSuccessful: 0,
      tradesFailed: 0,
      totalProfitUsd: 0,
      totalLossUsd: 0,
      netProfitUsd: 0,
      winRate: 0,
      avgProfitPerTrade: 0,
      avgLossPerTrade: 0,
      roi: 0,
      lastUpdated: Date.now(),
    });

    this.allocations.set(name, {
      name,
      baseAllocationPct,
      currentAllocationPct: baseAllocationPct,
      maxPositionUsd,
      enabled: true,
    });

    this.tradeHistory.set(name, []);
  }

  /**
   * Record a trade result
   */
  recordTrade(
    strategyName: string,
    result: {
      success: boolean;
      profitUsd: number;
      sizeUsd: number;
      timestamp?: number;
    },
  ): void {
    const metrics = this.metrics.get(strategyName);
    if (!metrics) {
      console.warn(`[StrategyPerformance] Unknown strategy: ${strategyName}`);
      return;
    }

    const timestamp = result.timestamp ?? Date.now();

    // Record in history
    const history = this.tradeHistory.get(strategyName) ?? [];
    history.push({
      timestamp,
      success: result.success,
      profitUsd: result.profitUsd,
      sizeUsd: result.sizeUsd,
    });
    this.tradeHistory.set(strategyName, history);

    // Update metrics
    metrics.tradesExecuted++;
    if (result.success && result.profitUsd > 0) {
      metrics.tradesSuccessful++;
      metrics.totalProfitUsd += result.profitUsd;
    } else {
      metrics.tradesFailed++;
      metrics.totalLossUsd += Math.abs(result.profitUsd);
    }

    metrics.netProfitUsd = metrics.totalProfitUsd - metrics.totalLossUsd;
    metrics.winRate =
      metrics.tradesExecuted > 0
        ? metrics.tradesSuccessful / metrics.tradesExecuted
        : 0;
    metrics.avgProfitPerTrade =
      metrics.tradesSuccessful > 0
        ? metrics.totalProfitUsd / metrics.tradesSuccessful
        : 0;
    metrics.avgLossPerTrade =
      metrics.tradesFailed > 0
        ? metrics.totalLossUsd / metrics.tradesFailed
        : 0;
    metrics.lastUpdated = timestamp;

    // Trigger rebalance check
    this.maybeRebalance();
  }

  /**
   * Get current allocation for a strategy (dynamically adjusted)
   */
  getAllocation(strategyName: string): StrategyAllocation | undefined {
    return this.allocations.get(strategyName);
  }

  /**
   * Get recommended max position size for a strategy
   * This is dynamically adjusted based on performance
   */
  getRecommendedPositionSize(strategyName: string, baseMaxUsd: number): number {
    const allocation = this.allocations.get(strategyName);
    if (!allocation) return baseMaxUsd;

    // Scale position size by allocation ratio
    const allocationRatio =
      allocation.currentAllocationPct / allocation.baseAllocationPct;
    return Math.max(1, baseMaxUsd * allocationRatio);
  }

  /**
   * Check if rebalance is needed and perform it
   */
  private maybeRebalance(): void {
    const now = Date.now();
    if (now - this.lastRebalance < this.rebalanceIntervalMs) {
      return;
    }

    this.rebalance();
    this.lastRebalance = now;
  }

  /**
   * Rebalance allocations based on recent performance
   *
   * Strategy:
   * - Calculate rolling ROI for each strategy (last 24h)
   * - Increase allocation to strategies with positive ROI
   * - Decrease allocation to strategies with negative ROI
   * - Never go below 10% or above 200% of base allocation
   */
  rebalance(): void {
    const now = Date.now();
    const cutoff = now - this.lookbackMs;

    // Calculate rolling metrics for each strategy
    const rollingMetrics: Map<string, { roi: number; trades: number }> =
      new Map();

    for (const [name, history] of this.tradeHistory.entries()) {
      // Filter to lookback period
      const recentTrades = history.filter((t) => t.timestamp >= cutoff);

      if (recentTrades.length === 0) {
        rollingMetrics.set(name, { roi: 0, trades: 0 });
        continue;
      }

      const totalProfit = recentTrades.reduce((sum, t) => sum + t.profitUsd, 0);
      const totalSize = recentTrades.reduce((sum, t) => sum + t.sizeUsd, 0);
      const roi = totalSize > 0 ? (totalProfit / totalSize) * 100 : 0;

      rollingMetrics.set(name, { roi, trades: recentTrades.length });

      // Update metrics with rolling ROI
      const metrics = this.metrics.get(name);
      if (metrics) {
        metrics.roi = roi;
      }
    }

    // Calculate average ROI across all strategies
    const allRois = Array.from(rollingMetrics.values()).map((m) => m.roi);
    const avgRoi =
      allRois.length > 0
        ? allRois.reduce((a, b) => a + b, 0) / allRois.length
        : 0;

    // Adjust allocations based on relative performance
    for (const [name, { roi, trades }] of rollingMetrics.entries()) {
      const allocation = this.allocations.get(name);
      if (!allocation) continue;

      // Need minimum trades to adjust allocation
      if (trades < 5) {
        allocation.currentAllocationPct = allocation.baseAllocationPct;
        continue;
      }

      // Calculate adjustment factor based on ROI vs average
      // If ROI > avg: increase allocation, if ROI < avg: decrease
      let adjustmentFactor = 1.0;

      if (avgRoi !== 0) {
        // Scale by how much better/worse than average
        const roiDelta = roi - avgRoi;
        adjustmentFactor = 1 + roiDelta / 100; // ±1% ROI = ±1% adjustment
      } else if (roi > 0) {
        adjustmentFactor = 1.2; // Boost profitable strategies when no baseline
      } else if (roi < 0) {
        adjustmentFactor = 0.8; // Reduce losing strategies
      }

      // Apply adjustment with bounds (10% - 200% of base)
      const newAllocation = allocation.baseAllocationPct * adjustmentFactor;
      allocation.currentAllocationPct = Math.max(
        allocation.baseAllocationPct * 0.1, // Min 10% of base
        Math.min(allocation.baseAllocationPct * 2.0, newAllocation), // Max 200% of base
      );
    }
  }

  /**
   * Get all strategy metrics
   */
  getAllMetrics(): StrategyMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Get performance summary for logging
   */
  getSummary(): string {
    const metrics = this.getAllMetrics();
    if (metrics.length === 0) return "No strategies tracked";

    const lines = metrics.map((m) => {
      const allocation = this.allocations.get(m.name);
      const allocPct = allocation?.currentAllocationPct.toFixed(1) ?? "?";
      return `${m.name}: ${m.tradesExecuted} trades, ${m.winRate.toFixed(1)}% win, $${m.netProfitUsd.toFixed(2)} net, ${m.roi.toFixed(2)}% ROI, ${allocPct}% alloc`;
    });

    return lines.join("\n");
  }

  /**
   * Prune old trade history to prevent memory growth
   */
  pruneHistory(): void {
    const cutoff = Date.now() - this.lookbackMs * 2; // Keep 2x lookback for safety

    for (const [name, history] of this.tradeHistory.entries()) {
      const pruned = history.filter((t) => t.timestamp >= cutoff);
      this.tradeHistory.set(name, pruned);
    }
  }
}

interface TradeRecord {
  timestamp: number;
  success: boolean;
  profitUsd: number;
  sizeUsd: number;
}

// Singleton instance for global access
let performanceTracker: StrategyPerformanceTracker | null = null;

export function getPerformanceTracker(): StrategyPerformanceTracker {
  if (!performanceTracker) {
    performanceTracker = new StrategyPerformanceTracker();
  }
  return performanceTracker;
}

export function resetPerformanceTracker(): void {
  performanceTracker = null;
}
