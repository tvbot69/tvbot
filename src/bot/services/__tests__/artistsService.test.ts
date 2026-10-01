import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { ArtistsService } from '../artistsService';
import { ColorService } from '../system/colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { TopArtist } from '@domain/models/topLists';
import type { User } from '@domain/interfaces/iuserRepository';
import type { ArtistInfo } from '@domain/models/musicInfo';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';

/**
 * artistsService is at 11.9% of 419 lines. `resolveArtistFromLink` is the
 * counterpart to `trackService.getTrackFromLink` and takes the same raw user
 * input, so the same reasoning applies: a wrong answer here is a wrong command,
 * not an exception.
 *
 * One asymmetry is worth stating, because the code documents it and it is
 * surprising: there is NO Spotify branch. A Spotify artist link deliberately
 * falls through and returns null, because there is no spotify-id -> artist
 * lookup in this codebase. That is pinned below so a future addition is a
 * deliberate change rather than an accident.
 */

const makeService = () => Object.create(ArtistsService.prototype) as ArtistsService;

describe('ArtistsService.resolveArtistFromLink', () => {
  let svc: ArtistsService;
  beforeEach(() => { svc = makeService(); });

  it('resolves a Last.fm artist URL', async () => {
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/Radiohead')).resolves.toBe('Radiohead');
  });

  it('decodes + as a space, since Last.fm encodes spaces that way', async () => {
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/James+Blake')).resolves.toBe('James Blake');
  });

  it('decodes percent-encoding in an artist name', async () => {
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/Bj%C3%B6rk')).resolves.toBe('Björk');
  });

  it('stops at a query string rather than absorbing it into the name', async () => {
    // The capture is [^/?#]+, so a trailing ?track=... must not become part of
    // the artist name, which would fail every lookup with "artist not found".
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/Radiohead?track=x')).resolves.toBe('Radiohead');
  });

  it('turns Apple Music dashes into spaces', async () => {
    // The fixture MUST contain a dash, or removing the replacement changes
    // nothing and the mutation survives. Apple uses dashes in the URL slug
    // exactly where the display name has spaces - "radiohead-head" is
    // "Radiohead Head" - so this is the ordinary case, not an edge one.
    await expect(svc.resolveArtistFromLink('https://music.apple.com/us/artist/radiohead-head/657515')).resolves.toBe('radiohead head');
  });

  it('returns null for a string that merely contains "http"', async () => {
    // The `includes('http')` guard is defensive, not load-bearing: both regexes
    // need a host segment, so anything the guard would reject reaches the same
    // null anyway. No mutation can separate them, so the guard's purpose is
    // recorded here rather than left implicit.
    await expect(svc.resolveArtistFromLink('http')).resolves.toBeNull();
    await expect(svc.resolveArtistFromLink('look at http://example.com')).resolves.toBeNull();
  });

  it('returns null for plain text, which is the common case', async () => {
    await expect(svc.resolveArtistFromLink('Radiohead')).resolves.toBeNull();
    await expect(svc.resolveArtistFromLink('')).resolves.toBeNull();
  });

  it('returns null for a Spotify artist link, by design', async () => {
    // Pinned deliberately. The source explains it: there is no spotify-id ->
    // artist resolver in this codebase, so the branch would lie. If one is ever
    // added, THIS test is what should change.
    await expect(svc.resolveArtistFromLink('https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb')).resolves.toBeNull();
  });

  it('returns null for plain text, which is the common case', async () => {
    await expect(svc.resolveArtistFromLink('Radiohead')).resolves.toBeNull();
    await expect(svc.resolveArtistFromLink('')).resolves.toBeNull();
  });

  it('returns null rather than throwing on an undecodable segment', async () => {
    // A malformed percent-escape makes decodeURIComponent throw. The inner
    // try/catch returns the raw segment; the outer one is the backstop. Either
    // way the command must get an answer, not a rejection.
    await expect(svc.resolveArtistFromLink('https://www.last.fm/music/%E0%A4%A')).resolves.toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// Dependency-backed branches: the searchArtist pipeline, the autocomplete
// helpers, the accent-color resolver, the static taste description, and the
// error paths of every raw query.
//
// Same mock-double pattern as artistsService.unit.test.ts: every collaborator
// is a vi.fn() and the service is built positionally, because the constructor
// arity is load-bearing (AGENTS.md 3.1).
// ---------------------------------------------------------------------------

const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';
const placeholderUrl = (size = 'large') =>
  `https://lastfm-img.freetls.fastly.net/i/u/${size}/${PLACEHOLDER}.png`;

type Over = Record<string, unknown>;

const build = (over: Over = {}) => {
  const lastfmRepository = {
    getArtistInfo: vi.fn(async () => null),
    searchArtists: vi.fn(async () => []),
    getTopArtists: vi.fn(async () => []),
    getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    ...(over.lastfmRepository as object),
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined), ...(over.cache as object) };
  const artworkService = { getArtistImageUrl: vi.fn(async () => undefined), ...(over.artworkService as object) };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x123456), ...(over.colorService as object) };
  const prisma = {
    artist: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    user: { findFirst: vi.fn(async () => null) },
    userPlay: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
    ...(over.prisma as object),
  };
  const service = new ArtistsService(
    lastfmRepository as never,
    cache as never,
    over.noArtwork ? undefined : (artworkService as never),
    over.noColor ? undefined : (colorService as never),
    prisma as never,
  );
  return { service, lastfmRepository, cache, artworkService, colorService, prisma };
};

const user = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    userNameLastFm: 'testuser',
    discordUserId: '123',
    sessionKey: 'sess',
    ...over,
  }) as User;

