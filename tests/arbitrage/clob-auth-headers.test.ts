import { test } from "node:test";
import assert from "node:assert/strict";
import { createL2Headers } from "@polymarket/clob-client";
import { getAuthHeaderPresence } from "../../src/utils/clob-auth-headers.util";

test("auth headers include API key, passphrase, and signature when creds are set", async () => {
  const signer = {
    getAddress: async () => "0xabc",
  };

  const headers = await createL2Headers(
    signer,
    { key: "key", secret: "c2VjcmV0", passphrase: "passphrase" },
    { method: "GET", requestPath: "/auth/api-keys" },
    1_700_000_000,
  );

  const presence = getAuthHeaderPresence(headers);
  assert.equal(presence.apiKeyHeaderPresent, true);
  assert.equal(presence.passphraseHeaderPresent, true);
  assert.equal(presence.signatureHeaderPresent, true);
});
