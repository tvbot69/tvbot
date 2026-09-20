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
});