const artistInfo = (over: Partial<ArtistInfo> = {}): ArtistInfo => ({
  name: 'Radiohead',
  url: 'https://www.last.fm/music/Radiohead',
  listeners: 5_000_000,
  playCount: 200_000_000,
  userPlayCount: 42,
  summary: 'Bio',
  tags: ['rock', 'alternative'],
  ...over,
});

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('ArtistsService.searchArtists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates straight through to the repository', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.searchArtists).mockResolvedValue([{ name: 'A', playcount: 1 }]);
    await expect(service.searchArtists('a')).resolves.toEqual([{ name: 'A', playcount: 1 }]);
    expect(lastfmRepository.searchArtists).toHaveBeenCalledWith('a');
  });
});

describe('ArtistsService.getUserAllTimeTopArtists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the cached list when useCache is set', async () => {
    const { service, cache, prisma } = build();
    mock(cache.get).mockResolvedValue([{ name: 'Cached', playcount: 5 }]);
    await expect(service.getUserAllTimeTopArtists(1, true)).resolves.toEqual([{ name: 'Cached', playcount: 5 }]);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('skips the cache entirely when useCache is false', async () => {
    const { service, cache, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockResolvedValue([{ artist_name: 'Fresh', playcount: 2n }]);
    const result = await service.getUserAllTimeTopArtists(1, false);
    expect(cache.get).not.toHaveBeenCalled();
    expect(result).toEqual([{ name: 'Fresh', playcount: 2 }]);
  });

  it('converts the bigint playcount to a JS number', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockResolvedValue([{ artist_name: 'Big', playcount: 10n }]);
    const [first] = await service.getUserAllTimeTopArtists(1);
    expect(typeof first?.playcount).toBe('number');
  });

  it('caches only when the list is longer than 100 entries', async () => {
    const { service, cache, prisma } = build();
    const many = Array.from({ length: 101 }, (_, i) => ({ artist_name: `A${i}`, playcount: 1n }));
    mock(prisma.$queryRawUnsafe).mockResolvedValue(many);
    await service.getUserAllTimeTopArtists(1, true);
    expect(cache.set).toHaveBeenCalledWith('user-1-topartists-alltime', expect.any(Array), 600);
  });

  it('does not cache a short list', async () => {
    const { service, cache, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockResolvedValue([{ artist_name: 'One', playcount: 1n }]);
    await service.getUserAllTimeTopArtists(1, true);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('raises rather than reporting an outage as "no artists"', async () => {
    // The old assertion here was `resolves.toEqual([])`, which is exactly the
    // bug: an outage and a user who has never scrobbled became the same value,
    // and `searchArtist('rnd')` reads that empty list as "fall back to a Last.fm
    // pick" and presents a stranger's artist as the user's own taste.
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getUserAllTimeTopArtists(1)).rejects.toSatisfy(isSourceUnavailable);
  });

  it('does not cache the failure, so the next request retries', async () => {
    // A cached `[]` would outlive the outage by the full TTL and keep reporting
    // "no artists" long after Postgres came back.
    const { service, cache, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getUserAllTimeTopArtists(1, true)).rejects.toSatisfy(isSourceUnavailable);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('ArtistsService.getArtistForId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the row to id and name', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findUnique).mockResolvedValue({ artistId: 5, name: 'Radiohead' });
    await expect(service.getArtistForId(5)).resolves.toEqual({ id: 5, name: 'Radiohead' });
  });

  it('returns null when the id is unknown', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findUnique).mockResolvedValue(null);
    await expect(service.getArtistForId(999)).resolves.toBeNull();
  });

  it('raises rather than claiming the artist does not exist', async () => {
    // `null` is the "no such artist" answer. Returning it for a failed query
    // told the caller the artist was unknown, which is a different fact.
    const { service, prisma } = build();
    mock(prisma.artist.findUnique).mockRejectedValue(new Error('db down'));
    await expect(service.getArtistForId(5)).rejects.toSatisfy(isSourceUnavailable);
  });

  it('still returns null for a genuinely unknown id', async () => {
    // The counterpart, so the raise cannot be "fixed" by deleting the null.
    const { service, prisma } = build();
    mock(prisma.artist.findUnique).mockResolvedValue(null);
    await expect(service.getArtistForId(999)).resolves.toBeNull();
  });
});

