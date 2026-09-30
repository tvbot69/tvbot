import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifySearchApi } from './spotifySearchApi';
import type { SpotifyTokenManager } from './spotifyTokenManager';
import { Logger } from '@domain/logger';

/**
 * `getSpotifyTrackUrl` — the matcher that decides which search result is "the"
 * track, and every rule it uses to reject the rest.
 *
 * Unlike the rest of the module this method answers `null` for a failure, and
 * the comment at the catch says why: both callers ask for a bonus preview URL
 * inside a try, and "no preview link for this track" is honest absence — the
 * ladder has Apple and Deezer rungs after it, and no caller reports it as "this
 * track is not on Spotify". So a raise here would buy a log line on a path that
 * is swallowed one layer up, for a value nothing renders as a fact. These tests
 * therefore pin the null-on-failure behaviour deliberately rather than by
 * accident.
 *
 * The rejection rules matter more than they look. A search for "Artist Track"
 * returns anything with either token in it, and returning the top hit
 * unexamined produces a Spotify link to a cover band, a remix or a karaoke
 * version — which a user cannot tell from the real one.
 *
 * VENDOR ASSUMPTION: a track result carries its id at `id` and its canonical
 * public URL at `external_urls.spotify`, and `id` is what
 * `https://open.spotify.com/track/{id}` resolves to. Nothing here checks that
 * against the live API.
 */

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response;

interface Hit {
  id?: string;
  name?: string;
  artists?: Array<{ id?: string; name: string }>;
  external_urls?: { spotify?: string };
}

const searchReturning = (...items: Hit[]) => {
  const fetchMock = vi.fn(
    async (..._args: unknown[]) => jsonResponse({ tracks: { items } }),
  );
  return fetchMock;
};

const build = (token: string | null = 'test-token') => {
  const getToken = vi.fn(async (): Promise<string | null> => token);
  const invalidate = vi.fn();
  const rotateCredential = vi.fn((): boolean => false);
  const tokenManager = {
    getToken,
    invalidate,
    rotateCredential,
  } as unknown as SpotifyTokenManager;
  return { api: new SpotifySearchApi(tokenManager), getToken, invalidate, rotateCredential };
};

beforeEach(() => {
  SpotifySearchApi.clearRateLimit();
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  SpotifySearchApi.clearRateLimit();
});

