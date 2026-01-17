import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';
import { Contract, constants, utils } from 'ethers';
import type { BigNumber, Wallet } from 'ethers';
import { isAuthError } from '../infrastructure/clob-auth';
import { runClobAuthMatrixPreflight, runClobAuthPreflight } from '../clob/diagnostics';
import { formatClobAuthFailureHint } from '../utils/clob-auth-hint.util';
import type { Logger } from '../utils/logger.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';
import { publicKeyMatchesDerived, deriveSignerAddress } from '../clob/diagnostics';
import { resolvePolymarketContracts } from './contracts';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ERC1155_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

export type ApprovalMode = 'true' | 'false' | 'dryrun';

export type ApprovalsConfig = {
  mode: ApprovalMode;
  minUsdcAllowanceRaw: string;
  minUsdcAllowanceUsd: number;
  gasBumpBps: number;
  force: boolean;
  confirmations: number;
};

export type TradingReadyParams = {
  client: ClobClient & { wallet: Wallet; derivedCreds?: ApiKeyCreds };
  logger: Logger;
  privateKey: string;
  configuredPublicKey?: string;
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

const parseNumber = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

export const readApprovalsConfig = (): ApprovalsConfig => {
  const modeRaw = readEnv('APPROVALS_AUTO');
  const modeValue = (modeRaw ?? 'false').toLowerCase();
  const mode: ApprovalMode = modeValue === 'true' || modeValue === 'dryrun' ? modeValue : 'false';
  const minUsdcAllowanceRaw = readEnv('APPROVALS_MIN_USDC_ALLOWANCE') ?? '1000';
  return {
    mode,
    minUsdcAllowanceRaw,
    minUsdcAllowanceUsd: parseNumber(minUsdcAllowanceRaw, 1000),
    gasBumpBps: parseNumber(readEnv('APPROVALS_GAS_BUMP_BPS'), 0),
    force: parseBool(readEnv('APPROVALS_FORCE'), false),
    confirmations: Math.max(1, Math.floor(parseNumber(readEnv('APPROVALS_CONFIRMATIONS'), 1))),
  };
};

const isLiveTradingEnabled = (): boolean => readEnv('ARB_LIVE_TRADING') === 'I_UNDERSTAND_THE_RISKS';

const formatUnits = (value: BigNumber, decimals: number): string =>
  Number(utils.formatUnits(value, decimals)).toFixed(2);

const formatGasGwei = (value: BigNumber): string => Number(utils.formatUnits(value, 'gwei')).toFixed(2);

const buildTxOverrides = async (
  wallet: Wallet,
  gasBumpBps: number,
): Promise<{ gasPrice?: BigNumber }> => {
  if (!wallet.provider) return {};
  if (gasBumpBps <= 0) return {};
  const gasPrice = await wallet.provider.getGasPrice();
  const bumped = gasPrice.mul(10000 + gasBumpBps).div(10000);
  return { gasPrice: bumped };
};

const logApprovalInstruction = (params: {
  logger: Logger;
  usdcAddress: string;
  spender: string;
  ctfErc1155Address: string;
}): void => {
  params.logger.warn('[Preflight][Approvals] Approvals required for live trading:');
  params.logger.warn(`[Preflight][Approvals] ERC20 approve token=${params.usdcAddress} spender=${params.spender} amount=MAX_UINT256`);
  params.logger.warn(`[Preflight][Approvals] ERC1155 setApprovalForAll token=${params.ctfErc1155Address} operator=${params.spender} approved=true`);
};

const logDryRunTx = (params: {
  logger: Logger;
  label: string;
  to: string;
  data: string;
  gasEstimate?: BigNumber;
  gasPrice?: BigNumber;
}): void => {
  const gasPart = params.gasEstimate ? ` gasEstimate=${params.gasEstimate.toString()}` : '';
  const gasPricePart = params.gasPrice ? ` gasPrice=${formatGasGwei(params.gasPrice)} gwei` : '';
  params.logger.info(`[Preflight][Approvals][DryRun] ${params.label} to=${params.to} value=0 data=${params.data}${gasPart}${gasPricePart}`);
};

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
  const contracts = resolvePolymarketContracts();
  const wallet = params.client.wallet;
  const spender = contracts.ctfExchangeAddress;
  const ctfErc1155Address = contracts.ctfErc1155Address;
  const negRiskEnabled = parseBool(readEnv('POLY_NEG_RISK_ENABLED'), false);
  if (negRiskEnabled && !contracts.negRiskExchangeAddress) {
    params.logger.warn('[Preflight][Approvals] POLY_NEG_RISK_ENABLED=true but POLY_NEG_RISK_EXCHANGE_ADDRESS missing.');
  }

  params.logger.info(
    `[Preflight][Approvals] Checking allowances spender=${spender ?? 'missing'} ctfErc1155=${ctfErc1155Address ?? 'missing'} usdc=${contracts.usdcAddress}`,
  );

  const usdcContract = new Contract(contracts.usdcAddress, ERC20_ABI, wallet);
  const usdcBalance = await usdcContract.balanceOf(wallet.address);

  let usdcAllowance = constants.Zero;
  if (spender) {
    usdcAllowance = await usdcContract.allowance(wallet.address, spender);
  }

  let ctfIsApprovedForAll = false;
  if (spender && ctfErc1155Address) {
    const ctfContract = new Contract(ctfErc1155Address, ERC1155_ABI, wallet);
    ctfIsApprovedForAll = await ctfContract.isApprovedForAll(wallet.address, spender);
  }

  params.logger.info(
    `[Preflight][Approvals] USDC balance=${formatUnits(usdcBalance, params.collateralTokenDecimals)} allowance=${formatUnits(usdcAllowance, params.collateralTokenDecimals)} min=${approvalsConfig.minUsdcAllowanceUsd.toFixed(2)} approvedForAll=${ctfIsApprovedForAll}`,
  );

  if (!spender || !ctfErc1155Address) {
    params.logger.warn(
      '[Preflight][Approvals] Missing POLY_CTF_EXCHANGE_ADDRESS or POLY_CTF_ERC1155_ADDRESS; approvals cannot be performed.',
    );
    return { detectOnly: true };
  }

  const minAllowanceRaw = utils.parseUnits(approvalsConfig.minUsdcAllowanceRaw, params.collateralTokenDecimals);
  const needsApproveErc20 = approvalsConfig.force || usdcAllowance.lt(minAllowanceRaw);
  const needsApproveErc1155 = approvalsConfig.force || !ctfIsApprovedForAll;

  if (!needsApproveErc20 && !needsApproveErc1155) {
    return { detectOnly };
  }

  if (!liveTradingEnabled) {
    params.logger.warn('[Preflight][Approvals] Approvals needed but live trading disabled; staying detect-only.');
    return { detectOnly: true };
  }

  if (approvalsConfig.mode === 'false') {
    logApprovalInstruction({
      logger: params.logger,
      usdcAddress: contracts.usdcAddress,
      spender,
      ctfErc1155Address,
    });
    params.logger.warn('[Preflight][Approvals] APPROVALS_AUTO=false; staying detect-only.');
    return { detectOnly: true };
  }

  const erc20Interface = new utils.Interface(ERC20_ABI);
  const erc1155Interface = new utils.Interface(ERC1155_ABI);
  const approvals = [
    {
      label: 'ERC20.approve',
      needed: needsApproveErc20,
      to: contracts.usdcAddress,
      data: erc20Interface.encodeFunctionData('approve', [spender, constants.MaxUint256]),
      send: (overridesToUse?: { gasPrice?: BigNumber }) =>
        usdcContract.approve(spender, constants.MaxUint256, overridesToUse ?? {}),
      estimate: () => usdcContract.estimateGas.approve(spender, constants.MaxUint256),
    },
    {
      label: 'ERC1155.setApprovalForAll',
      needed: needsApproveErc1155,
      to: ctfErc1155Address,
      data: erc1155Interface.encodeFunctionData('setApprovalForAll', [spender, true]),
      send: (overridesToUse?: { gasPrice?: BigNumber }) =>
        new Contract(ctfErc1155Address, ERC1155_ABI, wallet).setApprovalForAll(
          spender,
          true,
          overridesToUse ?? {},
        ),
      estimate: () => new Contract(ctfErc1155Address, ERC1155_ABI, wallet).estimateGas.setApprovalForAll(spender, true),
    },
  ];

  const overrides = await buildTxOverrides(wallet, approvalsConfig.gasBumpBps);
  if (overrides.gasPrice) {
    params.logger.info(
      `[Preflight][Approvals] Gas bump applied bps=${approvalsConfig.gasBumpBps} gasPrice=${formatGasGwei(overrides.gasPrice)} gwei`,
    );
  }

  if (approvalsConfig.mode === 'dryrun') {
    for (const approval of approvals) {
      if (!approval.needed) continue;
      let gasEstimate: BigNumber | undefined;
      try {
        gasEstimate = await approval.estimate();
      } catch {
        gasEstimate = undefined;
      }
      logDryRunTx({
        logger: params.logger,
        label: approval.label,
        to: approval.to,
        data: approval.data,
        gasEstimate,
        gasPrice: overrides.gasPrice,
      });
    }
    params.logger.warn('[Preflight][Approvals] APPROVALS_AUTO=dryrun; staying detect-only.');
    return { detectOnly: true };
  }

  if (approvalsConfig.mode !== 'true') {
    params.logger.warn('[Preflight][Approvals] Approvals required but APPROVALS_AUTO disabled.');
    return { detectOnly: true };
  }

  for (const approval of approvals) {
    if (!approval.needed) continue;
    params.logger.info(`[Preflight][Approvals] Sending ${approval.label} spender=${spender}`);
    const tx = await approval.send(overrides);
    params.logger.info(`[Preflight][Approvals] Tx submitted ${approval.label} to=${approval.to} hash=${tx.hash}`);
    await tx.wait(approvalsConfig.confirmations);
    params.logger.info(`[Preflight][Approvals] Tx confirmed ${approval.label}`);
  }

  const refreshedAllowance = await usdcContract.allowance(wallet.address, spender);
  const refreshedApproval = await new Contract(ctfErc1155Address, ERC1155_ABI, wallet)
    .isApprovedForAll(wallet.address, spender);
  if (refreshedAllowance.lt(minAllowanceRaw) || !refreshedApproval) {
    params.logger.error('[Preflight][Approvals] Approvals still insufficient after tx confirmation.');
    return { detectOnly: true };
  }

  params.logger.info('[Preflight][Approvals] Approvals satisfied.');
  return { detectOnly };
};
