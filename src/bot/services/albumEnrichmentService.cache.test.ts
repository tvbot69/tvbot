import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlbumEnrichmentService, parseSpotifyReleaseDate } from './albumEnrichmentService';
import type { TopAlbum } from '@domain/models/topLists';

/**
 * Chart release-date and album-type filtering depends entirely on this, and
 * the filter is a *deletion*: an album whose release date could not be read is
 * dropped from a year-filtered chart, and one whose type is unknown is treated
 * as an album. So the two failure directions are different:
 *
 *   - a provider that answered with nothing leaves the album un-enriched, and
 *     the year filter then removes it. The album really is unverified; the
 *     chart is honest about having fewer cells.
 *   - a provider that THREW is not the same, and is retried rather than
 *     remembered as "this album has no date".
 *
 * `enrichTopAlbums` swallows a per-album throw, which is correct for the batch
 * (one bad album must not blank a whole chart) and is why the cache matters:
 * the next chart run re-reads it.
 */

type Rec = Record<string, unknown>;

const album = (name: string, over: Rec = {}) =>
  ({ name, artistName: 'Radiohead', playcount: 1, ...over }) as unknown as TopAlbum;

const memCache = () => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k) : null),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
  };
};

const build = (over: {
  spotify?: Rec;
  artists?: Rec;
  albums?: Rec;
  cache?: ReturnType<typeof memCache>;
} = {}) => {
  const cache = over.cache ?? memCache();
  const artistRepository = { getArtistByName: vi.fn(async () => null), ...(over.artists as Rec) };
  const albumRepository = {
    getAlbumByNameAndArtist: vi.fn(async () => null),
    setReleaseData: vi.fn(async () => undefined),
    ...(over.albums as Rec),
  };
  const spotifyApi = { searchAlbums: vi.fn(async () => []), ...(over.spotify as Rec) };
  const service = new AlbumEnrichmentService(
    spotifyApi as never,
    artistRepository as never,
    albumRepository as never,
    cache as never,
  );
  return { service, spotifyApi, artistRepository, albumRepository, cache };
};

const spotifyAlbum = (over: Rec = {}) => ({
  id: 'x', name: 'Kid A', uri: 'u',
  release_date: '1997-05-21', release_date_precision: 'day', album_type: 'album',
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('parseSpotifyReleaseDate', () => {
  it('reads a full date', () => {
    const d = parseSpotifyReleaseDate('1997-05-21', 'day');
    expect(d?.toISOString()).toBe('1997-05-21T00:00:00.000Z');
  });

  it('defaults a year-only value to the first of January', () => {
    const d = parseSpotifyReleaseDate('1997', 'year');
    expect(d?.toISOString()).toBe('1997-01-01T00:00:00.000Z');
  });

  it('defaults a month-precision value to the first of the month', () => {
    const d = parseSpotifyReleaseDate('1997-05', 'month');
    expect(d?.toISOString()).toBe('1997-05-01T00:00:00.000Z');
  });

  it('ignores the day when the precision is only a month', () => {
    // Spotify sends "1997-05-01" with precision "month"; taking the 1st as the
    // day is right, and taking it as fact is not.
    expect(parseSpotifyReleaseDate('1997-05-01', 'month')?.toISOString()).toBe('1997-05-01T00:00:00.000Z');
  });

  it('builds in UTC so the date does not shift with the host timezone', () => {
    // A local-midnight constructor would put a New Year release on 31 December
    // for anyone west of Greenwich, and out of a "1990s" filter entirely.
    const d = parseSpotifyReleaseDate('1997', 'year');
    expect(d?.getUTCHours()).toBe(0);
  });

  it('answers undefined for a missing value rather than an epoch date', () => {
    // The epoch is 1970, which is inside every decade filter, so an invented
    // default here would put undated albums into "1970s".
    expect(parseSpotifyReleaseDate(undefined, 'year')).toBeUndefined();
    expect(parseSpotifyReleaseDate('', 'year')).toBeUndefined();
  });

  it('answers undefined for an unparseable value', () => {
    expect(parseSpotifyReleaseDate('not-a-year', 'year')).toBeUndefined();
  });

  it('answers undefined for a nonsensical year', () => {
    expect(parseSpotifyReleaseDate('0000', 'year')).toBeUndefined();
  });
});

describe('AlbumEnrichmentService.enrichTopAlbums', () => {
  it('does nothing when every album is already enriched', async () => {
    const { service, spotifyApi } = build();
    const albums = [
      album('Kid A', { releaseDate: new Date(), albumType: 'album' }),
      album('Amnesiac', { releaseDate: new Date(), albumType: 'album' }),
    ];

    await service.enrichTopAlbums(albums);

    expect(spotifyApi.searchAlbums).not.toHaveBeenCalled();
  });

  it('fills in the release date and album type from the provider', async () => {
    const { service } = build({ spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum()]) } });
    const target = album('Kid A');

    await service.enrichTopAlbums([target]);

    expect(target.releaseDate?.toISOString()).toBe('1997-05-21T00:00:00.000Z');
    expect(target.albumType).toBe('album');
  });

  it('prefers an exact album-name match over the first search hit', async () => {
    const { service } = build({
      spotify: {
        searchAlbums: vi.fn(async () => [
          spotifyAlbum({ name: 'Kid A (Deluxe)', album_type: 'album', release_date: '1997-05-21' }),
          spotifyAlbum({ name: 'Kid A', album_type: 'single', release_date: '2010-01-01' }),
        ]),
      },
    });
    const target = album('Kid A');

    await service.enrichTopAlbums([target]);

    expect(target.albumType).toBe('single');
  });

  it('falls back to the first hit when nothing matched by name', async () => {
    const { service } = build({ spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum({ name: 'Totally Different' })]) } });
    const target = album('Kid A');

    await service.enrichTopAlbums([target]);

    expect(target.releaseDate).toBeInstanceOf(Date);
  });

  it('leaves an album untouched when the provider answered with nothing', async () => {
    // A genuine empty result is an absence, not a deletion. The album keeps its
    // undefined date and the year filter drops it — which is the honest answer.
    const { service } = build();
    const target = album('Kid A');

    await service.enrichTopAlbums([target]);

    expect(target.releaseDate).toBeUndefined();
    expect(target.albumType).toBeUndefined();
  });

  it('enriches every album even when one of them throws', async () => {
    // A batch that aborted on one bad name would leave a whole chart unfilled.
    let n = 0;
    const { service } = build({
      spotify: {
        searchAlbums: vi.fn(async (q: string) => {
          n++;
          if (q.includes('Boom')) throw new Error('upstream 500');
          return [spotifyAlbum({ name: q.split(' ')[0] })];
        }),
      },
    });
    const good = album('Kid A');
    const bad = album('Boom');
    const alsoGood = album('Amnesiac');

    await service.enrichTopAlbums([good, bad, alsoGood]);

    expect(good.releaseDate).toBeInstanceOf(Date);
    expect(alsoGood.releaseDate).toBeInstanceOf(Date);
    expect(bad.releaseDate).toBeUndefined();
    expect(n).toBe(3);
  });

  it('serves the second run from cache without asking the provider again', async () => {
    const searchAlbums = vi.fn(async () => [spotifyAlbum()]);
    const { service } = build({ spotify: { searchAlbums } });

    await service.enrichTopAlbums([album('Kid A')]);
    await service.enrichTopAlbums([album('Kid A')]);

    expect(searchAlbums).toHaveBeenCalledTimes(1);
  });

  it('caches a genuine no-match briefly, so a chart does not re-search every render', async () => {
    const searchAlbums = vi.fn(async () => []);
    const { service, cache } = build({ spotify: { searchAlbums } });

    await service.enrichTopAlbums([album('Kid A')]);

    expect(cache.store.get('album-enrich:radiohead|kid a')).toEqual({});
  });

  it('treats a cached empty result as "nothing known" rather than as enrichment data', async () => {
    // `{}` in the cache is the no-match marker. Writing it onto the album would
    // stamp `albumType: undefined` explicitly and defeat the `?? 'album'`
    // default the singles filter relies on.
    const { service, cache } = build();
    cache.store.set('album-enrich:radiohead|kid a', {});
    const target = album('Kid A');

    await service.enrichTopAlbums([target]);

    expect(target.albumType).toBeUndefined();
  });

  it('uses the cached data when it carries either field', async () => {
    const { service, cache } = build();
    cache.store.set('album-enrich:radiohead|kid a', { albumType: 'single' });
    const target = album('Kid A');

    await service.enrichTopAlbums([target]);

    expect(target.albumType).toBe('single');
  });

  it('enriches albums that already have one field but not the other', async () => {
    const { service, spotifyApi } = build({ spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum()]) } });

    await service.enrichTopAlbums([album('Kid A', { albumType: 'album' })]);

    expect(spotifyApi.searchAlbums).toHaveBeenCalled();
  });
});

