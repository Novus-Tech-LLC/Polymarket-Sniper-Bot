/**
 * Simple test: Authenticate with ONLY a private key (like pmxt)
 * This should work out of the box with no additional configuration.
 */

import "dotenv/config";
import { PolymarketAuth } from "./src/clob/polymarket-auth";
import { ConsoleLogger } from "./src/utils/logger.util";

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    logger.error("PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  logger.info("========================================");
  logger.info("Testing Polymarket Authentication");
  logger.info("========================================");
  logger.info("Input: PRIVATE_KEY only");
  logger.info(
    "Expected: Auto-derive credentials and authenticate successfully",
  );
  logger.info("");

  try {
    const auth = new PolymarketAuth({
      privateKey,
      logger,
    });

    logger.info(`Signer address: ${auth.getAddress()}`);
    logger.info(`Signature type: ${auth.getSignatureType()} (0=EOA)`);
    logger.info("");
    logger.info("Attempting authentication...");

    const result = await auth.authenticate();

    if (result.success) {
      logger.info("✅ SUCCESS: Authentication complete");
      logger.info(`  Credentials derived: ${result.derived}`);
      logger.info(`  API key suffix: ...${result.creds?.key.slice(-6)}`);
      logger.info("");
      logger.info("Getting CLOB client...");

      const client = await auth.getClobClient();
      logger.info("✅ CLOB client created successfully");
      logger.info("");
      logger.info("========================================");
      logger.info(
        "✅ AUTH TEST PASSED - Can create client with PRIVATE_KEY only!",
      );
      logger.info("========================================");
      logger.info(
        "Note: Full API test skipped (requires real wallet with funds)",
      );
      process.exit(0);
    } else {
      logger.error("❌ FAILED: Authentication failed");
      logger.error(`  Error: ${result.error}`);
      logger.error("");
      logger.error("========================================");
      logger.error("❌ TEST FAILED - Cannot authenticate with PRIVATE_KEY");
      logger.error("========================================");
      process.exit(1);
    }
  } catch (error) {
    logger.error("❌ EXCEPTION: Test crashed");
    logger.error(String(error));
    logger.error("");
    logger.error("========================================");
    logger.error("❌ TEST CRASHED - Critical authentication bug");
    logger.error("========================================");
    process.exit(1);
  }
}

main();
