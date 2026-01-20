#!/usr/bin/env ts-node

/**
 * CLOB 401 Diagnostic Tool
 *
 * This tool helps diagnose 401 "Unauthorized/Invalid api key" errors by:
 * 1. Verifying ethers v6 → v5 compatibility shim works
 * 2. Testing L1 authentication (deriveApiKey)
 * 3. Testing L2 authentication (getBalanceAllowance)
 * 4. Providing detailed diagnostic output
 *
 * Usage:
 *   npx ts-node scripts/diagnose_401.ts
 *   PRIVATE_KEY=0x... npx ts-node scripts/diagnose_401.ts
 */

import { Wallet } from "ethers";
import { ClobClient, Chain, AssetType, createL1Headers, createL2Headers } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import axios from "axios";
import * as crypto from "crypto";

// Constants
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = Chain.POLYGON;

interface DiagnosticResult {
  step: string;
  status: "pass" | "fail" | "warn";
  message: string;
  details?: Record<string, unknown>;
}

const results: DiagnosticResult[] = [];

function log(result: DiagnosticResult): void {
  results.push(result);
  const icon = result.status === "pass" ? "✅" : result.status === "fail" ? "❌" : "⚠️";
  console.log(`${icon} [${result.step}] ${result.message}`);
  if (result.details && Object.keys(result.details).length > 0) {
    for (const [key, value] of Object.entries(result.details)) {
      const valueStr = typeof value === "object" ? JSON.stringify(value) : String(value);
      console.log(`   ${key}: ${valueStr.slice(0, 80)}${valueStr.length > 80 ? "..." : ""}`);
    }
  }
}

/**
 * Apply ethers v6 → v5 compatibility shim
 */
function applyV6Shim(wallet: Wallet): Wallet {
  const typedWallet = wallet as Wallet & {
    _signTypedData?: typeof wallet.signTypedData;
    signTypedData?: typeof wallet.signTypedData;
  };

  if (typeof typedWallet._signTypedData !== "function" && typeof typedWallet.signTypedData === "function") {
    const signTypedDataFn = typedWallet.signTypedData;
    typedWallet._signTypedData = async (domain, types, value) =>
      signTypedDataFn.call(typedWallet, domain, types, value);
  }

  return wallet;
}

/**
 * Redact sensitive data
 */
function redact(value: string, showChars: number = 4): string {
  if (value.length <= showChars * 2) {
    return "[REDACTED]";
  }
  return `${value.slice(0, showChars)}...${value.slice(-showChars)}`;
}

