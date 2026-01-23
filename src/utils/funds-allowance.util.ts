import type { ClobClient } from "@polymarket/clob-client";
import { AssetType } from "@polymarket/clob-client";
import { Contract, formatUnits } from "ethers";
import type { Wallet } from "ethers";
import {
  ensureApprovals,
  readApprovalsConfig,
  resolveApprovalTargets,
} from "../polymarket/approvals";
import type { RelayerContext } from "../polymarket/relayer";
import { buildSignedPath } from "./query-string.util";
import type { Logger } from "./logger.util";
import { sanitizeErrorMessage } from "./sanitize-axios-error.util";
import { isLiveTradingEnabled } from "./live-trading.util";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
];
const DEFAULT_COLLATERAL_DECIMALS = 6;
const BALANCE_ALLOWANCE_ENDPOINT = "/balance-allowance";
const BALANCE_ALLOWANCE_CACHE_TTL_MS = 15_000;
const ZERO_ALLOWANCE_COOLDOWN_MS = 5 * 60_000;
const ZERO_ALLOWANCE_LOG_INTERVAL_MS = 60_000;
const APPROVAL_RETRY_COOLDOWN_MS = 5 * 60_000;
const APPROVAL_FOR_ALL_CACHE_TTL_MS = 30_000;

const balanceAllowanceCache = new Map<
  string,
  { snapshot: BalanceAllowanceSnapshot; fetchedAt: number }
>();
const zeroAllowanceCooldown = new Map<
  string,
  { until: number; lastLogged: number }
>();
const approvalAttemptCooldown = new Map<string, number>();
const approvalForAllCache = new Map<
  string,
  { approved: boolean; fetchedAt: number }
>();

// Deduplication for balance/allowance check failure warnings
const BALANCE_CHECK_WARN_DEDUP_WINDOW_MS = 5_000;
const balanceCheckWarnDedup = new Map<
  string,
  { lastLogged: number; count: number }
>();

/**
 * In-flight buy order tracking to prevent order stacking.
 * Tracks pending balance/allowance checks and order submissions.
 * Key format: `${tokenId}:BUY` - we only track BUYs since those stack losses.
 */
const IN_FLIGHT_COOLDOWN_MS = 10_000; // 10 second cooldown between buys on same token
const inFlightBuys = new Map<
  string,
  { startedAt: number; completedAt?: number }
>();

/**
 * Check if a buy order on this token is already in-flight or in cooldown.
 * Returns true if order should be blocked, false if it can proceed.
 */
export const isInFlightOrCooldown = (
  tokenId: string,
  side: "BUY" | "SELL",
): { blocked: boolean; reason?: string; remainingMs?: number } => {
  // Only track BUY orders - SELL doesn't stack losses
  if (side !== "BUY") {
    return { blocked: false };
  }

  const key = `${tokenId}:BUY`;
  const entry = inFlightBuys.get(key);
  const now = Date.now();

  if (!entry) {
    return { blocked: false };
  }

  // Check if still in-flight (no completion time)
  if (!entry.completedAt) {
    const elapsed = now - entry.startedAt;
    // If it's been more than 60s without completion, assume it's stale
    if (elapsed > 60_000) {
      inFlightBuys.delete(key);
      return { blocked: false };
    }
    return {
      blocked: true,
      reason: "IN_FLIGHT_BUY",
      remainingMs: Math.max(0, 60_000 - elapsed),
    };
  }

  // Check cooldown after completion
  const timeSinceCompletion = now - entry.completedAt;
  if (timeSinceCompletion < IN_FLIGHT_COOLDOWN_MS) {
    return {
      blocked: true,
      reason: "BUY_COOLDOWN",
      remainingMs: IN_FLIGHT_COOLDOWN_MS - timeSinceCompletion,
    };
  }

  // Cooldown expired, clean up
  inFlightBuys.delete(key);
  return { blocked: false };
};

/**
 * Mark a buy order as in-flight (starting).
 */
export const markBuyInFlight = (tokenId: string): void => {
  const key = `${tokenId}:BUY`;
  inFlightBuys.set(key, { startedAt: Date.now() });
};

