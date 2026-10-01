import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastfmApiError } from '@domain/models/lastfmError';

import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
/**
 * The error contract at the Last.fm boundary.
 *
 * WHY HERE RATHER THAN IN THE REPOSITORY. The external review asked for
 * "error 6/8/29 mapping" tests in lastFmRepository. Grepping first: the bot
 * never branches on those codes anywhere. `LastfmApiError.code` is set by this
 * layer and read only by `LastfmErrorRateTracker`, which counts them. So the
 * thing worth holding is that the code survives the trip intact - not that a
 * particular number triggers a particular message, because that behaviour does
 * not exist yet.
 *
 * That is the honest framing. If someone later branches on code 6 to say
 * "that username does not exist", the tests here are the seam they extend, and
 * the mapping below is the contract they can rely on.
 *
 * The three ways a request fails, and why they must stay distinguishable:
 *   - a JSON error body  -> code is Last.fm's own (6, 8, 29, ...)
 *   - a non-2xx HTTP     -> code is the status
 *   - network / timeout  -> code is -1
 * Collapsing any two of these makes the rate tracker miscount, and -1 vs 6 is
 * the difference between "Last.fm is down" and "this username is wrong".
 */

interface FetchCall { url: string }

const makeFetch = (
  handler: (url: string, attempt: number) => { status?: number; json?: unknown; throws?: Error },
) => {
  const calls: FetchCall[] = [];
  let attempt = 0;
  const spy = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push({ url });
    const spec = handler(url, attempt++);
    if (spec.throws) throw spec.throws;
    return {
      ok: spec.status === undefined || (spec.status >= 200 && spec.status < 300),
      status: spec.status ?? 200,
      json: async () => spec.json ?? {},
      // `lastfmApi` reads the body with `response.text()`, before it judges the
      // status, because a JSON body carries Last.fm's real error code. A double
      // offering only `json` cannot express a body on a non-2xx response, which
      // is how the 404-means-user-not-found defect stayed invisible here.
      text: async () => JSON.stringify(spec.json ?? {}),
    };
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
};

describe('LastfmApi error contract', () => {
  let api: LastfmApi;

  beforeEach(() => {
    vi.useFakeTimers();
    api = new LastfmApi(new LastfmErrorRateTracker());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs a call, letting the retry backoff settle, and returns the rejection. */
  const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
    const p = run().catch((e: unknown) => e);
    // The retry path awaits real backoff sleeps; advance past them.
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(20_000);
    return p;
  };

  it('preserves Last.fm\'s own error code from a JSON error body', async () => {
    // 6 = user does not exist, 8 = operation failed, 29 = invalid session key.
    for (const code of [6, 8, 29]) {
      makeFetch(() => ({ status: 200, json: { error: code, message: `Last.fm error ${code}` } }));
      const err = await captureError(() => api.call('user.getInfo', { user: 'nobody' }));
      expect(err).toBeInstanceOf(LastfmApiError);
      expect((err as LastfmApiError).code).toBe(code);
    }
  });

  it('keeps the message Last.fm sent, not a generic one', async () => {
    makeFetch(() => ({ status: 200, json: { error: 6, message: 'User not found' } }));
    const err = (await captureError(() => api.call('user.getInfo', { user: 'x' }))) as LastfmApiError;
    expect(err.message).toBe('User not found');
  });

  it('falls back to a readable message when the body omits one', async () => {
    // Not an empty string: an empty message reaches the user as a blank embed.
    makeFetch(() => ({ status: 200, json: { error: 6 } }));
    const err = (await captureError(() => api.call('user.getInfo', { user: 'x' }))) as LastfmApiError;
    expect(err.message).toBe('Unknown Last.fm error');
  });

  it('maps a non-2xx HTTP response to the status as the code', async () => {
    // 500 is transient so it is retried; after MAX_RETRIES it surfaces as the
    // status, which is what the rate tracker sees.
    makeFetch(() => ({ status: 500, json: {} }));
    const err = (await captureError(() => api.call('user.getInfo', { user: 'x' }))) as LastfmApiError;
    expect(err).toBeInstanceOf(LastfmApiError);
    expect(err.code).toBe(500);
  });

  it('maps a network failure to -1, distinct from any Last.fm code', async () => {
    // -1 is the only value that cannot collide with a real Last.fm error, which
    // is why it exists. Collapsing this into 0 or -2 would make an outage
    // indistinguishable from an application error in the tracker.
    makeFetch(() => ({ throws: new Error('ECONNREFUSED') }));
    const err = (await captureError(() => api.call('user.getInfo', { user: 'x' }))) as LastfmApiError;
    expect(err).toBeInstanceOf(LastfmApiError);
    expect(err.code).toBe(-1);
    expect(err.message).toMatch(/network error or timeout/i);
  });

  it('retries a transient 5xx and succeeds when the retry works', async () => {
    // Proves the error path and the success path share one code path, so the
    // happy case is not accidentally exempt from the retry logic.
    const { calls } = makeFetch((_u, attempt) =>
      attempt < 2 ? { status: 503, json: {} } : { status: 200, json: { user: { name: 'ok' } } },
    );

    const p = api.call<{ user: { name: string } }>('user.getInfo', { user: 'ok' });
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(20_000);
    const result = await p;

    expect(result.user.name).toBe('ok');
    expect(calls.length).toBe(3);
  });

  it('does NOT retry a JSON error body, only transient statuses', async () => {
    // A JSON error is an ANSWER, not a transient fault. Retrying error 6
    // (user does not exist) three times is pure load on Last.fm and delays the
    // user-facing failure by seconds for nothing.
    const { calls } = makeFetch(() => ({ status: 200, json: { error: 6, message: 'User not found' } }));

    const err = await captureError(() => api.call('user.getInfo', { user: 'nobody' }));
    expect(err).toBeInstanceOf(LastfmApiError);
    expect(calls.length).toBe(1);
  });

  it('does not retry a non-transient 4xx', async () => {
    // 404 is not in the transient set, so it must surface immediately.
    const { calls } = makeFetch(() => ({ status: 404, json: {} }));

    const err = (await captureError(() => api.call('user.getInfo', { user: 'x' }))) as LastfmApiError;
    expect(err.code).toBe(404);
    expect(calls.length).toBe(1);
  });

  it('retries a 429, because a rate limit is transient by definition', async () => {
    // The one omission the mutation pass found in this file: removing 429 from
    // the transient set left every test here green.
    //
    // It matters because failing fast on a rate limit is exactly backwards. A
    // 429 means Last.fm is asking us to slow down, so the answer is to wait -
    // surfacing it as an error puts a transient condition in front of users as
    // a failure, and hammering through MAX_RETRIES in seconds is what earns the
    // next 429.
    const { calls } = makeFetch((_u, attempt) =>
      attempt < 1 ? { status: 429, json: {} } : { status: 200, json: { user: { name: 'slow' } } },
    );

    const p = api.call<{ user: { name: string } }>('user.getInfo', { user: 'slow' });
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(20_000);
    const result = await p;

    expect(result.user.name).toBe('slow');
    expect(calls.length).toBe(2);
  });

  it('surfaces a 429 as code 429 once the retries are exhausted', async () => {
    // So the rate tracker can distinguish "we were throttled" from a 5xx.
    const { calls } = makeFetch(() => ({ status: 429, json: {} }));

    const err = (await captureError(() => api.call('user.getInfo', { user: 'x' }))) as LastfmApiError;
    expect(err.code).toBe(429);
    expect(calls.length).toBeGreaterThan(1);
  });
});