describe('ArtistsService.getArtistFromDatabase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for an empty name without touching the database', async () => {
    const { service, prisma } = build();
    await expect(service.getArtistFromDatabase('')).resolves.toBeNull();
    expect(prisma.artist.findFirst).not.toHaveBeenCalled();
  });

  it('matches case-insensitively and maps the row', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findFirst).mockResolvedValue({ artistId: 9, name: 'Radiohead' });
    await expect(service.getArtistFromDatabase('radiohead')).resolves.toEqual({ id: 9, name: 'Radiohead' });
  });

  it('returns null when nothing matches', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findFirst).mockResolvedValue(null);
    await expect(service.getArtistFromDatabase('nobody')).resolves.toBeNull();
  });

  it('raises rather than claiming the artist does not exist', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findFirst).mockRejectedValue(new Error('db down'));
    await expect(service.getArtistFromDatabase('radiohead')).rejects.toSatisfy(isSourceUnavailable);
  });
});

/**
 * These four feed `whoKnowsImageBuilder`, which already wraps each call in its
 * own try/catch and falls through to the next cover source. So raising is
 * behaviourally neutral there and buys a log line explaining why a mosaic lost a
 * row. What it must never do is resolve to `[]` again - an empty list is the
 * value the caller uses to mean "nothing to draw", so a swallowed outage is
 * indistinguishable from an artist with no indexed covers.
 */
describe('ArtistsService top-list queries under database failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getTopTracksForArtist raises instead of reporting no tracks', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getTopTracksForArtist(1, 'Radiohead')).rejects.toSatisfy(isSourceUnavailable);
  });

  it('getTopAlbumsForArtist raises instead of reporting no albums', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getTopAlbumsForArtist(1, 'Radiohead')).rejects.toSatisfy(isSourceUnavailable);
  });

  it('getTopAlbumsForArtistGlobal raises instead of reporting no albums', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getTopAlbumsForArtistGlobal('Radiohead')).rejects.toSatisfy(isSourceUnavailable);
  });

  it('getTopTracksForArtistGlobal raises instead of reporting no tracks', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getTopTracksForArtistGlobal('Radiohead')).rejects.toSatisfy(isSourceUnavailable);
  });

  it('keeps the raise distinguishable from a Last.fm outage', async () => {
    // Both are `SourceUnavailableError`, but a database outage and a Last.fm
    // outage are different incidents and the operator needs to know which. The
    // method label is what carries that, so it is asserted rather than assumed.
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getTopTracksForArtistGlobal('Radiohead')).rejects.toMatchObject({
      method: 'artistsService.getTopTracksForArtistGlobal:globalTracksByArtist',
    });
  });
});

describe('ArtistsService.getIndexedAlbumCoversForArtist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps rows to cover strings and drops falsy ones', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockResolvedValue([
      { cover: 'https://img/1.png' },
      { cover: null },
      { cover: 'https://img/2.png' },
    ]);
    await expect(service.getIndexedAlbumCoversForArtist('Radiohead')).resolves.toEqual([
      'https://img/1.png',
      'https://img/2.png',
    ]);
  });

  it('passes the limit through to the query', async () => {
    const { service, prisma } = build();
    await service.getIndexedAlbumCoversForArtist('Radiohead', 5);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), 'Radiohead', 5);
  });

  it('returns [] when the query throws', async () => {
    const { service, prisma } = build();
    mock(prisma.$queryRawUnsafe).mockRejectedValue(new Error('db down'));
    await expect(service.getIndexedAlbumCoversForArtist('Radiohead')).resolves.toEqual([]);
  });
});

