import { SignatureType } from "@polymarket/order-utils";
import type { Logger } from "../utils/logger.util";
import { deriveSignerAddress, publicKeyMatchesDerived } from "./diagnostics";

const FUNDER_SIGNATURE_TYPES = new Set<number>([
  SignatureType.POLY_PROXY,
  SignatureType.POLY_GNOSIS_SAFE,
]);

export type EffectivePolyAddressResult = {
  derivedSignerAddress: string;
  effectivePolyAddress: string;
  signatureType?: number;
  funderAddress?: string;
  usedOverride: boolean;
};

export type PublicKeyMismatchResult = {
  mismatch: boolean;
  executionDisabled: boolean;
};

export const parseSignatureType = (
  value?: string | number,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (![0, 1, 2].includes(parsed)) return undefined;
  return parsed;
};

export const resolveDerivedSignerAddress = (privateKey: string): string =>
  deriveSignerAddress(privateKey);

export const resolveEffectivePolyAddress = (params: {
  derivedSignerAddress: string;
  signatureType?: number;
  funderAddress?: string;
  polyAddressOverride?: string;
  logger?: Logger;
}): EffectivePolyAddressResult => {
  let effectivePolyAddress = params.derivedSignerAddress;
  if (
    params.signatureType !== undefined &&
    FUNDER_SIGNATURE_TYPES.has(params.signatureType) &&
    params.funderAddress
  ) {
    effectivePolyAddress = params.funderAddress;
  }

  let usedOverride = false;
  if (params.polyAddressOverride) {
    usedOverride = true;
    effectivePolyAddress = params.polyAddressOverride;
    params.logger?.warn(
      `[CLOB][Diag] CLOB_POLY_ADDRESS_OVERRIDE set; forcing POLY_ADDRESS=${params.polyAddressOverride}.`,
    );
  }

  return {
    derivedSignerAddress: params.derivedSignerAddress,
    effectivePolyAddress,
    signatureType: params.signatureType,
    funderAddress: params.funderAddress,
    usedOverride,
  };
};

export const evaluatePublicKeyMismatch = (params: {
  configuredPublicKey?: string;
  derivedSignerAddress?: string;
  forceMismatch: boolean;
  logger?: Logger;
}): PublicKeyMismatchResult => {
  const mismatch = Boolean(
    params.configuredPublicKey &&
    params.derivedSignerAddress &&
    !publicKeyMatchesDerived(
      params.configuredPublicKey,
      params.derivedSignerAddress,
    ),
  );
  if (!mismatch) {
    return { mismatch: false, executionDisabled: false };
  }

  params.logger?.error(
    `[CLOB][Diag] PUBLIC_KEY=${params.configuredPublicKey} does not match derivedSignerAddress=${params.derivedSignerAddress}.`,
  );

  if (params.forceMismatch) {
    params.logger?.warn(
      "[CLOB][Diag] FORCE_MISMATCH=true; continuing despite PUBLIC_KEY mismatch.",
    );
    return { mismatch: true, executionDisabled: false };
  }

  params.logger?.error(
    "[CLOB][Diag] Execution disabled until PUBLIC_KEY matches derived signer or FORCE_MISMATCH=true.",
  );
  return { mismatch: true, executionDisabled: true };
};
