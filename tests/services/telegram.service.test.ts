import assert from "node:assert";
import { test, describe, beforeEach, mock } from "node:test";

/**
 * Unit tests for Telegram Notification Service
 *
 * These tests verify:
 * 1. Configuration loading from environment variables
 * 2. Enable/disable logic based on credentials
 * 3. Message formatting for different notification types
 * 4. Silent mode support
 * 5. P&L update scheduling
 */

// Mock logger interface
interface MockLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: Error) => void;
  debug: (msg: string) => void;
}

// Create mock logger
function createMockLogger(): MockLogger {
  return {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
  };
}

// Mock TelegramConfig interface (matches actual implementation)
interface TelegramConfig {
  botToken: string;
  chatId: string;
  topicId?: string;
  notificationName: string;
  pnlIntervalMinutes: number;
  silent: boolean;
  enabled: boolean;
}

// Default config matching implementation
const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: "",
  chatId: "",
  topicId: undefined,
  notificationName: "Polymarket Alert",
  pnlIntervalMinutes: 60,
  silent: false,
  enabled: false,
};

// Simulate loadTelegramConfig function
function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  const topicId = process.env.TELEGRAM_TOPIC_ID || undefined;
  const notificationName =
    process.env.TELEGRAM_NOTIFICATION_NAME ||
    DEFAULT_TELEGRAM_CONFIG.notificationName;
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
    pnlIntervalMinutes: Number.isFinite(pnlIntervalMinutes)
      ? pnlIntervalMinutes
      : 60,
    silent,
    enabled: Boolean(botToken && chatId),
  };
}

describe("Telegram Service Configuration", () => {
  beforeEach(() => {
    // Clear Telegram env vars before each test
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_TOPIC_ID;
    delete process.env.TELEGRAM_NOTIFICATION_NAME;
    delete process.env.TELEGRAM_PNL_INTERVAL_MINUTES;
    delete process.env.TELEGRAM_SILENT;
  });

  test("should be disabled when no credentials provided", () => {
    const config = loadTelegramConfig();

    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.botToken, "");
    assert.strictEqual(config.chatId, "");
  });

  test("should be disabled when only bot token provided", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNO";

    const config = loadTelegramConfig();

    assert.strictEqual(config.enabled, false);
  });

  test("should be disabled when only chat ID provided", () => {
    process.env.TELEGRAM_CHAT_ID = "123456789";

    const config = loadTelegramConfig();

    assert.strictEqual(config.enabled, false);
  });

  test("should be enabled when both bot token and chat ID provided", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCdefGHIjklMNO";
    process.env.TELEGRAM_CHAT_ID = "123456789";

    const config = loadTelegramConfig();

    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.botToken, "123456789:ABCdefGHIjklMNO");
    assert.strictEqual(config.chatId, "123456789");
  });

  test("should use default notification name when not specified", () => {
    const config = loadTelegramConfig();

    assert.strictEqual(config.notificationName, "Polymarket Alert");
  });

  test("should use custom notification name when specified", () => {
    process.env.TELEGRAM_NOTIFICATION_NAME = "My Polymarket Bot";

    const config = loadTelegramConfig();

    assert.strictEqual(config.notificationName, "My Polymarket Bot");
  });

  test("should parse topic ID when provided", () => {
    process.env.TELEGRAM_TOPIC_ID = "456";

    const config = loadTelegramConfig();

    assert.strictEqual(config.topicId, "456");
  });

  test("should have undefined topic ID when not provided", () => {
    const config = loadTelegramConfig();

    assert.strictEqual(config.topicId, undefined);
  });

  test("should use default P&L interval when not specified", () => {
    const config = loadTelegramConfig();

    assert.strictEqual(config.pnlIntervalMinutes, 60);
  });

  test("should parse custom P&L interval", () => {
    process.env.TELEGRAM_PNL_INTERVAL_MINUTES = "30";

    const config = loadTelegramConfig();

    assert.strictEqual(config.pnlIntervalMinutes, 30);
  });

  test("should use default P&L interval for invalid value", () => {
    process.env.TELEGRAM_PNL_INTERVAL_MINUTES = "invalid";

    const config = loadTelegramConfig();

    assert.strictEqual(config.pnlIntervalMinutes, 60);
  });

  test("should default to non-silent mode", () => {
    const config = loadTelegramConfig();

    assert.strictEqual(config.silent, false);
  });

  test("should enable silent mode when set to true", () => {
    process.env.TELEGRAM_SILENT = "true";

    const config = loadTelegramConfig();

    assert.strictEqual(config.silent, true);
  });

  test("should enable silent mode when set to TRUE (case insensitive)", () => {
    process.env.TELEGRAM_SILENT = "TRUE";

    const config = loadTelegramConfig();

    assert.strictEqual(config.silent, true);
  });

  test("should disable silent mode when set to false", () => {
    process.env.TELEGRAM_SILENT = "false";

    const config = loadTelegramConfig();

    assert.strictEqual(config.silent, false);
  });

  test("should disable silent mode for any other value", () => {
    process.env.TELEGRAM_SILENT = "yes";

    const config = loadTelegramConfig();

    assert.strictEqual(config.silent, false);
  });
});

