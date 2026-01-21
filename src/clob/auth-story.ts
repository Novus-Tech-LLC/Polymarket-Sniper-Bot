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
  funder: string | undefined; // Funder address (undefined for EOA)
  verifyEndpoint: string; // /balance-allowance or similar
  signedPath: string; // Path that was signed
  usedAxiosParams: boolean; // Whether axios params were used (bug!)
  httpStatus?: number; // HTTP status code
  errorCode?: string; // Error code (e.g., "WRONG_KEY_TYPE")
  errorTextShort?: string; // Truncated error message
  success: boolean;
  severity?: "FATAL" | "NON_FATAL" | "TRANSIENT"; // Preflight failure severity
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
 * On-chain transaction tracking
 */
export interface OnchainTxInfo {
  type: "SAFE_DEPLOY" | "PROXY_DEPLOY" | "APPROVAL" | "OTHER";
  txHash?: string;
  description: string;
  gasUsed?: string;
}

/**
 * Complete auth story for one run
 *
 * NOTE: This tracks TWO distinct authentication systems:
 * 1. CLOB API Authentication (off-chain): Verifies ability to submit orders to Polymarket's API
 *    - Uses HMAC signatures with API key/secret/passphrase
 *    - Required for all order operations
 *
 * 2. Wallet Setup (on-chain): Deploys Smart Contract Wallets on Polygon
 *    - Safe/Proxy wallet deployment
 *    - Token approvals
 *    - These require gas (POL) and create blockchain transactions
 *
 * A user may see on-chain transactions even when CLOB API auth fails if
 * the wallet setup happens before the auth check. The fix ensures auth
 * is verified BEFORE any on-chain transactions are sent.
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
  /** On-chain transactions sent during this run (wallet setup, approvals) */
  onchainTxs?: OnchainTxInfo[];
  /** Whether on-chain transactions were blocked due to auth failure */
  onchainBlocked?: boolean;
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
      onchainTxs: [],
      onchainBlocked: false,
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
   * Add an on-chain transaction record
   */
  addOnchainTx(tx: OnchainTxInfo): void {
    if (!this.story.onchainTxs) {
      this.story.onchainTxs = [];
    }
    this.story.onchainTxs.push(tx);
  }

  /**
   * Mark that on-chain transactions were blocked due to auth failure
   */
  setOnchainBlocked(blocked: boolean): void {
    this.story.onchainBlocked = blocked;
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

    // On-chain transactions status
    if (this.story.onchainBlocked) {
      logger.info("⛔ On-chain Transactions: BLOCKED (auth failed)", {
        category: "SUMMARY",
        runId: this.story.runId,
        onchainBlocked: true,
        reason:
          "CLOB API auth failed - no on-chain transactions were sent to prevent gas waste",
      });
    } else if (this.story.onchainTxs && this.story.onchainTxs.length > 0) {
      logger.info(`On-chain Transactions: ${this.story.onchainTxs.length}`, {
        category: "SUMMARY",
        runId: this.story.runId,
        onchainTxCount: this.story.onchainTxs.length,
      });
      for (const tx of this.story.onchainTxs) {
        logger.info(
          `  [${tx.type}] ${tx.description} hash=${tx.txHash ?? "n/a"}`,
          {
            category: "SUMMARY",
            runId: this.story.runId,
            txType: tx.type,
            txHash: tx.txHash,
            description: tx.description,
          },
        );
      }
    } else {
      logger.info("On-chain Transactions: None", {
        category: "SUMMARY",
        runId: this.story.runId,
        onchainTxCount: 0,
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
 * State transition tracking - ensures summary is printed only once per state change
 */
interface AuthStateTracker {
  lastAuthOk: boolean | null;
  summaryPrintedForCurrentState: boolean;
  processStartPrinted: boolean;
}

let stateTracker: AuthStateTracker = {
  lastAuthOk: null,
  summaryPrintedForCurrentState: false,
  processStartPrinted: false,
};

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
  stateTracker = {
    lastAuthOk: null,
    summaryPrintedForCurrentState: false,
    processStartPrinted: false,
  };
}

/**
 * Check if summary should be printed based on state transitions
 * Returns true only for:
 * - First process start (once per process)
 * - State transition: authOk changes from false→true or true→false
 */
export function shouldPrintSummary(currentAuthOk: boolean): boolean {
  // Always print on first process start
  if (!stateTracker.processStartPrinted) {
    return true;
  }

  // Print on state transition
  if (stateTracker.lastAuthOk !== currentAuthOk) {
    return true;
  }

  // Already printed for this state
  return false;
}

/**
 * Record that summary was printed for current state
 */
export function recordSummaryPrinted(authOk: boolean): void {
  stateTracker.lastAuthOk = authOk;
  stateTracker.summaryPrintedForCurrentState = true;
  stateTracker.processStartPrinted = true;
}

/**
 * Conditionally print auth story summary (once per state transition)
 */
export function printAuthStorySummaryIfNeeded(authOk: boolean): boolean {
  if (!globalAuthStory) {
    return false;
  }

  if (shouldPrintSummary(authOk)) {
    globalAuthStory.printSummary();
    recordSummaryPrinted(authOk);
    return true;
  }

  return false;
}

/**
 * Get current state tracker (for testing/diagnostics)
 */
export function getStateTracker(): Readonly<AuthStateTracker> {
  return { ...stateTracker };
}
