import type { Logger } from './logger.util';
import { DEFAULT_CONFIG } from '../constants/polymarket.constants';

export type OrderSubmissionSettings = {
  minOrderUsd: number;
  minIntervalMs: number;
  maxPerHour: number;
  marketCooldownMs: number;
  cloudflareCooldownMs: number;
  authCooldownMs: number;
};

export type OrderSubmissionResult = {
  status: 'submitted' | 'skipped' | 'failed';
  reason?: string;
  orderId?: string;
  statusCode?: number;
  blockedUntil?: number;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const CLOUDFLARE_REGEX = /cloudflare|blocked/i;
const RAY_ID_REGEX = /ray id\s*[:#]?\s*([a-z0-9-]+)/i;

const DEFAULT_SETTINGS: OrderSubmissionSettings = {
  minOrderUsd: DEFAULT_CONFIG.MIN_ORDER_USD,
  minIntervalMs: DEFAULT_CONFIG.ORDER_SUBMIT_MIN_INTERVAL_MS,
  maxPerHour: DEFAULT_CONFIG.ORDER_SUBMIT_MAX_PER_HOUR,
  marketCooldownMs: DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS * 1000,
  cloudflareCooldownMs: DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS * 1000,
  authCooldownMs: DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS * 1000,
};

export type OrderSubmissionConfig = {
  minOrderUsd?: number;
  orderSubmitMinIntervalMs?: number;
  orderSubmitMaxPerHour?: number;
  orderSubmitMarketCooldownSeconds?: number;
  cloudflareCooldownSeconds?: number;
  authCooldownSeconds?: number;
};

export const toOrderSubmissionSettings = (config: OrderSubmissionConfig): OrderSubmissionSettings => ({
  minOrderUsd: config.minOrderUsd ?? DEFAULT_SETTINGS.minOrderUsd,
  minIntervalMs: config.orderSubmitMinIntervalMs ?? DEFAULT_SETTINGS.minIntervalMs,
  maxPerHour: config.orderSubmitMaxPerHour ?? DEFAULT_SETTINGS.maxPerHour,
  marketCooldownMs: (config.orderSubmitMarketCooldownSeconds ?? DEFAULT_CONFIG.ORDER_SUBMIT_MARKET_COOLDOWN_SECONDS) * 1000,
  cloudflareCooldownMs: (config.cloudflareCooldownSeconds ?? DEFAULT_CONFIG.CLOUDFLARE_COOLDOWN_SECONDS) * 1000,
  authCooldownMs: (config.authCooldownSeconds ?? DEFAULT_CONFIG.CLOB_AUTH_COOLDOWN_SECONDS) * 1000,
});

export class OrderSubmissionController {
  private settings: OrderSubmissionSettings;
  private lastSubmitAt = 0;
  private submitHistory: number[] = [];
  private marketLastSubmit = new Map<string, number>();
  private blockedUntil = 0;
  private lastBlockedLogAt = Number.NEGATIVE_INFINITY;
  private authBlockedUntil = 0;
  private lastAuthBlockedLogAt = Number.NEGATIVE_INFINITY;
  private lastFingerprintSubmit = new Map<string, number>();
  private lastRayId?: string;

  constructor(settings: OrderSubmissionSettings) {
    this.settings = { ...settings };
  }

  updateSettings(settings: OrderSubmissionSettings): void {
    this.settings = { ...settings };
  }

  async submit(params: {
    sizeUsd: number;
    marketId?: string;
    orderFingerprint?: string;
    logger: Logger;
    submit: () => Promise<unknown>;
    now?: number;
    skipRateLimit?: boolean;
  }): Promise<OrderSubmissionResult> {
    const now = params.now ?? Date.now();
    const preflight = this.checkPreflight({
      sizeUsd: params.sizeUsd,
      marketId: params.marketId,
      orderFingerprint: params.orderFingerprint,
      logger: params.logger,
      now,
      skipRateLimit: params.skipRateLimit,
    });
    if (preflight) {
      return preflight;
    }

    this.recordAttempt(now, params.marketId, params.orderFingerprint);

    try {
      const response = await params.submit();
      const statusCode = extractStatusCode(response);
      const bodyText = extractBodyText(response);
      if (isCloudflareBlocked(statusCode, bodyText)) {
        const blockedUntil = now + this.settings.cloudflareCooldownMs;
        this.blockedUntil = blockedUntil;
        logCloudflare(params.logger, bodyText, extractHeaders(response), this);
        logFailure(params.logger, statusCode, 'CLOUDFLARE_BLOCK');
        return { status: 'failed', reason: 'CLOUDFLARE_BLOCK', statusCode, blockedUntil };
      }
      const orderId = extractOrderId(response);
      const accepted = isOrderAccepted(response);
      if ((statusCode === 200 || statusCode === 201) && accepted) {
        return { status: 'submitted', orderId, statusCode };
      }

      if (statusCode === 401) {
        this.authBlockedUntil = now + this.settings.authCooldownMs;
        logFailure(params.logger, statusCode, 'AUTH_UNAUTHORIZED');
        return { status: 'failed', reason: 'AUTH_UNAUTHORIZED', statusCode, blockedUntil: this.authBlockedUntil };
      }

      const reason = normalizeReason(extractReason(response) || 'order_rejected');
      logFailure(params.logger, statusCode, reason);
      return { status: 'failed', reason, statusCode };
    } catch (error) {
      const statusCode = extractStatusCode(error);
      const bodyText = extractBodyText(error);
      if (isCloudflareBlocked(statusCode, bodyText)) {
        const blockedUntil = now + this.settings.cloudflareCooldownMs;
        this.blockedUntil = blockedUntil;
        logCloudflare(params.logger, bodyText, extractHeaders(error), this);
        logFailure(params.logger, statusCode, 'CLOUDFLARE_BLOCK');
        return { status: 'failed', reason: 'CLOUDFLARE_BLOCK', statusCode, blockedUntil };
      }

      if (statusCode === 401) {
        this.authBlockedUntil = now + this.settings.authCooldownMs;
        logFailure(params.logger, statusCode, 'AUTH_UNAUTHORIZED');
        return { status: 'failed', reason: 'AUTH_UNAUTHORIZED', statusCode, blockedUntil: this.authBlockedUntil };
      }

      const reason = normalizeReason(extractReason(error) || 'request_error');
      logFailure(params.logger, statusCode, reason);
      return { status: 'failed', reason, statusCode };
    }
  }

  private checkPreflight(params: {
    sizeUsd: number;
    marketId?: string;
    orderFingerprint?: string;
    logger: Logger;
    now: number;
    skipRateLimit?: boolean;
  }): OrderSubmissionResult | null {
    if (params.sizeUsd < this.settings.minOrderUsd) {
      params.logger.info(
        `[CLOB] Order skipped (SKIP_MIN_ORDER_SIZE): size=${params.sizeUsd.toFixed(2)} USD < min=${this.settings.minOrderUsd.toFixed(2)} USD`,
      );
      return { status: 'skipped', reason: 'SKIP_MIN_ORDER_SIZE' };
    }

    if (this.blockedUntil > params.now) {
      if (params.now - this.lastBlockedLogAt >= 60_000) {
        params.logger.warn(
          `CLOB execution paused due to Cloudflare block until ${new Date(this.blockedUntil).toISOString()}`,
        );
        this.lastBlockedLogAt = params.now;
      }
      return { status: 'skipped', reason: 'CLOUDFLARE_BLOCK', blockedUntil: this.blockedUntil };
    }

    if (this.authBlockedUntil > params.now) {
      if (params.now - this.lastAuthBlockedLogAt >= 60_000) {
        params.logger.warn(
          `CLOB execution paused due to auth failure until ${new Date(this.authBlockedUntil).toISOString()}`,
        );
        this.lastAuthBlockedLogAt = params.now;
      }
      return { status: 'skipped', reason: 'AUTH_BLOCK', blockedUntil: this.authBlockedUntil };
    }

    if (this.settings.marketCooldownMs > 0 && params.orderFingerprint) {
      const lastFingerprint = this.lastFingerprintSubmit.get(params.orderFingerprint);
      if (lastFingerprint && params.now - lastFingerprint < this.settings.marketCooldownMs) {
        params.logger.warn('[CLOB] Order skipped (RATE_LIMIT_DUPLICATE_ORDER)');
        return { status: 'skipped', reason: 'RATE_LIMIT_DUPLICATE_ORDER' };
      }
    }

    if (!params.skipRateLimit && this.settings.minIntervalMs > 0 && params.now - this.lastSubmitAt < this.settings.minIntervalMs) {
      params.logger.warn('[CLOB] Order skipped (RATE_LIMIT_MIN_INTERVAL)');
      return { status: 'skipped', reason: 'RATE_LIMIT_MIN_INTERVAL' };
    }

    if (!params.skipRateLimit && this.settings.maxPerHour > 0) {
      this.submitHistory = this.submitHistory.filter((timestamp) => params.now - timestamp < ONE_HOUR_MS);
      if (this.submitHistory.length >= this.settings.maxPerHour) {
        params.logger.warn('[CLOB] Order skipped (RATE_LIMIT_MAX_PER_HOUR)');
        return { status: 'skipped', reason: 'RATE_LIMIT_MAX_PER_HOUR' };
      }
    }

    if (!params.skipRateLimit && params.marketId) {
      const lastMarketSubmit = this.marketLastSubmit.get(params.marketId);
      if (lastMarketSubmit && params.now - lastMarketSubmit < this.settings.marketCooldownMs) {
        params.logger.warn('[CLOB] Order skipped (RATE_LIMIT_MARKET_COOLDOWN)');
        return { status: 'skipped', reason: 'RATE_LIMIT_MARKET_COOLDOWN' };
      }
    }

    return null;
  }

  private recordAttempt(now: number, marketId?: string, fingerprint?: string): void {
    this.lastSubmitAt = now;
    this.submitHistory.push(now);
    if (marketId) {
      this.marketLastSubmit.set(marketId, now);
    }
    if (fingerprint) {
      this.lastFingerprintSubmit.set(fingerprint, now);
    }
  }

  shouldLogRayId(rayId: string): boolean {
    if (!rayId || rayId === this.lastRayId) return false;
    this.lastRayId = rayId;
    return true;
  }
}

let sharedController: OrderSubmissionController | null = null;

export function getOrderSubmissionController(settings: OrderSubmissionSettings): OrderSubmissionController {
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
  const candidate = value as { status?: number; statusCode?: number; response?: { status?: number } } | null;
  return candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status;
}

function extractHeaders(value: unknown): Record<string, string | string[] | undefined> | undefined {
  const candidate = value as { headers?: Record<string, string | string[]>; response?: { headers?: Record<string, string | string[]> } } | null;
  return candidate?.headers ?? candidate?.response?.headers;
}

function extractBodyText(value: unknown): string {
  const candidate = value as { data?: unknown; response?: { data?: unknown } } | null;
  const body = candidate?.data ?? candidate?.response?.data;
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
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
  return candidate?.response?.data?.error
    || candidate?.response?.data?.message
    || candidate?.error
    || candidate?.statusText
    || candidate?.message;
}

function normalizeReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function extractOrderId(response: unknown): string | undefined {
  const candidate = response as { order?: { id?: string; hash?: string } } | null;
  return candidate?.order?.id ?? candidate?.order?.hash;
}

function isOrderAccepted(response: unknown): boolean {
  const candidate = response as { success?: boolean; order?: { id?: string; hash?: string; status?: string } } | null;
  if (candidate?.success === false) return false;
  return Boolean(candidate?.order?.id || candidate?.order?.hash || candidate?.order?.status);
}

function isCloudflareBlocked(statusCode: number | undefined, bodyText: string): boolean {
  if (statusCode !== 403) return false;
  return CLOUDFLARE_REGEX.test(bodyText);
}

function logCloudflare(
  logger: Logger,
  bodyText: string,
  headers: Record<string, string | string[] | undefined> | undefined,
  controller: OrderSubmissionController,
): void {
  const headerRay = headers?.['cf-ray'] || headers?.['CF-Ray'];
  const headerRayValue = Array.isArray(headerRay) ? headerRay[0] : headerRay;
  const bodyMatch = bodyText.match(RAY_ID_REGEX);
  const rayId = headerRayValue || bodyMatch?.[1];
  if (rayId && controller.shouldLogRayId(rayId)) {
    logger.warn(`[CLOB] Cloudflare Ray ID: ${rayId}`);
  }
}

function logFailure(logger: Logger, statusCode: number | undefined, reason: string): void {
  const statusLabel = statusCode ?? 'unknown';
  logger.warn(`[CLOB] Order submission failed (${statusLabel}): ${reason}`);
}
