import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { AlbumService } from './albumService';
import { ColorService } from './colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The remaining AlbumService branches: caching, the DB-backed reads, the
 * playcount/time-listened math inside `searchAlbum`, and the autocomplete
 * queries.
 *
 * The pure parsers and the search grammar already have their own files; what
 * is left is where the service talks to Prisma, the cache and the container.
 * Those paths are almost entirely try/catch-and-degrade, so the interesting
 * assertions are the ones that prove the degradation: a rejected query must
 * still yield a usable result, never a throw.
 *
 * Same construction pattern as albumService.searchAlbum.test.ts: the service
 * is built by hand with doubles, and every double is a vi.fn so individual
 * tests can replace one behaviour without rebuilding the world.
 */

const user = { userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', totalPlayCount: 100 } as User;

const build = (over: Record<string, unknown> = {}, opts: { noColor?: boolean } = {}) => {
  const albumInfo = {
    name: 'OK Computer',
    artistName: 'Radiohead',
    imageUrl: 'https://img/cover.png',
    listeners: 100,
    playCount: 200,
    userPlayCount: 5,
    summary: 'A record.',
    tracks: [{ name: 'Airbag', durationSeconds: 284, url: 'u', rank: 1 }],
  };
  const deps: Record<string, unknown> = {
    lastfmRepository: {
      getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
      getTopAlbums: vi.fn(async () => []),
      searchAlbums: vi.fn(async () => []),
      getAlbumInfo: vi.fn(async () => albumInfo),
      getArtistInfo: vi.fn(async () => null),
    },
    artistRepository: { getOrCreateArtist: vi.fn(async (n: string) => ({ artistId: 1, name: n })) },
    albumRepository: {
      getOrCreateAlbum: vi.fn(async (n: string) => ({ albumId: 1, name: n, releaseDate: null })),
      setReleaseData: vi.fn(async () => undefined),
      getAlbumById: vi.fn(async () => null),
    },
    userRepository: {},
    guildUserRepository: { getUserIdsForGuild: vi.fn(async () => []) },
    artworkService: { getAlbumCoverUrl: vi.fn(async () => 'https://img/final.png') },
    spotifyApi: {
      searchAndGetFullAlbum: vi.fn(async () => null),
      getAlbumTrackNames: vi.fn(async () => []),
    },
    prisma: {
      artist: { findUnique: vi.fn(async () => null) },
      user: { findFirst: vi.fn(async () => null) },
      album: { findMany: vi.fn(async () => []) },
      userPlay: {
        groupBy: vi.fn(async () => []),
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => []),
      },
      $queryRawUnsafe: vi.fn(async () => []),
    },
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    colorService: { getColorFromImageUrl: vi.fn(async () => 0x123456) },
    ...over,
  };
  const service = new AlbumService(
    deps.lastfmRepository as never,
    deps.artistRepository as never,
    deps.albumRepository as never,
    deps.userRepository as never,
    deps.guildUserRepository as never,
    deps.artworkService as never,
    deps.spotifyApi as never,
    deps.prisma as never,
    deps.cache as never,
    opts.noColor ? undefined : (deps.colorService as never),
  );
  return { service, deps };
};

// One `as any` at the boundary, so 48 call sites can reach .count/.groupBy/
// .$queryRawUnsafe without each spelling out its mock shape. Warn-only rule.
const mockOf = (fn: unknown) => fn as any;

