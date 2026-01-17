import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';
import { utils, type BigNumberish } from 'ethers';
import type { Wallet } from 'ethers';
import { isAuthError } from '../infrastructure/clob-auth';
import { runClobAuthMatrixPreflight, runClobAuthPreflight } from '../clob/diagnostics';
import { formatClobAuthFailureHint } from '../utils/clob-auth-hint.util';
import type { Logger } from '../utils/logger.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';
import { publicKeyMatchesDerived, deriveSignerAddress } from '../clob/diagnostics';
import { resolvePolymarketContracts } from './contracts';
import { ensureApprovals, readApprovalsConfig } from './approvals';
import { createRelayerContext, deployIfNeeded } from './relayer';

export { readApprovalsConfig };

export type TradingReadyParams = {
  client: ClobClient & { wallet: Wallet; derivedCreds?: ApiKeyCreds };
  logger: Logger;
  privateKey: string;
  configuredPublicKey?: string;
  rpcUrl: string;
  detectOnly: boolean;
  clobCredsComplete: boolean;
  clobDeriveEnabled: boolean;
  collateralTokenDecimals: number;
};

const readEnv = (key: string): string | undefined => process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw) return fallback;
  return String(raw).toLowerCase() === 'true';
};

const isLiveTradingEnabled = (): boolean => readEnv('ARB_LIVE_TRADING') === 'I_UNDERSTAND_THE_RISKS';

const formatUnits = (value: BigNumberish, decimals: number): string =>
  Number(utils.formatUnits(value, decimals)).toFixed(2);

