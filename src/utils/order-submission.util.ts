import type { Logger } from "./logger.util";
import { DEFAULT_CONFIG } from "../constants/polymarket.constants";

export type OrderSubmissionSettings = {
  minOrderUsd: number;
  minIntervalMs: number;
  maxPerHour: number;
  marketCooldownMs: number;
  duplicatePreventionMs: number; // Token-level duplicate prevention cooldown
  cloudflareCooldownMs: number;
  authCooldownMs: number;
};

export type OrderSubmissionResult = {
  status: "submitted" | "skipped" | "failed";
  reason?: string;
  orderId?: string;
  transactionHash?: string; // For on-chain mode
  statusCode?: number;
  blockedUntil?: number;
  /**
   * Fill information for FOK/FAK orders.
   * For FOK orders, check if takingAmount or makingAmount > 0 to verify actual fill.
   * If both are "0", the order was killed (no fill).
   */
  fillInfo?: {
    takingAmount: string;
    makingAmount: string;
    status?: string;
  };
  /**
   * Amount filled in USD for partial fills.
   * Set when an order was partially filled but not fully completed.
   * Used by strategies to track that money was spent even on incomplete orders.
   * Only set when status === "failed" && reason === "order_incomplete".
   */
  filledAmountUsd?: number;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const CLOUDFLARE_REGEX = /cloudflare|blocked/i;
const RAY_ID_REGEX = /ray id\s*[:#]?\s*([a-z0-9-]+)/i;
const BALANCE_ALLOWANCE_REGEX =
  /not enough balance|insufficient balance|allowance/i;
const BALANCE_ALLOWANCE_COOLDOWN_MS = 10 * 60 * 1000;

const DEFAULT_SETTINGS: OrderSubmissionSettings = {
  minOrderUsd: DEFAULT_CONFIG.MIN_ORDER_USD,
  minIntervalMs: DEFAULT_CONFIG.ORDER_SUBMIT_MIN_INTERVAL_MS,
  maxPerHour: DEFAULT_CONFIG.ORDER_SUBMIT_MAX_PER_HOUR,
  marketCooldownMs: DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS * 1000,
  duplicatePreventionMs:
    DEFAULT_CONFIG.ORDER_DUPLICATE_PREVENTION_SECONDS * 1000,
  cloudflareCooldownMs: DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS * 1000,
  authCooldownMs: DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS * 1000,
};

export type OrderSubmissionConfig = {
  minOrderUsd?: number;
  orderSubmitMinIntervalMs?: number;
  orderSubmitMaxPerHour?: number;
  orderSubmitMarketCooldownSeconds?: number;
  orderDuplicatePreventionSeconds?: number;
  cloudflareCooldownSeconds?: number;
  authCooldownSeconds?: number;
  balanceBufferBps?: number;
  autoApprove?: boolean;
  autoApproveMaxUsd?: number;
};

export const toOrderSubmissionSettings = (
  config: OrderSubmissionConfig,
): OrderSubmissionSettings => ({
  minOrderUsd: config.minOrderUsd ?? DEFAULT_SETTINGS.minOrderUsd,
  minIntervalMs:
    config.orderSubmitMinIntervalMs ?? DEFAULT_SETTINGS.minIntervalMs,
  maxPerHour: config.orderSubmitMaxPerHour ?? DEFAULT_SETTINGS.maxPerHour,
  marketCooldownMs:
    (config.orderSubmitMarketCooldownSeconds ??
      DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS) * 1000,
  duplicatePreventionMs:
    (config.orderDuplicatePreventionSeconds ??
      DEFAULT_CONFIG.ORDER_DUPLICATE_PREVENTION_SECONDS) * 1000,
  cloudflareCooldownMs:
    (config.cloudflareCooldownSeconds ??
      DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS) * 1000,
  authCooldownMs:
    (config.authCooldownSeconds ?? DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS) *
    1000,
});

export class OrderSubmissionController {
  private settings: OrderSubmissionSettings;
  private lastSubmitAt = 0;
  private submitHistory: number[] = [];
  private marketLastSubmit = new Map<string, number>();
  private marketBalanceCooldownUntil = new Map<string, number>();
  private tokenBalanceCooldownUntil = new Map<string, number>();
  private blockedUntil = 0;
  private lastBlockedLogAt = Number.NEGATIVE_INFINITY;
  private authBlockedUntil = 0;
  private lastAuthBlockedLogAt = Number.NEGATIVE_INFINITY;
  private lastFingerprintSubmit = new Map<string, number>();
  private fingerprintCooldownUntil = new Map<string, number>();
  private lastRayId?: string;
  /**
   * Token-level duplicate prevention: tracks last order submission time per token+side
   * Key format: `${tokenId}:${side}` where side is BUY or SELL
   * This prevents placing the same type of order on the same token within the cooldown window,
   * independent of price/size - which prevents "order stacking".
   */
  private tokenSideLastSubmit = new Map<string, number>();
  /**
   * Hard cooldown cache per token_id + side
   * When an order response includes cooldownUntil, we cache it and skip all
   * subsequent order attempts for that token_id + side until expiry.
   * Key format: `${tokenId}:${side}`
   */
  private hardCooldownCache = new Map<string, number>();

  constructor(settings: OrderSubmissionSettings) {
    this.settings = { ...settings };
  }

  updateSettings(settings: OrderSubmissionSettings): void {
    this.settings = { ...settings };
  }

  async submit(params: {
    sizeUsd: number;
    marketId?: string;
    tokenId?: string;
    side?: "BUY" | "SELL"; // Order side for duplicate prevention
    orderFingerprint?: string;
    /**
     * Skip duplicate prevention check for this order.
     * Use for hedging, stop-loss, or other critical operations.
     */
    skipDuplicatePrevention?: boolean;
    /**
     * Skip the minimum order size check for this order.
     * Use for liquidations/sells where we need to sell whatever position
     * size we have, even if it's below the normal minimum.
     */
    skipMinOrderSizeCheck?: boolean;
    logger: Logger;
    submit: () => Promise<unknown>;
    now?: number;
    skipRateLimit?: boolean;
    signerAddress?: string;
    collateralLabel?: string;
  }): Promise<OrderSubmissionResult> {
    const now = params.now ?? Date.now();
    const preflight = this.checkPreflight({
      sizeUsd: params.sizeUsd,
      marketId: params.marketId,
      tokenId: params.tokenId,
      side: params.side,
      orderFingerprint: params.orderFingerprint,
      skipDuplicatePrevention: params.skipDuplicatePrevention,
      skipMinOrderSizeCheck: params.skipMinOrderSizeCheck,
      logger: params.logger,
      now,
      skipRateLimit: params.skipRateLimit,
      signerAddress: params.signerAddress,
      collateralLabel: params.collateralLabel,
    });
    if (preflight) {
      return preflight;
    }

    this.recordAttempt(
      now,
      params.marketId,
      params.tokenId,
      params.side,
      params.orderFingerprint,
    );

    try {
      const response = await params.submit();
      const statusCode = extractStatusCode(response);
      const bodyText = extractBodyText(response);
      if (isCloudflareBlocked(statusCode, bodyText)) {
        const blockedUntil = now + this.settings.cloudflareCooldownMs;
        this.blockedUntil = blockedUntil;
        logCloudflare(params.logger, bodyText, extractHeaders(response), this);
        logFailure(params.logger, statusCode, "CLOUDFLARE_BLOCK");
        return {
          status: "failed",
          reason: "CLOUDFLARE_BLOCK",
          statusCode,
          blockedUntil,
        };
      }
      const orderId = extractOrderId(response);
      const accepted = isOrderAccepted(response);
      const fillInfo = extractFillInfo(response);

      if ((statusCode === 200 || statusCode === 201) && accepted) {
        // Check if FOK order was actually filled (not killed)
        // A killed FOK order has takingAmount=0 and makingAmount=0
        if (fillInfo) {
          // Parse amounts directly - extractFillInfo guarantees strings (defaulting to "0")
          // Empty strings will become NaN, allowing malformed response detection
          const takingAmount = parseFloat(fillInfo.takingAmount);
          const makingAmount = parseFloat(fillInfo.makingAmount);

          // Check for NaN (malformed response) - treat as unknown and allow order to proceed
          const hasTaking = !isNaN(takingAmount) && takingAmount > 0;
          const hasMaking = !isNaN(makingAmount) && makingAmount > 0;

          if (
            !hasTaking &&
            !hasMaking &&
            !isNaN(takingAmount) &&
            !isNaN(makingAmount)
          ) {
            // Both amounts are valid numbers but zero - FOK order was killed
            params.logger.warn(
              `[CLOB] FOK order killed (no fill): orderId=${orderId ?? "unknown"} takingAmount=${fillInfo.takingAmount} makingAmount=${fillInfo.makingAmount} status=${fillInfo.status ?? "unknown"}`,
            );
            return {
              status: "failed",
              reason: "FOK_ORDER_KILLED",
              orderId,
              statusCode,
              fillInfo,
            };
          }

          // Log fill info for successful orders (diagnostic)
          params.logger.debug(
            `[CLOB] Order filled: orderId=${orderId ?? "unknown"} takingAmount=${fillInfo.takingAmount} makingAmount=${fillInfo.makingAmount}`,
          );
        }

        return { status: "submitted", orderId, statusCode, fillInfo };
      }

      if (statusCode === 401) {
        this.authBlockedUntil = now + this.settings.authCooldownMs;
        logFailure(params.logger, statusCode, "AUTH_UNAUTHORIZED");
        return {
          status: "failed",
          reason: "AUTH_UNAUTHORIZED",
          statusCode,
          blockedUntil: this.authBlockedUntil,
        };
      }

      const reason = normalizeReason(
        extractReason(response) || "order_rejected",
      );

      // Check for cooldownUntil in the response and cache it
      const cooldownUntil = extractCooldownUntil(response);
      if (cooldownUntil && params.tokenId && params.side) {
        const cooldownKey = `${params.tokenId}:${params.side}`;
        this.hardCooldownCache.set(cooldownKey, cooldownUntil);
        params.logger.warn(
          `[CLOB] Hard cooldown set: ${params.side} on token ${params.tokenId.slice(0, 8)}... until ${new Date(cooldownUntil).toISOString()}`,
        );
      }

      if (statusCode === 400 && isBalanceOrAllowanceReason(reason)) {
        this.applyBalanceCooldown(
          now,
          params.marketId,
          params.tokenId,
          params.logger,
          params.sizeUsd,
          params.signerAddress,
          params.collateralLabel,
        );
      }
      logFailure(params.logger, statusCode, reason);
      return { status: "failed", reason, statusCode };
    } catch (error) {
      const statusCode = extractStatusCode(error);
      const bodyText = extractBodyText(error);
      if (isCloudflareBlocked(statusCode, bodyText)) {
        const blockedUntil = now + this.settings.cloudflareCooldownMs;
        this.blockedUntil = blockedUntil;
        logCloudflare(params.logger, bodyText, extractHeaders(error), this);
        logFailure(params.logger, statusCode, "CLOUDFLARE_BLOCK");
        return {
          status: "failed",
          reason: "CLOUDFLARE_BLOCK",
          statusCode,
          blockedUntil,
        };
      }

      if (statusCode === 401) {
        this.authBlockedUntil = now + this.settings.authCooldownMs;
        logFailure(params.logger, statusCode, "AUTH_UNAUTHORIZED");
        return {
          status: "failed",
          reason: "AUTH_UNAUTHORIZED",
          statusCode,
          blockedUntil: this.authBlockedUntil,
        };
      }

      const reason = normalizeReason(extractReason(error) || "request_error");

      // Check for cooldownUntil in the error response and cache it
      const cooldownUntil = extractCooldownUntil(error);
      if (cooldownUntil && params.tokenId && params.side) {
        const cooldownKey = `${params.tokenId}:${params.side}`;
        this.hardCooldownCache.set(cooldownKey, cooldownUntil);
        params.logger.warn(
          `[CLOB] Hard cooldown set: ${params.side} on token ${params.tokenId.slice(0, 8)}... until ${new Date(cooldownUntil).toISOString()}`,
        );
      }

      if (statusCode === 400 && isBalanceOrAllowanceReason(reason)) {
        this.applyBalanceCooldown(
          now,
          params.marketId,
          params.tokenId,
          params.logger,
          params.sizeUsd,
          params.signerAddress,
          params.collateralLabel,
        );
      }
      logFailure(params.logger, statusCode, reason);
      return { status: "failed", reason, statusCode };
    }
  }

  private checkPreflight(params: {
    sizeUsd: number;
    marketId?: string;
    tokenId?: string;
    side?: "BUY" | "SELL";
    orderFingerprint?: string;
    skipDuplicatePrevention?: boolean;
    skipMinOrderSizeCheck?: boolean;
    logger: Logger;
    now: number;
    skipRateLimit?: boolean;
    signerAddress?: string;
    collateralLabel?: string;
  }): OrderSubmissionResult | null {
    if (
      !params.skipMinOrderSizeCheck &&
      params.sizeUsd < this.settings.minOrderUsd
    ) {
      params.logger.info(
        `[CLOB] Order skipped (SKIP_MIN_ORDER_SIZE): size=${params.sizeUsd.toFixed(2)} USD < min=${this.settings.minOrderUsd.toFixed(2)} USD`,
      );
      return { status: "skipped", reason: "SKIP_MIN_ORDER_SIZE" };
    }

    const balanceCooldown = this.resolveBalanceCooldown(
      params.marketId,
      params.tokenId,
    );
    if (balanceCooldown && balanceCooldown > params.now) {
      params.logger.warn(
        `[CLOB] Order skipped (INSUFFICIENT_BALANCE_OR_ALLOWANCE): required=${params.sizeUsd.toFixed(2)} signer=${params.signerAddress ?? "unknown"} collateral=${params.collateralLabel ?? "unknown"} cooldownUntil=${new Date(balanceCooldown).toISOString()}`,
      );
      return {
        status: "skipped",
        reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE",
        blockedUntil: balanceCooldown,
      };
    }

    if (this.blockedUntil > params.now) {
      if (params.now - this.lastBlockedLogAt >= 60_000) {
        params.logger.warn(
          `CLOB execution paused due to Cloudflare block until ${new Date(this.blockedUntil).toISOString()}`,
        );
        this.lastBlockedLogAt = params.now;
      }
      return {
        status: "skipped",
        reason: "CLOUDFLARE_BLOCK",
        blockedUntil: this.blockedUntil,
      };
    }

    if (this.authBlockedUntil > params.now) {
      if (params.now - this.lastAuthBlockedLogAt >= 60_000) {
        params.logger.warn(
          `CLOB execution paused due to auth failure until ${new Date(this.authBlockedUntil).toISOString()}`,
        );
        this.lastAuthBlockedLogAt = params.now;
      }
      return {
        status: "skipped",
        reason: "AUTH_BLOCK",
        blockedUntil: this.authBlockedUntil,
      };
    }

    // HARD COOLDOWN CHECK: Per token_id + side
    // When an order response includes cooldownUntil, we cache it and skip all
    // subsequent order attempts for that token_id + side until expiry.
    // This is NOT skippable - even hedging/stop-loss must respect server-imposed cooldowns.
    if (params.tokenId && params.side) {
      const hardCooldownKey = `${params.tokenId}:${params.side}`;
      const hardCooldownUntil = this.hardCooldownCache.get(hardCooldownKey);
      if (hardCooldownUntil) {
        if (params.now < hardCooldownUntil) {
          const remainingSec = Math.ceil(
            (hardCooldownUntil - params.now) / 1000,
          );
          params.logger.warn(
            `[CLOB] Order skipped (COOLDOWN_ACTIVE): ${params.side} on token ${params.tokenId.slice(0, 8)}... blocked for ${remainingSec}s (server-imposed cooldown)`,
          );
          return {
            status: "skipped",
            reason: "COOLDOWN_ACTIVE",
            blockedUntil: hardCooldownUntil,
          };
        } else {
          // Cooldown expired - clean up the entry
          this.hardCooldownCache.delete(hardCooldownKey);
        }
      }
    }

    // Token-level duplicate prevention check (price/size independent)
    // This is the PRIMARY mechanism to prevent order stacking
    // Skip if explicitly requested (for hedging, stop-loss, etc.)
    if (
      !params.skipDuplicatePrevention &&
      this.settings.duplicatePreventionMs > 0 &&
      params.tokenId &&
      params.side
    ) {
      const tokenSideKey = `${params.tokenId}:${params.side}`;
      const lastTokenSideSubmit = this.tokenSideLastSubmit.get(tokenSideKey);
      if (
        lastTokenSideSubmit &&
        params.now - lastTokenSideSubmit < this.settings.duplicatePreventionMs
      ) {
        const remainingSec = Math.ceil(
          (lastTokenSideSubmit +
            this.settings.duplicatePreventionMs -
            params.now) /
            1000,
        );
        params.logger.warn(
          `[CLOB] Order skipped (DUPLICATE_ORDER_PREVENTION): ${params.side} on token ${params.tokenId.slice(0, 8)}... blocked for ${remainingSec}s (prevents order stacking)`,
        );
        return {
          status: "skipped",
          reason: "DUPLICATE_ORDER_PREVENTION",
          blockedUntil:
            lastTokenSideSubmit + this.settings.duplicatePreventionMs,
        };
      }
    }

    if (this.settings.marketCooldownMs > 0 && params.orderFingerprint) {
      const fingerprintCooldown = this.fingerprintCooldownUntil.get(
        params.orderFingerprint,
      );
      if (fingerprintCooldown && params.now < fingerprintCooldown) {
        params.logger.warn("[CLOB] Order skipped (RATE_LIMIT_DUPLICATE_ORDER)");
        return {
          status: "skipped",
          reason: "RATE_LIMIT_DUPLICATE_ORDER",
          blockedUntil: fingerprintCooldown,
        };
      }
      const lastFingerprint = this.lastFingerprintSubmit.get(
        params.orderFingerprint,
      );
      if (
        lastFingerprint &&
        params.now - lastFingerprint < this.settings.marketCooldownMs
      ) {
        const jitteredMs =
          this.settings.marketCooldownMs +
          Math.floor(Math.random() * this.settings.marketCooldownMs * 0.2);
        const blockedUntil = params.now + jitteredMs;
        this.fingerprintCooldownUntil.set(
          params.orderFingerprint,
          blockedUntil,
        );
        params.logger.warn("[CLOB] Order skipped (RATE_LIMIT_DUPLICATE_ORDER)");
        return {
          status: "skipped",
          reason: "RATE_LIMIT_DUPLICATE_ORDER",
          blockedUntil,
        };
      }
    }

    if (
      !params.skipRateLimit &&
      this.settings.minIntervalMs > 0 &&
      params.now - this.lastSubmitAt < this.settings.minIntervalMs
    ) {
      params.logger.warn("[CLOB] Order skipped (RATE_LIMIT_MIN_INTERVAL)");
      return { status: "skipped", reason: "RATE_LIMIT_MIN_INTERVAL" };
    }

    if (!params.skipRateLimit && this.settings.maxPerHour > 0) {
      this.submitHistory = this.submitHistory.filter(
        (timestamp) => params.now - timestamp < ONE_HOUR_MS,
      );
      if (this.submitHistory.length >= this.settings.maxPerHour) {
        params.logger.warn("[CLOB] Order skipped (RATE_LIMIT_MAX_PER_HOUR)");
        return { status: "skipped", reason: "RATE_LIMIT_MAX_PER_HOUR" };
      }
    }

    if (!params.skipRateLimit && params.marketId) {
      const lastMarketSubmit = this.marketLastSubmit.get(params.marketId);
      if (
        lastMarketSubmit &&
        params.now - lastMarketSubmit < this.settings.marketCooldownMs
      ) {
        params.logger.warn("[CLOB] Order skipped (RATE_LIMIT_MARKET_COOLDOWN)");
        return { status: "skipped", reason: "RATE_LIMIT_MARKET_COOLDOWN" };
      }
    }

    return null;
  }

  private recordAttempt(
    now: number,
    marketId?: string,
    tokenId?: string,
    side?: "BUY" | "SELL",
    fingerprint?: string,
  ): void {
    this.lastSubmitAt = now;
    this.submitHistory.push(now);
    if (marketId) {
      this.marketLastSubmit.set(marketId, now);
    }
    if (fingerprint) {
      this.lastFingerprintSubmit.set(fingerprint, now);
    }
    // Track token-side for duplicate prevention
    if (tokenId && side) {
      const tokenSideKey = `${tokenId}:${side}`;
      this.tokenSideLastSubmit.set(tokenSideKey, now);
    }
  }

  private resolveBalanceCooldown(
    marketId?: string,
    tokenId?: string,
  ): number | undefined {
    const marketCooldown = marketId
      ? this.marketBalanceCooldownUntil.get(marketId)
      : undefined;
    const tokenCooldown = tokenId
      ? this.tokenBalanceCooldownUntil.get(tokenId)
      : undefined;
    if (marketCooldown && tokenCooldown) {
      return Math.max(marketCooldown, tokenCooldown);
    }
    return marketCooldown ?? tokenCooldown;
  }

  private applyBalanceCooldown(
    now: number,
    marketId: string | undefined,
    tokenId: string | undefined,
    logger: Logger,
    sizeUsd: number,
    signerAddress?: string,
    collateralLabel?: string,
  ): void {
    const cooldownUntil = now + BALANCE_ALLOWANCE_COOLDOWN_MS;
    if (marketId) {
      this.marketBalanceCooldownUntil.set(marketId, cooldownUntil);
    }
    if (tokenId) {
      this.tokenBalanceCooldownUntil.set(tokenId, cooldownUntil);
    }
    logger.warn(
      `[CLOB] Balance/allowance cooldown set: required=${sizeUsd.toFixed(2)} signer=${signerAddress ?? "unknown"} collateral=${collateralLabel ?? "unknown"} until=${new Date(cooldownUntil).toISOString()}`,
    );
  }

  shouldLogRayId(rayId: string): boolean {
    if (!rayId || rayId === this.lastRayId) return false;
    this.lastRayId = rayId;
    return true;
  }
}

let sharedController: OrderSubmissionController | null = null;

export function getOrderSubmissionController(
  settings: OrderSubmissionSettings,
): OrderSubmissionController {
  if (!sharedController) {
    sharedController = new OrderSubmissionController(settings);
  } else {
    sharedController.updateSettings(settings);
  }
  return sharedController;
}

export function resetOrderSubmissionController(): void {
  sharedController = null;
}

function extractStatusCode(value: unknown): number | undefined {
  const candidate = value as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  } | null;
  return (
    candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status
  );
}

function extractHeaders(
  value: unknown,
): Record<string, string | string[] | undefined> | undefined {
  const candidate = value as {
    headers?: Record<string, string | string[]>;
    response?: { headers?: Record<string, string | string[]> };
  } | null;
  return candidate?.headers ?? candidate?.response?.headers;
}

function extractBodyText(value: unknown): string {
  const candidate = value as {
    data?: unknown;
    response?: { data?: unknown };
  } | null;
  const body = candidate?.data ?? candidate?.response?.data;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function extractReason(value: unknown): string | undefined {
  const candidate = value as {
    message?: string;
    error?: string;
    statusText?: string;
    response?: { data?: { error?: string; message?: string } };
  } | null;
  return (
    candidate?.response?.data?.error ||
    candidate?.response?.data?.message ||
    candidate?.error ||
    candidate?.statusText ||
    candidate?.message
  );
}

function normalizeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 120);
}

