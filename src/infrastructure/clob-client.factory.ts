import { Wallet, providers } from 'ethers';
import { ClobClient, Chain } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { POLYMARKET_API } from '../constants/polymarket.constants';
import { initializeApiCreds } from './clob-auth';

export type CreateClientInput = {
  rpcUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
};

export async function createPolymarketClient(
  input: CreateClientInput,
): Promise<ClobClient & { wallet: Wallet }> {
  const provider = new providers.JsonRpcProvider(input.rpcUrl);
  const wallet = new Wallet(input.privateKey, provider);

  if (!input.apiKey || !input.apiSecret || !input.apiPassphrase) {
    throw new Error('Missing Polymarket API credentials. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_API_PASSPHRASE.');
  }

  const creds: ApiKeyCreds = {
    key: input.apiKey,
    secret: input.apiSecret,
    passphrase: input.apiPassphrase,
  };

  const client = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    wallet,
    creds,
  );

  await initializeApiCreds(client, creds);

  return Object.assign(client, { wallet });
}
