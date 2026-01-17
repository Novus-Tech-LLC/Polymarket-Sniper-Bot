import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedPath, canonicalQuery } from '../../src/utils/query-string.util';

test('canonicalQuery sorts keys and preserves encoding', () => {
  const { queryString, keys } = canonicalQuery({
    b: '2',
    a: '1',
    c: 'space value',
  });

  assert.deepEqual(keys, ['a', 'b', 'c']);
  assert.equal(queryString, 'a=1&b=2&c=space%20value');
});

test('buildSignedPath appends canonical query string', () => {
  const result = buildSignedPath('/balance-allowance', {
    asset_type: 'COLLATERAL',
    signature_type: 1,
  });

  assert.equal(result.signedPath, '/balance-allowance?asset_type=COLLATERAL&signature_type=1');
  assert.deepEqual(result.paramsKeys, ['asset_type', 'signature_type']);
});
