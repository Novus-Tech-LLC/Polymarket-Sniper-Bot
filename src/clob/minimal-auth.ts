/**
 * Minimal CLOB Authentication
 *
 * Ultra-simple authentication following the Polymarket/agents Python approach:
 * - Single call to createOrDeriveApiKey()
 * - No fallback ladder
 * - No signature type detection
 * - No address swapping
 * - Minimal logging (Auth Story format)
 *
 * Python reference:
 *   self.client = ClobClient(self.clob_url, key=self.private_key, chain_id=self.chain_id)
 *   self.credentials = self.client.create_or_derive_api_creds()
 *   self.client.set_api_creds(self.credentials)
 *
 * That's it. No complexity. Just works.
 */

import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import { asClobSigner } from "../utils/clob-signer.util";
import {
  AuthLogger,
  redactApiKey,
  createCredentialFingerprint,
} from "../utils/auth-logger";

const CLOB_HOST = POLYMARKET_API.BASE_URL;
const CHAIN_ID = Chain.POLYGON;

/**
 * Credential fingerprint type (safe to log)
 */
export interface CredentialFingerprint {
  apiKeySuffix: string;
  secretLen: number;
  passphraseLen?: number;
  secretEncodingGuess: string;
}

/**
 * Auth Story - single structured summary per run
 */
export interface AuthStory {
  runId: string;
  timestamp: string;
  success: boolean;
  signerAddress: string;
  signatureType?: number;
  funderAddress?: string;
  clobHost: string;
  chainId: number;
  credentialsObtained: boolean;
  derivedCredFingerprint?: CredentialFingerprint;
  verificationPassed: boolean;
  attempts: Array<{
    attemptId: string;
    mode: string;
    sigType: number;
    httpStatus?: number;
    errorTextShort?: string;
    success: boolean;
  }>;
  errorMessage?: string;
  durationMs: number;
}

/**
 * Result of minimal auth
 */
export interface MinimalAuthResult {
  success: boolean;
  creds?: ApiKeyCreds;
  client?: ClobClient;
  story: AuthStory;
}

/**
 * Config for minimal auth
 */
export interface MinimalAuthConfig {
  privateKey: string;
  signatureType?: number; // Optional: 0=EOA, 1=Proxy, 2=GnosisSafe
  funderAddress?: string; // Optional: For Proxy/Safe modes
  logLevel?: "debug" | "info" | "error"; // Default: "info"
  logger?: AuthLogger; // Optional: Custom auth logger
}

/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Extract HTTP status from an error object (safe with type guard)
 */