describe('AlbumService.getAlbumInfo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the cached entry without calling the repository', async () => {
    const { service, deps } = build();
    const cached = { name: 'Cached', artistName: 'Artist' } as never;
    mockOf(deps.cache).get.mockResolvedValue(cached);

    await expect(service.getAlbumInfo('Artist', 'Cached', 'DreadRock')).resolves.toBe(cached);
    expect(mockOf(deps.lastfmRepository).getAlbumInfo).not.toHaveBeenCalled();
    expect(mockOf(deps.cache).set).not.toHaveBeenCalled();
  });

  it('caches the repository result under a lowercased key for an hour', async () => {
    const { service, deps } = build();

    const r = await service.getAlbumInfo('Radiohead', 'OK Computer', 'DreadRock');

    expect(r?.name).toBe('OK Computer');
    expect(mockOf(deps.cache).set).toHaveBeenCalledWith(
      'album-info:radiohead:ok computer:dreadrock',
      expect.anything(),
      3600,
    );
  });

  it('does not cache a null result', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).getAlbumInfo.mockResolvedValue(null);

    await expect(service.getAlbumInfo('Radiohead', 'Nope')).resolves.toBeNull();
    expect(mockOf(deps.cache).set).not.toHaveBeenCalled();
  });
});

describe('AlbumService.searchAlbums', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates the query straight to the repository', async () => {
    const { service, deps } = build();
    const found = [{ name: 'Dummy', artistName: 'Portishead', playcount: 3 }] as never;
    mockOf(deps.lastfmRepository).searchAlbums.mockResolvedValue(found);

    await expect(service.searchAlbums('portishead')).resolves.toBe(found);
    expect(mockOf(deps.lastfmRepository).searchAlbums).toHaveBeenCalledWith('portishead');
  });
});

describe('AlbumService.getAlbumById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when the album is not in the database', async () => {
    const { service } = build();
    await expect(service.getAlbumById(999)).resolves.toBeNull();
  });

  it('maps the album and artist names onto the result', async () => {
    const { service, deps } = build();
    mockOf(deps.albumRepository).getAlbumById.mockResolvedValue({ albumId: 7, name: 'OK Computer', artistId: 3 });
    mockOf(deps.prisma).artist.findUnique.mockResolvedValue({ artistId: 3, name: 'Radiohead' });

    await expect(service.getAlbumById(7)).resolves.toEqual({
      albumName: 'OK Computer',
      artistName: 'Radiohead',
      albumId: 7,
    });
  });

  it('returns an empty artist name when the artist row is missing', async () => {
    // An orphan album row must not throw; the embed just shows no artist link.
    const { service, deps } = build();
    mockOf(deps.albumRepository).getAlbumById.mockResolvedValue({ albumId: 7, name: 'OK Computer', artistId: 3 });
    mockOf(deps.prisma).artist.findUnique.mockResolvedValue(null);

    const r = await service.getAlbumById(7);
    expect(r?.artistName).toBe('');
  });
});

describe('AlbumService.searchAlbum candidate selection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the candidate whose artist AND album both appear in the query', async () => {
    // The "future future" shape: the first result is the popular wrong answer.
    // Taking matches[0] would attribute the album to the wrong artist.
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).searchAlbums.mockResolvedValue([
      { name: 'Future', artistName: 'Don', playcount: 50 },
      { name: 'Future', artistName: 'Future', playcount: 1 },
    ]);

    await service.searchAlbum('future future', user);

    const info = mockOf(deps.lastfmRepository).getAlbumInfo;
    expect(info.mock.calls[0]?.[0]).toBe('Future');
    expect(info.mock.calls[0]?.[1]).toBe('Future');
  });
});

