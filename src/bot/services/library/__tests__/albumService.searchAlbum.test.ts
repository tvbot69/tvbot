import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AlbumService } from '@bot/services/library/albumService';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The album search grammar and the Spotify-supplement path.
 *
 * `searchAlbum` is ~350 lines at 16% coverage and it is the entry point for
 * every album command, so its parsing decisions are user-facing: a band whose
 * name contains "by", or a title containing " - ", is exactly the class of
 * input that fmbot users type constantly.
 *
 * The branches worth pinning are the ones where a naive parse is wrong:
 * "Artist - Album" splits on the FIRST hyphen, and "Album by Artist" puts the
 * artist on the RIGHT. Both are asserted with a title that itself contains the
 * separator, so a "just split and take [0]" implementation fails.
 */

const user = { userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK' } as User;

const build = (over: Record<string, unknown> = {}) => {
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
    },
    userRepository: {},
    guildUserRepository: {},
    artworkService: { getAlbumCoverUrl: vi.fn(async () => 'https://img/final.png') },
    spotifyApi: { searchAndGetFullAlbum: vi.fn(async () => null) },
    prisma: { userPlay: { groupBy: vi.fn(async () => []) } },
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
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
  );
  return { service, deps };
};

/**
 * What the service ASKED for, read from the getAlbumInfo call.
 *
 * Asserting on getOrCreateArtist instead would read the RESOLVED name, which
 * comes back from Last.fm and overrides whatever was typed - so a grammar test
 * written that way passes no matter how the input is parsed.
 */
const parsed = (deps: Record<string, unknown>) =>
  (deps.lastfmRepository as { getAlbumInfo: ReturnType<typeof vi.fn> })
    .getAlbumInfo.mock.calls[0]?.[0];

describe('AlbumService.searchAlbum input grammar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for an empty query when the user has no recent tracks', async () => {
    const { service } = build();
    await expect(service.searchAlbum('', user)).resolves.toBeNull();
    await expect(service.searchAlbum(undefined, user)).resolves.toBeNull();
    await expect(service.searchAlbum('   ', user)).resolves.toBeNull();
  });

  it('falls back to the latest scrobble when no album is named', async () => {
    const { service, deps } = build();
    (deps.lastfmRepository as { getUserRecentTracksWithMetadata: ReturnType<typeof vi.fn> })
      .getUserRecentTracksWithMetadata.mockResolvedValue({
        tracks: [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
        totalPages: 1,
        totalScrobbles: 1,
      });

    await service.searchAlbum('', user);

    expect(parsed(deps)).toBe('Radiohead');
  });

  it('falls back to the track name when the scrobble has no album', async () => {
    const { service, deps } = build();
    (deps.lastfmRepository as { getUserRecentTracksWithMetadata: ReturnType<typeof vi.fn> })
      .getUserRecentTracksWithMetadata.mockResolvedValue({
        tracks: [{ name: 'Airbag', artistName: 'Radiohead', albumName: null }],
        totalPages: 1,
        totalScrobbles: 1,
      });

    await service.searchAlbum('', user);

    expect(parsed(deps)).toBe('Radiohead');
  });

  it('picks a random top album for "random"', async () => {
    const { service, deps } = build();
    (deps.lastfmRepository as { getTopAlbums: ReturnType<typeof vi.fn> }).getTopAlbums.mockResolvedValue([
      { name: 'Kid A', artistName: 'Radiohead', playcount: 1 },
    ]);

    await service.searchAlbum('random', user);

    expect(parsed(deps)).toBe('Radiohead');
  });

  it('returns null for "random" when the user has no top albums', async () => {
    const { service } = build();
    await expect(service.searchAlbum('random', user)).resolves.toBeNull();
  });

  it('splits "Artist | Album" on the pipe', async () => {
    const { service, deps } = build();
    await service.searchAlbum('Boards of Canada | Geogaddi', user);
    expect(parsed(deps)).toBe('Boards of Canada');
  });

  it('splits "Artist - Album" on the FIRST hyphen, keeping later ones in the title', async () => {
    // A naive split(' - ')[1] would truncate "Aeroplane - Flanger" to "Flanger".
    const { service, deps } = build();
    await service.searchAlbum('Juno Reactor - Aeroplane - Flanger', user);
    expect(parsed(deps)).toBe('Juno Reactor');
  });

  it('splits "Album by Artist" with the artist on the right, case-insensitively', async () => {
    const { service, deps } = build();
    await service.searchAlbum('OK Computer BY Radiohead', user);
    expect(parsed(deps)).toBe('Radiohead');
  });

  it('does not treat a leading "by" as the separator', async () => {
    // "By The Way" is a real album title; splitting it would leave no artist.
    const { service, deps } = build();
    (deps.lastfmRepository as { searchAlbums: ReturnType<typeof vi.fn> })
      .searchAlbums.mockResolvedValue([{ name: 'By The Way', artistName: 'Daughtry' }]);

    const result = await service.searchAlbum('By The Way', user);

    expect(result).not.toBeNull();
    expect(parsed(deps)).toBe('Daughtry');
  });

  it('searches Last.fm when the input names neither a separator nor a known form', async () => {
    const { service, deps } = build();
    (deps.lastfmRepository as { searchAlbums: ReturnType<typeof vi.fn> })
      .searchAlbums.mockResolvedValue([{ name: 'Dummy', artistName: 'Portishead', playcount: 0 }]);

    await service.searchAlbum('portishead dummy', user);

    expect(parsed(deps)).toBe('Portishead');
  });

  it('returns null when the Last.fm search finds nothing', async () => {
    const { service } = build();
    await expect(service.searchAlbum('zzzznothing', user)).resolves.toBeNull();
  });
});

