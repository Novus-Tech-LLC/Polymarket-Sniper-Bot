#!/usr/bin/env ts-node

/**
 * CLOB Authentication Probe - Deterministic Auth Diagnostics Tool
 *
 * This tool performs a minimal, instrumented CLOB authentication test:
 * 1. Derives CLOB credentials from PRIVATE_KEY
 * 2. Forces EOA identity (signatureType=0, no Safe/proxy contamination)
 * 3. Makes a single GET /balance-allowance call
 * 4. Prints redacted debug bundle
 * 5. Generates Auth Story summary
 * 6. Exits with success/failure code
 *
 * Usage:
 *   ts-node scripts/clob_auth_probe.ts
 *   node dist/scripts/clob_auth_probe.js
 *   npm run clob:probe
 *
 * Environment Variables:
 *   PRIVATE_KEY              - Required: Private key for authentication
 *   CLOB_HOST                - Optional: CLOB API host (default: https://clob.polymarket.com)
 *   CHAIN_ID                 - Optional: Chain ID (default: 137 for Polygon)
 *   SIGNATURE_TYPE_FORCE     - Optional: Force signature type (default: "0" for EOA)
 *   POLY_ADDRESS_FORCE       - Optional: Force wallet address override
 *   DEBUG_AUTH_PROBE         - Optional: Enable debug output (default: true)
 *   DEBUG_PREFLIGHT_MATRIX   - Optional: Run identity matrix test (default: false)
 *   SAFE_ADDRESS             - Optional: Safe address for matrix mode
 *   PROXY_ADDRESS            - Optional: Proxy address for matrix mode
 *   LOG_FORMAT               - Optional: Log format "json" or "pretty" (default: "json")
 *   LOG_LEVEL                - Optional: Log level "error", "warn", "info", or "debug" (default: "info")
 */

import {
  ClobClient,
  Chain,
  AssetType,
  createL2Headers,
} from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import axios from "axios";
import * as crypto from "crypto";
import { getLogger, generateRunId } from "../src/utils/structured-logger";
import {
  initAuthStory,
  createCredentialFingerprint,
  type AuthAttempt,
} from "../src/clob/auth-story";

// Helper to convert ethers v6 Wallet to CLOB client compatible signer
function asClobSigner(wallet: Wallet): any {
  const typedSigner = wallet as any;
  if (
    typeof typedSigner._signTypedData !== "function" &&
    typeof typedSigner.signTypedData === "function"
  ) {
    typedSigner._signTypedData = async (domain: any, types: any, value: any) =>
      typedSigner.signTypedData!(domain, types, value);
  }
  return wallet;
}

// ============================================================================
// Configuration
// ============================================================================

interface ProbeConfig {
  privateKey: string;
  clobHost: string;
  chainId: number;
  signatureTypeForce: number;
  polyAddressForce?: string;
  debugAuthProbe: boolean;
  debugPreflightMatrix: boolean;
  safeAddress?: string;
  proxyAddress?: string;
}

function loadConfig(): ProbeConfig {
  const logger = getLogger();
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    logger.error("PRIVATE_KEY environment variable is required", {
      category: "STARTUP",
    });
    process.exit(1);
  }

  return {
    privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.CHAIN_ID || "137", 10),
    signatureTypeForce: parseInt(process.env.SIGNATURE_TYPE_FORCE || "0", 10),
    polyAddressForce: process.env.POLY_ADDRESS_FORCE,
    debugAuthProbe: process.env.DEBUG_AUTH_PROBE !== "false",
    debugPreflightMatrix: process.env.DEBUG_PREFLIGHT_MATRIX === "true",
    safeAddress: process.env.SAFE_ADDRESS,
    proxyAddress: process.env.PROXY_ADDRESS,
  };
}

// ============================================================================
// Identity Management - EOA Hard Lock
// ============================================================================

interface EOAIdentity {
  signerAddress: string;
  walletAddress: string;
  makerAddress: string;
  funderAddress: undefined;
  signatureType: 0;
}

