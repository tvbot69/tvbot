import 'reflect-metadata';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { container } from 'tsyringe';
import { GenreService } from '@bot/services/library/genreService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { Logger } from '@domain/logger';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';

/**
 * GenreService is the join between three sources that routinely disagree:
 * our own `artist_genres` table, Last.fm tags and Spotify's genre list. The
 * interesting behaviour is therefore almost entirely about WHICH source wins
 * and about suppression - a wrong genre is worse than no genre, so the service
 * deliberately returns `[]` in several places rather than guessing.
 *
 * The Spotify collision guard is the sharpest edge in the file. Same-name
 * artists ("Mond", "Muse") mean Last.fm tags resolved by NAME alone can belong
 * to a different human being, so a track-anchored Spotify id that disagrees
 * with the naive name search suppresses the Last.fm tags entirely rather than
 * attributing them to the wrong entity. That branch is pinned below, because
 * "returns no genres" is otherwise indistinguishable from "the API was down".
 *
 * THE SILENT-FAILURE CLASS. Seven methods here are `$queryRaw` aggregates that
 * each ended in `catch { return [] }`, which made a dropped Postgres connection
 * and a user with no scrobbles the same value. `.topgenres` answered "you have
 * no genres" and `.whoknowsgenre` answered "nobody in this server listens to
 * anything" during an outage, with nothing in the log. Each of those is now a
 * PAIR: the failure RAISES, and a query that ran and found no rows still returns
 * `[]`. A test that only asserted the raise would pass just as happily against a
 * method that always throws, which trades one wrong answer for another - so both
 * directions are pinned on every one of the seven.
 *
 * A malformed guild id is a third case and is neither. `BigInt('abc')` throws
 * synchronously, and that is a bad argument rather than a source that failed to
 * answer, so it returns the empty result WITHOUT opening a query - retrying it
 * could never succeed. Those tests are kept as they were.
 *
 * Two catches are deliberately left alone and say so inline: the Spotify anchor
 * (an optional precision improvement that falls through to a second real source)
 * and `artist.gettoptags` (the last rung of a ladder that has already
 * established the artist is untagged). Neither can convert a real answer into an
 * empty one, so changing them would be churn rather than a fix.
 */

const spotify = {
  getArtistIdViaTrackSample: vi.fn(),
  getArtistById: vi.fn(),
  searchArtists: vi.fn(),
};

const lastfmApiStub = { call: vi.fn() };

// Registered once for the whole file: vitest isolates the module graph per test
// file, so this cannot leak into another suite. `container.clearInstances()`
// would wipe a `useValue` registration, so it is never called in this file.
container.register(SpotifySearchApi, { useValue: spotify as never });
container.register(LastfmApi, { useValue: lastfmApiStub as never });

type ArtistInfoShape = { name?: string; tags?: string[] };

/** Prisma 5xx / driver-level connectivity failure, the realistic shape. */
const DB_DOWN = () => new Error("Can't reach database server at `host.docker.internal:5432`");

const build = (over: {
  cacheGet?: unknown;
  genresForName?: unknown;
  genresForNames?: unknown;
  setForArtistId?: unknown;
  getOrCreateArtist?: unknown;
  getArtistInfo?: ArtistInfoShape | null;
  queryRaw?: unknown;
} = {}) => {
  const cache = {
    get: vi.fn(async () => (over.cacheGet === undefined ? null : over.cacheGet)),
    set: vi.fn(async () => undefined),
  };
  const artistGenreRepo = {
    getForArtistName: vi.fn(async () => (over.genresForName === undefined ? [] : over.genresForName) as string[]),
    getForArtistNames: vi.fn(async () => (over.genresForNames === undefined ? new Map() : over.genresForNames)),
    setForArtistId: vi.fn(async () => (over.setForArtistId === undefined ? undefined : over.setForArtistId)),
  };
  const artistRepo = {
    getOrCreateArtist: vi.fn(async () => (over.getOrCreateArtist === undefined
      ? { artistId: 7, name: 'Radiohead' }
      : over.getOrCreateArtist) as { artistId: number; name: string }),
  };
  const lastfmRepo = {
    getArtistInfo: vi.fn(async () => (over.getArtistInfo === undefined ? null : over.getArtistInfo) as ArtistInfoShape | null),
  };
  const prisma = {
    $queryRaw: vi.fn(async () => (over.queryRaw === undefined ? [] : over.queryRaw)),
  };
  const service = new GenreService(
    cache as never,
    artistGenreRepo as never,
    artistRepo as never,
    lastfmRepo as never,
    prisma as never,
  );
  return { service, cache, artistGenreRepo, artistRepo, lastfmRepo, prisma };
};

