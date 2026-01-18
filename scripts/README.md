# CLOB Authentication Smoke Test

## Purpose

This standalone script tests the complete Polymarket CLOB authentication flow without running the full bot. Use it to verify your credentials and configuration before starting the bot.

## What It Tests

1. **Environment validation** - Checks required environment variables
2. **Wallet connection** - Verifies private key and RPC connection
3. **L1 authentication** - Tests API key derivation/creation
4. **L2 authentication** - Tests authenticated balance query
5. **Output** - Prints "AUTH OK" if all tests pass

## Usage

### Basic EOA Mode

```bash
export PRIVATE_KEY=0x1234567890123456789012345678901234567890123456789012345678901234
ts-node scripts/clob_auth_smoke_test.ts
```

### Safe/Proxy Mode

```bash
export PRIVATE_KEY=0x1234567890123456789012345678901234567890123456789012345678901234
export CLOB_SIGNATURE_TYPE=2
export CLOB_FUNDER=0xb403364076a14e239452f0cb4273bd6814314ce3
ts-node scripts/clob_auth_smoke_test.ts
```

### With Custom RPC

```bash
export PRIVATE_KEY=0x...
export RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_KEY
ts-node scripts/clob_auth_smoke_test.ts
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | Yes | - | Private key of the signer EOA (with or without 0x prefix) |
| `CLOB_HOST` | No | https://clob.polymarket.com | CLOB API host |
| `RPC_URL` | No | https://polygon-rpc.com | Polygon RPC endpoint |
| `CLOB_FUNDER` | Conditional* | - | Funder/proxy address for Safe/Proxy mode |
| `CLOB_SIGNATURE_TYPE` | No | 0 | Signature type: 0=EOA, 1=Proxy, 2=Safe |

\* Required when `CLOB_SIGNATURE_TYPE` is 1 or 2

**Alternative Names:**
- `CLOB_FUNDER` or `POLYMARKET_PROXY_ADDRESS`
- `CLOB_SIGNATURE_TYPE` or `POLYMARKET_SIGNATURE_TYPE`

## Expected Output

### Success

```
╔═══════════════════════════════════════════════════════════════════╗
║         Polymarket CLOB Authentication Smoke Test                ║
╚═══════════════════════════════════════════════════════════════════╝

======================================================================
1. Validating Environment
======================================================================

✅ Private Key: 0x1234...1234
✅ CLOB Host: https://clob.polymarket.com
✅ RPC URL: https://polygon-rpc.com
✅ Signature Type: 0 (EOA)

======================================================================
2. Testing Wallet Connection
======================================================================

✅ Wallet Address: 0x9B9883152BfFeFB1cBE2A96FC0391537012ee5D1
✅ POL Balance: 0.1234 POL

======================================================================
3. Testing L1 Authentication (Derive/Create API Key)
======================================================================

ℹ️  Creating CLOB client for L1 auth...
ℹ️  Attempting to derive API key (for existing wallets)...
✅ API Key derived successfully
ℹ️    API Key: 01234567...abcd
ℹ️    Secret: dGVzdC1z...1234
ℹ️    Passphrase: test...word

======================================================================
4. Testing L2 Authentication (Balance Allowance)
======================================================================

ℹ️  Creating CLOB client with credentials...
ℹ️  Fetching balance allowance...
✅ Balance allowance fetched successfully
ℹ️    Balance: 1000.00
ℹ️    Allowance: 1000.00

======================================================================
Summary
======================================================================

✅ AUTH OK - All authentication tests passed!
ℹ️  Your configuration is correct and ready for use.
```

### Failure: Invalid L1 Headers

```
======================================================================
3. Testing L1 Authentication (Derive/Create API Key)
======================================================================

