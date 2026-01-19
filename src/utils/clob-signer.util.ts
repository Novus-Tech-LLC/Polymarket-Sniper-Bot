import type { JsonRpcSigner as ClobJsonRpcSigner } from "@ethersproject/providers";
import type { Wallet as ClobWallet } from "@ethersproject/wallet";
import type {
  JsonRpcSigner as AppJsonRpcSigner,
  Wallet as AppWallet,
} from "ethers";

export type ClobSigner = ClobWallet | ClobJsonRpcSigner;
export type AppSigner = AppWallet | AppJsonRpcSigner;

type TypedDataSigner = AppSigner & {
  signTypedData?: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ) => Promise<string>;
  _signTypedData?: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ) => Promise<string>;
};

const ensureTypedDataCompatibility = (
  signer?: AppSigner,
): AppSigner | undefined => {
  if (!signer) {
    return signer;
  }

  const typedSigner = signer as TypedDataSigner;
  if (
    typeof typedSigner._signTypedData !== "function" &&
    typeof typedSigner.signTypedData === "function"
  ) {
    typedSigner._signTypedData = async (domain, types, value) =>
      typedSigner.signTypedData!(domain, types, value);
  }

  return signer;
};

export const asClobSigner = (
  signer: AppSigner | undefined,
): ClobSigner | undefined =>
  ensureTypedDataCompatibility(signer) as unknown as ClobSigner;
