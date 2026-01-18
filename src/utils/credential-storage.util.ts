import fs from "node:fs";
import path from "node:path";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import type { Logger } from "./logger.util";

const CREDS_FILE_PATH = "/data/clob-creds.json";
const CREDS_FILE_PATH_FALLBACK = "./data/clob-creds.json";

// Flag to prevent duplicate "No cached credentials found" messages
let noCachedCredsLogged = false;

type StoredCredentials = {
  key: string;
  secret: string;
  passphrase: string;
  createdAt: number;
  signerAddress: string;
  signatureType?: number;
  funderAddress?: string;
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
  signatureType?: number;
  funderAddress?: string;
  logger?: Logger;
}): ApiKeyCreds | null => {
  const filePath = resolveCredsPath();

  try {
    if (!fs.existsSync(filePath)) {
      // Only log this message once to avoid duplicate messages in mode=both
      if (!noCachedCredsLogged) {
        params.logger?.info(
          `[CredStorage] No cached credentials found at ${filePath}`,
        );
        noCachedCredsLogged = true;
      }
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

    // Validate signature type and funder address match (if stored)
    if (
      stored.signatureType !== undefined &&
      params.signatureType !== undefined
    ) {
      if (stored.signatureType !== params.signatureType) {
        params.logger?.warn(
          `[CredStorage] Cached credentials for different signature type (cached=${stored.signatureType} current=${params.signatureType}); ignoring and will re-derive.`,
        );
        return null;
      }
    }

    if (stored.funderAddress && params.funderAddress) {
      if (
        stored.funderAddress.toLowerCase() !==
        params.funderAddress.toLowerCase()
      ) {
        params.logger?.warn(
          `[CredStorage] Cached credentials for different funder address (cached=${stored.funderAddress} current=${params.funderAddress}); ignoring and will re-derive.`,
        );
        return null;
      }
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
  signatureType?: number;
  funderAddress?: string;
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
      signatureType: params.signatureType,
      funderAddress: params.funderAddress,
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
