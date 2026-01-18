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

/**
 * Result of credential verification with signature type auto-detection
 */
type VerifyCredsResult = {
  valid: boolean;
  signatureType: number;
};

/**
 * All signature types to try in order when auto-detecting.
 * The bot will try each one until it finds one that works.
 * 
 * Order rationale (by likelihood for typical users):
 * 1. EOA (0): Most common - standard externally owned account wallet
 * 2. POLY_GNOSIS_SAFE (2): Second most common - created when users log in via browser
 * 3. POLY_PROXY (1): Least common - older Polymarket proxy wallet format
 */
const ALL_SIGNATURE_TYPES = [
  SignatureType.EOA,              // 0 - Standard EOA wallet (most common)
  SignatureType.POLY_GNOSIS_SAFE, // 2 - Gnosis Safe (browser login creates this)
  SignatureType.POLY_PROXY,       // 1 - Polymarket proxy wallet (legacy)
];

const SERVER_TIME_SKEW_THRESHOLD_SECONDS = 30;
let polyAddressDiagLogged = false;
let cachedDerivedCreds: ApiKeyCreds | null = null;
let clockSkewLogged = false;
let credDerivationAttempted = false;

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
      if (!clockSkewLogged) {
        logger?.warn("[CLOB] Unable to parse server time; using local clock.");
        clockSkewLogged = true;
      }
      return;
    }
    const localSeconds = Math.floor(Date.now() / 1000);
    const skewSeconds = Math.abs(serverSeconds - localSeconds);
    if (skewSeconds >= SERVER_TIME_SKEW_THRESHOLD_SECONDS) {
      (client as ClobClient & { useServerTime?: boolean }).useServerTime = true;
      if (!clockSkewLogged) {
        logger?.warn(
          `[CLOB] Clock skew ${skewSeconds}s detected; enabling server time for signatures.`,
        );
        clockSkewLogged = true;
      }
      return;
    }
    if (!clockSkewLogged) {
      logger?.info(`[CLOB] Clock skew ${skewSeconds}s; using local clock.`);
      clockSkewLogged = true;
    }
  } catch (err) {
    if (!clockSkewLogged) {
      logger?.warn(
        `[CLOB] Failed to fetch server time; using local clock. ${sanitizeErrorMessage(err)}`,
      );
      clockSkewLogged = true;
    }
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
  signatureType: number = SignatureType.EOA,
): Promise<boolean> => {
  try {
    const verifyClient = new ClobClient(
      POLYMARKET_API.BASE_URL,
      Chain.POLYGON,
      wallet,
      creds,
      signatureType,
    );
    const response = await verifyClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    // The clob-client returns error objects instead of throwing on HTTP errors
    // Check if response indicates an error
    const errorResponse = response as ClobErrorResponse;
    if (errorResponse.status === 401 || errorResponse.status === 403) {
      logger?.warn(
        `[CLOB] Credential verification failed (sigType=${signatureType}): ${errorResponse.status} ${errorResponse.error ?? "Unauthorized/Invalid api key"}`,
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
        `[CLOB] Credential verification failed (sigType=${signatureType}): ${status} Unauthorized/Invalid api key`,
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

/**
 * Try to verify credentials with ALL signature types automatically.
 * Returns the first signature type that works, or undefined if none work.
 * This allows the bot to auto-detect whether the wallet uses EOA, Proxy, or Gnosis Safe.
 */
const verifyCredsWithAutoSignatureType = async (
  creds: ApiKeyCreds,
  wallet: Wallet,
  logger?: Logger,
  preferredSignatureType?: number,
): Promise<VerifyCredsResult | undefined> => {
  // Build list of signature types to try, with preferred type first if specified
  const typesToTry = preferredSignatureType !== undefined
    ? [preferredSignatureType, ...ALL_SIGNATURE_TYPES.filter(t => t !== preferredSignatureType)]
    : ALL_SIGNATURE_TYPES;

  const signatureTypeLabel = (sigType: number): string => {
    switch (sigType) {
      case SignatureType.EOA: return "EOA";
      case SignatureType.POLY_PROXY: return "Proxy";
      case SignatureType.POLY_GNOSIS_SAFE: return "Gnosis Safe";
      default: return `Unknown(${sigType})`;
    }
  };

  logger?.info(
    `[CLOB] Auto-detecting signature type (trying: ${typesToTry.map(t => `${t}=${signatureTypeLabel(t)}`).join(", ")})...`,
  );

  for (const sigType of typesToTry) {
    try {
      logger?.debug(`[CLOB] Trying signature type ${sigType} (${signatureTypeLabel(sigType)})...`);
      const isValid = await verifyCredsWithClient(creds, wallet, logger, sigType);
      if (isValid) {
        logger?.info(
          `[CLOB] ✅ Auto-detected signature type: ${sigType} (${signatureTypeLabel(sigType)})`,
        );
        return { valid: true, signatureType: sigType };
      }
    } catch (error) {
      // Transient error, continue to next signature type
      logger?.debug(
        `[CLOB] Verification with sigType=${sigType} encountered transient error: ${sanitizeErrorMessage(error)}`,
      );
    }
  }

  // None of the signature types worked
  logger?.error(
    `[CLOB] ❌ Credential verification failed with ALL signature types (tried: ${typesToTry.map(t => `${t}=${signatureTypeLabel(t)}`).join(", ")})`,
  );
  logger?.error(
    `[CLOB] This usually means the wallet has never traded on Polymarket. Visit ${POLYMARKET_API.WEBSITE_URL}, connect your wallet, and make at least one trade.`,
  );
  return undefined;
};

/**
 * Result of credential derivation including auto-detected signature type
 */
type DeriveCredsResult = {
  creds: ApiKeyCreds;
  signatureType: number;
};

// Cache for detected signature type
let cachedSignatureType: number | undefined;

const deriveApiCreds = async (
  wallet: Wallet,
  logger?: Logger,
): Promise<DeriveCredsResult | undefined> => {
  const signerAddress = await wallet.getAddress();

  // Return cached credentials if we already have them
  if (cachedDerivedCreds) {
    if (!credDerivationAttempted) {
      logger?.info("[CLOB] Using in-memory cached derived credentials.");
    }
    return { 
      creds: cachedDerivedCreds, 
      signatureType: cachedSignatureType ?? SignatureType.EOA 
    };
  }

  // Skip if we've already tried and failed
  if (credDerivationAttempted) {
    return undefined;
  }
  credDerivationAttempted = true;

  const diskCached = loadCachedCreds({ signerAddress, logger });
  if (diskCached) {
    // Verify cached credentials before using them - try all signature types
    logger?.info("[CLOB] Verifying disk-cached credentials...");
    try {
      const verifyResult = await verifyCredsWithAutoSignatureType(diskCached, wallet, logger);
      if (verifyResult?.valid) {
        cachedDerivedCreds = diskCached;
        cachedSignatureType = verifyResult.signatureType;
        logger?.info(
          "[CLOB] Using disk-cached derived credentials (verified).",
        );
        return { creds: diskCached, signatureType: verifyResult.signatureType };
      } else {
        // Cached credentials are invalid with all signature types, clear cache and retry
        logger?.warn(
          "[CLOB] Cached credentials invalid; clearing cache and retrying derive.",
        );
        const { clearCachedCreds } =
          await import("../utils/credential-storage.util");
        clearCachedCreds(logger);
        cachedDerivedCreds = null;
        cachedSignatureType = undefined;
        // Fall through to derive new credentials
      }
    } catch (error) {
      // Verification error (not 401/403), treat as transient and use cached creds
      logger?.warn(
        "[CLOB] Credential verification error; using cached credentials anyway.",
      );
      cachedDerivedCreds = diskCached;
      return { creds: diskCached, signatureType: cachedSignatureType ?? SignatureType.EOA };
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
    createApiKey?: () => Promise<ApiKeyCreds>;
  };

  // Helper to verify and cache credentials - tries all signature types
  const verifyAndCacheCreds = async (
    derived: ApiKeyCreds,
    source: string,
  ): Promise<DeriveCredsResult | undefined> => {
    // Validate response contains valid credentials before marking success
    if (!derived || !derived.key || !derived.secret || !derived.passphrase) {
      logger?.error(
        `[CLOB] ${source} API key creation returned incomplete credentials (missing key/secret/passphrase) - credentials NOT saved`,
      );
      return undefined;
    }

    // Verify derived credentials work before caching them - try ALL signature types
    logger?.info(`[CLOB] Verifying newly derived credentials from ${source}...`);
    try {
      const verifyResult = await verifyCredsWithAutoSignatureType(derived, wallet, logger);
      if (!verifyResult?.valid) {
        logger?.warn(
          `[CLOB] Derived credentials failed verification (401/403). The wallet has never traded on Polymarket or there's an account issue.`,
        );
        return undefined;
      }
      logger?.info(`[CLOB] Derived credentials verified successfully.`);
      
      // Valid credentials received and verified, save and return
      cachedDerivedCreds = derived;
      cachedSignatureType = verifyResult.signatureType;
      saveCachedCreds({ creds: derived, signerAddress, logger });
      logger?.info(`[CLOB] Successfully created/derived API credentials via ${source}.`);
      return { creds: derived, signatureType: verifyResult.signatureType };
    } catch (verifyError) {
      // Verification encountered a transient error (network, etc.)
      // In this case, we'll optimistically cache the credentials and let
      // the preflight check handle verification later
      logger?.warn(
        `[CLOB] Credential verification encountered transient error; caching anyway. ${sanitizeErrorMessage(verifyError)}`,
      );
      cachedDerivedCreds = derived;
      saveCachedCreds({ creds: derived, signerAddress, logger });
      logger?.info(`[CLOB] Successfully created/derived API credentials via ${source}.`);
      return { creds: derived, signatureType: SignatureType.EOA };
    }
  };

  // Strategy: Try deriveApiKey first (for existing wallets), then createApiKey
  // This is the opposite of what createOrDeriveApiKey does, but it's more reliable
  // because deriveApiKey works for wallets that have already traded on Polymarket
  // See: https://github.com/Polymarket/py-clob-client/issues/187

  // Step 1: Try deriveApiKey first (works for wallets with existing API keys)
  if (deriveFn.deriveApiKey) {
    try {
      logger?.info(
        "[CLOB] Attempting to derive existing API credentials from server...",
      );
      const derived = await deriveFn.deriveApiKey();
      const result = await verifyAndCacheCreds(derived, "deriveApiKey");
      if (result) {
        return result;
      }
      // If verification failed, continue to try createApiKey
      logger?.info(
        "[CLOB] deriveApiKey credentials didn't verify; trying createApiKey...",
      );
    } catch (deriveError) {
      const deriveStatus = (
        deriveError as { response?: { status?: number } }
      )?.response?.status;
      const deriveMsg = extractDeriveErrorMessage(deriveError);
      logger?.info(
        `[CLOB] deriveApiKey failed (status=${deriveStatus ?? "unknown"}): ${deriveMsg || "unknown error"}`,
      );
      // Continue to try createApiKey
    }
  }

  // Step 2: Try createApiKey (for new wallets or if derive failed)
  try {
    logger?.info("[CLOB] Attempting to create new API credentials...");
    if (deriveFn.createApiKey) {
      const created = await deriveFn.createApiKey();
      const result = await verifyAndCacheCreds(created, "createApiKey");
      if (result) {
        return result;
      }
    }
  } catch (createError) {
    const status = (createError as { response?: { status?: number } })
      ?.response?.status;
    const responseData = (createError as { response?: { data?: unknown } })
      ?.response?.data;
    const errorDetails = extractDeriveErrorMessage(createError) || "unknown error";
    logger?.info(
      `[CLOB] createApiKey failed (status=${status ?? "unknown"}): error=${errorDetails} - credentials NOT saved`,
    );
    if (responseData) {
      logger?.debug(`[CLOB] Response data: ${JSON.stringify(responseData)}`);
    }

    // If createApiKey failed with "Could not create api key", the wallet may need
    // to interact with Polymarket first
    if (canDetectCreateApiKeyFailure(createError)) {
      logger?.error(
        "[CLOB] =====================================================================",
      );
      logger?.error(
        "[CLOB] API KEY CREATION FAILED: Server cannot create credentials for this wallet",
      );
      logger?.error(
        "[CLOB] =====================================================================",
      );
      logger?.error(
        "[CLOB] Both deriveApiKey and createApiKey failed. Possible causes:",
      );
      logger?.error(
        "[CLOB]   - The wallet has never interacted with Polymarket",
      );
      logger?.error(
        "[CLOB]   - The wallet needs to enable trading on polymarket.com first",
      );
      logger?.error("[CLOB] ");
      logger?.error("[CLOB] TO FIX THIS:");
      logger?.error(
        "[CLOB]   1. Visit https://polymarket.com and connect this wallet",
      );
      logger?.error(
        "[CLOB]   2. Enable trading and make a small test trade on any market",
      );
      logger?.error(
        "[CLOB]   3. Wait a few minutes for the transaction to confirm",
      );
      logger?.error("[CLOB]   4. Restart this bot");
      logger?.error(
        "[CLOB] =====================================================================",
      );
    }
  }

  // Step 3: As last resort, try the combined createOrDeriveApiKey
  try {
    logger?.info(
      "[CLOB] Attempting createOrDeriveApiKey as final fallback...",
    );
    const combined = deriveFn.createOrDeriveApiKey
      ? await deriveFn.createOrDeriveApiKey()
      : undefined;
    if (combined) {
      const result = await verifyAndCacheCreds(combined, "createOrDeriveApiKey");
      if (result) {
        return result;
      }
    }
  } catch (combinedError) {
    const combinedMsg = extractDeriveErrorMessage(combinedError);
    logger?.warn(
      `[CLOB] createOrDeriveApiKey fallback failed: ${combinedMsg || "unknown error"}`,
    );
  }

  logger?.error(
    "[CLOB] All credential derivation methods failed. Bot will run in detect-only mode.",
  );
  return undefined;
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
  let detectedSignatureType: number | undefined;
  
  if (creds) {
    // Verify provided credentials before accepting them - try ALL signature types
    input.logger?.info(
      "[CLOB] User-provided API credentials detected; verifying with auto-detection of signature type...",
    );
    try {
      const verifyResult = await verifyCredsWithAutoSignatureType(
        creds,
        wallet,
        input.logger,
        signatureType, // Try user-configured signature type first if provided
      );
      if (verifyResult?.valid) {
        providedCredsValid = true;
        detectedSignatureType = verifyResult.signatureType;
        input.logger?.info(
          "[CLOB] User-provided API credentials verified successfully.",
        );
      } else {
        input.logger?.warn(
          "[CLOB] User-provided API credentials failed verification with all signature types.",
        );
        input.logger?.warn(
          "[CLOB] Your POLYMARKET_API_KEY, POLYMARKET_API_SECRET, or POLYMARKET_API_PASSPHRASE may be incorrect or expired.",
        );
        input.logger?.warn(
          "[CLOB] To regenerate credentials: set CLOB_DERIVE_CREDS=true",
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
      `[CLOB][Auth] mode=${authMode} signatureType=${signatureType ?? "default(0)/auto-detect"} signerAddress=${derivedSignerAddress} funderAddress=${funderAddress ?? "none"} effectivePolyAddress=${effectiveAddressResult.effectivePolyAddress}`,
    );
    polyAddressDiagLogged = true;
  }

  // Create a temporary client to check server time (doesn't require auth)
  const tempClient = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    signer,
    undefined, // No creds needed for server time
    SignatureType.EOA,
  );
  await maybeEnableServerTime(tempClient, input.logger);

  let derivedCreds: ApiKeyCreds | undefined;
  let deriveFailed = false;
  let deriveError: string | undefined;
  if (deriveEnabled) {
    try {
      const deriveResult = await deriveApiCreds(wallet, input.logger);
      if (deriveResult?.creds?.key && deriveResult?.creds?.secret && deriveResult?.creds?.passphrase) {
        creds = deriveResult.creds;
        derivedCreds = deriveResult.creds;
        detectedSignatureType = deriveResult.signatureType;
        const { apiKeyDigest, keyIdSuffix } = getApiKeyDiagnostics(deriveResult.creds.key);
        input.logger?.info(
          `[CLOB] derived creds derivedKeyDigest=${apiKeyDigest} derivedKeySuffix=${keyIdSuffix} signatureType=${deriveResult.signatureType}`,
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

  // Use detected signature type if available, otherwise use configured/default
  const effectiveSignatureType = detectedSignatureType ?? signatureType ?? SignatureType.EOA;
  
  // Log if signature type was auto-detected
  if (detectedSignatureType !== undefined && detectedSignatureType !== signatureType) {
    input.logger?.info(
      `[CLOB] Using auto-detected signature type ${effectiveSignatureType} instead of configured ${signatureType ?? 0}`,
    );
  }

  // Create the final client with the effective signature type and credentials
  const client = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    signer,
    creds,
    effectiveSignatureType,
    funderAddress,
  );

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
    signatureType: resolvedSignatureType ?? effectiveSignatureType,
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
    signatureType: resolvedSignatureType ?? effectiveSignatureType,
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
