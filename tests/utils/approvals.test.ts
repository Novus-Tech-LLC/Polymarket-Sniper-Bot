import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BigNumber } from 'ethers';
import { getApprovalDecision } from '../../src/polymarket/approvals';

test('getApprovalDecision flags missing ERC20 allowance', () => {
  const result = getApprovalDecision({
    allowance: BigNumber.from('0'),
    minAllowance: BigNumber.from('100'),
    approvedForAll: true,
    force: false,
  });

  assert.equal(result.needsErc20, true);
  assert.equal(result.needsErc1155, false);
});

test('getApprovalDecision respects force flag', () => {
  const result = getApprovalDecision({
    allowance: BigNumber.from('1000'),
    minAllowance: BigNumber.from('100'),
    approvedForAll: true,
    force: true,
  });

  assert.equal(result.needsErc20, true);
  assert.equal(result.needsErc1155, true);
});

test('getApprovalDecision flags missing ERC1155 approval', () => {
  const result = getApprovalDecision({
    allowance: BigNumber.from('1000'),
    minAllowance: BigNumber.from('100'),
    approvedForAll: false,
    force: false,
  });

  assert.equal(result.needsErc20, false);
  assert.equal(result.needsErc1155, true);
});
