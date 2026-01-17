import 'dotenv/config';
import { ConsoleLogger } from '../utils/logger.util';
import { createPolymarketClient } from '../infrastructure/clob-client.factory';
import { ensureTradingReady } from '../polymarket/preflight';
import { isApiKeyCreds } from '../utils/clob-credentials.util';

const readEnv = (key: string): string | undefined => process.env[key] ?? process.env[key.toLowerCase()];

const required = (key: string): string => {
  const value = readEnv(key);
  if (!value) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
};

const readFirstEnv = (keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = readEnv(key);
    if (value) return value;
  }
  return undefined;
};

const getClobCreds = () => ({
  key: readFirstEnv(['POLYMARKET_API_KEY', 'POLY_API_KEY', 'CLOB_API_KEY']),
  secret: readFirstEnv(['POLYMARKET_API_SECRET', 'POLY_SECRET', 'CLOB_API_SECRET']),
  passphrase: readFirstEnv(['POLYMARKET_API_PASSPHRASE', 'POLY_PASSPHRASE', 'CLOB_API_PASSPHRASE']),
});

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const rpcUrl = required('RPC_URL');
  const privateKey = required('PRIVATE_KEY');
  const publicKey = readEnv('PUBLIC_KEY');
  const clobDeriveEnabled = readEnv('CLOB_DERIVE_CREDS') === 'true' || readEnv('CLOB_DERIVE_API_KEY') === 'true';
  const clobCreds = getClobCreds();
  const collateralTokenDecimals = Number(readEnv('COLLATERAL_TOKEN_DECIMALS') ?? 6);

  const client = await createPolymarketClient({
    rpcUrl,
    privateKey,
    apiKey: clobCreds.key,
    apiSecret: clobCreds.secret,
    apiPassphrase: clobCreds.passphrase,
    deriveApiKey: clobDeriveEnabled,
    publicKey,
    logger,
  });

  const clientCredsRaw = (client as { creds?: { key?: string; secret?: string; passphrase?: string } }).creds;
  const clientCreds = isApiKeyCreds(clientCredsRaw) ? clientCredsRaw : undefined;
  const credsComplete = Boolean(clientCreds);

  const result = await ensureTradingReady({
    client,
    logger,
    privateKey,
    configuredPublicKey: publicKey,
    rpcUrl,
    detectOnly: !credsComplete,
    clobCredsComplete: credsComplete,
    clobDeriveEnabled,
    collateralTokenDecimals,
  });

  const ready = !result.detectOnly;
  logger.info(`[Preflight] SUMMARY ready=${ready}`);
  if (!ready) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Preflight failed', err);
  process.exit(1);
});
