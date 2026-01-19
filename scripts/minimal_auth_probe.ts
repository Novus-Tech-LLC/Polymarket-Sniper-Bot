#!/usr/bin/env ts-node

/**
 * Minimal Auth Probe - Python Agents Style
 *
 * This probe uses the minimal authentication approach that matches
 * the working Polymarket/agents Python repository.
 *
 * One call. No fallbacks. No retries. No complexity.
 *
 * Usage:
 *   npm run auth:probe
 *   ts-node scripts/minimal_auth_probe.ts
 *
 * Environment Variables:
 *   PRIVATE_KEY              - Required: Private key for authentication
 *   POLYMARKET_SIGNATURE_TYPE - Optional: 0=EOA, 1=Proxy, 2=GnosisSafe (default: auto)
 *   POLYMARKET_PROXY_ADDRESS - Optional: Proxy/funder address for Safe/Proxy modes
 *   LOG_LEVEL                - Optional: debug, info (default), error
 *
 * Exit Codes:
 *   0 - Authentication successful
 *   1 - Authentication failed
 */

import {
  authenticateMinimal,
  printAuthStory,
  createMinimalAuthConfigFromEnv,
} from "../src/clob/minimal-auth";

async function main(): Promise<number> {
  console.log("=".repeat(60));
  console.log("POLYMARKET MINIMAL AUTH PROBE");
  console.log("Python Agents Style - Simple & Working");
  console.log("=".repeat(60) + "\n");

  try {
    // Load config from environment
    const config = createMinimalAuthConfigFromEnv();

    // Run minimal auth (Python agents approach)
    const result = await authenticateMinimal(config);

    // Print Auth Story
    printAuthStory(result.story);

    // Return appropriate exit code
    return result.success ? 0 : 1;
  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    if (error instanceof Error && error.message.includes("PRIVATE_KEY")) {
      console.error("\n💡 Set PRIVATE_KEY environment variable");
      console.error("   Example: PRIVATE_KEY=0x... npm run auth:probe");
    }
    return 1;
  }
}

// Run and exit with appropriate code
main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error("Uncaught error:", error);
    process.exit(1);
  });
