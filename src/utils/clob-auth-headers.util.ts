export type AuthHeaderPresence = {
  apiKeyHeaderPresent: boolean;
  passphraseHeaderPresent: boolean;
  secretHeaderPresent: boolean;
  signatureHeaderPresent: boolean;
};

const normalizeHeaderKeys = (headers: Record<string, unknown>): Set<string> => {
  return new Set(Object.keys(headers).map((key) => key.toLowerCase()));
};

const hasHeader = (keys: Set<string>, candidates: string[]): boolean => {
  return candidates.some((candidate) => keys.has(candidate.toLowerCase()));
};

export const getAuthHeaderPresence = (
  headers?: Record<string, string | string[] | number | boolean | undefined>,
): AuthHeaderPresence => {
  if (!headers) {
    return {
      apiKeyHeaderPresent: false,
      passphraseHeaderPresent: false,
      secretHeaderPresent: false,
      signatureHeaderPresent: false,
    };
  }

  const keys = normalizeHeaderKeys(headers as Record<string, unknown>);

  return {
    apiKeyHeaderPresent: hasHeader(keys, ['POLY_API_KEY', 'X-API-KEY']),
    passphraseHeaderPresent: hasHeader(keys, ['POLY_PASSPHRASE']),
    secretHeaderPresent: hasHeader(keys, ['POLY_SECRET', 'AUTHORIZATION']),
    signatureHeaderPresent: hasHeader(keys, ['POLY_SIGNATURE']),
  };
};

export const formatAuthHeaderPresence = (presence: AuthHeaderPresence): string => {
  return `apiKeyHeaderPresent=${presence.apiKeyHeaderPresent} `
    + `passphraseHeaderPresent=${presence.passphraseHeaderPresent} `
    + `secretHeaderPresent=${presence.secretHeaderPresent} `
    + `signatureHeaderPresent=${presence.signatureHeaderPresent}`;
};
