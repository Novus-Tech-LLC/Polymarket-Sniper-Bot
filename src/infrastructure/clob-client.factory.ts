import { Wallet, providers } from "ethers";
import {
  AssetType,
  ClobClient,
  Chain,
  createL2Headers,
} from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { initializeApiCreds } from "./clob-auth";
import type { Logger } from "../utils/logger.util";
import {
  formatAuthHeaderPresence,
  getAuthHeaderPresence,
} from "../utils/clob-auth-headers.util";
import { sanitizeErrorMessage } from "../utils/sanitize-axios-error.util";
import {
  buildAuthMessageComponents,
  formatApiKeyId,
  getApiKeyDiagnostics,
  logAuthSigningDiagnostics,
  logClobDiagnostics,
  logAuthFundsDiagnostics,
  setupClobHeaderKeyLogging,
} from "../clob/diagnostics";
import {
  evaluatePublicKeyMismatch,
  parseSignatureType,
  resolveDerivedSignerAddress,
  resolveEffectivePolyAddress,
} from "../clob/addressing";
import { buildSignedPath } from "../utils/query-string.util";
import {
  loadCachedCreds,
  saveCachedCreds,
} from "../utils/credential-storage.util";

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

/**
 * Type for error responses returned by clob-client (instead of thrown exceptions)
 */
type ClobErrorResponse = {
  status?: number;
  error?: string;
};

const SERVER_TIME_SKEW_THRESHOLD_SECONDS = 30;
let polyAddressDiagLogged = false;
let cachedDerivedCreds: ApiKeyCreds | null = null;
let createApiKeyBlocked = false;
let createApiKeyBlockedUntil = 0; // Timestamp for retry backoff
let deriveFallbackAttempted = false;

const readEnvValue = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const buildEffectiveSigner = (
  wallet: Wallet,
  effectivePolyAddress: string,
): Wallet => {
  if (!effectivePolyAddress) return wallet;
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === "getAddress") {
        return async () => effectivePolyAddress;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
};

const parseTimestampSeconds = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  if (raw > 1_000_000_000_000) return Math.floor(raw / 1000);
  return Math.floor(raw);
};