async function runDiagnostics(): Promise<void> {
  console.log("=".repeat(70));
  console.log("CLOB 401 DIAGNOSTIC TOOL");
  console.log("=".repeat(70));
  console.log("");

  // Step 0: Check environment
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log({
      step: "ENV",
      status: "fail",
      message: "PRIVATE_KEY environment variable is not set",
      details: { hint: "Set PRIVATE_KEY=0x... before running this script" },
    });
    return;
  }

  const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;

  log({
    step: "ENV",
    status: "pass",
    message: "Environment check passed",
    details: { PRIVATE_KEY: `${normalizedKey.slice(0, 6)}...${normalizedKey.slice(-4)}` },
  });

  // Step 1: Create wallet
  let wallet: Wallet;
  try {
    wallet = new Wallet(normalizedKey);
    log({
      step: "WALLET",
      status: "pass",
      message: "Wallet created successfully",
      details: {
        address: wallet.address,
        hasSignTypedData: typeof (wallet as unknown as { signTypedData?: unknown }).signTypedData === "function",
      },
    });
  } catch (err) {
    log({
      step: "WALLET",
      status: "fail",
      message: "Failed to create wallet from private key",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  // Step 2: Apply v6 shim
  wallet = applyV6Shim(wallet);
  const hasShim = typeof (wallet as unknown as { _signTypedData?: unknown })._signTypedData === "function";

  log({
    step: "SHIM",
    status: hasShim ? "pass" : "fail",
    message: hasShim ? "ethers v6 → v5 compatibility shim applied" : "Failed to apply shim",
    details: { _signTypedData: hasShim ? "function" : "undefined" },
  });

  if (!hasShim) {
    return;
  }

  // Step 3: Test L1 headers
  console.log("\n--- L1 Authentication (EIP-712) ---");
  let l1HeadersOk = false;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = await createL1Headers(wallet as unknown as Parameters<typeof createL1Headers>[0], CHAIN_ID, 0, timestamp);

    l1HeadersOk = !!(headers.POLY_ADDRESS && headers.POLY_SIGNATURE && headers.POLY_TIMESTAMP);

    log({
      step: "L1-HEADERS",
      status: l1HeadersOk ? "pass" : "fail",
      message: l1HeadersOk ? "L1 headers created successfully" : "L1 headers missing fields",
      details: {
        POLY_ADDRESS: headers.POLY_ADDRESS,
        POLY_TIMESTAMP: headers.POLY_TIMESTAMP,
        POLY_SIGNATURE: redact(headers.POLY_SIGNATURE, 10),
        POLY_NONCE: headers.POLY_NONCE,
      },
    });
  } catch (err) {
    log({
      step: "L1-HEADERS",
      status: "fail",
      message: "Failed to create L1 headers",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  // Step 4: Test deriveApiKey
  console.log("\n--- Credential Derivation ---");
  let creds: ApiKeyCreds | null = null;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = await createL1Headers(wallet as unknown as Parameters<typeof createL1Headers>[0], CHAIN_ID, 0, timestamp);

    const response = await axios.get(`${CLOB_HOST}/auth/derive-api-key`, {
      headers,
      timeout: 30000, // 30 second timeout
    });

    creds = {
      key: response.data.apiKey,
      secret: response.data.secret,
      passphrase: response.data.passphrase,
    };

    log({
      step: "DERIVE",
      status: "pass",
      message: "Credentials derived successfully",
      details: {
        apiKey: redact(creds.key, 8),
        secretLength: creds.secret.length,
        passphraseLength: creds.passphrase.length,
      },
    });
  } catch (err) {
    const axiosErr = err as { response?: { status?: number; data?: unknown } };
    log({
      step: "DERIVE",
      status: "fail",
      message: "Failed to derive credentials",
      details: {
        status: axiosErr?.response?.status,
        data: axiosErr?.response?.data,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  // Step 5: Test L2 headers
  console.log("\n--- L2 Authentication (HMAC) ---");
  const timestamp = Math.floor(Date.now() / 1000);
  const method = "GET";
  const requestPath = "/balance-allowance?asset_type=COLLATERAL&signature_type=0";

  let l2Headers: Record<string, string> | null = null;
  try {
    l2Headers = (await createL2Headers(
      wallet as unknown as Parameters<typeof createL2Headers>[0],
      creds,
      { method, requestPath },
      timestamp
    )) as unknown as Record<string, string>;

    log({
      step: "L2-HEADERS",
      status: "pass",
      message: "L2 headers created successfully",
      details: {
        POLY_ADDRESS: l2Headers.POLY_ADDRESS,
        POLY_API_KEY: redact(l2Headers.POLY_API_KEY, 8),
        POLY_TIMESTAMP: l2Headers.POLY_TIMESTAMP,
        POLY_SIGNATURE: redact(l2Headers.POLY_SIGNATURE, 10),
      },
    });
  } catch (err) {
    log({
      step: "L2-HEADERS",
      status: "fail",
      message: "Failed to create L2 headers",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  // Step 6: Compute manual HMAC for comparison
  const messageStr = `${timestamp}${method}${requestPath}`;
  const messageHash = crypto.createHash("sha256").update(messageStr).digest("hex");

  log({
    step: "HMAC-INPUT",
    status: "pass",
    message: "HMAC message constructed",
    details: {
      message: messageStr,
      messageHash: redact(messageHash, 8),
      messageLength: messageStr.length,
    },
  });

  // Step 7: Test actual API call
  console.log("\n--- API Verification ---");
  const fullUrl = `${CLOB_HOST}${requestPath}`;

  try {
    const response = await axios.get(fullUrl, {
      headers: l2Headers,
      timeout: 30000, // 30 second timeout
    });

    log({
      step: "VERIFY",
      status: "pass",
      message: "API verification PASSED!",
      details: {
        status: response.status,
        balance: response.data?.balance,
        allowance: response.data?.allowance,
      },
    });
  } catch (err) {
    const axiosErr = err as { response?: { status?: number; data?: { error?: string } }; code?: string };
    const status = axiosErr?.response?.status;
    const errorMsg = axiosErr?.response?.data?.error || axiosErr?.code || "Unknown error";

    if (status === 401) {
      log({
        step: "VERIFY",
        status: "fail",
        message: "API verification FAILED with 401",
        details: {
          status: 401,
          error: errorMsg,
          url: fullUrl,
        },
      });

      console.log("\n" + "=".repeat(70));
      console.log("DIAGNOSIS: 401 Unauthorized");
      console.log("=".repeat(70));
      console.log("");
      console.log("The credentials were derived successfully, but verification failed.");
      console.log("This typically means ONE of the following:");
      console.log("");
      console.log("1. MOST LIKELY: Your wallet has NEVER traded on Polymarket");
      console.log("   - The deriveApiKey endpoint returns deterministic credentials");
      console.log("   - But those credentials only work if your wallet is registered");
      console.log("   - FIX: Visit polymarket.com, connect wallet, make any trade");
      console.log("");
      console.log("2. Wrong signature type:");
      console.log("   - If you created your wallet via browser/Metamask, try:");
      console.log("     POLYMARKET_SIGNATURE_TYPE=2");
      console.log("");
      console.log("3. Geographic restriction:");
      console.log("   - Polymarket blocks some regions");
      console.log("   - Try using a VPN if applicable");
      console.log("");
      console.log("4. Stale cached credentials:");
      console.log("   - Delete /data/clob-creds.json if it exists");
      console.log("   - Try again");
      console.log("");
    } else {
      log({
        step: "VERIFY",
        status: "fail",
        message: `API verification FAILED with status ${status}`,
        details: {
          status,
          error: errorMsg,
        },
      });
    }
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("DIAGNOSTIC SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;

  console.log(`Total steps: ${results.length}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⚠️ Warnings: ${warned}`);

  if (failed === 0) {
    console.log("\n✅ All diagnostics passed! Your CLOB auth should work.");
  } else if (results.some((r) => r.step === "VERIFY" && r.status === "fail")) {
    console.log("\n❌ Authentication flow works, but API verification failed.");
    console.log("   See diagnosis above for recommended actions.");
  } else {
    console.log("\n❌ Some diagnostics failed. Review the output above.");
  }

  console.log("=".repeat(70));
}

// Main entry point
runDiagnostics()
  .then(() => {
    const hasFailed = results.some((r) => r.status === "fail");
    process.exit(hasFailed ? 1 : 0);
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
