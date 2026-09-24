import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shipLogLine, flushLogShipper, clearLogShipper } from './logShipper';

const SAVED_ENV = { ...process.env };

describe('logShipper (discord log mirror)', () => {
  beforeEach(() => {
    clearLogShipper();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.LOG_WEBHOOK_URL = SAVED_ENV.LOG_WEBHOOK_URL;
    process.env.ERROR_WEBHOOK_URL = SAVED_ENV.ERROR_WEBHOOK_URL;
    clearLogShipper();
    vi.restoreAllMocks();
  });

  it('stays silent without any webhook configured', async () => {
    delete process.env.LOG_WEBHOOK_URL;
    delete process.env.ERROR_WEBHOOK_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    shipLogLine('[11:00:00] INFO test');
    await flushLogShipper();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('batches lines into code-block messages', async () => {
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/logs';
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      return { ok: true } as Response;
    });
    shipLogLine('[11:00:00] INFO first');
    shipLogLine('[11:00:01] INFO second');
    await flushLogShipper();
    expect(bodies).toHaveLength(1);
    const content = (bodies[0] as { content: string }).content;
    expect(content).toContain('first');
    expect(content).toContain('second');
    expect(content.startsWith('```')).toBe(true);
  });

  it('prefers the dedicated log webhook over the error channel', async () => {
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/logs';
    process.env.ERROR_WEBHOOK_URL = 'https://discord.com/api/webhooks/errors';
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      seen.push(String(url));
      return { ok: true } as Response;
    });
    shipLogLine('hello');
    await flushLogShipper();
    expect(seen).toEqual(['https://discord.com/api/webhooks/logs']);
  });

  it('falls back to the error channel when no log webhook is set', async () => {
    delete process.env.LOG_WEBHOOK_URL;
    process.env.ERROR_WEBHOOK_URL = 'https://discord.com/api/webhooks/errors';
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      seen.push(String(url));
      return { ok: true } as Response;
    });
    shipLogLine('hello');
    await flushLogShipper();
    expect(seen).toEqual(['https://discord.com/api/webhooks/errors']);
  });

  it('caps messages per flush and reports dropped lines', async () => {
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/logs';
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as { body: string }).body));
      return { ok: true } as Response;
    });
    // 130 lines x ~60 chars: exceeds the 120-line buffer and the 3-msg cap.
    for (let i = 0; i < 130; i++) {
      shipLogLine(`[11:00:00] INFO line-${String(i).padStart(3, '0')}-` + 'x'.repeat(40));
    }
    await flushLogShipper();
    expect(bodies.length).toBeLessThanOrEqual(3);
    const last = (bodies[bodies.length - 1] as { content: string }).content;
    expect(last).toContain('lines dropped');
  });

  it('never throws when the webhook POST fails', async () => {
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/logs';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net down'));
    shipLogLine('hello');
    await expect(flushLogShipper()).resolves.toBeUndefined();
  });
});
