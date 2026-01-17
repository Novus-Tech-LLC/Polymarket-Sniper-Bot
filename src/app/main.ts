import 'dotenv/config';
import { loadMonitorConfig, parseCliOverrides } from '../config/loadConfig';
import { createPolymarketClient } from '../infrastructure/clob-client.factory';
import { isAuthError } from '../infrastructure/clob-auth';
import { runClobAuthMatrixPreflight, runClobAuthPreflight } from '../clob/diagnostics';
import { MempoolMonitorService } from '../services/mempool-monitor.service';
import { TradeExecutorService } from '../services/trade-executor.service';
import { ConsoleLogger } from '../utils/logger.util';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util';
import { startArbitrageEngine } from '../arbitrage/runtime';
import { suppressClobOrderbookErrors } from '../utils/console-filter.util';
import { startWireguard } from '../utils/wireguard.util';
import { startOpenvpn } from '../utils/openvpn.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';
import { formatClobCredsChecklist, isApiKeyCreds } from '../utils/clob-credentials.util';
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

  if (!env.clobCredsComplete && !env.clobDeriveEnabled) {
    logger.warn('CLOB creds incomplete');
  }

  const client = await createPolymarketClient({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    apiKey: env.polymarketApiKey,
    apiSecret: env.polymarketApiSecret,
    apiPassphrase: env.polymarketApiPassphrase,
    deriveApiKey: env.clobDeriveEnabled,
    publicKey: env.proxyWallet,
    logger,
  });
  if (client.executionDisabled) {
    env.detectOnly = true;
  }

  const clientCredsRaw = (client as { creds?: { key?: string; secret?: string; passphrase?: string } }).creds;
  const clientCreds = isApiKeyCreds(clientCredsRaw) ? clientCredsRaw : undefined;
  const credsComplete = Boolean(clientCreds);
  env.clobCredsComplete = credsComplete;
  env.detectOnly = !credsComplete || env.detectOnly;

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
          env.detectOnly = true;
        }
      } else {
        const preflight = await runClobAuthPreflight({
          client,
          logger,
          creds: clientCreds,
          derivedSignerAddress: client.derivedSignerAddress,
          configuredPublicKey: env.proxyWallet,
          privateKeyPresent: Boolean(env.privateKey),
          derivedCredsEnabled: env.clobDeriveEnabled,
          force: process.env.CLOB_AUTH_FORCE === 'true',
        });
        if (preflight && !preflight.ok && (preflight.status === 401 || preflight.status === 403)) {
          env.detectOnly = true;
          logger.warn('[CLOB] Auth preflight failed; switching to detect-only.');
          logger.warn(formatClobAuthFailureHint(env.clobDeriveEnabled));
        } else if (preflight && !preflight.ok) {
          logger.warn('[CLOB] Auth preflight failed; continuing with order submissions.');
        }
      }
    } catch (err) {
      const maybeError = err as { code?: string; message?: string };
      if (maybeError?.code === 'ECONNRESET') {
        logger.warn(`[CLOB] Auth preflight transient failure; continuing. ${sanitizeErrorMessage(err)}`);
      } else if (isAuthError(err)) {
        env.detectOnly = true;
        logger.warn(`[CLOB] Auth preflight failed; switching to detect-only. ${sanitizeErrorMessage(err)}`);
        logger.warn(formatClobAuthFailureHint(env.clobDeriveEnabled));
      } else {
        logger.warn(`[CLOB] Auth preflight failed; continuing. ${sanitizeErrorMessage(err)}`);
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
