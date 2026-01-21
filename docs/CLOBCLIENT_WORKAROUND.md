# ClobClient createOrDeriveApiKey Workaround

## Problem

The `createOrDeriveApiKey()` method in `@polymarket/clob-client` has a bug where it attempts to create a new API key first, then falls back to deriving an existing key if creation fails. This causes issues when an API key already exists for the wallet.

### Symptoms

- 401 "Unauthorized/Invalid api key" errors
- GET requests work fine (e.g., `getBalanceAllowance()`, `getOrders()`)
- POST requests fail (e.g., `postOrder()`)
- Errors occur even with valid API credentials

### Affected Methods

- JavaScript: `ClobClient.createOrDeriveApiKey()`
- Python: `ClobClient.create_or_derive_api_creds()` (Note: This repository patches the JavaScript library; Python reference is for context only)

## Root Cause

The original implementation tries operations in the wrong order:

```javascript
// BUGGY IMPLEMENTATION (original)
async createOrDeriveApiKey(nonce) {
    return this.createApiKey(nonce).then(response => {
        if (!response.key) {
            return this.deriveApiKey(nonce);
        }
        return response;
    });
}
```

**Problem**: When an API key already exists, `createApiKey()` fails, causing the entire method to fail before attempting `deriveApiKey()`.

## Solution

The workaround reverses the order: try to derive an existing key first, and only create a new one if derivation fails.

```javascript
// FIXED IMPLEMENTATION (workaround)
async createOrDeriveApiKey(nonce) {
    // Attempt to derive first, then create as fallback
    // There is an issue with createOrDeriveApiKey() where createApiKey fails if key exists
    // See: https://github.com/Polymarket/clob-client/issues/202
    try {
        return await this.deriveApiKey(nonce);
    } catch (e) {
        return await this.createApiKey(nonce);
    }
}
```

## Implementation in This Repository

### 1. Patch File

The fix is applied via `patches/@polymarket+clob-client+5.2.1.patch` using `patch-package`. This patches the installed `@polymarket/clob-client` library to use the correct implementation.

### 2. Credential Derivation Module

The `src/clob/credential-derivation-v2.ts` module already implements the correct pattern when calling the API directly (abbreviated for brevity):

```typescript
// Try deriveApiKey first (for existing wallets)
if (deriveFn.deriveApiKey) {
  try {
    creds = await deriveFn.deriveApiKey();
  } catch (deriveError) {
    // If it's an "Invalid L1 Request headers" error, don't try createApiKey
    // because the issue is with the auth configuration, not whether the key exists
    if (isInvalidL1HeadersError(deriveError)) {
      return {
        success: false,
        error: "Invalid L1 Request headers",
        statusCode: 401,
      };
    }
    // Otherwise, continue to try createApiKey
  }
}

// If deriveApiKey didn't work, try createApiKey
if (!creds && deriveFn.createApiKey) {
  try {
    creds = await deriveFn.createApiKey();
  } catch (createError) {
    // Handle various error cases (wallet not activated, auth config issues, etc.)
  }
}
```

This ensures correct behavior even if someone calls the clob-client methods directly.

## References

- **Original Issue**: [Polymarket/clob-client#202](https://github.com/Polymarket/clob-client/issues/202)
- **Related Issue**: [Polymarket/clob-client#209](https://github.com/Polymarket/clob-client/issues/209)
- **Reference PR**: [IQAIcom/mcp-polymarket#37](https://github.com/IQAIcom/mcp-polymarket/pull/37)

## Verification

After applying the patch, the fixed method can be verified:

```bash
npm run postinstall  # Applies patches
npm run build       # Builds successfully
npm test            # Tests pass
```

## Notes

- The patch is automatically applied during `npm install` via the `postinstall` script
- The workaround is compatible with all signature types (EOA, Proxy, Gnosis Safe)
- This is a temporary fix until the upstream `@polymarket/clob-client` library is updated
