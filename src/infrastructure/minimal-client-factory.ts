/**
 * Minimal CLOB Client Factory
 *
 * Simple client creation following the Python agents approach:
 * - No fallback ladders
 * - No signature type auto-detection
 * - No complex identity resolution
 * - Just calls createOrDeriveApiKey() like Python does
 *
 * Use this for new code. For legacy compatibility, use clob-client.factory.ts
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { Logger } from "../utils/logger.util";
import { authenticateMinimal } from "../clob/minimal-auth";
import { asClobSigner } from "../utils/clob-signer.util";

/**
 * Input configuration for creating a client
 */
export interface MinimalClientInput {
  rpcUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  deriveApiKey?: boolean;
  signatureType?: number; // 0=EOA, 1=Proxy, 2=GnosisSafe
  funderAddress?: string; // For Proxy/Safe modes
  logger?: Logger;
}

/**
 * Extended client with additional properties
 */
export interface MinimalClobClient extends ClobClient {
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

/**
 * Create a Polymarket CLOB client using minimal auth (Python agents style)
 *
 * This is the simplified approach:
 * 1. If credentials provided, use them
 * 2. If not, call createOrDeriveApiKey()
 * 3. Set credentials on client
 * 4. Return ready-to-use client
 */
export async function createMinimalPolymarketClient(
  input: MinimalClientInput,
): Promise<MinimalClobClient> {
  const logger = input.logger;

  // Create wallet
  const provider = new JsonRpcProvider(input.rpcUrl);
  const pk = input.privateKey.startsWith("0x")
    ? input.privateKey
    : `0x${input.privateKey}`;
  const wallet = new Wallet(pk, provider);
  const derivedSignerAddress = wallet.address;

  logger?.info(
    `[MinimalClient] Wallet: ${derivedSignerAddress.slice(0, 10)}...${derivedSignerAddress.slice(-6)}`,
  );

  // Determine effective Polymarket address
  // For EOA mode (signatureType=0 or undefined), effective = signer
  // For Proxy/Safe modes (signatureType=1 or 2), effective = funderAddress
  const effectivePolyAddress =
    input.signatureType === 1 || input.signatureType === 2
      ? input.funderAddress ?? derivedSignerAddress
      : derivedSignerAddress;

  let creds: ApiKeyCreds | undefined;
  let derivedCreds: ApiKeyCreds | undefined;
  let providedCreds: ApiKeyCreds | undefined;
  let deriveFailed = false;
  let deriveError: string | undefined;

  // Check if user provided credentials
  if (input.apiKey && input.apiSecret && input.apiPassphrase) {
    providedCreds = {
      key: input.apiKey,
      secret: input.apiSecret,
      passphrase: input.apiPassphrase,
    };
    creds = providedCreds;
    logger?.info("[MinimalClient] Using provided API credentials");
  }

  // Derive credentials if requested and not provided
  if (!creds && input.deriveApiKey !== false) {
    logger?.info("[MinimalClient] Deriving credentials (minimal auth)...");

    const authResult = await authenticateMinimal({
      privateKey: input.privateKey,
      signatureType: input.signatureType,
      funderAddress: input.funderAddress,
      logLevel: "info",
    });

    if (authResult.success && authResult.creds) {
      creds = authResult.creds;
      derivedCreds = authResult.creds;

      const keySuffix = authResult.story.apiKeySuffix ?? "???";
      logger?.info(
        `[MinimalClient] ✅ Credentials derived (key: ${keySuffix})`,
      );
    } else {
      deriveFailed = true;
      deriveError = authResult.story.errorMessage ?? "Derivation failed";
      logger?.error(`[MinimalClient] ❌ Derivation failed: ${deriveError}`);
    }
  }

  // Create the client
  // Note: Type assertion is used here for backwards compatibility with existing code
  // that expects these additional properties. In a future refactor, consider creating
  // a proper wrapper class or using composition instead of type assertions.
  const client = new ClobClient(
    POLYMARKET_API.BASE_URL,
    Chain.POLYGON,
    asClobSigner(wallet),
    creds,
    input.signatureType,
    input.funderAddress,
  ) as MinimalClobClient;

  // Attach additional properties (for compatibility with existing code)
  client.wallet = wallet;
  client.derivedSignerAddress = derivedSignerAddress;
  client.effectivePolyAddress = effectivePolyAddress;
  // Note: publicKeyMismatch was used in complex auth to track EOA vs configured key mismatches.
  // Not relevant in minimal auth as we trust the SDK to handle wallet mode detection.
  client.publicKeyMismatch = false;
  client.executionDisabled = !creds; // Disabled if no credentials
  client.providedCreds = providedCreds;
  client.derivedCreds = derivedCreds;
  client.deriveFailed = deriveFailed;
  client.deriveError = deriveError;

  // Log final status
  if (creds) {
    logger?.info("[MinimalClient] ✅ Client ready for trading");
  } else {
    logger?.warn(
      "[MinimalClient] ⚠️  Client in read-only mode (no credentials)",
    );
    logger?.warn(
      "[MinimalClient] 💡 Visit https://polymarket.com to enable trading",
    );
  }

  return client;
}
