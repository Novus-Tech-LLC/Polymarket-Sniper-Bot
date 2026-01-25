/**
 * Telegram Notification Service
 *
 * Sends notifications to a Telegram chat/topic when:
 * - Positions are bought
 * - Positions are sold
 * - Positions are redeemed
 * - Periodic P&L updates
 *
 * Configuration via environment variables:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 * - TELEGRAM_CHAT_ID: Chat ID (can be a group or user)
 * - TELEGRAM_TOPIC_ID: Optional topic ID for forum-style groups
 * - TELEGRAM_NOTIFICATION_NAME: Custom notification name (default: "Polymarket Alert")
 * - TELEGRAM_PNL_INTERVAL_MINUTES: Interval for P&L updates (default: 60)
 * - TELEGRAM_SILENT: Send notifications silently without sound (default: false)
 */

import type { Logger } from "../utils/logger.util";
import type { LedgerSummary } from "../strategies/pnl-ledger";

/**
 * Telegram configuration
 */
export interface TelegramConfig {
  /** Bot token from @BotFather */
  botToken: string;
  /** Chat ID (user or group) */
  chatId: string;
  /** Topic ID for forum-style groups (optional) */
  topicId?: string;
  /** Custom notification name (default: "Polymarket Alert") */
  notificationName: string;
  /** Interval for P&L updates in minutes (default: 60, set to 0 to disable) */
  pnlIntervalMinutes: number;
  /** Send notifications silently without sound (default: false) */
  silent: boolean;
  /** Enable/disable notifications */
  enabled: boolean;
}

/**
 * Default Telegram configuration
 */
export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: "",
  chatId: "",
  topicId: undefined,
  notificationName: "Polymarket Alert",
  pnlIntervalMinutes: 60,
  silent: false,
  enabled: false,
};

/**
 * Trade notification types
 */
export type TradeNotificationType = "BUY" | "SELL" | "REDEEM";

/**
 * Trade notification data
 */
export interface TradeNotification {
  type: TradeNotificationType;
  marketId: string;
  tokenId: string;
  outcome?: string;
  size: number;
  price: number;
  sizeUsd: number;
  pnl?: number;
  marketQuestion?: string;
}

/**
 * Telegram Notification Service
 */
export class TelegramService {
  private readonly config: TelegramConfig;
  private readonly logger: Logger;
  private pnlTimer?: NodeJS.Timeout;
  private lastPnlUpdateTime: number = 0;
  private getPnlSummary?: () => LedgerSummary;

