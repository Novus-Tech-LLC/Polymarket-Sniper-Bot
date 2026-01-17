import type { ClobClient } from '@polymarket/clob-client';
import { AssetType } from '@polymarket/clob-client';
import { BigNumber, Contract, utils } from 'ethers';
import type { Wallet } from 'ethers';
import { ensureApprovals, readApprovalsConfig, resolveApprovalTargets } from '../polymarket/approvals';
import type { RelayerContext } from '../polymarket/relayer';
import { buildSignedPath } from './query-string.util';
import type { Logger } from './logger.util';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];
const ERC1155_ABI = ['function isApprovedForAll(address owner, address operator) view returns (bool)'];
const DEFAULT_COLLATERAL_DECIMALS = 6;
const BALANCE_ALLOWANCE_ENDPOINT = '/balance-allowance';
const BALANCE_ALLOWANCE_CACHE_TTL_MS = 15_000;
const ZERO_ALLOWANCE_COOLDOWN_MS = 5 * 60_000;
const ZERO_ALLOWANCE_LOG_INTERVAL_MS = 60_000;
const APPROVAL_RETRY_COOLDOWN_MS = 5 * 60_000;
const APPROVAL_FOR_ALL_CACHE_TTL_MS = 30_000;

const balanceAllowanceCache = new Map<string, { snapshot: BalanceAllowanceSnapshot; fetchedAt: number }>();
const zeroAllowanceCooldown = new Map<string, { until: number; lastLogged: number }>();
const approvalAttemptCooldown = new Map<string, number>();
const approvalForAllCache = new Map<string, { approved: boolean; fetchedAt: number }>();

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

const resolveTradingAddress = (client: ClobClient): string => {
  const relayerContext = (client as { relayerContext?: RelayerContext }).relayerContext;
  return relayerContext?.tradingAddress ?? resolveSignerAddress(client);
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

const buildOnchainSnapshot = async (params: {
  client: ClobClient;
  owner: string;
  decimals: number;
  tokenAddress?: string;
  logger: Logger;
}): Promise<{ balanceUsd: number; allowanceUsd: number; approvedForAll: boolean }> => {
  const wallet = (params.client as { wallet?: Wallet }).wallet;
  if (!wallet) {
    throw new Error('Missing wallet for onchain checks.');
  }
  const { contracts, usdcSpenders, erc1155Operators } = resolveApprovalTargets();
  const usdcContract = new Contract(params.tokenAddress ?? contracts.usdcAddress, ERC20_ABI, wallet.provider ?? wallet);
  const balance = await usdcContract.balanceOf(params.owner);
  const allowances = await Promise.all(
    usdcSpenders.map(async (spender) => usdcContract.allowance(params.owner, spender)),
  );
  const minAllowance = allowances.length
    ? allowances.reduce((min, current) => (current.lt(min) ? current : min), allowances[0])
    : BigNumber.from(0);
  const approvedForAll = await Promise.all(
    erc1155Operators.map(async (operator) => {
      if (!contracts.ctfErc1155Address) return false;
      const ctfContract = new Contract(contracts.ctfErc1155Address, ERC1155_ABI, wallet.provider ?? wallet);
      return ctfContract.isApprovedForAll(params.owner, operator);
    }),
  );
  const allApproved = approvedForAll.length ? approvedForAll.every(Boolean) : false;
  params.logger.info(
    `[CLOB][Onchain] owner=${params.owner} balance=${utils.formatUnits(balance, params.decimals)} allowance_min=${utils.formatUnits(minAllowance, params.decimals)} approvedForAll=${allApproved}`,
  );
  return {
    balanceUsd: Number(utils.formatUnits(balance, params.decimals)),
    allowanceUsd: Number(utils.formatUnits(minAllowance, params.decimals)),
    approvedForAll: allApproved,
  };
};

const fetchApprovedForAll = async (params: {
  client: ClobClient;
  owner: string;
  logger: Logger;
}): Promise<boolean> => {
  const cacheKey = `approved:${params.owner}`;
  const cached = approvalForAllCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < APPROVAL_FOR_ALL_CACHE_TTL_MS) {
    return cached.approved;
  }
  const wallet = (params.client as { wallet?: Wallet }).wallet;
  if (!wallet) {
    throw new Error('Missing wallet for approval checks.');
  }
  const { contracts, erc1155Operators } = resolveApprovalTargets();
  if (!contracts.ctfErc1155Address || erc1155Operators.length === 0) {
    return false;
  }
  const ctfContract = new Contract(contracts.ctfErc1155Address, ERC1155_ABI, wallet.provider ?? wallet);
  const approvals = await Promise.all(
    erc1155Operators.map((operator) => ctfContract.isApprovedForAll(params.owner, operator)),
  );
  const approved = approvals.every(Boolean);
  approvalForAllCache.set(cacheKey, { approved, fetchedAt: now });
  params.logger.info(`[CLOB][Onchain] owner=${params.owner} approvedForAll=${approved}`);
  return approved;
};

