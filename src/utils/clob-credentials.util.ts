import type { ApiKeyCreds } from "@polymarket/clob-client";
import type { ClobCredsChecklist } from "../config/loadConfig";

const formatChecklistItem = (item: {
  present: boolean;
  source?: string;
}): string => {
  const emoji = item.present ? "✅" : "❌";
  const source = item.source ? ` (${item.source})` : "";
  return `${emoji}${source}`;
};

export const formatClobCredsChecklist = (
  checklist: ClobCredsChecklist,
): string => {
  const hasExplicitCreds =
    checklist.key.present &&
    checklist.secret.present &&
    checklist.passphrase.present;

  // When derive is enabled (default) and no explicit credentials, show a clearer message
  if (checklist.deriveEnabled && !hasExplicitCreds) {
    return `[CLOB] Credentials will be auto-derived from PRIVATE_KEY (default behavior)`;
  }

  // When explicit credentials are provided (with or without derive enabled)
  if (hasExplicitCreds) {
    const key = formatChecklistItem(checklist.key);
    const secret = formatChecklistItem(checklist.secret);
    const passphrase = formatChecklistItem(checklist.passphrase);
    return `[CLOB] Explicit credentials: key=${key} secret=${secret} passphrase=${passphrase}`;
  }

  // When no credentials and derive is disabled - this is an error state
  // Note: Since derive defaults to true, this only happens with explicit CLOB_DERIVE_CREDS=false
  const key = formatChecklistItem(checklist.key);
  const secret = formatChecklistItem(checklist.secret);
  const passphrase = formatChecklistItem(checklist.passphrase);
  return `[CLOB] Missing credentials: key=${key} secret=${secret} passphrase=${passphrase} derive=disabled (remove CLOB_DERIVE_CREDS=false to enable auto-derivation)`;
};

export const isApiKeyCreds = (creds?: {
  key?: string;
  secret?: string;
  passphrase?: string;
}): creds is ApiKeyCreds =>
  Boolean(creds?.key && creds?.secret && creds?.passphrase);

