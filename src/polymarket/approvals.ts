import { BigNumber, Contract, constants, utils } from "ethers";
import type { Wallet } from "ethers";
import type { Logger } from "../utils/logger.util";
import { estimateGasFees, retryTxWithBackoff } from "../utils/gas";
import { resolvePolymarketContracts } from "./contracts";
import type { RelayerContext } from "./relayer";
import { executeRelayerTxs } from "./relayer";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

export type ApprovalMode = "true" | "false" | "dryrun";

export type ApprovalsConfig = {
  mode: ApprovalMode;
  minUsdcAllowanceRaw: string;
  minUsdcAllowanceUsd: number;
  approveMaxUint: boolean;
  gasBumpBps: number;
  force: boolean;
  confirmations: number;
};

export type ApprovalDecision = {
  needsErc20: boolean;
  needsErc1155: boolean;
};

export type ApprovalSnapshot = {
  usdcBalance: BigNumber;
  allowances: Array<{ spender: string; allowance: BigNumber }>;
  erc1155Approvals: Array<{ operator: string; approved: boolean }>;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw) return fallback;
  return String(raw).toLowerCase() === "true";
};

const parseNumber = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

export const readApprovalsConfig = (): ApprovalsConfig => {
  const modeRaw = readEnv("APPROVALS_AUTO");
  const modeValue = (modeRaw ?? "true").toLowerCase();
  const mode: ApprovalMode =
    modeValue === "true" || modeValue === "dryrun" ? modeValue : "false";
  const minUsdcAllowanceRaw =
    readEnv("APPROVAL_MIN_USDC") ??
    readEnv("APPROVALS_MIN_USDC_ALLOWANCE") ??
    "1000";
  return {
    mode,
    minUsdcAllowanceRaw,
    minUsdcAllowanceUsd: parseNumber(minUsdcAllowanceRaw, 1000),
    approveMaxUint: parseBool(readEnv("APPROVAL_MAX_UINT"), true),
    gasBumpBps: parseNumber(readEnv("APPROVALS_GAS_BUMP_BPS"), 0),
    force: parseBool(readEnv("APPROVALS_FORCE"), false),
    confirmations: Math.max(
      1,
      Math.floor(parseNumber(readEnv("APPROVALS_CONFIRMATIONS"), 1)),
    ),
  };
};

export const resolveApprovalTargets = () => {
  const contracts = resolvePolymarketContracts();
  const usdcSpenders = [
    contracts.ctfAddress,
    contracts.ctfExchangeAddress,
    contracts.negRiskExchangeAddress,
  ].filter(Boolean) as string[];
  const erc1155Operators = [
    contracts.ctfExchangeAddress,
    contracts.negRiskExchangeAddress,
  ].filter(Boolean) as string[];
  return {
    contracts,
    usdcSpenders,
    erc1155Operators,
  };
};

export const getApprovalDecision = (params: {
  allowance: BigNumber;
  minAllowance: BigNumber;
  approvedForAll: boolean;
  force: boolean;
}): ApprovalDecision => {
  return {
    needsErc20: params.force || params.allowance.lt(params.minAllowance),
    needsErc1155: params.force || !params.approvedForAll,
  };
};

