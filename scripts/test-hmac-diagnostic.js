#!/usr/bin/env node
/**
 * HMAC Diagnostic Test - Reproduce 401 error with full instrumentation
 *
 * This script:
 * 1. Enables HMAC diagnostic tracing
 * 2. Makes a simple getBalanceAllowance call
 * 3. Captures exact signing inputs vs HTTP request
 * 4. Produces an "Auth Story" on failure
 *
 * Usage:
 *   ENABLE_HMAC_DIAGNOSTICS=true DEBUG_HMAC_SIGNING=true node scripts/test-hmac-diagnostic.js
 */

require("dotenv").config();
const {
  createPolymarketClient,
} = require("../src/infrastructure/clob-client.factory");
const { AssetType } = require("@polymarket/clob-client");

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};

async function main() {
  console.log("=".repeat(80));
  console.log("HMAC DIAGNOSTIC TEST");
  console.log("=".repeat(80));

  if (!process.env.PRIVATE_KEY) {
    logger.error("PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  if (!process.env.POLYMARKET_API_KEY) {
    logger.error("POLYMARKET_API_KEY environment variable is required");
    process.exit(1);
  }

  // Force diagnostics on
  process.env.ENABLE_HMAC_DIAGNOSTICS = "true";
  process.env.DEBUG_HMAC_SIGNING = "true";

  const input = {
    rpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    privateKey: process.env.PRIVATE_KEY,
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    signatureType: process.env.POLYMARKET_SIGNATURE_TYPE
      ? parseInt(process.env.POLYMARKET_SIGNATURE_TYPE, 10)
      : undefined,
    funderAddress: process.env.POLYMARKET_PROXY_ADDRESS,
    logger,
  };

  try {
    logger.info("Creating Polymarket client...");
    const client = await createPolymarketClient(input);

    logger.info("Client created successfully");
    logger.info(`Signature Type: ${client.signatureType || 0}`);
    logger.info(`Effective Address: ${client.effectivePolyAddress}`);

    logger.info("Testing getBalanceAllowance...");
    const balance = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    if (balance.error) {
      logger.error(`API returned error: ${balance.error}`);
      logger.error("Check diagnostic output above for signing details");
      process.exit(1);
    }

    logger.info("✓ Success! Balance retrieved.");
    logger.info(JSON.stringify(balance, null, 2));
    process.exit(0);
  } catch (error) {
    logger.error("Test failed with exception:");
    logger.error(error.message);
    if (error.response) {
      logger.error(
        `HTTP ${error.response.status}: ${error.response.statusText}`,
      );
      logger.error(JSON.stringify(error.response.data, null, 2));
    }
    logger.error("\nCheck diagnostic output above for HMAC mismatch details");
    process.exit(1);
  }
}

main();
