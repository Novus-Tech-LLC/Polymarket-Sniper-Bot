import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAxiosError } from '../../src/utils/sanitize-axios-error.util';

test('sanitizeAxiosError redacts sensitive axios fields', () => {
  const error = {
    isAxiosError: true,
    message: 'Request failed: POLY_API_KEY=supersecret Authorization=Bearer token',
    config: {
      method: 'post',
      url: 'https://clob.test/orders?POLY_PASSPHRASE=passphrase',
      headers: {
        Authorization: 'Bearer token',
        Cookie: 'session=abc',
      },
    },
    response: {
      status: 403,
      headers: {
        Cookie: 'session=abc',
      },
    },
  };

  const sanitized = sanitizeAxiosError(error);
  assert.ok(!sanitized.message.includes('supersecret'));
  assert.ok(!sanitized.message.includes('passphrase'));
  assert.ok(!sanitized.message.toLowerCase().includes('authorization='));
  assert.ok(!sanitized.message.toLowerCase().includes('cookie='));
  assert.ok(sanitized.message.includes('<redacted>'));
});