  constructor(config: Partial<TelegramConfig>, logger: Logger) {
    this.config = {
      ...DEFAULT_TELEGRAM_CONFIG,
      ...config,
      enabled: Boolean(config.botToken && config.chatId),
    };
    this.logger = logger;

    if (this.config.enabled) {
      const silentMode = this.config.silent ? ", silent mode" : "";
      this.logger.info(
        `[Telegram] ✅ Notifications enabled (name: "${this.config.notificationName}"${silentMode})`,
      );
    } else {
      this.logger.debug(
        "[Telegram] Notifications disabled (missing bot token or chat ID)",
      );
    }
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Start periodic P&L updates
   */
  startPnlUpdates(getPnlSummary: () => LedgerSummary): void {
    if (!this.config.enabled || this.config.pnlIntervalMinutes <= 0) {
      return;
    }

    // Clear any existing timer before creating a new one
    if (this.pnlTimer) {
      clearInterval(this.pnlTimer);
      this.pnlTimer = undefined;
    }

    this.getPnlSummary = getPnlSummary;
    const intervalMs = this.config.pnlIntervalMinutes * 60 * 1000;

    this.pnlTimer = setInterval(() => {
      this.sendPnlUpdate().catch((err) => {
        this.logger.error(
          `[Telegram] Failed to send P&L update: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, intervalMs);

    this.logger.info(
      `[Telegram] P&L updates scheduled every ${this.config.pnlIntervalMinutes} minutes`,
    );
  }

  /**
   * Stop periodic P&L updates
   */
  stopPnlUpdates(): void {
    if (this.pnlTimer) {
      clearInterval(this.pnlTimer);
      this.pnlTimer = undefined;
    }
  }

  /**
   * Send a trade notification
   */
  async sendTradeNotification(trade: TradeNotification): Promise<boolean> {
    if (!this.config.enabled) return false;

    const emoji = this.getTradeEmoji(trade.type);
    const action = this.getTradeAction(trade.type);

    let message = `${emoji} <b>${this.escapeHtml(this.config.notificationName)}</b>\n\n`;
    message += `📍 <b>${action}</b>\n`;

    if (trade.marketQuestion) {
      message += `📊 Market: ${this.escapeHtml(trade.marketQuestion)}\n`;
    }

    if (trade.outcome) {
      message += `🎯 Outcome: ${this.escapeHtml(trade.outcome)}\n`;
    }

    message += `💵 Size: ${trade.size.toFixed(2)} shares\n`;
    message += `💰 Price: ${(trade.price * 100).toFixed(1)}¢\n`;
    message += `📊 Value: $${trade.sizeUsd.toFixed(2)}\n`;

    if (trade.pnl !== undefined) {
      const pnlEmoji = trade.pnl >= 0 ? "📈" : "📉";
      message += `${pnlEmoji} P&L: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}\n`;
    }

    message += `\n🔗 Market ID: <code>${trade.marketId.slice(0, 16)}...</code>`;

    return this.sendMessage(message);
  }

  /**
   * Send a P&L update
   */
  async sendPnlUpdate(): Promise<boolean> {
    if (!this.config.enabled || !this.getPnlSummary) return false;

    // Track performance of P&L summary generation
    const startTime = Date.now();
    const summary = this.getPnlSummary();
    const summaryDurationMs = Date.now() - startTime;

    // Log slow summary generation for performance monitoring
    if (summaryDurationMs > 1000) {
      this.logger.warn(
        `[Telegram] P&L summary generation took ${summaryDurationMs}ms (>1s) - consider optimizing if this persists`,
      );
    } else if (summaryDurationMs > 500) {
      this.logger.debug(
        `[Telegram] P&L summary generation took ${summaryDurationMs}ms`,
      );
    }

    const netEmoji = summary.netPnl >= 0 ? "🟢" : "🔴";

    let message = `📊 <b>${this.escapeHtml(this.config.notificationName)} - P&amp;L Update</b>\n\n`;
    message += `${netEmoji} <b>Net P&L: ${summary.netPnl >= 0 ? "+" : ""}$${summary.netPnl.toFixed(2)}</b>\n\n`;
    message += `💰 Realized: ${summary.totalRealizedPnl >= 0 ? "+" : ""}$${summary.totalRealizedPnl.toFixed(2)}\n`;
    message += `📈 Unrealized: ${summary.totalUnrealizedPnl >= 0 ? "+" : ""}$${summary.totalUnrealizedPnl.toFixed(2)}\n`;
    message += `💸 Fees: $${summary.totalFees.toFixed(2)}\n\n`;

    const totalTrades = summary.winningTrades + summary.losingTrades;
    if (totalTrades > 0) {
      message += `📉 Win Rate: ${(summary.winRate * 100).toFixed(1)}% (${summary.winningTrades}W / ${summary.losingTrades}L)\n`;
      message += `✅ Avg Win: $${summary.avgWin.toFixed(2)}\n`;
      message += `❌ Avg Loss: $${Math.abs(summary.avgLoss).toFixed(2)}\n`;

      if (summary.largestWin > 0) {
        message += `🏆 Best: +$${summary.largestWin.toFixed(2)}\n`;
      }
      if (summary.largestLoss < 0) {
        message += `💔 Worst: $${summary.largestLoss.toFixed(2)}\n`;
      }
    }

    this.lastPnlUpdateTime = Date.now();
    return this.sendMessage(message);
  }

  /**
   * Send a custom message
   */
  async sendCustomMessage(text: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    const message = `📢 <b>${this.escapeHtml(this.config.notificationName)}</b>\n\n${this.escapeHtml(text)}`;
    return this.sendMessage(message);
  }

  /**
   * Send a message to Telegram
   */
  private async sendMessage(text: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      const body: Record<string, string | number | boolean> = {
        chat_id: this.config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: this.config.silent,
      };

      // Add topic ID if specified (for forum-style groups)
      if (this.config.topicId) {
        const topicIdNum = Number.parseInt(this.config.topicId, 10);
        if (Number.isNaN(topicIdNum)) {
          this.logger.warn(
            `[Telegram] Invalid TELEGRAM_TOPIC_ID value "${this.config.topicId}" - skipping message_thread_id`,
          );
        } else {
          body.message_thread_id = topicIdNum;
        }
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let safeErrorMessage = "Unknown error";
        try {
          const parsed = JSON.parse(errorText) as {
            error_code?: number;
            description?: string;
          } | null;
          if (parsed && typeof parsed === "object") {
            const parts: string[] = [];
            if (typeof parsed.error_code === "number") {
              parts.push(`error_code=${parsed.error_code}`);
            }
            if (typeof parsed.description === "string") {
              parts.push(`description=${parsed.description}`);
            }
            if (parts.length > 0) {
              safeErrorMessage = parts.join(", ");
            } else {
              // Fallback: use a truncated version of the raw error text
              safeErrorMessage = errorText.slice(0, 200);
            }
          } else {
            safeErrorMessage = errorText.slice(0, 200);
          }
        } catch {
          // If the response is not valid JSON, log a truncated version
          safeErrorMessage = errorText.slice(0, 200);
        }
        this.logger.error(
          `[Telegram] API error (${response.status}): ${safeErrorMessage}`,
        );
        return false;
      }

      const data = (await response.json()) as { ok: boolean };
      if (!data.ok) {
        this.logger.error(`[Telegram] API returned ok=false`);
        return false;
      }

      this.logger.debug("[Telegram] Message sent successfully");
      return true;
    } catch (err) {
      this.logger.error(
        `[Telegram] Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get emoji for trade type (uses exported helper)
   */
  private getTradeEmoji(type: TradeNotificationType): string {
    return getTradeEmoji(type);
  }

  /**
   * Get action text for trade type (uses exported helper)
   */
  private getTradeAction(type: TradeNotificationType): string {
    return getTradeAction(type);
  }

  /**
   * Escape HTML entities for Telegram message (uses exported helper)
   */
  private escapeHtml(text: string): string {
    return escapeHtml(text);
  }
}

/**
 * Escape HTML entities for Telegram message
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Get emoji for trade notification type
 */
export function getTradeEmoji(type: TradeNotificationType): string {
  switch (type) {
    case "BUY":
      return "🛒";
    case "SELL":
      return "💵";
    case "REDEEM":
      return "🏦";
    default:
      return "📌";
  }
}

/**
 * Get action text for trade notification type
 */
export function getTradeAction(type: TradeNotificationType): string {
  switch (type) {
    case "BUY":
      return "Position Bought";
    case "SELL":
      return "Position Sold";
    case "REDEEM":
      return "Position Redeemed";
    default:
      return "Trade Executed";
  }
}

/**
 * Load Telegram configuration from environment variables
 */
export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  const topicId = process.env.TELEGRAM_TOPIC_ID || undefined;
  const notificationName =
    process.env.TELEGRAM_NOTIFICATION_NAME || DEFAULT_TELEGRAM_CONFIG.notificationName;
  const pnlIntervalMinutes = parseInt(
    process.env.TELEGRAM_PNL_INTERVAL_MINUTES ?? "60",
    10,
  );
  const silent = (process.env.TELEGRAM_SILENT ?? "").toLowerCase() === "true";

  return {
    botToken,
    chatId,
    topicId,
    notificationName,
    pnlIntervalMinutes: Number.isFinite(pnlIntervalMinutes) ? pnlIntervalMinutes : 60,
    silent,
    enabled: Boolean(botToken && chatId),
  };
}

/**
 * Create a Telegram service instance
 */
export function createTelegramService(logger: Logger): TelegramService {
  const config = loadTelegramConfig();
  return new TelegramService(config, logger);
}
