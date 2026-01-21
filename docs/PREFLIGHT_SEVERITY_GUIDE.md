# Preflight Error Severity Classification Guide

## Overview

The bot now intelligently classifies preflight check failures into three severity levels to prevent unnecessary trading blocks:

## Severity Levels

### 🔴 FATAL (Blocks Trading)
**Status Codes:** 401, 403  
**Meaning:** Authentication has truly failed - invalid credentials  
**Action:** Trading is blocked until auth is fixed  
**Example:**
```
[CLOB] Auth preflight failed (FATAL); switching to detect-only.
[Preflight][GasGuard] ⛔ BLOCKING ALL ON-CHAIN TRANSACTIONS
```

### 🟡 TRANSIENT (Allows Trading with Warning)
**Status Codes:** 500+, network errors (ECONNRESET, ETIMEDOUT)  
**Meaning:** Temporary server or network issue - credentials are likely valid  
**Action:** Trading continues with warning, will retry  
**Example:**
```
[CLOB] Auth preflight check failed (TRANSIENT); allowing trading with retry. status=503
```

### 🟢 NON_FATAL (Allows Trading with Warning)
**Status Codes:** 400 (bad params), unknown errors  
**Meaning:** Credentials are valid but preflight request had issues  
**Action:** Trading continues, issue is logged for diagnosis  
**Example:**
```
[CLOB] Auth preflight check failed (NON_FATAL) but credentials appear valid; allowing trading. status=400
```

## Decision Logic

```
┌─────────────────────────────────────┐
│    Preflight Check Fails            │
└──────────────┬──────────────────────┘
               │
               ▼
        ┌──────────────┐
        │ Status 401/  │  YES → FATAL → Block Trading
        │    403?      │────────────────────────────►
        └──────┬───────┘
               │ NO
               ▼
        ┌──────────────┐
        │ Network or   │  YES → TRANSIENT → Allow Trading
        │ 500+ error?  │────────────────────────────────►
        └──────┬───────┘
               │ NO
               ▼
        ┌──────────────┐
        │ Bad params   │  YES → NON_FATAL → Allow Trading
        │ or unknown?  │────────────────────────────────►
        └──────────────┘
```

## Examples

### Before This Fix ❌
```
✅ Successfully derived CLOB credentials
✅ Credentials validated with /auth/derive-api-key
❌ Preflight /balance-allowance returned unknown error (network glitch)
❌ authOk = false
❌ GasGuard blocks ALL trading
```

### After This Fix ✅
```
✅ Successfully derived CLOB credentials  
✅ Credentials validated with /auth/derive-api-key
⚠️  Preflight /balance-allowance returned unknown error (network glitch)
✅ Severity: TRANSIENT (not blocking)
✅ authOk = true
✅ Trading proceeds with warning
```

## Environment Variable Override

For testing or when you're confident your credentials work despite preflight failures:

```bash
# In .env file (NOT RECOMMENDED for production)
ALLOW_TRADING_WITHOUT_PREFLIGHT=true
```

This bypasses the GasGuard entirely. Only use for:
- Testing in development
- Temporary workaround while investigating specific issues
- Cases where you've verified credentials work via other means

## Error Classification Details

### FATAL Errors
- **When:** Polymarket API explicitly rejects credentials
- **HTTP Status:** 401 (Unauthorized), 403 (Forbidden)
- **Message Examples:**
  - "Unauthorized"
  - "Invalid api key"
  - "Invalid signature"
- **Resolution:** Fix credentials, check signature type, verify wallet address

### TRANSIENT Errors
- **When:** Infrastructure or temporary issues
- **HTTP Status:** 500, 502, 503, 504
- **Error Codes:** ECONNRESET, ETIMEDOUT
- **Message Examples:**
  - "Service temporarily unavailable"
  - "Gateway timeout"
  - "Connection reset"
- **Resolution:** Wait and retry, check network, verify Polymarket API status

### NON_FATAL Errors
- **When:** Request format issues, not auth problems
- **HTTP Status:** 400 (Bad Request), other 4xx
- **Message Examples:**
  - "Invalid asset type"
  - "Missing required parameter"
  - Unknown error without status
- **Resolution:** Check request parameters, update API usage if needed

## Auth Story Integration

The Auth Story now includes severity in its output:

```json
{
  "attemptId": "A",
  "mode": "EOA",
  "httpStatus": 500,
  "severity": "TRANSIENT",
  "errorTextShort": "Transient: Server error",
  "success": true
}
```

Note: `success: true` for TRANSIENT/NON_FATAL means "credentials are OK, trading is allowed"

## FAQ

**Q: Why does trading continue if preflight failed?**  
A: If the failure is TRANSIENT or NON_FATAL, your credentials are likely valid. The preflight check is a health check, not a credential validator. We've already validated creds via `/auth/derive-api-key`.

**Q: Is it safe to trade with a failed preflight?**  
A: It depends on the severity:
- FATAL (401/403): No - credentials are definitely invalid
- TRANSIENT (network/server): Yes - temporary issue, will retry
- NON_FATAL (params/unknown): Yes - credentials valid, just a request issue

**Q: How do I know which severity caused the issue?**  
A: Check logs for:
- `FATAL` = "Auth preflight failed (FATAL); switching to detect-only"
- `TRANSIENT` = "Auth preflight check failed (TRANSIENT); allowing trading"
- `NON_FATAL` = "Auth preflight check failed (NON_FATAL) but credentials appear valid"

**Q: What if I keep seeing TRANSIENT failures?**  
A: This suggests persistent network or API issues. Check:
1. Your internet connection
2. Polymarket API status
3. VPN/proxy configuration
4. Rate limiting

**Q: Can I force trading even with FATAL errors?**  
A: Not recommended, but yes via `ALLOW_TRADING_WITHOUT_PREFLIGHT=true`. However, your orders will likely fail at the API level anyway.
