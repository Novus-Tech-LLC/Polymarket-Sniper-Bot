import crypto from 'node:crypto';
import axios from 'axios';
import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from 'ethers';
import { POLYMARKET_API } from '../constants/polymarket.constants';
import type { Logger } from '../utils/logger.util';

export type SecretDecodingMode = 'raw' | 'base64' | 'base64url';
export type SignatureEncodingMode = 'base64' | 'base64url';

export type AuthMessageComponents = {
  timestamp: number;
  method: string;
  path: string;
  bodyIncluded: boolean;
  bodyLength: number;
};

export type AuthFailureReason =
  | 'MISMATCHED_ADDRESS'
  | 'WRONG_SIGNATURE_TYPE'
  | 'SECRET_ENCODING'
  | 'MESSAGE_CANONICALIZATION'
  | 'SERVER_REJECTED_CREDS';

const SIGNATURE_ENCODING_USED: SignatureEncodingMode = 'base64url';
const SECRET_DECODING_USED: SecretDecodingMode = 'base64';
const PREFLIGHT_BACKOFF_BASE_MS = 1000;
const PREFLIGHT_BACKOFF_MAX_MS = 5 * 60 * 1000;

let headerKeysLogged = false;
let preflightBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
let lastPreflightAttemptMs = 0;

const normalizeAddress = (value?: string): string | undefined => value?.toLowerCase();

export const deriveSignerAddress = (privateKey: string): string => new Wallet(privateKey).address;

export const publicKeyMatchesDerived = (configuredPublicKey?: string, derivedSignerAddress?: string): boolean => {
  if (!configuredPublicKey || !derivedSignerAddress) return false;
  return normalizeAddress(configuredPublicKey) === normalizeAddress(derivedSignerAddress);
};

const secretLooksBase64Url = (secret: string): boolean => {
  const base64UrlAlphabet = /^[A-Za-z0-9_-]+$/;
  const withoutPadding = secret.replace(/=/g, '');
  return (
    (secret.includes('-') || secret.includes('_') || !secret.includes('='))
    && base64UrlAlphabet.test(withoutPadding)
  );
};

export const detectSecretDecodingMode = (secret?: string): SecretDecodingMode => {
  if (!secret) return 'raw';
  if (secretLooksBase64Url(secret)) {
    return 'base64url';
  }
  if (secret.includes('+') || secret.includes('/') || secret.endsWith('=')) {
    return 'base64';
  }
  const base64Alphabet = /^[A-Za-z0-9]+$/;
  if (base64Alphabet.test(secret) && secret.length % 4 === 0) {
    return 'base64';
  }
  return 'raw';
};

export const decodeSecretBytes = (secret: string, mode: SecretDecodingMode): Buffer => {
  if (mode === 'base64url') {
    let normalized = secret.replace(/-/g, '+').replace(/_/g, '/');
    const paddingNeeded = normalized.length % 4;
    if (paddingNeeded) {
      normalized = normalized.padEnd(normalized.length + (4 - paddingNeeded), '=');
    }
    return Buffer.from(normalized, 'base64');
  }
  if (mode === 'base64') {
    return Buffer.from(secret, 'base64');
  }
  return Buffer.from(secret, 'utf8');
};

export const buildAuthMessageString = (params: {
  timestamp: number;
  method: string;
  path: string;
  body?: string;
}): string => {
  let message = `${params.timestamp}${params.method}${params.path}`;
  if (params.body !== undefined) {
    message += params.body;
  }
  return message;
};

export const computeSha256Hex = (value: string | Buffer): string => {
  return crypto.createHash('sha256').update(value).digest('hex');
};

export const formatApiKeyId = (apiKey?: string): string => {
  if (!apiKey) return 'n/a';
  if (apiKey.length >= 6) {
    return `...${apiKey.slice(-6)}`;
  }
  const digest = computeSha256Hex(apiKey).slice(0, 8);
  return `sha256:${digest}`;
};

export const getApiKeyDiagnostics = (apiKey?: string): { apiKeyDigest: string; keyIdSuffix: string } => {
  if (!apiKey) {
    return { apiKeyDigest: 'n/a', keyIdSuffix: 'n/a' };
  }
  const apiKeyDigest = computeSha256Hex(apiKey).slice(0, 8);
  const keyIdSuffix = apiKey.slice(-6);
  return { apiKeyDigest, keyIdSuffix };
};

const signatureTypeLabel = (signatureType?: number): string => {
  switch (signatureType) {
    case SignatureType.EOA:
      return 'EOA';
    case SignatureType.POLY_PROXY:
      return 'Magic';
    case SignatureType.POLY_GNOSIS_SAFE:
      return 'GnosisSafe';
    default:
      return 'Unknown';
  }
};

