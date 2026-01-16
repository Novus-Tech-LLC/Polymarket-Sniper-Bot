import { Wallet, providers } from 'ethers';
import { ClobClient, Chain, createL2Headers } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { POLYMARKET_API } from '../constants/polymarket.constants';
import { initializeApiCreds } from './clob-auth';
import type { Logger } from '../utils/logger.util';
import { formatAuthHeaderPresence, getAuthHeaderPresence } from '../utils/clob-auth-headers.util';
import { sanitizeErrorMessage } from '../utils/sanitize-axios-error.util';
import {
  buildAuthMessageComponents,
  formatApiKeyId,
  getApiKeyDiagnostics,
  logAuthSigningDiagnostics,
  logClobDiagnostics,
  setupClobHeaderKeyLogging,
} from '../clob/diagnostics';
import {
  evaluatePublicKeyMismatch,
  parseSignatureType,
  resolveDerivedSignerAddress,
  resolveEffectivePolyAddress,
} from '../clob/addressing';
import { buildSignedPath } from '../utils/query-string.util';

export type CreateClientInput = {
  rpcUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  deriveApiKey?: boolean;
  publicKey?: string;
  signatureType?: number;
  funderAddress?: string;
  polyAddressOverride?: string;
  forceMismatch?: boolean;
  logger?: Logger;
};

const SERVER_TIME_SKEW_THRESHOLD_SECONDS = 30;
let polyAddressDiagLogged = false;

const readEnvValue = (key: string): string | undefined => process.env[key] ?? process.env[key.toLowerCase()];

const buildEffectiveSigner = (wallet: Wallet, effectivePolyAddress: string): Wallet => {
  if (!effectivePolyAddress) return wallet;
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === 'getAddress') {
        return async () => effectivePolyAddress;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  });
};

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
    const signer = (client as ClobClient & { signer?: Wallet | providers.JsonRpcSigner }).signer;
    if (!signer) return;
    const orderBuilder = (client as ClobClient & { orderBuilder?: { signatureType?: number } }).orderBuilder;
    const signatureType = orderBuilder?.signatureType;
    const params = signatureType !== undefined ? { signature_type: signatureType } : undefined;
    const { signedPath, paramsKeys } = buildSignedPath('/balance-allowance', params);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = await createL2Headers(signer, creds, {
      method: 'GET',
      requestPath: signedPath,
    }, timestamp);
    const presence = getAuthHeaderPresence(headers, { secretConfigured: Boolean(creds?.secret) });
    logger.info(`[CLOB] Auth header presence: ${formatAuthHeaderPresence(presence)}`);
    logger.info(
      `[CLOB][Diag][Sign] pathSigned=${signedPath} paramsKeys=${paramsKeys.length ? paramsKeys.join(',') : 'none'}`,
    );
    logAuthSigningDiagnostics({
      logger,
      secret: creds.secret,
      messageComponents: buildAuthMessageComponents(timestamp, 'GET', signedPath),
    });
  } catch (err) {
    logger.warn(`[CLOB] Failed to inspect auth headers. ${sanitizeErrorMessage(err)}`);
  }
};

const deriveApiCreds = async (wallet: Wallet, logger?: Logger): Promise<ApiKeyCreds | undefined> => {
  const deriveClient = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    wallet,
    undefined,
    SignatureType.EOA,
  );
  const deriveFn = deriveClient as ClobClient & {
    create_or_derive_api_creds?: () => Promise<ApiKeyCreds>;
    createOrDeriveApiKey?: () => Promise<ApiKeyCreds>;
  };

  if (deriveFn.create_or_derive_api_creds) {
    return deriveFn.create_or_derive_api_creds();
  }
  return deriveFn.createOrDeriveApiKey?.();
};