describe('ArtistsService.getLatestArtists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the cached list without a database round-trip', async () => {
    const { service, cache, prisma } = build();
    mock(cache.get).mockResolvedValue(['Cached Artist']);
    await expect(service.getLatestArtists('123')).resolves.toEqual(['Cached Artist']);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('returns [] when the discord user is not registered', async () => {
    const { service, prisma } = build();
    mock(prisma.user.findFirst).mockResolvedValue(null);
    await expect(service.getLatestArtists('123')).resolves.toEqual([]);
  });

  it('dedupes artist names and caches for 30 seconds', async () => {
    const { service, cache, prisma } = build();
    mock(prisma.user.findFirst).mockResolvedValue({ userId: 42 });
    mock(prisma.userPlay.findMany).mockResolvedValue([
      { artistName: 'Radiohead' },
      { artistName: 'Arcade Fire' },
      { artistName: 'Radiohead' },
    ]);
    const result = await service.getLatestArtists('123');
    expect(result).toEqual(['Radiohead', 'Arcade Fire']);
    expect(cache.set).toHaveBeenCalledWith('user-recent-artists-123', ['Radiohead', 'Arcade Fire'], 30);
  });

  it('returns [] when the query throws', async () => {
    const { service, prisma } = build();
    mock(prisma.user.findFirst).mockRejectedValue(new Error('db down'));
    await expect(service.getLatestArtists('123')).resolves.toEqual([]);
  });
});

describe('ArtistsService.getRecentTopArtists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the cached list without a database round-trip', async () => {
    const { service, cache, prisma } = build();
    mock(cache.get).mockResolvedValue([{ name: 'Cached', playcount: 1 }]);
    await expect(service.getRecentTopArtists('123')).resolves.toEqual([{ name: 'Cached', playcount: 1 }]);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('returns [] when the discord user is not registered', async () => {
    const { service, prisma } = build();
    mock(prisma.user.findFirst).mockResolvedValue(null);
    await expect(service.getRecentTopArtists('123')).resolves.toEqual([]);
  });

  it('maps rows and caches for 120 seconds', async () => {
    const { service, cache, prisma } = build();
    mock(prisma.user.findFirst).mockResolvedValue({ userId: 42 });
    mock(prisma.$queryRawUnsafe).mockResolvedValue([{ artist_name: 'Radiohead', playcount: 7n }]);
    const result = await service.getRecentTopArtists('123');
    expect(result).toEqual([{ name: 'Radiohead', playcount: 7 }]);
    expect(cache.set).toHaveBeenCalledWith('user-recent-top-artists-123', [{ name: 'Radiohead', playcount: 7 }], 120);
  });

  it('returns [] when the query throws', async () => {
    const { service, prisma } = build();
    mock(prisma.user.findFirst).mockRejectedValue(new Error('db down'));
    await expect(service.getRecentTopArtists('123')).resolves.toEqual([]);
  });
});

describe('ArtistsService.searchThroughArtists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] for empty or whitespace input without a query', async () => {
    const { service, prisma } = build();
    await expect(service.searchThroughArtists('')).resolves.toEqual([]);
    await expect(service.searchThroughArtists('   ')).resolves.toEqual([]);
    expect(prisma.artist.findMany).not.toHaveBeenCalled();
  });

  it('trims the search value and maps the rows', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findMany).mockResolvedValue([{ name: 'Radiohead' }, { name: 'Radio' }]);
    await expect(service.searchThroughArtists('  radio  ')).resolves.toEqual([
      { name: 'Radiohead' },
      { name: 'Radio' },
    ]);
    expect(prisma.artist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ name: expect.objectContaining({ contains: 'radio' }) }),
      }),
    );
  });

  it('returns [] when the query throws', async () => {
    const { service, prisma } = build();
    mock(prisma.artist.findMany).mockRejectedValue(new Error('db down'));
    await expect(service.searchThroughArtists('radio')).resolves.toEqual([]);
  });
});

