import type { ApiKeyCreds, ClobClient } from "@polymarket/clob-client";
import { formatUnits, type BigNumberish } from "ethers";
import type { Wallet } from "ethers";
import { isAuthError } from "../infrastructure/clob-auth";
import {
  runClobAuthMatrixPreflight,
  runClobAuthPreflight,
} from "../clob/diagnostics";
import { formatClobAuthFailureHint } from "../utils/clob-auth-hint.util";
import { isGeoblocked } from "../utils/geoblock.util";
import type { Logger } from "../utils/logger.util";
import { sanitizeErrorMessage } from "../utils/sanitize-axios-error.util";
import {
  publicKeyMatchesDerived,
  deriveSignerAddress,
} from "../clob/diagnostics";
import { resolvePolymarketContracts } from "./contracts";
import { ensureApprovals, readApprovalsConfig } from "./approvals";
import { createRelayerContext, deployIfNeeded } from "./relayer";
import {
  diagnoseAuthFailure,
  logAuthDiagnostic,
} from "../utils/auth-diagnostic.util";
import { initAuthStory, type AuthAttempt } from "../clob/auth-story";
import {
  type StructuredLogger,
  generateRunId,
} from "../utils/structured-logger";

export { readApprovalsConfig };

export type TradingReadyParams = {
  client: ClobClient & {
    wallet: Wallet;
    derivedCreds?: ApiKeyCreds;
    effectivePolyAddress?: string;
  };
  logger: Logger;
  privateKey: string;
  configuredPublicKey?: string;
  rpcUrl: string;
  detectOnly: boolean;
  clobCredsComplete: boolean;
  clobDeriveEnabled: boolean;
  collateralTokenDecimals: number;
};

type AuthFailureContext = {
  userProvidedKeys: boolean;
  deriveEnabled: boolean;
  deriveFailed: boolean;
  deriveError?: string;
  verificationFailed: boolean;
  verificationError?: string;
  status?: number;
};

const readEnv = (key: string): string | undefined =>
  process.env[key] ?? process.env[key.toLowerCase()];

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw) return fallback;
  return String(raw).toLowerCase() === "true";
};

const isLiveTradingEnabled = (): boolean =>
  readEnv("ARB_LIVE_TRADING") === "I_UNDERSTAND_THE_RISKS";

const formatUnitsValue = (value: BigNumberish, decimals: number): string =>
  Number(formatUnits(value, decimals)).toFixed(2);

const log = (
  logger: Logger | StructuredLogger,
  level: "info" | "warn" | "error",
  message: string,
  category?: "PREFLIGHT",
) => {
  if (
    "log" in logger &&
    typeof (logger as StructuredLogger).log === "function"
  ) {
    (logger as StructuredLogger).log(level, message, { category });
  } else {
    (logger as Logger)[level](message);
  }
};