ℹ️  Creating CLOB client for L1 auth...
ℹ️  Attempting to derive API key (for existing wallets)...
❌ ERROR: L1 authentication failed with 'Invalid L1 Request headers'
❌ ERROR: This indicates that L1 headers are not correctly formatted
ℹ️  Expected L1 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE
ℹ️  Should NOT include: POLY_API_KEY, POLY_PASSPHRASE
❌ ERROR: L1 authentication failed. Exiting.
```

**Fix:** Check that your code is not adding L2 headers to L1 requests. L1 auth should use only EIP-712 signature.

### Failure: Wallet Not Activated

```
======================================================================
3. Testing L1 Authentication (Derive/Create API Key)
======================================================================

ℹ️  Creating CLOB client for L1 auth...
ℹ️  Attempting to derive API key (for existing wallets)...
⚠️  deriveApiKey failed: 400 - Could not create api key
ℹ️  Attempting to create new API key...
⚠️  Wallet has not traded on Polymarket yet
ℹ️  To fix: Visit polymarket.com, connect this wallet, and make at least one trade
❌ ERROR: L1 authentication failed. Exiting.
```

**Fix:**
1. Visit https://polymarket.com
2. Connect your wallet (use the private key you're testing with)
3. Make at least one trade (any amount)
4. Run the test again

### Failure: L2 Auth (HMAC Mismatch)

```
======================================================================
4. Testing L2 Authentication (Balance Allowance)
======================================================================

ℹ️  Creating CLOB client with credentials...
ℹ️  Fetching balance allowance...
❌ Balance allowance failed: 401 Unauthorized
ℹ️  This indicates L2 HMAC signature is incorrect
ℹ️  Expected L2 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
ℹ️  HMAC message format: timestamp + method + path (with query params) + body
❌ ERROR: L2 authentication failed. Exiting.
```

**Common causes:**
1. **Query parameters not included in signature** - Use patched clob-client
2. **Wrong secret decoding** - Secret should be base64, not base64url
3. **Wrong POLY_ADDRESS** - Should be funder in Safe mode, signer in EOA mode

---

## Troubleshooting

### Error: Missing PRIVATE_KEY

```
❌ ERROR: PRIVATE_KEY environment variable is required
```

Set the PRIVATE_KEY environment variable:
```bash
export PRIVATE_KEY=0x...
```

### Error: Invalid Private Key Length

```
❌ ERROR: Invalid private key length: 64 (expected 66 with 0x prefix)
```

Add the `0x` prefix:
```bash
export PRIVATE_KEY=0x1234567890123456789012345678901234567890123456789012345678901234
```

### Error: Signature Type Requires Funder

```
❌ ERROR: Signature type 2 requires CLOB_FUNDER or POLYMARKET_PROXY_ADDRESS
```

Set the funder address:
```bash
export CLOB_FUNDER=0xb403364076a14e239452f0cb4273bd6814314ce3
```

### Warning: Low POL Balance

```
⚠️  POL Balance: 0.0001 POL (LOW - may not have gas for transactions)
```

Your wallet has very low POL (Polygon MATIC). You'll need gas for transactions:
1. Bridge some MATIC to Polygon
2. Or buy POL on a Polygon DEX

---

## Running from Docker

If running in Docker, you can exec into the container:

```bash
# Run smoke test inside Docker container
docker exec -it polymarket-copy-bot \
  bash -c "export PRIVATE_KEY=0x... && ts-node scripts/clob_auth_smoke_test.ts"
```

Or add to docker-compose.yml:

```yaml
services:
  test-auth:
    image: polymarket-copy-bot
    env_file: .env
    command: ts-node scripts/clob_auth_smoke_test.ts
```

Then run:
```bash
docker-compose run --rm test-auth
```

---

## Integration with CI/CD

Use exit codes for automation:
- Exit 0: All tests passed
- Exit 1: At least one test failed

```bash
#!/bin/bash
if ts-node scripts/clob_auth_smoke_test.ts; then
  echo "Auth tests passed, starting bot..."
  npm start
else
  echo "Auth tests failed, not starting bot"
  exit 1
fi
```

---

## See Also

- [Polymarket Auth Guide](../docs/POLYMARKET_AUTH_GUIDE.md) - Complete auth documentation
- [Main README](../README.md) - Bot setup and usage
- [RUNBOOK](../RUNBOOK.md) - Operational guide