export const fetchApprovalSnapshot = async (params: {
  wallet: Wallet;
  owner: string;
  logger: Logger;
}): Promise<ApprovalSnapshot> => {
  const { contracts, usdcSpenders, erc1155Operators } =
    resolveApprovalTargets();
  if (!contracts.ctfErc1155Address) {
    throw new Error("Missing CTF ERC1155 address for approvals.");
  }
  const usdcContract = new Contract(
    contracts.usdcAddress,
    ERC20_ABI,
    params.wallet.provider ?? params.wallet,
  );
  const usdcBalance = await usdcContract.balanceOf(params.owner);
  const allowances = await Promise.all(
    usdcSpenders.map(async (spender) => ({
      spender,
      allowance: await usdcContract.allowance(params.owner, spender),
    })),
  );
  const erc1155Contract = new Contract(
    contracts.ctfErc1155Address,
    ERC1155_ABI,
    params.wallet.provider ?? params.wallet,
  );
  const erc1155Approvals = await Promise.all(
    erc1155Operators.map(async (operator) => ({
      operator,
      approved: await erc1155Contract.isApprovedForAll(params.owner, operator),
    })),
  );

  params.logger.info(
    `[Preflight][Approvals] USDC balance=${utils.formatUnits(usdcBalance, 6)} owner=${params.owner}`,
  );

  // Log detailed allowance state for each spender
  allowances.forEach(({ spender, allowance }) => {
    const allowanceFormatted = utils.formatUnits(allowance, 6);
    const sufficient = allowance.gt(0) ? "✅" : "❌";
    params.logger.info(
      `[Preflight][Approvals][USDC] ${sufficient} spender=${spender} allowance=${allowanceFormatted}`,
    );
  });

  // Log detailed ERC1155 approval state for each operator
  erc1155Approvals.forEach(({ operator, approved }) => {
    const status = approved ? "✅" : "❌";
    params.logger.info(
      `[Preflight][Approvals][ERC1155] ${status} operator=${operator} approvedForAll=${approved}`,
    );
  });

  return {
    usdcBalance,
    allowances,
    erc1155Approvals,
  };
};

