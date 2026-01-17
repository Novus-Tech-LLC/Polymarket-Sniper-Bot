import fs from "node:fs";
import path from "node:path";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import type { Logger } from "./logger.util";

const CREDS_FILE_PATH = "/data/clob-creds.json";
const CREDS_FILE_PATH_FALLBACK = "./data/clob-creds.json";

type StoredCredentials = {
  key: string;
  secret: string;
  passphrase: string;
  createdAt: number;
  signerAddress: string;
};

const ensureDataDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const resolveCredsPath = (): string => {
  try {
    ensureDataDir(CREDS_FILE_PATH);
    return CREDS_FILE_PATH;
  } catch (error) {
    // Fallback to local data dir if /data not writable
    // Log the issue but continue with fallback
    console.warn(
      `[CredStorage] /data not accessible (${error}), using fallback: ${CREDS_FILE_PATH_FALLBACK}`,
    );
    ensureDataDir(CREDS_FILE_PATH_FALLBACK);
    return CREDS_FILE_PATH_FALLBACK;
  }
};

/**
 * Load cached credentials from disk
 */
export const loadCachedCreds = (params: {
  signerAddress: string;
  logger?: Logger;
}): ApiKeyCreds | null => {
  const filePath = resolveCredsPath();

  try {
    if (!fs.existsSync(filePath)) {
      params.logger?.info(
        `[CredStorage] No cached credentials found at ${filePath}`,
      );
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const stored: StoredCredentials = JSON.parse(content);

    // Validate stored credentials match current signer
    if (
      stored.signerAddress.toLowerCase() !== params.signerAddress.toLowerCase()
    ) {
      params.logger?.warn(
        `[CredStorage] Cached credentials for different signer (cached=${stored.signerAddress} current=${params.signerAddress}); ignoring.`,
      );
      return null;
    }

    // Validate credentials are complete
    if (!stored.key || !stored.secret || !stored.passphrase) {
      params.logger?.warn(
        "[CredStorage] Cached credentials incomplete; ignoring.",
      );
      return null;
    }

    const ageHours = Math.floor(
      (Date.now() - stored.createdAt) / (1000 * 60 * 60),
    );
    params.logger?.info(
      `[CredStorage] Loaded cached credentials from ${filePath} (age=${ageHours}h signer=${stored.signerAddress})`,
    );

    return {
      key: stored.key,
      secret: stored.secret,
      passphrase: stored.passphrase,
    };
  } catch (error) {
    params.logger?.warn(
      `[CredStorage] Failed to load cached credentials: ${error}`,
    );
    return null;
  }
};

/**
 * Save credentials to disk cache
 */
export const saveCachedCreds = (params: {
  creds: ApiKeyCreds;
  signerAddress: string;
  logger?: Logger;
}): boolean => {
  const filePath = resolveCredsPath();

  try {
    const stored: StoredCredentials = {
      key: params.creds.key,
      secret: params.creds.secret,
      passphrase: params.creds.passphrase,
      createdAt: Date.now(),
      signerAddress: params.signerAddress,
    };

    ensureDataDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), "utf-8");

    params.logger?.info(
      `[CredStorage] Saved credentials to ${filePath} (signer=${params.signerAddress})`,
    );
    return true;
  } catch (error) {
    params.logger?.warn(`[CredStorage] Failed to save credentials: ${error}`);
    return false;
  }
};

/**
 * Clear cached credentials
 */
export const clearCachedCreds = (logger?: Logger): boolean => {
  const filePath = resolveCredsPath();

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger?.info(`[CredStorage] Cleared cached credentials from ${filePath}`);
    }
    return true;
  } catch (error) {
    logger?.warn(`[CredStorage] Failed to clear cached credentials: ${error}`);
    return false;
  }
};
