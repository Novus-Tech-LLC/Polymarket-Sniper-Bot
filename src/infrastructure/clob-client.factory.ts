import { Wallet, providers } from 'ethers';
import { ClobClient, Chain, createL2Headers } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { POLYMARKET_API } from '../constants/polymarket.constants';
import { initializeApiCreds } from './clob-auth';
import type { Logger } from '../utils/logger.util';
import { formatAuthHeaderPresence, getAuthHeaderPresence } from '../utils/clob-auth-headers.util';
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

const SERVER_TIME_SKEW_THRESHOLD_SECONDS = 30;

const parseTimestampSeconds = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return undefined;
  if (raw > 1_000_000_000_000) return Math.floor(raw / 1000);
  return Math.floor(raw);
};

const extractServerTimeSeconds = (payload: unknown): number | undefined => {
  const direct = parseTimestampSeconds(payload);
  if (direct !== undefined) return direct;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = ['serverTime', 'server_time', 'timestamp', 'time', 'epoch', 'seconds'];
  for (const key of candidates) {
    const parsed = parseTimestampSeconds(record[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const maybeEnableServerTime = async (client: ClobClient, logger?: Logger): Promise<void> => {
  try {
    const serverTimePayload = await client.getServerTime();
    const serverSeconds = extractServerTimeSeconds(serverTimePayload);
    if (serverSeconds === undefined) {
      logger?.warn('[CLOB] Unable to parse server time; using local clock.');
      return;
    }
    const localSeconds = Math.floor(Date.now() / 1000);
    const skewSeconds = Math.abs(serverSeconds - localSeconds);
    if (skewSeconds >= SERVER_TIME_SKEW_THRESHOLD_SECONDS) {
      (client as ClobClient & { useServerTime?: boolean }).useServerTime = true;
      logger?.warn(`[CLOB] Clock skew ${skewSeconds}s detected; enabling server time for signatures.`);
      return;
    }
    logger?.info(`[CLOB] Clock skew ${skewSeconds}s; using local clock.`);
  } catch (err) {
    logger?.warn(`[CLOB] Failed to fetch server time; using local clock. ${sanitizeErrorMessage(err)}`);
  }
};

const logAuthHeaderPresence = async (
  client: ClobClient,
  creds: ApiKeyCreds,
  logger?: Logger,
): Promise<void> => {
  if (!logger) return;
  try {
    const signer = (client as ClobClient & { signer?: unknown }).signer as { getAddress: () => Promise<string> } | undefined;
    if (!signer) return;
    const headers = await createL2Headers(signer, creds, {
      method: 'GET',
      requestPath: '/auth/api-keys',
    });
    const presence = getAuthHeaderPresence(headers);
    logger.info(`[CLOB] Auth header presence: ${formatAuthHeaderPresence(presence)}`);
  } catch (err) {
    logger.warn(`[CLOB] Failed to inspect auth headers. ${sanitizeErrorMessage(err)}`);
  }
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

  await maybeEnableServerTime(client, input.logger);

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
    await logAuthHeaderPresence(client, creds, input.logger);
  }

  return Object.assign(client, { wallet });
}
