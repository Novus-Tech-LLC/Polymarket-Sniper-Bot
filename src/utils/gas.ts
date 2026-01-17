import { BigNumber, utils } from "ethers";
import type { providers } from "ethers";
import type { Logger } from "./logger.util";

export type GasEstimateParams = {
  provider: providers.Provider;
  logger?: Logger;
  multiplier?: number;
  maxPriorityFeeGwei?: number;
  maxFeeGwei?: number;
};

export type GasEstimate = {
  maxPriorityFeePerGas: BigNumber;
  maxFeePerGas: BigNumber;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseGwei = (gwei: number): BigNumber =>
  utils.parseUnits(String(gwei), "gwei");

/**
 * Estimates EIP-1559 gas fees for Polygon with safe defaults
 * Applies floors + multipliers to ensure RPC acceptance
 */
export const estimateGasFees = async (
  params: GasEstimateParams,
): Promise<GasEstimate> => {
  const multiplier =
    params.multiplier ?? parseFloat(readEnv("POLY_GAS_MULTIPLIER") || "1.2");
  const minPriorityFeeGwei =
    params.maxPriorityFeeGwei ??
    parseFloat(readEnv("POLY_MAX_PRIORITY_FEE_GWEI") || "30");
  const minMaxFeeGwei =
    params.maxFeeGwei ?? parseFloat(readEnv("POLY_MAX_FEE_GWEI") || "60");

  try {
    const feeData = await params.provider.getFeeData();
    params.logger?.info(
      `[Gas] RPC feeData maxPriorityFeePerGas=${feeData.maxPriorityFeePerGas ? utils.formatUnits(feeData.maxPriorityFeePerGas, "gwei") : "null"} gwei maxFeePerGas=${feeData.maxFeePerGas ? utils.formatUnits(feeData.maxFeePerGas, "gwei") : "null"} gwei lastBaseFeePerGas=${feeData.lastBaseFeePerGas ? utils.formatUnits(feeData.lastBaseFeePerGas, "gwei") : "null"} gwei`,
    );

    // Calculate maxPriorityFeePerGas with floor
    let maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas || parseGwei(minPriorityFeeGwei);
    const minPriorityFee = parseGwei(minPriorityFeeGwei);
    if (maxPriorityFeePerGas.lt(minPriorityFee)) {
      maxPriorityFeePerGas = minPriorityFee;
    }

    // Apply multiplier
    maxPriorityFeePerGas = maxPriorityFeePerGas
      .mul(Math.floor(multiplier * 100))
      .div(100);

    // Calculate maxFeePerGas
    const baseFee = feeData.lastBaseFeePerGas || parseGwei(30);
    let maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);

    // Apply floor from RPC feeData
    if (feeData.maxFeePerGas && maxFeePerGas.lt(feeData.maxFeePerGas)) {
      maxFeePerGas = feeData.maxFeePerGas;
    }

    // Apply configured floor
    const minMaxFee = parseGwei(minMaxFeeGwei);
    if (maxFeePerGas.lt(minMaxFee)) {
      maxFeePerGas = minMaxFee;
    }

    // Apply multiplier
    maxFeePerGas = maxFeePerGas.mul(Math.floor(multiplier * 100)).div(100);

    params.logger?.info(
      `[Gas] Selected maxPriorityFeePerGas=${utils.formatUnits(maxPriorityFeePerGas, "gwei")} gwei maxFeePerGas=${utils.formatUnits(maxFeePerGas, "gwei")} gwei multiplier=${multiplier}`,
    );

    return {
      maxPriorityFeePerGas,
      maxFeePerGas,
    };
  } catch (error) {
    // Fallback to safe defaults if getFeeData fails
    params.logger?.warn(
      `[Gas] Failed to fetch fee data, using defaults: ${error}`,
    );
    const maxPriorityFeePerGas = parseGwei(minPriorityFeeGwei)
      .mul(Math.floor(multiplier * 100))
      .div(100);
    const maxFeePerGas = parseGwei(minMaxFeeGwei)
      .mul(Math.floor(multiplier * 100))
      .div(100);

    params.logger?.info(
      `[Gas] Fallback maxPriorityFeePerGas=${utils.formatUnits(maxPriorityFeePerGas, "gwei")} gwei maxFeePerGas=${utils.formatUnits(maxFeePerGas, "gwei")} gwei`,
    );

    return {
      maxPriorityFeePerGas,
      maxFeePerGas,
    };
  }
};

/**
 * Retry a transaction with exponential backoff
 */
export const retryTxWithBackoff = async <T>(
  operation: () => Promise<T>,
  params: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    logger?: Logger;
    description: string;
  },
): Promise<T> => {
  const maxAttempts =
    params.maxAttempts ??
    parseInt(readEnv("APPROVALS_MAX_RETRY_ATTEMPTS") || "3", 10);
  const initialDelayMs = params.initialDelayMs ?? 2000;
  const maxDelayMs = params.maxDelayMs ?? 30000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }

      const delayMs = Math.min(
        initialDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs,
      );
      params.logger?.warn(
        `[Gas][Retry] ${params.description} failed attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms: ${error}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
};