describe('ArtistsService.getArtistAccentColorAsync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the accent color from the image url', async () => {
    const { service, colorService } = build();
    await expect(service.getArtistAccentColorAsync('https://img/a.png')).resolves.toBe(0x123456);
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/a.png');
  });

  it('falls back to the container-registered ColorService when none is injected', async () => {
    // Vitest isolates the module graph per test file, so this registration
    // cannot leak into another suite.
    const stub = { getColorFromImageUrl: vi.fn(async () => 0xabcdef) };
    container.register(ColorService, { useValue: stub as never });
    const { service } = build({ noColor: true });
    await expect(service.getArtistAccentColorAsync('https://img/a.png')).resolves.toBe(0xabcdef);
    expect(stub.getColorFromImageUrl).toHaveBeenCalledWith('https://img/a.png');
  });

  it('returns the default red when the color service throws synchronously', async () => {
    // The catch guards the synchronous parts: resolving the service and
    // invoking it. A rejected promise is NOT caught here - `return promise`
    // inside a try block passes the rejection straight to the caller - so the
    // double throws synchronously to exercise the branch that actually exists.
    const { service, colorService } = build();
    mock(colorService.getColorFromImageUrl).mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(service.getArtistAccentColorAsync('https://img/a.png')).resolves.toBe(
      DiscordConstants.LastFmColorRed,
    );
  });

  it('returns the default red when there is no image url', async () => {
    const { service, colorService } = build();
    await expect(service.getArtistAccentColorAsync(undefined)).resolves.toBe(DiscordConstants.LastFmColorRed);
    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
  });
});

describe('ArtistsService.description', () => {
  it('reports the match percentage for the overall period by default', () => {
    const main = [
      { name: 'A', playcount: 1 },
      { name: 'B', playcount: 1 },
      { name: 'C', playcount: 1 },
    ];
    const matched = [{ name: 'A', playcount: 1 }];
    expect(ArtistsService.description(main, matched)).toBe(
      'Matched **1** of **3** artists (33.3%) for overall.',
    );
  });

  it('uses a custom time description', () => {
    const main = [{ name: 'A', playcount: 1 }];
    const matched = [{ name: 'A', playcount: 1 }];
    expect(ArtistsService.description(main, matched, 'the last 7 days')).toContain('for the last 7 days.');
  });

  it('reports 0.0% when the main user has no artists', () => {
    expect(ArtistsService.description([], [])).toBe('Matched **0** of **0** artists (0.0%) for overall.');
  });

  it('thousands-separates a large artist count', () => {
    const main = Array.from({ length: 1234 }, (_, i) => ({ name: `A${i}`, playcount: 1 }));
    const matched = [{ name: 'A0', playcount: 1 }];
    expect(ArtistsService.description(main, matched)).toContain('of **1,234** artists');
  });
});

