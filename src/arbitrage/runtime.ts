import { ConsoleLogger } from '../utils/logger.util';
import { createPolymarketClient } from '../infrastructure/clob-client.factory';
import { isAuthError } from '../infrastructure/clob-auth';
import { runClobAuthMatrixPreflight, runClobAuthPreflight } from '../clob/diagnostics';
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
import { formatClobCredsChecklist, isApiKeyCreds } from '../utils/clob-credentials.util';
import { formatClobAuthFailureHint } from '../utils/clob-auth-hint.util';

export async function startArbitrageEngine(
  overrides: Record<string, string | undefined> = {},
): Promise<ArbitrageEngine | null> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const config = loadArbConfig(overrides);
  logger.info(formatClobCredsChecklist(config.clobCredsChecklist));

  if (!config.enabled) {
    logger.info(`[ARB] Preset=${config.presetName} disabled (MODE=${process.env.MODE ?? 'arb'})`);
    return null;
  }

  if (!config.clobCredsComplete && !config.clobDeriveEnabled) {
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
    publicKey: config.proxyWallet,
    logger,
  });
  if (client.executionDisabled) {
    config.detectOnly = true;
  }

  const clientCredsRaw = (client as { creds?: { key?: string; secret?: string; passphrase?: string } }).creds;
  const clientCreds = isApiKeyCreds(clientCredsRaw) ? clientCredsRaw : undefined;
  const credsComplete = Boolean(clientCreds);
  config.clobCredsComplete = credsComplete;
  config.detectOnly = !credsComplete || config.detectOnly;
  if (credsComplete) {
    try {
      const matrixEnabled = process.env.CLOB_PREFLIGHT_MATRIX === 'true'
        || process.env.clob_preflight_matrix === 'true';
      if (matrixEnabled) {
        const matrix = await runClobAuthMatrixPreflight({
          client,
          logger,
          creds: clientCreds,
          derivedCreds: client.derivedCreds,
        });
        if (matrix && !matrix.ok) {
          config.detectOnly = true;
        }
      } else {
        const preflight = await runClobAuthPreflight({
          client,
          logger,
          creds: clientCreds,
          derivedSignerAddress: client.derivedSignerAddress,
          configuredPublicKey: config.proxyWallet,
          privateKeyPresent: Boolean(config.privateKey),
          derivedCredsEnabled: config.clobDeriveEnabled,
          force: process.env.CLOB_AUTH_FORCE === 'true',
        });
        if (preflight && !preflight.ok && (preflight.status === 401 || preflight.status === 403)) {
          config.detectOnly = true;
          logger.warn('[CLOB] Auth preflight failed; switching to detect-only.');
          logger.warn(formatClobAuthFailureHint(config.clobDeriveEnabled));
        } else if (preflight && !preflight.ok) {
          logger.warn('[CLOB] Auth preflight failed; continuing with order submissions.');
        }
      }
    } catch (err) {
      const maybeError = err as { code?: string; message?: string };
      if (maybeError?.code === 'ECONNRESET') {
        logger.warn(`[CLOB] Auth preflight transient failure; continuing. ${sanitizeErrorMessage(err)}`);
      } else if (isAuthError(err)) {
        config.detectOnly = true;
        logger.warn(`[CLOB] Auth preflight failed; switching to detect-only. ${sanitizeErrorMessage(err)}`);
        logger.warn(formatClobAuthFailureHint(config.clobDeriveEnabled));
      } else {
        logger.warn(`[CLOB] Auth preflight failed; continuing. ${sanitizeErrorMessage(err)}`);
      }
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
