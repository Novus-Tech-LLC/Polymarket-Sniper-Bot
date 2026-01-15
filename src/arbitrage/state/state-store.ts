import { promises as fs } from 'fs';
import path from 'path';
import type { StateStore } from '../types';

export type PersistedState = {
  marketExposureUsd: Record<string, number>;
  walletExposureUsd: number;
  marketCooldowns: Record<string, number>;
  consecutiveFailures: number;
  tradeTimestamps: number[];
};

export class InMemoryStateStore implements StateStore {
  private readonly snapshotPath: string;
  private readonly snapshotEnabled: boolean;
  private marketExposureUsd: Map<string, number> = new Map();
  private walletExposureUsd = 0;
  private marketCooldowns: Map<string, number> = new Map();
  private consecutiveFailures = 0;
  private tradeTimestamps: number[] = [];

  constructor(stateDir: string, snapshotEnabled: boolean) {
    this.snapshotPath = path.join(stateDir, 'arb_state.json');
    this.snapshotEnabled = snapshotEnabled;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.snapshotPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      this.marketExposureUsd = new Map(Object.entries(parsed.marketExposureUsd || {}));
      this.walletExposureUsd = parsed.walletExposureUsd || 0;
      this.marketCooldowns = new Map(Object.entries(parsed.marketCooldowns || {}));
      this.consecutiveFailures = parsed.consecutiveFailures || 0;
      this.tradeTimestamps = parsed.tradeTimestamps || [];
    } catch {
      // best-effort load
    }
  }

  async snapshot(): Promise<void> {
    if (!this.snapshotEnabled) return;
    const state: PersistedState = {
      marketExposureUsd: Object.fromEntries(this.marketExposureUsd),
      walletExposureUsd: this.walletExposureUsd,
      marketCooldowns: Object.fromEntries(this.marketCooldowns),
      consecutiveFailures: this.consecutiveFailures,
      tradeTimestamps: this.tradeTimestamps,
    };
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, JSON.stringify(state, null, 2), 'utf8');
  }

  getMarketExposure(marketId: string): number {
    return this.marketExposureUsd.get(marketId) ?? 0;
  }

  getWalletExposure(): number {
    return this.walletExposureUsd;
  }

  addExposure(marketId: string, amountUsd: number): void {
    const nextMarket = (this.marketExposureUsd.get(marketId) ?? 0) + amountUsd;
    this.marketExposureUsd.set(marketId, nextMarket);
    this.walletExposureUsd += amountUsd;
  }

  setMarketCooldown(marketId: string, nextAllowedAt: number): void {
    this.marketCooldowns.set(marketId, nextAllowedAt);
  }

  getMarketCooldown(marketId: string): number | undefined {
    return this.marketCooldowns.get(marketId);
  }

  incrementFailure(): void {
    this.consecutiveFailures += 1;
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  recordTradeTimestamp(timestamp: number): void {
    this.tradeTimestamps.push(timestamp);
  }

  countTradesSince(since: number): number {
    this.tradeTimestamps = this.tradeTimestamps.filter((ts) => ts >= since);
    return this.tradeTimestamps.length;
  }
}