describe('AlbumService.searchAlbum playcount and listening time', () => {
  beforeEach(() => vi.clearAllMocks());

  it('overrides the Last.fm playcount with a higher DB count', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(10);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userPlaycount).toBe(10);
  });

  it('keeps the Last.fm playcount when the DB count is lower', async () => {
    // The DB is a subset of Last.fm history, so a lower count is not an
    // override - it would under-report a user's plays.
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(2);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userPlaycount).toBe(5);
  });

  it('reports monthly plays when there are any', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockResolvedValueOnce(10).mockResolvedValueOnce(3);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userPlaycount).toBe(10);
    expect(r?.userMonthlyPlaycount).toBe(3);
  });

  it('computes time listened from per-track plays and durations', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(0);
    mockOf(deps.prisma).userPlay.groupBy.mockResolvedValue([
      { trackName: 'Airbag', _count: { trackName: 2 } },
    ]);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userTimeListenedSeconds).toBe(568);
  });

  it('falls back to average track duration when per-track plays are unknown', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(0);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userTimeListenedSeconds).toBe(1420);
  });

  it('estimates 3.5 minutes per play when the album has no tracklist', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).getAlbumInfo.mockResolvedValue({
      name: 'OK Computer',
      artistName: 'Radiohead',
      userPlayCount: 5,
      tracks: [],
    });
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(0);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userTimeListenedSeconds).toBe(1050);
  });

  it('computes the user percentage of all plays', async () => {
    const { service } = build();

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.userPercentageOfAllPlays).toBe(5);
  });

  it('attaches per-track playcounts from the database', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(0);
    mockOf(deps.prisma).userPlay.groupBy.mockResolvedValue([
      { trackName: 'Airbag', _count: { trackName: 7 } },
    ]);

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r?.tracks?.[0]?.playcount).toBe(7);
  });
});

describe('AlbumService.searchAlbum release data and server stats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists Spotify release data when the DB row has none', async () => {
    const { service, deps } = build({
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => ({
          release_date: '1997-05-21',
          release_date_precision: 'day',
          album_type: 'album',
          tracks: { items: [] },
        })),
      },
    });

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(mockOf(deps.albumRepository).setReleaseData).toHaveBeenCalledWith(1, {
      releaseDate: new Date(Date.UTC(1997, 4, 21)),
      releaseDatePrecision: 'day',
      spotifyAlbumType: 'album',
    });
    expect(r?.releaseDate?.toISOString().slice(0, 10)).toBe('1997-05-21');
  });

  it('does not overwrite release data the DB row already has', async () => {
    const { service, deps } = build({
      albumRepository: {
        getOrCreateAlbum: vi.fn(async (n: string) => ({
          albumId: 1,
          name: n,
          releaseDate: new Date(Date.UTC(1995, 0, 1)),
        })),
        setReleaseData: vi.fn(async () => undefined),
      },
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => ({
          release_date: '1997-05-21',
          release_date_precision: 'day',
          album_type: 'album',
          tracks: { items: [] },
        })),
      },
    });

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(mockOf(deps.albumRepository).setReleaseData).not.toHaveBeenCalled();
    expect(r?.releaseDate?.toISOString().slice(0, 10)).toBe('1995-01-01');
  });

  it('reports server playcount and listeners when a guild is given', async () => {
    const { service, deps } = build();
    mockOf(deps.guildUserRepository).getUserIdsForGuild.mockResolvedValue([1, 2]);
    mockOf(deps.prisma).userPlay.findMany.mockResolvedValue([{ userId: 1 }, { userId: 1 }, { userId: 2 }]);

    const r = await service.searchAlbum('Radiohead | OK Computer', user, 'guild-1');

    expect(r?.serverPlaycount).toBe(3);
    expect(r?.serverListeners).toBe(2);
  });

  it('leaves server stats undefined when the guild has no linked users', async () => {
    const { service } = build();

    const r = await service.searchAlbum('Radiohead | OK Computer', user, 'guild-1');

    expect(r?.serverPlaycount).toBeUndefined();
    expect(r?.serverListeners).toBeUndefined();
  });

  it('still returns the result when the stats query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.count.mockRejectedValue(new Error('db down'));

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r).not.toBeNull();
    expect(r?.userPlaycount).toBe(5);
  });

  it('still returns the result when the track playcount query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).userPlay.groupBy.mockRejectedValue(new Error('db down'));

    const r = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(r).not.toBeNull();
    expect(r?.tracks?.[0]?.playcount).toBeUndefined();
  });
});

