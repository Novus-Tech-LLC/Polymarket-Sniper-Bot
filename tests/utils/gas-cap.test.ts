import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { validateGasCap } from "../../src/utils/gas";

// Helper to create a mock logger that captures log calls
const createMockLogger = () => {
  const logs: { level: string; message: string }[] = [];
  return {
    logs,
    info: (msg: string) => logs.push({ level: "info", message: msg }),
    warn: (msg: string) => logs.push({ level: "warn", message: msg }),
    error: (msg: string) => logs.push({ level: "error", message: msg }),
    debug: (msg: string) => logs.push({ level: "debug", message: msg }),
  };
};

// Helper to parse gwei to bigint
const parseGwei = (gwei: number): bigint => parseUnits(String(gwei), "gwei");

// Helper to save and restore environment variables
const withEnv = (
  envVars: Record<string, string | undefined>,
  fn: () => void,
) => {
  const originalEnv = { ...process.env };
  try {
    // Clear relevant env vars first
    delete process.env.POLY_MAX_FEE_GWEI_CAP;
    delete process.env.poly_max_fee_gwei_cap;
    // Set test env vars
    for (const [key, value] of Object.entries(envVars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  }
};

// Test: Gas price below cap - transaction proceeds (no error)
test("validateGasCap allows gas price below cap", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(50); // 50 gwei, well below cap
    const logger = createMockLogger();

    // Should not throw
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should not log any warnings or errors
    const warningOrErrorLogs = logger.logs.filter(
      (log) => log.level === "warn" || log.level === "error",
    );
    assert.equal(
      warningOrErrorLogs.length,
      0,
      "No warnings or errors expected when gas price is below cap",
    );
  });
});

// Test: Gas price exceeds cap - throws error
test("validateGasCap throws when gas price exceeds cap", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(150); // 150 gwei, exceeds 100 gwei cap
    const logger = createMockLogger();

    assert.throws(
      () => validateGasCap(maxFeePerGas, logger),
      (err: Error) => {
        return (
          err.message.includes("GAS PRICE TOO HIGH") &&
          err.message.includes("150.00 gwei") &&
          err.message.includes("100 gwei")
        );
      },
      "Should throw with gas price details",
    );

    // Should have logged an error
    const errorLogs = logger.logs.filter((log) => log.level === "error");
    assert.equal(errorLogs.length, 1, "Should log one error");
    assert.ok(
      errorLogs[0].message.includes("GAS PRICE TOO HIGH"),
      "Error should mention gas price too high",
    );
  });
});

// Test: Gas price at 80%+ of cap - warning issued
test("validateGasCap warns when gas price is at 80%+ of cap", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(85); // 85 gwei, 85% of cap
    const logger = createMockLogger();

    // Should not throw
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should log a warning
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 1, "Should log one warning");
    assert.ok(
      warnLogs[0].message.includes("85% of cap"),
      "Warning should mention percentage of cap",
    );
    assert.ok(
      warnLogs[0].message.includes("Consider waiting"),
      "Warning should suggest waiting",
    );
  });
});

// Test: Gas price exactly at 80% threshold - warning issued
test("validateGasCap warns when gas price is exactly at 80% threshold", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(81); // 81 gwei, just over 80%
    const logger = createMockLogger();

    // Should not throw
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should log a warning
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 1, "Should log one warning");
  });
});

// Test: Gas price below 80% threshold - no warning
test("validateGasCap does not warn when gas price is below 80% threshold", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(79); // 79 gwei, just below 80%
    const logger = createMockLogger();

    // Should not throw
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should not log any warnings
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 0, "Should not log any warnings");
  });
});

// Test: Invalid POLY_MAX_FEE_GWEI_CAP value (non-numeric) - gracefully skips validation
test("validateGasCap skips validation for non-numeric cap value", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "invalid" }, () => {
    const maxFeePerGas = parseGwei(1000); // Very high gas price
    const logger = createMockLogger();

    // Should not throw even with very high gas price
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should log a warning about invalid config
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 1, "Should log one warning about invalid config");
    assert.ok(
      warnLogs[0].message.includes("Invalid POLY_MAX_FEE_GWEI_CAP"),
      "Warning should mention invalid config",
    );
    assert.ok(
      warnLogs[0].message.includes("Skipping gas cap validation"),
      "Warning should mention skipping validation",
    );
  });
});

