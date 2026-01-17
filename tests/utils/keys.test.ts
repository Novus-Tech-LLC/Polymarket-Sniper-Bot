import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrivateKey, redactPrivateKey } from "../../src/utils/keys";

test("parsePrivateKey accepts 64 hex chars without 0x prefix", () => {
  process.env.PRIVATE_KEY = "a".repeat(64);
  const result = parsePrivateKey();
  assert.equal(result, "0x" + "a".repeat(64));
  delete process.env.PRIVATE_KEY;
});

test("parsePrivateKey accepts 0x-prefixed 64 hex chars", () => {
  process.env.PRIVATE_KEY = "0x" + "b".repeat(64);
  const result = parsePrivateKey();
  assert.equal(result, "0x" + "b".repeat(64));
  delete process.env.PRIVATE_KEY;
});

test("parsePrivateKey trims whitespace", () => {
  process.env.PRIVATE_KEY = "  0x" + "c".repeat(64) + "  ";
  const result = parsePrivateKey();
  assert.equal(result, "0x" + "c".repeat(64));
  delete process.env.PRIVATE_KEY;
});

test("parsePrivateKey rejects invalid length", () => {
  process.env.PRIVATE_KEY = "a".repeat(32); // Too short
  assert.throws(() => parsePrivateKey(), /Invalid private key length/);
  delete process.env.PRIVATE_KEY;
});

test("parsePrivateKey rejects non-hex characters", () => {
  process.env.PRIVATE_KEY = "g".repeat(64); // Invalid hex
  assert.throws(() => parsePrivateKey(), /Invalid private key format/);
  delete process.env.PRIVATE_KEY;
});

test("parsePrivateKey throws on missing env var", () => {
  delete process.env.PRIVATE_KEY;
  assert.throws(() => parsePrivateKey(), /Missing PRIVATE_KEY/);
});

test("redactPrivateKey masks key safely", () => {
  const key =
    "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  const redacted = redactPrivateKey(key);
  assert.match(redacted, /^0xabcd\.\.\.7890$/);
});

test("redactPrivateKey handles short strings", () => {
  const short = "0x123";
  const redacted = redactPrivateKey(short);
  assert.equal(redacted, "***");
});