describe('AlbumService.fillMissingAlbumCovers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the same array untouched when every album already has a cover', async () => {
    const { service, deps } = build();
    const albums = [{ name: 'A', artistName: 'X', playcount: 1, imageUrl: 'https://img/a.png' }];

    const r = await service.fillMissingAlbumCovers(albums);

    expect(r).toBe(albums);
    expect(mockOf(deps.artworkService).getAlbumCoverUrl).not.toHaveBeenCalled();
  });

  it('fills covers only for albums that are missing one', async () => {
    const { service, deps } = build();
    const albums = [
      { name: 'A', artistName: 'X', playcount: 2 },
      { name: 'B', artistName: 'Y', playcount: 1, imageUrl: 'https://img/b.png' },
    ];
    mockOf(deps.artworkService).getAlbumCoverUrl.mockResolvedValue('https://img/a.png');

    const r = await service.fillMissingAlbumCovers(albums);

    expect(r[0]?.imageUrl).toBe('https://img/a.png');
    expect(r[1]?.imageUrl).toBe('https://img/b.png');
    expect(mockOf(deps.artworkService).getAlbumCoverUrl).toHaveBeenCalledTimes(1);
  });

  it('ignores artwork failures for individual albums', async () => {
    const { service, deps } = build();
    const albums = [{ name: 'A', artistName: 'X', playcount: 1 }];
    mockOf(deps.artworkService).getAlbumCoverUrl.mockRejectedValue(new Error('art down'));

    const r = await service.fillMissingAlbumCovers(albums);

    expect(r[0]?.imageUrl).toBeUndefined();
  });
});

describe('AlbumService.getUserAllTimeTopAlbums', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the cache when useCache is set and an entry exists', async () => {
    const { service, deps } = build();
    const cached = [{ name: 'A', artistName: 'X', playcount: 1 }] as never;
    mockOf(deps.cache).get.mockResolvedValue(cached);

    await expect(service.getUserAllTimeTopAlbums(1, true)).resolves.toBe(cached);
    expect(mockOf(deps.prisma).$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('maps raw rows, converting bigint playcounts to numbers', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).$queryRawUnsafe.mockResolvedValue([
      { album_name: 'OK Computer', artist_name: 'Radiohead', playcount: 3n },
    ]);

    const r = await service.getUserAllTimeTopAlbums(1);

    expect(r).toEqual([{ name: 'OK Computer', artistName: 'Radiohead', playcount: 3 }]);
  });

  it('caches the result only when the list is longer than 100 albums', async () => {
    const { service, deps } = build();
    const rows = Array.from({ length: 101 }, (_, i) => ({
      album_name: `Album ${i}`,
      artist_name: 'X',
      playcount: BigInt(i),
    }));
    mockOf(deps.prisma).$queryRawUnsafe.mockResolvedValue(rows);

    await service.getUserAllTimeTopAlbums(1);

    expect(mockOf(deps.cache).set).toHaveBeenCalledWith('user-1-topalbums-alltime', expect.anything(), 600);
  });

  it('does not cache a short list', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).$queryRawUnsafe.mockResolvedValue([
      { album_name: 'A', artist_name: 'X', playcount: 1n },
    ]);

    await service.getUserAllTimeTopAlbums(1);

    expect(mockOf(deps.cache).set).not.toHaveBeenCalled();
  });

  it('returns an empty list when the query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).$queryRawUnsafe.mockRejectedValue(new Error('db down'));

    await expect(service.getUserAllTimeTopAlbums(1)).resolves.toEqual([]);
  });
});

