import 'reflect-metadata';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastfmApiError } from '@domain/models/errors/lastfmError';
import { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import { TimePeriod } from '@domain/enums/timePeriod';

/**
 * The shape of the WIRE, not the shape of a convenient double.
 *
 * `lastfmApi` used to judge `response.ok` before it read the body, so a
 * "no such user" answer arrived as `LastfmApiError(404)`. `NOT_FOUND_CODES` in
 * `lastFmRepository` is `{6,7,8}`, so the real code was never seen, every
 * unlinked or mistyped username raised `LastFmUnavailableError`, and the user
 * was told Last.fm was unreachable when Last.fm had answered correctly.
 *
 * 4084 mocked tests passed through that. The reason is visible in the doubles
 * they used: each one returned `{ ok, status, json }` and NO `text`. Judging the
 * status first therefore never even attempted a body read, and every fixture
 * that happened to be non-2xx was asserting the bug. A double that only
 * supports what the buggy code path touches cannot catch a wire-shape bug.
 *
 * The wire shapes below were MEASURED against live Last.fm on 2026-09-30, and
 * the asymmetry is the whole bug:
 *
 *   user.getinfo,  no such user  -> HTTP 404, body {"message":"User not found","error":6}
 *   artist.getinfo, no such one  -> HTTP 200, body {"error":6,"message":"..."}
 *   any call, bad API key        -> HTTP 403, body {"message":"Invalid API key","error":10}
 *
 * So "does not exist" arrives as 404 on the user.* family and 200 on the entity
 * families. Last.fm's own contract is that the JSON body carries the code and
 * the HTTP status is a coarse transport-level summary of it. A parseable body
 * is authoritative; the status is only used when there is no body to read.
 *
 * TRANSPORT SEAM. `LastfmApi` reaches the network through a bare global
 * `fetch` inside the private `fetchWithRetry`; it offers no injection point and
 * adding one would be a production change made for the sake of a test. So this
 * file uses `vi.stubGlobal` / `vi.unstubAllGlobals`, which is the pair that
 * DELETES the stub and restores the original descriptor. That is deliberately
 * not `vi.spyOn(globalThis, 'fetch')` + `mockRestore()`: that path can leave an
 * own property holding `undefined`, which kills every later test in the file
 * with no error of its own.
 */

interface Wire {
  status: number;
  /** Omitted means an empty body, which is itself a wire shape. */
  body?: string;
}

/**
 * A transport double carrying ONLY the members production actually reads.
 *
 * `text` and not `json`, deliberately: the old code could not read a body on a
 * non-2xx response at all, so the old doubles needed no `text`, and that is
 * exactly why the defect was invisible. Supplying `json` as well would let a
 * regression back to `response.json()` pass unnoticed.
 */
const stubWire = (wire: Wire) => {
  const calls: Array<{ url: string; httpMethod: string }> = [];
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), httpMethod: init?.method ?? 'GET' });
    return {
      ok: wire.status >= 200 && wire.status < 300,
      status: wire.status,
      text: async () => wire.body ?? '',
    };
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
};

/** A fresh API and a fresh tracker per test, so spy counts are unambiguous. */
const makeApi = () => {
  const tracker = new LastfmErrorRateTracker();
  const trackSuccess = vi.spyOn(tracker, 'trackSuccess');
  const trackError = vi.spyOn(tracker, 'trackError');
  return { api: new LastfmApi(tracker), trackSuccess, trackError };
};

/** Records HOW the call ended, so a `null` cannot masquerade as a throw. */
const settle = (run: () => Promise<unknown>) =>
  run().then((value) => ({ outcome: 'resolved' as const, value }), (err) => ({ outcome: 'rejected' as const, err }));

/** The two public entry points, so no case can be fixed in only one of them. */
const ENTRY_POINTS: Array<{
  label: string;
  invoke: (api: LastfmApi) => Promise<unknown>;
}> = [
  {
    label: 'call',
    invoke: (api) => api.call('user.getinfo', { user: 'nonexistent-user-9f3a' }),
  },
  {
    label: 'callSigned',
    invoke: (api) => api.callSigned('user.getinfo', { user: 'nonexistent-user-9f3a' }, 'GET'),
  },
];