export const buildAuthMessageComponents = (
  timestamp: number,
  method: string,
  path: string,
  body?: string,
): AuthMessageComponents => ({
  timestamp,
  method,
  path,
  bodyIncluded: body !== undefined,
  bodyLength: body ? Buffer.byteLength(body) : 0,
});

export const logAuthSigningDiagnostics = (params: {
  logger?: Logger;
  secret?: string;
  messageComponents: AuthMessageComponents;
  body?: string;
  signatureEncoding?: SignatureEncodingMode;
  secretDecodingUsed?: SecretDecodingMode;
}): {
  messageDigest: string;
  secretDigest: string;
  secretDecodingUsed: SecretDecodingMode;
  signatureEncoding: SignatureEncodingMode;
} => {
  const signatureEncoding = params.signatureEncoding ?? SIGNATURE_ENCODING_USED;
  const secretLooksBase64UrlFlag = params.secret ? secretLooksBase64Url(params.secret) : false;
  const secretDecodingUsed = params.secretDecodingUsed
    ?? (secretLooksBase64UrlFlag ? 'base64url' : SECRET_DECODING_USED);
  const messageString = buildAuthMessageString({
    timestamp: params.messageComponents.timestamp,
    method: params.messageComponents.method,
    path: params.messageComponents.path,
    body: params.body,
  });
  const messageStringLength = messageString.length;
  const methodUppercase = params.messageComponents.method === params.messageComponents.method.toUpperCase();
  const messageDigest = computeSha256Hex(messageString).slice(0, 12);
  const secretDigest = params.secret
    ? computeSha256Hex(decodeSecretBytes(params.secret, secretDecodingUsed)).slice(0, 12)
    : 'n/a';

  if (params.logger) {
    params.logger.info(
      `[CLOB][Diag][Sign] messageComponents timestamp=${params.messageComponents.timestamp} method=${params.messageComponents.method} methodUppercase=${methodUppercase} path=${params.messageComponents.path} bodyIncluded=${params.messageComponents.bodyIncluded} bodyLength=${params.messageComponents.bodyLength} messageStringLength=${messageStringLength}`,
    );
    params.logger.info(
      `[CLOB][Diag][Sign] messageDigest=${messageDigest} secretDigest=${secretDigest} signatureEncoding=${signatureEncoding} secretDecoding=${secretDecodingUsed} secretLooksBase64Url=${secretLooksBase64UrlFlag}`,
    );
  }

  return { messageDigest, secretDigest, secretDecodingUsed, signatureEncoding };
};

export const logClobDiagnostics = (params: {
  logger?: Logger;
  derivedSignerAddress?: string;
  configuredPublicKey?: string;
  chainId?: number;
  clobHost?: string;
  signatureType?: number;
  funderAddress?: string;
  makerAddress?: string;
  ownerId?: string;
  apiKeyPresent: boolean;
  secretPresent: boolean;
  passphrasePresent: boolean;
}): void => {
  if (!params.logger) return;
  params.logger.info(
    `[CLOB][Diag] derivedSignerAddress=${params.derivedSignerAddress ?? 'n/a'} configuredPublicKey=${params.configuredPublicKey ?? 'none'} publicKeyMatchesDerived=${publicKeyMatchesDerived(params.configuredPublicKey, params.derivedSignerAddress)} chainId=${params.chainId ?? 'n/a'} clobHost=${params.clobHost ?? POLYMARKET_API.BASE_URL} signatureType=${params.signatureType ?? 'n/a'} (${signatureTypeLabel(params.signatureType)}) funderAddress=${params.funderAddress ?? 'none'} makerAddress=${params.makerAddress ?? 'n/a'} ownerId=${params.ownerId ?? 'n/a'} keyPresent=${params.apiKeyPresent} secretPresent=${params.secretPresent} passphrasePresent=${params.passphrasePresent}`,
  );
};

export const classifyAuthFailure = (params: {
  configuredPublicKey?: string;
  derivedSignerAddress?: string;
  signatureType?: number;
  privateKeyPresent: boolean;
  secretFormat: SecretDecodingMode;
  secretDecodingUsed: SecretDecodingMode;
  expectedBodyIncluded: boolean;
  bodyIncluded: boolean;
  expectedQueryPresent: boolean;
  pathIncludesQuery: boolean;
}): AuthFailureReason => {
  if (
    params.configuredPublicKey
    && params.derivedSignerAddress
    && !publicKeyMatchesDerived(params.configuredPublicKey, params.derivedSignerAddress)
  ) {
    return 'MISMATCHED_ADDRESS';
  }
  if (params.signatureType === SignatureType.POLY_PROXY && params.privateKeyPresent) {
    return 'WRONG_SIGNATURE_TYPE';
  }
  if (params.secretFormat === 'base64url' && params.secretDecodingUsed !== 'base64url') {
    return 'SECRET_ENCODING';
  }
  if (
    (params.expectedBodyIncluded && !params.bodyIncluded)
    || (params.expectedQueryPresent && !params.pathIncludesQuery)
  ) {
    return 'MESSAGE_CANONICALIZATION';
  }
  return 'SERVER_REJECTED_CREDS';
};

