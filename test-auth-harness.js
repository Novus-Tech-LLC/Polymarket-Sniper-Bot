#!/usr/bin/env node

/**
 * Enhanced Authentication Test Harness
 *
 * This CLI script provides comprehensive authentication testing for Polymarket CLOB.
 * It tests the complete authentication flow with deterministic staging and detailed diagnostics.
 *
 * NOTE: This is intentionally a single-file script for ease of deployment and use.
 * It can be run standalone without building the TypeScript codebase.
 *
 * Features:
 * - Deterministic wallet mode selection (EOA vs Safe/Proxy)
 * - Separate L1 and L2 authentication testing
 * - Header inspection and validation
 * - On-chain trade history verification (optional)
 * - Container-friendly operation
 * - Clear pass/fail indicators at each stage
 *
 * Usage:
 *   node test-auth-harness.js [options]
 *
 * Options:
 *   --private-key <key>    Private key (or set PRIVATE_KEY env var)
 *   --funder <address>     Funder/proxy address for Safe/Proxy mode
 *   --signature-type <n>   Signature type: 0=EOA, 1=Proxy, 2=Safe
 *   --check-history        Verify on-chain trade history
 *   --verbose              Enable verbose debug logging
 */

// Load environment variables FIRST before any other imports
require("dotenv").config();

const { ClobClient, Chain, AssetType } = require("@polymarket/clob-client");
const { Wallet, providers } = require("ethers");
const { SignatureType } = require("@polymarket/order-utils");

const POLYMARKET_API_URL = "https://clob.polymarket.com";
const POLYMARKET_WEBSITE_URL = "https://polymarket.com";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    privateKey: process.env.PRIVATE_KEY,
    rpcUrl: process.env.RPC_URL || "https://polygon-rpc.com",
    funder:
      process.env.POLYMARKET_PROXY_ADDRESS || process.env.CLOB_FUNDER_ADDRESS,
    signatureType: parseInt(
      process.env.POLYMARKET_SIGNATURE_TYPE ||
        process.env.CLOB_SIGNATURE_TYPE ||
        "0",
    ),
    checkHistory: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--private-key":
        options.privateKey = args[++i];
        break;
      case "--funder":
        options.funder = args[++i];
        break;
      case "--signature-type":
        options.signatureType = parseInt(args[++i]);
        break;
      case "--check-history":
        options.checkHistory = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- process.exit() never returns
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Enhanced Authentication Test Harness

Usage: node test-auth-harness.js [options]

Options:
  --private-key <key>       Private key (or set PRIVATE_KEY env var)
  --funder <address>        Funder/proxy address for Safe/Proxy mode
  --signature-type <n>      Signature type: 0=EOA, 1=Proxy, 2=Safe (default: 0)
  --check-history           Verify on-chain trade history
  --verbose                 Enable verbose debug logging
  --help, -h                Show this help message

