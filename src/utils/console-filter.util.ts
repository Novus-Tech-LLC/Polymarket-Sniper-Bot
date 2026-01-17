import type { Logger } from "./logger.util";
import {
  formatAuthHeaderPresence,
  getAuthHeaderPresence,
} from "./clob-auth-headers.util";
import { redactSensitiveValues } from "./sanitize-axios-error.util";

type ConsoleError = typeof console.error;

type ClobErrorPayload = {
  status?: number;
  data?: { error?: string };
  config?: {
    params?: { token_id?: string };
    headers?: Record<string, unknown>;
  };
};

type ClobErrorLog = ClobErrorPayload & {
  config?: {
    params?: { token_id?: string };
    headers?: Record<string, unknown>;
  };
};

let installed = false;
let originalConsoleError: ConsoleError | undefined;
let summaryTimer: NodeJS.Timeout | undefined;
const suppressedTokens = new Set<string>();
const suppressedCounts = new Map<string, number>();

const isClobOrderbook404 = (args: unknown[]): ClobErrorPayload | undefined => {
  if (!args.length) return undefined;
  if (typeof args[0] !== "string") return undefined;
  if (!args[0].includes("[CLOB Client] request error")) return undefined;

  const payloadText = args[1];
  if (typeof payloadText !== "string") return undefined;

  try {
    const payload = JSON.parse(payloadText) as ClobErrorPayload;
    if (payload?.status !== 404) return undefined;
    if (!payload?.data?.error?.includes("No orderbook exists"))
      return undefined;
    return payload;
  } catch {
    return undefined;
  }
};

const parseSummaryIntervalMs = (): number | undefined => {
  const raw =
    process.env.CLOB_404_SUMMARY_INTERVAL_SEC ??
    process.env.clob_404_summary_interval_sec;
  if (!raw) return 5 * 60 * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
};

const formatSummary = (counts: Map<string, number>): string => {
  const items = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tokenId, count]) => `${tokenId} (${count})`);
  return items.length ? items.join(", ") : "none";
};

export const suppressClobOrderbookErrors = (logger?: Logger): void => {
  if (installed) return;
  installed = true;

  originalConsoleError = console.error.bind(console);
  const summaryIntervalMs = parseSummaryIntervalMs();
  if (logger && summaryIntervalMs) {
    summaryTimer = setInterval(() => {
      logger.warn(
        `[CLOB] Suppressed orderbook 404 summary: ${formatSummary(suppressedCounts)}`,
      );
    }, summaryIntervalMs);
  }

  console.error = (...args: unknown[]): void => {
    const payload = isClobOrderbook404(args);
    if (payload) {
      const tokenId = payload.config?.params?.token_id;
      if (tokenId) {
        suppressedCounts.set(tokenId, (suppressedCounts.get(tokenId) ?? 0) + 1);
      }
      if (logger && tokenId && !suppressedTokens.has(tokenId)) {
        suppressedTokens.add(tokenId);
        logger.warn(
          `[CLOB] Suppressing repeated orderbook 404s for token ${tokenId}. Remove from watchlist if resolved.`,
        );
      }
      return;
    }

    if (
      typeof args[0] === "string" &&
      args[0].includes("[CLOB Client] request error")
    ) {
      const sanitizedArgs = [...args];
      if (typeof sanitizedArgs[1] === "string") {
        try {
          const payload = JSON.parse(sanitizedArgs[1]) as ClobErrorLog;
          const headers = payload?.config?.headers;
          if (headers && typeof headers === "object") {
            const presence = getAuthHeaderPresence(
              headers as Record<string, string>,
            );
            payload.config = {
              ...payload.config,
              headers: {
                authHeaderPresence: presence,
              },
            };
            if (logger) {
              logger.warn(
                `[CLOB] Auth header presence: ${formatAuthHeaderPresence(presence)}`,
              );
              if (payload.status === 401 && !presence.secretHeaderPresent) {
                logger.warn("[CLOB] secret missing from request");
              }
            }
          }
          sanitizedArgs[1] = redactSensitiveValues(JSON.stringify(payload));
        } catch {
          sanitizedArgs[1] = redactSensitiveValues(String(sanitizedArgs[1]));
        }
      }
      originalConsoleError?.(...(sanitizedArgs as Parameters<ConsoleError>));
      return;
    }

    originalConsoleError?.(...(args as Parameters<ConsoleError>));
  };
};

export const restoreConsoleError = (): void => {
  if (!installed || !originalConsoleError) return;
  console.error = originalConsoleError;
  originalConsoleError = undefined;
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = undefined;
  }
  installed = false;
  suppressedTokens.clear();
  suppressedCounts.clear();
};
