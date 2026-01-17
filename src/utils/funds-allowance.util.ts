import type { ClobClient } from '@polymarket/clob-client';
import { AssetType } from '@polymarket/clob-client';
import { Contract, utils } from 'ethers';
import type { Wallet } from 'ethers';
import { resolvePolymarketContracts } from '../polymarket/contracts';
import { readApprovalsConfig } from '../polymarket/preflight';
import { buildSignedPath } from './query-string.util';
import type { Logger } from './logger.util';

const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
const DEFAULT_COLLATERAL_DECIMALS = 6;
const BALANCE_ALLOWANCE_ENDPOINT = '/balance-allowance';
const BALANCE_ALLOWANCE_UPDATE_ENDPOINT = '/balance-allowance/update';
const BALANCE_ALLOWANCE_CACHE_TTL_MS = 15_000;
const ZERO_ALLOWANCE_COOLDOWN_MS = 5 * 60_000;
const ZERO_ALLOWANCE_LOG_INTERVAL_MS = 60_000;

const balanceAllowanceCache = new Map<string, { snapshot: BalanceAllowanceSnapshot; fetchedAt: number }>();
const zeroAllowanceCooldown = new Map<string, { until: number; lastLogged: number }>();

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
  asset_type: assetType === AssetType.CONDITIONAL ? AssetType.CONDITIONAL : AssetType.COLLATERAL,
  ...(assetType === AssetType.CONDITIONAL && tokenId ? { token_id: tokenId } : {}),
});

const buildCacheKey = (assetType: AssetType, tokenId?: string): string =>
  `${assetType}:${tokenId ?? 'collateral'}`;

const getSignatureType = (client: ClobClient): number | undefined =>
  (client as { orderBuilder?: { signatureType?: number } }).orderBuilder?.signatureType;

const buildBalanceAllowanceRequestInfo = (params: {
  client: ClobClient;
  endpoint: string;
  assetType: AssetType;
  tokenId?: string;
}): { requestParams: BalanceAllowanceParams; signedPath: string; paramsKeys: string[] } => {
  const requestParams = buildBalanceAllowanceParams(params.assetType, params.tokenId);
  const signatureType = getSignatureType(params.client);
  const signedParams = signatureType !== undefined
    ? { ...requestParams, signature_type: signatureType }
    : requestParams;
  const { signedPath, paramsKeys } = buildSignedPath(params.endpoint, signedParams);
  return { requestParams, signedPath, paramsKeys };
};

const logBalanceAllowanceRequest = (params: {
  logger: Logger;
  endpoint: string;
  signedPath: string;
  paramsKeys: string[];
}): void => {
  params.logger.info(
    `[CLOB] Balance/allowance request endpoint=${params.endpoint} path=${params.signedPath} paramsKeys=${params.paramsKeys.length ? params.paramsKeys.join(',') : 'none'} signatureIncludesQuery=${params.signedPath.includes('?')}`,
  );
};

const formatAssetLabel = (snapshot: BalanceAllowanceSnapshot): string => {
  if (snapshot.assetType === AssetType.CONDITIONAL) {
    return `${snapshot.assetType} token_id=${snapshot.tokenId ?? 'unknown'}`;
  }
  return `${snapshot.assetType}`;
};

const fetchBalanceAllowance = async (
  client: ClobClient,
  assetType: AssetType,
  tokenId: string | undefined,
  logger: Logger,
  options?: { forceRefresh?: boolean },
): Promise<BalanceAllowanceSnapshot> => {
  const now = Date.now();
  const cacheKey = buildCacheKey(assetType, tokenId);
  const cachedEntry = balanceAllowanceCache.get(cacheKey);
  if (!options?.forceRefresh) {
    const zeroCooldown = zeroAllowanceCooldown.get(cacheKey);
    if (zeroCooldown && cachedEntry && now < zeroCooldown.until) {
      if (now - zeroCooldown.lastLogged > ZERO_ALLOWANCE_LOG_INTERVAL_MS) {
        logger.warn(
          `[CLOB] Allowance is 0; approvals needed. Skipping refresh until ${new Date(zeroCooldown.until).toISOString()}`,
        );
        zeroAllowanceCooldown.set(cacheKey, { ...zeroCooldown, lastLogged: now });
      }
      return cachedEntry.snapshot;
    }

    if (cachedEntry && now - cachedEntry.fetchedAt < BALANCE_ALLOWANCE_CACHE_TTL_MS) {
      return cachedEntry.snapshot;
    }
  }

  const { requestParams, signedPath, paramsKeys } = buildBalanceAllowanceRequestInfo({
    client,
    endpoint: BALANCE_ALLOWANCE_ENDPOINT,
    assetType,
    tokenId,
  });
  logBalanceAllowanceRequest({ logger, endpoint: BALANCE_ALLOWANCE_ENDPOINT, signedPath, paramsKeys });
  const response = await client.getBalanceAllowance(requestParams);
  const snapshot = {
    assetType,
    tokenId,
    balanceUsd: parseUsdValue((response as { balance?: string }).balance),
    allowanceUsd: parseUsdValue((response as { allowance?: string }).allowance),
  };
  balanceAllowanceCache.set(cacheKey, { snapshot, fetchedAt: now });
  if (snapshot.allowanceUsd <= 0 && assetType === AssetType.COLLATERAL) {
    zeroAllowanceCooldown.set(cacheKey, { until: now + ZERO_ALLOWANCE_COOLDOWN_MS, lastLogged: now });
  } else if (assetType === AssetType.COLLATERAL) {
    zeroAllowanceCooldown.delete(cacheKey);
  }
  return snapshot;
};

