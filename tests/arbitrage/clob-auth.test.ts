import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClobClient } from '@polymarket/clob-client';
import { postOrder } from '../../src/utils/post-order.util';
import { resetApiCredsCache } from '../../src/infrastructure/clob-auth';

const baseOrderBook = {
  asks: [{ price: '1', size: '1' }],
  bids: [{ price: '1', size: '1' }],
};

afterEach(() => {
  resetApiCredsCache();
});

test('postOrder derives and sets API creds before placing orders', async () => {
  const callOrder: string[] = [];

  const client = {
    createOrDeriveApiCreds: async () => {
      callOrder.push('derive');
      return { key: 'key', secret: 'secret', passphrase: 'pass' };
    },
    setApiCreds: () => {
      callOrder.push('set');
    },
    getOrderBook: async () => baseOrderBook,
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      callOrder.push('post');
      return { success: true };
    },
  } as unknown as ClobClient;

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

test('postOrder re-derives API creds and retries once on auth failure', async () => {
  let postAttempts = 0;
  const derivedCreds: string[] = [];

  const client = {
    createOrDeriveApiCreds: async () => {
      derivedCreds.push(`derive-${derivedCreds.length + 1}`);
      return { key: `key-${derivedCreds.length}`, secret: 'secret', passphrase: 'pass' };
    },
    setApiCreds: () => undefined,
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

  await postOrder({
    client,
    tokenId: 'token-2',
    outcome: 'YES',
    side: 'BUY',
    sizeUsd: 1,
  });

  assert.equal(postAttempts, 2);
  assert.equal(derivedCreds.length, 2);
});