function deriveEOAIdentity(
  privateKey: string,
  polyAddressForce?: string,
): EOAIdentity {
  const wallet = new Wallet(privateKey);
  const signerAddress = wallet.address;
  const walletAddress = polyAddressForce || signerAddress;

  return {
    signerAddress,
    walletAddress,
    makerAddress: walletAddress,
    funderAddress: undefined, // MUST be undefined for EOA mode
    signatureType: 0,
  };
}

// ============================================================================
// Credential Derivation
// ============================================================================

async function deriveCredentials(
  wallet: Wallet,
  clobHost: string,
  identity: EOAIdentity,
): Promise<{ success: boolean; creds?: ApiKeyCreds; error?: string }> {
  const logger = getLogger();
  try {
    logger.info("Attempting credential derivation", {
      category: "CRED_DERIVE",
      clobHost,
      signatureType: identity.signatureType,
      funderAddress: identity.funderAddress,
    });

    const client = new ClobClient(
      clobHost,
      Chain.POLYGON,
      asClobSigner(wallet),
      undefined, // No creds yet
      identity.signatureType,
      identity.funderAddress, // undefined for EOA
    );

    // Try deriveApiKey
    const deriveFn = client as ClobClient & {
      deriveApiKey?: () => Promise<ApiKeyCreds>;
    };

    if (!deriveFn.deriveApiKey) {
      logger.error("deriveApiKey method not available", {
        category: "CRED_DERIVE",
      });
      return { success: false, error: "deriveApiKey method not available" };
    }

    const creds = await deriveFn.deriveApiKey();

    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      logger.error("Incomplete credentials returned", {
        category: "CRED_DERIVE",
      });
      return { success: false, error: "Incomplete credentials returned" };
    }

    logger.info("Credentials derived successfully", {
      category: "CRED_DERIVE",
      apiKeySuffix: creds.key.slice(-6),
    });
    return { success: true, creds };
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.message || String(error);

    if (status === 401 && message.includes("Invalid L1 Request headers")) {
      logger.error("Invalid L1 Request headers", {
        category: "CRED_DERIVE",
        status: 401,
      });
      return { success: false, error: "Invalid L1 Request headers (401)" };
    }

    if (
      status === 400 &&
      message.toLowerCase().includes("could not create api key")
    ) {
      logger.error("Wallet has not traded on Polymarket yet", {
        category: "CRED_DERIVE",
        status: 400,
      });
      return {
        success: false,
        error: "Wallet has not traded on Polymarket yet (400)",
      };
    }

    logger.error("Credential derivation failed", {
      category: "CRED_DERIVE",
      status,
      error: message,
    });
    return { success: false, error: `${status || "unknown"} - ${message}` };
  }
}

// ============================================================================
// Authentication Request
// ============================================================================

interface AuthRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  signedPath: string;
  timestamp: number;
  messageString: string;
}

async function buildAuthRequest(
  clobHost: string,
  wallet: Wallet,
  creds: ApiKeyCreds,
  identity: EOAIdentity,
): Promise<AuthRequest> {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/balance-allowance";
  const queryParams = {
    asset_type: AssetType.COLLATERAL,
    signature_type: identity.signatureType,
  };

  // Build signed path with query string
  const signedPath = `${path}?asset_type=${queryParams.asset_type}&signature_type=${queryParams.signature_type}`;
  const method = "GET";

  // Create L2 headers using CLOB client library
  const headers = await createL2Headers(
    asClobSigner(wallet),
    creds,
    {
      method,
      requestPath: signedPath,
    },
    timestamp,
  );

  // Build message string for diagnostics (HMAC message format)
  const messageString = `${timestamp}${method}${signedPath}`;

  return {
    method,
    url: `${clobHost}${signedPath}`,
    headers: headers as Record<string, string>,
    signedPath,
    timestamp,
    messageString,
  };
}

async function executeAuthRequest(
  request: AuthRequest,
): Promise<{ success: boolean; status?: number; data?: any; error?: string }> {
  const logger = getLogger();
  try {
    logger.info("Making authentication request", {
      category: "HTTP",
      method: request.method,
      url: request.url,
      signedPath: request.signedPath,
    });

    const response = await axios({
      method: request.method,
      url: request.url,
      headers: request.headers,
    });

    logger.info("Authentication request successful", {
      category: "HTTP",
      status: response.status,
    });

    return {
      success: response.status === 200,
      status: response.status,
      data: response.data,
    };
  } catch (error: any) {
    const status = error?.response?.status || 0;
    const errorData = error?.response?.data || error?.message || String(error);

    logger.error("Authentication request failed", {
      category: "HTTP",
      status,
      error: JSON.stringify(errorData).slice(0, 200),
    });

    return {
      success: false,
      status,
      error: JSON.stringify(errorData).slice(0, 500),
    };
  }
}

