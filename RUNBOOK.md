# CLOB Authentication Runbook

## Overview

This runbook explains how to configure the Polymarket CLOB authentication for different wallet types and use cases.

## Prerequisites

- **PRIVATE_KEY**: Your wallet's private key (64 hex characters, no 0x prefix)
- **RPC_URL**: Polygon RPC endpoint (e.g., `https://polygon-rpc.com`)
- **Wallet funded**: At least 0.01 POL for gas fees
- **Wallet approved**: First-time users MUST visit polymarket.com and make at least one trade to enable API access

## Authentication Modes

### Mode 1: EOA (Standard Wallet) - Recommended for Most Users

This is the simplest and most common configuration for direct wallet usage.

#### Environment Variables

```bash
# Required
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=your_private_key_here  # No 0x prefix

# Enable credential derivation
CLOB_DERIVE_CREDS=true

# Enable live trading
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

#### What Happens

1. Bot derives L1 identity from PRIVATE_KEY
2. Bot calls `/auth/derive-api-key` to retrieve existing API credentials (if wallet has traded before)
3. If no credentials exist, bot calls `/auth/api-key` to create new credentials
4. Credentials are saved to `/data/clob-creds.json` for reuse
5. All trading uses these L2 API credentials

#### Verification

```bash
# Run preflight check
npm run preflight

# Look for these logs:
# [CLOB][Auth] mode=MODE_B_DERIVED signatureType=0 walletMode="EOA (direct wallet)"
# [L1Auth] Configuration: addressMode: default (signer)
# [CLOB] Successfully created/derived API credentials via deriveApiKey.
```

---

### Mode 2: Gnosis Safe / Browser Wallet

When you've created a Polymarket account via the web browser, a Gnosis Safe proxy wallet is created for you. You need both:
- **Signer EOA**: The private key that controls the Safe (for L1 auth)
- **Proxy/Safe Address**: The Safe contract address (for L2 trading)

#### Environment Variables

```bash
# Required
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=your_signer_eoa_private_key  # EOA that controls the Safe

# Proxy configuration
POLYMARKET_SIGNATURE_TYPE=2  # 2 = Gnosis Safe
POLYMARKET_PROXY_ADDRESS=0xYourSafeContractAddress  # The Safe address

# Enable credential derivation
CLOB_DERIVE_CREDS=true

# Enable live trading
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

#### How to Find Your Safe Address

1. Visit https://polymarket.com and connect your wallet
2. Look at your profile or account settings
3. The "Trading Address" or "Deposit Address" is your Safe address
4. Or check PolygonScan for Safe deployments from your EOA

#### What Happens

1. Bot uses **signer EOA** for L1 authentication (derive/create API keys)
2. Bot uses **Safe address** as the maker/funder for L2 trading
3. Orders are signed by the signer EOA but attributed to the Safe address

#### Verification

```bash
npm run preflight

# Look for these logs:
# [CLOB][Auth] mode=MODE_B_DERIVED_MODE_C_PROXY signatureType=2 walletMode="Gnosis Safe"
# [CLOB][Auth] Using Gnosis Safe: signer=0x... (EOA for signing), maker/funder=0x... (proxy for orders)
# [L1Auth] signerAddress: 0x... effectiveAddress: 0x...
```

---

### Mode 3: Legacy Polymarket Proxy (Rare)

Only for wallets created via the old Polymarket proxy system (before Gnosis Safe).

#### Environment Variables

```bash
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=your_signer_eoa_private_key

# Legacy proxy configuration
POLYMARKET_SIGNATURE_TYPE=1  # 1 = POLY_PROXY
POLYMARKET_PROXY_ADDRESS=0xYourProxyContractAddress

CLOB_DERIVE_CREDS=true
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

---

## Advanced Configuration

### Debug HTTP Headers

Enable detailed logging of HTTP headers (with redaction) to diagnose authentication issues:

```bash
DEBUG_HTTP_HEADERS=true
```

This logs:
- Request method and path
- All header names
- Redacted header values (first 4 + last 4 characters)

Example output:
```
[L1Auth] HTTP Request Debug:
  Method: GET
  Path: /auth/derive-api-key
