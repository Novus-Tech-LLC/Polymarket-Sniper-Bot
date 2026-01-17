import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { runClobAuthPreflight } from "../../src/clob/diagnostics";

const createLogger = () => {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      error: () => undefined,
      debug: () => undefined,
    },
  };
};

test("preflight logging includes error code and message when axios has no response", async () => {
  const { warnings, logger } = createLogger();
  const originalGet = axios.get;

  axios.get = async () => {
    const error = new Error("no route to host");
    (error as { code?: string }).code = "EHOSTUNREACH";
    throw error;
  };

  try {
    await runClobAuthPreflight({
      client: {} as never,
      logger,
      creds: { key: "key", secret: "secret", passphrase: "pass" },
      privateKeyPresent: true,
    });
  } finally {
    axios.get = originalGet;
  }

  assert.ok(
    warnings.some(
      (entry) =>
        entry.includes("code=EHOSTUNREACH") &&
        entry.includes("message=no route to host"),
    ),
  );
});