describe('AlbumService.getTopTracksForAlbum', () => {
  beforeEach(() => vi.clearAllMocks());

  it("sorts album tracks by the caller's playcount, ties keeping tracklist order", async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).getAlbumInfo.mockResolvedValue({
      name: 'OK Computer',
      artistName: 'Radiohead',
      tracks: [
        { name: 'Airbag', rank: 1 },
        { name: 'Karma Police', rank: 2 },
        { name: 'Subterranean Homesick Alien', rank: 3 },
      ],
    });
    mockOf(deps.prisma).userPlay.groupBy.mockResolvedValue([
      { trackName: 'Karma Police', _count: { trackName: 9 } },
      { trackName: 'Airbag', _count: { trackName: 4 } },
      { trackName: 'Subterranean Homesick Alien', _count: { trackName: 4 } },
    ]);

    const r = await service.getTopTracksForAlbum('Radiohead', 'OK Computer', 3, 1);

    expect(r).toEqual(['Karma Police', 'Airbag', 'Subterranean Homesick Alien']);
  });

  it('sorts by global plays when no user is given', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).getAlbumInfo.mockResolvedValue({
      name: 'OK Computer',
      artistName: 'Radiohead',
      tracks: [{ name: 'Airbag' }, { name: 'Karma Police' }],
    });
    mockOf(deps.prisma).userPlay.groupBy.mockResolvedValue([
      { trackName: 'Karma Police', _count: { trackName: 2 } },
    ]);

    const r = await service.getTopTracksForAlbum('Radiohead', 'OK Computer', 2);

    expect(r).toEqual(['Karma Police', 'Airbag']);
  });

  it('falls back to a raw plays query when the album has no tracklist', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).getAlbumInfo.mockResolvedValue(null);
    mockOf(deps.spotifyApi).getAlbumTrackNames.mockResolvedValue([]);
    mockOf(deps.prisma).$queryRawUnsafe.mockResolvedValue([
      { track_name: 'Airbag', playcount: 5n },
      { track_name: 'Karma Police', playcount: 3n },
    ]);

    const r = await service.getTopTracksForAlbum('Radiohead', 'OK Computer', 3, 1);

    expect(r).toEqual(['Airbag', 'Karma Police']);
  });

  it('returns an empty list when resolution fails', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepository).getAlbumInfo.mockResolvedValue(null);
    mockOf(deps.spotifyApi).getAlbumTrackNames.mockRejectedValue(new Error('spotify down'));

    await expect(service.getTopTracksForAlbum('Radiohead', 'OK Computer')).resolves.toEqual([]);
  });
});

describe('AlbumService.getUserAllTimeTopAlbumsByReleasePrefix', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps rows including release date and album type', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).$queryRawUnsafe.mockResolvedValue([
      {
        album_name: 'OK Computer',
        artist_name: 'Radiohead',
        playcount: 4n,
        release_date: new Date(Date.UTC(1997, 4, 21)),
        album_type: 'album',
      },
    ]);

    const r = await service.getUserAllTimeTopAlbumsByReleasePrefix(1, '1997');

    expect(r).toEqual([
      {
        name: 'OK Computer',
        artistName: 'Radiohead',
        playcount: 4,
        releaseDate: new Date(Date.UTC(1997, 4, 21)),
        albumType: 'album',
      },
    ]);
  });

  it('falls back to the in-memory list when the prefix query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).$queryRawUnsafe
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue([{ album_name: 'A', artist_name: 'X', playcount: 1n }]);

    const r = await service.getUserAllTimeTopAlbumsByReleasePrefix(1, '1997');

    expect(r).toEqual([{ name: 'A', artistName: 'X', playcount: 1 }]);
  });
});

describe('AlbumService.filterAlbumsToReleasePeriod', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps only albums whose release date falls in the period', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).album.findMany.mockResolvedValue([
      { name: 'OK Computer', artist: { name: 'Radiohead' } },
    ]);

    const r = await service.filterAlbumsToReleasePeriod(
      [
        { artistName: 'Radiohead', albumName: 'OK Computer' },
        { artistName: 'Radiohead', albumName: 'Kid A' },
      ],
      new Date(Date.UTC(1997, 0, 1)),
      new Date(Date.UTC(1998, 0, 1)),
    );

    expect(r).toEqual([{ artistName: 'Radiohead', albumName: 'OK Computer' }]);
  });

  it('returns the input unchanged when the query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).album.findMany.mockRejectedValue(new Error('db down'));
    const albums = [{ artistName: 'Radiohead', albumName: 'OK Computer' }];

    await expect(
      service.filterAlbumsToReleasePeriod(albums, new Date(Date.UTC(1997, 0, 1)), new Date(Date.UTC(1998, 0, 1))),
    ).resolves.toBe(albums);
  });
});