describe.each(ENTRY_POINTS)('LastfmApi.$label: the body code beats the HTTP status', (entry) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws code 6 for a 404 whose body is {"error":6} - the regression itself', async () => {
    // Live: `user.getinfo` on a nonexistent user is HTTP 404 with
    // {"message":"User not found","error":6}. Judging the status first threw
    // code 404, which is not in {6,7,8}, so a missing user read as an outage.
    stubWire({ status: 404, body: JSON.stringify({ message: 'User not found', error: 6 }) });
    const { api } = makeApi();

    const err = await settle(() => entry.invoke(api));

    expect(err.outcome).toBe('rejected');
    const thrown = (err as { err: unknown }).err;
    expect(thrown).toBeInstanceOf(LastfmApiError);
    // Exactly 6. `not.toBe(404)` alone would also pass on -1 or 0.
    expect((thrown as LastfmApiError).code).toBe(6);
    expect((thrown as LastfmApiError).message).toBe('User not found');
  });

  it('throws code 6 for a 200 whose body is {"error":6} - the entity families', async () => {
    // Live: `artist.getinfo` / `track.getinfo` on a nonexistent entity answer
    // 200 with the same code 6. The old order got this right by accident; this
    // guards the fix from breaking the half that already worked.
    stubWire({
      status: 200,
      body: JSON.stringify({ error: 6, message: 'The artist you supplied could not be found' }),
    });
    const { api } = makeApi();

    const err = await settle(() => entry.invoke(api));

    expect(err.outcome).toBe('rejected');
    expect(((err as { err: LastfmApiError }).err).code).toBe(6);
  });

  it('throws code 10 for a 403 with {"error":10}, not the status and not 6', async () => {
    // Live: a bad API key is HTTP 403 with error 10. An auth failure is the
    // other half of this class - if it collapsed onto the status it would be
    // an outage (correct-ish), but if it collapsed onto 6 it would be reported
    // as "that username does not exist", which is a lie about a real account.
    stubWire({ status: 403, body: JSON.stringify({ message: 'Invalid API key - You must be granted a valid key by last.fm', error: 10 }) });
    const { api } = makeApi();

    const err = await settle(() => entry.invoke(api));

    expect(err.outcome).toBe('rejected');
    const code = ((err as { err: LastfmApiError }).err).code;
    expect(code).toBe(10);
    expect(code).not.toBe(403);
    // The specific misreading the repository would act on.
    expect([6, 7, 8]).not.toContain(code);
  });

  it('throws the status for a 404 with an HTML body and no code to read', async () => {
    // A proxy error page is not an answer. Judging the body first must not turn
    // a transport failure into "no such thing", so the status is still used
    // when there is nothing parseable to override it.
    stubWire({ status: 404, body: '<!doctype html><html><body><h1>404 Not Found</h1></body></html>' });
    const { api } = makeApi();

    const err = await settle(() => entry.invoke(api));

    expect(err.outcome).toBe('rejected');
    const thrown = (err as { err: LastfmApiError }).err;
    expect(thrown).toBeInstanceOf(LastfmApiError);
    expect(thrown.code).toBe(404);
    expect(thrown.message).toContain('404');
  });

  it('throws the status for a 404 with an EMPTY body', async () => {
    // The other no-body shape, and the one a bare `JSON.parse('')` would turn
    // into a bare SyntaxError that no caller can classify.
    stubWire({ status: 404 });
    const { api } = makeApi();

    const err = await settle(() => entry.invoke(api));

    expect(err.outcome).toBe('rejected');
    expect((err as { err: LastfmApiError }).err).toBeInstanceOf(LastfmApiError);
    expect((err as { err: LastfmApiError }).err.code).toBe(404);
  });

  it('throws on a 200 with an unparseable body instead of resolving to null', async () => {
    // A 2xx whose body is not JSON is a broken response, not an empty answer.
    // Returning `null` here would be the same lie as a null for a missing
    // user, one layer down and in a new place.
    stubWire({ status: 200, body: '<html>gateway says hello</html>' });
    const { api } = makeApi();

    const err = await settle(() => entry.invoke(api));

    expect(err.outcome).toBe('rejected');
    const thrown = (err as { err: LastfmApiError }).err;
    expect(thrown).toBeInstanceOf(LastfmApiError);
    expect(thrown.message).toMatch(/unparseable/i);
  });

  it('returns the parsed body of a healthy 200 and counts it as a success', async () => {
    stubWire({ status: 200, body: JSON.stringify({ user: { name: 'DreadRock', playcount: '11361' } }) });
    const { api, trackSuccess, trackError } = makeApi();

    const result = (await entry.invoke(api)) as { user: { name: string; playcount: string } };

    expect(result).toEqual({ user: { name: 'DreadRock', playcount: '11361' } });
    expect(trackSuccess).toHaveBeenCalledTimes(1);
    expect(trackError).not.toHaveBeenCalled();
  });

  it('reports a body-level error to the rate tracker and not as a success', async () => {
    // `LastfmErrorRateTracker.trackError(LastfmApiError)` is the only metric
    // surface this layer has, and it is what `isElevated` gates crown steals
    // and autoposts on. A body code that never reached it would leave those
    // decisions reading a clean rate during a real outage.
    stubWire({ status: 404, body: JSON.stringify({ message: 'User not found', error: 6 }) });
    const { api, trackSuccess, trackError } = makeApi();

    await settle(() => entry.invoke(api));

    expect(trackError).toHaveBeenCalledTimes(1);
    const reported = trackError.mock.calls[0]?.[0] as LastfmApiError;
    expect(reported).toBeInstanceOf(LastfmApiError);
    expect(reported.code).toBe(6);
    expect(trackSuccess).not.toHaveBeenCalled();
  });
});

