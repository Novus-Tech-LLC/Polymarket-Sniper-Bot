import 'dotenv/config';
import { loadMonitorConfig, parseCliOverrides } from '../config/loadConfig';
import { createPolymarketClient } from '../infrastructure/clob-client.factory';
import { isAuthError, verifyApiCreds } from '../infrastructure/clob-auth';
import { MempoolMonitorService } from '../services/mempool-monitor.service';
import { TradeExecutorService } from '../services/trade-executor.service';
import { ConsoleLogger } from '../utils/logger.util';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util';
import { startArbitrageEngine } from '../arbitrage/runtime';
import { suppressClobOrderbookErrors } from '../utils/console-filter.util';
import { startWireguard } from '../utils/wireguard.util';
import { startOpenvpn } from '../utils/openvpn.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';
import { formatClobCredsChecklist } from '../utils/clob-credentials.util';
import { formatClobAuthFailureHint } from '../utils/clob-auth-hint.util';

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const openvpnStarted = await startOpenvpn(logger);
  if (!openvpnStarted) {
    await startWireguard(logger);
  }
  const cliOverrides = parseCliOverrides(process.argv.slice(2));
  const mode = String(process.env.MODE ?? process.env.mode ?? 'mempool').toLowerCase();
  logger.info(`Starting Polymarket runtime mode=${mode}`);

  if (mode === 'arb' || mode === 'both') {
    await startArbitrageEngine(cliOverrides);
  }

  if (mode !== 'mempool' && mode !== 'both') {
    return;
  }

  const env = loadMonitorConfig(cliOverrides);
  logger.info(formatClobCredsChecklist(env.clobCredsChecklist));

  if (!env.enabled) {
    logger.info(`[Monitor] Preset=${env.presetName} disabled; skipping monitor runtime.`);
    return;
  }

  if (!env.clobCredsComplete) {
    logger.warn('CLOB creds incomplete');
  }

  const client = await createPolymarketClient({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    apiKey: env.polymarketApiKey,
    apiSecret: env.polymarketApiSecret,
    apiPassphrase: env.polymarketApiPassphrase,
    deriveApiKey: env.clobDeriveEnabled,
    logger,
  });

  const clientCreds = (client as { creds?: { key?: string; secret?: string; passphrase?: string } }).creds;
  const credsComplete = Boolean(clientCreds?.key && clientCreds?.secret && clientCreds?.passphrase);
  env.clobCredsComplete = credsComplete;
  env.detectOnly = !credsComplete;

  if (credsComplete) {
    try {
      const authOk = await verifyApiCreds(client);
      if (!authOk) {
        env.detectOnly = true;
        logger.warn('[CLOB] invalid creds');
        logger.warn('[CLOB] Auth check failed; switching to detect-only.');
        logger.warn(formatClobAuthFailureHint(env.clobDeriveEnabled));
      }
    } catch (err) {
      env.detectOnly = true;
      logger.warn(`[CLOB] Auth check failed; switching to detect-only. ${sanitizeErrorMessage(err)}`);
      if (isAuthError(err)) {
        logger.warn(formatClobAuthFailureHint(env.clobDeriveEnabled));
      }
    }
  }

  // Log balances at startup
  try {
    const polBalance = await getPolBalance(client.wallet);
    const usdcBalance = await getUsdBalanceApprox(
      client.wallet,
      env.collateralTokenAddress,
      env.collateralTokenDecimals,
    );
    logger.info(`Wallet: ${client.wallet.address}`);
    logger.info(`POL Balance: ${polBalance.toFixed(4)} POL`);
    logger.info(`USDC Balance: ${usdcBalance.toFixed(2)} USDC`);
  } catch (err) {
    logger.error('Failed to fetch balances', err as Error);
  }

  const executor = new TradeExecutorService({ client, proxyWallet: env.proxyWallet, logger, env });

  const monitor = new MempoolMonitorService({
    client,
    logger,
    env,
    onDetectedTrade: async (signal) => {
      await executor.frontrunTrade(signal);
    },
  });

  await monitor.start();
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