const extractServerTimeSeconds = (payload: unknown): number | undefined => {
  const direct = parseTimestampSeconds(payload);
  if (direct !== undefined) return direct;
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = [
    "serverTime",
    "server_time",
    "timestamp",
    "time",
    "epoch",
    "seconds",
  ];
  for (const key of candidates) {
    const parsed = parseTimestampSeconds(record[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const maybeEnableServerTime = async (
  client: ClobClient,
  logger?: Logger,
): Promise<void> => {
  try {
    const serverTimePayload = await client.getServerTime();
    const serverSeconds = extractServerTimeSeconds(serverTimePayload);
    if (serverSeconds === undefined) {
      logger?.warn("[CLOB] Unable to parse server time; using local clock.");
      return;
    }
    const localSeconds = Math.floor(Date.now() / 1000);
    const skewSeconds = Math.abs(serverSeconds - localSeconds);
    if (skewSeconds >= SERVER_TIME_SKEW_THRESHOLD_SECONDS) {
      (client as ClobClient & { useServerTime?: boolean }).useServerTime = true;
      logger?.warn(
        `[CLOB] Clock skew ${skewSeconds}s detected; enabling server time for signatures.`,
      );
      return;
    }
    logger?.info(`[CLOB] Clock skew ${skewSeconds}s; using local clock.`);
  } catch (err) {
    logger?.warn(
      `[CLOB] Failed to fetch server time; using local clock. ${sanitizeErrorMessage(err)}`,
    );
  }
};

const logAuthHeaderPresence = async (
  client: ClobClient,
  creds: ApiKeyCreds,
  logger?: Logger,
): Promise<void> => {
  if (!logger) return;
  try {
    const signer = (
      client as ClobClient & { signer?: Wallet | providers.JsonRpcSigner }
    ).signer;
    if (!signer) return;
    const signatureType = (
      client as { orderBuilder?: { signatureType?: number } }
    ).orderBuilder?.signatureType;
    const params = {
      asset_type: AssetType.COLLATERAL,
      ...(signatureType !== undefined ? { signature_type: signatureType } : {}),
    };
    const { signedPath, paramsKeys } = buildSignedPath(
      "/balance-allowance",
      params,
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = await createL2Headers(
      signer,
      creds,
      {
        method: "GET",
        requestPath: signedPath,
      },
      timestamp,
    );
    const presence = getAuthHeaderPresence(headers, {
      secretConfigured: Boolean(creds?.secret),
    });
    logger.info(
      `[CLOB] Auth header presence: ${formatAuthHeaderPresence(presence)}`,
    );
    logger.info(
      `[CLOB][Diag][Sign] pathSigned=${signedPath} paramsKeys=${paramsKeys.length ? paramsKeys.join(",") : "none"} signatureIncludesQuery=${signedPath.includes("?")}`,
    );
    logAuthSigningDiagnostics({
      logger,
      secret: creds.secret,
      messageComponents: buildAuthMessageComponents(
        timestamp,
        "GET",
        signedPath,
      ),
    });
  } catch (err) {
    logger.warn(
      `[CLOB] Failed to inspect auth headers. ${sanitizeErrorMessage(err)}`,
    );
  }
};

const extractErrorPayloadMessage = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") return JSON.stringify(payload);
  return "";
};

const extractDeriveErrorMessage = (error: unknown): string => {
  const maybeError = error as {
    response?: { data?: unknown };
    message?: string;
  };
  const responseMessage = extractErrorPayloadMessage(
    maybeError?.response?.data,
  );
  if (responseMessage) return responseMessage;
  if (typeof maybeError?.message === "string") return maybeError.message;
  return "";
};

const canDetectCreateApiKeyFailure = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  if (status !== 400) {
    return false;
  }
  const message =
    extractDeriveErrorMessage(error) || sanitizeErrorMessage(error);
  return message.toLowerCase().includes("could not create api key");
};

const verifyCredsWithClient = async (
  creds: ApiKeyCreds,
  wallet: Wallet,
  logger?: Logger,
): Promise<boolean> => {
  try {
    const verifyClient = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      wallet,
      creds,
      SignatureType.EOA,
    );
    const response = await verifyClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    // The clob-client returns error objects instead of throwing on HTTP errors
    // Check if response indicates an error
    const errorResponse = response as ClobErrorResponse;
    if (errorResponse.status === 401 || errorResponse.status === 403) {
      logger?.warn(
        `[CLOB] Credential verification failed: ${errorResponse.status} ${errorResponse.error ?? "Unauthorized/Invalid api key"}`,
      );
      return false;
    }
    if (errorResponse.error) {
      // Some other error returned from server
      logger?.warn(
        `[CLOB] Credential verification returned error: ${errorResponse.error}`,
      );
      // Treat non-auth errors as transient, re-throw to trigger fallback
      throw new Error(errorResponse.error);
    }
    return true;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status === 401 || status === 403) {
      logger?.warn(
        `[CLOB] Credential verification failed: ${status} Unauthorized/Invalid api key`,
      );
      return false;
    }
    // For other errors (network issues, etc.), assume credentials might be valid
    logger?.warn(
      `[CLOB] Credential verification encountered error: ${sanitizeErrorMessage(error)}`,
    );
    throw error;
  }
};

const deriveApiCreds = async (
  wallet: Wallet,
  logger?: Logger,
): Promise<ApiKeyCreds | undefined> => {
  const signerAddress = await wallet.getAddress();

  // Try to load from disk cache first
  if (cachedDerivedCreds) {
    logger?.info("[CLOB] Using in-memory cached derived credentials.");
    return cachedDerivedCreds;
  }

  const diskCached = loadCachedCreds({ signerAddress, logger });
  if (diskCached) {
    // Verify cached credentials before using them
    logger?.info("[CLOB] Verifying disk-cached credentials...");
    try {
      const isValid = await verifyCredsWithClient(diskCached, wallet, logger);
      if (isValid) {
        cachedDerivedCreds = diskCached;
        logger?.info(
          "[CLOB] Using disk-cached derived credentials (verified).",
        );
        return diskCached;
      } else {
        // Cached credentials are invalid (401/403), clear cache and retry
        logger?.warn(
          "[CLOB] Cached credentials invalid; clearing cache and retrying derive.",
        );
        const { clearCachedCreds } =
          await import("../utils/credential-storage.util");
        clearCachedCreds(logger);
        cachedDerivedCreds = null;
        // Fall through to derive new credentials
      }
    } catch (error) {
      // Verification error (not 401/403), treat as transient and use cached creds
      logger?.warn(
        "[CLOB] Credential verification error; using cached credentials anyway.",
      );
      cachedDerivedCreds = diskCached;
      return diskCached;
    }
  }

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
    deriveApiKey?: () => Promise<ApiKeyCreds>;
  };

  const attemptLocalDerive = async (): Promise<ApiKeyCreds | undefined> => {
    if (deriveFallbackAttempted) return cachedDerivedCreds ?? undefined;
    deriveFallbackAttempted = true;
    if (!deriveFn.deriveApiKey) return undefined;
    try {
      const derived = await deriveFn.deriveApiKey();
      if (derived?.key && derived?.secret && derived?.passphrase) {
        cachedDerivedCreds = derived;
        saveCachedCreds({ creds: derived, signerAddress, logger });
      }
      return cachedDerivedCreds ?? derived;
    } catch (err) {
      logger?.warn(`[CLOB] Local derive failed: ${sanitizeErrorMessage(err)}`);
      return undefined;
    }
  };

  // Check backoff timer
  const now = Date.now();
  if (createApiKeyBlocked && createApiKeyBlockedUntil > now) {
    const remainingSeconds = Math.ceil((createApiKeyBlockedUntil - now) / 1000);
    logger?.info(
      `[CLOB] API key creation blocked; retry in ${remainingSeconds}s. Skipping local derive.`,
    );
    return undefined;
  } else if (createApiKeyBlocked && createApiKeyBlockedUntil <= now) {
    // Retry period expired, reset block
    logger?.info(
      "[CLOB] API key creation retry period expired; attempting again.",
    );
    createApiKeyBlocked = false;
    createApiKeyBlockedUntil = 0;
  }

  // Defensive check: if blocked flag is set but timer expired, we should have reset above
  if (createApiKeyBlocked) {
    logger?.warn(
      "[CLOB] Unexpected state: API key creation blocked without timer. Skipping derive.",
    );
    return undefined;
  }

  try {
    logger?.info(
      "[CLOB] Attempting to create/derive API credentials from server...",
    );
    const derived = deriveFn.create_or_derive_api_creds
      ? await deriveFn.create_or_derive_api_creds()
      : await deriveFn.createOrDeriveApiKey?.();

    // Validate response contains valid credentials before marking success
    if (!derived || !derived.key || !derived.secret || !derived.passphrase) {
      logger?.error(
        "[CLOB] API key creation returned incomplete credentials (missing key/secret/passphrase)",
      );
      logger?.error(
        `[CLOB] Response: key=${Boolean(derived?.key)} secret=${Boolean(derived?.secret)} passphrase=${Boolean(derived?.passphrase)}`,
      );
      // Do NOT call attemptLocalDerive() - incomplete server response means credentials
      // were not properly registered, so local derive would produce unregistered credentials
      return undefined;
    }

    // Verify derived credentials work before caching them
    logger?.info("[CLOB] Verifying newly derived credentials...");
    try {
      const isValid = await verifyCredsWithClient(derived, wallet, logger);
      if (!isValid) {
        logger?.error(
          "[CLOB] Derived credentials failed verification (401/403); NOT caching.",
        );
        logger?.error(
          "[CLOB] The server returned credentials that do not work. This may indicate:",
        );
        logger?.error(
          "[CLOB]   - The wallet has never traded on Polymarket (try making a small trade on the website first)",
        );
        logger?.error(
          "[CLOB]   - The API credentials on the server are corrupted or expired",
        );
        logger?.error(
          "[CLOB]   - Visit https://polymarket.com to connect this wallet and enable trading",
        );
        logger?.error(
          "[CLOB]   - Or visit https://polymarket.com/settings/api to manage API keys manually",
        );
        // Do not cache or use these credentials - they don't work
        return undefined;
      }
      logger?.info("[CLOB] Derived credentials verified successfully.");
    } catch (verifyError) {
      // Verification encountered a transient error (network, etc.)
      // In this case, we'll optimistically cache the credentials and let
      // the preflight check handle verification later
      logger?.warn(
        `[CLOB] Credential verification encountered transient error; caching anyway. ${sanitizeErrorMessage(verifyError)}`,
      );
    }

    // Valid credentials received and verified, save and return
    cachedDerivedCreds = derived;
    saveCachedCreds({ creds: derived, signerAddress, logger });
    logger?.info("[CLOB] Successfully created/derived API credentials.");
    return cachedDerivedCreds;
  } catch (error) {
    // Log detailed error information
    const errorDetails = extractDeriveErrorMessage(error);
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    const responseData = (error as { response?: { data?: unknown } })?.response
      ?.data;

    // Log error with full details (excluding secrets)
    logger?.error(
      `[CLOB] API key creation failed: status=${status ?? "unknown"} error=${errorDetails}`,
    );
    if (responseData) {
      logger?.error(`[CLOB] Response data: ${JSON.stringify(responseData)}`);
    }

    // Treat 400/401 as definite failures - don't save credentials
    if (status === 400 || status === 401) {
      logger?.error(
        "[CLOB] API key creation failed with 400/401; credentials NOT saved.",
      );
      if (canDetectCreateApiKeyFailure(error)) {
        createApiKeyBlocked = true;
        const retrySeconds = parseInt(
          readEnvValue("AUTH_DERIVE_RETRY_SECONDS") || "600",
          10,
        ); // Default 10 minutes
        createApiKeyBlockedUntil = Date.now() + retrySeconds * 1000;
        logger?.error(
          "[CLOB] =====================================================================",
        );
        logger?.error(
          "[CLOB] FIRST-TIME WALLET DETECTED: Server cannot create API credentials",
        );
        logger?.error(
          "[CLOB] =====================================================================",
        );
        logger?.error(
          "[CLOB] This error occurs when your wallet has never traded on Polymarket.",
        );
        logger?.error("[CLOB] ");
        logger?.error("[CLOB] TO FIX THIS:");
        logger?.error(
          "[CLOB]   1. Visit https://polymarket.com and connect this wallet",
        );
        logger?.error("[CLOB]   2. Make a small test trade on any market");
        logger?.error(
          "[CLOB]   3. Wait a few minutes for the transaction to confirm",
        );
        logger?.error("[CLOB]   4. Restart this bot");
        logger?.error("[CLOB] ");
        logger?.error(
          `[CLOB] The bot will automatically retry credential creation in ${retrySeconds}s.`,
        );
        logger?.error(
          "[CLOB] Until then, the bot will operate in detect-only mode (no trades).",
        );
        logger?.error(
          "[CLOB] =====================================================================",
        );
        // Local derivation would produce credentials not registered with the server,
        // causing 401 errors. The server must register credentials first.
        return undefined;
      }
      // For other 400/401 errors (e.g., auth issues with existing credentials),
      // try local derive since credentials may already be registered on the server
      // and just need to be re-derived locally to match
      return attemptLocalDerive();
    }

    // For other errors, try local derive as fallback
    logger?.warn(
      "[CLOB] API key creation failed with unexpected error; trying local derive fallback.",
    );
    return attemptLocalDerive();
  }
};

