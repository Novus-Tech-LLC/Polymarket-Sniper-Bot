#!/usr/bin/env ts-node
/**
 * Polymarket Wallet Type Detector
 *
 * This script helps identify the correct signature type and proxy address
 * for your Polymarket wallet. This is CRITICAL for API authentication.
 *
 * If you created your Polymarket account via the WEBSITE (browser):
 *   - Your wallet is likely a Gnosis Safe (signature_type=2)
 *   - You need to set POLYMARKET_PROXY_ADDRESS to your Polymarket deposit address
 *
 * If you're using a direct EOA wallet that never went through the website:
 *   - Use signature_type=0 (default)
 *   - No POLYMARKET_PROXY_ADDRESS needed
 *
 * Usage:
 *   ts-node scripts/detect_wallet_type.ts
 *   npm run wallet:detect
 */

import "dotenv/config";
import { Wallet, JsonRpcProvider } from "ethers";
import axios from "axios";

const CLOB_HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/**
 * Try to find the Polymarket proxy/safe address for an EOA
 */
async function findPolymarketWalletAddress(
  eoaAddress: string,
  _rpcUrl?: string,
): Promise<{
  proxyAddress?: string;
  safeAddress?: string;
}> {
  const result: { proxyAddress?: string; safeAddress?: string } = {};

  // Method 1: Query the Gamma API for user profile
  try {
    const response = await axios.get(`${GAMMA_API}/users/${eoaAddress}`, {
      timeout: 10000,
    });
    if (response.data?.proxyWallet) {
      result.proxyAddress = response.data.proxyWallet;
    }
    if (response.data?.safeWallet) {
      result.safeAddress = response.data.safeWallet;
    }
  } catch {
    // API might not return data for all wallets
  }

  // Method 2: Try to compute the deterministic Safe address
  // For now, we rely on the API method above
  // In the future, we could use CREATE2 computation with Gnosis Safe factory

  return result;
}

/**
 * Get user's positions/activity from Polymarket to verify wallet is registered
 */
async function checkPolymarketActivity(address: string): Promise<{
  hasActivity: boolean;
  positionCount: number;
}> {
  try {
    // Query CLOB for orders by this maker
    const response = await axios.get(`${CLOB_HOST}/data/orders`, {
      params: { maker: address },
      timeout: 10000,
    });
    const orders = response.data?.data ?? response.data ?? [];
    return {
      hasActivity: Array.isArray(orders) && orders.length > 0,
      positionCount: Array.isArray(orders) ? orders.length : 0,
    };
  } catch {
    return { hasActivity: false, positionCount: 0 };
  }
}

