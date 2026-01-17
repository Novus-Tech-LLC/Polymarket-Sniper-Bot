import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';
import { utils } from 'ethers';
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

const formatUnits = (value: utils.BigNumberish, decimals: number): string =>
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
  let relayer = { enabled: false, signerAddress: derivedSignerAddress };
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
          params.logger.warn('[CLOB] Auth preflight failed; switching to detect-only.');
          params.logger.warn(formatClobAuthFailureHint(params.clobDeriveEnabled));
        } else if (preflight && !preflight.ok) {
          params.logger.warn('[CLOB] Auth preflight failed; continuing with order submissions.');
        }
      }
    } catch (err) {
      const maybeError = err as { code?: string; message?: string };
      if (maybeError?.code === 'ECONNRESET') {
        params.logger.warn(`[CLOB] Auth preflight transient failure; continuing. ${sanitizeErrorMessage(err)}`);
      } else if (isAuthError(err)) {
        detectOnly = true;
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
    (params.client as ClobClient & { relayerContext?: ReturnType<typeof createRelayerContext> }).relayerContext = relayer;
    return { detectOnly: true };
  }

  let approvalResult;
  try {
    approvalResult = await ensureApprovals({
      wallet,
      owner: tradingAddress,
      relayer: relayer.enabled ? relayer : undefined,
      logger: params.logger,
      config: approvalsConfig,
    });
  } catch (error) {
    params.logger.warn(`[Preflight][Approvals] Failed to ensure approvals. ${sanitizeErrorMessage(error)}`);
    detectOnly = true;
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
    }
  }

  params.logger.info(
    `[Preflight] READY_TO_TRADE=${!detectOnly} reason=${detectOnly ? 'CHECKS_FAILED' : 'OK'}`,
  );

  (params.client as ClobClient & { relayerContext?: ReturnType<typeof createRelayerContext> }).relayerContext = relayer;

  return { detectOnly };
};
