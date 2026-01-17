import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlLruSet } from "../../src/arbitrage/utils/ttl-lru";

test("ttl lru set expires entries", () => {
  const set = new TtlLruSet(10, 100);
  const now = Date.now();
  set.add("key", now);
  assert.equal(set.has("key", now + 50), true);
  assert.equal(set.has("key", now + 200), false);
});