function extractOrderId(response: unknown): string | undefined {
  const candidate = response as {
    order?: { id?: string; hash?: string };
    orderID?: string;
  } | null;
  return candidate?.order?.id ?? candidate?.order?.hash ?? candidate?.orderID;
}

/**
 * Extract fill information from an order response.
 * For FOK orders, this tells us if the order was actually filled or killed.
 * @returns Object with filled amounts, or undefined if not available
 */
export function extractFillInfo(response: unknown):
  | {
      takingAmount: string;
      makingAmount: string;
      status?: string;
    }
  | undefined {
  const candidate = response as {
    takingAmount?: string;
    makingAmount?: string;
    status?: string;
  } | null;

  if (
    candidate?.takingAmount !== undefined ||
    candidate?.makingAmount !== undefined
  ) {
    return {
      takingAmount: candidate?.takingAmount ?? "0",
      makingAmount: candidate?.makingAmount ?? "0",
      status: candidate?.status,
    };
  }
  return undefined;
}

function isOrderAccepted(response: unknown): boolean {
  const candidate = response as {
    success?: boolean;
    order?: { id?: string; hash?: string; status?: string };
    orderID?: string;
  } | null;
  if (candidate?.success === false) return false;
  return Boolean(
    candidate?.order?.id ||
    candidate?.order?.hash ||
    candidate?.order?.status ||
    candidate?.orderID,
  );
}