Environment Variables:
  PRIVATE_KEY               Private key (required)
  RPC_URL                   Polygon RPC endpoint (default: https://polygon-rpc.com)
  POLYMARKET_PROXY_ADDRESS  Proxy address for Safe/Proxy mode
  POLYMARKET_SIGNATURE_TYPE Signature type (0, 1, or 2)

Examples:
  # Test EOA wallet
  node test-auth-harness.js

  # Test Gnosis Safe wallet
  node test-auth-harness.js --signature-type 2 --funder 0xYourSafeAddress

  # Test with on-chain verification
  node test-auth-harness.js --check-history --verbose
`);
}

// Colors for console output
const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logVerbose(message, options) {
  if (options.verbose) {
    log(`  [DEBUG] ${message}`, "cyan");
  }
}

function header(message, stage = "") {
  console.log("\n" + "=".repeat(70));
  log(`${stage ? `${stage}: ` : ""}${message}`, "bold");
  console.log("=".repeat(70));
}

function section(message) {
  console.log();
  log(`${message}`, "blue");
  console.log("-".repeat(70));
}

// Determine wallet mode based on configuration
function determineWalletMode(options) {
  const { signatureType, funder } = options;

  if (signatureType === SignatureType.POLY_GNOSIS_SAFE) {
    if (!funder) {
      log(
        "⚠️  WARNING: signatureType=2 (Safe) but no funder address configured",
        "yellow",
      );
      log("   Falling back to EOA mode", "yellow");
      return {
        mode: "eoa",
        sigType: SignatureType.EOA,
        description: "EOA (default)",
      };
    }
    return {
      mode: "safe",
      sigType: SignatureType.POLY_GNOSIS_SAFE,
      description: "Gnosis Safe",
    };
  }

  if (signatureType === SignatureType.POLY_PROXY) {
    if (!funder) {
      log(
        "⚠️  WARNING: signatureType=1 (Proxy) but no funder address configured",
        "yellow",
      );
      log("   Falling back to EOA mode", "yellow");
      return {
        mode: "eoa",
        sigType: SignatureType.EOA,
        description: "EOA (default)",
      };
    }
    return {
      mode: "proxy",
      sigType: SignatureType.POLY_PROXY,
      description: "Polymarket Proxy",
    };
  }

  return {
    mode: "eoa",
    sigType: SignatureType.EOA,
    description: "EOA (standard wallet)",
  };
}

// Test L1 Authentication (derive/create API keys)
async function testL1Authentication(wallet, walletMode, options) {
  section("STAGE 1: L1 Authentication (Derive/Create API Keys)");

  log(`Wallet Mode: ${walletMode.description}`, "blue");
  log(`Signature Type: ${walletMode.sigType}`, "blue");
  log(`Signer Address: ${await wallet.getAddress()}`, "blue");
  if (options.funder) {
    log(`Funder/Proxy Address: ${options.funder}`, "blue");
  }

  try {
    const client = new ClobClient(
      POLYMARKET_API_URL,
      Chain.POLYGON,
      wallet,
      undefined, // No creds yet
      walletMode.sigType,
      options.funder,
    );

    // Try deriveApiKey first
    log("\n  → Attempting deriveApiKey()...", "blue");
    logVerbose("L1 endpoint: GET /auth/derive-api-key", options);
    logVerbose(
      "Expected headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE",
      options,
    );

    let creds;
    try {
      creds = await client.deriveApiKey();

      if (creds && creds.key && creds.secret && creds.passphrase) {
        log("  ✅ L1 AUTH OK - deriveApiKey succeeded", "green");
        if (options.verbose) {
          log(
            `     API Key: ${creds.key.slice(0, 8)}...${creds.key.slice(-8)}`,
            "green",
          );
        } else {
          log("     API Key: [REDACTED - use --verbose to show]", "green");
        }
        return { success: true, creds, method: "derive" };
      } else {
        log(
          "  ❌ L1 AUTH FAIL - deriveApiKey returned incomplete credentials",
          "red",
        );
        return {
          success: false,
          error: "Incomplete credentials from deriveApiKey",
        };
      }
    } catch (deriveError) {
      const status = deriveError.response?.status;
      const message =
        deriveError.message ||
        deriveError.response?.data ||
        String(deriveError);

      logVerbose(`deriveApiKey error: ${message}`, options);

      // Check for specific error types
      if (
        status === 401 &&
        message.toLowerCase().includes("invalid l1 request headers")
      ) {
        log("  ❌ L1 AUTH FAIL - Invalid L1 Request headers", "red");
        log(
          "     This means the L1 authentication signature is incorrect",
          "yellow",
        );
        log("     Possible causes:", "yellow");
        log(
          "       - Wrong address used for L1 auth (signer vs effective)",
          "yellow",
        );
        log("       - Incorrect signature type for this wallet", "yellow");
        return {
          success: false,
          error: "Invalid L1 Request headers",
          stage: "L1",
        };
      }

      // Try createApiKey as fallback
      log("  ⚠️  deriveApiKey failed, trying createApiKey()...", "yellow");
      logVerbose("L1 endpoint: POST /auth/api-key", options);

      try {
        creds = await client.createApiKey();

        if (creds && creds.key && creds.secret && creds.passphrase) {
          log("  ✅ L1 AUTH OK - createApiKey succeeded", "green");
          if (options.verbose) {
            log(
              `     API Key: ${creds.key.slice(0, 8)}...${creds.key.slice(-8)}`,
              "green",
            );
          } else {
            log("     API Key: [REDACTED - use --verbose to show]", "green");
          }
          return { success: true, creds, method: "create" };
        } else {
          log(
            "  ❌ L1 AUTH FAIL - createApiKey returned incomplete credentials",
            "red",
          );
          return {
            success: false,
            error: "Incomplete credentials from createApiKey",
          };
        }
      } catch (createError) {
        const createStatus = createError.response?.status;
        const createMessage =
          createError.message ||
          createError.response?.data ||
          String(createError);

        logVerbose(`createApiKey error: ${createMessage}`, options);

        if (
          createStatus === 400 &&
          createMessage.toLowerCase().includes("could not create api key")
        ) {
          log("  ❌ L1 AUTH FAIL - Could not create API key", "red");
          log("     This wallet has never traded on Polymarket", "yellow");
          log(
            `     Action required: Visit ${POLYMARKET_WEBSITE_URL} and make at least one trade`,
            "yellow",
          );
          return {
            success: false,
            error: "Wallet never traded",
            stage: "L1",
            requiresTrade: true,
          };
        }

        if (
          createStatus === 401 &&
          createMessage.toLowerCase().includes("invalid l1 request headers")
        ) {
          log("  ❌ L1 AUTH FAIL - Invalid L1 Request headers", "red");
          return {
            success: false,
            error: "Invalid L1 Request headers",
            stage: "L1",
          };
        }

        log("  ❌ L1 AUTH FAIL - createApiKey error", "red");
        log(`     Status: ${createStatus || "unknown"}`, "red");
        log(`     Message: ${createMessage}`, "red");
        return { success: false, error: createMessage, stage: "L1" };
      }
    }
  } catch (error) {
    log(`  ❌ L1 AUTH FAIL - Unexpected error: ${error.message}`, "red");
    return { success: false, error: error.message, stage: "L1" };
  }
}

// Test L2 Authentication (balance-allowance verification)
async function testL2Authentication(wallet, creds, walletMode, options) {
  section("STAGE 2: L2 Authentication (Balance-Allowance Verification)");

  log("Testing credentials with /balance-allowance endpoint...", "blue");
  logVerbose(
    "L2 endpoint: GET /balance-allowance?asset_type=COLLATERAL&signature_type=X",
    options,
  );
  logVerbose(
    "Expected headers: POLY_ADDRESS, POLY_SIGNATURE (HMAC), POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE",
    options,
  );

  try {
    const client = new ClobClient(
      POLYMARKET_API_URL,
      Chain.POLYGON,
      wallet,
      creds,
      walletMode.sigType,
      options.funder,
    );

    log(
      `\n  → Testing signature type ${walletMode.sigType} (${walletMode.description})...`,
      "blue",
    );

    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // Check for error response
    if (response.status === 401 || response.status === 403 || response.error) {
      log("  ❌ L2 AUTH FAIL - Unauthorized/Invalid api key", "red");
      log(`     Status: ${response.status || "unknown"}`, "red");
      log(`     Error: ${response.error || "Unauthorized"}`, "red");
      log("     Possible causes:", "yellow");
      log("       - API credentials are expired or invalid", "yellow");
      log("       - Wrong signature type for L2 requests", "yellow");
      log("       - HMAC signature mismatch", "yellow");
      return {
        success: false,
        error: response.error || "Unauthorized",
        stage: "L2",
      };
    }

    log("  ✅ L2 AUTH OK - Balance-allowance check succeeded", "green");
    logVerbose(`Response: ${JSON.stringify(response, null, 2)}`, options);
    return { success: true };
  } catch (error) {
    const status = error.response?.status;
    const message = error.message || error.response?.data || String(error);

    logVerbose(`L2 error: ${message}`, options);

    if (status === 401 || status === 403) {
      log("  ❌ L2 AUTH FAIL - Unauthorized/Invalid api key", "red");
      log(`     Status: ${status}`, "red");
      log(
        "     This suggests the API credentials or L2 signature is incorrect",
        "yellow",
      );
      return { success: false, error: "Unauthorized", stage: "L2" };
    }

    log(`  ❌ L2 AUTH FAIL - Error: ${message}`, "red");
    return { success: false, error: message, stage: "L2" };
  }
}

// Optional: Check on-chain trade history
async function checkTradeHistory(wallet, options) {
  section("STAGE 3: On-Chain Trade History Verification (Optional)");

  if (!options.checkHistory) {
    log("⏭️  Skipped (use --check-history to enable)", "yellow");
    return { skipped: true };
  }

  log("Checking for on-chain trading activity...", "blue");

  try {
    const provider = new providers.JsonRpcProvider(options.rpcUrl);
    const address = await wallet.getAddress();

    // Check transaction count as a simple heuristic
    const txCount = await provider.getTransactionCount(address);

    log(`  Transaction Count: ${txCount}`, "blue");

    if (txCount === 0) {
      log("  ⚠️  WARNING: No transactions found for this address", "yellow");
      log("     This wallet may not have traded on Polymarket", "yellow");
      return { success: false, warning: "No transactions" };
    }

    if (txCount < 5) {
      log("  ⚠️  WARNING: Very few transactions found", "yellow");
      log("     This wallet may not have traded on Polymarket", "yellow");
      return { success: true, warning: "Low transaction count" };
    }

    log("  ✅ Wallet has on-chain activity", "green");
    return { success: true };
  } catch (error) {
    log(`  ❌ Failed to check history: ${error.message}`, "red");
    return { success: false, error: error.message };
  }
}

// Main test flow
async function runAuthTests() {
  const options = parseArgs();

  // Validate required options
  if (!options.privateKey) {
    log("❌ ERROR: PRIVATE_KEY is required", "red");
    log(
      "   Set via --private-key flag or PRIVATE_KEY environment variable",
      "yellow",
    );
    process.exit(1);
  }

  // Header
  console.log("\n");
  log(
    "╔═══════════════════════════════════════════════════════════════╗",
    "bold",
  );
  log(
    "║      Polymarket Authentication Test Harness                   ║",
    "bold",
  );
  log(
    "╚═══════════════════════════════════════════════════════════════╝",
    "bold",
  );

  const provider = new providers.JsonRpcProvider(options.rpcUrl);
  const wallet = new Wallet(options.privateKey, provider);
  const address = await wallet.getAddress();

  // Configuration summary
  header("Configuration");
  log(`Signer Address: ${address}`, "blue");
  log(`RPC URL: ${options.rpcUrl}`, "blue");
  log(`Signature Type: ${options.signatureType}`, "blue");
  if (options.funder) {
    log(`Funder/Proxy: ${options.funder}`, "blue");
  }
  log(`Verbose Mode: ${options.verbose ? "ON" : "OFF"}`, "blue");
  log(`History Check: ${options.checkHistory ? "ON" : "OFF"}`, "blue");

  // Determine wallet mode
  const walletMode = determineWalletMode(options);
  log(`\nDetermined Wallet Mode: ${walletMode.description}`, "green");

  // Stage 1: L1 Authentication
  const l1Result = await testL1Authentication(wallet, walletMode, options);

  if (!l1Result.success) {
    header("❌ FINAL RESULT: FAILURE", "RESULT");
    log(`Failed at: ${l1Result.stage || "L1"} Authentication`, "red");
    log(`Error: ${l1Result.error}`, "red");

    if (l1Result.requiresTrade) {
      log("\n📋 NEXT STEPS:", "yellow");
      log(`1. Visit ${POLYMARKET_WEBSITE_URL}`, "yellow");
      log(`2. Connect wallet: ${address}`, "yellow");
      log("3. Make at least ONE small trade", "yellow");
      log("4. Wait for transaction to confirm (1-2 minutes)", "yellow");
      log("5. Re-run this diagnostic tool", "yellow");
    } else {
      log("\n📋 TROUBLESHOOTING:", "yellow");
      log("1. Verify your private key is correct", "yellow");
      log("2. Try different signature type (--signature-type 0/1/2)", "yellow");
      log("3. Check if funder address is required (Safe/Proxy mode)", "yellow");
      log("4. Enable verbose mode (--verbose) for more details", "yellow");
    }

    process.exit(1);
  }

  log(`\nCredentials obtained via: ${l1Result.method}`, "green");

  // Stage 2: L2 Authentication
  const l2Result = await testL2Authentication(
    wallet,
    l1Result.creds,
    walletMode,
    options,
  );

  if (!l2Result.success) {
    header("❌ FINAL RESULT: FAILURE", "RESULT");
    log("Failed at: L2 Authentication", "red");
    log(`Error: ${l2Result.error}`, "red");
    log("\n📋 TROUBLESHOOTING:", "yellow");
    log(
      "1. L1 auth succeeded but L2 failed - credentials may be corrupted",
      "yellow",
    );
    log(
      "2. Try clearing cache: rm -f /data/clob-creds.json ./data/clob-creds.json",
      "yellow",
    );
    log("3. Try different signature type for L2 requests", "yellow");
    log("4. Check if API is having issues", "yellow");
    process.exit(1);
  }

  // Stage 3: Trade History (Optional)
  await checkTradeHistory(wallet, options);

  // Success!
  header("✅ FINAL RESULT: SUCCESS", "RESULT");
  log("All authentication stages passed!", "green");
  log("\nStage Results:", "green");
  log("  ✅ L1 Authentication: OK", "green");
  log("  ✅ L2 Authentication: OK", "green");
  log("\nYou can now start the bot with confidence!", "green");

  // Save credentials tip
  log(
    "\n💡 TIP: Credentials can be cached in /data/clob-creds.json for reuse",
    "cyan",
  );

  process.exit(0);
}

// Run the harness
runAuthTests().catch((error) => {
  log(`\n❌ FATAL ERROR: ${error.message}`, "red");
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
