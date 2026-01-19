import crypto from "node:crypto";
import axios from "axios";
import type { ApiKeyCreds, ClobClient } from "@polymarket/clob-client";
import { AssetType } from "@polymarket/clob-client";
import * as clobSigning from "@polymarket/clob-client/dist/signing";
import { SignatureType } from "@polymarket/order-utils";
import { Wallet } from "ethers";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { initializeApiCreds } from "../infrastructure/clob-auth";
import type { Logger } from "../utils/logger.util";
import type { StructuredLogger, LogContext } from "../utils/structured-logger";
import { generateReqId } from "../utils/structured-logger";
import { buildSignedPath } from "../utils/query-string.util";

type AnyLogger = Logger | StructuredLogger;

const isStructuredLogger = (logger: AnyLogger): logger is StructuredLogger => {
  return (
    "log" in logger &&
    typeof (logger as StructuredLogger).log === "function" &&
    typeof (logger as StructuredLogger).debug === "function" &&
    typeof (logger as StructuredLogger).child === "function"
  );
};

export type SecretDecodingMode = "raw" | "base64" | "base64url";
export type SignatureEncodingMode = "base64" | "base64url";

export type AuthMessageComponents = {
  timestamp: number;
  method: string;
  path: string;
  bodyIncluded: boolean;
  bodyLength: number;
};

export type AuthFailureReason =
  | "MISMATCHED_ADDRESS"
  | "WRONG_SIGNATURE_TYPE"
  | "SECRET_ENCODING"
  | "MESSAGE_CANONICALIZATION"
  | "SERVER_REJECTED_CREDS";

export type PreflightIssue = "AUTH" | "PARAM" | "FUNDS" | "NETWORK" | "UNKNOWN";

const SIGNATURE_ENCODING_USED: SignatureEncodingMode = "base64url";
const SECRET_DECODING_USED: SecretDecodingMode = "base64";
const PREFLIGHT_BACKOFF_BASE_MS = 1000;
const PREFLIGHT_BACKOFF_MAX_MS = 5 * 60 * 1000;
const PREFLIGHT_MATRIX_DEFAULT_SIGNATURE_TYPES = "0,2";
const PREFLIGHT_MATRIX_DEFAULT_SECRET_DECODE = "base64,base64url,raw";
const PREFLIGHT_MATRIX_DEFAULT_SIG_ENCODING = "base64url,base64";
const PREFLIGHT_MATRIX_DEFAULT_ENDPOINT = "/balance-allowance";
const PREFLIGHT_MATRIX_ERROR_TRUNCATE = 160;
const PREFLIGHT_DATA_TRUNCATE = 300;
const PREFLIGHT_CONNECTIVITY_MAX_TRIES = 5;
const PREFLIGHT_CONNECTIVITY_BACKOFF_BASE_MS = 500;
const PREFLIGHT_TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT"]);
const PREFLIGHT_INVALID_ASSET_TYPE = /invalid asset type/i;
const PREFLIGHT_INSUFFICIENT_FUNDS =
  /not enough balance|insufficient balance|allowance/i;
const PREFLIGHT_NETWORK_HINT = /timeout|timed out|econnreset|network/i;

let headerKeysLogged = false;
let preflightBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
let lastPreflightAttemptMs = 0;
let matrixBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
let lastMatrixAttemptMs = 0;
let matrixCompleted = false;

type AuthModeConfig = {
  signatureType: number;
  secretDecoding: SecretDecodingMode;
  signatureEncoding: SignatureEncodingMode;
  useDerivedCreds: boolean;
};

let activeAuthMode: AuthModeConfig | null = null;
let hmacOverrideInstalled = false;
let originalHmacSignature:
  | ((
      secret: string,
      timestamp: number,
      method: string,
      path: string,
      body?: string,
    ) => string)
  | null = null;

const normalizeAddress = (value?: string): string | undefined =>
  value?.toLowerCase();

export const deriveSignerAddress = (privateKey: string): string =>
  new Wallet(privateKey).address;

export const publicKeyMatchesDerived = (
  configuredPublicKey?: string,
  derivedSignerAddress?: string,
): boolean => {
  if (!configuredPublicKey || !derivedSignerAddress) return false;
  return (
    normalizeAddress(configuredPublicKey) ===
    normalizeAddress(derivedSignerAddress)
  );
};

const secretLooksBase64Url = (secret: string): boolean => {
  const base64UrlAlphabet = /^[A-Za-z0-9_-]+$/;
  const withoutPadding = secret.replace(/=/g, "");
  if (!base64UrlAlphabet.test(withoutPadding)) {
    return false;
  }
  if (secret.includes("-") || secret.includes("_")) {
    return true;
  }
  return withoutPadding.length % 4 !== 0;
};

export const detectSecretDecodingMode = (
  secret?: string,
): SecretDecodingMode => {
  if (!secret) return "raw";
  if (secretLooksBase64Url(secret)) {
    return "base64url";
  }
  if (secret.includes("+") || secret.includes("/") || secret.endsWith("=")) {
    return "base64";
  }
  const base64Alphabet = /^[A-Za-z0-9]+$/;
  if (base64Alphabet.test(secret) && secret.length % 4 === 0) {
    return "base64";
  }
  return "raw";
};

