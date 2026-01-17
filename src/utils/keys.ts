import type { Logger } from "./logger.util";

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

/**
 * Parse and normalize a private key from environment
 * Accepts either 64 hex chars or 0x + 64 hex chars
 * Returns 0x-prefixed 32-byte hex
 */
export const parsePrivateKey = (params?: {
  logger?: Logger;
  envKey?: string;
}): string => {
  const envKey = params?.envKey ?? "PRIVATE_KEY";
  const raw = readEnv(envKey);

  if (!raw) {
    throw new Error(`Missing ${envKey} environment variable`);
  }

  // Trim whitespace
  const trimmed = raw.trim();

  // Remove 0x prefix if present
  const withoutPrefix =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;

  // Validate hex and length
  if (!/^[0-9a-fA-F]+$/.test(withoutPrefix)) {
    const preview = `${withoutPrefix.slice(0, 4)}...${withoutPrefix.slice(-4)}`;
    throw new Error(
      `Invalid private key format: expected hex string, got length=${withoutPrefix.length} preview=${preview}`,
    );
  }

  if (withoutPrefix.length !== 64) {
    const preview = `${withoutPrefix.slice(0, 4)}...${withoutPrefix.slice(-4)}`;
    throw new Error(
      `Invalid private key length: expected 64 hex chars (32 bytes), got ${withoutPrefix.length} chars preview=${preview}`,
    );
  }

  const normalized = `0x${withoutPrefix}`;
  params?.logger?.info(
    `[Keys] Private key format validated successfully (32 bytes, hex)`,
  );

  return normalized;
};

/**
 * Redact a private key for safe logging
 * Shows only first 4 and last 4 chars
 */
export const redactPrivateKey = (key: string): string => {
  if (!key || key.length < 10) {
    return "***";
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
};
