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
  const callOrder: string[] = [];

  const client = {
    getOrderBook: async () => baseOrderBook,
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      callOrder.push('post');
      return { success: true };
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, 'creds', {
    set: () => {
      callOrder.push('set');
    },
  });

  await initializeApiCreds(client, { key: 'key', secret: 'secret', passphrase: 'pass' });

  await postOrder({
    client,
    tokenId: 'token-1',
    outcome: 'YES',
    side: 'BUY',
    sizeUsd: 1,
  });

  assert.ok(callOrder.indexOf('set') !== -1);
  assert.ok(callOrder.indexOf('post') !== -1);
  assert.ok(callOrder.indexOf('set') < callOrder.indexOf('post'));
});

test('postOrder re-applies API creds and retries once on auth failure', async () => {
  let postAttempts = 0;
  const setCalls: string[] = [];

  const client = {
    getOrderBook: async () => baseOrderBook,
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      postAttempts += 1;
      if (postAttempts === 1) {
        const error = new Error('Unauthorized');
        (error as { response?: { status: number } }).response = { status: 401 };
        throw error;
      }
      return { success: true };
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, 'creds', {
    set: () => {
      setCalls.push('set');
    },
  });

  await initializeApiCreds(client, { key: 'key', secret: 'secret', passphrase: 'pass' });
  setCalls.length = 0;

  await postOrder({
    client,
    tokenId: 'token-2',
    outcome: 'YES',
    side: 'BUY',
    sizeUsd: 1,
  });

  assert.equal(postAttempts, 2);
  assert.equal(setCalls.length, 2);
});
