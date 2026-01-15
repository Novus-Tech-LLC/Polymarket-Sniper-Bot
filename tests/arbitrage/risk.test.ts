import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { ArbRiskManager } from '../../src/arbitrage/risk/risk-manager';
import { InMemoryStateStore } from '../../src/arbitrage/state/state-store';
import type { ArbConfig } from '../../src/arbitrage/config';
import type { Opportunity } from '../../src/arbitrage/types';
import { ConsoleLogger } from '../../src/utils/logger.util';

function buildConfig(overrides: Partial<ArbConfig> = {}): ArbConfig {
  return {
    enabled: true,
    scanIntervalMs: 1000,
    minEdgeBps: 250,
    minProfitUsd: 0.25,
    minLiquidityUsd: 0,
    maxSpreadBps: 200,
    maxHoldMinutes: 180,
    tradeBaseUsd: 5,
    maxPositionUsd: 25,
    maxWalletExposureUsd: 100,
    sizeScaling: 'sqrt',
    slippageBps: 50,
    feeBps: 10,
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
    killSwitchFile: path.join(os.tmpdir(), 'arb-kill'),
    snapshotState: false,
    maxConcurrentTrades: 1,
    rpcUrl: 'http://localhost:8545',
    privateKey: '0x' + '11'.repeat(32),
    proxyWallet: undefined,
    polymarketApiKey: undefined,
    polymarketApiSecret: undefined,
    polymarketApiPassphrase: undefined,
    collateralTokenAddress: '0x' + '22'.repeat(20),
    collateralTokenDecimals: 6,
    ...overrides,
  };
}

function sampleOpportunity(): Opportunity {
  return {
    marketId: 'market-1',
    yesTokenId: 'yes',
    noTokenId: 'no',
    yesAsk: 0.6,
    noAsk: 0.6,
    edgeBps: 2000,
    estProfitUsd: 1,
    sizeUsd: 5,
    sizeTier: 1,
  };
}

test('risk manager enforces kill switch and circuit breaker', async () => {
  const logger = new ConsoleLogger();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-state-'));
  const config = buildConfig({ stateDir });
  const state = new InMemoryStateStore(stateDir, false);
  await state.load();
  const wallet = new Wallet(config.privateKey);
  const risk = new ArbRiskManager({ config, state, logger, wallet });

  fs.writeFileSync(config.killSwitchFile, 'STOP');
  const decision = risk.canExecute(sampleOpportunity(), Date.now());
  assert.equal(decision.allowed, false);
  fs.unlinkSync(config.killSwitchFile);

  state.incrementFailure();
  state.incrementFailure();
  const breakerDecision = risk.canExecute(sampleOpportunity(), Date.now());
  assert.equal(breakerDecision.allowed, false);
});

test('risk manager enforces idempotency after submission', async () => {
  const logger = new ConsoleLogger();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-state-'));
  const config = buildConfig({ stateDir, startupCooldownSeconds: 0 });
  const state = new InMemoryStateStore(stateDir, false);
  await state.load();
  const wallet = new Wallet(config.privateKey);
  const risk = new ArbRiskManager({ config, state, logger, wallet });
  const opportunity = sampleOpportunity();
  const now = Date.now();

  const first = risk.canExecute(opportunity, now);
  assert.equal(first.allowed, true);
  await risk.onTradeSubmitted(opportunity, now);

  const second = risk.canExecute(opportunity, now);
  assert.equal(second.allowed, false);
});
