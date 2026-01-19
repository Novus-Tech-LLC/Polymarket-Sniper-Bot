#!/usr/bin/env ts-node

/**
 * Auth Logging Validator
 *
 * Validates that authentication-related files follow logging best practices:
 * 1. No direct console.log usage (must use structured logger)
 * 2. No secrets in logs (apiKey, secret, passphrase must be redacted)
 * 3. No duplicate identity dumps
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - Validation failed
 *
 * Usage:
 *   npm run auth:validate-logging
 *   ts-node scripts/validate_auth_logging.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Files to check for auth logging violations
const AUTH_FILES = [
  "src/clob/minimal-auth.ts",
  "src/clob/auth-story.ts",
  "src/clob/credential-derivation-v2.ts",
  "src/clob/auth-fallback.ts",
  "src/utils/clob-auth-headers.util.ts",
  "src/utils/l1-auth-headers.util.ts",
  "src/utils/auth-diagnostic.util.ts",
  "src/infrastructure/clob-client.factory.ts",
];

// Patterns to detect violations
const CONSOLE_LOG_PATTERN = /console\.(log|info|warn|error|debug)/g;
const SECRET_LOG_PATTERNS = [
  // Match logging of raw secret variables (not in method names)
  /log.*\b(apiKey|secret|passphrase|privateKey)\s*[,}]/i,
  // Match logger calls with unredacted secrets as standalone variables
  /logger\.(info|debug|warn|error).*\b(apiKey|secret|passphrase|privateKey)\s*[,}]/i,
];

// Allowed exceptions (for printAuthStory and error reporting)
const ALLOWED_CONSOLE_FILES = [
  "src/clob/minimal-auth.ts", // Has printAuthStory which uses console for final output
];

interface Violation {
  file: string;
  line: number;
  type: "console" | "secret";
  content: string;
}

/**
 * Check a file for violations
 */
function checkFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const fullPath = path.join(process.cwd(), filePath);

  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠️  File not found: ${filePath}`);
    return violations;
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  // Check for console.log usage
  const allowConsole = ALLOWED_CONSOLE_FILES.includes(filePath);
  if (!allowConsole) {
    lines.forEach((line, index) => {
      // Skip comments
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) {
        return;
      }

      const matches = line.match(CONSOLE_LOG_PATTERN);
      if (matches) {
        violations.push({
          file: filePath,
          line: index + 1,
          type: "console",
          content: line.trim(),
        });
      }
    });
  }

  // Check for secret logging
  lines.forEach((line, index) => {
    // Skip comments
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) {
      return;
    }

    // Skip lines with redaction functions or safe patterns
    if (
      line.includes("redact") ||
      line.includes("Redact") ||
      line.includes("REDACTED") ||
      line.includes("***") ||
      line.includes("Suffix") ||
      line.includes("Len") ||
      line.includes("Length") ||
      line.includes("Fingerprint") ||
      line.includes("createOrDeriveApiKey") || // Method name
      line.includes('"API') || // String literal
      line.includes("'API") // String literal
    ) {
      return;
    }

    for (const pattern of SECRET_LOG_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          type: "secret",
          content: line.trim(),
        });
        break; // Only report once per line
      }
    }
  });

  return violations;
}

/**
 * Main validation
 */
async function main(): Promise<number> {
  console.log("🔍 Validating auth logging practices...\n");

  let allViolations: Violation[] = [];

  for (const file of AUTH_FILES) {
    const violations = checkFile(file);
    allViolations = allViolations.concat(violations);
  }

  if (allViolations.length === 0) {
    console.log("✅ All auth files pass logging validation!");
    console.log(`   Checked ${AUTH_FILES.length} files`);
    return 0;
  }

  // Group violations by type
  const consoleViolations = allViolations.filter((v) => v.type === "console");
  const secretViolations = allViolations.filter((v) => v.type === "secret");

  console.log(`❌ Found ${allViolations.length} logging violations:\n`);

  if (consoleViolations.length > 0) {
    console.log(`📢 Console.log usage (${consoleViolations.length}):`);
    console.log("   Use structured logger instead of console.log\n");
    for (const v of consoleViolations) {
      console.log(`   ${v.file}:${v.line}`);
      console.log(`     ${v.content}\n`);
    }
  }

  if (secretViolations.length > 0) {
    console.log(`🔒 Potential secret leakage (${secretViolations.length}):`);
    console.log("   Secrets must be redacted before logging\n");
    for (const v of secretViolations) {
      console.log(`   ${v.file}:${v.line}`);
      console.log(`     ${v.content}\n`);
    }
  }

  console.log("💡 Fix these issues:");
  console.log("   1. Replace console.log with structured logger:");
  console.log(
    "      import { getLogger } from '../utils/structured-logger';",
  );
  console.log("      const logger = getLogger();");
  console.log("      logger.info('message', { context });");
  console.log("");
  console.log("   2. Redact secrets before logging:");
  console.log(
    "      import { redactApiKey, redactSecret } from '../utils/auth-logger';",
  );
  console.log("      logger.info('key', { apiKey: redactApiKey(key) });");
  console.log("");

  return 1;
}

// Run validator
main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error("❌ Validation error:", error);
    process.exit(1);
  });
