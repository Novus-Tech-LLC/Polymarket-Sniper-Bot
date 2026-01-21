import eslint from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierPlugin from "eslint-plugin-prettier";
import configPrettier from "eslint-config-prettier";
import globals from "globals";

export default [
  eslint.configs.recommended,
  configPrettier,
  {
    ignores: ["dist/**", "node_modules/**", "signer/**"],
  },
  // JavaScript files - use Node.js globals
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // TypeScript files
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: false, sourceType: "module" },
      globals: {
        ...globals.node,
        NodeJS: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin, prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "warn",
      "no-console": "off",
      "no-unused-vars": "off", // Disable base rule for TypeScript
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // Strict rules for auth files - no console.log allowed
  {
    files: [
      "src/clob/credential-derivation-v2.ts",
      "src/clob/auth-fallback.ts",
      "src/clob/minimal-auth.ts",
      "src/utils/clob-auth-headers.util.ts",
      "src/utils/l1-auth-headers.util.ts",
      "src/utils/auth-diagnostic.util.ts",
      "src/utils/auth-logger.ts",
      "src/utils/structured-logger.ts",
      "src/infrastructure/clob-client.factory.ts",
      "src/infrastructure/clob-http-client.ts",
      "src/clob/diagnostics.ts",
      "src/clob/identity-resolver.ts",
      "src/polymarket/preflight.ts",
    ],
    rules: {
      "no-console": "error", // Block console.log in auth files (use structured logger)
    },
  },
  // Global no-secrets rule - warn about potential secret logging
  {
    files: ["**/*.ts", "**/*.js"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "CallExpression[callee.property.name=/^(log|info|warn|error|debug)$/] > Literal[value=/(private|Private|PRIVATE).*(key|Key|KEY)|(secret|Secret|SECRET)|(passphrase|Passphrase|PASSPHRASE)|(api|Api|API).*(key|Key|KEY)/]",
          message:
            "Do not log secrets directly. Use structured logger with redaction.",
        },
      ],
    },
  },
];
