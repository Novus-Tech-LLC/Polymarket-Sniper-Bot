import { promises as fs } from 'fs';
import path from 'path';

export type DecisionLogEntry = {
  ts: string;
  market_id: string;
  yes_ask: number;
  no_ask: number;
  edge_bps: number;
  liquidity?: number;
  spread_bps?: number;
  est_profit_usd: number;
  action: string;
  reason?: string;
  planned_size?: number;
  tx_hash?: string;
  status?: string;
};

export class DecisionLogger {
  private readonly path?: string;

  constructor(path?: string) {
    this.path = path || undefined;
  }

  async append(entry: DecisionLogEntry): Promise<void> {
    if (!this.path) return;
    const line = `${JSON.stringify(entry)}\n`;
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.appendFile(this.path, line, { encoding: 'utf8' });
  }
}