describe('AlbumService.getAlbumAccentColor', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('resolves the accent color from the cover when one is available', async () => {
    const { service, deps } = build();

    await expect(service.getAlbumAccentColor('https://img/cover.png')).resolves.toBe(0x123456);
    expect(mockOf(deps.colorService).getColorFromImageUrl).toHaveBeenCalledWith('https://img/cover.png');
  });

  it('resolves the color service from the container when none was injected', async () => {
    const { service, deps } = build({}, { noColor: true });
    const spy = vi.spyOn(container, 'resolve').mockReturnValue(deps.colorService as never);

    await expect(service.getAlbumAccentColor('https://img/cover.png')).resolves.toBe(0x123456);
    expect(spy).toHaveBeenCalledWith(ColorService);
  });

  it('returns the Last.fm red when color resolution throws', async () => {
    // The catch is around the call itself, so it covers a synchronous throw
    // (a null service, a throwing container.resolve). An async rejection from
    // getColorFromImageUrl propagates - that is the production behaviour.
    const { service, deps } = build();
    mockOf(deps.colorService).getColorFromImageUrl.mockImplementation(() => {
      throw new Error('color down');
    });

    await expect(service.getAlbumAccentColor('https://img/cover.png')).resolves.toBe(DiscordConstants.LastFmColorRed);
  });

  it('returns the Last.fm red when there is no cover', async () => {
    const { service, deps } = build();

    await expect(service.getAlbumAccentColor(undefined)).resolves.toBe(DiscordConstants.LastFmColorRed);
    await expect(service.getAlbumAccentColor(null)).resolves.toBe(DiscordConstants.LastFmColorRed);
    expect(mockOf(deps.colorService).getColorFromImageUrl).not.toHaveBeenCalled();
  });
});

describe('AlbumService.getAlbumReleaseDate', () => {
  it('returns null when there is no release date', () => {
    expect(AlbumService.getAlbumReleaseDate({})).toBeNull();
    expect(AlbumService.getAlbumReleaseDate({ releaseDate: null })).toBeNull();
  });

  it('returns null for an unparseable date string', () => {
    // An Invalid Date rendered in an embed is the "NaN" class of bug.
    expect(AlbumService.getAlbumReleaseDate({ releaseDate: 'not-a-date' })).toBeNull();
  });

  it('formats a year-precision date as just the year', () => {
    expect(
      AlbumService.getAlbumReleaseDate({
        releaseDate: new Date(Date.UTC(1997, 4, 21)),
        releaseDatePrecision: 'year',
      }),
    ).toBe('`1997`');
  });

  it('formats a month-precision date as month and year', () => {
    expect(
      AlbumService.getAlbumReleaseDate({
        releaseDate: new Date(Date.UTC(1997, 4, 21)),
        releaseDatePrecision: 'month',
      }),
    ).toBe('May 1997');
  });

  it('formats a day-precision date as a Discord timestamp', () => {
    const d = new Date(Date.UTC(1997, 4, 21));
    const epoch = Math.floor(d.getTime() / 1000);
    expect(AlbumService.getAlbumReleaseDate({ releaseDate: d, releaseDatePrecision: 'day' })).toBe(`<t:${epoch}:D>`);
  });

  it('accepts a date string and defaults to day precision', () => {
    const d = new Date(Date.UTC(1997, 4, 21));
    const epoch = Math.floor(d.getTime() / 1000);
    expect(AlbumService.getAlbumReleaseDate({ releaseDate: '1997-05-21T00:00:00.000Z' })).toBe(`<t:${epoch}:D>`);
  });
});

