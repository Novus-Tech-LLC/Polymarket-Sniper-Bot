import { test } from "node:test";
import assert from "node:assert/strict";
import { ArbitrageEngine } from "../../src/arbitrage/engine";
import { IntraMarketArbStrategy } from "../../src/arbitrage/strategy/intra-market.strategy";
import type { ArbConfig } from "../../src/arbitrage/config";
import type {
  MarketDataProvider,
  Opportunity,
  RiskManager,
  TradeExecutor,
  TradePlan,
} from "../../src/arbitrage/types";
import { ConsoleLogger } from "../../src/utils/logger.util";
import type { Logger } from "../../src/utils/logger.util";

class MockProvider implements MarketDataProvider {
  async getActiveMarkets() {
    return [
      {
        marketId: "market-1",
        yesTokenId: "yes",
        noTokenId: "no",
        liquidityUsd: 10000,
      },
    ];
  }

  async getOrderBookTop(tokenId: string) {
    return tokenId === "yes"
      ? { bestAsk: 0.6, bestBid: 0.55 }
      : { bestAsk: 0.6, bestBid: 0.55 };
  }
}

class MockExecutor implements TradeExecutor {
  public calls: TradePlan[] = [];

  async execute(plan: TradePlan) {
    this.calls.push(plan);
    return { status: "dry_run" };
  }
}

class MockRiskManager implements RiskManager {
  public submitted: Opportunity[] = [];

  canExecute() {
    return { allowed: true };
  }

  async ensureGasBalance() {
    return { ok: true, balance: 5 };
  }

  async onTradeSubmitted(opportunity: Opportunity) {
    this.submitted.push(opportunity);
  }

  async onTradeSuccess() {
    return undefined;
  }

  async onTradeFailure() {
    return undefined;
  }
}

class MemoryLogger implements Logger {
  public infoMessages: string[] = [];
  public warnMessages: string[] = [];

  info(msg: string): void {
    this.infoMessages.push(msg);
  }

  warn(msg: string): void {
    this.warnMessages.push(msg);
  }

  error(_msg: string): void {
    return undefined;
  }

  debug(): void {
    return undefined;
  }
}

const baseConfig: ArbConfig = {
  enabled: true,
  scanIntervalMs: 1000,
  minEdgeBps: 250,
  minProfitUsd: 0.25,
  minLiquidityUsd: 5000,
  maxSpreadBps: 1000,
  maxHoldMinutes: 180,
  tradeBaseUsd: 5,
  maxPositionUsd: 25,
  maxWalletExposureUsd: 100,
  sizeScaling: "sqrt",
  slippageBps: 50,
  feeBps: 10,
  startupCooldownSeconds: 0,
  marketCooldownSeconds: 600,
  maxTradesPerHour: 10,
  maxConsecutiveFailures: 2,
  dryRun: true,
  liveTrading: "",
  minPolGas: 2,
  approveUnlimited: false,
  stateDir: "/tmp",
  decisionsLog: "",
  killSwitchFile: "/tmp/arb-kill",
  snapshotState: false,
  maxConcurrentTrades: 1,
  debugTopN: 0,
  unitsAutoFix: true,
  logEveryMarket: false,
  rpcUrl: "http://localhost:8545",
  privateKey: "0x" + "11".repeat(32),
  proxyWallet: undefined,
  polymarketApiKey: undefined,
  polymarketApiSecret: undefined,
  polymarketApiPassphrase: undefined,
  collateralTokenAddress: "0x" + "22".repeat(20),
  collateralTokenDecimals: 6,
};

test("engine scans and produces trade plan in dry run", async () => {
  const provider = new MockProvider();
  const logger = new ConsoleLogger();
  const executor = new MockExecutor();
  const riskManager = new MockRiskManager();
  const strategy = new IntraMarketArbStrategy({
    config: baseConfig,
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const engine = new ArbitrageEngine({
    provider,
    strategy,
    riskManager,
    executor,
    config: baseConfig,
    logger,
  });

  await engine.scanOnce(Date.now());
  assert.equal(executor.calls.length, 1);
  assert.equal(riskManager.submitted.length, 1);
});

test("engine logs top candidates and passes edge threshold", async () => {
  const provider = new MockProvider();
  const logger = new MemoryLogger();
  const executor = new MockExecutor();
  const riskManager = new MockRiskManager();
  const config: ArbConfig = {
    ...baseConfig,
    minEdgeBps: 400,
    minProfitUsd: 0,
    debugTopN: 10,
  };
  const strategy = new IntraMarketArbStrategy({
    config,
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const engine = new ArbitrageEngine({
    provider,
    strategy,
    riskManager,
    executor,
    config,
    logger,
  });

  await engine.scanOnce(Date.now());
  assert.equal(executor.calls.length, 1);
  const logLine = logger.infoMessages.find((msg) =>
    msg.includes("TopCandidates"),
  );
  assert.ok(logLine);
  assert.ok(logLine?.includes("market-1"));
});

test("engine does not treat bid-only markets as opportunities", async () => {
  class BidOnlyProvider extends MockProvider {
    async getOrderBookTop(tokenId: string) {
      return tokenId === "yes"
        ? { bestAsk: 0, bestBid: 0.8 }
        : { bestAsk: 0, bestBid: 0.8 };
    }
  }

  const provider = new BidOnlyProvider();
  const logger = new MemoryLogger();
  const executor = new MockExecutor();
  const riskManager = new MockRiskManager();
  const config: ArbConfig = {
    ...baseConfig,
    minEdgeBps: 0,
    minProfitUsd: 0,
    debugTopN: 0,
  };
  const strategy = new IntraMarketArbStrategy({
    config,
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const engine = new ArbitrageEngine({
    provider,
    strategy,
    riskManager,
    executor,
    config,
    logger,
  });

  await engine.scanOnce(Date.now());
  assert.equal(executor.calls.length, 0);
});