describe('getSpotifyTrackUrl — a single clean match', () => {
  it('builds the canonical URL from the id, without asking for the public URL', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning({ id: 'TRACK1', name: 'Airbag', artists: [{ name: 'Radiohead' }] }),
    );

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBe(
      'https://open.spotify.com/track/TRACK1',
    );
  });

  it('falls back to the public URL when the result carries no id', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning({
        name: 'Airbag',
        artists: [{ name: 'Radiohead' }],
        external_urls: { spotify: 'https://open.spotify.com/track/ONLY-URL' },
      }),
    );

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBe(
      'https://open.spotify.com/track/ONLY-URL',
    );
  });

  it('answers null when the match carries neither an id nor a public URL', async () => {
    // Honest absence, not a broken link: the caller renders no preview.
    const { api } = build();
    vi.stubGlobal('fetch', searchReturning({ name: 'Airbag', artists: [{ name: 'Radiohead' }] }));

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('answers null when the search returned nothing at all', async () => {
    const { api } = build();
    vi.stubGlobal('fetch', searchReturning());

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('answers null when the search came back with no `tracks` key', async () => {
    const { api } = build();
    vi.stubGlobal('fetch', vi.fn(async (..._args: unknown[]) => jsonResponse({ artists: {} })));

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
  });
});

describe('getSpotifyTrackUrl — rejecting the wrong recording', () => {
  it('drops a result whose artist AND track are both wrong', async () => {
    // A cover band, a remix or a karaoke version. Every one of them looks right
    // in a search result, which is the entire reason this filter exists.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning({ id: 'WRONG', name: 'Sonnet 2', artists: [{ name: 'Blur' }] }),
    );

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('keeps the right recording when it sits below a rejected one in the results', async () => {
    // Ranking must come from the scorer, not from Spotify's ordering: a search
    // for "Radiohead Airbag" legitimately returns other artists first.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning(
        { id: 'COVER', name: 'Karma Police', artists: [{ name: 'Noel Gallagher' }] },
        { id: 'REAL', name: 'Airbag', artists: [{ name: 'Radiohead' }] },
      ),
    );

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBe(
      'https://open.spotify.com/track/REAL',
    );
  });

  it('keeps a same-track/different-artist result, which is the tolerance the "baba" rule corrects', async () => {
    // The control for the pair below, and it pins a deliberate-looking choice:
    // a result with the EXACT track title but a different artist is only
    // penalised, never dropped. That is what lets a featuring or re-recorded
    // version through — and it is also what makes the `baba` correction
    // necessary, because the same shape is a live false positive for artists
    // whose names begin "Baba".
    const { api } = build();
    vi.stubGlobal('fetch', searchReturning({ id: 'BLURVER', name: 'Airbag', artists: [{ name: 'Blur' }] }));

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBe(
      'https://open.spotify.com/track/BLURVER',
    );
  });

  it('drops that same result once the queried artist contains "baba", instead of returning a wrong link', async () => {
    // Identical candidate shape to the control above; the ONLY difference is
    // that "Baba Maal" contains "baba" and "Blur" does not. The -5000 pushes
    // the score below zero, so the row leaves the candidate pool and the method
    // answers null rather than handing the user a Spotify link to the wrong
    // artist.
    const { api } = build();
    vi.stubGlobal('fetch', searchReturning({ id: 'BLURVER', name: 'Junun', artists: [{ name: 'Blur' }] }));

    await expect(api.getSpotifyTrackUrl('Baba Maal', 'Junun')).resolves.toBeNull();
  });

  it('still returns the right recording for a "baba" query when a genuine match is present', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning(
        { id: 'WRONGARTIST', name: 'Junun', artists: [{ name: 'Blur' }] },
        { id: 'REAL', name: 'Junun', artists: [{ name: 'Baba Maal' }] },
      ),
    );

    await expect(api.getSpotifyTrackUrl('Baba Maal', 'Junun')).resolves.toBe(
      'https://open.spotify.com/track/REAL',
    );
  });

  it('rejects everything when the track name matches nothing and the artist is not the asked one', async () => {
    // Reachable only with a blank artist name: with a non-empty one the earlier
    // artist block already returned -1. Asserted because the branch is otherwise
    // invisible, and an unreachable branch in a matcher is a branch nobody
    // maintains.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning({ id: 'X', name: 'Sonnet 2', artists: [{ name: 'Blur' }] }),
    );

    await expect(api.getSpotifyTrackUrl('', 'Airbag')).resolves.toBeNull();
  });

  it('tolerates a result with no credited artist at all rather than throwing', async () => {
    // A malformed row must not take the whole lookup down; it scores as a
    // non-match and the other rows still compete.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning(
        { id: 'NOARTIST', name: 'Sonnet 2' },
        { id: 'REAL', name: 'Airbag', artists: [{ name: 'Radiohead' }] },
      ),
    );

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBe(
      'https://open.spotify.com/track/REAL',
    );
  });

  it('tolerates a result with no name, and treats the empty string as a miss', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      searchReturning(
        { id: 'NONAME', artists: [{ name: 'Radiohead' }] },
        { id: 'REAL', name: 'Airbag', artists: [{ name: 'Radiohead' }] },
      ),
    );

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBe(
      'https://open.spotify.com/track/REAL',
    );
  });
});

describe('getSpotifyTrackUrl — a failed lookup is an honest null', () => {
  it('answers null on a 500 rather than raising', async () => {
    const { api } = build();
    vi.stubGlobal('fetch', vi.fn(async (..._args: unknown[]) => jsonResponse({}, 500)));

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('answers null on a transport failure rather than raising', async () => {
    const { api } = build();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('answers null when there are no credentials, because nothing was ever asked', async () => {
    const { api } = build(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends ONE request per call, at limit 5', async () => {
    // The deleted quoted-query retry used to double every call. A limit of 15
    // would be a measured 400, so both numbers are load-bearing.
    const { api } = build();
    const fetchMock = searchReturning({ id: 'T', name: 'Airbag', artists: [{ name: 'Radiohead' }] });
    vi.stubGlobal('fetch', fetchMock);

    await api.getSpotifyTrackUrl('Radiohead', 'Airbag');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=5');
  });
});