describe('AlbumEnrichmentService persistence', () => {
  it('stores the release data on the album row', async () => {
    const written: unknown[][] = [];
    const { service } = build({
      spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum()]) },
      artists: { getArtistByName: vi.fn(async () => ({ artistId: 3 })) },
      albums: {
        getAlbumByNameAndArtist: vi.fn(async () => ({ albumId: 9, releaseDate: null })),
        setReleaseData: async (...args: unknown[]) => { written.push(args); },
      },
    });

    await service.enrichTopAlbums([album('Kid A')]);

    expect(written[0]?.[0]).toBe(9);
  });

  it('does not overwrite a release date the database already has', async () => {
    // The stored date came from a full metadata read; a search result is weaker
    // evidence and must not replace it.
    const written: unknown[][] = [];
    const { service } = build({
      spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum()]) },
      artists: { getArtistByName: vi.fn(async () => ({ artistId: 3 })) },
      albums: {
        getAlbumByNameAndArtist: vi.fn(async () => ({ albumId: 9, releaseDate: new Date('1997-05-21') })),
        setReleaseData: async (...args: unknown[]) => { written.push(args); },
      },
    });

    await service.enrichTopAlbums([album('Kid A')]);

    expect(written).toEqual([]);
  });

  it('still enriches the chart album when the database write fails', async () => {
    // The filter runs on the in-memory copy, so a failed persist costs the
    // next render a re-read and nothing the user can see.
    const { service } = build({
      spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum()]) },
      artists: { getArtistByName: vi.fn(async () => ({ artistId: 3 })) },
      albums: {
        getAlbumByNameAndArtist: vi.fn(async () => ({ albumId: 9, releaseDate: null })),
        setReleaseData: vi.fn(async () => { throw new Error('db down'); }),
      },
    });
    const target = album('Kid A');

    await expect(service.enrichTopAlbums([target])).resolves.toBeUndefined();
    expect(target.releaseDate?.toISOString()).toBe('1997-05-21T00:00:00.000Z');
  });

  it('skips persistence entirely when there is no artist row', async () => {
    const { service, albumRepository } = build({
      spotify: { searchAlbums: vi.fn(async () => [spotifyAlbum()]) },
      artists: { getArtistByName: vi.fn(async () => null) },
    });

    await service.enrichTopAlbums([album('Kid A')]);

    expect(albumRepository.getAlbumByNameAndArtist).not.toHaveBeenCalled();
  });
});