export const checkFundsAndAllowance = async (params: FundsAllowanceParams): Promise<FundsAllowanceResult> => {
  const bufferBps = params.balanceBufferBps ?? 0;
  const requiredUsd = params.sizeUsd * (1 + bufferBps / 10000);
  const signerAddress = resolveSignerAddress(params.client);
  const tradingAddress = resolveTradingAddress(params.client);
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
      if (refreshed) return;
      refreshed = true;
      params.logger.info('[CLOB] Refreshing balance/allowance cache before skipping order.');
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

            const approvalKey = `${tradingAddress}:${params.collateralTokenAddress}`;
            const lastAttempt = approvalAttemptCooldown.get(approvalKey) ?? 0;
            if (Date.now() - lastAttempt < APPROVAL_RETRY_COOLDOWN_MS) {
              params.logger.warn('[CLOB] Auto-approve cooldown active; skipping approval retry.');
            } else {
              if (params.autoApproveMaxUsd && params.autoApproveMaxUsd < requiredUsd) {
                params.logger.warn(
                  `[CLOB] Auto-approve cap ${formatUsd(params.autoApproveMaxUsd)} is below required ${formatUsd(requiredUsd)}.`,
                );
                return {
                  ok: false,
                  requiredUsd,
                  balanceUsd: insufficientSnapshot.balanceUsd,
                  allowanceUsd: insufficientSnapshot.allowanceUsd,
                  reason,
                };
              }
              approvalAttemptCooldown.set(approvalKey, Date.now());
              await ensureApprovals({
                wallet,
                owner: tradingAddress,
                relayer: (params.client as { relayerContext?: RelayerContext }).relayerContext,
                logger: params.logger,
                config: approvalsConfig,
              });
              await refreshAndRetry();
            }
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

    const approvedForAll = await fetchApprovedForAll({
      client: params.client,
      owner: tradingAddress,
      logger: params.logger,
    });
    if (!approvedForAll) {
      if (params.autoApprove) {
        const wallet = (params.client as { wallet?: Wallet }).wallet;
        if (wallet) {
          const approvalsConfig = readApprovalsConfig();
          const liveTradingEnabled = process.env.ARB_LIVE_TRADING === 'I_UNDERSTAND_THE_RISKS';
          if (liveTradingEnabled && approvalsConfig.mode === 'true') {
            const approvalKey = `${tradingAddress}:erc1155`;
            const lastAttempt = approvalAttemptCooldown.get(approvalKey) ?? 0;
            if (Date.now() - lastAttempt >= APPROVAL_RETRY_COOLDOWN_MS) {
              approvalAttemptCooldown.set(approvalKey, Date.now());
              await ensureApprovals({
                wallet,
                owner: tradingAddress,
                relayer: (params.client as { relayerContext?: RelayerContext }).relayerContext,
                logger: params.logger,
                config: approvalsConfig,
              });
              const refreshedApproval = await fetchApprovedForAll({
                client: params.client,
                owner: tradingAddress,
                logger: params.logger,
              });
              if (!refreshedApproval) {
                return {
                  ok: false,
                  requiredUsd,
                  balanceUsd,
                  allowanceUsd,
                  reason: 'INSUFFICIENT_ALLOWANCE_OR_APPROVAL',
                };
              }
            }
          }
        }
      }
      return {
        ok: false,
        requiredUsd,
        balanceUsd,
        allowanceUsd,
        reason: 'INSUFFICIENT_ALLOWANCE_OR_APPROVAL',
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
    try {
      const onchain = await buildOnchainSnapshot({
        client: params.client,
        owner: tradingAddress,
        decimals: params.collateralTokenDecimals ?? DEFAULT_COLLATERAL_DECIMALS,
        tokenAddress: params.collateralTokenAddress,
        logger: params.logger,
      });
      const ok = onchain.balanceUsd >= requiredUsd && onchain.allowanceUsd >= requiredUsd && onchain.approvedForAll;
      if (!ok) {
        return {
          ok: false,
          requiredUsd,
          balanceUsd: onchain.balanceUsd,
          allowanceUsd: onchain.allowanceUsd,
          reason: 'INSUFFICIENT_BALANCE_OR_ALLOWANCE',
        };
      }
      return {
        ok: true,
        requiredUsd,
        balanceUsd: onchain.balanceUsd,
        allowanceUsd: onchain.allowanceUsd,
        reason: 'BALANCE_ALLOWANCE_FALLBACK_ONCHAIN',
      };
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      params.logger.warn(`[CLOB] Onchain fallback failed: ${fallbackMessage}`);
      return {
        ok: true,
        requiredUsd,
        balanceUsd: 0,
        allowanceUsd: 0,
        reason: 'BALANCE_ALLOWANCE_UNAVAILABLE',
      };
    }
  }
};
