import type { ClobClient } from '@polymarket/clob-client';
import { AssetType } from '@polymarket/clob-client';
import { Contract, utils } from 'ethers';
import type { Wallet } from 'ethers';
import { POLYMARKET_CONTRACTS } from '../constants/polymarket.constants';
import type { Logger } from './logger.util';

const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
const DEFAULT_COLLATERAL_DECIMALS = 6;

export type FundsAllowanceParams = {
  client: ClobClient;
  sizeUsd: number;
  balanceBufferBps?: number;
  collateralTokenAddress?: string;
  collateralTokenDecimals?: number;
  collateralTokenId?: string;
  autoApprove?: boolean;
  autoApproveMaxUsd?: number;
  logger: Logger;
};

export type FundsAllowanceResult = {
  ok: boolean;
  requiredUsd: number;
  balanceUsd: number;
  allowanceUsd: number;
  reason?: string;
};

export const resolveSignerAddress = (client: ClobClient): string => {
  const derived = (client as { derivedSignerAddress?: string }).derivedSignerAddress;
  const wallet = (client as { wallet?: Wallet }).wallet;
  return derived ?? wallet?.address ?? 'unknown';
};

export const formatCollateralLabel = (collateralTokenAddress?: string, collateralTokenId?: string): string => {
  const addressLabel = collateralTokenAddress ?? 'unknown';
  return collateralTokenId ? `${addressLabel} (id=${collateralTokenId})` : addressLabel;
};

const parseUsdValue = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatUsd = (value: number): string => value.toFixed(2);

const buildApprovalAmount = (requiredUsd: number, maxUsd: number | undefined): number => {
  if (!maxUsd || maxUsd <= 0) return requiredUsd;
  return Math.min(requiredUsd, maxUsd);
};

const submitApproval = async (params: {
  wallet: Wallet;
  tokenAddress: string;
  spender: string;
  amountUsd: number;
  decimals: number;
  logger: Logger;
}): Promise<void> => {
  const amount = utils.parseUnits(params.amountUsd.toFixed(params.decimals), params.decimals);
  const contract = new Contract(params.tokenAddress, ERC20_APPROVE_ABI, params.wallet);
  params.logger.warn(`[CLOB] Submitting approval tx for ${params.amountUsd.toFixed(2)} collateral tokens.`);
  const tx = await contract.approve(params.spender, amount);
  params.logger.info(`[CLOB] Approval tx submitted: ${tx.hash}`);
  await tx.wait(1);
  params.logger.info('[CLOB] Approval confirmed.');
};

export const checkFundsAndAllowance = async (params: FundsAllowanceParams): Promise<FundsAllowanceResult> => {
  const bufferBps = params.balanceBufferBps ?? 0;
  const requiredUsd = params.sizeUsd * (1 + bufferBps / 10000);
  const signerAddress = resolveSignerAddress(params.client);
  const collateralLabel = formatCollateralLabel(params.collateralTokenAddress, params.collateralTokenId);
  const balanceParams = {
    asset_type: AssetType.COLLATERAL,
    ...(params.collateralTokenId ? { token_id: params.collateralTokenId } : {}),
  };

  try {
    const response = await params.client.getBalanceAllowance(balanceParams);
    const balanceUsd = parseUsdValue((response as { balance?: string }).balance);
    const allowanceUsd = parseUsdValue((response as { allowance?: string }).allowance);

    if (balanceUsd < requiredUsd || allowanceUsd < requiredUsd) {
      const reason = 'INSUFFICIENT_BALANCE_OR_ALLOWANCE';
      params.logger.warn(
        `[CLOB] Order skipped (${reason}): need=${formatUsd(requiredUsd)} have=${formatUsd(balanceUsd)} allowance=${formatUsd(allowanceUsd)} signer=${signerAddress} collateral=${collateralLabel}`,
      );

      if (allowanceUsd < requiredUsd) {
        if (params.autoApprove && params.collateralTokenAddress) {
          const wallet = (params.client as { wallet?: Wallet }).wallet;
          if (!wallet) {
            params.logger.warn(
              `[CLOB] Auto-approve requested but wallet missing. signer=${signerAddress} collateral=${collateralLabel}`,
            );
          } else {
            const decimals = params.collateralTokenDecimals ?? DEFAULT_COLLATERAL_DECIMALS;
            const approvalUsd = buildApprovalAmount(requiredUsd, params.autoApproveMaxUsd);
            if (params.autoApproveMaxUsd && params.autoApproveMaxUsd < requiredUsd) {
              params.logger.warn(
                `[CLOB] Auto-approve cap ${formatUsd(params.autoApproveMaxUsd)} is below required ${formatUsd(requiredUsd)}.`,
              );
            }
            await submitApproval({
              wallet,
              tokenAddress: params.collateralTokenAddress,
              spender: POLYMARKET_CONTRACTS[1],
              amountUsd: approvalUsd,
              decimals,
              logger: params.logger,
            });
          }
        } else {
          params.logger.warn(`[CLOB] Approval required for collateral ${collateralLabel}.`);
        }
      }

      return {
        ok: false,
        requiredUsd,
        balanceUsd,
        allowanceUsd,
        reason,
      };
    }

    return {
      ok: true,
      requiredUsd,
      balanceUsd,
      allowanceUsd,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.logger.warn(
      `[CLOB] Balance/allowance check failed (BALANCE_ALLOWANCE_UNAVAILABLE): required=${formatUsd(requiredUsd)} signer=${signerAddress} collateral=${collateralLabel} error=${message}`,
    );
    return {
      ok: false,
      requiredUsd,
      balanceUsd: 0,
      allowanceUsd: 0,
      reason: 'BALANCE_ALLOWANCE_UNAVAILABLE',
    };
  }
};
