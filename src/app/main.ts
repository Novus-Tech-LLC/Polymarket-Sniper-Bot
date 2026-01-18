import "dotenv/config";
import { loadMonitorConfig, parseCliOverrides } from "../config/loadConfig";
import { createPolymarketClient } from "../infrastructure/clob-client.factory";
import { MempoolMonitorService } from "../services/mempool-monitor.service";
import { TradeExecutorService } from "../services/trade-executor.service";
import { ConsoleLogger } from "../utils/logger.util";
import { getUsdBalanceApprox, getPolBalance } from "../utils/get-balance.util";
import { startArbitrageEngine } from "../arbitrage/runtime";
import { suppressClobOrderbookErrors } from "../utils/console-filter.util";
import { startWireguard } from "../utils/wireguard.util";
import { startOpenvpn } from "../utils/openvpn.util";
import {
  formatClobCredsChecklist,
  isApiKeyCreds,
} from "../utils/clob-credentials.util";
import { ensureTradingReady } from "../polymarket/preflight";
import { getContextAwareWarnings } from "../utils/auth-diagnostic.util";

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const openvpnStarted = await startOpenvpn(logger);
  if (!openvpnStarted) {
    await startWireguard(logger);
  }
  const cliOverrides = parseCliOverrides(process.argv.slice(2));
  const mode = String(
    process.env.MODE ?? process.env.mode ?? "mempool",
  ).toLowerCase();
  logger.info(`Starting Polymarket runtime mode=${mode}`);

  if (mode === "arb" || mode === "both") {
    await startArbitrageEngine(cliOverrides);
  }

  if (mode !== "mempool" && mode !== "both") {
    return;
  }

  const env = loadMonitorConfig(cliOverrides);
  logger.info(formatClobCredsChecklist(env.clobCredsChecklist));

  if (!env.enabled) {
    logger.info(
      `[Monitor] Preset=${env.presetName} disabled; skipping monitor runtime.`,
    );
    return;
  }

  if (!env.clobCredsComplete && !env.clobDeriveEnabled) {
    logger.warn("CLOB creds incomplete");
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

  const clientCredsRaw = (
    client as { creds?: { key?: string; secret?: string; passphrase?: string } }
  ).creds;
  const clientCreds = isApiKeyCreds(clientCredsRaw)
    ? clientCredsRaw
    : undefined;
  const credsComplete = Boolean(clientCreds);
  env.clobCredsComplete = credsComplete;
  env.detectOnly = !credsComplete || env.detectOnly;
  const tradingReady = await ensureTradingReady({
    client,
    logger,
    privateKey: env.privateKey,
    configuredPublicKey: env.proxyWallet,
    rpcUrl: env.rpcUrl,
    detectOnly: env.detectOnly,
    clobCredsComplete: env.clobCredsComplete,
    clobDeriveEnabled: env.clobDeriveEnabled,
    collateralTokenDecimals: env.collateralTokenDecimals,
  });
  env.detectOnly = tradingReady.detectOnly;

  // Check if ARB_LIVE_TRADING is set
  const liveTradingEnabled =
    process.env.ARB_LIVE_TRADING === "I_UNDERSTAND_THE_RISKS";

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
    logger.error("Failed to fetch balances", err as Error);
  }

  // Log prominent trading status banner
  if (env.detectOnly) {
    logger.warn(
      "=====================================================================",
    );
    logger.warn("⚠️  TRADING DISABLED - Running in DETECT-ONLY mode");
    logger.warn(
      "=====================================================================",
    );
    logger.warn("The bot will monitor trades but will NOT submit orders.");
    logger.warn("");

    // Get context-aware warnings based on actual failure reasons
    const warnings = getContextAwareWarnings({
      liveTradingEnabled,
      authOk: tradingReady.authOk,
      approvalsOk: tradingReady.approvalsOk,
      geoblockPassed: tradingReady.geoblockPassed,
    });

    if (warnings.length > 0) {
      logger.warn("Active blockers:");
      warnings.forEach((warning, idx) => {
        logger.warn(`  ${idx + 1}. ${warning}`);
      });
      logger.warn("");
    }

    logger.warn("General troubleshooting:");
    logger.warn("  - Visit https://polymarket.com and connect your wallet");
    logger.warn("  - Make at least one small trade on the website");
    logger.warn("  - Then restart this bot to generate valid API credentials");
    logger.warn(
      "  - Or generate API keys at CLOB_DERIVE_CREDS=true (there is no web UI to manually generate CLOB API keys)",
    );
    logger.warn(
      "=====================================================================",
    );
  } else {
    logger.info(
      "=====================================================================",
    );
    logger.info("✅ TRADING ENABLED - Bot will submit orders");
    logger.info(
      "=====================================================================",
    );
  }

  const executor = new TradeExecutorService({
    client,
    proxyWallet: env.proxyWallet,
    logger,
    env,
  });

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
  console.error("Fatal error", err);
  process.exit(1);
});
