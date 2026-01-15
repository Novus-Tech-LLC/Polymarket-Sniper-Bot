import { Contract, providers, utils } from 'ethers';
import type { Wallet } from 'ethers';

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export async function getUsdBalanceApprox(
  wallet: Wallet,
  collateralTokenAddress: string,
  collateralTokenDecimals = 6,
): Promise<number> {
  const provider = wallet.provider;
  if (!provider) {
    throw new Error('Wallet provider is required');
  }
  const usdcContract = new Contract(collateralTokenAddress, USDC_ABI, provider);
  const balance = await usdcContract.balanceOf(wallet.address);
  return parseFloat(utils.formatUnits(balance, collateralTokenDecimals));
}

export async function getPolBalance(wallet: Wallet): Promise<number> {
  const provider = wallet.provider;
  if (!provider) {
    throw new Error('Wallet provider is required');
  }
  const balance = await provider.getBalance(wallet.address);
  return parseFloat(utils.formatEther(balance));
}