export const ensureTradingReady = async (
  params: TradingReadyParams,
): Promise<{ detectOnly: boolean }> => {
  const derivedSignerAddress = deriveSignerAddress(params.privateKey);
  if (params.configuredPublicKey && !publicKeyMatchesDerived(params.configuredPublicKey, derivedSignerAddress)) {
    if (!parseBool(readEnv('FORCE_MISMATCH'), false)) {
      params.logger.error(
        `[Preflight] PUBLIC_KEY mismatch configured=${params.configuredPublicKey} derived=${derivedSignerAddress}.`,
      );
      throw new Error('public_key_mismatch');
    }
    params.logger.warn('[Preflight] FORCE_MISMATCH=true; continuing despite PUBLIC_KEY mismatch.');
  }

  let detectOnly = params.detectOnly;
  const liveTradingEnabled = isLiveTradingEnabled();
  const contracts = resolvePolymarketContracts();
  let relayer: ReturnType<typeof createRelayerContext> = { enabled: false, signerAddress: derivedSignerAddress };
  try {
    relayer = createRelayerContext({
      privateKey: params.privateKey,
      rpcUrl: params.rpcUrl,
      logger: params.logger,
    });
  } catch (error) {
    params.logger.warn(`[Relayer] Failed to initialize relayer client. ${sanitizeErrorMessage(error)}`);
  }
  if (!liveTradingEnabled) {
    detectOnly = true;
    params.logger.warn('[Preflight] ARB_LIVE_TRADING not enabled; trading disabled.');
  }

  let authOk = false;
  if (params.clobCredsComplete || params.clobDeriveEnabled) {
    try {
      const matrixEnabled = readEnv('CLOB_PREFLIGHT_MATRIX') === 'true'
        || readEnv('clob_preflight_matrix') === 'true';
      if (matrixEnabled) {
        const matrix = await runClobAuthMatrixPreflight({
          client: params.client,
          logger: params.logger,
          creds: (params.client as { creds?: ApiKeyCreds }).creds,
          derivedCreds: params.client.derivedCreds,
        });
        if (matrix && !matrix.ok) {
          detectOnly = true;
          authOk = false;
        } else if (matrix && matrix.ok) {
          authOk = true;
        }
      } else {
        const preflight = await runClobAuthPreflight({
          client: params.client,
          logger: params.logger,
          creds: (params.client as { creds?: ApiKeyCreds }).creds,
          derivedSignerAddress,
          configuredPublicKey: params.configuredPublicKey,
          privateKeyPresent: Boolean(params.privateKey),
          derivedCredsEnabled: params.clobDeriveEnabled,
          force: readEnv('CLOB_AUTH_FORCE') === 'true',
        });
        if (preflight && !preflight.ok && (preflight.status === 401 || preflight.status === 403)) {
          detectOnly = true;
          authOk = false;
          params.logger.warn('[CLOB] Auth preflight failed; switching to detect-only.');
          params.logger.warn(formatClobAuthFailureHint(params.clobDeriveEnabled));
        } else if (preflight && !preflight.ok) {
          authOk = false;
          params.logger.warn('[CLOB] Auth preflight failed; continuing with order submissions.');
        } else if (preflight && preflight.ok) {
          authOk = true;
        }
      }
    } catch (err) {
      const maybeError = err as { code?: string; message?: string };
      if (maybeError?.code === 'ECONNRESET') {
        params.logger.warn(`[CLOB] Auth preflight transient failure; continuing. ${sanitizeErrorMessage(err)}`);
      } else if (isAuthError(err)) {
        detectOnly = true;
        authOk = false;
        params.logger.warn(`[CLOB] Auth preflight failed; switching to detect-only. ${sanitizeErrorMessage(err)}`);
        params.logger.warn(formatClobAuthFailureHint(params.clobDeriveEnabled));
      } else {
        params.logger.warn(`[CLOB] Auth preflight failed; continuing. ${sanitizeErrorMessage(err)}`);
      }
    }
  } else {
    params.logger.info('[Preflight] CLOB auth disabled; skipping authenticated endpoint check.');
  }

  const approvalsConfig = readApprovalsConfig();
  const wallet = params.client.wallet;
  if (relayer.enabled) {
    try {
      await deployIfNeeded({ relayer, logger: params.logger });
    } catch (error) {
      params.logger.warn(`[Relayer] Deploy check failed; falling back to EOA approvals. ${sanitizeErrorMessage(error)}`);
    }
  }

  const tradingAddress = relayer.tradingAddress ?? derivedSignerAddress;
  params.logger.info(
    `[Preflight] signer=${derivedSignerAddress} effective_trading_address=${tradingAddress} public_key=${params.configuredPublicKey ?? 'none'}`,
  );
  params.logger.info(
    `[Preflight] contracts usdc=${contracts.usdcAddress} ctf=${contracts.ctfAddress ?? 'n/a'} ctf_exchange=${contracts.ctfExchangeAddress ?? 'n/a'} neg_risk_exchange=${contracts.negRiskExchangeAddress ?? 'n/a'} neg_risk_adapter=${contracts.negRiskAdapterAddress ?? 'n/a'}`,
  );

  if (!liveTradingEnabled) {
    params.logger.info('[Preflight] READY_TO_TRADE=false reason=LIVE_TRADING_DISABLED');
    logPreflightSummary({
      logger: params.logger,
      signer: derivedSignerAddress,
      effectiveTradingAddress: tradingAddress,
      relayerEnabled: relayer.enabled,
      approvalsOk: false,
      authOk,
      readyToTrade: false,
    });
    (params.client as ClobClient & { relayerContext?: ReturnType<typeof createRelayerContext> }).relayerContext = relayer;
    return { detectOnly: true };
  }

  let approvalResult;
  let approvalsOk = false;
  try {
    approvalResult = await ensureApprovals({
      wallet,
      owner: tradingAddress,
      relayer: relayer.enabled ? relayer : undefined,
      logger: params.logger,
      config: approvalsConfig,
    });
    approvalsOk = approvalResult?.ok ?? false;
  } catch (error) {
    params.logger.warn(`[Preflight][Approvals] Failed to ensure approvals. ${sanitizeErrorMessage(error)}`);
    detectOnly = true;
    approvalsOk = false;
  }

  if (approvalResult) {
    const balanceDisplay = formatUnits(approvalResult.snapshot.usdcBalance, params.collateralTokenDecimals);
    const allowanceDetails = approvalResult.snapshot.allowances
      .map(({ spender, allowance }) => `${spender}=${formatUnits(allowance, params.collateralTokenDecimals)}`)
      .join(' ');
    const approvedForAll = approvalResult.snapshot.erc1155Approvals.every(({ approved }) => approved);
    params.logger.info(
      `[Preflight][Approvals] USDC balance=${balanceDisplay} allowances=[${allowanceDetails || 'none'}] approvedForAll=${approvedForAll}`,
    );

    if (!approvalResult.ok) {
      detectOnly = true;
      approvalsOk = false;
    }
  } else {
    // If no approval result, approvals failed
    detectOnly = true;
    approvalsOk = false;
  }

  const readyToTrade = !detectOnly && approvalsOk && authOk;

  params.logger.info(
    `[Preflight] READY_TO_TRADE=${readyToTrade} reason=${detectOnly ? 'CHECKS_FAILED' : 'OK'}`,
  );

  logPreflightSummary({
    logger: params.logger,
    signer: derivedSignerAddress,
    effectiveTradingAddress: tradingAddress,
    relayerEnabled: relayer.enabled,
    approvalsOk,
    authOk,
    readyToTrade,
  });

  (params.client as ClobClient & { relayerContext?: ReturnType<typeof createRelayerContext> }).relayerContext = relayer;

  return { detectOnly };
};

const logPreflightSummary = (params: {
  logger: Logger;
  signer: string;
  effectiveTradingAddress: string;
  relayerEnabled: boolean;
  approvalsOk: boolean;
  authOk: boolean;
  readyToTrade: boolean;
}): void => {
  params.logger.info(
    `[Preflight][Summary] signer=${params.signer} effective_trading_address=${params.effectiveTradingAddress} relayer_enabled=${params.relayerEnabled} approvals_ok=${params.approvalsOk} auth_ok=${params.authOk} ready_to_trade=${params.readyToTrade}`,
  );
};