export const ensureApprovals = async (params: {
  wallet: Wallet;
  owner: string;
  relayer?: RelayerContext;
  logger: Logger;
  config: ApprovalsConfig;
}): Promise<{ ok: boolean; snapshot: ApprovalSnapshot }> => {
  const { contracts, usdcSpenders, erc1155Operators } =
    resolveApprovalTargets();
  if (
    !contracts.ctfErc1155Address ||
    usdcSpenders.length === 0 ||
    erc1155Operators.length === 0
  ) {
    params.logger.warn(
      "[Preflight][Approvals] Missing spender/operator addresses; approvals cannot be performed.",
    );
    const snapshot = await fetchApprovalSnapshot({
      wallet: params.wallet,
      owner: params.owner,
      logger: params.logger,
    });
    return { ok: false, snapshot };
  }

  const minAllowance = utils.parseUnits(params.config.minUsdcAllowanceRaw, 6);
  const snapshot = await fetchApprovalSnapshot({
    wallet: params.wallet,
    owner: params.owner,
    logger: params.logger,
  });

  const approvalAmount = params.config.approveMaxUint
    ? constants.MaxUint256
    : minAllowance;
  const approvalsToSend: Array<{
    label: string;
    to: string;
    data: string;
    type: "erc20" | "erc1155";
    spender: string;
  }> = [];
  const erc20Interface = new utils.Interface(ERC20_ABI);
  const erc1155Interface = new utils.Interface(ERC1155_ABI);

  snapshot.allowances.forEach(({ spender, allowance }) => {
    const decision = getApprovalDecision({
      allowance,
      minAllowance,
      approvedForAll: true,
      force: params.config.force,
    });
    if (decision.needsErc20) {
      approvalsToSend.push({
        label: `ERC20.approve spender=${spender}`,
        to: contracts.usdcAddress,
        data: erc20Interface.encodeFunctionData("approve", [
          spender,
          approvalAmount,
        ]),
        type: "erc20",
        spender,
      });
    }
  });

  snapshot.erc1155Approvals.forEach(({ operator, approved }) => {
    const decision = getApprovalDecision({
      allowance: minAllowance,
      minAllowance,
      approvedForAll: approved,
      force: params.config.force,
    });
    if (decision.needsErc1155) {
      approvalsToSend.push({
        label: `ERC1155.setApprovalForAll operator=${operator}`,
        to: contracts.ctfErc1155Address!,
        data: erc1155Interface.encodeFunctionData("setApprovalForAll", [
          operator,
          true,
        ]),
        type: "erc1155",
        spender: operator,
      });
    }
  });

  if (approvalsToSend.length === 0) {
    params.logger.info("[Preflight][Approvals] Approvals already satisfied.");
    return { ok: true, snapshot };
  }

  if (params.config.mode === "false") {
    approvalsToSend.forEach((approval) => {
      params.logger.warn(
        `[Preflight][Approvals] Required ${approval.label} token=${approval.to}`,
      );
    });
    params.logger.warn(
      "[Preflight][Approvals] APPROVALS_AUTO=false; staying detect-only.",
    );
    return { ok: false, snapshot };
  }

  if (params.config.mode === "dryrun") {
    approvalsToSend.forEach((approval) => {
      params.logger.info(
        `[Preflight][Approvals][DryRun] ${approval.label} to=${approval.to} data=${approval.data}`,
      );
    });
    params.logger.warn(
      "[Preflight][Approvals] APPROVALS_AUTO=dryrun; staying detect-only.",
    );
    return { ok: false, snapshot };
  }

  const useRelayerForApprovals =
    readEnv("USE_RELAYER_FOR_APPROVALS") !== "false"; // Default true

  if (
    params.relayer?.enabled &&
    params.relayer.client &&
    useRelayerForApprovals
  ) {
    params.logger.info(
      "[Preflight][Approvals] Using relayer for gasless approvals.",
    );
    const relayerTxs = approvalsToSend.map((approval) => ({
      to: approval.to,
      data: approval.data,
    }));
    const result = await executeRelayerTxs({
      relayer: params.relayer,
      txs: relayerTxs,
      description: "preflight approvals",
      logger: params.logger,
    });
    params.logger.info(
      `[Preflight][Approvals] Relayer approvals sent relayer_tx_id=${result.transactionId ?? "n/a"} state=${result.state ?? "n/a"} hash=${result.transactionHash ?? "n/a"}`,
    );
  } else {
    const overrides = await buildTxOverrides(
      params.wallet,
      params.config.gasBumpBps,
      params.logger,
    );
    for (const approval of approvalsToSend) {
      params.logger.info(`[Preflight][Approvals] Sending ${approval.label}`);

      // Retry approval tx with exponential backoff
      await retryTxWithBackoff(
        async () => {
          if (approval.type === "erc20") {
            const tx = await new Contract(
              contracts.usdcAddress,
              ERC20_ABI,
              params.wallet,
            ).approve(approval.spender, approvalAmount, overrides);
            params.logger.info(
              `[Preflight][Approvals] Tx submitted ${tx.hash}`,
            );
            await tx.wait(params.config.confirmations);
          } else {
            const tx = await new Contract(
              contracts.ctfErc1155Address!,
              ERC1155_ABI,
              params.wallet,
            ).setApprovalForAll(approval.spender, true, overrides);
            params.logger.info(
              `[Preflight][Approvals] Tx submitted ${tx.hash}`,
            );
            await tx.wait(params.config.confirmations);
          }
        },
        {
          logger: params.logger,
          description: approval.label,
        },
      );
    }
  }

  const refreshed = await fetchApprovalSnapshot({
    wallet: params.wallet,
    owner: params.owner,
    logger: params.logger,
  });

  const approvalsOk =
    refreshed.allowances.every(({ allowance }) =>
      allowance.gte(minAllowance),
    ) && refreshed.erc1155Approvals.every(({ approved }) => approved);

  if (!approvalsOk) {
    params.logger.error(
      "[Preflight][Approvals] Approvals still insufficient after tx confirmation.",
    );
    return { ok: false, snapshot: refreshed };
  }

  params.logger.info("[Preflight][Approvals] Approvals satisfied.");
  return { ok: true, snapshot: refreshed };
};

const buildTxOverrides = async (
  wallet: Wallet,
  gasBumpBps: number,
  logger: Logger,
): Promise<{ maxPriorityFeePerGas?: BigNumber; maxFeePerGas?: BigNumber }> => {
  if (!wallet.provider) return {};

  // Use EIP-1559 gas estimation with proper floors for Polygon
  const multiplier = gasBumpBps > 0 ? 1 + gasBumpBps / 10000 : undefined;
  const gasEstimate = await estimateGasFees({
    provider: wallet.provider,
    logger,
    multiplier,
  });

  return {
    maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
    maxFeePerGas: gasEstimate.maxFeePerGas,
  };
};
