#!/usr/bin/env node

/**
 * Authentication Diagnostic Tool
 *
 * This script helps diagnose authentication issues with Polymarket CLOB API.
 * Run this BEFORE starting the bot to identify potential issues.
 *
 * Usage: node diagnose-auth.js
 */

const { ClobClient } = require("@polymarket/clob-client");
const { Wallet, providers } = require("ethers");
const { SignatureType, Chain } = require("@polymarket/clob-client");
require("dotenv").config();

const POLYMARKET_API_URL = "https://clob.polymarket.com";

// Colors for console output
const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  console.log("\n" + "=".repeat(70));
  log(message, "blue");
  console.log("=".repeat(70) + "\n");
}

async function checkEnvironmentVariables() {
  header("1. Checking Environment Variables");

  const required = ["PRIVATE_KEY", "RPC_URL"];
  const optional = [
    "POLYMARKET_API_KEY",
    "POLYMARKET_API_SECRET",
    "POLYMARKET_API_PASSPHRASE",
  ];

  let allPresent = true;

  for (const key of required) {
    if (process.env[key]) {
      log(`✅ ${key}: Present`, "green");
    } else {
      log(`❌ ${key}: Missing (REQUIRED)`, "red");
      allPresent = false;
    }
  }

  let hasManualCreds = true;
  for (const key of optional) {
    if (process.env[key]) {
      log(`✅ ${key}: Present`, "green");
    } else {
      hasManualCreds = false;
    }
  }

  if (!hasManualCreds) {
    log(
      `ℹ️  Manual CLOB credentials not found - will try auto-derive`,
      "yellow",
    );
  }

  return allPresent;
}

async function checkWalletConnection() {
  header("2. Checking Wallet Connection");

  try {
    const provider = new providers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
    const address = await wallet.getAddress();

    log(`✅ Wallet Address: ${address}`, "green");

    // Check balance
    const balance = await provider.getBalance(address);
    const balanceEth = parseFloat(balance.toString()) / 1e18;

    if (balanceEth > 0.01) {
      log(`✅ POL Balance: ${balanceEth.toFixed(4)} POL`, "green");
    } else {
      log(
        `⚠️  POL Balance: ${balanceEth.toFixed(4)} POL (LOW - need gas for transactions)`,
        "yellow",
      );
    }

    return { address, provider, wallet };
  } catch (error) {
    log(`❌ Wallet connection failed: ${error.message}`, "red");
    return null;
  }
}

async function checkPolymarketAPI() {
  header("3. Checking Polymarket API Connection");

  try {
    // Use axios which is already a dependency
    const axios = require("axios");
    const response = await axios.get(`${POLYMARKET_API_URL}/time`);
    if (response.status === 200) {
      log(`✅ Polymarket API is reachable`, "green");
      log(`   Server time: ${response.data.timestamp || "unknown"}`, "blue");
      return true;
    } else {
      log(`⚠️  Polymarket API returned status ${response.status}`, "yellow");
      return false;
    }
  } catch (error) {
    log(`❌ Cannot reach Polymarket API: ${error.message}`, "red");
    return false;
  }
}

