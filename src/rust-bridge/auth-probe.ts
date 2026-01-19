#!/usr/bin/env npx ts-node
/**
 * Rust-based Authentication Probe
 *
 * This script uses the official Polymarket Rust SDK to authenticate and verify
 * trading capability. It automatically tries all signature types and reports
 * which configuration works.
 *
 * Usage:
 *   npm run auth:rust
 *   # or with env vars:
 *   POLYMARKET_PRIVATE_KEY=... POLYMARKET_PROXY_ADDRESS=... npm run auth:rust
 */

import "dotenv/config";
import { createRustBridgeClient } from "../rust-bridge/client";
import { ConsoleLogger } from "../utils/logger.util";

async function main(): Promise<void> {
  const logger = new ConsoleLogger();

  const privateKey =
    process.env.POLYMARKET_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!privateKey) {
    logger.error(
      "[AuthProbe] POLYMARKET_PRIVATE_KEY or PRIVATE_KEY environment variable required",
    );
    process.exit(1);
  }

  const signatureType = process.env.POLYMARKET_SIGNATURE_TYPE
    ? parseInt(process.env.POLYMARKET_SIGNATURE_TYPE, 10)
    : undefined;

  const funderAddress =
    process.env.POLYMARKET_PROXY_ADDRESS ?? process.env.CLOB_FUNDER_ADDRESS;

  logger.info("=".repeat(70));
  logger.info("Polymarket Rust SDK Authentication Probe");
  logger.info("=".repeat(70));
  logger.info("");
  logger.info("Configuration:");
  logger.info(
    `  Private key: [${privateKey.length} chars, starts with ${privateKey.slice(0, 6)}...]`,
  );
  logger.info(`  Signature type: ${signatureType ?? "auto-detect"}`);
  logger.info(
    `  Funder/Proxy address: ${funderAddress ?? "none (will auto-derive)"}`,
  );
  logger.info("");

  const bridge = createRustBridgeClient({
    privateKey,
    signatureType,
    funderAddress,
    logger,
  });

  try {
    logger.info("[AuthProbe] Starting Rust bridge...");
    await bridge.start();

    logger.info(
      "[AuthProbe] Running authentication probe (trying all signature types)...",
    );
    logger.info("");

    const result = await bridge.probe({ funderAddress });

    logger.info("=".repeat(70));
    if (result.success && result.data?.working_config) {
      logger.info("✅ AUTHENTICATION SUCCESSFUL");
      logger.info("=".repeat(70));
      logger.info("");
      logger.info("Working Configuration:");
      logger.info(
        `  Signature Type: ${result.data.working_config.signature_type}`,
      );
      logger.info(
        `  Funder Address: ${result.data.working_config.funder_address ?? "auto-derived"}`,
      );
      logger.info("");
      logger.info("Account Status:");
      logger.info(`  Balance: ${result.data.balance} USDC`);
      logger.info(`  Allowance: ${result.data.allowance}`);
      logger.info("");

      // Output recommended environment variables
      logger.info("Recommended Environment Variables:");
      logger.info(
        "  POLYMARKET_SIGNATURE_TYPE=" +
          (result.data.working_config.signature_type === "EOA"
            ? "0"
            : result.data.working_config.signature_type === "Proxy"
              ? "1"
              : "2"),
      );
      if (result.data.working_config.funder_address) {
        logger.info(
          `  POLYMARKET_PROXY_ADDRESS=${result.data.working_config.funder_address}`,
        );
      }
      logger.info("");

      // Output auth story if available
      if (result.auth_story) {
        logger.info("Auth Story:");
        logger.info(JSON.stringify(result.auth_story, null, 2));
      }

      process.exit(0);
    } else {
      logger.error("❌ AUTHENTICATION FAILED");
      logger.info("=".repeat(70));
      logger.info("");

      if (result.data?.probe_results) {
        logger.info("Probe Results:");
        for (const probe of result.data.probe_results) {
          const status = probe.success ? "✅" : "❌";
          logger.info(
            `  ${status} ${probe.signature_type}: ${probe.error ?? `balance=${probe.balance}`}`,
          );
        }
        logger.info("");
      }

      if (result.data?.recommendation) {
        logger.warn("Recommendation:");
        logger.warn(`  ${result.data.recommendation}`);
        logger.info("");
      }

      logger.info("Most Likely Causes:");
      logger.info("  1. Wallet has never traded on Polymarket");
      logger.info(
        "  2. Missing or incorrect POLYMARKET_PROXY_ADDRESS for browser wallets",
      );
      logger.info("  3. Private key doesn't match the registered wallet");
      logger.info("");
      logger.info("To Fix:");
      logger.info(
        "  1. Go to https://polymarket.com and log in with your wallet",
      );
      logger.info("  2. Make at least one small trade (even $1)");
      logger.info(
        "  3. Find your Polymarket deposit address in Profile > Wallet",
      );
      logger.info("  4. Set POLYMARKET_PROXY_ADDRESS to that address");
      logger.info("  5. Restart the bot");
      logger.info("");

      process.exit(1);
    }
  } catch (error) {
    logger.error(
      `[AuthProbe] Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  } finally {
    await bridge.stop();
  }
}

main();
