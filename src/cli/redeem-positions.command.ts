/**
 * CLI command to manually redeem resolved (winning/losing) positions
 *
 * Usage:
 *   npx ts-node src/cli/redeem-positions.command.ts [--include-losses] [--min-value=X]
 *
 * Options:
 *   --include-losses  Include $0 positions (losers) in redemption. Default: false
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
 *   - $0 losers are SKIPPED (costs gas, returns nothing)
 *   - Positions not yet resolved on-chain are SKIPPED
 *   - Use --include-losses to redeem $0 positions for cleanup
 */

import "dotenv/config";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";
import { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "../strategies/position-tracker";
import { AutoRedeemStrategy } from "../strategies/auto-redeem";

// Parse CLI arguments
function parseArgs(): { includeLosses: boolean; minValueUsd: number } {
  const args = process.argv.slice(2);
  let includeLosses = false;
  let minValueUsd = 0.01; // Default: skip positions worth less than 1 cent

  for (const arg of args) {
    if (arg === "--include-losses") {
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
  --include-losses    Include $0 positions (losers) in redemption
  --min-value=X       Minimum position value in USD to redeem (default: 0.01)
  --help, -h          Show this help message

Examples:
  # Redeem only winning positions worth at least $0.01
  npx ts-node src/cli/redeem-positions.command.ts

  # Include $0 losers (cleanup mode)
  npx ts-node src/cli/redeem-positions.command.ts --include-losses

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

  // Initialize position tracker
  logger.info("📊 Fetching positions...");
  const positionTracker = new PositionTracker({
    client,
    logger,
    refreshIntervalMs: 30000,
  });

  // Manually refresh to get initial positions
  await positionTracker.refresh();

  const allPositions = positionTracker.getPositions();
  const redeemablePositions = allPositions.filter(
    (pos) => pos.redeemable === true,
  );

  logger.info(`📈 Total positions: ${allPositions.length}`);
  logger.info(`💰 Redeemable positions: ${redeemablePositions.length}\n`);

  if (redeemablePositions.length === 0) {
    logger.info(
      "✅ No positions to redeem. All markets are still active or already claimed.\n",
    );
    process.exit(0);
  }

  // Display redeemable positions with win/loss categorization
  const winners = redeemablePositions.filter((p) => p.currentPrice >= 0.5);
  const losers = redeemablePositions.filter((p) => p.currentPrice < 0.5);

  logger.info("📋 Redeemable positions found:");
  logger.info(`   Winners: ${winners.length}, Losers: ${losers.length}\n`);

  for (const pos of redeemablePositions) {
    const value = pos.size * pos.currentPrice;
    const winLoss = pos.currentPrice >= 0.5 ? "WIN" : "LOSS";
    const willSkip =
      !includeLosses && value < 0.001
        ? " [WILL SKIP - $0 loser]"
        : value < minValueUsd
          ? " [WILL SKIP - below min]"
          : "";
    logger.info(
      `  - Market: ${pos.marketId.substring(0, 16)}... | Side: ${pos.side} | Size: ${pos.size.toFixed(2)} | Value: $${value.toFixed(4)} (${winLoss})${willSkip}`,
    );
  }
  logger.info("");

  // Initialize auto-redeem strategy
  const autoRedeemStrategy = new AutoRedeemStrategy({
    client,
    logger,
    positionTracker,
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