[L1Auth] HTTP Headers (redacted):
  POLY_ADDRESS: 0x1234...5678
  POLY_SIGNATURE: 0x12...ab
  POLY_TIMESTAMP: 1737187338
  POLY_NONCE: 0
```

### Force Signature Type

Override auto-detection and force a specific signature type:

```bash
CLOB_FORCE_SIGNATURE_TYPE=0  # 0=EOA, 1=Proxy, 2=Gnosis Safe
```

**Warning**: Only use this if you know exactly which signature type your wallet needs. Incorrect values will cause authentication failures.

---

## Troubleshooting

### Error: "401 Unauthorized - Invalid L1 Request headers"

**Cause**: L1 authentication headers are missing or incorrect.

**Solutions**:
1. Verify the patch is applied: `npm install` (should show "Applying patches...")
2. Check that `CLOB_DERIVE_CREDS=true` is set
3. Enable debug logging: `DEBUG_HTTP_HEADERS=true`
4. For proxy wallets, ensure `POLYMARKET_SIGNATURE_TYPE` and `POLYMARKET_PROXY_ADDRESS` are set correctly

### Error: "400 Bad Request - Could not create api key"

**Cause**: Wallet has never traded on Polymarket or is not approved.

**Solution**:
1. Visit https://polymarket.com
2. Connect your wallet
3. Make at least one small trade (e.g., bet $1 on any market)
4. Wait for transaction confirmation
5. Restart the bot

### Error: "Invalid api key" after deriving credentials

**Cause**: Derived credentials don't match the wallet's signature type.

**Solutions**:
1. Delete `/data/clob-creds.json`
2. Verify `POLYMARKET_SIGNATURE_TYPE` matches your wallet type:
   - Direct wallet = 0 (or omit)
   - Gnosis Safe = 2
3. Restart the bot

### Wrong wallet address in logs

**Symptom**: Bot shows different address than expected in `[CLOB][Auth]` logs.

**Solution**: Check these in order:
1. For Gnosis Safe: Set `POLYMARKET_PROXY_ADDRESS` to your Safe address
2. Verify `PRIVATE_KEY` matches the correct wallet
3. Check `POLYMARKET_SIGNATURE_TYPE`:
   - 0 = Uses derived signer address
   - 2 = Uses proxy/funder address

---

## Configuration Examples

### Example 1: Direct EOA Trading

```bash
# .env
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
CLOB_DERIVE_CREDS=true
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

Expected logs:
```
[CLOB][Auth] mode=MODE_B_DERIVED signatureType=0 walletMode="EOA (direct wallet)"
[L1Auth] addressMode: default (signer)
```

### Example 2: Gnosis Safe with Debug

```bash
# .env
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
POLYMARKET_SIGNATURE_TYPE=2
POLYMARKET_PROXY_ADDRESS=0xb40336eF345ADA17bb36665b6193476004785A21
CLOB_DERIVE_CREDS=true
DEBUG_HTTP_HEADERS=true
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

Expected logs:
```
[CLOB][Auth] mode=MODE_B_DERIVED_MODE_C_PROXY signatureType=2 walletMode="Gnosis Safe"
[CLOB][Auth] Using Gnosis Safe: signer=0x9B9883... (EOA for signing), maker/funder=0xb40336... (proxy for orders)
[L1Auth] forceSignatureType: auto-detect, debugHttpHeaders: true
[L1Auth] HTTP Request Debug: Method: GET, Path: /auth/derive-api-key
```

### Example 3: Force Signature Type for Testing

```bash
# .env
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
CLOB_DERIVE_CREDS=true
CLOB_FORCE_SIGNATURE_TYPE=0  # Override auto-detection
DEBUG_HTTP_HEADERS=true
ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
```

---

## Quick Self-Test

### Test 1: Verify Patch Applied

```bash
# Check that params: {} is added to createApiKey and deriveApiKey
grep -A 2 "createApiKey\|deriveApiKey" node_modules/@polymarket/clob-client/dist/client.js | grep "params: {}"

