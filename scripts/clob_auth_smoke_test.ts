#!/usr/bin/env ts-node

/**
 * Polymarket CLOB Authentication Smoke Test
 *
 * This standalone script tests the complete authentication flow:
 * 1. L1 authentication (derive/create API key using EIP-712)
 * 2. L2 authentication (balance-allowance using HMAC)
 *
 * Usage:
 *   ts-node scripts/clob_auth_smoke_test.ts
 *
 * Environment Variables:
 *   PRIVATE_KEY           - Required: Private key of the signer EOA
 *   CLOB_HOST             - Optional: CLOB API host (default: https://clob.polymarket.com)
 *   CLOB_FUNDER           - Optional: Funder/proxy address for Safe/Proxy mode
 *   CLOB_SIGNATURE_TYPE   - Optional: 0=EOA, 1=Proxy, 2=Safe (default: 0)
 *   RPC_URL               - Optional: Polygon RPC URL (default: https://polygon-rpc.com)
 */

import { ClobClient, Chain, AssetType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet, providers } from "ethers";
import { SignatureType } from "@polymarket/order-utils";

// Configuration from environment
const config = {
  privateKey: process.env.PRIVATE_KEY,
  clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
  rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",
  funderAddress:
    process.env.CLOB_FUNDER || process.env.POLYMARKET_PROXY_ADDRESS,
  signatureType: parseInt(
    process.env.CLOB_SIGNATURE_TYPE ||
      process.env.POLYMARKET_SIGNATURE_TYPE ||
      "0",
    10,
  ),
};

// Colors for console output
const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

function log(message: string, color: keyof typeof colors = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message: string): void {
  console.log("\n" + "=".repeat(70));
  log(message, "blue");
  console.log("=".repeat(70) + "\n");
}

function error(message: string): void {
  log(`❌ ERROR: ${message}`, "red");
}

function success(message: string): void {
  log(`✅ ${message}`, "green");
}

function info(message: string): void {
  log(`ℹ️  ${message}`, "cyan");
}

function warn(message: string): void {
  log(`⚠️  ${message}`, "yellow");
}

async function validateEnvironment(): Promise<boolean> {
  header("1. Validating Environment");

  if (!config.privateKey) {
    error("PRIVATE_KEY environment variable is required");
    return false;
  }

  if (!config.privateKey.startsWith("0x")) {
    config.privateKey = "0x" + config.privateKey;
  }

  if (config.privateKey.length !== 66) {
    error(
      `Invalid private key length: ${config.privateKey.length} (expected 66 with 0x prefix)`,
    );
    return false;
  }

  success(
    `Private Key: ${config.privateKey.slice(0, 6)}...${config.privateKey.slice(-4)}`,
  );
  success(`CLOB Host: ${config.clobHost}`);
  success(`RPC URL: ${config.rpcUrl}`);
  success(
    `Signature Type: ${config.signatureType} (${getSignatureTypeName(config.signatureType)})`,
  );

  if (config.funderAddress) {
    success(`Funder Address: ${config.funderAddress}`);
    if (config.signatureType === 0) {
      warn(
        "Funder address provided but signature type is EOA (0). This is unusual.",
      );
    }
  } else if (config.signatureType === 1 || config.signatureType === 2) {
    error(
      `Signature type ${config.signatureType} requires CLOB_FUNDER or POLYMARKET_PROXY_ADDRESS`,
    );
    return false;
  }

  return true;
}

function getSignatureTypeName(type: number): string {
  switch (type) {
    case SignatureType.EOA:
      return "EOA";
    case SignatureType.POLY_PROXY:
      return "Proxy";
    case SignatureType.POLY_GNOSIS_SAFE:
      return "Gnosis Safe";
    default:
      return "Unknown";
  }
}

