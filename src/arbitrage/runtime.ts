import { ConsoleLogger } from "../utils/logger.util";
import { createPolymarketClient } from "../infrastructure/clob-client.factory";
import { loadArbConfig } from "../config/loadConfig";
import { ArbitrageEngine } from "./engine";
import { PolymarketMarketDataProvider } from "./provider/polymarket.provider";
import { IntraMarketArbStrategy } from "./strategy/intra-market.strategy";
import { InMemoryStateStore } from "./state/state-store";
import { ArbRiskManager } from "./risk/risk-manager";
import { ArbTradeExecutor } from "./executor/trade-executor";
import { DecisionLogger } from "./utils/decision-logger";
import { suppressClobOrderbookErrors } from "../utils/console-filter.util";
import {
  formatClobCredsChecklist,
  isApiKeyCreds,
} from "../utils/clob-credentials.util";
import { ensureTradingReady } from "../polymarket/preflight";
import { getContextAwareWarnings } from "../utils/auth-diagnostic.util";
import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";

export async function startArbitrageEngine(
  overrides: Record<string, string | undefined> = {},
  preAuthenticatedClient?: ClobClient & { wallet: Wallet },
  preflightResult?: {
    detectOnly: boolean;
    authOk: boolean;
    approvalsOk: boolean;
    geoblockPassed: boolean;
  },
): Promise<ArbitrageEngine | null> {
  const logger = new ConsoleLogger();
  suppressClobOrderbookErrors(logger);
  const config = loadArbConfig(overrides);
  logger.info(formatClobCredsChecklist(config.clobCredsChecklist));

  if (!config.enabled) {
    logger.info(
      `[ARB] Preset=${config.presetName} disabled (MODE=${process.env.MODE ?? "arb"})`,
    );
    return null;
  }

  if (!config.clobCredsComplete && !config.clobDeriveEnabled) {
    logger.warn("CLOB creds incomplete");
  }

  const overridesInfo = config.overridesApplied.length
    ? ` overrides=${config.overridesApplied.join(",")}`
    : "";
  logger.info(
    `[ARB] Preset=${config.presetName} scan_interval_ms=${config.scanIntervalMs} min_edge_bps=${config.minEdgeBps} min_profit_usd=${config.minProfitUsd} min_liquidity_usd=${config.minLiquidityUsd} max_spread_bps=${config.maxSpreadBps} trade_base_usd=${config.tradeBaseUsd} slippage_bps=${config.slippageBps} fee_bps=${config.feeBps} max_position_usd=${config.maxPositionUsd} max_wallet_exposure_usd=${config.maxWalletExposureUsd} max_trades_per_hour=${config.maxTradesPerHour}${overridesInfo}`,
  );
  logger.info(
    `[ARB] Collateral token address=${config.collateralTokenAddress}`,
  );

  // Use pre-authenticated client if provided (MODE=both), otherwise create new one
  let client: ClobClient & { wallet: Wallet; executionDisabled?: boolean };
  let tradingReady: {
    detectOnly: boolean;
    authOk: boolean;
    approvalsOk: boolean;
    geoblockPassed: boolean;
  };

  if (preAuthenticatedClient && preflightResult) {
    logger.info("[ARB] ⚡ Using pre-authenticated client from main (preflight already completed)");
    client = preAuthenticatedClient;
    tradingReady = preflightResult;
    config.detectOnly = tradingReady.detectOnly;
  } else {
    // Standalone ARB mode - create client and run preflight
    logger.info("[ARB] Creating new CLOB client and running preflight...");
    client = await createPolymarketClient({
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

    const clientCredsRaw = (
      client as { creds?: { key?: string; secret?: string; passphrase?: string } }
    ).creds;
    const clientCreds = isApiKeyCreds(clientCredsRaw)
      ? clientCredsRaw
      : undefined;
    const credsComplete = Boolean(clientCreds);
    config.clobCredsComplete = credsComplete;
    config.detectOnly = !credsComplete || config.detectOnly;
    tradingReady = await ensureTradingReady({
      client,
      logger,
      privateKey: config.privateKey,
      configuredPublicKey: config.proxyWallet,
      rpcUrl: config.rpcUrl,
      detectOnly: config.detectOnly,
      clobCredsComplete: config.clobCredsComplete,
      clobDeriveEnabled: config.clobDeriveEnabled,
      collateralTokenDecimals: config.collateralTokenDecimals,
    });
    config.detectOnly = tradingReady.detectOnly;
  }

  // Check if ARB_LIVE_TRADING is set
  const liveTradingEnabled =
    process.env.ARB_LIVE_TRADING === "I_UNDERSTAND_THE_RISKS";

  // Log prominent trading status banner for ARB mode
  if (config.detectOnly) {
    logger.warn(
      "=====================================================================",
    );
    logger.warn("⚠️  ARB TRADING DISABLED - Running in DETECT-ONLY mode");
    logger.warn(
      "=====================================================================",
    );
    logger.warn(
      "The arbitrage engine will scan for opportunities but will NOT trade.",
    );
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
    logger.info("✅ ARB TRADING ENABLED - Engine will execute trades");
    logger.info(
      "=====================================================================",
    );
  }

  const stateStore = new InMemoryStateStore(
    config.stateDir,
    config.snapshotState,
  );
  await stateStore.load();

  const provider = new PolymarketMarketDataProvider({ client, logger });
  const strategy = new IntraMarketArbStrategy({
    config,
    getExposure: (marketId) => ({
      market: stateStore.getMarketExposure(marketId),
      wallet: stateStore.getWalletExposure(),
    }),
  });
  const riskManager = new ArbRiskManager({
    config,
    state: stateStore,
    logger,
    wallet: client.wallet,
  });
  const executor = new ArbTradeExecutor({ client, provider, config, logger });
  const decisionLogger = config.decisionsLog
    ? new DecisionLogger(config.decisionsLog)
    : undefined;

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
    console.error("[ARB] Engine failed", err);
  });

  return engine;
}
