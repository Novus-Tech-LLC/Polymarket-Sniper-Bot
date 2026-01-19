#!/usr/bin/env ts-node
/**
 * Wallet Status Checker for Polymarket CLOB
 *
 * This script checks if a wallet has ever traded on Polymarket,
 * which is a REQUIREMENT before API credentials can work.
 *
 * Usage:
 *   ts-node scripts/check_wallet_status.ts
 *   npm run wallet:check
 *
 * Environment Variables:
 *   PRIVATE_KEY - Required: Your wallet's private key
 *   PUBLIC_KEY  - Optional: Override wallet address to check
 */

import "dotenv/config";
import { Wallet } from "ethers";
import axios from "axios";

const CLOB_HOST =
  process.env.CLOB_HOST ||
  process.env.clob_host ||
  "https://clob.polymarket.com";

interface OrderHistoryResponse {
  data?: unknown[];
  next_cursor?: string;
}

/**
 * Check if wallet has any trade history on Polymarket
 */
async function checkWalletTradingHistory(
  walletAddress: string,
): Promise<{ hasTrades: boolean; tradeCount: number; error?: string }> {
  try {
    // Query the public trades endpoint (no auth required)
    const url = `${CLOB_HOST}/data/trades`;
    const response = await axios.get<OrderHistoryResponse>(url, {
      params: {
        maker: walletAddress,
      },
      timeout: 10000,
    });

    const trades = response.data?.data ?? [];
    return {
      hasTrades: trades.length > 0,
      tradeCount: trades.length,
    };
  } catch (error) {
    // Try alternative endpoint
    try {
      const url = `${CLOB_HOST}/trades`;
      const response = await axios.get<OrderHistoryResponse>(url, {
        params: {
          maker_address: walletAddress,
        },
        timeout: 10000,
      });

      const trades = response.data?.data ?? [];
      return {
        hasTrades: trades.length > 0,
        tradeCount: trades.length,
      };
    } catch {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        hasTrades: false,
        tradeCount: 0,
        error: `Could not check trading history: ${errMsg}`,
      };
    }
  }
}

/**
 * Check wallet USDC balance and approvals
 */
async function checkWalletOnChain(
  walletAddress: string,
  rpcUrl: string,
): Promise<{
  maticBalance: string;
  usdcBalance: string;
  error?: string;
}> {
  try {
    const { JsonRpcProvider, Contract, formatUnits } = await import("ethers");
    const provider = new JsonRpcProvider(rpcUrl);

    // Get MATIC balance
    const maticBalance = await provider.getBalance(walletAddress);

    // Get USDC balance (Polygon USDC.e)
    const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const ERC20_ABI = [
      "function balanceOf(address owner) view returns (uint256)",
    ];
    const usdcContract = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const usdcBalance = await usdcContract.balanceOf(walletAddress);

    return {
      maticBalance: formatUnits(maticBalance, 18),
      usdcBalance: formatUnits(usdcBalance, 6),
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      maticBalance: "unknown",
      usdcBalance: "unknown",
      error: `Could not check on-chain balances: ${errMsg}`,
    };
  }
}

async function main(): Promise<void> {
  console.log("========================================================");
  console.log("🔍 POLYMARKET WALLET STATUS CHECKER");
  console.log("========================================================\n");

  // Get wallet address
  const privateKey = process.env.PRIVATE_KEY;
  let walletAddress = process.env.PUBLIC_KEY;

  if (!privateKey && !walletAddress) {
    console.error("❌ ERROR: PRIVATE_KEY environment variable is required");
    console.error(
      "   Set PRIVATE_KEY in your .env file or export it in your shell",
    );
    process.exit(1);
  }

  if (!walletAddress && privateKey) {
    try {
      const normalizedKey = privateKey.startsWith("0x")
        ? privateKey
        : `0x${privateKey}`;
      const wallet = new Wallet(normalizedKey);
      walletAddress = wallet.address;
    } catch {
      console.error("❌ ERROR: Invalid PRIVATE_KEY format");
      process.exit(1);
    }
  }

  console.log(`📍 Wallet Address: ${walletAddress}`);
  console.log(`🌐 CLOB Host: ${CLOB_HOST}\n`);

  // Check trading history
  console.log("Checking Polymarket trading history...");
  const tradingHistory = await checkWalletTradingHistory(walletAddress!);

  if (tradingHistory.error) {
    console.log(`⚠️  ${tradingHistory.error}`);
  } else if (tradingHistory.hasTrades) {
    console.log(
      `✅ Wallet has trading history (${tradingHistory.tradeCount} trades found)`,
    );
    console.log("   ➡️  This wallet SHOULD be able to derive API credentials");
  } else {
    console.log("❌ NO TRADING HISTORY FOUND");
    console.log("");
    console.log("   ⚠️  THIS IS THE MOST LIKELY CAUSE OF YOUR 401 ERRORS!");
    console.log("");
    console.log("   Polymarket requires wallets to have at least ONE trade");
    console.log("   before API credentials can be derived and used.");
    console.log("");
    console.log("   TO FIX:");
    console.log("   1. Visit https://polymarket.com");
    console.log("   2. Connect this wallet: " + walletAddress);
    console.log("   3. Make at least ONE small trade (even $1)");
    console.log("   4. Wait for on-chain confirmation (1-2 minutes)");
    console.log("   5. Clear credential cache: rm -f /data/clob-creds.json");
    console.log("   6. Restart your bot");
  }
  console.log("");

  // Check on-chain balances if RPC_URL available
  const rpcUrl = process.env.RPC_URL;
  if (rpcUrl) {
    console.log("Checking on-chain balances...");
    const balances = await checkWalletOnChain(walletAddress!, rpcUrl);

    if (balances.error) {
      console.log(`⚠️  ${balances.error}`);
    } else {
      console.log(
        `   POL Balance:  ${Number(balances.maticBalance).toFixed(4)} POL`,
      );
      console.log(
        `   USDC Balance: ${Number(balances.usdcBalance).toFixed(2)} USDC`,
      );

      if (Number(balances.usdcBalance) < 1) {
        console.log("");
        console.log(
          "⚠️  Low USDC balance - you need USDC to make trades on Polymarket",
        );
      }
      if (Number(balances.maticBalance) < 0.01) {
        console.log("");
        console.log("⚠️  Low POL balance - you need POL for gas fees");
      }
    }
  } else {
    console.log("ℹ️  Set RPC_URL to check on-chain balances (POL and USDC)");
  }

  console.log("\n========================================================");

  // Exit with appropriate code
  if (!tradingHistory.hasTrades) {
    console.log("❌ WALLET NOT READY FOR API TRADING");
    console.log("   Follow the steps above to register your wallet");
    process.exit(1);
  } else {
    console.log("✅ WALLET APPEARS READY FOR API TRADING");
    console.log(
      "   If you're still getting 401 errors, try clearing credentials:",
    );
    console.log("   rm -f /data/clob-creds.json && npm run start");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
