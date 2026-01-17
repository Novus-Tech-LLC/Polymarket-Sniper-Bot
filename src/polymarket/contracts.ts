import {
  POLYGON_USDC_ADDRESS,
  POLYMARKET_CTF_ADDRESS,
  POLYMARKET_CTF_EXCHANGE_ADDRESS,
  POLYMARKET_NEG_RISK_ADAPTER_ADDRESS,
  POLYMARKET_NEG_RISK_CTF_EXCHANGE_ADDRESS,
} from "../constants/polymarket.constants";

export type PolymarketContracts = {
  usdcAddress: string;
  ctfAddress?: string;
  ctfExchangeAddress?: string;
  ctfErc1155Address?: string;
  negRiskExchangeAddress?: string;
  negRiskAdapterAddress?: string;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

export const resolvePolymarketContracts = (): PolymarketContracts => {
  const usdcAddress =
    readEnv("COLLATERAL_TOKEN_ADDRESS") ||
    readEnv("USDC_CONTRACT_ADDRESS") ||
    readEnv("POLY_USDCE_ADDRESS") ||
    POLYGON_USDC_ADDRESS;
  const ctfAddress = readEnv("POLY_CTF_ADDRESS") || POLYMARKET_CTF_ADDRESS;
  const ctfExchangeAddress =
    readEnv("POLY_CTF_EXCHANGE_ADDRESS") || POLYMARKET_CTF_EXCHANGE_ADDRESS;
  const negRiskExchangeAddress =
    readEnv("POLY_NEG_RISK_CTF_EXCHANGE_ADDRESS") ||
    POLYMARKET_NEG_RISK_CTF_EXCHANGE_ADDRESS;
  const negRiskAdapterAddress =
    readEnv("POLY_NEG_RISK_ADAPTER_ADDRESS") ||
    POLYMARKET_NEG_RISK_ADAPTER_ADDRESS;
  return {
    usdcAddress,
    ctfAddress,
    ctfExchangeAddress,
    ctfErc1155Address: readEnv("POLY_CTF_ERC1155_ADDRESS") || ctfAddress,
    negRiskExchangeAddress,
    negRiskAdapterAddress,
  };
};