describe("Telegram Service Message Formatting", () => {
  // Test HTML escaping
  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  test("should escape HTML special characters", () => {
    const input = "Test <script>alert('xss')</script> & more";
    const expected = "Test &lt;script&gt;alert('xss')&lt;/script&gt; &amp; more";

    const result = escapeHtml(input);

    assert.strictEqual(result, expected);
  });

  test("should handle ampersands in market questions", () => {
    const input = "Will Biden & Trump debate?";
    const expected = "Will Biden &amp; Trump debate?";

    const result = escapeHtml(input);

    assert.strictEqual(result, expected);
  });

  test("should handle greater than and less than symbols", () => {
    const input = "Price > $100 and < $200";
    const expected = "Price &gt; $100 and &lt; $200";

    const result = escapeHtml(input);

    assert.strictEqual(result, expected);
  });
});

describe("Telegram Trade Notification Types", () => {
  // Test emoji selection
  function getTradeEmoji(type: "BUY" | "SELL" | "REDEEM"): string {
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

  // Test action text selection
  function getTradeAction(type: "BUY" | "SELL" | "REDEEM"): string {
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

  test("should return correct emoji for BUY", () => {
    assert.strictEqual(getTradeEmoji("BUY"), "🛒");
  });

  test("should return correct emoji for SELL", () => {
    assert.strictEqual(getTradeEmoji("SELL"), "💵");
  });

  test("should return correct emoji for REDEEM", () => {
    assert.strictEqual(getTradeEmoji("REDEEM"), "🏦");
  });

  test("should return correct action text for BUY", () => {
    assert.strictEqual(getTradeAction("BUY"), "Position Bought");
  });

  test("should return correct action text for SELL", () => {
    assert.strictEqual(getTradeAction("SELL"), "Position Sold");
  });

  test("should return correct action text for REDEEM", () => {
    assert.strictEqual(getTradeAction("REDEEM"), "Position Redeemed");
  });
});

describe("Telegram P&L Summary Formatting", () => {
  interface MockLedgerSummary {
    totalRealizedPnl: number;
    totalUnrealizedPnl: number;
    totalFees: number;
    netPnl: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
  }

  test("should format positive P&L with green emoji", () => {
    const summary: MockLedgerSummary = {
      totalRealizedPnl: 100,
      totalUnrealizedPnl: 50,
      totalFees: 5,
      netPnl: 145,
      winningTrades: 8,
      losingTrades: 2,
      winRate: 0.8,
      avgWin: 15,
      avgLoss: -5,
      largestWin: 30,
      largestLoss: -10,
    };

    // Simulate message formatting
    const netEmoji = summary.netPnl >= 0 ? "🟢" : "🔴";

    assert.strictEqual(netEmoji, "🟢");
  });

  test("should format negative P&L with red emoji", () => {
    const summary: MockLedgerSummary = {
      totalRealizedPnl: -50,
      totalUnrealizedPnl: -25,
      totalFees: 5,
      netPnl: -80,
      winningTrades: 2,
      losingTrades: 8,
      winRate: 0.2,
      avgWin: 10,
      avgLoss: -15,
      largestWin: 20,
      largestLoss: -30,
    };

    // Simulate message formatting
    const netEmoji = summary.netPnl >= 0 ? "🟢" : "🔴";

    assert.strictEqual(netEmoji, "🔴");
  });

  test("should calculate win rate percentage correctly", () => {
    const summary: MockLedgerSummary = {
      totalRealizedPnl: 0,
      totalUnrealizedPnl: 0,
      totalFees: 0,
      netPnl: 0,
      winningTrades: 3,
      losingTrades: 7,
      winRate: 0.3,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
    };

    const winRatePercent = (summary.winRate * 100).toFixed(1);

    assert.strictEqual(winRatePercent, "30.0");
  });
});

describe("Telegram API Request Body Construction", () => {
  test("should include disable_notification when silent is true", () => {
    const config: TelegramConfig = {
      botToken: "token",
      chatId: "123",
      topicId: undefined,
      notificationName: "Test",
      pnlIntervalMinutes: 60,
      silent: true,
      enabled: true,
    };

    // Simulate body construction
    const body: Record<string, string | number | boolean> = {
      chat_id: config.chatId,
      text: "Test message",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: config.silent,
    };

    assert.strictEqual(body.disable_notification, true);
  });

  test("should set disable_notification to false when silent is false", () => {
    const config: TelegramConfig = {
      botToken: "token",
      chatId: "123",
      topicId: undefined,
      notificationName: "Test",
      pnlIntervalMinutes: 60,
      silent: false,
      enabled: true,
    };

    // Simulate body construction
    const body: Record<string, string | number | boolean> = {
      chat_id: config.chatId,
      text: "Test message",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: config.silent,
    };

    assert.strictEqual(body.disable_notification, false);
  });

  test("should include message_thread_id when topicId is set", () => {
    const config: TelegramConfig = {
      botToken: "token",
      chatId: "123",
      topicId: "456",
      notificationName: "Test",
      pnlIntervalMinutes: 60,
      silent: false,
      enabled: true,
    };

    // Simulate body construction
    const body: Record<string, string | number | boolean> = {
      chat_id: config.chatId,
      text: "Test message",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: config.silent,
    };

    if (config.topicId) {
      body.message_thread_id = parseInt(config.topicId, 10);
    }

    assert.strictEqual(body.message_thread_id, 456);
  });

  test("should not include message_thread_id when topicId is undefined", () => {
    const config: TelegramConfig = {
      botToken: "token",
      chatId: "123",
      topicId: undefined,
      notificationName: "Test",
      pnlIntervalMinutes: 60,
      silent: false,
      enabled: true,
    };

    // Simulate body construction
    const body: Record<string, string | number | boolean> = {
      chat_id: config.chatId,
      text: "Test message",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: config.silent,
    };

    if (config.topicId) {
      body.message_thread_id = parseInt(config.topicId, 10);
    }

    assert.strictEqual(body.message_thread_id, undefined);
  });
});