// ============================================================================
// Self-Check Validation
// ============================================================================

interface SelfCheckResult {
  passed: boolean;
  checks: {
    queryStringInPath: boolean;
    funderIsNull: boolean;
    signatureTypeIsZero: boolean;
  };
}

function runSelfCheck(
  identity: EOAIdentity,
  request: AuthRequest,
): SelfCheckResult {
  const checks = {
    queryStringInPath: request.signedPath.includes("?"),
    funderIsNull: identity.funderAddress === undefined,
    signatureTypeIsZero: identity.signatureType === 0,
  };

  const passed = Object.values(checks).every((v) => v);

  return { passed, checks };
}

// ============================================================================
// Debug Bundle - Redacted Output
// ============================================================================

interface DebugBundle {
  identity: {
    signerAddress: string;
    walletAddress: string;
    makerAddress: string;
    funderAddress: undefined;
  };
  request: {
    url: string;
    signedPath: string;
    headerNames: string[];
  };
  credentials: {
    apiKeyPrefix: string;
    apiKeySuffix: string;
    secretLength: number;
    secretEncoding: string;
    secretPrefix: string;
    secretSuffix: string;
    passphrasePrefix: string;
    passphraseSuffix: string;
  };
  signing: {
    timestamp: number;
    messageStringLength: number;
    messageDigest: string;
    signatureEncoding: string;
  };
  selfCheck: SelfCheckResult;
}

function buildDebugBundle(
  identity: EOAIdentity,
  creds: ApiKeyCreds,
  request: AuthRequest,
  selfCheck: SelfCheckResult,
): DebugBundle {
  // Detect secret encoding - check for base64-specific chars first
  const hasBase64Chars =
    creds.secret.includes("+") || creds.secret.includes("/");
  const hasBase64UrlChars =
    creds.secret.includes("-") || creds.secret.includes("_");

  // If has base64 chars and no base64url chars, it's base64
  // If has base64url chars and no base64 chars, it's base64url
  // If has both or neither, it's unclear
  let secretEncoding = "unknown";
  if (hasBase64Chars && !hasBase64UrlChars) {
    secretEncoding = "base64";
  } else if (hasBase64UrlChars && !hasBase64Chars) {
    secretEncoding = "base64url";
  } else if (hasBase64Chars && hasBase64UrlChars) {
    // Has both types of chars - check which is more common
    const base64CharCount = (creds.secret.match(/[+/]/g) || []).length;
    const base64UrlCharCount = (creds.secret.match(/[-_]/g) || []).length;
    secretEncoding =
      base64CharCount > base64UrlCharCount ? "base64" : "base64url";
  }

  // Create message digest for debugging
  const messageHash = crypto
    .createHash("sha256")
    .update(request.messageString)
    .digest("hex");
  const messageDigest = `${messageHash.slice(0, 8)}...${messageHash.slice(-8)}`;

  return {
    identity: {
      signerAddress: identity.signerAddress,
      walletAddress: identity.walletAddress,
      makerAddress: identity.makerAddress,
      funderAddress: identity.funderAddress,
    },
    request: {
      url: request.url,
      signedPath: request.signedPath,
      headerNames: Object.keys(request.headers),
    },
    credentials: {
      apiKeyPrefix: creds.key.slice(0, 8),
      apiKeySuffix: creds.key.slice(-4),
      secretLength: creds.secret.length,
      secretEncoding,
      secretPrefix: creds.secret.slice(0, 8),
      secretSuffix: creds.secret.slice(-4),
      passphrasePrefix: creds.passphrase.slice(0, 4),
      passphraseSuffix: creds.passphrase.slice(-4),
    },
    signing: {
      timestamp: request.timestamp,
      messageStringLength: request.messageString.length,
      messageDigest,
      signatureEncoding: "base64url", // CLOB client uses base64url
    },
    selfCheck,
  };
}