/**
 * Extract cooldownUntil timestamp from an order response.
 * The CLOB API may return a cooldownUntil field when orders are rejected
 * due to rate limiting or other temporary restrictions.
 * @returns Unix timestamp in milliseconds, or undefined if not present
 */
function extractCooldownUntil(response: unknown): number | undefined {
  const candidate = response as {
    cooldownUntil?: number | string;
    cooldown_until?: number | string;
    response?: {
      data?: {
        cooldownUntil?: number | string;
        cooldown_until?: number | string;
      };
    };
  } | null;

  // Helper to parse and normalize the value
  // Values < 1e12 are assumed to be in seconds, otherwise milliseconds
  const parseValue = (
    value: number | string | undefined,
  ): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = typeof value === "string" ? parseInt(value, 10) : value;
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    // Normalize: if value looks like seconds (< Sep 2001 in ms), convert to ms
    return parsed < 1e12 ? parsed * 1000 : parsed;
  };

  // Check direct field
  const directValue = parseValue(
    candidate?.cooldownUntil ?? candidate?.cooldown_until,
  );
  if (directValue !== undefined) {
    return directValue;
  }

  // Check nested response.data field
  const nestedValue = parseValue(
    candidate?.response?.data?.cooldownUntil ??
      candidate?.response?.data?.cooldown_until,
  );
  if (nestedValue !== undefined) {
    return nestedValue;
  }

  return undefined;
}

function isCloudflareBlocked(
  statusCode: number | undefined,
  bodyText: string,
): boolean {
  if (statusCode !== 403) return false;
  return CLOUDFLARE_REGEX.test(bodyText);
}

function logCloudflare(
  logger: Logger,
  bodyText: string,
  headers: Record<string, string | string[] | undefined> | undefined,
  controller: OrderSubmissionController,
): void {
  const headerRay = headers?.["cf-ray"] || headers?.["CF-Ray"];
  const headerRayValue = Array.isArray(headerRay) ? headerRay[0] : headerRay;
  const bodyMatch = bodyText.match(RAY_ID_REGEX);
  const rayId = headerRayValue || bodyMatch?.[1];
  if (rayId && controller.shouldLogRayId(rayId)) {
    logger.warn(`[CLOB] Cloudflare Ray ID: ${rayId}`);
  }
}

function logFailure(
  logger: Logger,
  statusCode: number | undefined,
  reason: string,
): void {
  const statusLabel = statusCode ?? "unknown";
  logger.warn(`[CLOB] Order submission failed (${statusLabel}): ${reason}`);
}

function isBalanceOrAllowanceReason(reason: string): boolean {
  return BALANCE_ALLOWANCE_REGEX.test(reason.toLowerCase());
}