beforeEach(() => {
  vi.clearAllMocks();
  spotify.getArtistIdViaTrackSample.mockReset().mockResolvedValue(null);
  spotify.getArtistById.mockReset().mockResolvedValue(null);
  spotify.searchArtists.mockReset().mockResolvedValue([]);
  lastfmApiStub.call.mockReset().mockResolvedValue({ toptags: { tag: [] } });
});

// `vi.spyOn(Logger, 'error')` is used in the failure tests below, and a spy left
// in place is the exact bug class this repo has been bitten by before:
// `mockRestore()` on a shared module singleton can leave an own property set to
// `undefined`, and every later test then fails silently against it. Restore
// after every test rather than per-test, so a new failure test cannot forget.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GenreService.genresToString', () => {
  it('joins with the middle dot separator the cards use', () => {
    expect(GenreService.genresToString(['rock', 'indie'])).toBe('rock · indie');
  });

  it('returns an empty string for no genres rather than a lone separator', () => {
    expect(GenreService.genresToString([])).toBe('');
  });
});

describe('GenreService.getGenresForArtist', () => {
  it('returns an empty array for an empty artist name without touching the cache', async () => {
    const { service, cache } = build();
    await expect(service.getGenresForArtist('')).resolves.toEqual([]);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('returns the anchored cache entry without hitting Spotify or the database', async () => {
    const built = build({ cacheGet: ['ambient', 'electronic'] });
    await expect(built.service.getGenresForArtist('Burial', 'Archangel')).resolves.toEqual(['ambient', 'electronic']);
    expect(built.artistGenreRepo.getForArtistName).not.toHaveBeenCalled();
    expect(built.lastfmRepo.getArtistInfo).not.toHaveBeenCalled();
    expect(spotify.getArtistIdViaTrackSample).not.toHaveBeenCalled();
  });

  it('uses a track-scoped cache key for the anchored path', async () => {
    const built = build();
    spotify.getArtistIdViaTrackSample.mockResolvedValue('spot-id');
    spotify.getArtistById.mockResolvedValue({ id: 'spot-id', genres: ['Trip Hop'] });
    await built.service.getGenresForArtist('Burial', 'Archangel');
    expect(built.cache.get).toHaveBeenCalledWith('genres:burial:via:archangel');
  });

  it('normalises anchored Spotify genres and caches them for an hour', async () => {
    const built = build();
    spotify.getArtistIdViaTrackSample.mockResolvedValue('spot-id');
    spotify.getArtistById.mockResolvedValue({
      id: 'spot-id',
      genres: ['  Trip Hop ', '', 'DUBSTEP', 'UK GARAGE', 'FIFTH', 'DROPPED'],
    });
    await expect(built.service.getGenresForArtist('Burial', 'Archangel')).resolves.toEqual([
      'trip hop', 'dubstep', 'uk garage', 'fifth',
    ]);
    expect(built.cache.set).toHaveBeenCalledWith('genres:burial:via:archangel', ['trip hop', 'dubstep', 'uk garage', 'fifth'], 3600);
    expect(built.artistGenreRepo.setForArtistId).not.toHaveBeenCalled();
    expect(built.lastfmRepo.getArtistInfo).not.toHaveBeenCalled();
  });

  it('suppresses Last.fm tags when the anchored entity is not the naive name winner', async () => {
    // The whole point of the anchor: Last.fm tags for "Mond" (the rapper) are
    // actively wrong for a Different Sean record, so no genres beats wrong ones.
    const built = build();
    spotify.getArtistIdViaTrackSample.mockResolvedValue('anchored-id');
    spotify.getArtistById.mockResolvedValue({ id: 'anchored-id', genres: [] });
    spotify.searchArtists.mockResolvedValue([
      { id: 'naive-id', name: 'Mond' },
      { id: 'other-id', name: 'Mond' },
    ]);
    await expect(built.service.getGenresForArtist('Mond', 'Different Sean')).resolves.toEqual([]);
    expect(built.cache.set).toHaveBeenCalledWith('genres:mond:via:different sean', [], 3600);
    expect(built.lastfmRepo.getArtistInfo).not.toHaveBeenCalled();
    expect(built.artistGenreRepo.getForArtistName).not.toHaveBeenCalled();
  });

  it('falls through to the name flow when the anchor IS the naive name winner', async () => {
    const built = build({ genresForName: ['indie rock'] });
    spotify.getArtistIdViaTrackSample.mockResolvedValue('same-id');
    spotify.getArtistById.mockResolvedValue({ id: 'same-id', genres: [] });
    spotify.searchArtists.mockResolvedValue([{ id: 'same-id', name: 'mond' }]);
    await expect(built.service.getGenresForArtist('Mond', 'Different Sean')).resolves.toEqual(['indie rock']);
    expect(built.artistGenreRepo.getForArtistName).toHaveBeenCalledWith('Mond');
  });

  it('falls through to the name flow when the anchor cannot be resolved at all', async () => {
    const built = build({ genresForName: ['indie rock'] });
    spotify.getArtistIdViaTrackSample.mockResolvedValue(null);
    await expect(built.service.getGenresForArtist('Mond', 'Different Sean')).resolves.toEqual(['indie rock']);
    expect(built.artistGenreRepo.getForArtistName).toHaveBeenCalledWith('Mond');
  });

  it('falls through to the name flow when the Spotify client throws', async () => {
    const built = build({ genresForName: ['indie rock'] });
    spotify.getArtistIdViaTrackSample.mockImplementation(() => { throw new Error('spotify down'); });
    await expect(built.service.getGenresForArtist('Mond', 'Different Sean')).resolves.toEqual(['indie rock']);
    expect(built.artistGenreRepo.getForArtistName).toHaveBeenCalledWith('Mond');
  });

  it('does not consult Spotify at all when no sample track is given', async () => {
    const built = build({ genresForName: ['indie rock'] });
    await expect(built.service.getGenresForArtist('Mond')).resolves.toEqual(['indie rock']);
    expect(spotify.getArtistIdViaTrackSample).not.toHaveBeenCalled();
  });

  it('uses the name-keyed cache on the unanchored path', async () => {
    const built = build();
    (built.cache.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['ambient', 'dub']);
    await expect(built.service.getGenresForArtist('  Burial ')).resolves.toEqual(['ambient', 'dub']);
    expect(built.cache.get).toHaveBeenCalledWith('genres:burial');
    expect(built.artistGenreRepo.getForArtistName).not.toHaveBeenCalled();
  });

  it('caches a database hit for an hour and skips Last.fm', async () => {
    const built = build({ genresForName: ['indie rock', 'dream pop'] });
    await expect(built.service.getGenresForArtist('Radiohead')).resolves.toEqual(['indie rock', 'dream pop']);
    expect(built.cache.set).toHaveBeenCalledWith('genres:radiohead', ['indie rock', 'dream pop'], 3600);
    expect(built.lastfmRepo.getArtistInfo).not.toHaveBeenCalled();
  });

  it('persists Last.fm tags against the artist and caches them', async () => {
    const built = build({
      getArtistInfo: { name: 'Radiohead', tags: ['Art Rock', 'UK'] },
      getOrCreateArtist: { artistId: 42, name: 'Radiohead' },
    });
    await expect(built.service.getGenresForArtist('Radiohead')).resolves.toEqual(['art rock', 'uk']);
    expect(built.artistRepo.getOrCreateArtist).toHaveBeenCalledWith('Radiohead');
    expect(built.artistGenreRepo.setForArtistId).toHaveBeenCalledWith(42, ['art rock', 'uk']);
    expect(built.cache.set).toHaveBeenCalledWith('genres:radiohead', ['art rock', 'uk'], 3600);
  });

  it('retries the s/$ spelling variant and uses whichever returns tags', async () => {
    // The swap is a GLOBAL `s` -> `$` replace, so a name with two s characters
    // probes a spelling no human would type ("Travi$ $cott"). Pinned as current
    // behaviour: the probe is best-effort, a miss just costs one extra request.
    const built = build();
    built.lastfmRepo.getArtistInfo
      .mockResolvedValueOnce({ name: 'Mars', tags: [] })
      .mockResolvedValueOnce({ name: 'Mar$', tags: ['Hip Hop', 'Trap'] });
    await expect(built.service.getGenresForArtist('Mars')).resolves.toEqual(['hip hop', 'trap']);
    expect(built.lastfmRepo.getArtistInfo).toHaveBeenNthCalledWith(2, 'Mar$');
  });

  it('replaces a dollar sign with a plain s and retries', async () => {
    const built = build();
    built.lastfmRepo.getArtistInfo
      .mockResolvedValueOnce({ name: 'Travi$ Scott', tags: [] })
      .mockResolvedValueOnce({ name: 'Travis Scott', tags: ['Trap'] });
    await expect(built.service.getGenresForArtist('Travi$ Scott')).resolves.toEqual(['trap']);
    expect(built.lastfmRepo.getArtistInfo).toHaveBeenNthCalledWith(2, 'Travis Scott');
  });

  it('only runs the s/$ retry for a name that contains an s at all', async () => {
    const built = build();
    built.lastfmRepo.getArtistInfo.mockResolvedValue({ name: 'Burial', tags: [] });
    await expect(built.service.getGenresForArtist('Burial')).resolves.toEqual([]);
    expect(built.lastfmRepo.getArtistInfo).toHaveBeenCalledTimes(1);
  });

  it('falls back to artist.gettoptags when getInfo lists no tags', async () => {
    const built = build();
    lastfmApiStub.call.mockResolvedValue({ toptags: { tag: [{ name: 'Shoegaze' }, { name: 'Noise Rock' }] } });
    await expect(built.service.getGenresForArtist('My Bloody Valentine')).resolves.toEqual(['shoegaze', 'noise rock']);
    expect(lastfmApiStub.call).toHaveBeenCalledWith('artist.gettoptags', { artist: 'My Bloody Valentine', autocorrect: '1' });
  });

  it('ignores a gettoptags failure and caches the definitive miss for ten minutes', async () => {
    const built = build();
    lastfmApiStub.call.mockRejectedValue(new Error('lastfm 500'));
    await expect(built.service.getGenresForArtist('Nobody')).resolves.toEqual([]);
    expect(built.cache.set).toHaveBeenCalledWith('genres:nobody', [], 600);
  });

  it('drops a tag that is just the artist name again', async () => {
    // Last.fm happily returns the artist name as its top tag. Normalisation
    // ignores spaces and the $/s difference, so "Travis Scott" and
    // "Travis Scott" both collapse to the artist key and are removed.
    const built = build();
    built.lastfmRepo.getArtistInfo.mockResolvedValue({ name: 'Travis Scott', tags: ['Travis Scott', 'Hip Hop'] });
    await expect(built.service.getGenresForArtist('Travis Scott')).resolves.toEqual(['hip hop']);
    expect(built.artistGenreRepo.setForArtistId).toHaveBeenCalledWith(7, ['hip hop']);
  });

  it('caps the resolved tag list at four entries', async () => {
    const built = build();
    built.lastfmRepo.getArtistInfo.mockResolvedValue({
      name: 'Various',
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    await expect(built.service.getGenresForArtist('Various')).resolves.toEqual(['a', 'b', 'c', 'd']);
  });

  it('caches an empty result for ten minutes when nothing is found', async () => {
    const built = build();
    await expect(built.service.getGenresForArtist('Nobody')).resolves.toEqual([]);
    expect(built.artistGenreRepo.setForArtistId).not.toHaveBeenCalled();
    expect(built.cache.set).toHaveBeenCalledWith('genres:nobody', [], 600);
  });

  it('caches an empty result for ten minutes when the Last.fm call throws an UNCLASSIFIED error', async () => {
    // Deliberately narrower than it looks. `lastFmRepository` is contracted to
    // return null for a real "no such artist" and to RAISE for anything else,
    // so a bare Error reaching here is a defect in some other collaborator, not
    // a Last.fm verdict. The empty answer is a safe fallback for that; the
    // classified case below is the one that used to lie.
    const built = build();
    built.lastfmRepo.getArtistInfo.mockRejectedValue(new Error('lastfm down'));
    await expect(built.service.getGenresForArtist('Nobody')).resolves.toEqual([]);
    expect(built.cache.set).toHaveBeenCalledWith('genres:nobody', [], 600);
  });

  it('propagates a classified Last.fm outage and refuses to cache it as "no genres"', async () => {
    // The load-bearing one. `LastFmRepository.getArtistInfo` raises
    // LastFmUnavailableError precisely so nothing downstream can read a 5xx as
    // an artist with no tags. This catch used to swallow that, cache `[]` for
    // ten minutes, and return it - so `.genre Radiohead` would report that
    // Radiohead has no genres, and `genreCommands` branches on
    // `genres.length === 0` to decide whether the query was an artist at all,
    // so an outage would chart an ARTIST as a GENRE.
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    // The real shape, constructed through the same class the repository uses.
    const unavailable = new LastFmUnavailableError('artist.getinfo', new Error('Last.fm 5xx'));
    built.lastfmRepo.getArtistInfo.mockRejectedValue(unavailable);

    const err = await built.service.getGenresForArtist('Radiohead').catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    // The lie is the CACHE, not just the return value: a cached `[]` survives
    // the outage and keeps answering "no genres" for ten minutes after Last.fm
    // is healthy again.
    expect(built.cache.set).not.toHaveBeenCalledWith('genres:radiohead', [], 600);
    expect(error).toHaveBeenCalled();
  });
});

describe('GenreService.getGenresForArtistNames', () => {
  it('delegates to the repository and returns its map', async () => {
    const map = new Map([['radiohead', ['indie rock']]]);
    const built = build({ genresForNames: map });
    await expect(built.service.getGenresForArtistNames(['Radiohead'])).resolves.toBe(map);
    expect(built.artistGenreRepo.getForArtistNames).toHaveBeenCalledWith(['Radiohead']);
  });

  it('passes an empty name list straight through', async () => {
    const built = build();
    await expect(built.service.getGenresForArtistNames([])).resolves.toEqual(new Map());
    expect(built.artistGenreRepo.getForArtistNames).toHaveBeenCalledWith([]);
  });
});

describe('GenreService.getTopGenresForUserAllTime', () => {
  it('converts the bigint playcount column to a number', async () => {
    const built = build({
      queryRaw: [{ genreName: 'indie rock', userPlaycount: BigInt(1234) }],
    });
    await expect(built.service.getTopGenresForUserAllTime(1)).resolves.toEqual([
      { genreName: 'indie rock', userPlaycount: 1234 },
    ]);
  });

  it('raises instead of reporting "no genres" when the query fails', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    // The old code answered `[]` here, and `.topgenres` then rendered an empty
    // genre chart for a user who has thousands of plays. Indistinguishable from
    // the truth, and the user has no way to distrust it.
    const err = await built.service.getTopGenresForUserAllTime(1).catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getTopGenresForUserAllTime');
    expect(error).toHaveBeenCalled();
  });

  it('still returns an empty array when the query RAN and found no rows', async () => {
    // The other half of the pair, and the one a "just throw on error" fix
    // breaks. Every one of these is a GROUP BY aggregate: no matching rows is a
    // SUCCESS with a shorter result, so empty is the honest answer and must
    // stay a plain empty array - not an exception.
    const built = build({ queryRaw: [] });
    await expect(built.service.getTopGenresForUserAllTime(1)).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('GenreService.getTopGenresForTopArtists', () => {
  it('returns an empty array for an empty or missing artist list without querying', async () => {
    const built = build();
    await expect(built.service.getTopGenresForTopArtists([])).resolves.toEqual([]);
    await expect(built.service.getTopGenresForTopArtists(undefined as never)).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('sums artist playcounts per genre and sorts descending', async () => {
    const built = build({
      queryRaw: [
        { genre: 'indie rock', artistName: 'Radiohead' },
        { genre: 'indie rock', artistName: 'The Strokes' },
        { genre: 'dream pop', artistName: 'Radiohead' },
      ],
    });
    const result = await built.service.getTopGenresForTopArtists([
      { name: 'Radiohead', playcount: 10 },
      { name: 'The Strokes', playcount: 5 },
    ]);
    expect(result).toEqual([
      { genreName: 'indie rock', userPlaycount: 15, topArtists: ['Radiohead', 'The Strokes'] },
      { genreName: 'dream pop', userPlaycount: 10, topArtists: ['Radiohead'] },
    ]);
  });

  it('matches genres case-insensitively and trims both sides', async () => {
    const built = build({
      queryRaw: [{ genre: 'indie rock', artistName: '  radiohead  ' }],
    });
    const result = await built.service.getTopGenresForTopArtists([{ name: ' Radiohead ', playcount: 3 }]);
    expect(result).toEqual([{ genreName: 'indie rock', userPlaycount: 3, topArtists: [' Radiohead '] }]);
  });

  it('lists at most three artists per genre and never repeats one', async () => {
    const built = build({
      queryRaw: [
        { genre: 'indie', artistName: 'A' },
        { genre: 'indie', artistName: 'B' },
        { genre: 'indie', artistName: 'C' },
        { genre: 'indie', artistName: 'D' },
        { genre: 'indie', artistName: 'A' },
      ],
    });
    const result = await built.service.getTopGenresForTopArtists([
      { name: 'A', playcount: 1 },
      { name: 'B', playcount: 1 },
      { name: 'C', playcount: 1 },
      { name: 'D', playcount: 1 },
    ]);
    expect(result[0]?.topArtists).toEqual(['A', 'B', 'C']);
  });

  it('ignores a top artist that has no genre rows', async () => {
    const built = build({ queryRaw: [{ genre: 'indie', artistName: 'A' }] });
    const result = await built.service.getTopGenresForTopArtists([
      { name: 'A', playcount: 1 },
      { name: 'Untagged', playcount: 900 },
    ]);
    expect(result).toEqual([{ genreName: 'indie', userPlaycount: 1, topArtists: ['A'] }]);
  });

  it('applies the limit after sorting', async () => {
    const built = build({
      queryRaw: [
        { genre: 'a', artistName: 'X' },
        { genre: 'b', artistName: 'X' },
        { genre: 'c', artistName: 'X' },
      ],
    });
    const result = await built.service.getTopGenresForTopArtists([{ name: 'X', playcount: 1 }], 2);
    expect(result.map(r => r.genreName)).toEqual(['a', 'b']);
  });

  it('raises rather than rendering an empty top-genres chart', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    const err = await built.service
      .getTopGenresForTopArtists([{ name: 'A', playcount: 1 }])
      .catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getTopGenresForTopArtists');
  });

  it('still returns an empty array when the query ran and no artist is tagged', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getTopGenresForTopArtists([{ name: 'A', playcount: 1 }])).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('GenreService.getUserArtistsForGenre', () => {
  it('maps the rows and normalises the playcount', async () => {
    const built = build({
      queryRaw: [{ artistName: 'Radiohead', userPlaycount: BigInt(9) }],
    });
    await expect(built.service.getUserArtistsForGenre(1, 'indie rock')).resolves.toEqual([
      { artistName: 'Radiohead', userPlaycount: 9 },
    ]);
  });

  it('raises rather than reporting "no artists in this genre"', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    const err = await built.service.getUserArtistsForGenre(1, 'indie rock').catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getUserArtistsForGenre');
  });

  it('still returns an empty array when the query ran and the user has none', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getUserArtistsForGenre(1, 'indie rock')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('GenreService.getGuildTopGenresAllTime', () => {
  it('converts both bigint columns to numbers', async () => {
    const built = build({
      queryRaw: [{ genreName: 'indie rock', totalPlaycount: BigInt(500), listenerCount: BigInt(12) }],
    });
    await expect(built.service.getGuildTopGenresAllTime('123')).resolves.toEqual([
      { genreName: 'indie rock', totalPlaycount: 500, listenerCount: 12 },
    ]);
  });

  it('returns an empty array for a non-numeric guild id rather than throwing', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getGuildTopGenresAllTime('not-a-snowflake')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('raises rather than reporting a server where nobody listens to anything', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    // The worst shape in the file: an empty guild genre chart is a plausible,
    // confident, actionable answer. `genreService.db.test.ts` documents a REAL
    // production bug of exactly this shape in this very query.
    const err = await built.service.getGuildTopGenresAllTime('123').catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getGuildTopGenresAllTime');
  });

  it('still returns an empty array when the query ran and the guild has no genre rows', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getGuildTopGenresAllTime('123')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('GenreService.getGuildArtistsForGenre', () => {
  it('maps the rows and normalises the summed playcount', async () => {
    const built = build({
      queryRaw: [{ artistName: 'Radiohead', userPlaycount: BigInt(77) }],
    });
    await expect(built.service.getGuildArtistsForGenre('123', '  Indie Rock ')).resolves.toEqual([
      { artistName: 'Radiohead', userPlaycount: 77 },
    ]);
  });

  it('returns an empty array for a non-numeric guild id', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getGuildArtistsForGenre('abc', 'indie')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('raises rather than reporting "no artists in this genre"', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    const err = await built.service.getGuildArtistsForGenre('123', 'indie').catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getGuildArtistsForGenre');
  });

  it('still returns an empty array when the query ran and found no artists', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getGuildArtistsForGenre('123', 'indie')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('GenreService.getGuildUsersForGenre', () => {
  it('stringifies the bigint discord id and normalises the playcount', async () => {
    const built = build({
      queryRaw: [{
        userId: 5,
        discordUserId: BigInt('900000000000000001'),
        userNameLastFm: 'moha',
        playcount: BigInt(31),
      }],
    });
    await expect(built.service.getGuildUsersForGenre('123', 'indie rock')).resolves.toEqual([
      { userId: 5, discordUserId: '900000000000000001', userNameLastFm: 'moha', playcount: 31 },
    ]);
  });

  it('returns an empty array for a non-numeric guild id', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getGuildUsersForGenre('abc', 'indie')).resolves.toEqual([]);
  });

  it('raises rather than reporting that nobody in the server knows this genre', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    const err = await built.service.getGuildUsersForGenre('123', 'indie rock').catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getGuildUsersForGenre');
  });

  it('still returns an empty array when the query ran and nobody listens to it', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getGuildUsersForGenre('123', 'indie rock')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('GenreService.getFriendUsersForGenre', () => {
  it('queries for the user and every friend in one go and maps the rows', async () => {
    const built = build({
      queryRaw: [{
        userId: 5,
        discordUserId: BigInt('900000000000000001'),
        userNameLastFm: 'moha',
        playcount: BigInt(4),
      }],
    });
    await expect(built.service.getFriendUsersForGenre(5, [6, 7], 'indie rock')).resolves.toEqual([
      { userId: 5, discordUserId: '900000000000000001', userNameLastFm: 'moha', playcount: 4 },
    ]);
  });

  it('raises rather than reporting that no friend of yours knows this genre', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(DB_DOWN());

    const err = await built.service.getFriendUsersForGenre(5, [6], 'indie').catch((e: unknown) => e);
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('genreService.getFriendUsersForGenre');
  });

  it('still returns an empty array when the query ran and nobody does', async () => {
    const built = build({ queryRaw: [] });
    await expect(built.service.getFriendUsersForGenre(5, [6], 'indie')).resolves.toEqual([]);
    expect(built.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