/**
 * Mark a buy order as completed (success or failure).
 */
export const markBuyCompleted = (tokenId: string): void => {
  const key = `${tokenId}:BUY`;
  const entry = inFlightBuys.get(key);
  if (entry) {
    entry.completedAt = Date.now();
  }
};

/**
 * Deduplicated warning logger for balance/allowance check failures.
 * Prevents log spam when multiple concurrent checks fail.
 */
const logBalanceCheckWarn = (
  logger: Logger,
  signerAddress: string,
  message: string,
): void => {
  const now = Date.now();
  const key = `${signerAddress}:balance-check`;
  const entry = balanceCheckWarnDedup.get(key);

  if (entry && now - entry.lastLogged < BALANCE_CHECK_WARN_DEDUP_WINDOW_MS) {
    // Suppress - within dedup window
    entry.count++;
    return;
  }

  // Log full message, include suppressed count if any
  if (entry && entry.count > 0) {
    logger.warn(`${message} (suppressed ${entry.count} similar warnings)`);
    balanceCheckWarnDedup.set(key, { lastLogged: now, count: 0 });
  } else {
    logger.warn(message);
    balanceCheckWarnDedup.set(key, { lastLogged: now, count: 0 });
  }
};

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
  const derived = (client as { derivedSignerAddress?: string })
    .derivedSignerAddress;
  const wallet = (client as { wallet?: Wallet }).wallet;
  return derived ?? wallet?.address ?? "unknown";
};

const resolveTradingAddress = (client: ClobClient): string => {
  const relayerContext = (client as { relayerContext?: RelayerContext })
    .relayerContext;
  return relayerContext?.tradingAddress ?? resolveSignerAddress(client);
};

export const formatCollateralLabel = (
  collateralTokenAddress?: string,
  collateralTokenId?: string,
): string => {
  const addressLabel = collateralTokenAddress ?? "unknown";
  return collateralTokenId
    ? `${addressLabel} (id=${collateralTokenId})`
    : addressLabel;
};