function printDebugBundle(bundle: DebugBundle, debugEnabled: boolean): void {
  if (!debugEnabled) {
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log("DEBUG BUNDLE (Redacted)");
  console.log("=".repeat(70));

  console.log("\n[Identity - EOA Hard Lock]");
  console.log(`  signerAddress:  ${bundle.identity.signerAddress}`);
  console.log(`  walletAddress:  ${bundle.identity.walletAddress}`);
  console.log(`  makerAddress:   ${bundle.identity.makerAddress}`);
  console.log(
    `  funderAddress:  ${bundle.identity.funderAddress} (MUST be undefined)`,
  );

  console.log("\n[Request]");
  console.log(`  url:            ${bundle.request.url}`);
  console.log(`  signedPath:     ${bundle.request.signedPath}`);
  console.log(`  headerNames:    ${bundle.request.headerNames.join(", ")}`);

  console.log("\n[Credentials - Redacted]");
  console.log(
    `  apiKey:         ${bundle.credentials.apiKeyPrefix}...${bundle.credentials.apiKeySuffix}`,
  );
  console.log(
    `  secret:         ${bundle.credentials.secretPrefix}...${bundle.credentials.secretSuffix} (len=${bundle.credentials.secretLength}, encoding=${bundle.credentials.secretEncoding})`,
  );
  console.log(
    `  passphrase:     ${bundle.credentials.passphrasePrefix}...${bundle.credentials.passphraseSuffix}`,
  );

  console.log("\n[Signing]");
  console.log(`  timestamp:      ${bundle.signing.timestamp}`);
  console.log(`  messageLength:  ${bundle.signing.messageStringLength}`);
  console.log(`  messageDigest:  ${bundle.signing.messageDigest}`);
  console.log(`  sigEncoding:    ${bundle.signing.signatureEncoding}`);

  console.log("\n[Self-Check]");
  console.log(
    `  queryInPath:    ${bundle.selfCheck.checks.queryStringInPath ? "✅" : "❌"}`,
  );
  console.log(
    `  funderIsNull:   ${bundle.selfCheck.checks.funderIsNull ? "✅" : "❌"}`,
  );
  console.log(
    `  sigTypeIsZero:  ${bundle.selfCheck.checks.signatureTypeIsZero ? "✅" : "❌"}`,
  );
  console.log(
    `  OVERALL:        ${bundle.selfCheck.passed ? "✅ PASS" : "❌ FAIL"}`,
  );

  console.log("\n" + "=".repeat(70));
}

// ============================================================================
// Preflight Matrix Mode
// ============================================================================

interface MatrixCase {
  label: string;
  signatureType: number;
  walletAddress: string;
  makerAddress: string;
  funderAddress?: string;
}

async function runPreflightMatrix(
  config: ProbeConfig,
  wallet: Wallet,
): Promise<void> {
  const logger = getLogger();
  logger.info("PREFLIGHT MATRIX MODE", { category: "STARTUP" });

  const signerAddress = wallet.address;
  const cases: MatrixCase[] = [];

  // Case 1: EOA
  cases.push({
    label: "EOA",
    signatureType: 0,
    walletAddress: signerAddress,
    makerAddress: signerAddress,
    funderAddress: undefined,
  });

  // Case 2: Safe-like (if configured)
  if (config.safeAddress) {
    cases.push({
      label: "Safe",
      signatureType: 2,
      walletAddress: signerAddress,
      makerAddress: config.safeAddress,
      funderAddress: config.safeAddress,
    });
  }

  // Case 3: Proxy-like (if configured)
  if (config.proxyAddress) {
    cases.push({
      label: "Proxy",
      signatureType: 1,
      walletAddress: signerAddress,
      makerAddress: config.proxyAddress,
      funderAddress: config.proxyAddress,
    });
  }

  logger.info(`Testing ${cases.length} identity configurations`, {
    category: "STARTUP",
  });

  for (const testCase of cases) {
    logger.info(`Testing ${testCase.label}`, {
      category: "STARTUP",
      signatureType: testCase.signatureType,
      walletAddress: testCase.walletAddress,
      makerAddress: testCase.makerAddress,
      funderAddress: testCase.funderAddress || "null",
    });

    try {
      const client = new ClobClient(
        config.clobHost,
        Chain.POLYGON,
        asClobSigner(wallet),
        undefined,
        testCase.signatureType,
        testCase.funderAddress,
      );

      const deriveFn = client as ClobClient & {
        deriveApiKey?: () => Promise<ApiKeyCreds>;
      };

      if (!deriveFn.deriveApiKey) {
        logger.error("deriveApiKey not available", {
          category: "CRED_DERIVE",
          label: testCase.label,
        });
        continue;
      }

      const creds = await deriveFn.deriveApiKey();

      if (!creds || !creds.key) {
        logger.error("Invalid credentials", {
          category: "CRED_DERIVE",
          label: testCase.label,
        });
        continue;
      }

      // Test with balance-allowance
      const response = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });

      const errorResponse = response as { status?: number; error?: string };
      if (errorResponse.status === 401 || errorResponse.status === 403) {
        logger.error("AUTH FAIL", {
          category: "HTTP",
          label: testCase.label,
          status: errorResponse.status,
          error: errorResponse.error || "Unauthorized",
        });
      } else if (errorResponse.error) {
        logger.error("ERROR", {
          category: "HTTP",
          label: testCase.label,
          error: errorResponse.error,
        });
      } else {
        logger.info("AUTH OK", {
          category: "HTTP",
          label: testCase.label,
        });
      }
    } catch (error: any) {
      const status = error?.response?.status || 0;
      const message = error?.message || String(error);
      logger.error("EXCEPTION", {
        category: "HTTP",
        label: testCase.label,
        status,
        error: message.slice(0, 80),
      });
    }
  }

  logger.info("Matrix test complete", { category: "SUMMARY" });
}

