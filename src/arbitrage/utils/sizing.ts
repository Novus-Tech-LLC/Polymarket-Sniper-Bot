import type { SizeScalingMode } from "../config";

export function scalingMultiplier(
  edgeBps: number,
  mode: SizeScalingMode,
): number {
  const edge = Math.max(0, edgeBps) / 10000;
  switch (mode) {
    case "linear":
      return 1 + edge;
    case "log":
      return 1 + Math.log1p(edge * 10) / 10;
    case "sqrt":
    default:
      return Math.sqrt(1 + edge);
  }
}

export function computeSizeUsd(params: {
  baseUsd: number;
  edgeBps: number;
  mode: SizeScalingMode;
  maxPositionUsd: number;
  maxWalletExposureUsd: number;
  currentMarketExposureUsd: number;
  currentWalletExposureUsd: number;
}): { sizeUsd: number; sizeTier: number } {
  const multiplier = scalingMultiplier(params.edgeBps, params.mode);
  const target = params.baseUsd * multiplier;
  const remainingMarket = Math.max(
    0,
    params.maxPositionUsd - params.currentMarketExposureUsd,
  );
  const remainingWallet = Math.max(
    0,
    params.maxWalletExposureUsd - params.currentWalletExposureUsd,
  );
  const sizeUsd = Math.max(
    0,
    Math.min(target, remainingMarket, remainingWallet),
  );
  const sizeTier = Math.max(1, Math.floor(sizeUsd / params.baseUsd));
  return { sizeUsd, sizeTier };
}
