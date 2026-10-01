import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportFatalToDiscord, clearErrorFeedThrottle } from './errorFeed';

const SAVED_ENV = { ...process.env };

describe('errorFeed (free fatal alerts)', () => {
  beforeEach(() => {
    clearErrorFeedThrottle();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.ERROR_WEBHOOK_URL = SAVED_ENV.ERROR_WEBHOOK_URL;
  });

  it('stays silent without a webhook configured', () => {
    delete process.env.ERROR_WEBHOOK_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    reportFatalToDiscord('unhandledRejection', new Error('boom'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts fatals and throttles repeats of the same crash', async () => {
    process.env.ERROR_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      return { ok: true } as Response;
    });

    reportFatalToDiscord('uncaughtException', new Error('boom'));
    reportFatalToDiscord('uncaughtException', new Error('boom'));
    reportFatalToDiscord('uncaughtException', new Error('different'));
    await new Promise((r) => setTimeout(r, 10));

    expect(bodies).toHaveLength(2);
    const first = bodies[0] as { content: string };
    expect(first.content).toContain('uncaughtException');
    expect(first.content).toContain('boom');
  });

  it('scrubs a credential out of the post, because this copy leaves the machine', () => {
    // stdout and the log file are two copies of the same line inside the same
    // box. A webhook post is a THIRD copy, in a channel, which is the one place
    // a leaked key is read by a human rather than a log aggregator. A Last.fm 401
    // arrives as `... 2.0/?method=user.getInfo&api_key=...`, so a crash CAUSED by
    // an auth failure is exactly the case that would carry the credential out.
    // The fake is shaped like a real query parameter and is not a real key.
    process.env.ERROR_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      return { ok: true } as Response;
    });

    reportFatalToDiscord('uncaughtException', new Error('GET /2.0/?method=user.getInfo&api_key=5b4a39281706f5e4d3c2b1a09ff8e7d6c5'));
    const first = bodies[0] as { content: string };

    expect(first.content).not.toContain('5b4a39281706f5e4d3c2b1a09ff8e7d6c5');
    expect(first.content).toContain('[REDACTED]');
    // What makes the post useful survives: the vendor, the method, the source.
    expect(first.content).toContain('user.getInfo');
    expect(first.content).toContain('uncaughtException');
  });
});
