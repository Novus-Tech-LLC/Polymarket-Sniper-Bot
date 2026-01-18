import type { JsonRpcSigner as ClobJsonRpcSigner } from "@ethersproject/providers";
import type { Wallet as ClobWallet } from "@ethersproject/wallet";
import type { JsonRpcSigner as AppJsonRpcSigner, Wallet as AppWallet } from "ethers";

export type ClobSigner = ClobWallet | ClobJsonRpcSigner;
export type AppSigner = AppWallet | AppJsonRpcSigner;

export const asClobSigner = (
  signer: AppSigner | undefined,
): ClobSigner | undefined => signer as unknown as ClobSigner;