export async function createPolymarketClient(input: CreateClientInput): Promise<
  ClobClient & {
    wallet: Wallet;
    derivedSignerAddress: string;
    effectivePolyAddress: string;
    publicKeyMismatch: boolean;
    executionDisabled: boolean;
    providedCreds?: ApiKeyCreds;
    derivedCreds?: ApiKeyCreds;
    deriveFailed?: boolean;
    deriveError?: string;
  }
> {
  const provider = new providers.JsonRpcProvider(input.rpcUrl);
  const wallet = new Wallet(input.privateKey, provider);
  setupClobHeaderKeyLogging(input.logger);

  const derivedSignerAddress = resolveDerivedSignerAddress(input.privateKey);
  const signatureType = parseSignatureType(
    input.signatureType ?? readEnvValue("CLOB_SIGNATURE_TYPE"),
  );
  const funderAddress =
    input.funderAddress ?? readEnvValue("CLOB_FUNDER_ADDRESS");
  const polyAddressOverride =
    input.polyAddressOverride ?? readEnvValue("CLOB_POLY_ADDRESS_OVERRIDE");
  const effectiveAddressResult = resolveEffectivePolyAddress({
    derivedSignerAddress,
    signatureType,
    funderAddress,
    polyAddressOverride,
    logger: input.logger,
  });
  const configuredPublicKey = input.publicKey ?? readEnvValue("PUBLIC_KEY");
  const forceMismatch =
    input.forceMismatch ?? readEnvValue("FORCE_MISMATCH") === "true";
  const mismatchResult = evaluatePublicKeyMismatch({
    configuredPublicKey,
    derivedSignerAddress,
    forceMismatch,
    logger: input.logger,
  });

  const signer = buildEffectiveSigner(
    wallet,
    effectiveAddressResult.effectivePolyAddress,
  );

  // Build credentials object from input if all fields are provided
  const buildInputCreds = (): ApiKeyCreds | undefined => {
    if (input.apiKey && input.apiSecret && input.apiPassphrase) {
      return {
        key: input.apiKey,
        secret: input.apiSecret,
        passphrase: input.apiPassphrase,
      };
    }
    return undefined;
  };

  let creds: ApiKeyCreds | undefined = buildInputCreds();
  const providedCreds = creds; // Store original user-provided credentials for diagnostics
  let providedCredsValid = false;
  if (creds) {
    // Verify provided credentials before accepting them
    input.logger?.info(
      "[CLOB] User-provided API credentials detected; verifying before use...",
    );
    try {
      providedCredsValid = await verifyCredsWithClient(
        creds,
        wallet,
        input.logger,
      );
      if (providedCredsValid) {
        input.logger?.info(
          "[CLOB] User-provided API credentials verified successfully.",
        );
      } else {
        input.logger?.warn(
          "[CLOB] User-provided API credentials failed verification (401/403).",
        );
        input.logger?.warn(
          "[CLOB] Your POLYMARKET_API_KEY, POLYMARKET_API_SECRET, or POLYMARKET_API_PASSPHRASE may be incorrect or expired.",
        );
        input.logger?.warn(
          "[CLOB] To regenerate credentials: visit https://polymarket.com/settings/api",
        );
        if (input.deriveApiKey) {
          input.logger?.info(
            "[CLOB] Will attempt to derive new credentials as fallback.",
          );
          creds = undefined; // Clear invalid credentials to trigger derive
        } else {
          input.logger?.warn(
            "[CLOB] Derive mode disabled; continuing with provided credentials (may fail).",
          );
        }
      }
    } catch (verifyErr) {
      // Transient error during verification (e.g., network timeout, ECONNRESET)
      // Since this is not a definitive 401/403, optimistically use provided credentials.
      // The preflight check will validate them again and switch to detect-only if they fail.
      input.logger?.warn(
        `[CLOB] Credential verification encountered transient error; using provided credentials. ${sanitizeErrorMessage(verifyErr)}`,
      );
      providedCredsValid = true;
    }
  }
  // Derive if user credentials are missing OR if they failed verification
  const deriveEnabled = Boolean(input.deriveApiKey) && !creds;

  if (input.logger && !polyAddressDiagLogged) {
    // Determine auth mode for logging
    let authMode = "NONE";
    if (providedCreds && !deriveEnabled) {
      authMode = "MODE_A_EXPLICIT";
    } else if (deriveEnabled) {
      authMode = "MODE_B_DERIVED";
    }
    if (
      signatureType === SignatureType.POLY_PROXY ||
      signatureType === SignatureType.POLY_GNOSIS_SAFE
    ) {
      authMode += "_MODE_C_PROXY";
    }

    input.logger.info(
      `[CLOB][Auth] mode=${authMode} signatureType=${signatureType ?? "default(0)"} signerAddress=${derivedSignerAddress} funderAddress=${funderAddress ?? "none"} effectivePolyAddress=${effectiveAddressResult.effectivePolyAddress}`,
    );
    polyAddressDiagLogged = true;
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
  let deriveFailed = false;
  let deriveError: string | undefined;
  if (deriveEnabled) {
    try {
      const derived = await deriveApiCreds(wallet, input.logger);
      if (derived?.key && derived?.secret && derived?.passphrase) {
        creds = derived;
        derivedCreds = derived;
        const { apiKeyDigest, keyIdSuffix } = getApiKeyDiagnostics(derived.key);
        input.logger?.info(
          `[CLOB] derived creds derivedKeyDigest=${apiKeyDigest} derivedKeySuffix=${keyIdSuffix}`,
        );
      } else {
        deriveFailed = true;
        deriveError = "Derived credentials incomplete or missing";
      }
    } catch (err) {
      deriveFailed = true;
      deriveError = sanitizeErrorMessage(err);
      input.logger?.warn(
        `[CLOB] Failed to derive API creds: ${deriveError}`,
      );
    }
  }

  const resolvedSignatureType = (
    client as ClobClient & { orderBuilder?: { signatureType?: number } }
  ).orderBuilder?.signatureType;
  const resolvedFunderAddress = (
    client as ClobClient & { orderBuilder?: { funderAddress?: string } }
  ).orderBuilder?.funderAddress;
  const makerAddress =
    effectiveAddressResult.effectivePolyAddress ??
    derivedSignerAddress ??
    "n/a";
  const credentialMode: "explicit" | "derived" | "none" = creds
    ? deriveEnabled
      ? "derived"
      : "explicit"
    : "none";
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
  logAuthFundsDiagnostics({
    logger: input.logger,
    derivedSignerAddress,
    configuredPublicKey,
    effectivePolyAddress: effectiveAddressResult.effectivePolyAddress,
    signatureType: resolvedSignatureType ?? signatureType,
    funderAddress: resolvedFunderAddress ?? funderAddress,
    credentialMode,
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
    deriveFailed,
    deriveError,
  });
}
