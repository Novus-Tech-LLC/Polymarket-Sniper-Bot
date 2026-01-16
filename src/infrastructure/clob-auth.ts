import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';

let cachedCreds: ApiKeyCreds | null = null;
let loggedDerivation = false;

export async function initializeApiCreds(client: ClobClient, providedCreds?: ApiKeyCreds): Promise<ApiKeyCreds> {
  if (providedCreds) {
    client.setApiCreds(providedCreds);
    cachedCreds = providedCreds;
    return providedCreds;
  }

  if (cachedCreds) {
    client.setApiCreds(cachedCreds);
    return cachedCreds;
  }

  const derivedCreds = await client.createOrDeriveApiCreds();
  client.setApiCreds(derivedCreds);
  cachedCreds = derivedCreds;

  if (!loggedDerivation) {
    console.log('[CLOB] API credentials derived via wallet signature');
    loggedDerivation = true;
  }

  return derivedCreds;
}

export async function refreshApiCreds(client: ClobClient): Promise<ApiKeyCreds> {
  const derivedCreds = await client.createOrDeriveApiCreds();
  client.setApiCreds(derivedCreds);
  cachedCreds = derivedCreds;
  return derivedCreds;
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
  loggedDerivation = false;
}

function isAuthError(error: unknown): boolean {
  const maybeError = error as { response?: { status?: number }; status?: number; message?: string };
  const status = maybeError?.status ?? maybeError?.response?.status;
  if (status === 401 || status === 403) {
    return true;
  }

  const message = maybeError?.message?.toLowerCase() ?? '';
  return message.includes('api credentials') || message.includes('unauthorized') || message.includes('forbidden');
}
