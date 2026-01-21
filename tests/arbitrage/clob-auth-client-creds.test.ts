import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ClobClient } from "@polymarket/clob-client";
import {
  initializeApiCreds,
  refreshApiCreds,
  resetApiCredsCache,
} from "../../src/infrastructure/clob-auth";

afterEach(() => {
  resetApiCredsCache();
});

test("initializeApiCreds recognizes credentials already on client instance", async () => {
  const client = {
    creds: {
      key: "client-key",
      secret: "client-secret",
      passphrase: "client-pass",
    },
  } as unknown as ClobClient;

  const result = await initializeApiCreds(client);

  assert.deepEqual(result, {
    key: "client-key",
    secret: "client-secret",
    passphrase: "client-pass",
  });
});

test("refreshApiCreds recognizes credentials already on client instance", async () => {
  const client = {
    creds: {
      key: "refresh-key",
      secret: "refresh-secret",
      passphrase: "refresh-pass",
    },
  } as unknown as ClobClient;

  const result = await refreshApiCreds(client);

  assert.deepEqual(result, {
    key: "refresh-key",
    secret: "refresh-secret",
    passphrase: "refresh-pass",
  });
});

test("initializeApiCreds caches client credentials for future use", async () => {
  const client1 = {
    creds: {
      key: "cache-key",
      secret: "cache-secret",
      passphrase: "cache-pass",
    },
  } as unknown as ClobClient;

  // First call should find creds on client
  await initializeApiCreds(client1);

  // Second call with a different client should use cached creds
  let appliedCreds:
    | { key: string; secret: string; passphrase: string }
    | undefined;

  const client2 = {} as unknown as ClobClient;
  Object.defineProperty(client2, "creds", {
    set: (value: { key: string; secret: string; passphrase: string }) => {
      appliedCreds = value;
    },
  });

  const result = await initializeApiCreds(client2);

  assert.deepEqual(result, {
    key: "cache-key",
    secret: "cache-secret",
    passphrase: "cache-pass",
  });
  assert.deepEqual(appliedCreds, {
    key: "cache-key",
    secret: "cache-secret",
    passphrase: "cache-pass",
  });
});

test("initializeApiCreds prioritizes provided creds over client creds", async () => {
  const client = {
    creds: {
      key: "client-key",
      secret: "client-secret",
      passphrase: "client-pass",
    },
  } as unknown as ClobClient;

  let appliedCreds:
    | { key: string; secret: string; passphrase: string }
    | undefined;

  Object.defineProperty(client, "creds", {
    get: () => ({
      key: "client-key",
      secret: "client-secret",
      passphrase: "client-pass",
    }),
    set: (value: { key: string; secret: string; passphrase: string }) => {
      appliedCreds = value;
    },
  });

  const result = await initializeApiCreds(client, {
    key: "provided-key",
    secret: "provided-secret",
    passphrase: "provided-pass",
  });

  assert.deepEqual(result, {
    key: "provided-key",
    secret: "provided-secret",
    passphrase: "provided-pass",
  });
  assert.deepEqual(appliedCreds, {
    key: "provided-key",
    secret: "provided-secret",
    passphrase: "provided-pass",
  });
});
