/**
 * Polymarket Authentication Module
 *
 * Implements a clean, simple authentication flow following pmxt's methodology:
 * 1. Try to DERIVE existing credentials first (most common case)
 * 2. If derivation fails (404/400), try to CREATE new credentials
 * 3. Cache credentials for reuse
 *
 * This approach is simpler and more reliable than complex fallback ladders.
 *
 * @see https://github.com/pmxt-dev/pmxt/blob/main/core/src/exchanges/polymarket/auth.ts
 */

import { ClobClient, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet, JsonRpcProvider } from "ethers";
import { SignatureType } from "@polymarket/order-utils";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { Logger } from "../utils/logger.util";
import { asClobSigner } from "../utils/clob-signer.util";

const POLYMARKET_HOST = POLYMARKET_API.BASE_URL;
const POLYGON_CHAIN_ID = Chain.POLYGON;

/**
 * Credentials configuration for PolymarketAuth
 */
export interface PolymarketCredentials {
  /** Private key for wallet authentication (required) */
  privateKey: string;
  /** RPC URL for blockchain interactions (optional, but recommended for balance/approval checks) */
  rpcUrl?: string;
  /** Pre-configured API key (optional - will derive if not provided) */
  apiKey?: string;
  /** Pre-configured API secret (optional - will derive if not provided) */
  apiSecret?: string;
  /** Pre-configured API passphrase (optional - will derive if not provided) */
  passphrase?: string;
  /** Signature type: 0=EOA, 1=Proxy, 2=GnosisSafe (default: 0) */
  signatureType?: number;
  /** Funder address for Proxy/Safe modes (optional) */
  funderAddress?: string;
  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * Result of authentication attempt
 */
export interface AuthResult {
  /** Whether authentication succeeded */
  success: boolean;
  /** API credentials if successful */
  creds?: ApiKeyCreds;
  /** Detected or configured signature type */
  signatureType: number;
  /** Error message if failed */
  error?: string;
  /** Whether credentials were derived (vs provided) */
  derived: boolean;
}

/**
 * Manages Polymarket authentication and CLOB client initialization.
 * Handles both L1 (wallet-based) and L2 (API credentials) authentication.
 *
 * Following pmxt's clean, simple approach:
 * - Try deriveApiKey() first (for existing wallets)
 * - Fall back to createApiKey() if derivation fails
 * - Cache credentials for efficiency
 */
export class PolymarketAuth {
  private credentials: PolymarketCredentials;
  private signer: Wallet;
  private clobClient?: ClobClient;
  private cachedClientWithWallet?: ClobClient & { wallet: Wallet };
  private apiCreds?: ApiKeyCreds;
  private logger?: Logger;
  private effectiveSignatureType: number;

  constructor(credentials: PolymarketCredentials) {
    if (!credentials.privateKey) {
      throw new Error("Polymarket requires a privateKey for authentication");
    }

    this.credentials = credentials;
    this.logger = credentials.logger;
    this.effectiveSignatureType =
      credentials.signatureType ?? SignatureType.EOA;

    // Initialize the signer with provider if RPC URL is provided
    const privateKey = credentials.privateKey.startsWith("0x")
      ? credentials.privateKey
      : `0x${credentials.privateKey}`;

    if (credentials.rpcUrl) {
      const provider = new JsonRpcProvider(credentials.rpcUrl);
      this.signer = new Wallet(privateKey, provider);
      this.log(
        "debug",
        `PolymarketAuth initialized with provider: address=${this.signer.address}`,
      );
    } else {
      this.signer = new Wallet(privateKey);
      this.log(
        "warn",
        `PolymarketAuth initialized without provider - balance/approval checks will fail`,
      );
    }

    this.log(
      "info",
      `PolymarketAuth initialized: address=${this.signer.address} signatureType=${this.effectiveSignatureType}`,
    );
  }

  /**
   * Get or create API credentials using L1 authentication.
   * This uses the private key to derive/create API credentials.
   *
   * Strategy (following pmxt):
   * 1. Return cached credentials if available
   * 2. Return user-provided credentials if configured
   * 3. Otherwise, derive/create using L1 auth
   */
  async getApiCredentials(): Promise<ApiKeyCreds> {
    // Return cached credentials if available
    if (this.apiCreds) {
      this.log("debug", "Returning cached API credentials");
      return this.apiCreds;
    }

    // If credentials were provided explicitly, use them
    if (
      this.credentials.apiKey &&
      this.credentials.apiSecret &&
      this.credentials.passphrase
    ) {
      this.log("info", "Using user-provided API credentials");
      this.apiCreds = {
        key: this.credentials.apiKey,
        secret: this.credentials.apiSecret,
        passphrase: this.credentials.passphrase,
      };
      return this.apiCreds;
    }

    // Otherwise, derive/create them using L1 auth
    this.log("info", "Deriving API credentials via L1 authentication...");

    const l1Client = new ClobClient(
      POLYMARKET_HOST,
      POLYGON_CHAIN_ID,
      asClobSigner(this.signer),
    );

    // Robust derivation strategy (from pmxt):
    // 1. Try to DERIVE existing credentials first (most common case)
    // 2. If that fails (e.g. 404 or 400), try to CREATE new ones

    let creds: ApiKeyCreds | undefined;

    try {
      this.log("debug", "Attempting deriveApiKey()...");
      creds = await l1Client.deriveApiKey();
      this.log("info", "Successfully derived existing API key");
    } catch (deriveError: unknown) {
      const deriveErr = deriveError as {
        response?: { status?: number };
        message?: string;
      };
      const status = deriveErr?.response?.status;
      this.log(
        "debug",
        `deriveApiKey() failed (status=${status ?? "unknown"}): ${deriveErr?.message ?? "unknown error"}`,
      );

      // Try to create new credentials
      this.log("debug", "Attempting createApiKey()...");
      try {
        creds = await l1Client.createApiKey();
        this.log("info", "Successfully created new API key");
      } catch (createError: unknown) {
        const createErr = createError as {
          response?: { status?: number };
          message?: string;
        };
        const createStatus = createErr?.response?.status;
        const message = createErr?.message ?? String(createError);

        // Check for "could not create api key" error - means wallet hasn't traded
        if (
          createStatus === 400 &&
          message.toLowerCase().includes("could not create api key")
        ) {
          const errorMsg =
            "Authentication failed: Wallet has never traded on Polymarket. " +
            "Please visit https://polymarket.com, connect your wallet, and make at least one trade.";
          this.log("error", errorMsg);
          throw new Error(errorMsg);
        }

        this.log(
          "error",
          `createApiKey() failed (status=${createStatus ?? "unknown"}): ${message}`,
        );
        throw new Error(
          `Authentication failed: Could not create or derive API key. ${message}`,
        );
      }
    }

    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      throw new Error(
        "Authentication failed: Credentials are empty or incomplete.",
      );
    }

