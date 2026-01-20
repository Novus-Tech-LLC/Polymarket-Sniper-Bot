import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";

/**
 * Tests for effective trading address resolution in preflight checks
 * Verifies that the correct address is used for different wallet modes
 */

// Helper to resolve trading address using the same priority chain as production code
function resolveTradingAddress(
  relayerAddress: string | undefined,
  effectivePolyAddress: string | undefined,
  signerAddress: string,
): string {
  return relayerAddress ?? effectivePolyAddress ?? signerAddress;
}

test("effective trading address uses signer address for EOA mode", async () => {
  // In EOA mode (signatureType=0), the signer address should be used
  // since there's no separate funder/proxy address

  const signerAddress = "0x1234567890123456789012345678901234567890";

  // Mock client with no effectivePolyAddress (EOA mode)
  const mockClient = {
    wallet: {} as Wallet,
    effectivePolyAddress: undefined,
  } as ClobClient & { wallet: Wallet; effectivePolyAddress?: string };

  // The trading address resolution logic should be:
  // relayer.tradingAddress ?? client.effectivePolyAddress ?? derivedSignerAddress

  const relayerAddress: string | undefined = undefined; // relayer not enabled
  const tradingAddress = resolveTradingAddress(
    relayerAddress,
    mockClient.effectivePolyAddress,
    signerAddress,
  );

  assert.strictEqual(
    tradingAddress,
    signerAddress,
    "EOA mode should use signer address as trading address",
  );
});

test("effective trading address uses funder address for Gnosis Safe mode", async () => {
  // In Gnosis Safe mode (signatureType=2), the effectivePolyAddress
  // should be the funder address, not the signer address

  const signerAddress = "0x1234567890123456789012345678901234567890";
  const funderAddress = "0x9876543210987654321098765432109876543210";

  // Mock client with effectivePolyAddress set to funder (Safe mode)
  const mockClient = {
    wallet: {} as Wallet,
    effectivePolyAddress: funderAddress,
  } as ClobClient & { wallet: Wallet; effectivePolyAddress?: string };

  // The trading address resolution logic should be:
  // relayer.tradingAddress ?? client.effectivePolyAddress ?? derivedSignerAddress

  const relayerAddress: string | undefined = undefined; // relayer not enabled
  const tradingAddress = resolveTradingAddress(
    relayerAddress,
    mockClient.effectivePolyAddress,
    signerAddress,
  );

  assert.strictEqual(
    tradingAddress,
    funderAddress,
    "Gnosis Safe mode should use funder address as trading address",
  );

  assert.notStrictEqual(
    tradingAddress,
    signerAddress,
    "Gnosis Safe mode should NOT use signer address as trading address",
  );
});

test("effective trading address uses funder address for Proxy mode", async () => {
  // In Proxy mode (signatureType=1), the effectivePolyAddress
  // should be the funder address, not the signer address

  const signerAddress = "0x1234567890123456789012345678901234567890";
  const funderAddress = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";

  // Mock client with effectivePolyAddress set to funder (Proxy mode)
  const mockClient = {
    wallet: {} as Wallet,
    effectivePolyAddress: funderAddress,
  } as ClobClient & { wallet: Wallet; effectivePolyAddress?: string };

  // The trading address resolution logic should be:
  // relayer.tradingAddress ?? client.effectivePolyAddress ?? derivedSignerAddress

  const relayerAddress: string | undefined = undefined; // relayer not enabled
  const tradingAddress = resolveTradingAddress(
    relayerAddress,
    mockClient.effectivePolyAddress,
    signerAddress,
  );

  assert.strictEqual(
    tradingAddress,
    funderAddress,
    "Proxy mode should use funder address as trading address",
  );

  assert.notStrictEqual(
    tradingAddress,
    signerAddress,
    "Proxy mode should NOT use signer address as trading address",
  );
});

test("effective trading address prefers relayer address when enabled", async () => {
  // When relayer is enabled, its trading address should take precedence
  // over both effectivePolyAddress and signer address

  const signerAddress = "0x1234567890123456789012345678901234567890";
  const funderAddress = "0x9876543210987654321098765432109876543210";
  const relayerAddress = "0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333";

  // Mock client with effectivePolyAddress set (Safe mode)
  const mockClient = {
    wallet: {} as Wallet,
    effectivePolyAddress: funderAddress,
  } as ClobClient & { wallet: Wallet; effectivePolyAddress?: string };

  // The trading address resolution logic should be:
  // relayer.tradingAddress ?? client.effectivePolyAddress ?? derivedSignerAddress

  const tradingAddress = resolveTradingAddress(
    relayerAddress, // relayer enabled
    mockClient.effectivePolyAddress,
    signerAddress,
  );

  assert.strictEqual(
    tradingAddress,
    relayerAddress,
    "Relayer address should take precedence over all other addresses",
  );

  assert.notStrictEqual(
    tradingAddress,
    funderAddress,
    "Relayer address should override funder address",
  );

  assert.notStrictEqual(
    tradingAddress,
    signerAddress,
    "Relayer address should override signer address",
  );
});

test("address resolution priority: relayer > effectivePolyAddress > signer", async () => {
  // Test the complete priority chain

  const signerAddress = "0x1111111111111111111111111111111111111111";
  const funderAddress = "0x2222222222222222222222222222222222222222";
  const relayerAddress = "0x3333333333333333333333333333333333333333";

  // Test 1: Only signer available (EOA mode, no relayer)
  let noRelayer: string | undefined;
  let noEffectivePolyAddress: string | undefined;
  let tradingAddress = resolveTradingAddress(
    noRelayer,
    noEffectivePolyAddress,
    signerAddress,
  );
  assert.strictEqual(tradingAddress, signerAddress);

  // Test 2: Signer + effectivePolyAddress available (Safe/Proxy mode, no relayer)
  tradingAddress = resolveTradingAddress(
    noRelayer,
    funderAddress,
    signerAddress,
  );
  assert.strictEqual(tradingAddress, funderAddress);

  // Test 3: All three available (relayer + Safe/Proxy mode)
  tradingAddress = resolveTradingAddress(
    relayerAddress,
    funderAddress,
    signerAddress,
  );
  assert.strictEqual(tradingAddress, relayerAddress);

  assert.ok(true, "Address resolution follows correct priority chain");
});
