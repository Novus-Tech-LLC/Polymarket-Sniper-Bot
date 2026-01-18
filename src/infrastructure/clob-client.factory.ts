import { JsonRpcProvider, JsonRpcSigner, Wallet } from "ethers";
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
import {
  loadL1AuthConfig,
  logL1AuthDiagnostics,
} from "../utils/l1-auth-headers.util";
import { deriveCredentialsWithFallback } from "../clob/credential-derivation-v2";
import { logAuthIdentity } from "../clob/identity-resolver";

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
 * Type guard to check if a response is a CLOB error response
 */
function isClobErrorResponse(response: unknown): response is ClobErrorResponse {
  if (!response || typeof response !== "object") {
    return false;
  }
  const obj = response as Record<string, unknown>;
  return (
    (typeof obj.status === "number" && obj.status >= 400) ||
    (typeof obj.error === "string" && obj.error.length > 0)
  );
}

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
  SignatureType.EOA, // 0 - Standard EOA wallet (most common)
  SignatureType.POLY_GNOSIS_SAFE, // 2 - Gnosis Safe (browser login creates this)
  SignatureType.POLY_PROXY, // 1 - Polymarket proxy wallet (legacy)
];

const SERVER_TIME_SKEW_THRESHOLD_SECONDS = 30;
let polyAddressDiagLogged = false;
let cachedDerivedCreds: ApiKeyCreds | null = null;
let clockSkewLogged = false;
let credDerivationAttempted = false;

const readEnvValue = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const readSignatureType = (): number | undefined => {
  // Try new names first, then fall back to old names
  const value =
    readEnvValue("POLYMARKET_SIGNATURE_TYPE") ??
    readEnvValue("CLOB_SIGNATURE_TYPE");
  return parseSignatureType(value);
};