const isSnapshotSufficient = (snapshot: BalanceAllowanceSnapshot, requiredUsd: number): boolean =>
  snapshot.balanceUsd >= requiredUsd && snapshot.allowanceUsd >= requiredUsd;

const getBalanceUpdater = (client?: ClobClient): ((params?: BalanceAllowanceParams) => Promise<void>) | null => {
  if (!client) return null;
  const updater = (client as { updateBalanceAllowance?: (params?: BalanceAllowanceParams) => Promise<void> })
    .updateBalanceAllowance;
  const canL2Auth = (client as unknown as { canL2Auth?: () => void }).canL2Auth;
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
    let collateralSnapshot = await fetchBalanceAllowance(params.client, AssetType.COLLATERAL, undefined, params.logger);
    let conditionalSnapshot = params.conditionalTokenId
      ? await fetchBalanceAllowance(params.client, AssetType.CONDITIONAL, params.conditionalTokenId, params.logger)
      : null;
    let balanceUsd = collateralSnapshot.balanceUsd;
    let allowanceUsd = collateralSnapshot.allowanceUsd;

    const refreshAndRetry = async (): Promise<void> => {
      const updater = getBalanceUpdater(params.client);
      if (!updater || refreshed) return;
      refreshed = true;
      params.logger.info('[CLOB] Refreshing balance/allowance cache before skipping order.');
      const refreshInfo = buildBalanceAllowanceRequestInfo({
        client: params.client,
        endpoint: BALANCE_ALLOWANCE_UPDATE_ENDPOINT,
        assetType: AssetType.COLLATERAL,
      });
      logBalanceAllowanceRequest({
        logger: params.logger,
        endpoint: BALANCE_ALLOWANCE_UPDATE_ENDPOINT,
        signedPath: refreshInfo.signedPath,
        paramsKeys: refreshInfo.paramsKeys,
      });
      await updater(refreshInfo.requestParams);
      collateralSnapshot = await fetchBalanceAllowance(
        params.client,
        AssetType.COLLATERAL,
        undefined,
        params.logger,
        { forceRefresh: true },
      );
      conditionalSnapshot = params.conditionalTokenId
        ? await fetchBalanceAllowance(
          params.client,
          AssetType.CONDITIONAL,
          params.conditionalTokenId,
          params.logger,
          { forceRefresh: true },
        )
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
            const approvalsConfig = readApprovalsConfig();
            const liveTradingEnabled = process.env.ARB_LIVE_TRADING === 'I_UNDERSTAND_THE_RISKS';
            if (!liveTradingEnabled || approvalsConfig.mode !== 'true') {
              params.logger.warn(
                `[CLOB] Auto-approve blocked (live trading disabled or APPROVALS_AUTO!=true). signer=${signerAddress} collateral=${collateralLabel}`,
              );
              return {
                ok: false,
                requiredUsd,
                balanceUsd: insufficientSnapshot.balanceUsd,
                allowanceUsd: insufficientSnapshot.allowanceUsd,
                reason,
              };
            }
            const spender = resolvePolymarketContracts().ctfExchangeAddress;
            if (!spender) {
              params.logger.warn(
                `[CLOB] Auto-approve requested but POLY_CTF_EXCHANGE_ADDRESS missing. signer=${signerAddress} collateral=${collateralLabel}`,
              );
              return {
                ok: false,
                requiredUsd,
                balanceUsd: insufficientSnapshot.balanceUsd,
                allowanceUsd: insufficientSnapshot.allowanceUsd,
                reason,
              };
            }
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
              spender,
              amountUsd: approvalUsd,
              decimals,
              logger: params.logger,
            });
          }
        } else {
          if (insufficientSnapshot.allowanceUsd <= 0) {
            params.logger.warn(`[CLOB] Allowance is 0; approvals needed for collateral ${collateralLabel}.`);
          } else {
            params.logger.warn(`[CLOB] Approval required for collateral ${collateralLabel}.`);
          }
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
