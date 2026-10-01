import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The chapter cascade's `[]` vs `null` contract.
 *
 * `getVideoChapters` promises: null = unusable (API down, missing key),
 * `[]` = the video genuinely has no chapters. The pair is load-bearing
 * because `probeVideoChapters` turns `[]` into a 24-HOUR cached fact and
 * `null` into a 10-minute retry. A rung that was never usable must never
 * be allowed to answer "this video has no chapters".
 *
 * Fresh module state per test (`vi.resetModules()` + dynamic import) -
 * `pausedUntil` and the three cascade caches are module-level and would
 * otherwise leak between cases.
 */
describe('chapter cascade: unusable rung is never a chapter-less fact', () => {
  const SAVED_URL = process.env.HOME_RESOLVER_URL;
  const SAVED_TOKEN = process.env.HOME_RESOLVER_TOKEN;
  const SAVED_KEY = process.env.YOUTUBE_API_KEY;
  let mod: typeof import('../ytResolver');
  /**
   * A clock we can wind forward, because "retry sooner" is 10 minutes
   * (NEG_TTL_MS) and a test must not sit still for 10 of them. Only
   * `Date.now` is faked: fake timers would also stand in for the
   * `AbortSignal.timeout` on each fetch, and `fetch` is mocked anyway.
   */
  let clock = 0;
  const advance = (ms: number): void => {
    clock += ms;
  };

  /** Data API answers fine, with a description that carries no timestamps. */
  const descriptionWithoutTimestamps = async (): Promise<Response> =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ snippet: { description: 'Doors at 17:00. Stream starts soon.' } }] }),
    }) as Response;

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    process.env.YOUTUBE_API_KEY = 'test-key';
    clock = Date.parse('2026-09-29T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mod = await import('../ytResolver');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (SAVED_URL === undefined) delete process.env.HOME_RESOLVER_URL;
    else process.env.HOME_RESOLVER_URL = SAVED_URL;
    if (SAVED_TOKEN === undefined) delete process.env.HOME_RESOLVER_TOKEN;
    else process.env.HOME_RESOLVER_TOKEN = SAVED_TOKEN;
    if (SAVED_KEY === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = SAVED_KEY;
  });

  it('returns null, not [], when the home-resolver chapter probe is unreachable', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) return descriptionWithoutTimestamps();
      throw new Error('tower asleep');
    });

    await expect(mod.getVideoChapters('rug0down000')).resolves.toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/chapters'))).toBe(true);
  });

  it('does not cache the chapter-less fact after an unreachable probe, so a later play re-probes', async () => {
    let rugCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) return descriptionWithoutTimestamps();
      rugCalls += 1;
      throw new Error('tower asleep');
    });

    await expect(mod.getVideoChapters('rug0retry00')).resolves.toBeNull();
    expect(rugCalls).toBe(1);
    // Inside the 10-minute retry window the negative cache answers, which is
    // the designed cost of not knowing.
    await expect(mod.getVideoChapters('rug0retry00')).resolves.toBeNull();
    expect(rugCalls).toBe(1);

    // Past it, the rung is consulted again. A 24h chapter-less cache would
    // still be answering from memory here, with no fetch at all.
    advance(10 * 60_000 + 1_000);
    await expect(mod.getVideoChapters('rug0retry00')).resolves.toBeNull();
    expect(rugCalls).toBe(2);
  });

  it('recovers as soon as the resolver comes back', async () => {
    let rugUp = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) return descriptionWithoutTimestamps();
      if (!rugUp) throw new Error('tower asleep');
      return {
        ok: true,
        status: 200,
        json: async () => ({ chapters: [{ title: 'Setlist', startMs: 0 }] }),
      } as Response;
    });

    await expect(mod.getVideoChapters('rug0recov00')).resolves.toBeNull();
    rugUp = true;
    advance(10 * 60_000 + 1_000);
    await expect(mod.getVideoChapters('rug0recov00')).resolves.toEqual([{ title: 'Setlist', startMs: 0 }]);
  });

  it('returns null while the resolver is configured but paused (unreachable pause)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) return descriptionWithoutTimestamps();
      throw new Error('down');
    });
    // A failed audio resolve pauses the resolver for 2 minutes.
    await expect(mod.resolveViaHome('pause0id000')).resolves.toBeNull();
    expect(mod.resolverEnabled()).toBe(false);

    const before = spy.mock.calls.length;
    await expect(mod.getVideoChapters('rug0paused0')).resolves.toBeNull();
    // A paused resolver is not consulted at all, and a rung that never ran
    // is not a chapter-less fact either.
    expect(spy.mock.calls.length).toBe(before + 1);
  });

  it('still returns [] (and caches it) when the resolver answers with no chapters', async () => {
    let rugCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) return descriptionWithoutTimestamps();
      rugCalls += 1;
      return { ok: true, status: 200, json: async () => ({ chapters: [] }) } as Response;
    });

    await expect(mod.getVideoChapters('rug0empty00')).resolves.toEqual([]);
    expect(rugCalls).toBe(1);
    // Both rungs answered, so this one IS a fact and the 24h cache may hold it.
    await expect(mod.getVideoChapters('rug0empty00')).resolves.toEqual([]);
    expect(rugCalls).toBe(1);
  });

  it('still returns [] when no home resolver is configured at all (no second rung exists)', async () => {
    delete process.env.HOME_RESOLVER_URL;
    delete process.env.HOME_RESOLVER_TOKEN;
    let dataCalls = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      expect(String(input)).toContain('googleapis.com');
      dataCalls += 1;
      return descriptionWithoutTimestamps();
    });

    await expect(mod.getVideoChapters('noc0noreso0')).resolves.toEqual([]);
    expect(spy.mock.calls.length).toBe(1);
    await expect(mod.getVideoChapters('noc0noreso0')).resolves.toEqual([]);
    expect(dataCalls).toBe(1);
  });
});