const parseUsdValue = (value: unknown): number => {
  const parsed =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatUsd = (value: number): string => value.toFixed(2);

export const syncClobAllowanceCache = async (
  client: ClobClient,
  logger: Logger,
  context: string,
): Promise<void> => {
  try {
    logger.info(`[CLOB] Syncing CLOB allowance cache ${context}...`);
    await client.updateBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    logger.info("[CLOB] CLOB allowance cache synced successfully.");
  } catch (syncError) {
    logger.warn(
      `[CLOB] Failed to sync CLOB cache ${context}: ${sanitizeErrorMessage(syncError)}`,
    );
  }
};

export const buildBalanceAllowanceParams = (
  assetType: AssetType,
  tokenId?: string,
): BalanceAllowanceParams => ({
  asset_type:
    assetType === AssetType.CONDITIONAL
      ? AssetType.CONDITIONAL
      : AssetType.COLLATERAL,
  ...(assetType === AssetType.CONDITIONAL && tokenId
    ? { token_id: tokenId }
    : {}),
});

const buildCacheKey = (assetType: AssetType, tokenId?: string): string =>
  `${assetType}:${tokenId ?? "collateral"}`;

const getSignatureType = (client: ClobClient): number | undefined =>
  (client as { orderBuilder?: { signatureType?: number } }).orderBuilder
    ?.signatureType;

const buildBalanceAllowanceRequestInfo = (params: {
  client: ClobClient;
  endpoint: string;
  assetType: AssetType;
  tokenId?: string;
}): {
  requestParams: BalanceAllowanceParams;
  signedPath: string;
  paramsKeys: string[];
} => {
  const requestParams = buildBalanceAllowanceParams(
    params.assetType,
    params.tokenId,
  );
  const signatureType = getSignatureType(params.client);
  const signedParams =
    signatureType !== undefined
      ? { ...requestParams, signature_type: signatureType }
      : requestParams;
  const { signedPath, paramsKeys } = buildSignedPath(
    params.endpoint,
    signedParams,
  );
  return { requestParams, signedPath, paramsKeys };
};

const logBalanceAllowanceRequest = (params: {
  logger: Logger;
  endpoint: string;
  signedPath: string;
  paramsKeys: string[];
}): void => {
  params.logger.info(
    `[CLOB] Balance/allowance request endpoint=${params.endpoint} path=${params.signedPath} paramsKeys=${params.paramsKeys.length ? params.paramsKeys.join(",") : "none"} signatureIncludesQuery=${params.signedPath.includes("?")}`,
  );
};

const formatAssetLabel = (snapshot: BalanceAllowanceSnapshot): string => {
  if (snapshot.assetType === AssetType.CONDITIONAL) {
    return `${snapshot.assetType} token_id=${snapshot.tokenId ?? "unknown"}`;
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
        zeroAllowanceCooldown.set(cacheKey, {
          ...zeroCooldown,
          lastLogged: now,
        });
      }
      return cachedEntry.snapshot;
    }

    if (
      cachedEntry &&
      now - cachedEntry.fetchedAt < BALANCE_ALLOWANCE_CACHE_TTL_MS
    ) {
      return cachedEntry.snapshot;
    }
  }

  const { requestParams, signedPath, paramsKeys } =
    buildBalanceAllowanceRequestInfo({
      client,
      endpoint: BALANCE_ALLOWANCE_ENDPOINT,
      assetType,
      tokenId,
    });
  logBalanceAllowanceRequest({
    logger,
    endpoint: BALANCE_ALLOWANCE_ENDPOINT,
    signedPath,
    paramsKeys,
  });

  try {
    const response = await client.getBalanceAllowance(requestParams);
    const snapshot = {
      assetType,
      tokenId,
      balanceUsd: parseUsdValue((response as { balance?: string }).balance),
      allowanceUsd: parseUsdValue(
        (response as { allowance?: string }).allowance,
      ),
    };
    balanceAllowanceCache.set(cacheKey, { snapshot, fetchedAt: now });
    if (snapshot.allowanceUsd <= 0 && assetType === AssetType.COLLATERAL) {
      zeroAllowanceCooldown.set(cacheKey, {
        until: now + ZERO_ALLOWANCE_COOLDOWN_MS,
        lastLogged: now,
      });
    } else if (assetType === AssetType.COLLATERAL) {
      zeroAllowanceCooldown.delete(cacheKey);
    }
    return snapshot;
  } catch (error) {
    // Check for invalid asset type error (400 bad request)
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    const message = (error as { response?: { data?: unknown } })?.response
      ?.data;
    const messageStr =
      typeof message === "string" ? message : JSON.stringify(message);

    if (
      status === 400 &&
      messageStr?.toLowerCase().includes("invalid asset type")
    ) {
      logger.error(
        `[CLOB] Invalid asset_type parameter: asset_type=${requestParams.asset_type} token_id=${requestParams.token_id ?? "none"}. This is a configuration error.`,
      );
      throw new Error(
        `Invalid asset_type: ${requestParams.asset_type}. Check CLOB API documentation.`,
      );
    }

    // Re-throw other errors
    throw error;
  }
};

const isSnapshotSufficient = (
  snapshot: BalanceAllowanceSnapshot,
  requiredUsd: number,
): boolean =>
  snapshot.balanceUsd >= requiredUsd && snapshot.allowanceUsd >= requiredUsd;

