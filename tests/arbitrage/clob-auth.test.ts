import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClobClient } from '@polymarket/clob-client';
import { postOrder } from '../../src/utils/post-order.util';
import { initializeApiCreds, resetApiCredsCache } from '../../src/infrastructure/clob-auth';

const baseOrderBook = {
  asks: [{ price: '1', size: '1' }],
  bids: [{ price: '1', size: '1' }],
};

afterEach(() => {
  resetApiCredsCache();
});

test('postOrder applies cached API creds before placing orders', async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = 'I_UNDERSTAND_THE_RISKS';
  const callOrder: string[] = [];
  let appliedCreds: { key: string; secret: string; passphrase: string } | undefined;

  const client = {
    getOrderBook: async () => baseOrderBook,
    getBalanceAllowance: async () => ({ balance: '100', allowance: '100' }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      callOrder.push('post');
      return { success: true, order: { id: 'order-1' }, status: 200 };
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, 'creds', {
    set: (value: { key: string; secret: string; passphrase: string }) => {
      callOrder.push('set');
      appliedCreds = value;
    },
  });

  await initializeApiCreds(client, { key: 'key', secret: 'secret', passphrase: 'pass' });

  try {
    await postOrder({
      client,
      tokenId: 'token-1',
      outcome: 'YES',
      side: 'BUY',
      sizeUsd: 1,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        minOrderUsd: 0,
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }

  assert.ok(callOrder.indexOf('set') !== -1);
  assert.ok(callOrder.indexOf('post') !== -1);
  assert.ok(callOrder.indexOf('set') < callOrder.indexOf('post'));
  assert.deepEqual(appliedCreds, { key: 'key', secret: 'secret', passphrase: 'pass' });
});

test('postOrder re-applies API creds and retries once on auth failure', async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = 'I_UNDERSTAND_THE_RISKS';
  let postAttempts = 0;
  const setCalls: string[] = [];

  const client = {
    getOrderBook: async () => baseOrderBook,
    getBalanceAllowance: async () => ({ balance: '100', allowance: '100' }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      postAttempts += 1;
      if (postAttempts === 1) {
        const error = new Error('Unauthorized');
        (error as { response?: { status: number } }).response = { status: 401 };
        throw error;
      }
      return { success: true, order: { id: 'order-2' }, status: 200 };
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, 'creds', {
    set: () => {
      setCalls.push('set');
    },
  });

  await initializeApiCreds(client, { key: 'key', secret: 'secret', passphrase: 'pass' });
  setCalls.length = 0;

  try {
    await postOrder({
      client,
      tokenId: 'token-2',
      outcome: 'YES',
      side: 'BUY',
      sizeUsd: 1,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        minOrderUsd: 0,
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }

  assert.equal(postAttempts, 2);
  assert.equal(setCalls.length, 2);
});
