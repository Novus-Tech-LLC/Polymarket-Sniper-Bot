/**
 * Auth Story - Canonical Authentication Summary
 *
 * Generates a single comprehensive summary of authentication attempts,
 * identity resolution, and credential derivation.
 */

import crypto from "node:crypto";
import { getLogger, type LogContext } from "../utils/structured-logger";
import type { OrderIdentity, L1AuthIdentity } from "./identity-resolver";

/**
 * Credential fingerprint (safe to log)
 */
export interface CredentialFingerprint {
  apiKeySuffix: string;
  secretLen: number;
  passphraseLen: number;
  secretEncodingGuess: "base64" | "base64url" | "raw" | "unknown";
}

/**
 * Single attempt in the auth ladder
 */
export interface AuthAttempt {
  attemptId: string; // A, B, C, D, E
  mode: "EOA" | "SAFE" | "PROXY";
  sigType: number; // 0, 1, 2
  l1Auth: string; // L1 auth address used
  maker: string; // Maker address
  funder: string; // Funder address
  verifyEndpoint: string; // /balance-allowance or similar
  signedPath: string; // Path that was signed
  usedAxiosParams: boolean; // Whether axios params were used (bug!)
  httpStatus?: number; // HTTP status code
  errorCode?: string; // Error code (e.g., "WRONG_KEY_TYPE")
  errorTextShort?: string; // Truncated error message
  success: boolean;
}

/**
 * Final auth result
 */
export interface AuthResult {
  authOk: boolean;
  readyToTrade: boolean;
  reason: string;
}

/**
 * Complete auth story for one run
 */
export interface AuthStory {
  runId: string;
  selectedMode?: "EOA" | "SAFE" | "PROXY";
  selectedSignatureType?: number;
  signerAddress: string;
  makerAddress?: string;
  funderAddress?: string;
  effectiveAddress?: string;
  clobHost: string;
  chainId: number;
  derivedCredFingerprint?: CredentialFingerprint;
  attempts: AuthAttempt[];
  finalResult: AuthResult;
}

/**
 * Create credential fingerprint (safe to log - no secrets)
 */
export function createCredentialFingerprint(creds: {
  key?: string;
  secret?: string;
  passphrase?: string;
}): CredentialFingerprint {
  const apiKeySuffix = creds.key
    ? creds.key.length >= 6
      ? creds.key.slice(-6)
      : crypto.createHash("sha256").update(creds.key).digest("hex").slice(0, 8)
    : "n/a";

  const secretLen = creds.secret?.length ?? 0;
  const passphraseLen = creds.passphrase?.length ?? 0;

  // Guess secret encoding
  let secretEncodingGuess: "base64" | "base64url" | "raw" | "unknown" =
    "unknown";
  if (creds.secret) {
    const secret = creds.secret;
    const hasBase64Chars = secret.includes("+") || secret.includes("/");
    const hasBase64UrlChars = secret.includes("-") || secret.includes("_");
    const hasPadding = secret.endsWith("=");

    if (hasBase64UrlChars) {
      secretEncodingGuess = "base64url";
    } else if (hasBase64Chars || hasPadding) {
      secretEncodingGuess = "base64";
    } else if (/^[A-Za-z0-9]+$/.test(secret)) {
      secretEncodingGuess = "base64"; // Probably base64 without special chars
    } else {
      secretEncodingGuess = "raw";
    }
  }

  return {
    apiKeySuffix,
    secretLen,
    passphraseLen,
    secretEncodingGuess,
  };
}

/**
 * Map signature type to mode name
 */
function signatureTypeToMode(sigType: number): "EOA" | "SAFE" | "PROXY" {
  switch (sigType) {
    case 0:
      return "EOA";
    case 1:
      return "PROXY";
    case 2:
      return "SAFE";
    default:
      return "EOA";
  }
}

/**
 * Build an auth story incrementally
 */
export class AuthStoryBuilder {
  private story: AuthStory;

  constructor(params: {
    runId: string;
    signerAddress: string;
    clobHost: string;
    chainId: number;
  }) {
    this.story = {
      runId: params.runId,
      signerAddress: params.signerAddress,
      clobHost: params.clobHost,
      chainId: params.chainId,
      attempts: [],
      finalResult: {
        authOk: false,
        readyToTrade: false,
        reason: "Not yet determined",
      },
    };
  }

  /**
   * Set identity resolution
   */
  setIdentity(params: {
    orderIdentity: OrderIdentity;
    l1AuthIdentity: L1AuthIdentity;
  }): void {
    this.story.selectedMode = signatureTypeToMode(
      params.orderIdentity.signatureTypeForOrders,
    );
    this.story.selectedSignatureType =
      params.orderIdentity.signatureTypeForOrders;
    this.story.makerAddress = params.orderIdentity.makerAddress;
    this.story.funderAddress = params.orderIdentity.funderAddress;
    this.story.effectiveAddress = params.orderIdentity.effectiveAddress;
  }