async function testAuthenticationFlow(wallet) {
  header("4. Testing Authentication Flow");

  log("Attempting to derive API credentials...", "blue");

  try {
    const client = new ClobClient(
      POLYMARKET_API_URL,
      Chain.POLYGON,
      wallet,
      undefined,
      SignatureType.EOA,
    );

    log("Step 1: Calling deriveApiKey...", "blue");
    let creds;
    try {
      creds = await client.deriveApiKey();

      if (creds && creds.key && creds.secret && creds.passphrase) {
        log(`✅ deriveApiKey returned credentials`, "green");
        log(`   API Key (last 8): ...${creds.key.slice(-8)}`, "blue");
      } else {
        log(`⚠️  deriveApiKey returned incomplete credentials`, "yellow");
        return false;
      }
    } catch (error) {
      log(`❌ deriveApiKey failed: ${error.message}`, "red");

      log("\nStep 2: Trying createApiKey...", "blue");
      try {
        creds = await client.createApiKey();
        if (creds && creds.key) {
          log(`✅ createApiKey returned credentials`, "green");
        } else {
          log(`❌ createApiKey failed to return valid credentials`, "red");
          log(
            `\n⚠️  POSSIBLE CAUSE: Wallet may not have traded on Polymarket yet`,
            "yellow",
          );
          log(`   If this wallet is new to Polymarket:`, "yellow");
          log(`   1. Visit https://polymarket.com`, "yellow");
          log(
            `   2. Connect your wallet (${await wallet.getAddress()})`,
            "yellow",
          );
          log(`   3. Make at least ONE small trade`, "yellow");
          log(`   4. Wait for transaction to confirm`, "yellow");
          log(`   5. Re-run this diagnostic`, "yellow");
          log(
            `\n   If wallet HAS traded, this could be a network/API issue. Try again in a few minutes.`,
            "yellow",
          );
          return false;
        }
      } catch (createError) {
        const isWalletIssue =
          createError.message?.includes("Could not create api key") ||
          createError.response?.status === 400;

        if (isWalletIssue) {
          log(
            `❌ createApiKey failed: Wallet not eligible for API key creation`,
            "red",
          );
          log(`\n⚠️  WALLET HAS NEVER TRADED ON POLYMARKET`, "yellow");
          log(`   Action required:`, "yellow");
          log(`   1. Visit https://polymarket.com`, "yellow");
          log(
            `   2. Connect your wallet (${await wallet.getAddress()})`,
            "yellow",
          );
          log(`   3. Make at least ONE small trade`, "yellow");
          log(`   4. Wait for transaction to confirm`, "yellow");
          log(`   5. Re-run this diagnostic`, "yellow");
        } else {
          log(
            `❌ createApiKey failed with error: ${createError.message}`,
            "red",
          );
          log(
            `   This could be a network issue, rate limiting, or API problem.`,
            "yellow",
          );
        }
        return false;
      }
    }

    log(
      "\nStep 3: Verifying credentials with signature type auto-detection...",
      "blue",
    );

    const signatureTypes = [
      { type: SignatureType.EOA, name: "EOA (Standard Wallet)" },
      { type: SignatureType.POLY_GNOSIS_SAFE, name: "Gnosis Safe" },
      { type: SignatureType.POLY_PROXY, name: "Polymarket Proxy" },
    ];

    for (const { type, name } of signatureTypes) {
      log(`   Testing ${name} (type ${type})...`, "blue");

      try {
        const verifyClient = new ClobClient(
          POLYMARKET_API_URL,
          Chain.POLYGON,
          wallet,
          creds,
          type,
        );

        const result = await verifyClient.getBalanceAllowance({
          asset_type: "COLLATERAL",
        });

        // Check if result has data (success) or is an error response
        if (result && typeof result === "object") {
          // ClobClient returns error objects instead of throwing
          if (result.error || result.status === 401 || result.status === 403) {
            log(
              `   ❌ ${name} failed: ${result.error || "Unauthorized"}`,
              "red",
            );
          } else {
            // Has data, no error field, not 401/403 status
            log(`   ✅ ${name} works!`, "green");
            return true;
          }
        } else {
          log(`   ❌ ${name} failed: Invalid response`, "red");
        }
      } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          log(`   ❌ ${name} failed: ${status} Unauthorized`, "red");
        } else {
          log(`   ❌ ${name} failed: ${error.message}`, "red");
        }
      }
    }

    log(`\n❌ All signature types failed verification`, "red");
    log(
      `   This suggests credentials are invalid or there's an API issue`,
      "yellow",
    );
    return false;
  } catch (error) {
    log(`❌ Authentication test failed: ${error.message}`, "red");
    return false;
  }
}

async function main() {
  console.log("\n");
  log(
    "╔═══════════════════════════════════════════════════════════════╗",
    "blue",
  );
  log(
    "║  Polymarket Authentication Diagnostic Tool                     ║",
    "blue",
  );
  log(
    "╚═══════════════════════════════════════════════════════════════╝",
    "blue",
  );

  // Step 1: Check environment
  const envOk = await checkEnvironmentVariables();
  if (!envOk) {
    log("\n❌ Please fix environment variables before continuing", "red");
    process.exit(1);
  }

  // Step 2: Check wallet
  const walletResult = await checkWalletConnection();
  if (!walletResult) {
    log(
      "\n❌ Wallet connection failed - please check RPC_URL and PRIVATE_KEY",
      "red",
    );
    process.exit(1);
  }

  // Step 3: Check API
  const apiOk = await checkPolymarketAPI();
  if (!apiOk) {
    log("\n⚠️  Warning: Polymarket API may be unreachable", "yellow");
  }

  // Step 4: Test authentication
  const authOk = await testAuthenticationFlow(walletResult.wallet);

  // Final summary
  header("Diagnostic Summary");
  if (authOk) {
    log("✅ All checks passed! Authentication should work.", "green");
    log("   You can now start the bot with confidence.", "green");
  } else {
    log("❌ Authentication checks failed.", "red");
    log("   Please review the errors above and take corrective action.", "red");
  }

  console.log("\n");
}

main().catch((error) => {
  log(`\n❌ Diagnostic failed with error: ${error.message}`, "red");
  console.error(error);
  process.exit(1);
});