export async function createPolymarketClient(
  input: CreateClientInput,
): Promise<ClobClient & {
  wallet: Wallet;
  derivedSignerAddress: string;
  effectivePolyAddress: string;
  publicKeyMismatch: boolean;
  executionDisabled: boolean;
  providedCreds?: ApiKeyCreds;
  derivedCreds?: ApiKeyCreds;
}> {
  const provider = new providers.JsonRpcProvider(input.rpcUrl);
  const wallet = new Wallet(input.privateKey, provider);
  setupClobHeaderKeyLogging(input.logger);

  const derivedSignerAddress = resolveDerivedSignerAddress(input.privateKey);
  const signatureType = parseSignatureType(
    input.signatureType ?? readEnvValue('CLOB_SIGNATURE_TYPE'),
  );
  const funderAddress = input.funderAddress ?? readEnvValue('CLOB_FUNDER_ADDRESS');
  const polyAddressOverride = input.polyAddressOverride ?? readEnvValue('CLOB_POLY_ADDRESS_OVERRIDE');
  const effectiveAddressResult = resolveEffectivePolyAddress({
    derivedSignerAddress,
    signatureType,
    funderAddress,
    polyAddressOverride,
    logger: input.logger,
  });
  const configuredPublicKey = input.publicKey ?? readEnvValue('PUBLIC_KEY');
  const forceMismatch = input.forceMismatch ?? readEnvValue('FORCE_MISMATCH') === 'true';
  const mismatchResult = evaluatePublicKeyMismatch({
    configuredPublicKey,
    derivedSignerAddress,
    forceMismatch,
    logger: input.logger,
  });

  if (input.logger && !polyAddressDiagLogged) {
    input.logger.info(
      `[CLOB][Diag] derivedSignerAddress=${derivedSignerAddress} funderAddress=${funderAddress ?? 'none'} signatureType=${signatureType ?? 'n/a'} effectivePolyAddress=${effectiveAddressResult.effectivePolyAddress}`,
    );
    polyAddressDiagLogged = true;
  }

  const signer = buildEffectiveSigner(wallet, effectiveAddressResult.effectivePolyAddress);

  let creds: ApiKeyCreds | undefined;
  if (input.apiKey && input.apiSecret && input.apiPassphrase) {
    creds = {
      key: input.apiKey,
      secret: input.apiSecret,
      passphrase: input.apiPassphrase,
    };
  }
  const providedCreds = creds;
  const deriveEnabled = Boolean(input.deriveApiKey);
  if (deriveEnabled && creds) {
    input.logger?.info('[CLOB] Derived creds enabled; ignoring provided API keys.');
    creds = undefined;
  }

  const client = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    signer,
    creds,
    signatureType,
    funderAddress,
  );
  await maybeEnableServerTime(client, input.logger);

  let derivedCreds: ApiKeyCreds | undefined;
  if (deriveEnabled) {
    try {
      const derived = await deriveApiCreds(wallet, input.logger);
      if (derived?.key && derived?.secret && derived?.passphrase) {
        creds = derived;
        derivedCreds = derived;
        const { apiKeyDigest, keyIdSuffix } = getApiKeyDiagnostics(derived.key);
        input.logger?.info(`[CLOB] derived creds apiKeyDigest=${apiKeyDigest} keyIdSuffix=${keyIdSuffix}`);
      }
    } catch (err) {
      input.logger?.warn(`[CLOB] Failed to derive API creds: ${sanitizeErrorMessage(err)}`);
    }
  }

  const resolvedSignatureType = (client as ClobClient & { orderBuilder?: { signatureType?: number } }).orderBuilder
    ?.signatureType;
  const resolvedFunderAddress = (client as ClobClient & { orderBuilder?: { funderAddress?: string } }).orderBuilder
    ?.funderAddress;
  const makerAddress = effectiveAddressResult.effectivePolyAddress ?? derivedSignerAddress ?? 'n/a';
  logClobDiagnostics({
    logger: input.logger,
    derivedSignerAddress,
    configuredPublicKey,
    chainId: Chain.POLYGON,
    clobHost: POLYMARKET_API.BASE_URL,
    signatureType: resolvedSignatureType ?? signatureType,
    funderAddress: resolvedFunderAddress ?? funderAddress,
    makerAddress,
    ownerId: formatApiKeyId(creds?.key),
    apiKeyPresent: Boolean(creds?.key),
    secretPresent: Boolean(creds?.secret),
    passphrasePresent: Boolean(creds?.passphrase),
  });

  if (creds) {
    await initializeApiCreds(client, creds);
    await logAuthHeaderPresence(client, creds, input.logger);
  }

  return Object.assign(client, {
    wallet,
    derivedSignerAddress,
    effectivePolyAddress: effectiveAddressResult.effectivePolyAddress,
    publicKeyMismatch: mismatchResult.mismatch,
    executionDisabled: mismatchResult.executionDisabled,
    providedCreds,
    derivedCreds,
  });
}
