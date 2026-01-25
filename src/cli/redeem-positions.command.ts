/**
 * CLI command to manually redeem resolved (winning/losing) positions
 *
 * Usage:
 *   npx ts-node src/cli/redeem-positions.command.ts [--exclude-losses] [--min-value=X]
 *
 * Options:
 *   --exclude-losses  Exclude $0 positions (losers) from redemption. Default: false (losses included)
 *   --min-value=X     Minimum position value in USD to redeem. Default: 0.01
 *
 * Environment variables:
 *   PRIVATE_KEY - Required: Your wallet private key
 *   RPC_URL - Required: Polygon RPC endpoint
 *
 * This command:
 *   1. Fetches all your positions from Polymarket
 *   2. Identifies positions marked as redeemable (resolved markets)
 *   3. Performs on-chain preflight check (payoutDenominator > 0)
 *   4. Calls the CTF contract to redeem them for USDC
 *
 * By default:
 *   - $0 losers are INCLUDED (redeemed for cleanup)
 *   - Positions not yet resolved on-chain are SKIPPED
 *   - Use --exclude-losses to skip $0 positions if you want to save gas
 */

import "dotenv/config";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";
import { ConsoleLogger } from "../utils/logger.util";
import { AutoRedeemStrategy } from "../strategies/auto-redeem";

// Parse CLI arguments
function parseArgs(): { includeLosses: boolean; minValueUsd: number } {
  const args = process.argv.slice(2);
  let includeLosses = true; // Default: include losses for cleanup
  let minValueUsd = 0.01; // Default: skip positions worth less than 1 cent

  for (const arg of args) {
    if (arg === "--exclude-losses" || arg === "--no-include-losses") {
      includeLosses = false;
    } else if (arg === "--include-losses") {
      // Keep for backward compatibility (now a no-op since it's the default)
      includeLosses = true;
    } else if (arg.startsWith("--min-value=")) {
      const value = parseFloat(arg.split("=")[1]);
      if (!isNaN(value) && value >= 0) {
        minValueUsd = value;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: npx ts-node src/cli/redeem-positions.command.ts [options]

Options:
  --exclude-losses    Exclude $0 positions (losers) from redemption (saves gas)
  --include-losses    Include $0 positions (losers) in redemption (default, for cleanup)
  --min-value=X       Minimum position value in USD to redeem (default: 0.01)
  --help, -h          Show this help message

Examples:
  # Redeem all positions including $0 losers (default)
  npx ts-node src/cli/redeem-positions.command.ts

  # Exclude $0 losers (save gas, skip cleanup)
  npx ts-node src/cli/redeem-positions.command.ts --exclude-losses

  # Only redeem positions worth at least $1
  npx ts-node src/cli/redeem-positions.command.ts --min-value=1
`);
      process.exit(0);
    }
  }

  return { includeLosses, minValueUsd };
}

async function run(): Promise<void> {
  const { includeLosses, minValueUsd } = parseArgs();

  const logger = new ConsoleLogger();
  logger.info("🔄 Starting position redemption...\n");
  logger.info(
    `📋 Options: includeLosses=${includeLosses}, minValueUsd=$${minValueUsd}\n`,
  );

  // Authenticate
  logger.info("🔐 Authenticating with Polymarket...");
  const auth = createPolymarketAuthFromEnv(logger);
  const authResult = await auth.authenticate();

  if (!authResult.success) {
    logger.error(`❌ Authentication failed: ${authResult.error}`);
    process.exit(1);
  }
  logger.info("✅ Authentication successful\n");

  // Get authenticated CLOB client
  const client = await auth.getClobClient();
  logger.info(`💳 Wallet: ${client.wallet.address}\n`);

  // Initialize auto-redeem strategy
  // AutoRedeem fetches positions directly from Data API and checks on-chain
  // payoutDenominator - it does NOT use PositionTracker.
  logger.info("📊 Initializing redemption (fetches positions directly)...");
  const autoRedeemStrategy = new AutoRedeemStrategy({
    client,
    logger,
    config: {
      enabled: true,
      minPositionUsd: minValueUsd,
      checkIntervalMs: 30000, // Not used in CLI, but required by type
    },
  });

  // Execute redemptions with on-chain preflight checks
  logger.info("🔄 Executing redemptions (with on-chain preflight checks)...\n");
  const results = await autoRedeemStrategy.forceRedeemAll(includeLosses);

  // Categorized summary
  const successful = results.filter((r) => r.success);
  const skippedNotResolved = results.filter(
    (r) => r.skippedReason === "NOT_RESOLVED_ONCHAIN",
  );
  const skippedBelowMin = results.filter(
    (r) => r.skippedReason === "BELOW_MIN_VALUE",
  );
  const failed = results.filter((r) => !r.success && !r.skippedReason);

  // Detailed results
  if (successful.length > 0) {
    logger.info("\n✅ Successfully redeemed:");
    for (const result of successful) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Value: $${result.positionValueUsd?.toFixed(2) ?? "?"} | TX: ${result.transactionHash}`,
      );
    }
  }

  if (skippedNotResolved.length > 0) {
    logger.info("\n⏭️ Skipped (not resolved on-chain yet):");
    for (const result of skippedNotResolved) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Value: $${result.positionValueUsd?.toFixed(2) ?? "?"}`,
      );
    }
  }

  if (skippedBelowMin.length > 0) {
    logger.info("\n⏭️ Skipped ($0 losers / below min value):");
    for (const result of skippedBelowMin) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Value: $${result.positionValueUsd?.toFixed(4) ?? "?"}`,
      );
    }
  }

  if (failed.length > 0) {
    logger.info("\n❌ Failed redemptions:");
    for (const result of failed) {
      logger.info(
        `  - Market: ${result.marketId.substring(0, 16)}... | Error: ${result.error}`,
      );
    }
  }

  logger.info("\n✅ Done!");
  // Exit with success if any were redeemed, or if everything was intentionally skipped
  const exitCode =
    successful.length > 0 ||
    (failed.length === 0 &&
      skippedNotResolved.length + skippedBelowMin.length > 0)
      ? 0
      : 1;
  process.exit(exitCode);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
