import { Wallet, providers } from 'ethers';
import { ClobClient, Chain } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { POLYMARKET_API } from '../constants/polymarket.constants';
import { initializeApiCreds } from './clob-auth';
import type { Logger } from '../utils/logger.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';

export type CreateClientInput = {
  rpcUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  deriveApiKey?: boolean;
  logger?: Logger;
};

export async function createPolymarketClient(
  input: CreateClientInput,
): Promise<ClobClient & { wallet: Wallet }> {
  const provider = new providers.JsonRpcProvider(input.rpcUrl);
  const wallet = new Wallet(input.privateKey, provider);

  let creds: ApiKeyCreds | undefined;
  if (input.apiKey && input.apiSecret && input.apiPassphrase) {
    creds = {
      key: input.apiKey,
      secret: input.apiSecret,
      passphrase: input.apiPassphrase,
    };
  }

  const client = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    wallet,
    creds,
  );

  if (!creds && input.deriveApiKey) {
    try {
      const derived = await client.createOrDeriveApiKey();
      if (derived?.key && derived?.secret && derived?.passphrase) {
        creds = derived;
        input.logger?.info('[CLOB] derived creds');
      }
    } catch (err) {
      input.logger?.warn(`[CLOB] Failed to derive API creds: ${sanitizeErrorMessage(err)}`);
    }
  }

  if (creds) {
    await initializeApiCreds(client, creds);
  }

  return Object.assign(client, { wallet });
}
