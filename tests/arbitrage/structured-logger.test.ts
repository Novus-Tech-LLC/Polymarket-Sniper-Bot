/**
 * Tests for Structured Logger
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  StructuredLogger,
  generateRunId,
  generateReqId,
  generateAttemptId,
} from "../../src/utils/structured-logger";

describe("StructuredLogger", () => {
  it("should generate unique run IDs", () => {
    const id1 = generateRunId();
    const id2 = generateRunId();

    assert.ok(id1.startsWith("run_"));
    assert.ok(id2.startsWith("run_"));
    assert.notEqual(id1, id2);
  });

  it("should generate unique request IDs", () => {
    const id1 = generateReqId();
    const id2 = generateReqId();

    assert.ok(id1.startsWith("req_"));
    assert.ok(id2.startsWith("req_"));
    assert.notEqual(id1, id2);
  });

  it("should generate attempt IDs", () => {
    assert.equal(generateAttemptId(0), "A");
    assert.equal(generateAttemptId(1), "B");
    assert.equal(generateAttemptId(2), "C");
    assert.equal(generateAttemptId(3), "D");
    assert.equal(generateAttemptId(4), "E");
  });

  it("should create logger with default format", () => {
    const logger = new StructuredLogger();
    assert.ok(logger);
  });

  it("should create logger with json format", () => {
    const logger = new StructuredLogger({ format: "json" });
    assert.ok(logger);
  });

  it("should create logger with pretty format", () => {
    const logger = new StructuredLogger({ format: "pretty" });
    assert.ok(logger);
  });

  it("should create child logger with additional context", () => {
    const logger = new StructuredLogger();
    const child = logger.child({ category: "TEST", testId: "123" });
    assert.ok(child);
  });

  it("should redact privateKey in context", () => {
    const logger = new StructuredLogger({ level: "debug" });

    // Capture console output
    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => {
      captured = msg;
    };

    logger.debug("Test with private key", {
      privateKey:
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    });

    console.log = originalLog;

    // Check that full private key is not in output
    assert.ok(!captured.includes("0x1234567890abcdef1234567890abcdef"));
    assert.ok(captured.includes("[REDACTED"));
  });

  it("should redact apiKey in context", () => {
    const logger = new StructuredLogger({ level: "debug" });

    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => {
      captured = msg;
    };

    logger.debug("Test with API key", {
      apiKey: "sk_test_1234567890abcdef",
    });

    console.log = originalLog;

    // Should show last 6 chars only
    assert.ok(!captured.includes("sk_test_123456"));
    assert.ok(captured.includes("***"));
  });

  it("should redact secret in context", () => {
    const logger = new StructuredLogger({ level: "debug" });

    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => {
      captured = msg;
    };

    logger.debug("Test with secret", {
      secret: "verylongsecretkey1234567890",
    });

    console.log = originalLog;

    // Should show first 4 and last 4 chars only with length
    assert.ok(!captured.includes("verylongsecretkey"));
    assert.ok(captured.includes("very"));
    assert.ok(captured.includes("7890"));
    assert.ok(captured.includes("len="));
  });

  it("should redact passphrase in context", () => {
    const logger = new StructuredLogger({ level: "debug" });

    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => {
      captured = msg;
    };

    logger.debug("Test with passphrase", {
      passphrase: "my-secret-passphrase-123",
    });

    console.log = originalLog;

    // Should show first 4 and last 4 chars only
    assert.ok(!captured.includes("my-secret-passphrase"));
    assert.ok(captured.includes("my-s"));
    assert.ok(captured.includes("-123"));
  });

  it("should log at info level by default", () => {
    const logger = new StructuredLogger();

    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => {
      captured = msg;
    };

    logger.info("Test info message");
    const infoLogged = captured !== "";

    captured = "";
    logger.debug("Test debug message");
    const debugLogged = captured !== "";

    console.log = originalLog;

    assert.ok(infoLogged, "Info should be logged at default level");
    assert.ok(!debugLogged, "Debug should not be logged at default level");
  });

  it("should log debug when level is debug", () => {
    const logger = new StructuredLogger({ level: "debug" });

    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => {
      captured = msg;
    };

    logger.debug("Test debug message");

    console.log = originalLog;

    assert.ok(captured !== "", "Debug should be logged when level is debug");
  });

  it("should shutdown cleanly", () => {
    const logger = new StructuredLogger();
    logger.shutdown();
    assert.ok(true, "Shutdown should complete without error");
  });
});
