import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';

let cachedCreds: ApiKeyCreds | null = null;

export async function initializeApiCreds(client: ClobClient, providedCreds?: ApiKeyCreds): Promise<ApiKeyCreds> {
  if (providedCreds) {
    applyClientCreds(client, providedCreds);
    cachedCreds = providedCreds;
    return providedCreds;
  }

  if (cachedCreds) {
    applyClientCreds(client, cachedCreds);
    return cachedCreds;
  }

  throw new Error('[CLOB] Missing API credentials. Provide POLYMARKET_API_KEY/POLY_API_KEY/CLOB_API_KEY, POLYMARKET_API_SECRET/POLY_SECRET/CLOB_API_SECRET, and POLYMARKET_API_PASSPHRASE/POLY_PASSPHRASE/CLOB_API_PASSPHRASE.');
}

export async function refreshApiCreds(client: ClobClient): Promise<ApiKeyCreds> {
  if (!cachedCreds) {
    throw new Error('[CLOB] Missing API credentials. Provide POLYMARKET_API_KEY/POLY_API_KEY/CLOB_API_KEY, POLYMARKET_API_SECRET/POLY_SECRET/CLOB_API_SECRET, and POLYMARKET_API_PASSPHRASE/POLY_PASSPHRASE/CLOB_API_PASSPHRASE.');
  }
  applyClientCreds(client, cachedCreds);
  return cachedCreds;
}

export async function verifyApiCreds(client: ClobClient): Promise<boolean> {
  try {
    await client.getApiKeys();
    return true;
  } catch (error) {
    if (isAuthError(error)) {
      return false;
    }
    throw error;
  }
}

export async function withAuthRetry<T>(client: ClobClient, operation: () => Promise<T>): Promise<T> {
  await initializeApiCreds(client);
  try {
    return await operation();
  } catch (error) {
    if (!isAuthError(error)) {
      throw error;
    }
    await refreshApiCreds(client);
    return operation();
  }
}

export function resetApiCredsCache(): void {
  cachedCreds = null;
}

function isAuthError(error: unknown): boolean {
  const maybeError = error as { response?: { status?: number }; status?: number; message?: string };
  const status = maybeError?.status ?? maybeError?.response?.status;
  if (status === 401) {
    return true;
  }
  if (status === 403) {
    return false;
  }

  const message = maybeError?.message?.toLowerCase() ?? '';
  return message.includes('api credentials') || message.includes('unauthorized') || message.includes('forbidden');
}

function applyClientCreds(client: ClobClient, creds: ApiKeyCreds): void {
  (client as ClobClient & { creds?: ApiKeyCreds }).creds = creds;
}
