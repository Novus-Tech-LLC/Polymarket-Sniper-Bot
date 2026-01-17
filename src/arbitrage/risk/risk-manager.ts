import fs from "fs";
import type { Wallet } from "ethers";
import type { Logger } from "../../utils/logger.util";
import type { ArbConfig } from "../config";
import type { Opportunity, RiskManager, StateStore } from "../types";
import { TtlLruSet } from "../utils/ttl-lru";
import { getPolBalance } from "../../utils/get-balance.util";

const OPPORTUNITY_TTL_MS = 10 * 60 * 1000;
const OPPORTUNITY_CACHE_SIZE = 5000;

export class ArbRiskManager implements RiskManager {
  private readonly config: ArbConfig;
  private readonly state: StateStore;
  private readonly logger: Logger;
  private readonly wallet: Wallet;
  private readonly opportunityCache: TtlLruSet;
  private readonly startupReadyAt: number;

  constructor(params: {
    config: ArbConfig;
    state: StateStore;
    logger: Logger;
    wallet: Wallet;
  }) {
    this.config = params.config;
    this.state = params.state;
    this.logger = params.logger;
    this.wallet = params.wallet;
    this.opportunityCache = new TtlLruSet(
      OPPORTUNITY_CACHE_SIZE,
      OPPORTUNITY_TTL_MS,
    );
    this.startupReadyAt =
      Date.now() + this.config.startupCooldownSeconds * 1000;
  }

  canExecute(
    opportunity: Opportunity,
    now: number,
  ): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: false, reason: "disabled" };
    if (now < this.startupReadyAt)
      return { allowed: false, reason: "startup_cooldown" };
    if (fs.existsSync(this.config.killSwitchFile))
      return { allowed: false, reason: "kill_switch" };

    const cooldown = this.state.getMarketCooldown(opportunity.marketId);
    if (cooldown && cooldown > now)
      return { allowed: false, reason: "market_cooldown" };

    const hourAgo = now - 60 * 60 * 1000;
    if (this.state.countTradesSince(hourAgo) >= this.config.maxTradesPerHour) {
      return { allowed: false, reason: "rate_limit" };
    }

    if (
      this.state.getConsecutiveFailures() >= this.config.maxConsecutiveFailures
    ) {
      return { allowed: false, reason: "circuit_breaker" };
    }

    const fingerprint = this.fingerprint(opportunity, now);
    if (this.opportunityCache.has(fingerprint, now)) {
      return { allowed: false, reason: "duplicate" };
    }

    const marketExposure = this.state.getMarketExposure(opportunity.marketId);
    if (marketExposure + opportunity.sizeUsd * 2 > this.config.maxPositionUsd) {
      return { allowed: false, reason: "market_cap" };
    }

    const walletExposure = this.state.getWalletExposure();
    if (
      walletExposure + opportunity.sizeUsd * 2 >
      this.config.maxWalletExposureUsd
    ) {
      return { allowed: false, reason: "wallet_cap" };
    }

    return { allowed: true };
  }

  async onTradeSubmitted(opportunity: Opportunity, now: number): Promise<void> {
    const fingerprint = this.fingerprint(opportunity, now);
    this.opportunityCache.add(fingerprint, now);
    this.state.recordTradeTimestamp(now);
    this.state.addExposure(opportunity.marketId, opportunity.sizeUsd * 2);
    this.state.setMarketCooldown(
      opportunity.marketId,
      now + this.config.marketCooldownSeconds * 1000,
    );
    await this.state.snapshot();
  }

  async onTradeSuccess(opportunity: Opportunity, now: number): Promise<void> {
    this.state.resetFailures();
    await this.state.snapshot();
    this.logger.info(
      `[ARB] Trade success ${opportunity.marketId} size=${opportunity.sizeUsd.toFixed(2)} USD`,
    );
  }

  async onTradeFailure(
    opportunity: Opportunity,
    now: number,
    reason: string,
  ): Promise<void> {
    this.state.incrementFailure();
    await this.state.snapshot();
    this.logger.warn(`[ARB] Trade failure ${opportunity.marketId}: ${reason}`);
  }

  async ensureGasBalance(
    _now: number,
  ): Promise<{ ok: boolean; balance: number }> {
    const polBalance = await getPolBalance(this.wallet);
    if (polBalance < this.config.minPolGas) {
      this.logger.warn(
        `[ARB] POL balance below minimum: ${polBalance.toFixed(4)} < ${this.config.minPolGas}`,
      );
      return { ok: false, balance: polBalance };
    }
    return { ok: true, balance: polBalance };
  }

  private fingerprint(opportunity: Opportunity, now: number): string {
    const bucket = Math.floor(now / 60000);
    return [
      opportunity.marketId,
      opportunity.yesAsk.toFixed(4),
      opportunity.noAsk.toFixed(4),
      bucket,
      opportunity.sizeTier,
    ].join("|");
  }
}