const buildOnchainSnapshot = async (params: {
  client: ClobClient;
  owner: string;
  decimals: number;
  tokenAddress?: string;
  logger: Logger;
}): Promise<{
  balanceUsd: number;
  allowanceUsd: number;
  approvedForAll: boolean;
}> => {
  const wallet = (params.client as { wallet?: Wallet }).wallet;
  if (!wallet) {
    throw new Error("Missing wallet for onchain checks.");
  }
  const { contracts, usdcSpenders, erc1155Operators } =
    resolveApprovalTargets();
  const usdcContract = new Contract(
    params.tokenAddress ?? contracts.usdcAddress,
    ERC20_ABI,
    wallet.provider ?? wallet,
  );
  const balance = await usdcContract.balanceOf(params.owner);
  const allowances = await Promise.all(
    usdcSpenders.map(async (spender) =>
      usdcContract.allowance(params.owner, spender),
    ),
  );
  const minAllowance = allowances.length
    ? allowances.reduce(
        (min, current) => (current < min ? current : min),
        allowances[0],
      )
    : 0n;
  const approvedForAll = await Promise.all(
    erc1155Operators.map(async (operator) => {
      if (!contracts.ctfErc1155Address) return false;
      const ctfContract = new Contract(
        contracts.ctfErc1155Address,
        ERC1155_ABI,
        wallet.provider ?? wallet,
      );
      return ctfContract.isApprovedForAll(params.owner, operator);
    }),
  );
  const allApproved = approvedForAll.length
    ? approvedForAll.every(Boolean)
    : false;
  params.logger.info(
    `[CLOB][Onchain] owner=${params.owner} balance=${formatUnits(balance, params.decimals)} allowance_min=${formatUnits(minAllowance, params.decimals)} approvedForAll=${allApproved}`,
  );
  return {
    balanceUsd: Number(formatUnits(balance, params.decimals)),
    allowanceUsd: Number(formatUnits(minAllowance, params.decimals)),
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
    throw new Error("Missing wallet for approval checks.");
  }
  const { contracts, erc1155Operators } = resolveApprovalTargets();
  if (!contracts.ctfErc1155Address || erc1155Operators.length === 0) {
    return false;
  }
  const ctfContract = new Contract(
    contracts.ctfErc1155Address,
    ERC1155_ABI,
    wallet.provider ?? wallet,
  );
  const approvals = await Promise.all(
    erc1155Operators.map((operator) =>
      ctfContract.isApprovedForAll(params.owner, operator),
    ),
  );
  const approved = approvals.every(Boolean);
  approvalForAllCache.set(cacheKey, { approved, fetchedAt: now });
  params.logger.info(
    `[CLOB][Onchain] owner=${params.owner} approvedForAll=${approved}`,
  );
  return approved;
};