export const decodeSecretBytes = (
  secret: string,
  mode: SecretDecodingMode,
): Buffer => {
  if (mode === "base64url") {
    let normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
    const paddingNeeded = normalized.length % 4;
    if (paddingNeeded) {
      normalized = normalized.padEnd(
        normalized.length + (4 - paddingNeeded),
        "=",
      );
    }
    return Buffer.from(normalized, "base64");
  }
  if (mode === "base64") {
    return Buffer.from(secret, "base64");
  }
  return Buffer.from(secret, "utf8");
};

const encodeSignature = (
  digest: Buffer,
  mode: SignatureEncodingMode,
): string => {
  const base64 = digest.toString("base64");
  if (mode === "base64") {
    return base64;
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_");
};

const readEnvValue = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const parseBooleanList = (
  value: string | undefined,
  fallback: boolean[],
): boolean[] => {
  const entries = parseCsv(value);
  if (!entries.length) return fallback;
  return entries.map((entry) => entry.toLowerCase() === "true");
};

const installHmacOverride = (): void => {
  if (hmacOverrideInstalled) return;
  const signingModule = clobSigning as unknown as {
    buildPolyHmacSignature?: (
      secret: string,
      timestamp: number,
      method: string,
      path: string,
      body?: string,
    ) => string;
  };
  if (typeof signingModule.buildPolyHmacSignature !== "function") return;
  originalHmacSignature = signingModule.buildPolyHmacSignature;
  signingModule.buildPolyHmacSignature = (
    secret,
    timestamp,
    method,
    path,
    body,
  ) => {
    if (!activeAuthMode) {
      return originalHmacSignature
        ? originalHmacSignature(secret, timestamp, method, path, body)
        : "";
    }
    return buildHmacSignature({
      secret,
      timestamp,
      method,
      path,
      body,
      secretDecoding: activeAuthMode.secretDecoding,
      signatureEncoding: activeAuthMode.signatureEncoding,
    });
  };
  hmacOverrideInstalled = true;
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

const buildHmacSignature = (params: {
  secret: string;
  timestamp: number;
  method: string;
  path: string;
  body?: string;
  secretDecoding: SecretDecodingMode;
  signatureEncoding: SignatureEncodingMode;
}): string => {
  const message = buildAuthMessageString({
    timestamp: params.timestamp,
    method: params.method,
    path: params.path,
    body: params.body,
  });
  const secretBytes = decodeSecretBytes(params.secret, params.secretDecoding);
  const hmac = crypto.createHmac("sha256", secretBytes);
  const digest = hmac.update(message).digest();
  return encodeSignature(digest, params.signatureEncoding);
};

export const computeSha256Hex = (value: string | Buffer): string => {
  return crypto.createHash("sha256").update(value).digest("hex");
};

export const formatApiKeyId = (apiKey?: string): string => {
  if (!apiKey) return "n/a";
  if (apiKey.length >= 6) {
    return `...${apiKey.slice(-6)}`;
  }
  const digest = computeSha256Hex(apiKey).slice(0, 8);
  return `sha256:${digest}`;
};

export const getApiKeyDiagnostics = (
  apiKey?: string,
): { apiKeyDigest: string; keyIdSuffix: string } => {
  if (!apiKey) {
    return { apiKeyDigest: "n/a", keyIdSuffix: "n/a" };
  }
  const apiKeyDigest = computeSha256Hex(apiKey).slice(0, 8);
  const keyIdSuffix = apiKey.slice(-6);
  return { apiKeyDigest, keyIdSuffix };
};

const signatureTypeLabel = (signatureType?: number): string => {
  switch (signatureType) {
    case SignatureType.EOA:
      return "EOA";
    case SignatureType.POLY_PROXY:
      return "Magic";
    case SignatureType.POLY_GNOSIS_SAFE:
      return "GnosisSafe";
    default:
      return "Unknown";
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
  logger?: AnyLogger;
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
  const secretLooksBase64UrlFlag = params.secret
    ? secretLooksBase64Url(params.secret)
    : false;
  const secretDecodingUsed =
    params.secretDecodingUsed ??
    (secretLooksBase64UrlFlag ? "base64url" : SECRET_DECODING_USED);
  const messageString = buildAuthMessageString({
    timestamp: params.messageComponents.timestamp,
    method: params.messageComponents.method,
    path: params.messageComponents.path,
    body: params.body,
  });
  const messageStringLength = messageString.length;
  const methodUppercase =
    params.messageComponents.method ===
    params.messageComponents.method.toUpperCase();
  const messageDigest = computeSha256Hex(messageString).slice(0, 12);
  const secretDigest = params.secret
    ? computeSha256Hex(
        decodeSecretBytes(params.secret, secretDecodingUsed),
      ).slice(0, 12)
    : "n/a";

  if (params.logger) {
    if (isStructuredLogger(params.logger)) {
      params.logger.debug("Auth message components", {
        category: "SIGN",
        timestamp: params.messageComponents.timestamp,
        method: params.messageComponents.method,
        methodUppercase,
        path: params.messageComponents.path,
        bodyIncluded: params.messageComponents.bodyIncluded,
        bodyLength: params.messageComponents.bodyLength,
        messageStringLength,
      });
      params.logger.debug("Auth signing details", {
        category: "SIGN",
        messageDigest,
        secretDigest,
        signatureEncoding,
        secretDecoding: secretDecodingUsed,
        secretLooksBase64Url: secretLooksBase64UrlFlag,
      });
    } else {
      params.logger.debug(
        `[CLOB][Diag][Sign] messageComponents timestamp=${params.messageComponents.timestamp} method=${params.messageComponents.method} methodUppercase=${methodUppercase} path=${params.messageComponents.path} bodyIncluded=${params.messageComponents.bodyIncluded} bodyLength=${params.messageComponents.bodyLength} messageStringLength=${messageStringLength}`,
      );
      params.logger.debug(
        `[CLOB][Diag][Sign] messageDigest=${messageDigest} secretDigest=${secretDigest} signatureEncoding=${signatureEncoding} secretDecoding=${secretDecodingUsed} secretLooksBase64Url=${secretLooksBase64UrlFlag}`,
      );
    }
  }

  return { messageDigest, secretDigest, secretDecodingUsed, signatureEncoding };
};

export const logClobDiagnostics = (params: {
  logger?: AnyLogger;
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
  if (isStructuredLogger(params.logger)) {
    params.logger.debug("CLOB client configuration", {
      category: "PREFLIGHT",
      derivedSignerAddress: params.derivedSignerAddress ?? "n/a",
      configuredPublicKey: params.configuredPublicKey ?? "none",
      publicKeyMatchesDerived: publicKeyMatchesDerived(
        params.configuredPublicKey,
        params.derivedSignerAddress,
      ),
      chainId: params.chainId ?? "n/a",
      clobHost: params.clobHost ?? POLYMARKET_API.BASE_URL,
      signatureType: params.signatureType ?? "n/a",
      signatureTypeLabel: signatureTypeLabel(params.signatureType),
      funderAddress: params.funderAddress ?? "none",
      makerAddress: params.makerAddress ?? "n/a",
      ownerId: params.ownerId ?? "n/a",
      keyPresent: params.apiKeyPresent,
      secretPresent: params.secretPresent,
      passphrasePresent: params.passphrasePresent,
    });
  } else {
    // Gate verbose identity dumps behind LOG_LEVEL=debug
    params.logger.debug(
      `[CLOB][Diag] derivedSignerAddress=${params.derivedSignerAddress ?? "n/a"} configuredPublicKey=${params.configuredPublicKey ?? "none"} publicKeyMatchesDerived=${publicKeyMatchesDerived(params.configuredPublicKey, params.derivedSignerAddress)} chainId=${params.chainId ?? "n/a"} clobHost=${params.clobHost ?? POLYMARKET_API.BASE_URL} signatureType=${params.signatureType ?? "n/a"} (${signatureTypeLabel(params.signatureType)}) funderAddress=${params.funderAddress ?? "none"} makerAddress=${params.makerAddress ?? "n/a"} ownerId=${params.ownerId ?? "n/a"} keyPresent=${params.apiKeyPresent} secretPresent=${params.secretPresent} passphrasePresent=${params.passphrasePresent}`,
    );
  }
};

export const logAuthFundsDiagnostics = (params: {
  logger?: AnyLogger;
  derivedSignerAddress?: string;
  configuredPublicKey?: string;
  effectivePolyAddress?: string;
  signatureType?: number;
  funderAddress?: string;
  credentialMode: "explicit" | "derived" | "none";
}): void => {
  if (!params.logger) return;
  if (isStructuredLogger(params.logger)) {
    params.logger.debug("Auth funds configuration", {
      category: "PREFLIGHT",
      signer: params.derivedSignerAddress ?? "n/a",
      configuredPublicKey: params.configuredPublicKey ?? "none",
      publicKeyMatchesDerived: publicKeyMatchesDerived(
        params.configuredPublicKey,
        params.derivedSignerAddress,
      ),
      effectivePolyAddress: params.effectivePolyAddress ?? "n/a",
      signatureType: params.signatureType ?? "n/a",
      signatureTypeLabel: signatureTypeLabel(params.signatureType),
      funderAddress: params.funderAddress ?? "none",
      credentialMode: params.credentialMode,
    });
  } else {
    // Gate verbose identity dumps behind LOG_LEVEL=debug
    params.logger.debug(
      `[CLOB][Diag][AuthFunds] signer=${params.derivedSignerAddress ?? "n/a"} configuredPublicKey=${params.configuredPublicKey ?? "none"} publicKeyMatchesDerived=${publicKeyMatchesDerived(params.configuredPublicKey, params.derivedSignerAddress)} effectivePolyAddress=${params.effectivePolyAddress ?? "n/a"} signatureType=${params.signatureType ?? "n/a"} (${signatureTypeLabel(params.signatureType)}) funderAddress=${params.funderAddress ?? "none"} credentialMode=${params.credentialMode}`,
    );
  }
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
    params.configuredPublicKey &&
    params.derivedSignerAddress &&
    !publicKeyMatchesDerived(
      params.configuredPublicKey,
      params.derivedSignerAddress,
    )
  ) {
    return "MISMATCHED_ADDRESS";
  }
  if (
    params.signatureType === SignatureType.POLY_PROXY &&
    params.privateKeyPresent
  ) {
    return "WRONG_SIGNATURE_TYPE";
  }
  if (
    params.secretFormat === "base64url" &&
    params.secretDecodingUsed !== "base64url"
  ) {
    return "SECRET_ENCODING";
  }
  if (
    (params.expectedBodyIncluded && !params.bodyIncluded) ||
    (params.expectedQueryPresent && !params.pathIncludesQuery)
  ) {
    return "MESSAGE_CANONICALIZATION";
  }
  return "SERVER_REJECTED_CREDS";
};

export const classifyPreflightIssue = (params: {
  status?: number;
  code?: string | null;
  message?: string;
  data?: unknown;
}): PreflightIssue => {
  if (params.status === 401 || params.status === 403) {
    return "AUTH";
  }
  const dataText =
    typeof params.data === "string"
      ? params.data
      : params.data
        ? JSON.stringify(params.data)
        : "";
  const combined = `${params.message ?? ""} ${dataText}`.trim();
  if (params.status === 400 && PREFLIGHT_INVALID_ASSET_TYPE.test(combined)) {
    return "PARAM";
  }
  if (params.status === 400 && PREFLIGHT_INSUFFICIENT_FUNDS.test(combined)) {
    return "FUNDS";
  }
  if (
    (params.code && PREFLIGHT_TRANSIENT_CODES.has(params.code)) ||
    PREFLIGHT_NETWORK_HINT.test(combined)
  ) {
    return "NETWORK";
  }
  return "UNKNOWN";
};

const logPreflightHint = (logger: AnyLogger, issue: PreflightIssue): void => {
  const hints: Record<PreflightIssue, string> = {
    AUTH: "Auth failed: verify API key/secret/passphrase, signature_type, and POLY_ADDRESS.",
    PARAM: "Invalid params: use asset_type=COLLATERAL or asset_type=CONDITIONAL&token_id=...",
    FUNDS: "Insufficient balance/allowance: top up collateral or approve spending.",
    NETWORK: "Network issue: retry or check connectivity/Cloudflare.",
    UNKNOWN: "",
  };

  const hint = hints[issue];
  if (!hint) return;

  if (isStructuredLogger(logger)) {
    logger.warn("Preflight hint", {
      category: "PREFLIGHT",
      issue,
      hint,
    });
  } else {
    logger.warn(`[CLOB][Preflight][Hint] ${hint}`);
  }
};

const extractStatus = (error: unknown): number | undefined => {
  const maybeError = error as {
    response?: { status?: number };
    status?: number;
  };
  return maybeError?.status ?? maybeError?.response?.status;
};

const truncatePreflightData = (data: unknown): string | null => {
  if (data === null || data === undefined) return null;
  let dataText = typeof data === "string" ? data : JSON.stringify(data);
  if (dataText === undefined) {
    dataText = String(data);
  }
  dataText = dataText.replace(/\s+/g, " ");
  if (dataText.length > PREFLIGHT_DATA_TRUNCATE) {
    dataText = dataText.slice(0, PREFLIGHT_DATA_TRUNCATE);
  }
  return dataText;
};

const extractPreflightErrorDetails = (
  error: unknown,
): {
  status?: number;
  code?: string | null;
  message: string;
  data?: unknown;
  url?: string;
} => {
  const maybeError = error as {
    response?: { status?: number; data?: unknown };
    status?: number;
    code?: string;
    message?: string;
  };
  let url: string | undefined;
  if (axios.isAxiosError(error)) {
    const baseUrl = error.config?.baseURL ?? "";
    const configUrl = error.config?.url ?? "";
    if (configUrl) {
      url =
        configUrl.startsWith("http") || !baseUrl
          ? configUrl
          : `${baseUrl}${configUrl}`;
    } else if (baseUrl) {
      url = baseUrl;
    }
  }
  return {
    status: maybeError?.status ?? maybeError?.response?.status,
    code: maybeError?.code ?? null,
    message: maybeError?.message ?? String(error),
    data: maybeError?.response?.data,
    url,
  };
};

const logPreflightFailure = (params: {
  logger: AnyLogger;
  stage: string;
  status?: number;
  code?: string | null;
  message?: string;
  data?: unknown;
  url?: string;
}): void => {
  const message = params.message?.trim() ? params.message : "unknown_error";
  const dataText = truncatePreflightData(params.data);

  if (isStructuredLogger(params.logger)) {
    params.logger.warn("Preflight failure", {
      category: "PREFLIGHT",
      stage: params.stage,
      status: params.status ?? "none",
      code: params.code ?? "none",
      message,
      url: params.url,
      data: dataText,
    });
  } else {
    const urlPart = params.url ? ` url=${params.url}` : "";
    params.logger.warn(
      `[CLOB][Preflight] FAIL stage=${params.stage} status=${params.status ?? "none"} code=${params.code ?? "none"} message=${message}${urlPart}`,
    );
    if (dataText) {
      params.logger.warn(`[CLOB][Preflight] data=${dataText}`);
    }
  }
};

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const runConnectivityCheck = async (
  logger: AnyLogger,
): Promise<"ok" | "transient" | "fail"> => {
  for (
    let attempt = 1;
    attempt <= PREFLIGHT_CONNECTIVITY_MAX_TRIES;
    attempt += 1
  ) {
    try {
      const response = await axios.get(`${POLYMARKET_API.BASE_URL}/markets`, {
        timeout: 10000,
      });
      if (response?.status === 200) {
        if (isStructuredLogger(logger)) {
          logger.debug("Connectivity check passed", {
            category: "HTTP",
            url: `${POLYMARKET_API.BASE_URL}/markets`,
            status: 200,
          });
        }
        return "ok";
      }
      logPreflightFailure({
        logger,
        stage: "connectivity",
        status: response?.status,
        message: response?.statusText ?? "non_200",
        data: (response as { data?: unknown })?.data,
      });
      return "fail";
    } catch (error) {
      const details = extractPreflightErrorDetails(error);
      logPreflightFailure({
        logger,
        stage: "connectivity",
        status: details.status,
        code: details.code,
        message: details.message,
        data: details.data,
        url: details.url,
      });
      if (details.code && PREFLIGHT_TRANSIENT_CODES.has(details.code)) {
        if (attempt === PREFLIGHT_CONNECTIVITY_MAX_TRIES) {
          return "transient";
        }
        const backoffMs =
          PREFLIGHT_CONNECTIVITY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        const jitterMs = Math.floor(Math.random() * backoffMs * 0.2);
        await delay(backoffMs + jitterMs);
        continue;
      }
      return "fail";
    }
  }
  return "transient";
};

export const setupClobHeaderKeyLogging = (logger?: AnyLogger): void => {
  if (!logger || headerKeysLogged) return;
  axios.interceptors.request.use((config) => {
    if (headerKeysLogged) return config;
    const url = config.url ?? "";
    if (!url.includes(POLYMARKET_API.BASE_URL)) {
      return config;
    }
    const headers = (config.headers ?? {}) as Record<string, unknown>;
    const headerKeys = Object.keys(headers)
      .map((key) => key.toUpperCase())
      .sort();
    if (headerKeys.length > 0) {
      if (isStructuredLogger(logger)) {
        logger.debug("HTTP headers detected", {
          category: "HTTP",
          headerKeys: headerKeys.join(","),
          count: headerKeys.length,
        });
      } else {
        logger.info(`[CLOB][Diag] headerKeysSorted=${headerKeys.join(",")}`);
      }
      headerKeysLogged = true;
    }
    return config;
  });
};

export const runClobAuthPreflight = async (params: {
  client: ClobClient;
  logger?: AnyLogger;
  creds?: ApiKeyCreds;
  derivedSignerAddress?: string;
  configuredPublicKey?: string;
  privateKeyPresent: boolean;
  derivedCredsEnabled?: boolean;
  force?: boolean;
}): Promise<{
  ok: boolean;
  status?: number;
  reason?: AuthFailureReason;
  forced: boolean;
} | null> => {
  if (!params.logger || !params.creds) return null;
  const nowMs = Date.now();
  if (nowMs - lastPreflightAttemptMs < preflightBackoffMs) {
    return null;
  }
  lastPreflightAttemptMs = nowMs;

  const orderBuilder = (
    params.client as {
      orderBuilder?: { signatureType?: number; funderAddress?: string };
    }
  ).orderBuilder;
  const signatureType = orderBuilder?.signatureType ?? SignatureType.EOA;
  const funderAddress = orderBuilder?.funderAddress;

  const reqId = generateReqId();
  const logContext: LogContext = {
    category: "PREFLIGHT",
    reqId,
  };

  const connectivity = await runConnectivityCheck(params.logger);
  if (connectivity === "transient") {
    preflightBackoffMs = Math.min(
      preflightBackoffMs * 2,
      PREFLIGHT_BACKOFF_MAX_MS,
    );
    return null;
  }
  if (connectivity === "fail") {
    preflightBackoffMs = Math.min(
      preflightBackoffMs * 2,
      PREFLIGHT_BACKOFF_MAX_MS,
    );
    return { ok: false, forced: Boolean(params.force) };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const endpoint = "/balance-allowance";
  
  if (isStructuredLogger(params.logger)) {
    params.logger.debug("Starting auth preflight", {
      ...logContext,
      endpoint,
    });
  } else {
    params.logger.info(`[CLOB][Preflight] endpoint=${endpoint}`);
  }

  const requestParams = { asset_type: AssetType.COLLATERAL };
  const signedParams =
    signatureType !== undefined
      ? { ...requestParams, signature_type: signatureType }
      : requestParams;
  const { signedPath, paramsKeys } = buildSignedPath(endpoint, signedParams);
  
  if (isStructuredLogger(params.logger)) {
    params.logger.debug("Signed path details", {
      category: "SIGN",
      reqId,
      pathSigned: signedPath,
      paramsKeys: paramsKeys.length ? paramsKeys.join(",") : "none",
      signatureIncludesQuery: signedPath.includes("?"),
    });
  } else {
    params.logger.info(
      `[CLOB][Diag][Sign] pathSigned=${signedPath} paramsKeys=${paramsKeys.length ? paramsKeys.join(",") : "none"} signatureIncludesQuery=${signedPath.includes("?")}`,
    );
  }

  const messageComponents = buildAuthMessageComponents(
    timestamp,
    "GET",
    signedPath,
  );
  const { messageDigest, secretDecodingUsed, signatureEncoding } =
    logAuthSigningDiagnostics({
      logger: params.logger,
      secret: params.creds.secret,
      messageComponents,
      signatureEncoding: SIGNATURE_ENCODING_USED,
    });

  try {
    const response = await params.client.getBalanceAllowance(requestParams);
    const status = (response as { status?: number })?.status;
    const responseErrorMessage = extractPreflightResponseErrorMessage(response);
    if (status === 200) {
      if (isStructuredLogger(params.logger)) {
        params.logger.info("Auth preflight successful", {
          ...logContext,
          status,
        });
      } else {
        params.logger.info("[CLOB][Preflight] OK");
      }
      preflightBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
      return { ok: true, status, forced: Boolean(params.force) };
    }
    if (status === 401 || status === 403) {
      logPreflightFailure({
        logger: params.logger,
        stage: "auth",
        status,
        message: responseErrorMessage || "unauthorized",
        data: (response as { data?: unknown })?.data,
      });
      logPreflightHint(
        params.logger,
        classifyPreflightIssue({
          status,
          message: responseErrorMessage,
          data: (response as { data?: unknown })?.data,
        }),
      );
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
        expectedQueryPresent: paramsKeys.length > 0,
        pathIncludesQuery: messageComponents.path.includes("?"),
      });

      if (isStructuredLogger(params.logger)) {
        params.logger.warn("Auth preflight failed", {
          ...logContext,
          status,
          reason,
          address: params.derivedSignerAddress ?? "n/a",
          sigType: signatureType,
          funder: funderAddress ?? "none",
          secretDecode: secretDecodingUsed,
          sigEnc: signatureEncoding,
          msgHash: messageDigest,
          keyIdSuffix: formatApiKeyId(params.creds.key),
        });
      } else {
        params.logger.warn(`[CLOB][Preflight] FAIL ${status}`);
        params.logger.warn(`[CLOB][Preflight] reason=${reason}`);
        params.logger.warn(
          `[CLOB][401] address=${params.derivedSignerAddress ?? "n/a"} sigType=${signatureType} funder=${funderAddress ?? "none"} secretDecode=${secretDecodingUsed} sigEnc=${signatureEncoding} msgHash=${messageDigest} keyIdSuffix=${formatApiKeyId(params.creds.key)}`,
        );
      }

      preflightBackoffMs = Math.min(
        preflightBackoffMs * 2,
        PREFLIGHT_BACKOFF_MAX_MS,
      );
      return { ok: false, status, reason, forced: Boolean(params.force) };
    }
    if (status && status >= 500) {
      logPreflightFailure({
        logger: params.logger,
        stage: "auth",
        status,
        message: responseErrorMessage || "server_error",
        data: (response as { data?: unknown })?.data,
      });
      preflightBackoffMs = Math.min(
        preflightBackoffMs * 2,
        PREFLIGHT_BACKOFF_MAX_MS,
      );
      return null;
    }
    if (status && status >= 400 && status < 500) {
      logPreflightFailure({
        logger: params.logger,
        stage: "auth",
        status,
        message: responseErrorMessage || "bad_request",
        data: (response as { data?: unknown })?.data,
      });
      logPreflightHint(
        params.logger,
        classifyPreflightIssue({
          status,
          message: responseErrorMessage || "bad_request",
          data: (response as { data?: unknown })?.data,
        }),
      );
      if (isStructuredLogger(params.logger)) {
        params.logger.warn("Auth OK but bad params", {
          ...logContext,
          endpoint,
        });
      } else {
        params.logger.warn(
          `[CLOB][Preflight] AUTH_OK_BUT_BAD_PARAMS endpoint=${endpoint}`,
        );
      }
      preflightBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
      return { ok: true, status, forced: Boolean(params.force) };
    }
    logPreflightFailure({
      logger: params.logger,
      stage: "auth",
      status,
      message: responseErrorMessage || "unknown_error",
      data: (response as { data?: unknown })?.data,
    });
    logPreflightHint(
      params.logger,
      classifyPreflightIssue({
        status,
        message: responseErrorMessage || "unknown_error",
        data: (response as { data?: unknown })?.data,
      }),
    );
    preflightBackoffMs = Math.min(
      preflightBackoffMs * 2,
      PREFLIGHT_BACKOFF_MAX_MS,
    );
    return { ok: false, status, forced: Boolean(params.force) };
  } catch (error) {
    const details = extractPreflightErrorDetails(error);
    
    if (isStructuredLogger(params.logger)) {
      params.logger.warn("Preflight request failed", {
        category: "HTTP",
        reqId,
        method: "GET",
        endpoint,
      });
    } else {
      params.logger.warn(`[CLOB][Preflight] request GET ${endpoint}`);
    }

    logPreflightFailure({
      logger: params.logger,
      stage: "auth",
      status: details.status,
      code: details.code,
      message: details.message,
      data: details.data,
      url: details.url,
    });
    logPreflightHint(
      params.logger,
      classifyPreflightIssue({
        status: details.status,
        code: details.code,
        message: details.message,
        data: details.data,
      }),
    );
    if (details.code && PREFLIGHT_TRANSIENT_CODES.has(details.code)) {
      preflightBackoffMs = Math.min(
        preflightBackoffMs * 2,
        PREFLIGHT_BACKOFF_MAX_MS,
      );
      return null;
    }
    if (details.status === 401 || details.status === 403) {
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
        expectedQueryPresent: paramsKeys.length > 0,
        pathIncludesQuery: messageComponents.path.includes("?"),
      });

      if (isStructuredLogger(params.logger)) {
        params.logger.warn("Auth preflight failed", {
          ...logContext,
          status: details.status,
          reason,
          address: params.derivedSignerAddress ?? "n/a",
          sigType: signatureType,
          funder: funderAddress ?? "none",
          secretDecode: secretDecodingUsed,
          sigEnc: signatureEncoding,
          msgHash: messageDigest,
          keyIdSuffix: formatApiKeyId(params.creds.key),
        });
      } else {
        params.logger.warn(`[CLOB][Preflight] FAIL ${details.status}`);
        params.logger.warn(`[CLOB][Preflight] reason=${reason}`);
        params.logger.warn(
          `[CLOB][401] address=${params.derivedSignerAddress ?? "n/a"} sigType=${signatureType} funder=${funderAddress ?? "none"} secretDecode=${secretDecodingUsed} sigEnc=${signatureEncoding} msgHash=${messageDigest} keyIdSuffix=${formatApiKeyId(params.creds.key)}`,
        );
      }

      preflightBackoffMs = Math.min(
        preflightBackoffMs * 2,
        PREFLIGHT_BACKOFF_MAX_MS,
      );
      return {
        ok: false,
        status: details.status,
        reason,
        forced: Boolean(params.force),
      };
    }
    if (details.status && details.status >= 500) {
      preflightBackoffMs = Math.min(
        preflightBackoffMs * 2,
        PREFLIGHT_BACKOFF_MAX_MS,
      );
      return null;
    }
    if (details.status && details.status >= 400 && details.status < 500) {
      if (isStructuredLogger(params.logger)) {
        params.logger.warn("Auth OK but bad params", {
          ...logContext,
          endpoint,
        });
      } else {
        params.logger.warn(
          `[CLOB][Preflight] AUTH_OK_BUT_BAD_PARAMS endpoint=${endpoint}`,
        );
      }
      preflightBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
      return {
        ok: true,
        status: details.status,
        forced: Boolean(params.force),
      };
    }
    preflightBackoffMs = Math.min(
      preflightBackoffMs * 2,
      PREFLIGHT_BACKOFF_MAX_MS,
    );
    return { ok: false, status: details.status, forced: Boolean(params.force) };
  }
};

