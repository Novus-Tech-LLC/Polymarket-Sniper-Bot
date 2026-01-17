import { POLYGON_USDC_ADDRESS } from '../constants/polymarket.constants';

export type PolymarketContracts = {
  usdcAddress: string;
  ctfExchangeAddress?: string;
  ctfErc1155Address?: string;
  negRiskExchangeAddress?: string;
};

const readEnv = (key: string): string | undefined => process.env[key] ?? process.env[key.toLowerCase()];

export const resolvePolymarketContracts = (): PolymarketContracts => {
  const usdcAddress = readEnv('COLLATERAL_TOKEN_ADDRESS')
    || readEnv('USDC_CONTRACT_ADDRESS')
    || POLYGON_USDC_ADDRESS;
  return {
    usdcAddress,
    ctfExchangeAddress: readEnv('POLY_CTF_EXCHANGE_ADDRESS'),
    ctfErc1155Address: readEnv('POLY_CTF_ERC1155_ADDRESS'),
    negRiskExchangeAddress: readEnv('POLY_NEG_RISK_EXCHANGE_ADDRESS'),
  };
};