async function main(): Promise<void> {
  console.log("========================================================");
  console.log("🔍 POLYMARKET WALLET TYPE DETECTOR");
  console.log("========================================================\n");

  // Get wallet address
  const privateKey = process.env.PRIVATE_KEY;
  let eoaAddress = process.env.PUBLIC_KEY;
  const configuredProxyAddress =
    process.env.POLYMARKET_PROXY_ADDRESS || process.env.CLOB_FUNDER_ADDRESS;
  const configuredSignatureType =
    process.env.POLYMARKET_SIGNATURE_TYPE || process.env.CLOB_SIGNATURE_TYPE;
  const rpcUrl = process.env.RPC_URL;

  if (!privateKey && !eoaAddress) {
    console.error(
      "❌ ERROR: PRIVATE_KEY or PUBLIC_KEY environment variable is required",
    );
    process.exit(1);
  }

  if (!eoaAddress && privateKey) {
    try {
      const normalizedKey = privateKey.startsWith("0x")
        ? privateKey
        : `0x${privateKey}`;
      const wallet = new Wallet(normalizedKey);
      eoaAddress = wallet.address;
    } catch {
      console.error("❌ ERROR: Invalid PRIVATE_KEY format");
      process.exit(1);
    }
  }

  console.log("📋 CURRENT CONFIGURATION:");
  console.log(`   EOA Address (from PRIVATE_KEY): ${eoaAddress}`);
  console.log(
    `   Configured Proxy Address:       ${configuredProxyAddress || "NOT SET"}`,
  );
  console.log(
    `   Configured Signature Type:      ${configuredSignatureType || "NOT SET (defaults to 0/EOA)"}`,
  );
  console.log("");

  // Try to find the Polymarket wallet addresses
  console.log("🔎 Searching for Polymarket wallet associations...\n");

  const walletAddresses = await findPolymarketWalletAddress(
    eoaAddress!,
    rpcUrl,
  );

  // Check activity on both EOA and discovered addresses
  console.log("📊 Checking Polymarket activity...\n");

  const eoaActivity = await checkPolymarketActivity(eoaAddress!);
  let proxyActivity = { hasActivity: false, positionCount: 0 };
  let safeActivity = { hasActivity: false, positionCount: 0 };

  if (walletAddresses.proxyAddress) {
    proxyActivity = await checkPolymarketActivity(walletAddresses.proxyAddress);
  }
  if (walletAddresses.safeAddress) {
    safeActivity = await checkPolymarketActivity(walletAddresses.safeAddress);
  }
  if (
    configuredProxyAddress &&
    configuredProxyAddress !== walletAddresses.proxyAddress &&
    configuredProxyAddress !== walletAddresses.safeAddress
  ) {
    const configuredActivity = await checkPolymarketActivity(
      configuredProxyAddress,
    );
    if (configuredActivity.hasActivity) {
      console.log(
        `✅ Configured proxy address has activity: ${configuredProxyAddress}`,
      );
    }
  }

  // Determine wallet type and recommendations
  console.log("========================================================");
  console.log("📝 ANALYSIS RESULTS:");
  console.log("========================================================\n");

  let detectedType: "EOA" | "PROXY" | "SAFE" | "UNKNOWN" = "UNKNOWN";
  let recommendedSignatureType = 0;
  let recommendedProxyAddress: string | undefined;
  const recommendations: string[] = [];

  if (walletAddresses.safeAddress || safeActivity.hasActivity) {
    detectedType = "SAFE";
    recommendedSignatureType = 2;
    recommendedProxyAddress = walletAddresses.safeAddress;
    console.log("🏦 DETECTED: Gnosis Safe Wallet (Browser Login)");
    console.log(
      `   Safe Address: ${walletAddresses.safeAddress || "unknown - check Polymarket UI"}`,
    );
    recommendations.push("Set POLYMARKET_SIGNATURE_TYPE=2");
    if (walletAddresses.safeAddress) {
      recommendations.push(
        `Set POLYMARKET_PROXY_ADDRESS=${walletAddresses.safeAddress}`,
      );
    } else {
      recommendations.push(
        "Set POLYMARKET_PROXY_ADDRESS to your Polymarket deposit address (shown in Polymarket UI)",
      );
    }
  } else if (walletAddresses.proxyAddress || proxyActivity.hasActivity) {
    detectedType = "PROXY";
    recommendedSignatureType = 1;
    recommendedProxyAddress = walletAddresses.proxyAddress;
    console.log("🔗 DETECTED: Proxy Wallet (Magic Link / Email Login)");
    console.log(
      `   Proxy Address: ${walletAddresses.proxyAddress || "unknown"}`,
    );
    recommendations.push("Set POLYMARKET_SIGNATURE_TYPE=1");
    if (walletAddresses.proxyAddress) {
      recommendations.push(
        `Set POLYMARKET_PROXY_ADDRESS=${walletAddresses.proxyAddress}`,
      );
    }
  } else if (eoaActivity.hasActivity) {
    detectedType = "EOA";
    recommendedSignatureType = 0;
    console.log("💼 DETECTED: Direct EOA Wallet");
    console.log("   Your EOA has direct trading activity on Polymarket.");
    recommendations.push("Use POLYMARKET_SIGNATURE_TYPE=0 (or leave unset)");
    recommendations.push("Do NOT set POLYMARKET_PROXY_ADDRESS");
  } else {
    console.log("❓ COULD NOT DETERMINE WALLET TYPE");
    console.log("");
    console.log("   No trading activity found for this wallet on Polymarket.");
    console.log("   This could mean:");
    console.log("   1. The wallet has never traded on Polymarket");
    console.log(
      "   2. The wallet address doesn't match what was used on Polymarket",
    );
    console.log("");
    recommendations.push(
      "Visit https://polymarket.com and check your deposit address in the UI",
    );
    recommendations.push(
      "The deposit address shown in Polymarket should be set as POLYMARKET_PROXY_ADDRESS",
    );
    recommendations.push(
      "If you logged in via browser wallet, use POLYMARKET_SIGNATURE_TYPE=2",
    );
    recommendations.push(
      "If you logged in via email/Magic Link, use POLYMARKET_SIGNATURE_TYPE=1",
    );
  }

  console.log("");
  console.log("========================================================");
  console.log("🛠️  RECOMMENDED CONFIGURATION:");
  console.log("========================================================\n");

  if (recommendations.length > 0) {
    console.log("Add these to your .env file:\n");
    recommendations.forEach((rec, idx) => {
      console.log(`   ${idx + 1}. ${rec}`);
    });
  }

  console.log("\n========================================================");
  console.log("📖 HOW TO FIND YOUR POLYMARKET PROXY ADDRESS:");
  console.log("========================================================\n");
  console.log("1. Go to https://polymarket.com");
  console.log("2. Connect your wallet (the same one used with this bot)");
  console.log("3. Click on your profile / wallet icon");
  console.log("4. Look for 'Deposit Address' or your wallet address");
  console.log("5. This address is your POLYMARKET_PROXY_ADDRESS");
  console.log("");
  console.log("⚠️  IMPORTANT: Your EOA (signer) address and Polymarket");
  console.log("   deposit address are DIFFERENT if you use browser login!");
  console.log("");

  // Show example .env configuration
  console.log("========================================================");
  console.log("📄 EXAMPLE .env CONFIGURATION:");
  console.log("========================================================\n");

  if (detectedType === "SAFE" || detectedType === "UNKNOWN") {
    console.log("# For Browser Wallet (MetaMask, Coinbase Wallet, etc.):");
    console.log(`PRIVATE_KEY=your_private_key_here`);
    console.log(`POLYMARKET_SIGNATURE_TYPE=2`);
    console.log(
      `POLYMARKET_PROXY_ADDRESS=${recommendedProxyAddress || "YOUR_POLYMARKET_DEPOSIT_ADDRESS"}`,
    );
  } else if (detectedType === "PROXY") {
    console.log("# For Magic Link / Email Login:");
    console.log(`PRIVATE_KEY=your_private_key_here`);
    console.log(`POLYMARKET_SIGNATURE_TYPE=1`);
    console.log(
      `POLYMARKET_PROXY_ADDRESS=${recommendedProxyAddress || "YOUR_POLYMARKET_DEPOSIT_ADDRESS"}`,
    );
  } else {
    console.log("# For Direct EOA Wallet:");
    console.log(`PRIVATE_KEY=your_private_key_here`);
    console.log(`# POLYMARKET_SIGNATURE_TYPE=0  # Optional, 0 is default`);
    console.log(`# POLYMARKET_PROXY_ADDRESS=    # Not needed for EOA`);
  }

  console.log("\n========================================================\n");

  // Exit code based on detection confidence
  if (detectedType === "UNKNOWN") {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