const formatPreflightError = (error: unknown): string => {
  const status = extractStatus(error);
  let message = extractPreflightErrorMessage(error);
  if (!message) {
    message = status ? `status_${status}` : "unknown_error";
  }
  if (message.length > PREFLIGHT_MATRIX_ERROR_TRUNCATE) {
    return `${message.slice(0, PREFLIGHT_MATRIX_ERROR_TRUNCATE)}…`;
  }
  return message;
};

const extractPreflightErrorMessage = (error: unknown): string => {
  const maybeError = error as {
    response?: { data?: unknown };
    message?: string;
  };
  if (typeof maybeError?.response?.data === "string") {
    return maybeError.response.data;
  }
  if (
    maybeError?.response?.data &&
    typeof maybeError.response.data === "object"
  ) {
    return JSON.stringify(maybeError.response.data);
  }
  if (typeof maybeError?.message === "string") {
    return maybeError.message;
  }
  return "";
};

const extractPreflightResponseErrorMessage = (response: unknown): string => {
  const responseError = (response as { error?: unknown })?.error;
  if (typeof responseError === "string") {
    return responseError;
  }
  if (responseError && typeof responseError === "object") {
    return JSON.stringify(responseError);
  }
  return "";
};

const formatMatrixTable = (rows: string[][]): string => {
  const header = [
    "id",
    "signature_type",
    "secretDecode",
    "sigEncoding",
    "derivedCreds",
    "status",
    "error",
  ];
  const table = [header, ...rows];
  const widths = header.map((_, idx) =>
    Math.max(...table.map((row) => row[idx].length)),
  );
  const formatRow = (row: string[]): string =>
    row.map((value, idx) => value.padEnd(widths[idx])).join(" | ");
  return [
    "[CLOB][Preflight][Matrix]",
    formatRow(header),
    ...rows.map(formatRow),
  ].join("\n");
};