# Should output two lines with "params: {}"
```

### Test 2: Test L1 Header Generation

```bash
# Run the L1 auth header tests
npm test -- tests/arbitrage/l1-auth-headers.test.ts

# Should pass all tests
```

### Test 3: Test Full Credential Derivation

```bash
# Set environment variables
export RPC_URL="https://polygon-rpc.com"
export PRIVATE_KEY="your_test_key"
export CLOB_DERIVE_CREDS="true"
export DEBUG_HTTP_HEADERS="true"

# Run preflight check
npm run preflight

# Check for successful credential derivation in logs
```

### Test 4: Verify Correct Headers (Manual curl test)

**Note**: This requires a running bot or manual implementation of EIP-712 signing.

```bash
# Example curl (won't work directly - signature must be generated)
curl -v "https://clob.polymarket.com/auth/derive-api-key" \
  -H "POLY_ADDRESS: 0xYourAddress" \
  -H "POLY_SIGNATURE: 0x..." \
  -H "POLY_TIMESTAMP: $(date +%s)" \
  -H "POLY_NONCE: 0"

# Expected: 200 OK with API credentials
# Common errors:
# - 401 "Invalid L1 Request headers" = missing header or wrong signature
# - 400 "Could not create api key" = wallet not approved on Polymarket
```

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | Yes | - | Polygon RPC endpoint |
| `PRIVATE_KEY` | Yes | - | Wallet private key (64 hex chars, no 0x) |
| `CLOB_DERIVE_CREDS` | No | `false` | Enable automatic credential derivation |
| `POLYMARKET_SIGNATURE_TYPE` | No | Auto-detect | 0=EOA, 1=Proxy, 2=Gnosis Safe |
| `POLYMARKET_PROXY_ADDRESS` | Conditional | - | Required if signature_type=1 or 2 |
| `DEBUG_HTTP_HEADERS` | No | `false` | Log HTTP headers (redacted) |
| `CLOB_FORCE_SIGNATURE_TYPE` | No | Auto-detect | Override signature type: 0, 1, or 2 |
| `ARB_LIVE_TRADING` | Yes | - | Must be `I_UNDERSTAND_THE_RISKS` |

---

## Security Notes

1. **Never commit `.env` files**: Keep credentials secure
2. **Private keys**: Store securely, never in code or public repos
3. **API credentials**: Cached in `/data/clob-creds.json` - secure this directory
4. **Debug logs**: `DEBUG_HTTP_HEADERS` redacts secrets but still outputs sensitive data - use only for debugging
5. **Proxy addresses**: Safe addresses are public, but keep signer EOA private

---

## Support

If you encounter issues:

1. Check the [main README](../README.md) for general setup
2. Review [CLOB_AUTH_DEBUGGING.md](../docs/CLOB_AUTH_DEBUGGING.md) for comprehensive authentication debugging
3. Review [AUTH_TROUBLESHOOTING.md](../docs/AUTH_TROUBLESHOOTING.md) for common issues (if exists)
4. Enable `DEBUG_HTTP_HEADERS=true` and `CLOB_DEBUG_CANON=true` and check logs
5. Verify patch applied: `npm install` shows "Applying patches..."
6. Test with preflight: `npm run preflight`

### Debug Environment Variables

For deep authentication debugging, use these environment variables:

```bash
# Enable detailed request canonicalization logs
CLOB_DEBUG_CANON=true

# Enable HTTP header logging (redacted)
DEBUG_HTTP_HEADERS=true

# Enable automatic credential derivation
CLOB_DERIVE_CREDS=true
```

See [CLOB_AUTH_DEBUGGING.md](../docs/CLOB_AUTH_DEBUGGING.md) for detailed debugging workflow.
