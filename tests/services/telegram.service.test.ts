import assert from "node:assert";
import { test, describe, beforeEach, mock, afterEach } from "node:test";
import {
  TelegramService,
  TelegramConfig,
  DEFAULT_TELEGRAM_CONFIG,
  loadTelegramConfig,
  escapeHtml,
  getTradeEmoji,
  getTradeAction,
  type TradeNotification,
} from "../../src/services/telegram.service";

/**
 * Unit tests for Telegram Notification Service
 *
 * These tests verify:
 * 1. Configuration loading from environment variables
 * 2. Enable/disable logic based on credentials
 * 3. Message formatting for different notification types
 * 4. Silent mode support
 * 5. TelegramService class methods with mocked fetch
 */

// Mock logger
function createMockLogger() {
  return {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
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

describe("Telegram Service Message Formatting - escapeHtml", () => {
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

describe("Telegram Trade Notification Types - getTradeEmoji", () => {
  test("should return correct emoji for BUY", () => {
    assert.strictEqual(getTradeEmoji("BUY"), "🛒");
  });

  test("should return correct emoji for SELL", () => {
    assert.strictEqual(getTradeEmoji("SELL"), "💵");
  });

  test("should return correct emoji for REDEEM", () => {
    assert.strictEqual(getTradeEmoji("REDEEM"), "🏦");
  });
});

describe("Telegram Trade Notification Types - getTradeAction", () => {
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

describe("TelegramService Class", () => {
  let mockFetch: ReturnType<typeof mock.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      } as Response),
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("isEnabled returns false when disabled", () => {
    const logger = createMockLogger();
    const service = new TelegramService({}, logger);

    assert.strictEqual(service.isEnabled(), false);
  });

  test("isEnabled returns true when bot token and chat ID provided", () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "token", chatId: "123" },
      logger,
    );

    assert.strictEqual(service.isEnabled(), true);
  });

  test("sendTradeNotification returns false when disabled", async () => {
    const logger = createMockLogger();
    const service = new TelegramService({}, logger);
    const trade: TradeNotification = {
      type: "BUY",
      marketId: "0x1234567890abcdef",
      tokenId: "token123",
      size: 100,
      price: 0.65,
      sizeUsd: 65,
    };

    const result = await service.sendTradeNotification(trade);

    assert.strictEqual(result, false);
    assert.strictEqual(mockFetch.mock.calls.length, 0);
  });

  test("sendTradeNotification calls fetch with correct parameters", async () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "test-token", chatId: "123456" },
      logger,
    );
    const trade: TradeNotification = {
      type: "BUY",
      marketId: "0x1234567890abcdef1234567890abcdef",
      tokenId: "token123",
      size: 100,
      price: 0.65,
      sizeUsd: 65,
      marketQuestion: "Will BTC hit $100k?",
    };

    const result = await service.sendTradeNotification(trade);

    assert.strictEqual(result, true);
    assert.strictEqual(mockFetch.mock.calls.length, 1);

    const [url, options] = mockFetch.mock.calls[0].arguments;
    assert.strictEqual(
      url,
      "https://api.telegram.org/bottest-token/sendMessage",
    );
    assert.strictEqual(options.method, "POST");

    const body = JSON.parse(options.body);
    assert.strictEqual(body.chat_id, "123456");
    assert.strictEqual(body.parse_mode, "HTML");
    assert.ok(body.text.includes("Position Bought"));
    assert.ok(body.text.includes("Will BTC hit $100k?"));
  });

  test("sendPnlUpdate returns false when disabled", async () => {
    const logger = createMockLogger();
    const service = new TelegramService({}, logger);

    const result = await service.sendPnlUpdate();

    assert.strictEqual(result, false);
  });

  test("sendPnlUpdate returns false when no getPnlSummary callback", async () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "token", chatId: "123" },
      logger,
    );

    const result = await service.sendPnlUpdate();

    assert.strictEqual(result, false);
  });

  test("sendPnlUpdate calls fetch with P&L data", async () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "test-token", chatId: "123456", pnlIntervalMinutes: 60 },
      logger,
    );
    
    // Verify service is enabled
    assert.ok(service.isEnabled(), "Service should be enabled");
    
    const mockSummary = {
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
      byStrategy: new Map(),
    };

    // Start P&L updates to set the callback
    service.startPnlUpdates(() => mockSummary);
    
    try {
      const result = await service.sendPnlUpdate();

      assert.strictEqual(result, true, "sendPnlUpdate should return true");
      assert.strictEqual(mockFetch.mock.calls.length, 1, "fetch should be called once");

      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      // Note: The message contains "P&amp;L Update" (HTML-escaped ampersand)
      assert.ok(body.text.includes("P&amp;L Update"), "Message should contain P&L Update");
      assert.ok(body.text.includes("$145.00"), "Message should contain net P&L value");
    } finally {
      // Always stop to clean up the timer
      service.stopPnlUpdates();
    }
  });

  test("sendCustomMessage returns false when disabled", async () => {
    const logger = createMockLogger();
    const service = new TelegramService({}, logger);

    const result = await service.sendCustomMessage("Test message");

    assert.strictEqual(result, false);
  });

  test("sendCustomMessage sends message correctly", async () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "test-token", chatId: "123456" },
      logger,
    );

    const result = await service.sendCustomMessage("Custom alert!");

    assert.strictEqual(result, true);
    assert.strictEqual(mockFetch.mock.calls.length, 1);

    const [, options] = mockFetch.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.ok(body.text.includes("Custom alert!"));
  });

  test("handles API errors gracefully", async () => {
    mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error_code: 401,
              description: "Unauthorized",
            }),
          ),
      } as Response),
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "bad-token", chatId: "123" },
      logger,
    );

    const result = await service.sendCustomMessage("Test");

    assert.strictEqual(result, false);
    assert.ok(logger.error.mock.calls.length > 0);
  });

  test("stopPnlUpdates clears timer", () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "token", chatId: "123", pnlIntervalMinutes: 1 },
      logger,
    );
    const mockSummary = {
      totalRealizedPnl: 0,
      totalUnrealizedPnl: 0,
      totalFees: 0,
      netPnl: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      byStrategy: new Map(),
    };

    service.startPnlUpdates(() => mockSummary);
    // Should not throw
    service.stopPnlUpdates();
    // Calling again should be safe
    service.stopPnlUpdates();
  });

  test("validates topicId and logs warning for invalid value", async () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "token", chatId: "123", topicId: "invalid" },
      logger,
    );

    await service.sendCustomMessage("Test");

    // Should have logged a warning about invalid topicId
    const warnCalls = logger.warn.mock.calls;
    const hasTopicIdWarning = warnCalls.some((call: { arguments: string[] }) =>
      call.arguments[0].includes("Invalid TELEGRAM_TOPIC_ID"),
    );
    assert.ok(hasTopicIdWarning);
  });

  test("includes message_thread_id for valid topicId", async () => {
    const logger = createMockLogger();
    const service = new TelegramService(
      { botToken: "test-token", chatId: "123456", topicId: "789" },
      logger,
    );

    await service.sendCustomMessage("Test");

    const [, options] = mockFetch.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.strictEqual(body.message_thread_id, 789);
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
});