const readFunderAddress = (): string | undefined => {
  // Try new names first, then fall back to old names
  return (
    readEnvValue("POLYMARKET_PROXY_ADDRESS") ??
    readEnvValue("CLOB_FUNDER_ADDRESS")
  );
};

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
      client as ClobClient & { signer?: Wallet | JsonRpcSigner }
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
  const typesToTry =
    preferredSignatureType !== undefined
      ? [
          preferredSignatureType,
          ...ALL_SIGNATURE_TYPES.filter((t) => t !== preferredSignatureType),
        ]
      : ALL_SIGNATURE_TYPES;

  const signatureTypeLabel = (sigType: number): string => {
    switch (sigType) {
      case SignatureType.EOA:
        return "EOA";
      case SignatureType.POLY_PROXY:
        return "Proxy";
      case SignatureType.POLY_GNOSIS_SAFE:
        return "Gnosis Safe";
      default:
        return `Unknown(${sigType})`;
    }
  };

  logger?.info(
    `[CLOB] Auto-detecting signature type (trying: ${typesToTry.map((t) => `${t}=${signatureTypeLabel(t)}`).join(", ")})...`,
  );

  for (const sigType of typesToTry) {
    try {
      logger?.debug(
        `[CLOB] Trying signature type ${sigType} (${signatureTypeLabel(sigType)})...`,
      );
      const isValid = await verifyCredsWithClient(
        creds,
        wallet,
        logger,
        sigType,
      );
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
    `[CLOB] ❌ Credential verification failed with ALL signature types (tried: ${typesToTry.map((t) => `${t}=${signatureTypeLabel(t)}`).join(", ")})`,
  );
  logger?.error(
    `[CLOB] This usually means the wallet has never traded on Polymarket. Visit ${POLYMARKET_API.WEBSITE_URL}, connect your wallet, and make at least one trade.`,
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
  const provider = new JsonRpcProvider(input.rpcUrl);
  const wallet = new Wallet(input.privateKey, provider);
  setupClobHeaderKeyLogging(input.logger);

  const derivedSignerAddress = resolveDerivedSignerAddress(input.privateKey);
  const signatureType = parseSignatureType(
    input.signatureType ?? readSignatureType(),
  );
  const funderAddress = input.funderAddress ?? readFunderAddress();

  // Safety check: if signature_type is 1 or 2, funder address is required
  if (signatureType === 1 || signatureType === 2) {
    if (!funderAddress) {
      const errorMsg = `[CLOB] FATAL: signature_type=${signatureType} requires POLYMARKET_PROXY_ADDRESS (or CLOB_FUNDER_ADDRESS) to be set. This is the Polymarket proxy wallet/deposit address (maker/funder), not the EOA signer address.`;
      input.logger?.error(errorMsg);
      input.logger?.error(
        "[CLOB] For browser wallets: Set POLYMARKET_SIGNATURE_TYPE=2 AND POLYMARKET_PROXY_ADDRESS=<your-proxy-wallet-address>",
      );
      input.logger?.error(
        "[CLOB] The signer (PRIVATE_KEY) remains your EOA, but maker/funder must be the proxy address.",
      );
      throw new Error(errorMsg);
    }
    input.logger?.info(
      `[CLOB] Using signature_type=${signatureType} with funder/proxy address=${funderAddress}`,
    );
  }

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
    }
  }
  // Derive if user credentials are missing OR if they failed verification
  const deriveEnabled = Boolean(input.deriveApiKey) && !creds;

  // Load L1 authentication configuration
  const l1AuthConfig = loadL1AuthConfig();

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

    // Determine wallet mode for clarity
    const walletMode =
      signatureType === SignatureType.EOA || signatureType === undefined
        ? "EOA (direct wallet)"
        : signatureType === SignatureType.POLY_PROXY
          ? "Proxy Wallet"
          : "Gnosis Safe";

    input.logger.info(
      `[CLOB][Auth] mode=${authMode} signatureType=${signatureType ?? "default(0)/auto-detect"} walletMode="${walletMode}" signerAddress=${derivedSignerAddress} funderAddress=${funderAddress ?? "none"} effectivePolyAddress=${effectiveAddressResult.effectivePolyAddress}`,
    );

    // Add clarity log for proxy/safe mode
    if (
      signatureType === SignatureType.POLY_PROXY ||
      signatureType === SignatureType.POLY_GNOSIS_SAFE
    ) {
      input.logger.info(
        `[CLOB][Auth] Using ${walletMode}: signer=${derivedSignerAddress} (EOA for signing), maker/funder=${funderAddress} (proxy for orders)`,
      );
    }

    // Log L1 authentication configuration
    logL1AuthDiagnostics(
      l1AuthConfig,
      derivedSignerAddress,
      effectiveAddressResult.effectivePolyAddress,
      input.logger,
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
  let derivationResult: Awaited<
    ReturnType<typeof deriveCredentialsWithFallback>
  > | null = null;

  if (deriveEnabled) {
    try {
      // Read and validate optional overrides from environment
      const forceWalletModeRaw = process.env.CLOB_FORCE_WALLET_MODE;
      const forceL1AuthRaw = process.env.CLOB_FORCE_L1_AUTH;

      // Validate CLOB_FORCE_WALLET_MODE
      let forceWalletMode: "auto" | "eoa" | "safe" | "proxy" | undefined;
      if (forceWalletModeRaw) {
        const validModes = ["auto", "eoa", "safe", "proxy"];
        if (validModes.includes(forceWalletModeRaw)) {
          forceWalletMode = forceWalletModeRaw as
            | "auto"
            | "eoa"
            | "safe"
            | "proxy";
        } else {
          input.logger?.warn(
            `[CLOB] Invalid CLOB_FORCE_WALLET_MODE="${forceWalletModeRaw}". Must be one of: ${validModes.join(", ")}. Ignoring.`,
          );
        }
      }

      // Validate CLOB_FORCE_L1_AUTH
      let forceL1Auth: "auto" | "signer" | "effective" | undefined;
      if (forceL1AuthRaw) {
        const validAuth = ["auto", "signer", "effective"];
        if (validAuth.includes(forceL1AuthRaw)) {
          forceL1Auth = forceL1AuthRaw as "auto" | "signer" | "effective";
        } else {
          input.logger?.warn(
            `[CLOB] Invalid CLOB_FORCE_L1_AUTH="${forceL1AuthRaw}". Must be one of: ${validAuth.join(", ")}. Ignoring.`,
          );
        }
      }

      derivationResult = await deriveCredentialsWithFallback({
        privateKey: input.privateKey,
        signatureType,
        funderAddress,
        forceWalletMode,
        forceL1Auth,
        logger: input.logger,
      });

      if (derivationResult.success && derivationResult.creds) {
        creds = derivationResult.creds;
        derivedCreds = derivationResult.creds;
        detectedSignatureType = derivationResult.signatureType;

        const { apiKeyDigest, keyIdSuffix } = getApiKeyDiagnostics(
          derivationResult.creds.key,
        );
        input.logger?.info(
          `[CLOB] derived creds derivedKeyDigest=${apiKeyDigest} derivedKeySuffix=${keyIdSuffix} signatureType=${derivationResult.signatureType}`,
        );

        // Log the auth identity that worked
        if (derivationResult.orderIdentity && derivationResult.l1AuthIdentity) {
          logAuthIdentity({
            orderIdentity: derivationResult.orderIdentity,
            l1AuthIdentity: derivationResult.l1AuthIdentity,
            signerAddress: derivedSignerAddress,
            logger: input.logger,
          });
        }
      } else {
        deriveFailed = true;
        deriveError =
          derivationResult.error ?? "Derived credentials incomplete or missing";
      }
    } catch (err) {
      deriveFailed = true;
      deriveError = sanitizeErrorMessage(err);
      input.logger?.warn(`[CLOB] Failed to derive API creds: ${deriveError}`);
    }
  }

  // Use detected signature type if available, otherwise use configured/default
  const effectiveSignatureType =
    detectedSignatureType ?? signatureType ?? SignatureType.EOA;

  // Log if signature type was auto-detected
  if (
    detectedSignatureType !== undefined &&
    detectedSignatureType !== signatureType
  ) {
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
