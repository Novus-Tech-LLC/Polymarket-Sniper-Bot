import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntraMarketArbStrategy } from '../../src/arbitrage/strategy/intra-market.strategy';
import type { ArbConfig } from '../../src/arbitrage/config';
import type { MarketSnapshot } from '../../src/arbitrage/types';

const baseConfig: ArbConfig = {
  enabled: true,
  scanIntervalMs: 1000,
  minEdgeBps: 300,
  minProfitUsd: 0,
  minLiquidityUsd: 0,
  maxSpreadBps: 1000,
  maxHoldMinutes: 180,
  tradeBaseUsd: 5,
  maxPositionUsd: 25,
  maxWalletExposureUsd: 100,
  sizeScaling: 'sqrt',
  slippageBps: 0,
  feeBps: 0,
  startupCooldownSeconds: 0,
  marketCooldownSeconds: 600,
  maxTradesPerHour: 10,
  maxConsecutiveFailures: 2,
  dryRun: true,
  liveTrading: '',
  minPolGas: 2,
  approveUnlimited: false,
  stateDir: '/tmp',
  decisionsLog: '',
  killSwitchFile: '/tmp/arb-kill',
  snapshotState: false,
  maxConcurrentTrades: 1,
  debugTopN: 0,
  unitsAutoFix: true,
  logEveryMarket: false,
  rpcUrl: 'http://localhost:8545',
  privateKey: '0x' + '11'.repeat(32),
  proxyWallet: undefined,
  polymarketApiKey: undefined,
  polymarketApiSecret: undefined,
  polymarketApiPassphrase: undefined,
  collateralTokenAddress: '0x' + '22'.repeat(20),
  collateralTokenDecimals: 6,
};

test('strategy uses asks for edge calculations', () => {
  const strategy = new IntraMarketArbStrategy({
    config: baseConfig,
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const markets: MarketSnapshot[] = [
    {
      marketId: 'market-1',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 10000,
      yesTop: { bestAsk: 0.52, bestBid: 0.519 },
      noTop: { bestAsk: 0.52, bestBid: 0.519 },
    },
  ];

  const opportunities = strategy.findOpportunities(markets, Date.now());
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].yesAsk, 0.52);
});

test('strategy auto-fixes cents to probability units when enabled', () => {
  const strategy = new IntraMarketArbStrategy({
    config: { ...baseConfig, minEdgeBps: 0 },
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const markets: MarketSnapshot[] = [
    {
      marketId: 'market-1',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 10000,
      yesTop: { bestAsk: 53, bestBid: 52 },
      noTop: { bestAsk: 53, bestBid: 52 },
    },
  ];

  const opportunities = strategy.findOpportunities(markets, Date.now());
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].yesAsk, 0.53);
});

test('strategy treats missing bids as bad books', () => {
  const strategy = new IntraMarketArbStrategy({
    config: { ...baseConfig, minEdgeBps: 0, maxSpreadBps: 5 },
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const markets: MarketSnapshot[] = [
    {
      marketId: 'missing-bid',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 10000,
      yesTop: { bestAsk: 0.6, bestBid: 0 },
      noTop: { bestAsk: 0.4, bestBid: 0.39 },
    },
  ];

  strategy.findOpportunities(markets, Date.now());
  const diagnostics = strategy.getDiagnostics();
  assert.equal(diagnostics.skipCounts.SKIP_BAD_BOOK, 1);
  assert.equal(diagnostics.skipCounts.SKIP_WIDE_SPREAD, 0);
});

test('strategy increments skip reason histogram correctly', () => {
  const now = Date.now();
  const config: ArbConfig = {
    ...baseConfig,
    minEdgeBps: 300,
    minProfitUsd: 100,
    minLiquidityUsd: 1000,
    maxSpreadBps: 50,
    maxHoldMinutes: 60,
    tradeBaseUsd: 1,
    maxPositionUsd: 1,
    maxWalletExposureUsd: 1,
    unitsAutoFix: false,
  };
  const strategy = new IntraMarketArbStrategy({
    config,
    getExposure: () => ({ market: 0, wallet: 0 }),
  });

  const markets: MarketSnapshot[] = [
    {
      marketId: 'low-liq',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 500,
      yesTop: { bestAsk: 0.6, bestBid: 0.59 },
      noTop: { bestAsk: 0.6, bestBid: 0.59 },
    },
    {
      marketId: 'bad-book',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 2000,
      yesTop: { bestAsk: 0, bestBid: 0.8 },
      noTop: { bestAsk: 0.6, bestBid: 0.59 },
    },
    {
      marketId: 'units',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 2000,
      yesTop: { bestAsk: 250, bestBid: 240 },
      noTop: { bestAsk: 250, bestBid: 240 },
    },
    {
      marketId: 'wide-spread',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 2000,
      yesTop: { bestAsk: 0.6, bestBid: 0.1 },
      noTop: { bestAsk: 0.6, bestBid: 0.1 },
    },
    {
      marketId: 'low-edge',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 2000,
      yesTop: { bestAsk: 0.4, bestBid: 0.39 },
      noTop: { bestAsk: 0.4, bestBid: 0.39 },
    },
    {
      marketId: 'low-profit',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 2000,
      yesTop: { bestAsk: 0.6, bestBid: 0.599 },
      noTop: { bestAsk: 0.6, bestBid: 0.599 },
    },
    {
      marketId: 'too-far',
      yesTokenId: 'yes',
      noTokenId: 'no',
      liquidityUsd: 2000,
      endTime: now + 2 * 60 * 60 * 1000,
      yesTop: { bestAsk: 0.6, bestBid: 0.59 },
      noTop: { bestAsk: 0.6, bestBid: 0.59 },
    },
  ];

  strategy.findOpportunities(markets, now);
  const diagnostics = strategy.getDiagnostics();
  assert.equal(diagnostics.skipCounts.SKIP_LOW_LIQ, 1);
  assert.equal(diagnostics.skipCounts.SKIP_BAD_BOOK, 1);
  assert.equal(diagnostics.skipCounts.SKIP_UNITS, 1);
  assert.equal(diagnostics.skipCounts.SKIP_WIDE_SPREAD, 1);
  assert.equal(diagnostics.skipCounts.SKIP_LOW_EDGE, 1);
  assert.equal(diagnostics.skipCounts.SKIP_LOW_PROFIT, 1);
  assert.equal(diagnostics.skipCounts.SKIP_OTHER, 1);
});
