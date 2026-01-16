import { ConsoleLogger } from '../utils/logger.util';
import { createPolymarketClient } from '../infrastructure/clob-client.factory';
import { verifyApiCreds } from '../infrastructure/clob-auth';
import { loadArbConfig } from '../config/loadConfig';
import { ArbitrageEngine } from './engine';
import { PolymarketMarketDataProvider } from './provider/polymarket.provider';
import { IntraMarketArbStrategy } from './strategy/intra-market.strategy';
import { InMemoryStateStore } from './state/state-store';
import { ArbRiskManager } from './risk/risk-manager';
import { ArbTradeExecutor } from './executor/trade-executor';
import { DecisionLogger } from './utils/decision-logger';
import { suppressClobOrderbookErrors } from '../utils/console-filter.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';

export async function startArbitrageEngine(
  overrides: Record<string, string | undefined> = {},
): Promise<ArbitrageEngine | null> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const config = loadArbConfig(overrides);

  if (!config.enabled) {
    logger.info(`[ARB] Preset=${config.presetName} disabled (MODE=${process.env.MODE ?? 'arb'})`);
    return null;
  }

  if (!config.clobCredsComplete) {
    logger.warn('CLOB creds incomplete');
  }

  const overridesInfo = config.overridesApplied.length ? ` overrides=${config.overridesApplied.join(',')}` : '';
  logger.info(
    `[ARB] Preset=${config.presetName} scan_interval_ms=${config.scanIntervalMs} min_edge_bps=${config.minEdgeBps} min_profit_usd=${config.minProfitUsd} min_liquidity_usd=${config.minLiquidityUsd} max_spread_bps=${config.maxSpreadBps} trade_base_usd=${config.tradeBaseUsd} slippage_bps=${config.slippageBps} fee_bps=${config.feeBps} max_position_usd=${config.maxPositionUsd} max_wallet_exposure_usd=${config.maxWalletExposureUsd} max_trades_per_hour=${config.maxTradesPerHour}${overridesInfo}`,
  );
  logger.info(`[ARB] Collateral token address=${config.collateralTokenAddress}`);

  const client = await createPolymarketClient({
    rpcUrl: config.rpcUrl,
    privateKey: config.privateKey,
    apiKey: config.polymarketApiKey,
    apiSecret: config.polymarketApiSecret,
    apiPassphrase: config.polymarketApiPassphrase,
    deriveApiKey: config.clobDeriveEnabled,
    logger,
  });

  const clientCreds = (client as { creds?: { key?: string; secret?: string; passphrase?: string } }).creds;
  const credsComplete = Boolean(clientCreds?.key && clientCreds?.secret && clientCreds?.passphrase);
  config.clobCredsComplete = credsComplete;
  config.detectOnly = !credsComplete;
  if (credsComplete) {
    try {
      const authOk = await verifyApiCreds(client);
      if (!authOk) {
        config.detectOnly = true;
        logger.warn('[CLOB] Auth check failed; switching to detect-only.');
      }
    } catch (err) {
      config.detectOnly = true;
      logger.warn(`[CLOB] Auth check failed; switching to detect-only. ${sanitizeErrorMessage(err)}`);
    }
  }

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