const applyAuthMode = async (
  client: ClobClient,
  creds: ApiKeyCreds,
  mode: AuthModeConfig,
): Promise<void> => {
  activeAuthMode = mode;
  installHmacOverride();
  const orderBuilder = (client as { orderBuilder?: { signatureType?: number } })
    .orderBuilder;
  if (orderBuilder) {
    orderBuilder.signatureType = mode.signatureType;
  }
  await initializeApiCreds(client, creds);
};

export const runClobAuthMatrixPreflight = async (params: {
  client: ClobClient;
  logger?: AnyLogger;
  creds?: ApiKeyCreds;
  derivedCreds?: ApiKeyCreds;
}): Promise<{ ok: boolean } | null> => {
  if (!params.logger || !params.creds) return null;
  const matrixEnabled = readEnvValue("CLOB_PREFLIGHT_MATRIX") === "true";
  if (!matrixEnabled) return null;
  if (matrixCompleted) return null;
  const nowMs = Date.now();
  if (nowMs - lastMatrixAttemptMs < matrixBackoffMs) {
    return null;
  }
  lastMatrixAttemptMs = nowMs;

  const endpoint =
    readEnvValue("CLOB_PREFLIGHT_ENDPOINT") ??
    PREFLIGHT_MATRIX_DEFAULT_ENDPOINT;
  const signatureTypeValues = parseCsv(
    readEnvValue("CLOB_PREFLIGHT_TRY_SIGNATURE_TYPES") ??
      PREFLIGHT_MATRIX_DEFAULT_SIGNATURE_TYPES,
  );
  const secretDecodingValues = parseCsv(
    readEnvValue("CLOB_PREFLIGHT_TRY_SECRET_DECODE") ??
      PREFLIGHT_MATRIX_DEFAULT_SECRET_DECODE,
  ) as SecretDecodingMode[];
  const signatureEncodingValues = parseCsv(
    readEnvValue("CLOB_PREFLIGHT_TRY_SIG_ENCODING") ??
      PREFLIGHT_MATRIX_DEFAULT_SIG_ENCODING,
  ) as SignatureEncodingMode[];
  const derivedCredsChoices = parseBooleanList(
    readEnvValue("CLOB_PREFLIGHT_USE_DERIVED_CREDS"),
    [false, true],
  );

  const signer = (
    params.client as { signer?: { getAddress: () => Promise<string> } }
  ).signer;
  const address = signer ? await signer.getAddress() : "";
  const rows: string[][] = [];
  let successMode: { mode: AuthModeConfig; creds: ApiKeyCreds } | null = null;
  let attemptId = 0;

  if (isStructuredLogger(params.logger)) {
    params.logger.info("Starting auth matrix preflight", {
      category: "PREFLIGHT",
      endpoint,
      signatureTypes: signatureTypeValues.length,
      secretDecodings: secretDecodingValues.length,
      signatureEncodings: signatureEncodingValues.length,
    });
  }

  for (const signatureTypeRaw of signatureTypeValues) {
    const signatureType = Number(signatureTypeRaw);
    if (Number.isNaN(signatureType)) {
      continue;
    }
    for (const secretDecoding of secretDecodingValues) {
      for (const signatureEncoding of signatureEncodingValues) {
        for (const useDerivedCreds of derivedCredsChoices) {
          attemptId += 1;
          const credsToUse = useDerivedCreds
            ? params.derivedCreds
            : params.creds;
          if (!credsToUse) {
            rows.push([
              `${attemptId}`,
              `${signatureType}`,
              secretDecoding,
              signatureEncoding,
              `${useDerivedCreds}`,
              "other",
              "missing_creds",
            ]);
            continue;
          }

          const timestamp = Math.floor(Date.now() / 1000);
          const requestParams = { asset_type: AssetType.COLLATERAL };
          const { signedPath } = buildSignedPath(endpoint, requestParams);
          const signature = buildHmacSignature({
            secret: credsToUse.secret,
            timestamp,
            method: "GET",
            path: signedPath,
            secretDecoding,
            signatureEncoding,
          });
          const headers = {
            POLY_ADDRESS: address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: `${timestamp}`,
            POLY_API_KEY: credsToUse.key,
            POLY_PASSPHRASE: credsToUse.passphrase,
          };

          let statusLabel = "other";
          let errorLabel = "";
          try {
            const response = await axios.get(
              `${POLYMARKET_API.BASE_URL}${endpoint}`,
              {
                headers,
                params: requestParams,
                timeout: 10000,
              },
            );
            if (response?.status === 200) {
              statusLabel = "200";
              rows.push([
                `${attemptId}`,
                `${signatureType}`,
                secretDecoding,
                signatureEncoding,
                `${useDerivedCreds}`,
                statusLabel,
                "",
              ]);
              successMode = {
                mode: {
                  signatureType,
                  secretDecoding,
                  signatureEncoding,
                  useDerivedCreds,
                },
                creds: credsToUse,
              };
              break;
            }
            statusLabel = response?.status === 401 ? "401" : "other";
            errorLabel = response?.statusText ?? "";
          } catch (error) {
            const status = extractStatus(error);
            statusLabel =
              status === 200 ? "200" : status === 401 ? "401" : "other";
            errorLabel = formatPreflightError(error);
          }

          rows.push([
            `${attemptId}`,
            `${signatureType}`,
            secretDecoding,
            signatureEncoding,
            `${useDerivedCreds}`,
            statusLabel,
            errorLabel,
          ]);

          if (statusLabel === "200") {
            break;
          }
        }
        if (successMode) break;
      }
      if (successMode) break;
    }
    if (successMode) break;
  }

  if (isStructuredLogger(params.logger)) {
    params.logger.info("Auth matrix preflight complete", {
      category: "PREFLIGHT",
      totalAttempts: attemptId,
      success: Boolean(successMode),
    });
    params.logger.debug("Matrix results", {
      category: "PREFLIGHT",
      table: formatMatrixTable(rows),
    });
  } else {
    params.logger.info(formatMatrixTable(rows));
  }

  matrixCompleted = true;

  if (successMode) {
    if (isStructuredLogger(params.logger)) {
      params.logger.info("Valid auth mode found", {
        category: "PREFLIGHT",
        signatureType: successMode.mode.signatureType,
        secretDecoding: successMode.mode.secretDecoding,
        signatureEncoding: successMode.mode.signatureEncoding,
        useDerivedCreds: successMode.mode.useDerivedCreds,
      });
    }
    await applyAuthMode(params.client, successMode.creds, successMode.mode);
    matrixBackoffMs = PREFLIGHT_BACKOFF_BASE_MS;
    return { ok: true };
  }

  if (isStructuredLogger(params.logger)) {
    params.logger.warn("No valid auth mode found", {
      category: "PREFLIGHT",
    });
  } else {
    params.logger.warn("NO_VALID_AUTH_MODE");
  }
  matrixBackoffMs = Math.min(matrixBackoffMs * 2, PREFLIGHT_BACKOFF_MAX_MS);
  return { ok: false };
};
