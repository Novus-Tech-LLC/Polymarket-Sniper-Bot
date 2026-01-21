#!/usr/bin/env ts-node

/**
 * CLOB 401 Diagnostic Tool
 *
 * This tool helps diagnose 401 "Unauthorized/Invalid api key" errors by:
 * 1. Verifying ethers v6 → v5 compatibility shim works
 * 2. Testing L1 authentication (deriveApiKey)
 * 3. Testing L2 authentication with ALL signature types (0, 1, 2)
 * 4. Providing detailed diagnostic output and recommendations
 *
 * Usage:
 *   npx ts-node scripts/diagnose_401.ts
 *   PRIVATE_KEY=0x... npx ts-node scripts/diagnose_401.ts
 */

import { Wallet } from "ethers";
import {
  Chain,
  createL1Headers,
  createL2Headers,
} from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import axios from "axios";
import * as crypto from "crypto";

// Constants
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = Chain.POLYGON;

// Signature type definitions
const SIGNATURE_TYPES = [
  { type: 0, name: "EOA", description: "Direct wallet (no proxy)" },
  { type: 1, name: "PROXY", description: "Magic Link / Email login" },
  {
    type: 2,
    name: "GNOSIS_SAFE",
    description: "Browser wallet (MetaMask, etc.)",
  },
] as const;

interface DiagnosticResult {
  step: string;
  status: "pass" | "fail" | "warn";
  message: string;
  details?: Record<string, unknown>;
}

interface SignatureTypeResult {
  signatureType: number;
  name: string;
  success: boolean;
  status?: number;
  error?: string;
}

const results: DiagnosticResult[] = [];

