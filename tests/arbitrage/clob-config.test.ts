import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMonitorConfig } from '../../src/config/loadConfig';

const baseEnv = {
  TARGET_ADDRESSES: '0xabc',
  PUBLIC_KEY: '0x' + '22'.repeat(20),
  PRIVATE_KEY: '0x' + '33'.repeat(32),
  RPC_URL: 'http://localhost:8545',
  POLY_API_KEY: 'key',
  POLY_PASSPHRASE: 'passphrase',
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

test('missing secret triggers detect-only mode', () => {
  resetEnv();
  Object.assign(process.env, baseEnv);

  const config = loadMonitorConfig();
  assert.equal(config.clobCredsComplete, false);
  assert.equal(config.detectOnly, true);
});
