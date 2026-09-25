import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPipedChapters, __resetPipedChaptersForTests } from './pipedChapters';

const SAVED_INSTANCES = process.env.PIPED_INSTANCES;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

const restoreInstances = () => {
  if (SAVED_INSTANCES === undefined) delete process.env.PIPED_INSTANCES;
  else process.env.PIPED_INSTANCES = SAVED_INSTANCES;
};

describe('pipedChapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetPipedChaptersForTests();
    delete process.env.PIPED_INSTANCES;
  });

  afterEach(restoreInstances);

  it('maps seconds to ms, sorts, and drops bad entries', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        ok({
          chapters: [
            { title: 'Late', start: 200 },
            { title: 'First', start: 0 },
            { title: '', start: 10 },
            { start: 30 },
            { title: 'NaN', start: Number.NaN },
            { title: 'Negative', start: -5 },
            { title: 'Middle', start: 100 },
          ],
        }),
      );
    await expect(fetchPipedChapters('sec0ndsMap0')).resolves.toEqual([
      { title: 'First', startMs: 0 },
      { title: 'Middle', startMs: 100_000 },
      { title: 'Late', startMs: 200_000 },
    ]);
    expect(String(spy.mock.calls[0]![0])).toContain('/streams/sec0ndsMap0');
  });

  it('serves the second call from cache with a single fetch', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ chapters: [{ title: 'One', start: 5 }] }));
    await fetchPipedChapters('cache0Hit00');
    await expect(fetchPipedChapters('cache0Hit00')).resolves.toEqual([{ title: 'One', startMs: 5_000 }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails over to the next instance when one rejects', async () => {
    process.env.PIPED_INSTANCES = 'https://piped-a.test,https://piped-b.test';
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      if (String(input).startsWith('https://piped-a.test')) throw new Error('instance down');
      return ok({ chapters: [{ title: 'B', start: 3 }] });
    }) as any);
    await expect(fetchPipedChapters('failover000')).resolves.toEqual([{ title: 'B', startMs: 3_000 }]);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://piped-a.test/streams/failover000',
      'https://piped-b.test/streams/failover000',
    ]);
  });

  it('treats a Piped error body as instance failure and fails over', async () => {
    process.env.PIPED_INSTANCES = 'https://piped-e.test,https://piped-f.test';
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      if (String(input).startsWith('https://piped-e.test')) {
        return ok({ error: 'TooManyRequests', message: 'LOGIN_REQUIRED' });
      }
      return ok({ chapters: [{ title: 'F', start: 12 }] });
    }) as any);
    await expect(fetchPipedChapters('err0rbody00')).resolves.toEqual([{ title: 'F', startMs: 12_000 }]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('negative-caches for 10 minutes when every instance fails', async () => {
    process.env.PIPED_INSTANCES = 'https://piped-x.test';
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(fetchPipedChapters('all0fail000')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(fetchPipedChapters('all0fail000')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid video ids without any fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchPipedChapters('short')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns [] for videos with no chapters (and caches the empty list)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ chapters: [] }));
    await expect(fetchPipedChapters('empty0list0')).resolves.toEqual([]);
    await expect(fetchPipedChapters('empty0list0')).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
