import { fetchWithTimeout } from './fetchWithTimeout';

/**
 * Mirrors the whole bot log to a private Discord channel so Railway logs
 * never need opening. The Logger pushes every ANSI-stripped line here;
 * lines are buffered and flushed as code-block messages on a timer.
 *
 * Discord webhooks rate-limit (~30 req/min), so: one flush every 15s,
 * max 3 messages per flush, per-line cap, overflow drops the oldest lines
 * with a `+N dropped` trailer. A failed POST is dropped silently —
 * Railway and the local log files remain the source of truth. Nothing
 * here ever throws into the logging path.
 *
 * Set LOG_WEBHOOK_URL to a dedicated webhook, or leave it unset to reuse
 * the ERROR_WEBHOOK_URL channel. Unset both = Discord stays silent.
 */

const FLUSH_MS = 15000;
const MAX_MESSAGE_CHARS = 1900;
const MAX_MESSAGES_PER_FLUSH = 3;
const MAX_LINE_CHARS = 500;
const MAX_BUFFERED_LINES = 120;

let buffer: string[] = [];
let dropped = 0;
let timer: NodeJS.Timeout | null = null;
let flushing = false;

const webhookUrl = (): string | null => {
  const dedicated = process.env.LOG_WEBHOOK_URL?.trim();
  if (dedicated) return dedicated;
  return process.env.ERROR_WEBHOOK_URL?.trim() || null;
};

const ensureTimer = (): void => {
  // No background timer in tests — tests drive flushLogShipper() directly.
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => void flushLogShipper(), FLUSH_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
};

/** Queue one pre-formatted log line. No-op when no webhook is configured. */
export const shipLogLine = (line: string): void => {
  if (!line) return;
  if (!webhookUrl()) return;
  const capped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
  buffer.push(capped);
  if (buffer.length > MAX_BUFFERED_LINES) {
    const overflow = buffer.length - MAX_BUFFERED_LINES;
    buffer.splice(0, overflow);
    dropped += overflow;
  }
  ensureTimer();
};

/** Pack buffered lines into code-block messages and POST them. */
export const flushLogShipper = async (): Promise<void> => {
  if (flushing) return;
  const url = webhookUrl();
  if (!url) {
    buffer = [];
    dropped = 0;
    return;
  }
  if (buffer.length === 0 && dropped === 0) return;
  flushing = true;
  try {
    const lines = buffer;
    buffer = [];
    const messages: string[] = [];
    let current = '';
    let overflowDropped = 0;
    for (const line of lines) {
      if (messages.length >= MAX_MESSAGES_PER_FLUSH) {
        overflowDropped += 1;
        continue;
      }
      const next = current ? `${current}\n${line}` : line;
      if (next.length > MAX_MESSAGE_CHARS && current) {
        messages.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) {
      if (messages.length < MAX_MESSAGES_PER_FLUSH) {
        messages.push(current);
      } else {
        overflowDropped += current.split('\n').length;
      }
    }
    const totalDropped = dropped + overflowDropped;
    dropped = 0;
    if (totalDropped > 0 && messages.length > 0) {
      messages[messages.length - 1] += `\n… +${totalDropped} lines dropped`;
    }
    for (const body of messages) {
      try {
        await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '```\n' + body + '\n```' }),
          },
          8000,
        );
      } catch {
        // Drop on failure — Railway stays the source of truth.
      }
    }
  } finally {
    flushing = false;
  }
};

/** Test hooks: reset buffer/counters/timer between tests. */
export const clearLogShipper = (): void => {
  buffer = [];
  dropped = 0;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
