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
import { formatClobCredsChecklist } from "../utils/clob-credentials.util";
import { ensureTradingReady } from "../polymarket/preflight";
import { getContextAwareWarnings } from "../utils/auth-diagnostic.util";
import { Orchestrator, createOrchestrator } from "../strategies/orchestrator";
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
  // Uses reliable strategies for reliable, easy-to-debug trading
  let orchestrator: Orchestrator | undefined;
  if (strategyConfig && strategyConfig.enabled && !tradingReady.detectOnly) {
    logger.info(
      `🎯 Starting strategy orchestrator (preset: ${strategyConfig.presetName})`,
    );
    logger.info(
      `📊 Config: MAX_POSITION_USD=$${strategyConfig.endgameMaxPositionUsd}, ` +
        `SMART_HEDGING=${strategyConfig.smartHedgingEnabled ? "ON" : "OFF"}, ` +
        `ABSOLUTE_MAX=$${strategyConfig.smartHedgingAbsoluteMaxUsd}`,
    );

    // Load env config for balance fetching (needed for dynamic reserves)
    const envForBalances = loadMonitorConfig(cliOverrides);

    // Create orchestrator with user's config
    orchestrator = new Orchestrator({
      client,
      logger,
      maxPositionUsd: strategyConfig.endgameMaxPositionUsd,
      riskPreset: strategyConfig.presetName as
        | "conservative"
        | "balanced"
        | "aggressive",
      // Provide wallet balance fetcher for dynamic reserves to work
      // This enables the reserve system to track USDC balance and gate BUY orders
      getWalletBalances: async () => ({
        usdcBalance: await getUsdBalanceApprox(
          client.wallet,
          envForBalances.collateralTokenAddress,
          envForBalances.collateralTokenDecimals,
        ),
      }),
      // Pass hedging config from env
      hedgingConfig: {
        enabled: strategyConfig.smartHedgingEnabled,
        triggerLossPct: strategyConfig.smartHedgingTriggerLossPct,
        maxHedgeUsd: strategyConfig.smartHedgingMaxHedgeUsd,
        absoluteMaxUsd: strategyConfig.smartHedgingAbsoluteMaxUsd,
        allowExceedMax: strategyConfig.smartHedgingAllowExceedMax,
        forceLiquidationPct: strategyConfig.smartHedgingForceLiquidationLossPct,
        // Near-close hedging behavior
        nearCloseWindowMinutes:
          strategyConfig.smartHedgingNearCloseWindowMinutes,
        nearClosePriceDropCents:
          strategyConfig.smartHedgingNearClosePriceDropCents,
        nearCloseLossPct: strategyConfig.smartHedgingNearCloseLossPct,
        noHedgeWindowMinutes: strategyConfig.smartHedgingNoHedgeWindowMinutes,
        // Smart hedging direction and "hedge up" settings
        direction: strategyConfig.smartHedgingDirection,
        hedgeUpPriceThreshold: strategyConfig.smartHedgingHedgeUpPriceThreshold,
        hedgeUpMaxPrice: strategyConfig.smartHedgingHedgeUpMaxPrice,
        hedgeUpWindowMinutes: strategyConfig.smartHedgingHedgeUpWindowMinutes,
        hedgeUpMaxUsd: strategyConfig.smartHedgingHedgeUpMaxUsd,
      },
      // Quick flip module removed - functionality covered by ScalpTakeProfit
      // Pass endgame config
      endgameConfig: {
        enabled: strategyConfig.endgameSweepEnabled,
        minPrice: strategyConfig.endgameMinPrice,
        maxPrice: strategyConfig.endgameMaxPrice,
      },
      // Pass stop-loss config from preset
      stopLossConfig: {
        minHoldSeconds: strategyConfig.stopLossMinHoldSeconds,
      },
      // Pass scalp take-profit config
      scalpConfig: {
        enabled: strategyConfig.scalpTakeProfitEnabled,
        minHoldMinutes: strategyConfig.scalpMinHoldMinutes,
        maxHoldMinutes: strategyConfig.scalpMaxHoldMinutes,
        minProfitPct: strategyConfig.scalpMinProfitPct,
        targetProfitPct: strategyConfig.scalpTargetProfitPct,
        minProfitUsd: strategyConfig.scalpMinProfitUsd,
        resolutionExclusionPrice: strategyConfig.scalpResolutionExclusionPrice,
        suddenSpikeEnabled: strategyConfig.scalpSuddenSpikeEnabled,
        suddenSpikeThresholdPct: strategyConfig.scalpSuddenSpikeThresholdPct,
        suddenSpikeWindowMinutes: strategyConfig.scalpSuddenSpikeWindowMinutes,
        lowPriceThreshold: strategyConfig.scalpLowPriceThreshold,
        lowPriceMaxHoldMinutes: strategyConfig.scalpLowPriceMaxHoldMinutes,
        legacyPositionMode: strategyConfig.scalpLegacyPositionMode,
      },
    });

    await orchestrator.start();
    logger.info("✅ Simplified strategy orchestrator started successfully");

    // Set session start balance for accurate drawdown calculation
    try {
      const usdcBalance = await getUsdBalanceApprox(
        client.wallet,
        envForBalances.collateralTokenAddress,
        envForBalances.collateralTokenDecimals,
      );
      orchestrator.getRiskManager().setSessionStartBalance(usdcBalance);
      logger.info(`💰 Session start balance: $${usdcBalance.toFixed(2)}`);
    } catch (err) {
      logger.warn(
        `[Orchestrator] Could not set session balance: ${err instanceof Error ? err.message : String(err)}`,
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
      // Pass dynamic reserves controller to gate BUY orders when reserves are insufficient
      // NOTE: Does NOT block hedging/SELL paths since they help recover reserves
      dynamicReserves: orchestrator?.getDynamicReserves(),
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

/**
 * Global error handlers to prevent crashes from unhandled errors.
 * These are safety nets for transient RPC errors (rate limits, network issues)
 * that might escape normal try/catch blocks.
 */

/**
 * Check if an error message indicates a transient RPC/network error
 * that shouldn't crash the bot. These errors typically resolve on retry.
 */
function isTransientRpcError(errorMsg: string): boolean {
  return (
    errorMsg.includes("Too Many Requests") ||
    errorMsg.includes("-32005") ||
    errorMsg.includes("-32000") ||
    errorMsg.includes("BAD_DATA") ||
    errorMsg.includes("missing response for request") ||
    errorMsg.includes("REPLACEMENT_UNDERPRICED") ||
    errorMsg.includes("replacement fee too low") ||
    errorMsg.includes("in-flight transaction limit") ||
    errorMsg.includes("rate limit") ||
    errorMsg.includes("ECONNRESET") ||
    errorMsg.includes("ETIMEDOUT") ||
    errorMsg.includes("socket hang up")
  );
}

// Handle unhandled promise rejections (async errors)
process.on("unhandledRejection", (reason) => {
  const errorMsg = reason instanceof Error ? reason.message : String(reason);

  if (isTransientRpcError(errorMsg)) {
    console.warn(
      `[UnhandledRejection] ⚠️ Transient error (bot continues): ${errorMsg}`,
    );
  } else {
    console.error(
      `[UnhandledRejection] ❌ Unhandled promise rejection:`,
      reason,
    );
    // For non-transient errors, log but don't crash
    // The specific strategy/service should handle retries
  }
});

// Handle uncaught exceptions (sync errors)
process.on("uncaughtException", (error) => {
  const errorMsg = error.message;

  if (isTransientRpcError(errorMsg)) {
    console.warn(
      `[UncaughtException] ⚠️ Transient error (bot continues): ${errorMsg}`,
    );
  } else {
    console.error(`[UncaughtException] ❌ Uncaught exception:`, error);
    // For truly fatal errors, exit after logging
    // Give time for logs to flush
    setTimeout(() => process.exit(1), 1000);
  }
});

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});
