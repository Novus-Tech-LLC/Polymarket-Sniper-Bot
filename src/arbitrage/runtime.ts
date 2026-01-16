import { ConsoleLogger } from '../utils/logger.util';
import { createPolymarketClient } from '../infrastructure/clob-client.factory';
import { loadArbConfig } from './config';
import { ArbitrageEngine } from './engine';
import { PolymarketMarketDataProvider } from './provider/polymarket.provider';
import { IntraMarketArbStrategy } from './strategy/intra-market.strategy';
import { InMemoryStateStore } from './state/state-store';
import { ArbRiskManager } from './risk/risk-manager';
import { ArbTradeExecutor } from './executor/trade-executor';
import { DecisionLogger } from './utils/decision-logger';
import { suppressClobOrderbookErrors } from '../utils/console-filter.util';

export async function startArbitrageEngine(overrides: Record<string, string | undefined> = {}): Promise<ArbitrageEngine> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const config = loadArbConfig(overrides);

  const client = await createPolymarketClient({
    rpcUrl: config.rpcUrl,
    privateKey: config.privateKey,
    apiKey: config.polymarketApiKey,
    apiSecret: config.polymarketApiSecret,
    apiPassphrase: config.polymarketApiPassphrase,
  });

  const stateStore = new InMemoryStateStore(config.stateDir, config.snapshotState);
  await stateStore.load();

  const provider = new PolymarketMarketDataProvider({ client, logger });
  const strategy = new IntraMarketArbStrategy({
    config,
    getExposure: (marketId) => ({
      market: stateStore.getMarketExposure(marketId),
      wallet: stateStore.getWalletExposure(),
    }),
  });
  const riskManager = new ArbRiskManager({ config, state: stateStore, logger, wallet: client.wallet });
  const executor = new ArbTradeExecutor({ client, provider, config, logger });
  const decisionLogger = config.decisionsLog ? new DecisionLogger(config.decisionsLog) : undefined;

  const engine = new ArbitrageEngine({
    provider,
    strategy,
    riskManager,
    executor,
    config,
    logger,
    decisionLogger,
  });

  engine.start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ARB] Engine failed', err);
  });

  return engine;
}