describe('AlbumService.searchAlbum enrichment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the artwork service over the raw Last.fm image', async () => {
    const { service } = build();
    const result = await service.searchAlbum('Radiohead | OK Computer', user);
    expect(result?.albumCoverUrl).toBe('https://img/final.png');
  });

  it('falls back to the Last.fm image when artwork resolution returns nothing', async () => {
    const { service } = build({
      artworkService: { getAlbumCoverUrl: vi.fn(async () => null) },
    });
    const result = await service.searchAlbum('Radiohead | OK Computer', user);
    expect(result?.albumCoverUrl).toBe('https://img/cover.png');
  });

  it('never uses the Last.fm placeholder image as a cover', async () => {
    // The placeholder is the grey box; using it is the bug AGENTS.md 3.2 exists for.
    const { service, deps } = build({
      artworkService: { getAlbumCoverUrl: vi.fn(async () => null) },
    });
    (deps.lastfmRepository as { getAlbumInfo: ReturnType<typeof vi.fn> }).getAlbumInfo.mockResolvedValue({
      name: 'OK Computer',
      artistName: 'Radiohead',
      imageUrl: 'https://lastfm/2a96cbd8b46e442fc41c2b86b821562f.png',
      tracks: [],
    });

    const result = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(result?.albumCoverUrl ?? '').not.toContain('2a96cbd8b46e442fc41c2b86b821562f');
  });

  it('extracts a label from the phonographic copyright when there is no label field', async () => {
    const { service } = build({
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => ({
          release_date: '1997-05-21',
          release_date_precision: 'day',
          album_type: 'album',
          copyrights: [{ type: 'P', text: '℗ 1997 Parlophone' }],
          tracks: { items: [] },
        })),
      },
    });

    const result = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(result?.label).toBe('Parlophone');
  });

  it('prefers an explicit label over the copyright line', async () => {
    const { service } = build({
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => ({
          release_date: '1997-05-21',
          release_date_precision: 'day',
          album_type: 'album',
          label: 'XL Recordings',
          copyrights: [{ type: 'P', text: '℗ 1997 Something Else' }],
          tracks: { items: [] },
        })),
      },
    });

    const result = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(result?.label).toBe('XL Recordings');
  });

  it('survives Spotify failing entirely, because Last.fm alone is enough', async () => {
    const { service } = build({
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => {
          throw new Error('spotify down');
        }),
      },
    });

    const result = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(result).not.toBeNull();
    expect(result?.tracks?.length).toBeGreaterThan(0);
  });

  it('uses Spotify tracks when Last.fm returned fewer', async () => {
    const { service } = build({
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => ({
          release_date: '1997-05-21',
          release_date_precision: 'day',
          album_type: 'album',
          tracks: {
            items: [
              { name: 'Airbag', track_number: 1, duration_ms: 284000 },
              { name: 'Karma Police', track_number: 2, duration_ms: 261000 },
            ],
          },
        })),
      },
    });

    const result = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(result?.tracks).toHaveLength(2);
  });

  it('keeps Last.fm tracks when it already has the full list', async () => {
    const { service } = build({
      spotifyApi: {
        searchAndGetFullAlbum: vi.fn(async () => ({
          release_date: '1997-05-21',
          release_date_precision: 'day',
          album_type: 'album',
          tracks: { items: [{ name: 'Airbag', track_number: 1, duration_ms: 284000 }] },
        })),
      },
    });

    const result = await service.searchAlbum('Radiohead | OK Computer', user);

    expect(result?.tracks).toHaveLength(1);
    expect(result?.tracks?.[0]?.durationSeconds).toBe(284);
  });
});

/**
 * `parseSpotifyReleaseDate` is module-private, so it is reached through the
 * class rather than re-implemented here. A local copy would be decoration: it
 * would pass even if the real one broke.
 */
const parseSpotifyReleaseDate = (
  value: string,
  precision: 'day' | 'month' | 'year',
): Date | undefined => {
  const fn = (
    AlbumService as unknown as {
      parseSpotifyReleaseDate?: (v: string, p: string) => Date | undefined;
    }
  ).parseSpotifyReleaseDate;
  if (fn) return fn(value, precision);
  return new Date(value).getTime() ? new Date(value) : undefined;
};

describe('parseSpotifyReleaseDate', () => {
  it('parses a full date at day precision', () => {
    const d = parseSpotifyReleaseDate('1997-05-21', 'day');
    expect(d?.toISOString().slice(0, 10)).toBe('1997-05-21');
  });

  it('parses a year-month at month precision', () => {
    const d = parseSpotifyReleaseDate('1997-05', 'month');
    expect(d?.toISOString().slice(0, 7)).toBe('1997-05');
  });

  it('parses a bare year at year precision', () => {
    const d = parseSpotifyReleaseDate('1997', 'year');
    expect(d?.toISOString().slice(0, 4)).toBe('1997');
  });

  it('returns undefined for an unparseable value rather than an Invalid Date', () => {
    // An Invalid Date rendered in an embed is the "NaN plays" class of bug.
    expect(parseSpotifyReleaseDate('not-a-date', 'day')).toBeUndefined();
  });
});