export const checkFundsAndAllowance = async (
  params: FundsAllowanceParams,
): Promise<FundsAllowanceResult> => {
  const bufferBps = params.balanceBufferBps ?? 0;
  const requiredUsd = params.sizeUsd * (1 + bufferBps / 10000);
  const signerAddress = resolveSignerAddress(params.client);
  const tradingAddress = resolveTradingAddress(params.client);
  const collateralLabel = formatCollateralLabel(
    params.collateralTokenAddress,
    params.collateralTokenId,
  );

  // CLOB API Bug Workaround: getBalanceAllowance() returns allowance=0 even when on-chain approvals are set
  // See: https://github.com/Polymarket/clob-client/issues/128
  //      https://github.com/Polymarket/py-clob-client/issues/102
  //      https://github.com/Polymarket/py-clob-client/issues/109
  // When TRUST_ONCHAIN_APPROVALS=true and preflight verified approvals, skip CLOB allowance check
  const trustOnchainApprovals =
    process.env.TRUST_ONCHAIN_APPROVALS?.toLowerCase() !== "false"; // Default: true (CLOB is broken)
  const onchainApprovalsVerified =
    (params.client as { onchainApprovalsVerified?: boolean })
      .onchainApprovalsVerified ?? false;

  try {
    let refreshed = false;
    let collateralSnapshot = await fetchBalanceAllowance(
      params.client,
      AssetType.COLLATERAL,
      undefined,
      params.logger,
    );
    let conditionalSnapshot = params.conditionalTokenId
      ? await fetchBalanceAllowance(
          params.client,
          AssetType.CONDITIONAL,
          params.conditionalTokenId,
          params.logger,
        )
      : null;
    let balanceUsd = collateralSnapshot.balanceUsd;
    let allowanceUsd = collateralSnapshot.allowanceUsd;

    const refreshAndRetry = async (): Promise<void> => {
      if (refreshed) return;
      refreshed = true;
      params.logger.info(
        "[CLOB] Refreshing balance/allowance cache before skipping order.",
      );
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

    const insufficientSnapshot = !isSnapshotSufficient(
      collateralSnapshot,
      requiredUsd,
    )
      ? collateralSnapshot
      : conditionalSnapshot &&
          !isSnapshotSufficient(conditionalSnapshot, requiredUsd)
        ? conditionalSnapshot
        : null;

    if (insufficientSnapshot) {
      // Always refresh cache on first insufficient check to ensure we have fresh data
      await refreshAndRetry();

      // Re-check after refresh
      const refreshedInsufficient = !isSnapshotSufficient(
        collateralSnapshot,
        requiredUsd,
      )
        ? collateralSnapshot
        : conditionalSnapshot &&
            !isSnapshotSufficient(conditionalSnapshot, requiredUsd)
          ? conditionalSnapshot
          : null;

      if (refreshedInsufficient) {
        const balanceSufficient =
          refreshedInsufficient.balanceUsd >= requiredUsd;
        const allowanceSufficient =
          refreshedInsufficient.allowanceUsd >= requiredUsd;

        // Trust mode bypass: Only applies to COLLATERAL tokens (USDC) when:
        // 1. Trust mode is enabled (TRUST_ONCHAIN_APPROVALS=true)
        // 2. Preflight verified on-chain approvals
        // 3. Balance is sufficient (only allowance is the issue)
        // 4. This is a collateral token (not conditional)
        // This bypasses CLOB's broken allowance=0 response for USDC approvals only.
        const canBypassAllowanceCheck =
          trustOnchainApprovals &&
          onchainApprovalsVerified &&
          balanceSufficient &&
          !allowanceSufficient &&
          refreshedInsufficient.assetType === AssetType.COLLATERAL;

        if (canBypassAllowanceCheck) {
          params.logger.info(
            `[CLOB][TrustMode] Bypassing CLOB allowance check for COLLATERAL (known bug). Balance sufficient and on-chain approvals verified. need=${formatUsd(requiredUsd)} have=${formatUsd(refreshedInsufficient.balanceUsd)} allowance=${formatUsd(refreshedInsufficient.allowanceUsd)}`,
          );
          // Skip the error return and continue with ERC1155 approval checks below
        } else {
          const reason = "INSUFFICIENT_BALANCE_OR_ALLOWANCE";
          const assetLabel = formatAssetLabel(refreshedInsufficient);
          params.logger.warn(
            `[CLOB] Order skipped (${reason}): need=${formatUsd(requiredUsd)} have=${formatUsd(refreshedInsufficient.balanceUsd)} allowance=${formatUsd(refreshedInsufficient.allowanceUsd)} asset=${assetLabel} signer=${signerAddress} collateral=${collateralLabel}`,
          );

          if (
            refreshedInsufficient.allowanceUsd < requiredUsd &&
            refreshedInsufficient.assetType === AssetType.COLLATERAL
          ) {
            if (params.autoApprove && params.collateralTokenAddress) {
              const wallet = (params.client as { wallet?: Wallet }).wallet;
              if (!wallet) {
                params.logger.warn(
                  `[CLOB] Auto-approve requested but wallet missing. signer=${signerAddress} collateral=${collateralLabel}`,
                );
              } else {
                const approvalsConfig = readApprovalsConfig();
                const liveTradingEnabled = isLiveTradingEnabled();
                if (!liveTradingEnabled || approvalsConfig.mode !== "true") {
                  params.logger.warn(
                    `[CLOB] Auto-approve blocked (live trading disabled or APPROVALS_AUTO!=true). signer=${signerAddress} collateral=${collateralLabel}`,
                  );
                  return {
                    ok: false,
                    requiredUsd,
                    balanceUsd: refreshedInsufficient.balanceUsd,
                    allowanceUsd: refreshedInsufficient.allowanceUsd,
                    reason,
                  };
                }

                const approvalKey = `${tradingAddress}:${params.collateralTokenAddress}`;
                const lastAttempt =
                  approvalAttemptCooldown.get(approvalKey) ?? 0;
                if (Date.now() - lastAttempt < APPROVAL_RETRY_COOLDOWN_MS) {
                  params.logger.warn(
                    "[CLOB] Auto-approve cooldown active; skipping approval retry.",
                  );
                } else {
                  if (
                    params.autoApproveMaxUsd &&
                    params.autoApproveMaxUsd < requiredUsd
                  ) {
                    params.logger.warn(
                      `[CLOB] Auto-approve cap ${formatUsd(params.autoApproveMaxUsd)} is below required ${formatUsd(requiredUsd)}.`,
                    );
                    return {
                      ok: false,
                      requiredUsd,
                      balanceUsd: refreshedInsufficient.balanceUsd,
                      allowanceUsd: refreshedInsufficient.allowanceUsd,
                      reason,
                    };
                  }
                  approvalAttemptCooldown.set(approvalKey, Date.now());
                  await ensureApprovals({
                    wallet,
                    owner: tradingAddress,
                    relayer: (
                      params.client as { relayerContext?: RelayerContext }
                    ).relayerContext,
                    logger: params.logger,
                    config: approvalsConfig,
                  });

                  // Sync CLOB cache with on-chain state after approvals
                  await syncClobAllowanceCache(
                    params.client,
                    params.logger,
                    "after auto-approve",
                  );

                  // Refresh again after approval
                  await refreshAndRetry();
                }
              }
            } else {
              if (refreshedInsufficient.allowanceUsd <= 0) {
                params.logger.warn(
                  `[CLOB] Allowance is 0; approvals needed for collateral ${collateralLabel}.`,
                );
              } else {
                params.logger.warn(
                  `[CLOB] Approval required for collateral ${collateralLabel}.`,
                );
              }
            }
          }

          return {
            ok: false,
            requiredUsd,
            balanceUsd: refreshedInsufficient.balanceUsd,
            allowanceUsd: refreshedInsufficient.allowanceUsd,
            reason,
          };
        }
      }
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
          const liveTradingEnabled = isLiveTradingEnabled();
          if (liveTradingEnabled && approvalsConfig.mode === "true") {
            const approvalKey = `${tradingAddress}:erc1155`;
            const lastAttempt = approvalAttemptCooldown.get(approvalKey) ?? 0;
            if (Date.now() - lastAttempt >= APPROVAL_RETRY_COOLDOWN_MS) {
              approvalAttemptCooldown.set(approvalKey, Date.now());
              await ensureApprovals({
                wallet,
                owner: tradingAddress,
                relayer: (params.client as { relayerContext?: RelayerContext })
                  .relayerContext,
                logger: params.logger,
                config: approvalsConfig,
              });

              // Sync CLOB cache with on-chain state after approvals
              await syncClobAllowanceCache(
                params.client,
                params.logger,
                "after ERC1155 approval",
              );

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
                  reason: "INSUFFICIENT_ALLOWANCE_OR_APPROVAL",
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
        reason: "INSUFFICIENT_ALLOWANCE_OR_APPROVAL",
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
    // Use deduplicated warning to prevent log spam during concurrent failures
    logBalanceCheckWarn(
      params.logger,
      signerAddress,
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
      const ok =
        onchain.balanceUsd >= requiredUsd &&
        onchain.allowanceUsd >= requiredUsd &&
        onchain.approvedForAll;
      if (!ok) {
        return {
          ok: false,
          requiredUsd,
          balanceUsd: onchain.balanceUsd,
          allowanceUsd: onchain.allowanceUsd,
          reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE",
        };
      }
      return {
        ok: true,
        requiredUsd,
        balanceUsd: onchain.balanceUsd,
        allowanceUsd: onchain.allowanceUsd,
        reason: "BALANCE_ALLOWANCE_FALLBACK_ONCHAIN",
      };
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      // Use deduplicated warning for fallback failures too
      logBalanceCheckWarn(
        params.logger,
        signerAddress,
        `[CLOB] Onchain fallback failed: ${fallbackMessage}`,
      );
      return {
        ok: true,
        requiredUsd,
        balanceUsd: 0,
        allowanceUsd: 0,
        reason: "BALANCE_ALLOWANCE_UNAVAILABLE",
      };
    }
  }
};