describe('ArtistsService.searchArtist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps every ArtistInfo field onto the search result', async () => {
    const { service, lastfmRepository, artworkService } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo());
    mock(artworkService.getArtistImageUrl).mockResolvedValue('https://img/radiohead.png');

    const result = await service.searchArtist('radiohead', user());

    expect(result).toEqual({
      artistName: 'Radiohead',
      artistUrl: 'https://www.last.fm/music/Radiohead',
      imageUrl: 'https://img/radiohead.png',
      userPlaycount: 42,
      globalPlaycount: 200_000_000,
      globalListeners: 5_000_000,
      bio: 'Bio',
      tags: ['rock', 'alternative'],
    });
  });

  it('prefers the artwork service image over the Last.fm one', async () => {
    const { service, lastfmRepository, artworkService } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo({ imageUrl: 'https://lastfm/img.png' }));
    mock(artworkService.getArtistImageUrl).mockResolvedValue('https://artwork/img.png');

    const result = await service.searchArtist('radiohead', user());

    expect(result?.imageUrl).toBe('https://artwork/img.png');
  });

  it('drops a placeholder imageUrl coming from Last.fm', async () => {
    const { service, lastfmRepository, artworkService } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo({ imageUrl: placeholderUrl() }));
    mock(artworkService.getArtistImageUrl).mockResolvedValue(undefined);

    const result = await service.searchArtist('radiohead', user());

    expect(result?.imageUrl).toBeUndefined();
  });

  it('falls back to the referenced message artist when input is empty', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo({ name: 'Referenced Artist' }));

    const result = await service.searchArtist('   ', user(), undefined, { artist: 'Referenced Artist' });

    expect(lastfmRepository.getArtistInfo).toHaveBeenCalledWith('Referenced Artist', 'testuser');
    expect(result?.artistName).toBe('Referenced Artist');
  });

  it('resolves a Last.fm URL before looking the artist up', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo());

    const result = await service.searchArtist('https://www.last.fm/music/Radiohead', user());

    expect(lastfmRepository.getArtistInfo).toHaveBeenCalledWith('Radiohead', 'testuser');
    expect(result?.artistName).toBe('Radiohead');
  });

  it('picks a random artist from the local top list for "rnd"', async () => {
    const { service, prisma, lastfmRepository } = build();
    mock(prisma.$queryRawUnsafe).mockResolvedValue([{ artist_name: 'Solo Act', playcount: 9n }]);

    const result = await service.searchArtist('rnd', user({ userId: 7 }));

    expect(result?.artistName).toBe('Solo Act');
    expect(result?.userPlaycount).toBe(9);
    expect(result?.rndPlaycount).toBe(9);
    expect(result?.rndPosition).toBe(1);
    // The local list short-circuits: Last.fm is never consulted.
    expect(lastfmRepository.getArtistInfo).not.toHaveBeenCalled();
  });

  it('falls back to the Last.fm top list when the local one is empty', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getTopArtists).mockResolvedValue([{ name: 'Lfm Pick', playcount: 3 }]);
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo({ name: 'Lfm Pick' }));

    const result = await service.searchArtist('random', user());

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('testuser', undefined, 100);
    expect(result?.artistName).toBe('Lfm Pick');
  });

  it('uses the most recent track artist when there is no input at all', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getUserRecentTracksWithMetadata).mockResolvedValue({
      tracks: [{ name: 'Karma Police', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: false }],
      totalPages: 1,
      totalScrobbles: 100,
    });
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(artistInfo());

    const result = await service.searchArtist('', user());

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalledWith('testuser', 1, 1, undefined, 'sess');
    expect(result?.artistName).toBe('Radiohead');
  });

  it('returns null when there is no input and no recent tracks', async () => {
    const { service } = build();
    await expect(service.searchArtist(null, user())).resolves.toBeNull();
  });

  it('falls back to searchArtists when the exact lookup misses', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getArtistInfo)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(artistInfo({ name: 'Searched Name' }));
    mock(lastfmRepository.searchArtists).mockResolvedValue([{ name: 'Searched Name', playcount: 1 }]);

    const result = await service.searchArtist('searched name', user());

    expect(lastfmRepository.searchArtists).toHaveBeenCalledWith('searched name');
    expect(result?.artistName).toBe('Searched Name');
  });

  it('returns just the name when both the lookup and the fallback miss', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(null);
    mock(lastfmRepository.searchArtists).mockResolvedValue([{ name: 'Half Known', playcount: 1 }]);

    const result = await service.searchArtist('half known', user());

    expect(result).toEqual({ artistName: 'Half Known' });
  });

  it('returns the raw input when nothing resolves at all', async () => {
    const { service, lastfmRepository } = build();
    mock(lastfmRepository.getArtistInfo).mockResolvedValue(null);
    mock(lastfmRepository.searchArtists).mockResolvedValue([]);

    const result = await service.searchArtist('unknown artist', user());

    expect(result).toEqual({ artistName: 'unknown artist' });
  });
});

describe('ArtistsService.fillArtistImages — remaining branches', () =>  {
  beforeEach(() => vi.clearAllMocks());

  it('looks up only the artists that are missing an image', async () => {
    const { service, artworkService } = build();
    mock(artworkService.getArtistImageUrl).mockResolvedValue('https://img/b.png');

    const list: TopArtist[] = [
      { name: 'A', playcount: 1, imageUrl: 'https://img/a.png' },
      { name: 'B', playcount: 1 },
    ];
    const result = await service.fillArtistImages(list);

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledTimes(1);
    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('B');
    expect(result[0]?.imageUrl).toBe('https://img/a.png');
    expect(result[1]?.imageUrl).toBe('https://img/b.png');
  });

  it('returns the original list when the database fallback query throws', async () => {
    const { service, prisma } = build({ noArtwork: true });
    mock(prisma.artist.findMany).mockRejectedValue(new Error('db down'));

    const list: TopArtist[] = [{ name: 'Mond', playcount: 1 }];
    const result = await service.fillArtistImages(list);

    expect(result).toEqual([{ name: 'Mond', playcount: 1 }]);
  });
});
