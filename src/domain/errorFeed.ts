import { fetchWithTimeout } from './fetchWithTimeout';

// Minimum gap between two feed posts with the same signature (spam guard).
const THROTTLE_MS = 5 * 60 * 1000;
const MAX_CONTENT_CHARS = 1900;

const lastSentBySignature = new Map<string, number>();

const signatureOf = (source: string, message: string): string =>
  `${source}|${message.slice(0, 160)}`;

/**
 * Forwards fatal process errors to a private Discord channel webhook.
 * Free forever, no accounts: create a webhook in a private channel and set
 * ERROR_WEBHOOK_URL. No-op when unconfigured. Throttled per signature so a
 * crash loop posts once per 5 minutes instead of flooding the channel.
 */
export const reportFatalToDiscord = (source: string, err: unknown): void => {
  const url = process.env.ERROR_WEBHOOK_URL?.trim();
  if (!url) return;

  const message = err instanceof Error ? err.message : String(err);
  const signature = signatureOf(source, message);
  const now = Date.now();
  if ((lastSentBySignature.get(signature) ?? 0) + THROTTLE_MS > now) return;
  lastSentBySignature.set(signature, now);

  const stack = err instanceof Error && err.stack ? err.stack : String(err);
  const content =
    `🚨 **tvbot fatal** \`${source}\` — ${new Date(now).toISOString()}\n` +
    '```\n' +
    `${message}\n${stack}`.slice(0, MAX_CONTENT_CHARS) +
    '\n```';

  void fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
    8000,
  ).catch(() => undefined);
};

/** Test hook: resets the throttle map. */
export const clearErrorFeedThrottle = (): void => {
  lastSentBySignature.clear();
};
