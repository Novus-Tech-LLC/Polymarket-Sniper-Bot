import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetType } from '@polymarket/clob-client';
import { checkFundsAndAllowance } from '../../src/utils/funds-allowance.util';

const createLogger = () => ({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
});

test('checkFundsAndAllowance refresh binds the client updater', async () => {
  let refreshCalled = false;
  let collateralCalls = 0;

  const client = {
    canL2Auth() {
      return true;
    },
    updateBalanceAllowance() {
      refreshCalled = true;
      this.canL2Auth();
      return Promise.resolve();
    },
    getBalanceAllowance: async (params: { asset_type: AssetType }) => {
      if (params.asset_type === AssetType.COLLATERAL) {
        collateralCalls += 1;
        return collateralCalls === 1
          ? { balance: '0', allowance: '0' }
          : { balance: '100', allowance: '100' };
      }
      return { balance: '0', allowance: '0' };
    },
  };

  await assert.doesNotReject(async () => {
    const result = await checkFundsAndAllowance({
      client: client as never,
      sizeUsd: 10,
      logger: createLogger(),
    });
    assert.equal(result.ok, true);
  });

  assert.equal(refreshCalled, true);
});