export const ensureTradingReady = async (
  params: TradingReadyParams,
): Promise<{
  detectOnly: boolean;
  authOk: boolean;
  approvalsOk: boolean;
  geoblockPassed: boolean;
}> => {
  const derivedSignerAddress = deriveSignerAddress(params.privateKey);

  // Initialize auth story
  const runId = generateRunId();
  const clobHost =
    process.env.CLOB_HOST ||
    process.env.clob_host ||
    "https://clob.polymarket.com";
  const chainId = parseInt(
    process.env.CHAIN_ID || process.env.chain_id || "137",
    10,
  );
  const authStory = initAuthStory({
    runId,
    signerAddress: derivedSignerAddress,
    clobHost,
    chainId,
  });

  // Extract identity information from CLOB client and set on auth story
  const orderBuilder = (
    params.client as {
      orderBuilder?: { signatureType?: number; funderAddress?: string };
    }
  ).orderBuilder;
  const signatureType = orderBuilder?.signatureType ?? 0;
  const funderAddress = orderBuilder?.funderAddress;
  const effectiveAddress =
    params.client.effectivePolyAddress ?? derivedSignerAddress;

  // Map signature type to mode
  const modeMap: Record<number, "EOA" | "SAFE" | "PROXY"> = {
    0: "EOA",
    1: "PROXY",
    2: "SAFE",
  };
  const selectedMode = modeMap[signatureType] ?? "EOA";

  // Set identity on auth story
  authStory.setIdentity({
    orderIdentity: {
      signatureTypeForOrders: signatureType,
      makerAddress: funderAddress ?? effectiveAddress,
      funderAddress: funderAddress ?? effectiveAddress,
      effectiveAddress,
    },
    l1AuthIdentity: {
      signatureTypeForAuth: signatureType,
      l1AuthAddress: effectiveAddress,
      signingAddress: derivedSignerAddress,
    },
  });

  log(
    params.logger,
    "info",
    `[Preflight] Initialized auth story runId=${runId}`,
    "PREFLIGHT",
  );
  if (
    params.configuredPublicKey &&
    !publicKeyMatchesDerived(params.configuredPublicKey, derivedSignerAddress)
  ) {
    if (!parseBool(readEnv("FORCE_MISMATCH"), false)) {
      params.logger.error(
        `[Preflight] PUBLIC_KEY mismatch configured=${params.configuredPublicKey} derived=${derivedSignerAddress}.`,
      );
      throw new Error("public_key_mismatch");
    }
    params.logger.warn(
      "[Preflight] FORCE_MISMATCH=true; continuing despite PUBLIC_KEY mismatch.",
    );
  }

  let detectOnly = params.detectOnly;
  const liveTradingEnabled = isLiveTradingEnabled();
  let geoblockPassed = true;

  // Check geographic eligibility per Polymarket API requirements
  // @see https://docs.polymarket.com/developers/CLOB/geoblock
  const skipGeoblockCheck = parseBool(readEnv("SKIP_GEOBLOCK_CHECK"), false);
  if (!skipGeoblockCheck) {
    // isGeoblocked fails closed by default - if API is unreachable, it returns true (blocked)
    // This ensures compliance with geographic restrictions even during API outages
    const blocked = await isGeoblocked(params.logger);
    if (blocked) {
      params.logger.error(
        "[Preflight] Geographic restriction: trading not available in your region.",
      );
      params.logger.error(
        "[Preflight] Set SKIP_GEOBLOCK_CHECK=true to bypass (not recommended).",
      );
      detectOnly = true;
      geoblockPassed = false;
    }
  } else {
    params.logger.warn(
      "[Preflight] SKIP_GEOBLOCK_CHECK=true; geographic eligibility check bypassed.",
    );
  }

  const contracts = resolvePolymarketContracts();
  let relayer: ReturnType<typeof createRelayerContext> = {
    enabled: false,
    signerAddress: derivedSignerAddress,
  };
  try {
    relayer = createRelayerContext({
      privateKey: params.privateKey,
      rpcUrl: params.rpcUrl,
      logger: params.logger,
    });
  } catch (error) {
    params.logger.warn(
      `[Relayer] Failed to initialize relayer client. ${sanitizeErrorMessage(error)}`,
    );
  }
  if (!liveTradingEnabled) {
    detectOnly = true;
    params.logger.warn(
      "[Preflight] ARB_LIVE_TRADING not enabled; trading disabled.",
    );
  }

  let authOk = false;

  // Extract derive failure info from client if available
  const clientWithDeriveInfo = params.client as ClobClient & {
    deriveFailed?: boolean;
    deriveError?: string;
    providedCreds?: ApiKeyCreds;
  };

  let authFailureContext: AuthFailureContext = {
    userProvidedKeys: Boolean(clientWithDeriveInfo.providedCreds),
    deriveEnabled: params.clobDeriveEnabled,
    deriveFailed: clientWithDeriveInfo.deriveFailed ?? false,
    deriveError: clientWithDeriveInfo.deriveError,
    verificationFailed: false,
  };

  if (params.clobCredsComplete || params.clobDeriveEnabled) {
    try {
      const matrixEnabled =
        readEnv("CLOB_PREFLIGHT_MATRIX") === "true" ||
        readEnv("clob_preflight_matrix") === "true";
      if (matrixEnabled) {
        const matrix = await runClobAuthMatrixPreflight({
          client: params.client,
          logger: params.logger,
          creds: (params.client as { creds?: ApiKeyCreds }).creds,
          derivedCreds: params.client.derivedCreds,
        });
        if (matrix && !matrix.ok) {
          detectOnly = true;
          authOk = false;
          authFailureContext.verificationFailed = true;
          // Add matrix attempt to auth story
          const matrixAttempt: AuthAttempt = {
            attemptId: "MATRIX",
            mode: selectedMode,
            sigType: signatureType,
            l1Auth: effectiveAddress,
            maker: funderAddress ?? effectiveAddress,
            funder: funderAddress ?? effectiveAddress,
            verifyEndpoint: "/balance-allowance",
            signedPath: "/balance-allowance",
            usedAxiosParams: false,
            httpStatus: 401,
            errorTextShort: "Matrix auth failed",
            success: false,
          };
          authStory.addAttempt(matrixAttempt);
        } else if (matrix && matrix.ok) {
          authOk = true;
          // Add success attempt to auth story
          const matrixAttempt: AuthAttempt = {
            attemptId: "MATRIX",
            mode: selectedMode,
            sigType: signatureType,
            l1Auth: effectiveAddress,
            maker: funderAddress ?? effectiveAddress,
            funder: funderAddress ?? effectiveAddress,
            verifyEndpoint: "/balance-allowance",
            signedPath: "/balance-allowance",
            usedAxiosParams: false,
            httpStatus: 200,
            success: true,
          };
          authStory.addAttempt(matrixAttempt);
        }
      } else {
        const preflight = await runClobAuthPreflight({
          client: params.client,
          logger: params.logger,
          creds: (params.client as { creds?: ApiKeyCreds }).creds,
          derivedSignerAddress,
          configuredPublicKey: params.configuredPublicKey,
          privateKeyPresent: Boolean(params.privateKey),
          derivedCredsEnabled: params.clobDeriveEnabled,
          force: readEnv("CLOB_AUTH_FORCE") === "true",
        });
        if (
          preflight &&
          !preflight.ok &&
          (preflight.status === 401 || preflight.status === 403)
        ) {
          detectOnly = true;
          authOk = false;
          authFailureContext.verificationFailed = true;
          authFailureContext.status = preflight.status;
          authFailureContext.verificationError = "Unauthorized/Invalid api key";
          params.logger.warn(
            "[CLOB] Auth preflight failed; switching to detect-only.",
          );
          params.logger.warn(
            formatClobAuthFailureHint(params.clobDeriveEnabled),
          );
          // Add failed attempt to auth story
          const preflightAttempt: AuthAttempt = {
            attemptId: "A",
            mode: selectedMode,
            sigType: signatureType,
            l1Auth: effectiveAddress,
            maker: funderAddress ?? effectiveAddress,
            funder: funderAddress ?? effectiveAddress,
            verifyEndpoint: "/balance-allowance",
            signedPath: "/balance-allowance",
            usedAxiosParams: false,
            httpStatus: preflight.status,
            errorTextShort: preflight.reason ?? "Unauthorized",
            success: false,
          };
          authStory.addAttempt(preflightAttempt);
        } else if (preflight && !preflight.ok) {
          authOk = false;
          authFailureContext.verificationFailed = true;
          authFailureContext.status = preflight.status;
          params.logger.warn(
            "[CLOB] Auth preflight failed; continuing with order submissions.",
          );
          // Add failed attempt to auth story
          const preflightAttempt: AuthAttempt = {
            attemptId: "A",
            mode: selectedMode,
            sigType: signatureType,
            l1Auth: effectiveAddress,
            maker: funderAddress ?? effectiveAddress,
            funder: funderAddress ?? effectiveAddress,
            verifyEndpoint: "/balance-allowance",
            signedPath: "/balance-allowance",
            usedAxiosParams: false,
            httpStatus: preflight.status,
            errorTextShort: preflight.reason ?? "Unknown error",
            success: false,
          };
          authStory.addAttempt(preflightAttempt);
        } else if (preflight && preflight.ok) {
          authOk = true;
          // Add success attempt to auth story
          const preflightAttempt: AuthAttempt = {
            attemptId: "A",
            mode: selectedMode,
            sigType: signatureType,
            l1Auth: effectiveAddress,
            maker: funderAddress ?? effectiveAddress,
            funder: funderAddress ?? effectiveAddress,
            verifyEndpoint: "/balance-allowance",
            signedPath: "/balance-allowance",
            usedAxiosParams: false,
            httpStatus: preflight.status ?? 200,
            success: true,
          };
          authStory.addAttempt(preflightAttempt);
        } else if (!preflight) {
          // Preflight returned null - likely no creds available or backoff
          // Add attempt showing auth check was skipped
          const skippedAttempt: AuthAttempt = {
            attemptId: "A",
            mode: selectedMode,
            sigType: signatureType,
            l1Auth: effectiveAddress,
            maker: funderAddress ?? effectiveAddress,
            funder: funderAddress ?? effectiveAddress,
            verifyEndpoint: "/balance-allowance",
            signedPath: "n/a",
            usedAxiosParams: false,
            errorTextShort: "No credentials available or backoff",
            success: false,
          };
          authStory.addAttempt(skippedAttempt);
        }
      }
    } catch (err) {
      const maybeError = err as { code?: string; message?: string };
      authFailureContext.verificationError = maybeError?.message;

      // Add error attempt to auth story
      const errorAttempt: AuthAttempt = {
        attemptId: "A",
        mode: selectedMode,
        sigType: signatureType,
        l1Auth: effectiveAddress,
        maker: funderAddress ?? effectiveAddress,
        funder: funderAddress ?? effectiveAddress,
        verifyEndpoint: "/balance-allowance",
        signedPath: "/balance-allowance",
        usedAxiosParams: false,
        errorCode: maybeError?.code,
        errorTextShort: maybeError?.message?.slice(0, 100) ?? "Unknown error",
        success: false,
      };
      authStory.addAttempt(errorAttempt);

      if (maybeError?.code === "ECONNRESET") {
        params.logger.warn(
          `[CLOB] Auth preflight transient failure; continuing. ${sanitizeErrorMessage(err)}`,
        );
      } else if (isAuthError(err)) {
        detectOnly = true;
        authOk = false;
        authFailureContext.verificationFailed = true;
        params.logger.warn(
          `[CLOB] Auth preflight failed; switching to detect-only. ${sanitizeErrorMessage(err)}`,
        );
        params.logger.warn(formatClobAuthFailureHint(params.clobDeriveEnabled));
      } else {
        params.logger.warn(
          `[CLOB] Auth preflight failed; continuing. ${sanitizeErrorMessage(err)}`,
        );
      }
    }
  } else {
    // CLOB auth disabled - add attempt showing it was skipped
    const skippedAttempt: AuthAttempt = {
      attemptId: "SKIP",
      mode: selectedMode,
      sigType: signatureType,
      l1Auth: effectiveAddress,
      maker: funderAddress ?? effectiveAddress,
      funder: funderAddress ?? effectiveAddress,
      verifyEndpoint: "n/a",
      signedPath: "n/a",
      usedAxiosParams: false,
      errorTextShort: "CLOB auth disabled",
      success: false,
    };
    authStory.addAttempt(skippedAttempt);
    params.logger.info(
      "[Preflight] CLOB auth disabled; skipping authenticated endpoint check.",
    );
  }

  const approvalsConfig = readApprovalsConfig();
  const wallet = params.client.wallet;
  if (relayer.enabled) {
    try {
      await deployIfNeeded({ relayer, logger: params.logger });
    } catch (error) {
      params.logger.warn(
        `[Relayer] Deploy check failed; falling back to EOA approvals. ${sanitizeErrorMessage(error)}`,
      );
    }
  }

  // Determine effective trading address:
  // 1. If relayer is enabled, use relayer's trading address
  // 2. Otherwise, use CLOB client's effectivePolyAddress (which accounts for Safe/Proxy modes)
  // 3. Fall back to signer address if neither is available
  const tradingAddress =
    relayer.tradingAddress ??
    params.client.effectivePolyAddress ??
    derivedSignerAddress;
  params.logger.info(
    `[Preflight] signer=${derivedSignerAddress} effective_trading_address=${tradingAddress} public_key=${params.configuredPublicKey ?? "none"}`,
  );
  params.logger.info(
    `[Preflight] contracts usdc=${contracts.usdcAddress} ctf=${contracts.ctfAddress ?? "n/a"} ctf_exchange=${contracts.ctfExchangeAddress ?? "n/a"} neg_risk_exchange=${contracts.negRiskExchangeAddress ?? "n/a"} neg_risk_adapter=${contracts.negRiskAdapterAddress ?? "n/a"}`,
  );

  if (!liveTradingEnabled) {
    params.logger.info(
      "[Preflight] READY_TO_TRADE=false reason=LIVE_TRADING_DISABLED",
    );
    logPreflightSummary({
      logger: params.logger,
      signer: derivedSignerAddress,
      effectiveTradingAddress: tradingAddress,
      relayerEnabled: relayer.enabled,
      approvalsOk: false,
      authOk,
      readyToTrade: false,
    });

    // Set final result and print auth story summary
    authStory.setFinalResult({
      authOk,
      readyToTrade: false,
      reason: "LIVE_TRADING_DISABLED",
    });
    authStory.printSummary();

    (
      params.client as ClobClient & {
        relayerContext?: ReturnType<typeof createRelayerContext>;
      }
    ).relayerContext = relayer;
    return { detectOnly: true, authOk, approvalsOk: false, geoblockPassed };
  }

  let approvalResult;
  let approvalsOk = false;
  try {
    approvalResult = await ensureApprovals({
      wallet,
      owner: tradingAddress,
      relayer: relayer.enabled ? relayer : undefined,
      logger: params.logger,
      config: approvalsConfig,
    });
    approvalsOk = approvalResult?.ok ?? false;
  } catch (error) {
    params.logger.warn(
      `[Preflight][Approvals] Failed to ensure approvals. ${sanitizeErrorMessage(error)}`,
    );
    detectOnly = true;
    approvalsOk = false;
  }

  if (approvalResult) {
    const balanceDisplay = formatUnitsValue(
      approvalResult.snapshot.usdcBalance,
      params.collateralTokenDecimals,
    );
    const allowanceDetails = approvalResult.snapshot.allowances
      .map(
        ({ spender, allowance }) =>
          `${spender}=${formatUnitsValue(allowance, params.collateralTokenDecimals)}`,
      )
      .join(" ");
    const approvedForAll = approvalResult.snapshot.erc1155Approvals.every(
      ({ approved }) => approved,
    );
    params.logger.info(
      `[Preflight][Approvals] USDC balance=${balanceDisplay} allowances=[${allowanceDetails || "none"}] approvedForAll=${approvedForAll}`,
    );

    if (!approvalResult.ok) {
      detectOnly = true;
      approvalsOk = false;
    }
  } else {
    // If no approval result, approvals failed
    detectOnly = true;
    approvalsOk = false;
  }

  const readyToTrade = !detectOnly && approvalsOk && authOk;

  // Run comprehensive auth diagnostics if auth failed
  if (!authOk && authFailureContext.verificationFailed) {
    // Log diagnostic parameters for debugging
    params.logger.error(`[AuthDiag] Diagnostic parameters:`);
    params.logger.error(
      `  userProvidedKeys=${authFailureContext.userProvidedKeys}`,
    );
    params.logger.error(`  deriveEnabled=${authFailureContext.deriveEnabled}`);
    params.logger.error(`  deriveFailed=${authFailureContext.deriveFailed}`);
    params.logger.error(
      `  verificationFailed=${authFailureContext.verificationFailed}`,
    );
    params.logger.error(`  status=${authFailureContext.status}`);
    params.logger.error(
      `  deriveError=${authFailureContext.deriveError ?? "none"}`,
    );
    const diagnostic = diagnoseAuthFailure({
      userProvidedKeys: authFailureContext.userProvidedKeys,
      deriveEnabled: authFailureContext.deriveEnabled,
      deriveFailed: authFailureContext.deriveFailed,
      deriveError: authFailureContext.deriveError,
      verificationFailed: authFailureContext.verificationFailed,
      verificationError: authFailureContext.verificationError,
      status: authFailureContext.status,
      walletAddress: derivedSignerAddress,
      logger: params.logger,
    });
    logAuthDiagnostic(diagnostic, params.logger, derivedSignerAddress);
  }

  params.logger.info(
    `[Preflight] READY_TO_TRADE=${readyToTrade} reason=${detectOnly ? "CHECKS_FAILED" : "OK"}`,
  );

  logPreflightSummary({
    logger: params.logger,
    signer: derivedSignerAddress,
    effectiveTradingAddress: tradingAddress,
    relayerEnabled: relayer.enabled,
    approvalsOk,
    authOk,
    readyToTrade,
  });

  // Set final result and print auth story summary
  authStory.setFinalResult({
    authOk,
    readyToTrade,
    reason: detectOnly ? "CHECKS_FAILED" : "OK",
  });
  authStory.printSummary();

  (
    params.client as ClobClient & {
      relayerContext?: ReturnType<typeof createRelayerContext>;
    }
  ).relayerContext = relayer;

  return { detectOnly, authOk, approvalsOk, geoblockPassed };
};

const logPreflightSummary = (params: {
  logger: Logger;
  signer: string;
  effectiveTradingAddress: string;
  relayerEnabled: boolean;
  approvalsOk: boolean;
  authOk: boolean;
  readyToTrade: boolean;
}): void => {
  params.logger.info(
    `[Preflight][Summary] signer=${params.signer} effective_trading_address=${params.effectiveTradingAddress} relayer_enabled=${params.relayerEnabled} approvals_ok=${params.approvalsOk} auth_ok=${params.authOk} ready_to_trade=${params.readyToTrade}`,
  );
};