// ============================================================================
// Main Probe Logic
// ============================================================================

async function runProbe(config: ProbeConfig): Promise<number> {
  const logger = getLogger();

  logger.info("CLOB Authentication Probe", { category: "STARTUP" });
  logger.info("Starting probe execution", {
    category: "STARTUP",
    clobHost: config.clobHost,
    chainId: config.chainId,
    signatureTypeForce: config.signatureTypeForce,
  });

  // Step 1: Derive EOA identity
  logger.info("Step 1: Deriving EOA identity", { category: "STARTUP" });
  const identity = deriveEOAIdentity(
    config.privateKey,
    config.polyAddressForce,
  );
  logger.info("EOA identity derived", {
    category: "STARTUP",
    signerAddress: identity.signerAddress,
    walletAddress: identity.walletAddress,
    makerAddress: identity.makerAddress,
    funderAddress: identity.funderAddress,
    signatureType: identity.signatureType,
  });

  const wallet = new Wallet(config.privateKey);

  // Initialize auth story - get runId from logger's base context
  const runId = generateRunId();
  const authStory = initAuthStory({
    runId,
    signerAddress: identity.signerAddress,
    clobHost: config.clobHost,
    chainId: config.chainId,
  });

  // Step 2: Derive credentials
  logger.info("Step 2: Deriving CLOB credentials", { category: "CRED_DERIVE" });
  const derivationResult = await deriveCredentials(
    wallet,
    config.clobHost,
    identity,
  );

  if (!derivationResult.success || !derivationResult.creds) {
    logger.error("Credential derivation failed", {
      category: "CRED_DERIVE",
      error: derivationResult.error,
    });

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: `Credential derivation failed: ${derivationResult.error}`,
    });
    authStory.printSummary();

    return 1;
  }

  const creds = derivationResult.creds;

  // Set credential fingerprint in auth story
  const credFingerprint = createCredentialFingerprint(creds);
  authStory.setCredentialFingerprint(credFingerprint);

  // Step 3: Build auth request
  logger.info("Step 3: Building authentication request", { category: "HTTP" });
  const request = await buildAuthRequest(
    config.clobHost,
    wallet,
    creds,
    identity,
  );

  // Step 4: Run self-check
  logger.info("Step 4: Running self-check validation", { category: "STARTUP" });
  const selfCheck = runSelfCheck(identity, request);

  if (!selfCheck.passed) {
    logger.error("Self-check failed", {
      category: "STARTUP",
      queryInPath: selfCheck.checks.queryStringInPath,
      funderIsNull: selfCheck.checks.funderIsNull,
      sigTypeIsZero: selfCheck.checks.signatureTypeIsZero,
    });

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason: "Self-check validation failed",
    });
    authStory.printSummary();

    return 1;
  }

  logger.info("All self-checks passed", { category: "STARTUP" });

  // Step 5: Execute request
  logger.info("Step 5: Executing authentication request", { category: "HTTP" });
  const result = await executeAuthRequest(request);

  // Add attempt to auth story
  const attempt: AuthAttempt = {
    attemptId: "A",
    mode: "EOA",
    sigType: identity.signatureType,
    l1Auth: identity.signerAddress,
    maker: identity.makerAddress,
    funder: identity.funderAddress || "null",
    verifyEndpoint: "/balance-allowance",
    signedPath: request.signedPath,
    usedAxiosParams: false,
    httpStatus: result.status,
    errorTextShort: result.error?.slice(0, 100),
    success: result.success,
  };
  authStory.addAttempt(attempt);

  // Step 6: Build and print debug bundle
  const debugBundle = buildDebugBundle(identity, creds, request, selfCheck);
  printDebugBundle(debugBundle, config.debugAuthProbe);

  // Step 7: Set final result and print auth story
  if (result.success) {
    logger.info("AUTH_PROBE_OK", {
      category: "SUMMARY",
      status: result.status,
    });

    if (result.data) {
      const dataStr = JSON.stringify(result.data);
      logger.info("Response data", {
        category: "SUMMARY",
        response: dataStr.slice(0, 200) + (dataStr.length > 200 ? "..." : ""),
      });
    }

    logger.info(
      "Authentication successful - credentials and identity are correct",
      {
        category: "SUMMARY",
      },
    );

    authStory.setFinalResult({
      authOk: true,
      readyToTrade: true,
      reason: "Authentication successful",
    });
    authStory.printSummary();

    return 0;
  } else {
    logger.error("AUTH_PROBE_FAIL", {
      category: "SUMMARY",
      status: result.status || "unknown",
      error: result.error || "Unknown error",
    });

    let reason = `Authentication failed: ${result.status || "unknown"}`;
    if (result.status === 401) {
      logger.error("401 Unauthorized - Most likely causes:", {
        category: "SUMMARY",
      });
      logger.error(
        "1. HMAC signature mismatch (check secret encoding, message format)",
        {
          category: "SUMMARY",
        },
      );
      logger.error(
        "2. Invalid API credentials (regenerate with deriveApiKey)",
        {
          category: "SUMMARY",
        },
      );
      logger.error(
        "3. Wallet address mismatch (POLY_ADDRESS header != actual wallet)",
        {
          category: "SUMMARY",
        },
      );
      logger.error("4. Timestamp skew (check system clock)", {
        category: "SUMMARY",
      });
      reason =
        "401 Unauthorized - HMAC signature mismatch or invalid credentials";
    } else if (result.status === 403) {
      logger.error("403 Forbidden - Possible causes:", { category: "SUMMARY" });
      logger.error("1. Account restricted or banned", { category: "SUMMARY" });
      logger.error("2. Geographic restrictions (geoblock)", {
        category: "SUMMARY",
      });
      reason = "403 Forbidden - Account restricted or geoblocked";
    } else {
      logger.error("Check network connectivity and CLOB_HOST", {
        category: "SUMMARY",
      });
      reason = `${result.status || "Network error"} - Check connectivity`;
    }

    authStory.setFinalResult({
      authOk: false,
      readyToTrade: false,
      reason,
    });
    authStory.printSummary();

    return 1;
  }
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  // Initialize logger first
  getLogger();

  const config = loadConfig();

  if (config.debugPreflightMatrix) {
    const wallet = new Wallet(config.privateKey);
    await runPreflightMatrix(config, wallet);
    process.exit(0);
  }

  const exitCode = await runProbe(config);
  process.exit(exitCode);
}

// Run the probe
main().catch((error) => {
  const logger = getLogger();
  logger.error("FATAL ERROR", {
    category: "STARTUP",
    error: error?.message || String(error),
    stack: error?.stack,
  });
  process.exit(1);
});