function extractErrorStatus(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "status" in error.response
  ) {
    const status = (error.response as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * Update the auth story with final duration
 * Note: This function mutates the story object for efficiency
 */
function updateStoryDuration(story: AuthStory, startTime: number): AuthStory {
  story.durationMs = Date.now() - startTime;
  return story;
}

/**
 * Authenticate with Polymarket CLOB - Python agents style
 *
 * This function does exactly what the Python agents repo does:
 * 1. Create ClobClient with private key
 * 2. Call createOrDeriveApiKey() once
 * 3. Set credentials on client
 * 4. Verify with one API call
 *
 * No fallback ladder. No retries. No complexity.
 */
export async function authenticateMinimal(
  config: MinimalAuthConfig,
): Promise<MinimalAuthResult> {
  const runId = generateRunId();
  const startTime = Date.now();

  // Create or reuse logger (if provided, ensure runId matches)
  const logger = config.logger ? config.logger : new AuthLogger(runId);

  // Initialize story
  const story: AuthStory = {
    runId,
    timestamp: new Date().toISOString(),
    success: false,
    signerAddress: "",
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    clobHost: CLOB_HOST,
    chainId: CHAIN_ID,
    credentialsObtained: false,
    verificationPassed: false,
    attempts: [],
    durationMs: 0,
  };

  try {
    // Validate private key
    if (!config.privateKey) {
      story.errorMessage = "Private key is required";
      logger.error(story.errorMessage, { category: "IDENTITY" });
      return { success: false, story: updateStoryDuration(story, startTime) };
    }

    // Create wallet
    const pk = config.privateKey.startsWith("0x")
      ? config.privateKey
      : `0x${config.privateKey}`;
    const wallet = new Wallet(pk);
    story.signerAddress = wallet.address;

    logger.info(
      `Authenticating wallet ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`,
      { category: "IDENTITY", signerAddress: wallet.address },
    );

    // Step 1: Create CLOB client
    logger.debug("Creating ClobClient...", { category: "IDENTITY" });
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      asClobSigner(wallet),
      undefined, // No credentials yet
      config.signatureType, // Optional signature type
      config.funderAddress, // Optional funder address
    );

    // Step 2: Call createOrDeriveApiKey() - just like Python agents
    logger.info("Calling createOrDeriveApiKey()...", {
      category: "CRED_DERIVE",
    });

    // Add attempt record
    const attemptId = "A";
    story.attempts.push({
      attemptId,
      mode:
        config.signatureType === 2
          ? "SAFE"
          : config.signatureType === 1
            ? "PROXY"
            : "EOA",
      sigType: config.signatureType ?? 0,
      success: false,
    });

    let creds: ApiKeyCreds;
    try {
      creds = await client.createOrDeriveApiKey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = extractErrorStatus(error);

      // Update attempt with error
      story.attempts[0].httpStatus = status;
      story.attempts[0].errorTextShort = message.slice(0, 100);

      if (
        status === 400 &&
        message.toLowerCase().includes("could not create")
      ) {
        story.errorMessage = "Wallet must trade on Polymarket first";
        logger.error("Wallet has never traded on Polymarket", {
          category: "CRED_DERIVE",
          status,
        });
        logger.info("Visit https://polymarket.com and make a trade", {
          category: "CRED_DERIVE",
        });
      } else {
        story.errorMessage = `Failed to derive credentials: ${message}`;
        logger.error(story.errorMessage, { category: "CRED_DERIVE", status });
      }

      return { success: false, story: updateStoryDuration(story, startTime) };
    }

    // Validate credentials
    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      story.errorMessage = "Credentials incomplete";
      story.attempts[0].errorTextShort = "Credentials missing required fields";
      logger.error("Credentials missing required fields", {
        category: "CRED_DERIVE",
      });
      return { success: false, story: updateStoryDuration(story, startTime) };
    }

    // Create credential fingerprint (safe to log)
    const fingerprint = createCredentialFingerprint(creds);
    story.credentialsObtained = true;
    story.derivedCredFingerprint = fingerprint;

    logger.info(`Credentials obtained (key: ***${fingerprint.apiKeySuffix})`, {
      category: "CRED_DERIVE",
      ...fingerprint,
    });

    // Step 3: Set credentials on client (like Python: client.set_api_creds())
    // Note: JS/TS ClobClient stores credentials in the 'creds' property directly
    logger.debug("Setting credentials on client...", { category: "IDENTITY" });
    (client as ClobClient & { creds?: ApiKeyCreds }).creds = creds;

    // Step 4: Verify with a simple API call
    logger.info("Verifying credentials with /balance-allowance...", {
      category: "PREFLIGHT",
    });
    try {
      const response = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });

      // Check for error response
      const errorResponse = response as { status?: number; error?: string };
      if (errorResponse.status === 401 || errorResponse.status === 403) {
        story.errorMessage = `Verification failed: ${errorResponse.status} ${errorResponse.error ?? "Unauthorized"}`;
        story.attempts[0].httpStatus = errorResponse.status;
        story.attempts[0].errorTextShort =
          errorResponse.error ?? "Unauthorized";
        logger.error(story.errorMessage, {
          category: "PREFLIGHT",
          status: errorResponse.status,
        });
        return { success: false, story: updateStoryDuration(story, startTime) };
      }

      if (errorResponse.error) {
        story.errorMessage = `Verification error: ${errorResponse.error}`;
        story.attempts[0].errorTextShort = errorResponse.error;
        logger.error(story.errorMessage, { category: "PREFLIGHT" });
        return { success: false, story: updateStoryDuration(story, startTime) };
      }

      // Success!
      story.verificationPassed = true;
      story.success = true;
      story.attempts[0].success = true;
      story.attempts[0].httpStatus = 200;

      const finalStory = updateStoryDuration(story, startTime);
      logger.info(`✅ Auth successful (${finalStory.durationMs}ms)`, {
        category: "IDENTITY",
        durationMs: finalStory.durationMs,
      });

      // Flush deduplication before returning
      logger.flushDeduplication();

      return {
        success: true,
        creds,
        client,
        story: finalStory,
      };
    } catch (verifyError) {
      const message =
        verifyError instanceof Error
          ? verifyError.message
          : String(verifyError);
      const status = extractErrorStatus(verifyError);

      story.attempts[0].httpStatus = status;
      story.attempts[0].errorTextShort = message.slice(0, 100);

      if (status === 401 || status === 403) {
        story.errorMessage = `Verification failed: ${status} Unauthorized`;
      } else {
        story.errorMessage = `Verification error: ${message}`;
      }

      logger.error(story.errorMessage, { category: "PREFLIGHT", status });
      return { success: false, story: updateStoryDuration(story, startTime) };
    }
  } catch (unexpectedError) {
    const message =
      unexpectedError instanceof Error
        ? unexpectedError.message
        : String(unexpectedError);
    story.errorMessage = `Unexpected error: ${message}`;
    logger.error(story.errorMessage, { category: "IDENTITY" });
    return { success: false, story: updateStoryDuration(story, startTime) };
  } finally {
    // Always flush deduplication
    logger.flushDeduplication();
  }
}

/**
 * Print Auth Story in JSON format (single structured output)
 */
export function printAuthStory(
  story: AuthStory,
  format: "json" | "pretty" = "json",
): void {
  if (format === "json") {
    // Pure JSON output - single line for easy parsing
    console.log(JSON.stringify(story));
  } else {
    // Pretty format with header/footer (for human readability)
    console.log("\n" + "=".repeat(60));
    console.log("AUTH STORY");
    console.log("=".repeat(60));
    console.log(JSON.stringify(story, null, 2));
    console.log("=".repeat(60));

    if (story.success) {
      console.log("✅ Authentication successful - ready to trade");
    } else {
      console.log("❌ Authentication failed");
      if (story.errorMessage) {
        console.log(`   Reason: ${story.errorMessage}`);
      }
    }
    console.log("=".repeat(60) + "\n");
  }
}

/**
 * Create from environment variables
 */
export function createMinimalAuthConfigFromEnv(): MinimalAuthConfig {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  // Parse signature type if provided
  let signatureType: number | undefined;
  const sigTypeStr =
    process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE;
  if (sigTypeStr) {
    const parsed = Number.parseInt(sigTypeStr, 10);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 2) {
      signatureType = parsed;
    } else {
      // Log warning for invalid signature type but continue
      console.warn(
        `[MinimalAuth] Invalid signature type "${sigTypeStr}" - must be 0, 1, or 2. Using default.`,
      );
    }
  }

  // Get funder address if provided
  const funderAddress =
    process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;

  // Get log level
  const logLevelStr = process.env.LOG_LEVEL?.toLowerCase();
  const logLevel: "debug" | "info" | "error" =
    logLevelStr === "debug" || logLevelStr === "error" ? logLevelStr : "info";

  return {
    privateKey,
    signatureType,
    funderAddress,
    logLevel,
  };
}
