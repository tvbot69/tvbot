import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from 'tsyringe';
import { GenreService } from './genreService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { LastfmApi } from '@lastfm/api/lastfmApi';

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

  it('caches an empty result for ten minutes when Last.fm itself throws', async () => {
    const built = build();
    built.lastfmRepo.getArtistInfo.mockRejectedValue(new Error('lastfm down'));
    await expect(built.service.getGenresForArtist('Nobody')).resolves.toEqual([]);
    expect(built.cache.set).toHaveBeenCalledWith('genres:nobody', [], 600);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getTopGenresForUserAllTime(1)).resolves.toEqual([]);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getTopGenresForTopArtists([{ name: 'A', playcount: 1 }])).resolves.toEqual([]);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getUserArtistsForGenre(1, 'indie rock')).resolves.toEqual([]);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getGuildTopGenresAllTime('123')).resolves.toEqual([]);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getGuildArtistsForGenre('123', 'indie')).resolves.toEqual([]);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getGuildUsersForGenre('123', 'indie')).resolves.toEqual([]);
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

  it('returns an empty array when the query fails', async () => {
    const built = build();
    built.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(built.service.getFriendUsersForGenre(5, [], 'indie')).resolves.toEqual([]);
  });
});