const extractStatus = (error: unknown): number | undefined => {
  const maybeError = error as { response?: { status?: number }; status?: number };
  return maybeError?.status ?? maybeError?.response?.status;
};

export const setupClobHeaderKeyLogging = (logger?: Logger): void => {
  if (!logger || headerKeysLogged) return;
  axios.interceptors.request.use((config) => {
    if (headerKeysLogged) return config;
    const url = config.url ?? '';
    if (!url.includes(POLYMARKET_API.BASE_URL)) {
      return config;
    }
    const headers = (config.headers ?? {}) as Record<string, unknown>;
    const headerKeys = Object.keys(headers)
      .map((key) => key.toUpperCase())
      .sort();
    if (headerKeys.length > 0) {
      logger.info(`[CLOB][Diag] headerKeysSorted=${headerKeys.join(',')}`);
      headerKeysLogged = true;
    }
    return config;
  });
};

export const runClobAuthPreflight = async (params: {
  client: ClobClient;
  logger?: Logger;
  creds?: ApiKeyCreds;
  derivedSignerAddress?: string;
  configuredPublicKey?: string;
  privateKeyPresent: boolean;
  force?: boolean;
}): Promise<{ ok: boolean; status?: number; reason?: AuthFailureReason; forced: boolean } | null> => {
  if (!params.logger || !params.creds) return null;
  const nowMs = Date.now();
  if (nowMs - lastPreflightAttemptMs < preflightBackoffMs) {
    return null;
  }
  lastPreflightAttemptMs = nowMs;

  const orderBuilder = (params.client as { orderBuilder?: { signatureType?: number; funderAddress?: string } })
    .orderBuilder;
  const signatureType = orderBuilder?.signatureType ?? SignatureType.EOA;
  const funderAddress = orderBuilder?.funderAddress;

  const timestamp = Math.floor(Date.now() / 1000);
  const endpoint = '/balance-allowance';
  params.logger.info(`[CLOB][Preflight] endpoint=${endpoint}`);
  const messageComponents = buildAuthMessageComponents(timestamp, 'GET', endpoint);
  const { messageDigest, secretDecodingUsed, signatureEncoding } = logAuthSigningDiagnostics({
    logger: params.logger,
    secret: params.creds.secret,
    messageComponents,
    signatureEncoding: SIGNATURE_ENCODING_USED,
  });

  try {
    const response = await params.client.getBalanceAllowance();
    const status = response?.status;
    if (status === 200) {
      params.logger.info('[CLOB][Preflight] OK');
      preflightBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
      return { ok: true, status, forced: Boolean(params.force) };
    }
    params.logger.warn(`[CLOB][Preflight] FAIL status=${status ?? 'unknown'}`);
    preflightBackoffMs = Math.min(preflightBackoffMs * 2, PREFLIGHT_BACKOFF_MAX_MS);
    return { ok: false, status, forced: Boolean(params.force) };
  } catch (error) {
    const status = extractStatus(error);
    if (status === 401) {
      const secretFormat = detectSecretDecodingMode(params.creds.secret);
      const reason = classifyAuthFailure({
        configuredPublicKey: params.configuredPublicKey,
        derivedSignerAddress: params.derivedSignerAddress,
        signatureType,
        privateKeyPresent: params.privateKeyPresent,
        secretFormat,
        secretDecodingUsed,
        expectedBodyIncluded: false,
        bodyIncluded: messageComponents.bodyIncluded,
        expectedQueryPresent: false,
        pathIncludesQuery: messageComponents.path.includes('?'),
      });

      params.logger.warn('[CLOB][Preflight] FAIL 401');
      params.logger.warn(`[CLOB][Preflight] reason=${reason}`);
      params.logger.warn(
        `[CLOB][401] address=${params.derivedSignerAddress ?? 'n/a'} sigType=${signatureType} funder=${funderAddress ?? 'none'} secretDecode=${secretDecodingUsed} sigEnc=${signatureEncoding} msgHash=${messageDigest} keyIdSuffix=${formatApiKeyId(params.creds.key)}`,
      );

      preflightBackoffMs = Math.min(preflightBackoffMs * 2, PREFLIGHT_BACKOFF_MAX_MS);
      return { ok: false, status, reason, forced: Boolean(params.force) };
    }

    params.logger.warn(`[CLOB][Preflight] FAIL status=${status ?? 'unknown'}`);
    preflightBackoffMs = Math.min(preflightBackoffMs * 2, PREFLIGHT_BACKOFF_MAX_MS);
    return { ok: false, status, forced: Boolean(params.force) };
  }
};
