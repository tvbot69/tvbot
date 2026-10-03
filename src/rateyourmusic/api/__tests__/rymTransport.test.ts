import { afterEach, describe, expect, it, vi } from 'vitest';
import { RymOriginBlockError, RymTransport } from '../rymTransport';
import { getRelease } from '../rymClient';

const SOLVER_BASE = 'http://localhost:8191';
const SOLVER_URL = `${SOLVER_BASE}/v1`;

const solverOk = (html: string, status = 200) => ({
  status: 'ok',
  solution: { url: 'https://rateyourmusic.com/x', status, response: html, userAgent: 'UA' },
});

const createBody = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

describe('RymTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a session once and reuses it across requests', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = createBody(init);
      bodies.push(body);
      if (body.cmd === 'sessions.create') {
        return new Response(JSON.stringify({ status: 'ok', solution: { session: 's1' } }));
      }
      return new Response(JSON.stringify(solverOk('<html>ok</html>')));
    });

    const transport = new RymTransport({ solverUrl: SOLVER_BASE, minDelayMs: 0 });
    const page = await transport.getHtml('/artist/radiohead');
    expect(page.html).toBe('<html>ok</html>');
    await transport.getHtml('/artist/a');
    expect(bodies.filter((b) => b.cmd === 'sessions.create')).toHaveLength(1);
    expect(bodies.filter((b) => b.cmd === 'sessions.request')).toHaveLength(2);
  });

  it('flags a 503 origin block with RymOriginBlockError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = createBody(init);
      if (body.cmd === 'sessions.create') {
        return new Response(JSON.stringify({ status: 'ok', solution: { session: 's1' } }));
      }
      return new Response(
        JSON.stringify(solverOk('<html>HTTP ERROR 503\nThe server is currently unable to handle this request</html>', 503)),
      );
    });

    const transport = new RymTransport({ solverUrl: SOLVER_BASE, minDelayMs: 0 });
    await expect(transport.getHtml('/release/album/a/b/')).rejects.toThrow(RymOriginBlockError);
  });

  it('retries a solver failure then succeeds', async () => {
    let creates = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = createBody(init);
      if (body.cmd === 'sessions.create') {
        creates += 1;
        if (creates === 1) {
          return new Response(JSON.stringify({ status: 'error', message: 'boom' }));
        }
        return new Response(JSON.stringify({ status: 'ok', solution: { session: 's1' } }));
      }
      return new Response(JSON.stringify(solverOk('<html>ok</html>')));
    });

    const transport = new RymTransport({ solverUrl: SOLVER_BASE, minDelayMs: 0, maxRetries: 3 });
    await expect(transport.getHtml('/x')).resolves.toMatchObject({ html: '<html>ok</html>' });
  });

  it('drops the cached session and recreates it when a request fails', async () => {
    const sessionsCreated: string[] = [];
    let requestCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = createBody(init);
      if (body.cmd === 'sessions.create') {
        sessionsCreated.push(String(body.cmd));
        return new Response(JSON.stringify({ status: 'ok', solution: { session: `s${sessionsCreated.length}` } }));
      }
      requestCalls += 1;
      if (requestCalls === 1) {
        return new Response(JSON.stringify({ status: 'error', message: 'session died' }));
      }
      return new Response(JSON.stringify(solverOk('<html>ok</html>')));
    });

    const transport = new RymTransport({ solverUrl: SOLVER_BASE, minDelayMs: 0 });
    await expect(transport.getHtml('/x')).resolves.toMatchObject({ html: '<html>ok</html>' });
    expect(sessionsCreated).toHaveLength(2);
  });

  it('getRelease falls back to Wayback when the origin block persists', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url === SOLVER_URL) {
        const body = createBody(init);
        if (body.cmd === 'sessions.create') {
          return new Response(JSON.stringify({ status: 'ok', solution: { session: 's1' } }));
        }
        return new Response(
          JSON.stringify(solverOk('<html>HTTP ERROR 503\nThe server is currently unable to handle this request</html>', 503)),
        );
      }
      if (url.startsWith('https://archive.org/wayback/available')) {
        return new Response(
          JSON.stringify({ archived_snapshots: { closest: { available: true, url: 'https://web.archive.org/web/2023/x' } } }),
        );
      }
      if (url.startsWith('https://web.archive.org/')) {
        return new Response('<html><title>ok</title></html>');
      }
      return new Response('<html></html>', { status: 200 });
    });

    const transport = new RymTransport({ solverUrl: SOLVER_BASE, minDelayMs: 0 });
    await getRelease(transport, 'pixies/surfer-rosa');
    expect(seen.some((u) => u.startsWith('https://archive.org/wayback/available'))).toBe(true);
    expect(seen.some((u) => u.startsWith('https://web.archive.org/'))).toBe(true);
  });
});