    this.apiCreds = creds;
    this.log("info", `API credentials obtained: key=...${creds.key.slice(-6)}`);
    return creds;
  }

  /**
   * Get an authenticated CLOB client for L2 operations (trading).
   * This client can place orders, cancel orders, query positions, etc.
   *
   * Returns a client with wallet attached for compatibility with existing code.
   * The returned client is cached and the same instance is returned on subsequent calls.
   */
  async getClobClient(): Promise<ClobClient & { wallet: Wallet }> {
    // Return cached wrapped client if available
    if (this.cachedClientWithWallet) {
      return this.cachedClientWithWallet;
    }

    // Get API credentials (L1 auth)
    const apiCreds = await this.getApiCredentials();

    // Determine funder address (defaults to signer's address for EOA)
    const funderAddress = this.credentials.funderAddress ?? this.signer.address;

    this.log(
      "debug",
      `Creating CLOB client: signatureType=${this.effectiveSignatureType} funderAddress=${funderAddress}`,
    );

    // Create L2-authenticated client
    this.clobClient = new ClobClient(
      POLYMARKET_HOST,
      POLYGON_CHAIN_ID,
      asClobSigner(this.signer),
      apiCreds,
      this.effectiveSignatureType,
      this.effectiveSignatureType !== SignatureType.EOA
        ? funderAddress
        : undefined,
    );

    // Create and cache wrapped client for consistency
    this.cachedClientWithWallet = Object.assign(this.clobClient, {
      wallet: this.signer,
    });
    return this.cachedClientWithWallet;
  }

  /**
   * Authenticate and return a complete AuthResult.
   * This is a higher-level method that handles the full auth flow.
   */
  async authenticate(): Promise<AuthResult> {
    try {
      const creds = await this.getApiCredentials();
      const derived = !this.credentials.apiKey;

      return {
        success: true,
        creds,
        signatureType: this.effectiveSignatureType,
        derived,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        signatureType: this.effectiveSignatureType,
        error: message,
        derived: !this.credentials.apiKey,
      };
    }
  }

  /**
   * Get the signer's address.
   */
  getAddress(): string {
    return this.signer.address;
  }

  /**
   * Get the effective signature type being used.
   */
  getSignatureType(): number {
    return this.effectiveSignatureType;
  }

  /**
   * Check if credentials are currently cached.
   */
  hasCredentials(): boolean {
    return Boolean(this.apiCreds);
  }

  /**
   * Reset cached credentials and client.
   * Useful for testing or credential rotation.
   */
  reset(): void {
    this.log("debug", "Resetting cached credentials and client");
    this.apiCreds = undefined;
    this.clobClient = undefined;
    this.cachedClientWithWallet = undefined;
  }

  /**
   * Internal logging helper
   */
  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    if (this.logger) {
      this.logger[level](`[PolymarketAuth] ${message}`);
    }
  }
}

/**
 * Create a PolymarketAuth instance from environment variables.
 * This is a convenience factory for common usage patterns.
 */
export function createPolymarketAuthFromEnv(logger?: Logger): PolymarketAuth {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "PRIVATE_KEY environment variable is required for Polymarket authentication",
    );
  }

  const rpcUrl = process.env.RPC_URL ?? process.env.rpc_url;
  const apiKey =
    process.env.POLYMARKET_API_KEY ??
    process.env.POLY_API_KEY ??
    process.env.CLOB_API_KEY;
  const apiSecret =
    process.env.POLYMARKET_API_SECRET ??
    process.env.POLY_SECRET ??
    process.env.CLOB_API_SECRET;
  const passphrase =
    process.env.POLYMARKET_API_PASSPHRASE ??
    process.env.POLY_PASSPHRASE ??
    process.env.CLOB_API_PASSPHRASE;
  const signatureTypeStr =
    process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
  const signatureType = signatureTypeStr
    ? parseInt(signatureTypeStr, 10)
    : undefined;
  const funderAddress =
    process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;

  return new PolymarketAuth({
    privateKey,
    rpcUrl,
    apiKey,
    apiSecret,
    passphrase,
    signatureType,
    funderAddress,
    logger,
  });
}
