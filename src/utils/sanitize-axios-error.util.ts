import axios from 'axios';

const SENSITIVE_KEYS = [
  'POLY_API_KEY',
  'POLY_SECRET',
  'POLY_PASSPHRASE',
  'POLY_SIGNATURE',
  'POLYMARKET_API_KEY',
  'POLYMARKET_API_SECRET',
  'POLYMARKET_API_PASSPHRASE',
  'CLOB_API_KEY',
  'CLOB_API_SECRET',
  'CLOB_API_PASSPHRASE',
  'X-API-KEY',
  'Authorization',
  'Cookie',
];

export function redactSensitiveValues(value: string): string {
  let redacted = value;
  for (const key of SENSITIVE_KEYS) {
    const keyRegex = new RegExp(`(${key})\\s*[:=]\\s*([\"']?)[^\\s\"',;]+\\2`, 'gi');
    redacted = redacted.replace(keyRegex, '$1=<redacted>');
    const jsonRegex = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, 'gi');
    redacted = redacted.replace(jsonRegex, '$1"<redacted>"');
  }
  redacted = redacted.replace(/headers\\s*[:=]\\s*\\{[^}]*\\}/gi, (match) => {
    return match.includes('authHeaderPresence') ? match : 'headers=<redacted>';
  });
  redacted = redacted.replace(/"headers"\\s*:\\s*\\{[^}]*\\}/gi, (match) => {
    return match.includes('authHeaderPresence') ? match : '"headers":"<redacted>"';
  });
  return redacted;
}

export function sanitizeAxiosError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const method = error.config?.method?.toUpperCase();
    const url = error.config?.url;
    const details = [method, url].filter(Boolean).join(' ');
    const statusLabel = status ? ` (status ${status})` : '';
    const message = [error.message, statusLabel, details].filter(Boolean).join(' ').trim();
    return new Error(redactSensitiveValues(message));
  }

  if (error instanceof Error) {
    return new Error(redactSensitiveValues(error.message));
  }

  return new Error(redactSensitiveValues(String(error)));
}

export function sanitizeErrorMessage(error: unknown): string {
  return sanitizeAxiosError(error).message;
}