describe('AlbumService.getLatestAlbums', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the cache when enabled and an entry exists', async () => {
    const { service, deps } = build();
    const cached = [{ artistName: 'Radiohead', albumName: 'OK Computer' }] as never;
    mockOf(deps.cache).get.mockResolvedValue(cached);

    await expect(service.getLatestAlbums('123')).resolves.toBe(cached);
    expect(mockOf(deps.prisma).user.findFirst).not.toHaveBeenCalled();
  });

  it('returns an empty list when the discord user is not registered', async () => {
    const { service } = build();

    await expect(service.getLatestAlbums('unknown')).resolves.toEqual([]);
  });

  it('dedupes albums case-insensitively and caches the result for 30 seconds', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).user.findFirst.mockResolvedValue({ userId: 1 });
    mockOf(deps.prisma).userPlay.findMany.mockResolvedValue([
      { artistName: 'Radiohead', albumName: 'OK Computer' },
      { artistName: 'Radiohead', albumName: 'ok computer' },
      { artistName: 'Radiohead', albumName: 'Kid A' },
    ]);

    const r = await service.getLatestAlbums('123');

    expect(r).toEqual([
      { artistName: 'Radiohead', albumName: 'OK Computer' },
      { artistName: 'Radiohead', albumName: 'Kid A' },
    ]);
    expect(mockOf(deps.cache).set).toHaveBeenCalledWith('user-recent-albums-123', expect.anything(), 30);
  });

  it('returns an empty list when the query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).user.findFirst.mockRejectedValue(new Error('db down'));

    await expect(service.getLatestAlbums('123')).resolves.toEqual([]);
  });
});

describe('AlbumService.getRecentTopAlbums', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the cache when enabled and an entry exists', async () => {
    const { service, deps } = build();
    const cached = [{ artistName: 'Radiohead', albumName: 'OK Computer' }] as never;
    mockOf(deps.cache).get.mockResolvedValue(cached);

    await expect(service.getRecentTopAlbums('123')).resolves.toBe(cached);
    expect(mockOf(deps.prisma).$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns an empty list when the discord user is not registered', async () => {
    const { service } = build();

    await expect(service.getRecentTopAlbums('unknown')).resolves.toEqual([]);
  });

  it('maps the raw rows and caches them for 120 seconds', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).user.findFirst.mockResolvedValue({ userId: 1 });
    mockOf(deps.prisma).$queryRawUnsafe.mockResolvedValue([
      { artist_name: 'Radiohead', album_name: 'OK Computer', playcount: 3n },
    ]);

    const r = await service.getRecentTopAlbums('123');

    expect(r).toEqual([{ artistName: 'Radiohead', albumName: 'OK Computer' }]);
    expect(mockOf(deps.cache).set).toHaveBeenCalledWith('user-recent-top-albums-123', expect.anything(), 120);
  });

  it('returns an empty list when the query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).user.findFirst.mockRejectedValue(new Error('db down'));

    await expect(service.getRecentTopAlbums('123')).resolves.toEqual([]);
  });
});

describe('AlbumService.searchThroughAlbums', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty list for a blank query without hitting the database', async () => {
    const { service, deps } = build();

    await expect(service.searchThroughAlbums('')).resolves.toEqual([]);
    await expect(service.searchThroughAlbums('   ')).resolves.toEqual([]);
    expect(mockOf(deps.prisma).album.findMany).not.toHaveBeenCalled();
  });

  it('maps the catalog rows', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).album.findMany.mockResolvedValue([
      { name: 'OK Computer', artist: { name: 'Radiohead' } },
    ]);

    const r = await service.searchThroughAlbums('ok comp');

    expect(r).toEqual([{ artistName: 'Radiohead', albumName: 'OK Computer' }]);
  });

  it('returns an empty list when the query fails', async () => {
    const { service, deps } = build();
    mockOf(deps.prisma).album.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.searchThroughAlbums('ok comp')).resolves.toEqual([]);
  });
});
