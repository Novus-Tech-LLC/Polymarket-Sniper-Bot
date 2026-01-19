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

const CLOB_HOST = POLYMARKET_API.BASE_URL;
const CHAIN_ID = Chain.POLYGON;

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
  credentialsObtained: boolean;
  apiKeySuffix?: string;
  verificationPassed: boolean;
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
 * Redact secret for logging (show only last 4-6 chars)
 */
function redactSecret(secret: string): string {
  // For short strings, use fixed redaction to avoid revealing too much
  if (secret.length <= 8) {
    return "***";
  }
  // For longer strings, show last 6 chars
  return `***${secret.slice(-6)}`;
}

/**
 * Log based on level
 */
function log(
  level: "debug" | "info" | "error",
  message: string,
  config: MinimalAuthConfig,
): void {
  const logLevel = config.logLevel ?? "info";
  const levelPriority = { debug: 0, info: 1, error: 2 };

  if (levelPriority[level] >= levelPriority[logLevel]) {
    const prefix =
      level === "error" ? "❌" : level === "info" ? "ℹ️" : "🔍";
    console.log(`${prefix} [MinimalAuth] ${message}`);
  }
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

  // Initialize story
  const story: AuthStory = {
    runId,
    timestamp: new Date().toISOString(),
    success: false,
    signerAddress: "",
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    credentialsObtained: false,
    verificationPassed: false,
    durationMs: 0,
  };

  try {
    // Validate private key
    if (!config.privateKey) {
      story.errorMessage = "Private key is required";
      log("error", story.errorMessage, config);
      return { success: false, story: updateStoryDuration(story, startTime) };
    }

    // Create wallet
    const pk = config.privateKey.startsWith("0x")
      ? config.privateKey
      : `0x${config.privateKey}`;
    const wallet = new Wallet(pk);
    story.signerAddress = wallet.address;

    log(
      "info",
      `Authenticating wallet ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`,
      config,
    );

    // Step 1: Create CLOB client
    log("debug", "Creating ClobClient...", config);
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      asClobSigner(wallet),
      undefined, // No credentials yet
      config.signatureType, // Optional signature type
      config.funderAddress, // Optional funder address
    );

    // Step 2: Call createOrDeriveApiKey() - just like Python agents
    log("info", "Calling createOrDeriveApiKey()...", config);
    let creds: ApiKeyCreds;
    try {
      creds = await client.createOrDeriveApiKey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = extractErrorStatus(error);

      if (status === 400 && message.toLowerCase().includes("could not create")) {
        story.errorMessage = "Wallet must trade on Polymarket first";
        log("error", "Wallet has never traded on Polymarket", config);
        log("info", "Visit https://polymarket.com and make a trade", config);
      } else {
        story.errorMessage = `Failed to derive credentials: ${message}`;
        log("error", story.errorMessage, config);
      }

      return { success: false, story: updateStoryDuration(story, startTime) };
    }

    // Validate credentials
    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      story.errorMessage = "Credentials incomplete";
      log("error", "Credentials missing required fields", config);
      return { success: false, story: updateStoryDuration(story, startTime) };
    }

    story.credentialsObtained = true;
    story.apiKeySuffix = redactSecret(creds.key);
    log("info", `Credentials obtained (key: ${story.apiKeySuffix})`, config);
    log(
      "debug",
      `Secret length: ${creds.secret.length}, Passphrase length: ${creds.passphrase.length}`,
      config,
    );

    // Step 3: Set credentials on client (like Python: client.set_api_creds())
    // Note: JS/TS ClobClient stores credentials in the 'creds' property directly
    log("debug", "Setting credentials on client...", config);
    (client as ClobClient & { creds?: ApiKeyCreds }).creds = creds;

    // Step 4: Verify with a simple API call
    log("info", "Verifying credentials with /balance-allowance...", config);
    try {
      const response = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });

      // Check for error response
      const errorResponse = response as { status?: number; error?: string };
      if (errorResponse.status === 401 || errorResponse.status === 403) {
        story.errorMessage = `Verification failed: ${errorResponse.status} ${errorResponse.error ?? "Unauthorized"}`;
        log("error", story.errorMessage, config);
        return { success: false, story: updateStoryDuration(story, startTime) };
      }

      if (errorResponse.error) {
        story.errorMessage = `Verification error: ${errorResponse.error}`;
        log("error", story.errorMessage, config);
        return { success: false, story: updateStoryDuration(story, startTime) };
      }

      story.verificationPassed = true;
      story.success = true;

      const finalStory = updateStoryDuration(story, startTime);
      log("info", `✅ Auth successful (${finalStory.durationMs}ms)`, config);

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

      if (status === 401 || status === 403) {
        story.errorMessage = `Verification failed: ${status} Unauthorized`;
      } else {
        story.errorMessage = `Verification error: ${message}`;
      }

      log("error", story.errorMessage, config);
      return { success: false, story: updateStoryDuration(story, startTime) };
    }
  } catch (unexpectedError) {
    const message =
      unexpectedError instanceof Error
        ? unexpectedError.message
        : String(unexpectedError);
    story.errorMessage = `Unexpected error: ${message}`;
    log("error", story.errorMessage, config);
    return { success: false, story: updateStoryDuration(story, startTime) };
  }
}

/**
 * Print Auth Story in JSON format
 */
export function printAuthStory(story: AuthStory): void {
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
    process.env.POLYMARKET_SIGNATURE_TYPE ??
    process.env.CLOB_SIGNATURE_TYPE;
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
    process.env.POLYMARKET_PROXY_ADDRESS ??
    process.env.CLOB_FUNDER_ADDRESS;

  // Get log level
  const logLevelStr = process.env.LOG_LEVEL?.toLowerCase();
  const logLevel: "debug" | "info" | "error" =
    logLevelStr === "debug" || logLevelStr === "error"
      ? logLevelStr
      : "info";

  return {
    privateKey,
    signatureType,
    funderAddress,
    logLevel,
  };
}