  /**
   * Set derived credential fingerprint
   */
  setCredentialFingerprint(fingerprint: CredentialFingerprint): void {
    this.story.derivedCredFingerprint = fingerprint;
  }

  /**
   * Add an attempt
   */
  addAttempt(attempt: AuthAttempt): void {
    this.story.attempts.push(attempt);
  }

  /**
   * Set final result
   */
  setFinalResult(result: AuthResult): void {
    this.story.finalResult = result;
  }

  /**
   * Get the story
   */
  getStory(): AuthStory {
    return this.story;
  }

  /**
   * Print the auth story as a summary block
   */
  printSummary(): void {
    const logger = getLogger();

    logger.info("========================================================", {
      category: "SUMMARY",
      runId: this.story.runId,
    });
    logger.info("AUTH STORY SUMMARY", {
      category: "SUMMARY",
      runId: this.story.runId,
    });
    logger.info("========================================================", {
      category: "SUMMARY",
      runId: this.story.runId,
    });

    // Identity
    logger.info("Identity Configuration:", {
      category: "SUMMARY",
      runId: this.story.runId,
      selectedMode: this.story.selectedMode,
      selectedSignatureType: this.story.selectedSignatureType,
      signerAddress: this.story.signerAddress,
      makerAddress: this.story.makerAddress,
      funderAddress: this.story.funderAddress,
      effectiveAddress: this.story.effectiveAddress,
    });

    // CLOB Config
    logger.info("CLOB Configuration:", {
      category: "SUMMARY",
      runId: this.story.runId,
      clobHost: this.story.clobHost,
      chainId: this.story.chainId,
    });

    // Credential fingerprint
    if (this.story.derivedCredFingerprint) {
      logger.info("Derived Credential Fingerprint:", {
        category: "SUMMARY",
        runId: this.story.runId,
        ...this.story.derivedCredFingerprint,
      });
    }

    // Attempts
    logger.info(`Authentication Attempts: ${this.story.attempts.length}`, {
      category: "SUMMARY",
      runId: this.story.runId,
    });

    for (const attempt of this.story.attempts) {
      const status = attempt.success ? "✅ SUCCESS" : "❌ FAILED";
      const errorInfo = attempt.errorCode
        ? ` (${attempt.errorCode})`
        : attempt.errorTextShort
          ? ` (${attempt.errorTextShort})`
          : "";

      logger.info(`  [${attempt.attemptId}] ${status}${errorInfo}`, {
        category: "SUMMARY",
        runId: this.story.runId,
        attemptId: attempt.attemptId,
        mode: attempt.mode,
        sigType: attempt.sigType,
        l1Auth: attempt.l1Auth,
        maker: attempt.maker,
        funder: attempt.funder,
        verifyEndpoint: attempt.verifyEndpoint,
        signedPath: attempt.signedPath,
        usedAxiosParams: attempt.usedAxiosParams,
        httpStatus: attempt.httpStatus,
      });
    }

    // Final result
    const resultIcon = this.story.finalResult.authOk ? "✅" : "❌";
    logger.info(`Final Result: ${resultIcon}`, {
      category: "SUMMARY",
      runId: this.story.runId,
      authOk: this.story.finalResult.authOk,
      readyToTrade: this.story.finalResult.readyToTrade,
      reason: this.story.finalResult.reason,
    });

    logger.info("========================================================", {
      category: "SUMMARY",
      runId: this.story.runId,
    });

    // Also output a single JSON block for easy parsing
    this.printJsonSummary();
  }

  /**
   * Print the auth story as a single JSON block (Auth Story JSON)
   */
  printJsonSummary(): void {
    const logger = getLogger();
    logger.info("AUTH_STORY_JSON", {
      category: "SUMMARY",
      runId: this.story.runId,
      authStory: this.story,
    });
  }

  /**
   * Export as JSON
   */
  toJSON(): string {
    return JSON.stringify(this.story, null, 2);
  }
}

/**
 * Global auth story builder instance
 */
let globalAuthStory: AuthStoryBuilder | null = null;

/**
 * Initialize global auth story
 */
export function initAuthStory(params: {
  runId: string;
  signerAddress: string;
  clobHost: string;
  chainId: number;
}): AuthStoryBuilder {
  globalAuthStory = new AuthStoryBuilder(params);
  return globalAuthStory;
}

/**
 * Get global auth story
 */
export function getAuthStory(): AuthStoryBuilder | null {
  return globalAuthStory;
}

/**
 * Reset global auth story (for testing)
 */
export function resetAuthStory(): void {
  globalAuthStory = null;
}
