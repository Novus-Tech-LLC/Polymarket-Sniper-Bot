#!/usr/bin/env ts-node
/**
 * On-Chain Status Check CLI Command
 *
 * Checks the on-chain trading status including:
 * - Wallet address and balance
 * - USDC balance
 * - Exchange approval status
 * - Network information
 *
 * Usage:
 *   npm run onchain:status
 *   or
 *   ts-node src/cli/onchain-status.command.ts
 */

import { config as loadEnv } from "dotenv";
import { Wallet, JsonRpcProvider } from "ethers";
import { getOnChainStatus } from "../trading/onchain-executor";
import { ConsoleLogger } from "../utils/logger.util";

loadEnv();

const logger = new ConsoleLogger();

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;

  if (!privateKey) {
    logger.error("PRIVATE_KEY is required in environment variables");
    process.exit(1);
  }

  if (!rpcUrl) {
    logger.error("RPC_URL is required in environment variables");
    process.exit(1);
  }

  logger.info("=".repeat(70));
  logger.info("On-Chain Trading Status Check");
  logger.info("=".repeat(70));

  try {
    // Create wallet and provider
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);

    // Get on-chain status
    const status = await getOnChainStatus(wallet, undefined, 6, logger);

    logger.info("");
    logger.info("Status:");
    logger.info(`  Wallet Address: ${status.walletAddress}`);
    logger.info(`  Network Chain ID: ${status.chainId}`);
    logger.info(`  USDC Balance: ${status.usdcBalanceFormatted} USDC`);
    logger.info(`  Exchange Allowance: ${status.exchangeAllowance} USDC`);
    logger.info(
      `  Exchange Approved: ${status.exchangeApproved ? "✅ Yes" : "❌ No"}`,
    );
    logger.info("");

    if (!status.exchangeApproved) {
      logger.warn("⚠️  CTF Exchange is not approved for spending USDC");
      logger.warn("   The bot will automatically approve when needed");
      logger.warn("   Or manually approve using: npm run set-token-allowance");
    } else {
      logger.info("✅ On-chain trading is ready!");
    }

    logger.info("");
    logger.info("=".repeat(70));
    logger.info("To enable on-chain trading, set in your .env:");
    logger.info("  TRADE_MODE=onchain");
    logger.info("  ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS");
    logger.info("=".repeat(70));
  } catch (error) {
    logger.error("Failed to check on-chain status:");
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
