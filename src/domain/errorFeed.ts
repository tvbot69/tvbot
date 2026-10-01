import { fetchWithTimeout } from './fetchWithTimeout';
import { errorWebhookUrl as configuredErrorWebhookUrl } from '@config/runtimeEnv';
import { redactSecrets } from './logger';

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
 *
 * IS THIS A PATH THAT CAN SWALPHOW A DIAGNOSIS? It is the one place where the
 * answer is subtle, so here it is in full. Two channels report a fatal:
 *
 *   1. `Logger.fatal` in `bot/index.ts`, which runs on the line BEFORE this is
 *      called and writes to stdout. That line cannot be lost by anything in
 *      this file - see the ordering comment in `logger.writeLogToFile`.
 *   2. This webhook post, which is a SECOND, redundant copy to a phone.
 *
 * So a failure here never removes the diagnostic; it removes the copy that
 * reaches someone who is not watching Railway. `.catch(() => undefined)` is
 * therefore the right shape, and it is also mandatory: this runs inside
 * `uncaughtException`, where a throw would replace a reported crash with an
 * unreported one.
 */
export const reportFatalToDiscord = (source: string, err: unknown): void => {
  // Read inside the function, never at module scope: this is called from
  // uncaughtException/uncaughtRejection handlers, where a throw would replace a
  // reported crash with an unreported one. An absent URL is a no-op.
  const url = configuredErrorWebhookUrl();
  if (!url) return;

  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  const signature = signatureOf(source, message);
  const now = Date.now();
  if ((lastSentBySignature.get(signature) ?? 0) + THROTTLE_MS > now) return;
  lastSentBySignature.set(signature, now);

  // Redacted for the same reason as the stdout line, and it is a DIFFERENT reason:
  // this one leaves the machine. A Last.fm 401 arrives as
  // `... 2.0/?method=user.getInfo&api_key=...`, and the stack of the fetch that
  // made the call carries the same URL, so a crash caused by an auth failure would
  // post the credential to a channel instead of to a log file.
  const stack = redactSecrets(err instanceof Error && err.stack ? err.stack : String(err));
  const content =
    `🚨 **tvbot fatal** \`${source}\` — ${new Date(now).toISOString()}\n` +
    '```\n' +
    `${message}\n${stack}`.slice(0, MAX_CONTENT_CHARS) +
    '\n```';

  // CORRECT AS IS: the post is fire-and-forget by design (it must not be
  // awaited on the crash path, where a slow webhook would hold the process
  // open), and the failure is unrecoverable in the sense that matters - the
  // stdout line from `Logger.fatal` already carries the same message, stack and
  // source. Re-throwing here would be caught by nothing: this is the bottom of
  // the `uncaughtException` handler.
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
