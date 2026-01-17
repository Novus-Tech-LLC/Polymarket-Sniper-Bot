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
  const key = formatChecklistItem(checklist.key);
  const secret = formatChecklistItem(checklist.secret);
  const passphrase = formatChecklistItem(checklist.passphrase);
  const derive = checklist.deriveEnabled ? "enabled" : "disabled";
  return `[CLOB] Creds checklist: key=${key} secret=${secret} passphrase=${passphrase} derive=${derive}`;
};

export const isApiKeyCreds = (creds?: {
  key?: string;
  secret?: string;
  passphrase?: string;
}): creds is ApiKeyCreds =>
  Boolean(creds?.key && creds?.secret && creds?.passphrase);
