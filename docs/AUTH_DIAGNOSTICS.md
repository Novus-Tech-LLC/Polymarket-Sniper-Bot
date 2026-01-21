# Authentication Diagnostics Guide

## Overview

This bot now includes enhanced authentication diagnostics to help you quickly identify and resolve CLOB authentication failures (401/403 errors).

## Quick Start

If you're experiencing authentication failures, run the auth probe command:

```bash
npm run auth:probe
```

The command will:

1. Attempt to derive CLOB API credentials from your PRIVATE_KEY
2. Verify the credentials with a test API call
3. Output a structured "Auth Story" with diagnostic information
4. Exit with code 0 (success) or 1 (failure)

## Example Output

### Success Case

```json
{
  "timestamp": "2026-01-20T19:17:20.309Z",
  "level": "info",
  "message": "✅ Auth successful - credentials verified",
  "context": {
    "runId": "run_1768936640308_431bd9b1",
    "category": "PREFLIGHT"
  }
}
```

### Failure Case with Root-Cause Analysis

```json
{
  "timestamp": "2026-01-20T19:17:20.310Z",
  "level": "error",
  "message": "❌ Credential derivation failed",
  "context": {
    "runId": "run_1768936640308_431bd9b1",
    "category": "CRED_DERIVE",
    "httpStatus": 401
  }
}
{
  "timestamp": "2026-01-20T19:17:20.311Z",
  "level": "error",
  "message": "Root-cause analysis:",
  "context": {
    "category": "SUMMARY"
  }
}
{
  "timestamp": "2026-01-20T19:17:20.311Z",
  "level": "error",
  "message": "401 Unauthorized - MOST LIKELY CAUSES:\n   1. HMAC signature mismatch (check secret encoding, message format, timestamp)\n   2. Invalid API credentials (try deleting .polymarket-credentials-cache.json and re-derive)\n   3. Wallet address mismatch (L1 auth header != actual wallet)\n   4. Wrong signature type (browser wallets need POLYMARKET_SIGNATURE_TYPE=2 + POLYMARKET_PROXY_ADDRESS)\n   Run: npm run wallet:detect  # to identify correct configuration",
  "context": {
    "category": "SUMMARY"
  }
}
```

## Common Failure Modes

### 401 Unauthorized

**Most Likely Causes:**

1. **HMAC signature mismatch** - Check secret encoding, message format, timestamp
2. **Invalid API credentials** - Delete `.polymarket-credentials-cache.json` and re-derive
3. **Wallet address mismatch** - L1 auth header doesn't match actual wallet
4. **Wrong signature type** - Browser wallets need `POLYMARKET_SIGNATURE_TYPE=2` AND `POLYMARKET_PROXY_ADDRESS`

**Solution Steps:**

1. Run `npm run wallet:detect` to identify your correct wallet configuration
2. Set the appropriate environment variables:
   - EOA wallets: No extra config needed
   - Browser/proxy wallets: Set `POLYMARKET_SIGNATURE_TYPE=2` and `POLYMARKET_PROXY_ADDRESS=<your-proxy-address>`
3. Delete `.polymarket-credentials-cache.json` if it exists
4. Re-run `npm run auth:probe` to verify

### 403 Forbidden

**Possible Causes:**

1. Account restricted or banned by Polymarket
2. Geographic restrictions (VPN/geoblock issue)
3. Rate limiting (too many failed auth attempts)

**Solution Steps:**

1. Verify your account is in good standing on polymarket.com
2. Try using a VPN if you're in a restricted region
3. Wait 15-30 minutes before retrying if rate-limited

### 400 Bad Request - "Could not create api key"

**Cause:** Wallet has not traded on Polymarket yet

**Solution:**

1. Visit https://polymarket.com
2. Make at least one trade (even a small one)
3. Wait a few minutes for the trade to settle
4. Re-run `npm run auth:probe`

Note: The first trade creates your CLOB API credentials on-chain

## Verbose Diagnostics

For detailed debugging information, run with debug logging enabled:

```bash
LOG_LEVEL=debug npm run auth:probe
```

This will show:

- Detailed HTTP request/response information
- HMAC signature components
- Credential fingerprints (no secrets leaked)
- Full Auth Story JSON

## Environment Variables

The auth probe respects these environment variables:

| Variable                    | Description                              | Required | Example                       |
| --------------------------- | ---------------------------------------- | -------- | ----------------------------- |
| `PRIVATE_KEY`               | Your wallet private key                  | ✅ Yes   | `0x...`                       |
| `POLYMARKET_SIGNATURE_TYPE` | Signature type (0=EOA, 1=Proxy, 2=Safe)  | Optional | `0`                           |
| `POLYMARKET_PROXY_ADDRESS`  | Proxy/Safe address (for browser wallets) | Optional | `0x...`                       |
| `CLOB_HOST`                 | CLOB API endpoint                        | Optional | `https://clob.polymarket.com` |
| `LOG_LEVEL`                 | Log verbosity (error, info, debug)       | Optional | `info`                        |
| `LOG_FORMAT`                | Log format (json, pretty)                | Optional | `json`                        |

## Security Notes

✅ **Safe**:

- Credential fingerprints (only show last 4-6 chars of API key)
- Secret lengths
- HTTP status codes

❌ **Never Logged**:

- Full private keys
- Full API secrets
- Full passphrases
- Complete HMAC signatures

All secret values are redacted before logging. You can safely share auth probe output for debugging.

## Integration with CI/CD

The auth probe command is CI-friendly:

- Exits with code 0 on success, 1 on failure
- Outputs structured JSON logs (parseable)
- Can be used in health checks or deployment verification

Example:

```bash
# In your CI pipeline
npm run auth:probe || echo "Authentication health check failed"
```

## Need More Help?

If the auth probe doesn't resolve your issue:

1. Check the [RUNBOOK.md](../RUNBOOK.md) for wallet configuration details
2. Review [CLOB_AUTH_AUTO_DETECTION.md](../CLOB_AUTH_AUTO_DETECTION.md) for fallback ladder details
3. Open an issue with your auth probe output (sanitized)