// Test: Invalid POLY_MAX_FEE_GWEI_CAP value (negative) - gracefully skips validation
test("validateGasCap skips validation for negative cap value", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "-50" }, () => {
    const maxFeePerGas = parseGwei(1000); // Very high gas price
    const logger = createMockLogger();

    // Should not throw even with very high gas price
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should log a warning about invalid config
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 1, "Should log one warning about invalid config");
    assert.ok(
      warnLogs[0].message.includes("Invalid POLY_MAX_FEE_GWEI_CAP"),
      "Warning should mention invalid config",
    );
  });
});

// Test: Invalid POLY_MAX_FEE_GWEI_CAP value (zero) - gracefully skips validation
test("validateGasCap skips validation for zero cap value", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "0" }, () => {
    const maxFeePerGas = parseGwei(1000); // Very high gas price
    const logger = createMockLogger();

    // Should not throw even with very high gas price
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should log a warning about invalid config
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 1, "Should log one warning about invalid config");
  });
});

// Test: Cap not configured - skips validation
test("validateGasCap skips validation when cap not configured", () => {
  withEnv({}, () => {
    const maxFeePerGas = parseGwei(1000); // Very high gas price
    const logger = createMockLogger();

    // Should not throw even with very high gas price
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // Should not log anything
    assert.equal(logger.logs.length, 0, "Should not log anything when cap not configured");
  });
});

// Test: Gas price at exact cap boundary - throws error
test("validateGasCap throws when gas price equals cap (boundary test)", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    // Exact boundary: slightly above 100 gwei (100.000001 gwei)
    const maxFeePerGas = parseGwei(100) + 1n;
    const logger = createMockLogger();

    assert.throws(
      () => validateGasCap(maxFeePerGas, logger),
      (err: Error) => err.message.includes("GAS PRICE TOO HIGH"),
      "Should throw when gas price exceeds cap",
    );
  });
});

// Test: Gas price exactly at cap - should not throw
test("validateGasCap allows gas price exactly at cap", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(100); // Exactly at cap
    const logger = createMockLogger();

    // Should not throw when exactly at cap
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas, logger));

    // But should warn since it's at 100% of cap (above 80% threshold)
    const warnLogs = logger.logs.filter((log) => log.level === "warn");
    assert.equal(warnLogs.length, 1, "Should log warning at 100% of cap");
  });
});

// Test: Works without logger (logger is optional)
test("validateGasCap works without logger parameter", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(50);

    // Should not throw without logger
    assert.doesNotThrow(() => validateGasCap(maxFeePerGas));
  });
});

// Test: Throws without logger when cap exceeded
test("validateGasCap throws without logger when cap exceeded", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "100" }, () => {
    const maxFeePerGas = parseGwei(150);

    // Should throw even without logger
    assert.throws(
      () => validateGasCap(maxFeePerGas),
      (err: Error) => err.message.includes("GAS PRICE TOO HIGH"),
    );
  });
});

// Test: Lowercase env var is also read
test("validateGasCap reads lowercase env var", () => {
  withEnv({ poly_max_fee_gwei_cap: "100" }, () => {
    const maxFeePerGas = parseGwei(150);
    const logger = createMockLogger();

    assert.throws(
      () => validateGasCap(maxFeePerGas, logger),
      (err: Error) => err.message.includes("GAS PRICE TOO HIGH"),
    );
  });
});

// Test: Decimal cap value works correctly
test("validateGasCap handles decimal cap values", () => {
  withEnv({ POLY_MAX_FEE_GWEI_CAP: "50.5" }, () => {
    const maxFeePerGas = parseGwei(51);
    const logger = createMockLogger();

    assert.throws(
      () => validateGasCap(maxFeePerGas, logger),
      (err: Error) => {
        return (
          err.message.includes("GAS PRICE TOO HIGH") &&
          err.message.includes("50.5 gwei")
        );
      },
    );
  });
});