async function testWalletConnection(): Promise<Wallet | null> {
  header("2. Testing Wallet Connection");

  try {
    const provider = new providers.JsonRpcProvider(config.rpcUrl);
    const wallet = new Wallet(config.privateKey!, provider);
    const address = await wallet.getAddress();

    success(`Wallet Address: ${address}`);

    // Check balance
    const balance = await provider.getBalance(address);
    const balanceMatic = parseFloat(balance.toString()) / 1e18;

    if (balanceMatic > 0.01) {
      success(`POL Balance: ${balanceMatic.toFixed(4)} POL`);
    } else {
      warn(
        `POL Balance: ${balanceMatic.toFixed(4)} POL (LOW - may not have gas for transactions)`,
      );
    }

    return wallet;
  } catch (err) {
    error(
      `Wallet connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function testL1Auth(wallet: Wallet): Promise<ApiKeyCreds | null> {
  header("3. Testing L1 Authentication (Derive/Create API Key)");

  info("Creating CLOB client for L1 auth...");
  const client = new ClobClient(
    config.clobHost,
    Chain.POLYGON,
    wallet,
    undefined, // No creds yet
    config.signatureType,
    config.funderAddress,
  );

  // Try deriveApiKey first
  info("Attempting to derive API key (for existing wallets)...");
  try {
    const deriveFn = client as ClobClient & {
      deriveApiKey?: () => Promise<ApiKeyCreds>;
    };

    if (!deriveFn.deriveApiKey) {
      warn("deriveApiKey method not available on client");
      return null;
    }

    const creds = await deriveFn.deriveApiKey();

    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      error("Derived credentials are incomplete");
      info(`  key: ${creds?.key ? "present" : "missing"}`);
      info(`  secret: ${creds?.secret ? "present" : "missing"}`);
      info(`  passphrase: ${creds?.passphrase ? "present" : "missing"}`);
      return null;
    }

    success("API Key derived successfully");
    info(`  API Key: ${creds.key.slice(0, 8)}...${creds.key.slice(-4)}`);
    info(`  Secret: ${creds.secret.slice(0, 8)}...${creds.secret.slice(-4)}`);
    info(
      `  Passphrase: ${creds.passphrase.slice(0, 4)}...${creds.passphrase.slice(-4)}`,
    );

    return creds;
  } catch (deriveErr) {
    const deriveError = deriveErr as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    const status = deriveError?.response?.status;
    const message = deriveError?.message || String(deriveErr);

    if (status === 401 && message.includes("Invalid L1 Request headers")) {
      error("L1 authentication failed with 'Invalid L1 Request headers'");
      error("This indicates that L1 headers are not correctly formatted");
      info(
        "Expected L1 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE",
      );
      info("Should NOT include: POLY_API_KEY, POLY_PASSPHRASE");
      return null;
    }

    if (
      status === 400 &&
      message.toLowerCase().includes("could not create api key")
    ) {
      warn("Wallet has not traded on Polymarket yet");
      info(
        "To fix: Visit polymarket.com, connect this wallet, and make at least one trade",
      );
      return null;
    }

    error(`deriveApiKey failed: ${status || "unknown"} - ${message}`);

    // Try createApiKey as fallback
    info("Attempting to create new API key...");
    try {
      const createFn = client as ClobClient & {
        createApiKey?: () => Promise<ApiKeyCreds>;
      };

      if (!createFn.createApiKey) {
        warn("createApiKey method not available on client");
        return null;
      }

      const creds = await createFn.createApiKey();

      if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
        error("Created credentials are incomplete");
        return null;
      }

      success("API Key created successfully");
      info(`  API Key: ${creds.key.slice(0, 8)}...${creds.key.slice(-4)}`);
      info(`  Secret: ${creds.secret.slice(0, 8)}...${creds.secret.slice(-4)}`);
      info(
        `  Passphrase: ${creds.passphrase.slice(0, 4)}...${creds.passphrase.slice(-4)}`,
      );

      return creds;
    } catch (createErr) {
      const createError = createErr as {
        response?: { status?: number };
        message?: string;
      };
      error(
        `createApiKey failed: ${createError?.response?.status || "unknown"} - ${createError?.message || String(createErr)}`,
      );
      return null;
    }
  }
}

async function testL2Auth(
  wallet: Wallet,
  creds: ApiKeyCreds,
): Promise<boolean> {
  header("4. Testing L2 Authentication (Balance Allowance)");

  info("Creating CLOB client with credentials...");
  const client = new ClobClient(
    config.clobHost,
    Chain.POLYGON,
    wallet,
    creds,
    config.signatureType,
    config.funderAddress,
  );

  info("Fetching balance allowance...");
  try {
    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // Check for error response
    const errorResponse = response as { status?: number; error?: string };
    if (errorResponse.status === 401 || errorResponse.status === 403) {
      error(
        `Balance allowance failed: ${errorResponse.status} ${errorResponse.error ?? "Unauthorized"}`,
      );
      info("This indicates L2 HMAC signature is incorrect");
      info(
        "Expected L2 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE",
      );
      info(
        "HMAC message format: timestamp + method + path (with query params) + body",
      );
      return false;
    }

    if (errorResponse.error) {
      error(`Balance allowance returned error: ${errorResponse.error}`);
      return false;
    }

    // Check if response has balance data
    const balanceData = response as { balance?: string; allowance?: string };
    if (
      balanceData.balance !== undefined ||
      balanceData.allowance !== undefined
    ) {
      success("Balance allowance fetched successfully");
      info(`  Balance: ${balanceData.balance || "N/A"}`);
      info(`  Allowance: ${balanceData.allowance || "N/A"}`);
      return true;
    }

    // Response structure might be different, but if we got here without errors, it's likely OK
    success("Balance allowance request succeeded");
    info(`  Response: ${JSON.stringify(response).slice(0, 100)}...`);
    return true;
  } catch (err) {
    const error = err as { response?: { status?: number }; message?: string };
    const status = error?.response?.status;
    const message = error?.message || String(err);

    if (status === 401 || status === 403) {
      log(`❌ Balance allowance failed: ${status} Unauthorized`, "red");
      info("This indicates L2 HMAC signature is incorrect");
      info("Common issues:");
      info("  - Secret not decoded correctly (base64 vs base64url)");
      info("  - Query parameters not included in signature");
      info("  - POLY_ADDRESS mismatch (should be funder address in Safe mode)");
      return false;
    }

    log(`❌ Balance allowance failed: ${message}`, "red");
    return false;
  }
}

async function main(): Promise<void> {
  console.log("\n");
  log(
    "╔═══════════════════════════════════════════════════════════════════╗",
    "cyan",
  );
  log(
    "║         Polymarket CLOB Authentication Smoke Test                ║",
    "cyan",
  );
  log(
    "╚═══════════════════════════════════════════════════════════════════╝",
    "cyan",
  );

  // Step 1: Validate environment
  const envValid = await validateEnvironment();
  if (!envValid) {
    error("Environment validation failed. Exiting.");
    process.exit(1);
  }

  // Step 2: Test wallet connection
  const wallet = await testWalletConnection();
  if (!wallet) {
    error("Wallet connection failed. Exiting.");
    process.exit(1);
  }

  // Step 3: Test L1 authentication
  const creds = await testL1Auth(wallet);
  if (!creds) {
    error("L1 authentication failed. Exiting.");
    process.exit(1);
  }

  // Step 4: Test L2 authentication
  const l2Success = await testL2Auth(wallet, creds);
  if (!l2Success) {
    error("L2 authentication failed. Exiting.");
    process.exit(1);
  }

  // All tests passed!
  header("Summary");
  success("AUTH OK - All authentication tests passed!");
  info("Your configuration is correct and ready for use.");
  console.log("\n");
  process.exit(0);
}

// Run the test
main().catch((err) => {
  console.error("\n");
  error(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
