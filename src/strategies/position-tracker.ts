import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";

export interface Position {
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  pnlUsd: number;
}

export interface PositionTrackerConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  refreshIntervalMs?: number;
}

/**
 * Tracks current positions and their P&L
 * Provides data to Quick Flip and Auto-Sell strategies
 */
export class PositionTracker {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positions: Map<string, Position> = new Map();
  private refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;

  constructor(config: PositionTrackerConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000; // 30 seconds default
  }

  /**
   * Start tracking positions
   */
  async start(): Promise<void> {
    this.logger.info("[PositionTracker] Starting position tracking");
    await this.refresh();
    
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error("[PositionTracker] Refresh failed", err as Error);
      });
    }, this.refreshIntervalMs);
  }

  /**
   * Stop tracking positions
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.logger.info("[PositionTracker] Stopped position tracking");
  }

  /**
   * Refresh positions from API
   */
  async refresh(): Promise<void> {
    try {
      // Get current positions from CLOB API
      // Note: This is a placeholder - actual implementation would use
      // ClobClient methods to fetch positions
      this.logger.debug("[PositionTracker] Refreshing positions");
      
      // For now, we'll use a mock implementation
      // In production, this would call actual Polymarket API endpoints
      const positions = await this.fetchPositionsFromAPI();
      
      // Update positions map
      this.positions.clear();
      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        this.positions.set(key, position);
      }
      
      this.logger.debug(
        `[PositionTracker] Refreshed ${positions.length} positions`
      );
    } catch (err) {
      this.logger.error(
        "[PositionTracker] Failed to refresh positions",
        err as Error
      );
      throw err;
    }
  }

  /**
   * Get all current positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get position by market and token ID
   */
  getPosition(marketId: string, tokenId: string): Position | undefined {
    const key = `${marketId}-${tokenId}`;
    return this.positions.get(key);
  }

  /**
   * Get positions with P&L above threshold
   */
  getPositionsAboveTarget(targetPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct >= targetPct);
  }

  /**
   * Get positions below stop loss threshold
   */
  getPositionsBelowStopLoss(stopLossPct: number): Position[] {
    return this.getPositions().filter((pos) => pos.pnlPct <= -stopLossPct);
  }

  /**
   * Get positions near resolution (price > threshold)
   */
  getPositionsNearResolution(threshold: number): Position[] {
    return this.getPositions().filter((pos) => pos.currentPrice >= threshold);
  }

  /**
   * Fetch positions from Polymarket API
   * This is a placeholder for actual API integration
   */
  private async fetchPositionsFromAPI(): Promise<Position[]> {
    // This would use actual Polymarket API endpoints
    // For now, return empty array as placeholder
    // In production, this would call something like:
    // const response = await this.client.getPositions();
    // Then map response to Position[] format
    return [];
  }
}
