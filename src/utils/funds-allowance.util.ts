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
  conditionalTokenId?: string;
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

export type BalanceAllowanceParams = {
  asset_type: AssetType;
  token_id?: string;
};

export type BalanceAllowanceSnapshot = {
  assetType: AssetType;
  tokenId?: string;
  balanceUsd: number;
  allowanceUsd: number;
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

export const buildBalanceAllowanceParams = (assetType: AssetType, tokenId?: string): BalanceAllowanceParams => ({
  asset_type: assetType,
  ...(assetType === AssetType.CONDITIONAL && tokenId ? { token_id: tokenId } : {}),
});

const formatAssetLabel = (snapshot: BalanceAllowanceSnapshot): string => {
  if (snapshot.assetType === AssetType.CONDITIONAL) {
    return `${snapshot.assetType} token_id=${snapshot.tokenId ?? 'unknown'}`;
  }
  return `${snapshot.assetType}`;
};

const fetchBalanceAllowance = async (
  client: ClobClient,
  assetType: AssetType,
  tokenId?: string,
): Promise<BalanceAllowanceSnapshot> => {
  const params = buildBalanceAllowanceParams(assetType, tokenId);
  const response = await client.getBalanceAllowance(params);
  return {
    assetType,
    tokenId,
    balanceUsd: parseUsdValue((response as { balance?: string }).balance),
    allowanceUsd: parseUsdValue((response as { allowance?: string }).allowance),
  };
};

const isSnapshotSufficient = (snapshot: BalanceAllowanceSnapshot, requiredUsd: number): boolean =>
  snapshot.balanceUsd >= requiredUsd && snapshot.allowanceUsd >= requiredUsd;

const getBalanceUpdater = (client?: ClobClient): (() => Promise<void>) | null => {
  if (!client) return null;
  const updater = (client as { updateBalanceAllowance?: () => Promise<void> }).updateBalanceAllowance;
  const canL2Auth = (client as { canL2Auth?: () => void }).canL2Auth;
  if (typeof updater !== 'function' || typeof canL2Auth !== 'function') {
    return null;
  }
  return updater.bind(client);
};

export const checkFundsAndAllowance = async (params: FundsAllowanceParams): Promise<FundsAllowanceResult> => {
  const bufferBps = params.balanceBufferBps ?? 0;
  const requiredUsd = params.sizeUsd * (1 + bufferBps / 10000);
  const signerAddress = resolveSignerAddress(params.client);
  const collateralLabel = formatCollateralLabel(params.collateralTokenAddress, params.collateralTokenId);

  try {
    let refreshed = false;
    let collateralSnapshot = await fetchBalanceAllowance(params.client, AssetType.COLLATERAL);
    let conditionalSnapshot = params.conditionalTokenId
      ? await fetchBalanceAllowance(params.client, AssetType.CONDITIONAL, params.conditionalTokenId)
      : null;
    let balanceUsd = collateralSnapshot.balanceUsd;
    let allowanceUsd = collateralSnapshot.allowanceUsd;

    const refreshAndRetry = async (): Promise<void> => {
      const updater = getBalanceUpdater(params.client);
      if (!updater || refreshed) return;
      refreshed = true;
      params.logger.info('[CLOB] Refreshing balance/allowance cache before skipping order.');
      await updater();
      collateralSnapshot = await fetchBalanceAllowance(params.client, AssetType.COLLATERAL);
      conditionalSnapshot = params.conditionalTokenId
        ? await fetchBalanceAllowance(params.client, AssetType.CONDITIONAL, params.conditionalTokenId)
        : null;
      balanceUsd = collateralSnapshot.balanceUsd;
      allowanceUsd = collateralSnapshot.allowanceUsd;
    };

    const firstInsufficient = !isSnapshotSufficient(collateralSnapshot, requiredUsd)
      ? collateralSnapshot
      : conditionalSnapshot && !isSnapshotSufficient(conditionalSnapshot, requiredUsd)
        ? conditionalSnapshot
        : null;

    if (firstInsufficient) {
      await refreshAndRetry();
    }

    const insufficientSnapshot = !isSnapshotSufficient(collateralSnapshot, requiredUsd)
      ? collateralSnapshot
      : conditionalSnapshot && !isSnapshotSufficient(conditionalSnapshot, requiredUsd)
        ? conditionalSnapshot
        : null;

    if (insufficientSnapshot) {
      const reason = 'INSUFFICIENT_BALANCE_OR_ALLOWANCE';
      const assetLabel = formatAssetLabel(insufficientSnapshot);
      params.logger.warn(
        `[CLOB] Order skipped (${reason}): need=${formatUsd(requiredUsd)} have=${formatUsd(insufficientSnapshot.balanceUsd)} allowance=${formatUsd(insufficientSnapshot.allowanceUsd)} asset=${assetLabel} signer=${signerAddress} collateral=${collateralLabel}`,
      );

      if (insufficientSnapshot.allowanceUsd < requiredUsd && insufficientSnapshot.assetType === AssetType.COLLATERAL) {
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
        balanceUsd: insufficientSnapshot.balanceUsd,
        allowanceUsd: insufficientSnapshot.allowanceUsd,
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
      ok: true,
      requiredUsd,
      balanceUsd: 0,
      allowanceUsd: 0,
      reason: 'BALANCE_ALLOWANCE_UNAVAILABLE',
    };
  }
};