/**
 * The seam's own safety, asserted rather than asserted-in-prose.
 *
 * This repo has a proven failure mode: a mock-restore that leaves an own
 * property holding `undefined`, after which every later test in the file dies
 * silently. `vi.stubGlobal` / `vi.unstubAllGlobals` is the pair that DELETES
 * the stub and puts the original descriptor back, which is why this file uses it
 * instead of `vi.spyOn(globalThis, 'fetch')`. The test below is the receipt.
 */
describe('the transport stub leaves nothing behind', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('restores the original global fetch after the stub is removed', () => {
    const original = globalThis.fetch;

    stubWire({ status: 200, body: '{}' });
    expect(globalThis.fetch).not.toBe(original);

    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(original);
    expect(typeof globalThis.fetch).toBe('function');
  });
});

/**
 * The user-visible contract, over the seam that was actually broken.
 *
 * A real `LastfmApi` over the stubbed transport, NOT a mocked collaborator. The
 * existing repository contract tests hand the repository an object with `call`
 * and `callSigned` that throw whatever the test wants, which is why they stayed
 * green through the defect: the code that produced 404 instead of 6 lived one
 * layer below the seam they stubbed, so no shape of their double could ever have
 * seen it.
 */
describe('LastFmRepository over a real LastfmApi and the wire shapes from 2026-09-30', () => {
  const USER_OK = JSON.stringify({
    user: { name: 'DreadRock', realname: 'Real Name', playcount: '11361', country: 'UK' },
  });
  const TOP_ARTISTS_OK = JSON.stringify({
    topartists: {
      '@attr': { user: 'DreadRock', total: '900', page: '1', perPage: '2', totalPages: '450' },
      artist: [
        { name: 'Mond', playcount: '432', mbid: 'a1' },
        { name: 'Tycho', playcount: '311', mbid: 'a2' },
      ],
    },
  });
  const USER_NOT_FOUND = JSON.stringify({ message: 'User not found', error: 6 });
  const PROXY_HTML = '<!doctype html><html><body>502 Bad Gateway</body></html>';

  const makeRepo = () => new LastFmRepository(new LastfmApi(new LastfmErrorRateTracker()));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns null, not a raise, for a 404 whose body says the user does not exist', async () => {
    // The exact live shape. Before the fix this raised LastFmUnavailableError,
    // and the caller rendered "Last.fm is unreachable" for a username that
    // simply does not exist.
    stubWire({ status: 404, body: USER_NOT_FOUND });
    const repo = makeRepo();

    await expect(repo.getUserInfo('nonexistent-user-9f3a')).resolves.toBeNull();
  });

  it('returns an empty list, not a raise, for a 404 whose body says the user does not exist', async () => {
    // Same shape, top-list path. An empty list here is a real answer; a raise
    // told the user their whole listening history could not be read.
    stubWire({ status: 404, body: USER_NOT_FOUND });
    const repo = makeRepo();

    await expect(repo.getTopArtists('nonexistent-user-9f3a', TimePeriod.AllTime, 10, 1)).resolves.toEqual([]);
  });

  it('converts a healthy 200 user payload, so the two tests above are not green for the wrong reason', async () => {
    // The control. Without it, a repository that failed every call would make
    // both "resolves to null" and "resolves to []" pass, and the file would
    // assert nothing at all.
    stubWire({ status: 200, body: USER_OK });
    const repo = makeRepo();

    const user = await repo.getUserInfo('DreadRock');

    expect(user?.name).toBe('DreadRock');
    expect(user?.playCount).toBe(11361);
  });

  it('converts a healthy 200 top-artists payload, the control for the empty-list assertion', async () => {
    stubWire({ status: 200, body: TOP_ARTISTS_OK });
    const repo = makeRepo();

    const artists = await repo.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1);

    expect(artists).toHaveLength(2);
    expect(artists[0]).toEqual({ name: 'Mond', playcount: 432, mbid: 'a1', url: undefined });
  });

  it('raises for a 403 with {"error":10} - a broken API key is not a missing user', async () => {
    // The other half of the class, end to end. Reporting this as "that user
    // does not exist" would be a claim about a real account.
    stubWire({ status: 403, body: JSON.stringify({ message: 'Invalid API key - You must be granted a valid key by last.fm', error: 10 }) });
    const repo = makeRepo();

    const err = await repo.getUserInfo('DreadRock').then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(LastFmUnavailableError);
    expect((err as LastFmUnavailableError).method).toBe('user.getinfo');
  });

  it('raises for a proxy HTML error page, which is a transport failure and not an answer', async () => {
    // No parseable body means the status is used, so the code is 502 - and 502
    // is not in {6,7,8}, so it must not degrade to a null user.
    stubWire({ status: 502, body: PROXY_HTML });
    const repo = makeRepo();

    const err = await repo.getUserInfo('DreadRock').then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(LastFmUnavailableError);
  });
});