function log(result: DiagnosticResult): void {
  results.push(result);
  const icon =
    result.status === "pass" ? "✅" : result.status === "fail" ? "❌" : "⚠️";
  console.log(`${icon} [${result.step}] ${result.message}`);
  if (result.details && Object.keys(result.details).length > 0) {
    for (const [key, value] of Object.entries(result.details)) {
      const valueStr =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      console.log(
        `   ${key}: ${valueStr.slice(0, 80)}${valueStr.length > 80 ? "..." : ""}`,
      );
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

  if (
    typeof typedWallet._signTypedData !== "function" &&
    typeof typedWallet.signTypedData === "function"
  ) {
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

/**
 * Test L2 authentication with a specific signature type
 */
async function testSignatureType(
  wallet: Wallet,
  creds: ApiKeyCreds,
  signatureType: number,
): Promise<SignatureTypeResult> {
  const sigTypeInfo = SIGNATURE_TYPES.find((s) => s.type === signatureType);
  const name = sigTypeInfo?.name ?? `TYPE_${signatureType}`;

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const method = "GET";
    const requestPath = `/balance-allowance?asset_type=COLLATERAL&signature_type=${signatureType}`;

    const l2Headers = (await createL2Headers(
      wallet as unknown as Parameters<typeof createL2Headers>[0],
      creds,
      { method, requestPath },
      timestamp,
    )) as unknown as Record<string, string>;

    const fullUrl = `${CLOB_HOST}${requestPath}`;
    const response = await axios.get(fullUrl, {
      headers: l2Headers,
      timeout: 30000,
    });

    return {
      signatureType,
      name,
      success: response.status === 200,
      status: response.status,
    };
  } catch (err) {
    const axiosErr = err as {
      response?: { status?: number; data?: { error?: string } };
      code?: string;
    };
    return {
      signatureType,
      name,
      success: false,
      status: axiosErr?.response?.status,
      error:
        axiosErr?.response?.data?.error ||
        axiosErr?.code ||
        (err instanceof Error ? err.message : "Unknown error"),
    };
  }
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

  const normalizedKey = privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`;

  log({
    step: "ENV",
    status: "pass",
    message: "Environment check passed",
    details: {
      PRIVATE_KEY: `${normalizedKey.slice(0, 6)}...${normalizedKey.slice(-4)}`,
    },
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
        hasSignTypedData:
          typeof (wallet as unknown as { signTypedData?: unknown })
            .signTypedData === "function",
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
  const hasShim =
    typeof (wallet as unknown as { _signTypedData?: unknown })
      ._signTypedData === "function";

  log({
    step: "SHIM",
    status: hasShim ? "pass" : "fail",
    message: hasShim
      ? "ethers v6 → v5 compatibility shim applied"
      : "Failed to apply shim",
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
    const headers = await createL1Headers(
      wallet as unknown as Parameters<typeof createL1Headers>[0],
      CHAIN_ID,
      0,
      timestamp,
    );

    l1HeadersOk = !!(
      headers.POLY_ADDRESS &&
      headers.POLY_SIGNATURE &&
      headers.POLY_TIMESTAMP
    );

    log({
      step: "L1-HEADERS",
      status: l1HeadersOk ? "pass" : "fail",
      message: l1HeadersOk
        ? "L1 headers created successfully"
        : "L1 headers missing fields",
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
    const headers = await createL1Headers(
      wallet as unknown as Parameters<typeof createL1Headers>[0],
      CHAIN_ID,
      0,
      timestamp,
    );

    const response = await axios.get(`${CLOB_HOST}/auth/derive-api-key`, {
      headers,
      timeout: 30000,
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

  // Step 5: Test ALL signature types
  console.log("\n--- Testing ALL Signature Types ---");
  console.log("(This will try EOA, Proxy, and Gnosis Safe modes)\n");

  const signatureTypeResults: SignatureTypeResult[] = [];

  for (const sigType of SIGNATURE_TYPES) {
    process.stdout.write(
      `Testing signature_type=${sigType.type} (${sigType.name})... `,
    );
    const result = await testSignatureType(wallet, creds, sigType.type);
    signatureTypeResults.push(result);

    if (result.success) {
      console.log(`✅ SUCCESS`);
    } else {
      console.log(
        `❌ FAILED (${result.status || "error"}: ${result.error?.slice(0, 50) || "unknown"})`,
      );
    }
  }

  // Step 6: Analyze and display results
  const workingTypes = signatureTypeResults.filter((r) => r.success);
  const failedTypes = signatureTypeResults.filter((r) => !r.success);

  console.log("\n" + "=".repeat(70));
  console.log("SIGNATURE TYPE PROBE RESULTS");
  console.log("=".repeat(70));
  console.log("");

  if (workingTypes.length > 0) {
    log({
      step: "SIG-PROBE",
      status: "pass",
      message: `Found ${workingTypes.length} working signature type(s)`,
      details: {
        working: workingTypes
          .map((r) => `${r.signatureType} (${r.name})`)
          .join(", "),
      },
    });

    console.log("\n✅ WORKING CONFIGURATION(S):");
    for (const result of workingTypes) {
      const sigInfo = SIGNATURE_TYPES.find(
        (s) => s.type === result.signatureType,
      );
      console.log(
        `   • signature_type=${result.signatureType} (${result.name})`,
      );
      console.log(`     ${sigInfo?.description}`);
    }

    // Recommend the most likely correct one
    const recommended = workingTypes[0];
    console.log("\n📝 RECOMMENDED .env CONFIGURATION:");
    console.log(`   POLYMARKET_SIGNATURE_TYPE=${recommended.signatureType}`);
    if (recommended.signatureType !== 0) {
      console.log(
        `   POLYMARKET_PROXY_ADDRESS=<your Polymarket deposit address>`,
      );
      console.log("\n   To find your deposit address:");
      console.log("   1. Go to https://polymarket.com");
      console.log("   2. Connect your wallet");
      console.log("   3. Look for 'Deposit Address' in your profile");
    }
  } else {
    log({
      step: "SIG-PROBE",
      status: "fail",
      message: "No working signature type found",
      details: {
        tried: SIGNATURE_TYPES.map((s) => s.type).join(", "),
      },
    });

    console.log("\n❌ ALL SIGNATURE TYPES FAILED");
    console.log("");
    console.log("This typically means:");
    console.log("");
    console.log("1. MOST LIKELY: Your wallet has NEVER traded on Polymarket");
    console.log(
      "   - The deriveApiKey endpoint returns deterministic credentials",
    );
    console.log(
      "   - But those credentials only work if your wallet is registered",
    );
    console.log(
      "   - FIX: Visit polymarket.com, connect wallet, make any trade",
    );
    console.log("");
    console.log("2. Geographic restriction:");
    console.log("   - Polymarket blocks some regions");
    console.log("   - Try using a VPN if applicable");
    console.log("");
    console.log("3. Stale cached credentials:");
    console.log("   - Delete /data/clob-creds.json if it exists");
    console.log("   - Try again");
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

  if (workingTypes.length > 0) {
    console.log(
      `\n✅ Found working signature type: ${workingTypes[0].signatureType} (${workingTypes[0].name})`,
    );
    console.log("   Use this value for POLYMARKET_SIGNATURE_TYPE in your .env");
  } else if (failed === 0) {
    console.log("\n✅ All diagnostics passed but no signature type worked.");
    console.log("   Your wallet may not be registered on Polymarket yet.");
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
