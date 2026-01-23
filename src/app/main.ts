import "dotenv/config";
import {
  loadMonitorConfig,
  loadArbConfig,
  loadStrategyConfig,
  parseCliOverrides,
} from "../config/loadConfig";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";
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
import { StrategyOrchestrator } from "../strategies/orchestrator";
import { isLiveTradingEnabled } from "../utils/live-trading.util";

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const openvpnStarted = await startOpenvpn(logger);
  if (!openvpnStarted) {
    await startWireguard(logger);
  }
  const cliOverrides = parseCliOverrides(process.argv.slice(2));

  // Check if unified STRATEGY_PRESET is configured
  const strategyConfig = loadStrategyConfig(cliOverrides);

  const mode = String(
    process.env.MODE ?? process.env.mode ?? "mempool",
  ).toLowerCase();
  logger.info(`🚀 Starting Polymarket runtime mode=${mode}`);

  // Run authentication and preflight ONCE at top level before starting any engines
  // This ensures MODE=both only runs preflight once, not twice
  logger.info("🔐 Authenticating with Polymarket...");
  const auth = createPolymarketAuthFromEnv(logger);

  const authResult = await auth.authenticate();
  if (!authResult.success) {
    logger.error(`❌ Authentication failed: ${authResult.error}`);
    logger.error("Cannot proceed without valid credentials");
    return;
  }
  logger.info(`✅ Authentication successful`);

  // Get authenticated CLOB client (already has wallet with provider)
  const client = await auth.getClobClient();

  // Load config to get parameters for preflight
  // For MODE=both, prefer ARB config as it has all necessary parameters
  const env =
    mode === "arb" || mode === "both"
      ? loadArbConfig(cliOverrides)
      : loadMonitorConfig(cliOverrides);

  // Run preflight ONCE for all modes
  logger.info("🔍 Running preflight checks...");
  const tradingReady = await ensureTradingReady({
    client,
    logger,
    privateKey: env.privateKey,
    configuredPublicKey: env.proxyWallet,
    rpcUrl: env.rpcUrl,
    detectOnly: false,
    clobCredsComplete: true,
    clobDeriveEnabled: env.clobDeriveEnabled,
    collateralTokenDecimals: env.collateralTokenDecimals,
  });

  // Start unified strategy orchestrator if STRATEGY_PRESET is configured
  // Hoist orchestrator variable so its position tracker can be shared with TradeExecutorService
  let orchestrator: StrategyOrchestrator | undefined;
  if (strategyConfig && strategyConfig.enabled && !tradingReady.detectOnly) {
    logger.info(
      `🎯 Starting unified strategy orchestrator (preset: ${strategyConfig.presetName})`,
    );

    orchestrator = new StrategyOrchestrator({
      client,
      logger,
      arbEnabled: strategyConfig.arbEnabled,
      monitorEnabled: strategyConfig.monitorEnabled,
      quickFlipConfig: {
        enabled: strategyConfig.quickFlipEnabled,
        targetPct: strategyConfig.quickFlipTargetPct,
        stopLossPct: strategyConfig.quickFlipStopLossPct,
        minHoldSeconds: strategyConfig.quickFlipMinHoldSeconds,
        minOrderUsd: strategyConfig.minOrderUsd,
        minProfitUsd: strategyConfig.quickFlipMinProfitUsd,
        dynamicTargets: strategyConfig.quickFlipDynamicTargets,
      },
      autoSellConfig: {
        enabled: strategyConfig.autoSellEnabled,
        threshold: strategyConfig.autoSellThreshold,
        minHoldSeconds: strategyConfig.autoSellMinHoldSeconds,
        minOrderUsd: strategyConfig.minOrderUsd,
        // Dispute window exit - sell at 99.9¢ to exit positions in dispute hold
        disputeWindowExitEnabled: true, // Always enabled for faster capital recovery
        disputeWindowExitPrice: 0.999, // Sell at 99.9¢ (others are doing this)
      },
      endgameSweepConfig: {
        enabled: strategyConfig.endgameSweepEnabled,
        minPrice: strategyConfig.endgameMinPrice,
        maxPrice: strategyConfig.endgameMaxPrice,
        maxPositionUsd: strategyConfig.endgameMaxPositionUsd,
      },
      autoRedeemConfig: {
        enabled: strategyConfig.autoRedeemEnabled,
        minPositionUsd: strategyConfig.autoRedeemMinPositionUsd,
        checkIntervalMs: strategyConfig.autoRedeemCheckIntervalMs,
      },
    });

    await orchestrator.start();
    logger.info("✅ Strategy orchestrator started successfully");

    // Log auto-redeem check interval for user clarity
    if (strategyConfig.autoRedeemEnabled) {
      const intervalSec = strategyConfig.autoRedeemCheckIntervalMs / 1000;
      logger.info(
        `💵 Auto-Redeem: Checking for redeemable positions every ${intervalSec} seconds`,
      );
    }
  } else if (strategyConfig && !strategyConfig.enabled) {
    logger.info(
      `[Strategy] Preset=${strategyConfig.presetName} disabled; using individual ARB/MONITOR presets.`,
    );
  }

  // Start ARB engine if configured, passing pre-authenticated client
  if (mode === "arb" || mode === "both") {
    await startArbitrageEngine(cliOverrides, client, tradingReady);
  }

  // Start MEMPOOL monitor if configured, using same authenticated client
  if (mode === "mempool" || mode === "both") {
    const mempoolEnv = loadMonitorConfig(cliOverrides);
    logger.info(formatClobCredsChecklist(mempoolEnv.clobCredsChecklist));

    if (!mempoolEnv.enabled) {
      logger.info(
        `[Monitor] Preset=${mempoolEnv.presetName} disabled; skipping monitor runtime.`,
      );
      return;
    }

    // Update config with preflight results
    mempoolEnv.clobCredsComplete = true;
    mempoolEnv.detectOnly = tradingReady.detectOnly;

    // Check if live trading is enabled (supports both ARB_LIVE_TRADING and LIVE_TRADING)
    const liveTradingEnabled = isLiveTradingEnabled();

    // Log balances at startup
    try {
      const polBalance = await getPolBalance(client.wallet);
      const usdcBalance = await getUsdBalanceApprox(
        client.wallet,
        mempoolEnv.collateralTokenAddress,
        mempoolEnv.collateralTokenDecimals,
      );
      logger.info(`💳 Wallet: ${client.wallet.address}`);
      logger.info(`⛽ POL Balance: ${polBalance.toFixed(4)} POL`);
      logger.info(`💵 USDC Balance: ${usdcBalance.toFixed(2)} USDC`);
    } catch (err) {
      logger.error("❌ Failed to fetch balances", err as Error);
    }

    // Log prominent trading status banner for MEMPOOL mode
    if (mempoolEnv.detectOnly) {
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
      logger.warn(
        "  - Then restart this bot to generate valid API credentials",
      );
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
      logger.info(
        "✅ MEMPOOL MONITOR TRADING ENABLED - Bot will submit orders",
      );
      logger.info(
        "=====================================================================",
      );
    }

    const executor = new TradeExecutorService({
      client,
      proxyWallet: mempoolEnv.proxyWallet,
      logger,
      env: mempoolEnv,
      // Pass position tracker to prevent buying positions we already own (avoids stacking)
      // NOTE: Does NOT block hedging - hedges use a different tokenId (opposite outcome)
      positionTracker: orchestrator?.getPositionTracker(),
    });

    const monitor = new MempoolMonitorService({
      client,
      logger,
      env: mempoolEnv,
      onDetectedTrade: async (signal) => {
        await executor.frontrunTrade(signal);
      },
    });

    await monitor.start();
  }
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
