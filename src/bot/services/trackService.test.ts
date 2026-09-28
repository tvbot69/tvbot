import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TrackService } from './trackService';


/**
 * trackService sits at 7.7% of 428 lines. These two parsers take raw user
 * input - a pasted URL, a bolded description - so they are where a wrong answer
 * is a wrong command rather than an exception.
 *
 * `parseBoldDelimitedTrackAndArtist` parses text this bot generates itself:
 * the embed footer reads "**Track** **by** **Artist**". So a change to the
 * template silently breaks the parser, and the symptom is a scrobble attributed
 * to a literal "**" rather than an error. That is why the exact-shape cases
 * below are pinned, including the ones that currently return null.
 */

const makeService = () => Object.create(TrackService.prototype) as TrackService;

describe('TrackService.getTrackFromLink', () => {
  let svc: TrackService;
  beforeEach(() => { svc = makeService(); });

  it('extracts artist and track from a Last.fm track URL', () => {
    // Note the `_` segment: Last.fm puts a literal underscore between artist
    // and track, and the regex has to match it exactly.
    expect(svc.getTrackFromLink('https://www.last.fm/music/Radiohead/_/Karma+Police')).toEqual({
      artistName: 'Radiohead',
      trackName: 'Karma Police',
    });
  });

  it('decodes + as a space in BOTH the artist and the track segment', () => {
    // Both halves, because Last.fm encodes spaces as + on both. A fixture with
    // a + only in the track segment would miss a broken artist half.
    expect(svc.getTrackFromLink('https://www.last.fm/music/James+Blake/_/Retrograde')).toEqual({
      artistName: 'James Blake',
      trackName: 'Retrograde',
    });
  });

  it('decodes percent-encoding in a track name', () => {
    expect(svc.getTrackFromLink('https://www.last.fm/music/Radiohead/_/Let+Down%2C+You+Down')).toEqual({
      artistName: 'Radiohead',
      trackName: 'Let Down, You Down',
    });
  });

  it('returns only the id for a Spotify track URL', () => {
    // A Spotify id carries no name, so trackName is the id and artistName is
    // ABSENT rather than empty - an empty string would be searched for.
    expect(svc.getTrackFromLink('https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp')).toEqual({
      trackName: '3n3Ppam7vgaVa1iaRUc9Lp',
    });
  });

  it('handles the localised Spotify path', () => {
    expect(svc.getTrackFromLink('https://open.spotify.com/intl-pt/track/3n3Ppam7vgaVa1iaRUc9Lp')).toEqual({
      trackName: '3n3Ppam7vgaVa1iaRUc9Lp',
    });
  });

  it('returns null for a plain search string', () => {
    expect(svc.getTrackFromLink('Karma Police')).toBeNull();
    expect(svc.getTrackFromLink('')).toBeNull();
  });

  it('returns null for a link from a provider it does not know', () => {
    // Better a reportable null than a wrong guess.
    expect(svc.getTrackFromLink('https://soundcloud.com/artist/track')).toBeNull();
    expect(svc.getTrackFromLink('https://youtube.com/watch?v=abc123')).toBeNull();
  });

  it('does not confuse a Last.fm ALBUM url for a track url', () => {
    // An album url has no `_` segment, so it must not resolve. Getting this
    // wrong means `.track <album link>` reports the album name as a track.
    expect(svc.getTrackFromLink('https://www.last.fm/music/Radiohead/OK+Computer')).toBeNull();
  });
});

describe('TrackService.parseBoldDelimitedTrackAndArtist', () => {
  it('parses the canonical footer shape this bot renders', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Karma Police** **by** **Radiohead**')).toEqual({
      track: 'Karma Police',
      artist: 'Radiohead',
    });
  });

  it('keeps asterisks inside a title, which would otherwise break the split', () => {
    // The split requires exactly 3 pieces, so a title containing a literal
    // double-asterisk breaks the parse. Pinned as current behaviour: the
    // practical fix is a non-bold delimiter in the template, and this test is
    // what will notice if either side changes.
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**AC**DC** **by** **Back In Black**')).toBeNull();
  });

  it('returns null when the bold markers are missing on one side', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('Karma Police **by** **Radiohead**')).toBeNull();
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Karma Police** **by** Radiohead')).toBeNull();
  });

  it('returns null when the "by" delimiter is absent', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Karma Police** **Radiohead**')).toBeNull();
  });

  it('requires the surrounding spaces around "**by**"', () => {
    // ' **by** ' with spaces, not '**by**'. A template change to a tight
    // delimiter would stop the footer parsing at all.
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Track****by****Artist**')).toBeNull();
  });

  it('preserves internal spaces in the artist name', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('**Retrograde** **by** **James Blake**')).toEqual({
      track: 'Retrograde',
      artist: 'James Blake',
    });
  });

  it('returns null for an empty description rather than throwing', () => {
    expect(TrackService.parseBoldDelimitedTrackAndArtist('')).toBeNull();
  });
});



const build = (over: Record<string, unknown> = {}) => {
  const lastfmRepository = {
    getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    getTopTracks: vi.fn(async () => []),
    searchTracks: vi.fn(async () => []),
    getTrackInfo: vi.fn(async () => ({
      name: 'Airbag',
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      albumCoverUrl: 'https://img/album.png',
      imageUrl: 'https://img/track.png',
      url: 'https://last.fm/track',
      durationSeconds: 284,
      userPlayCount: 7,
      playCount: 999,
      listeners: 100,
      summary: 's',
      tags: ['rock'],
      userLoved: true,
    })),
    ...(over.lastfmRepository as object),
  };
  const artistRepository = { getArtistByName: vi.fn(async () => ({ artistId: 1, name: 'Radiohead' })), ...(over.artistRepository as object) };
  const trackRepository = { getTrackByNameAndArtist: vi.fn(async () => ({ trackId: 5, name: 'Airbag' })), ...(over.trackRepository as object) };
  const whoKnowsRepository = { getIndexedUsersForTrack: vi.fn(async () => [{ userId: 1, playcount: 3 }, { userId: 2, playcount: 4 }]), ...(over.whoKnowsRepository as object) };
  const artworkService = { getTrackCoverUrl: vi.fn(async () => 'https://img/resolved.png'), ...(over.artworkService as object) };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const prisma = over.prisma === undefined ? undefined : over.prisma;
  const service = new TrackService(
    lastfmRepository as never,
    artistRepository as never,
    trackRepository as never,
    whoKnowsRepository as never,
    artworkService as never,
    cache as never,
    prisma as never,
  );
  return { service, lastfmRepository, artistRepository, trackRepository, whoKnowsRepository, artworkService, cache };
};

describe('TrackService.getTrackInfo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cached info without calling the repository', async () => {
    const { service, lastfmRepository, cache } = build();
    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'Cached', artistName: 'Artist' });
    const result = await service.getTrackInfo('Airbag', 'Radiohead', 'DreadRock');
    expect(result).toEqual({ name: 'Cached', artistName: 'Artist' });
    expect(lastfmRepository.getTrackInfo).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('fetches from the repository on cache miss and stores the result', async () => {
    const { service, lastfmRepository, cache } = build();
    const result = await service.getTrackInfo('Airbag', 'Radiohead', 'DreadRock');
    expect(lastfmRepository.getTrackInfo).toHaveBeenCalledWith('Airbag', 'Radiohead', 'DreadRock');
    expect(cache.set).toHaveBeenCalledWith(
      'track-info:radiohead:airbag:dreadrock',
      expect.objectContaining({ name: 'Airbag' }),
      1800,
    );
    expect(result).toMatchObject({ name: 'Airbag', artistName: 'Radiohead' });
  });

  it('uses :global suffix when no username is provided', async () => {
    const { service, cache } = build();
    await service.getTrackInfo('Airbag', 'Radiohead');
    expect(cache.set).toHaveBeenCalledWith(
      'track-info:radiohead:airbag:global',
      expect.anything(),
      1800,
    );
  });

  it('does not cache when the repository returns null', async () => {
    const { service, lastfmRepository, cache } = build();
    (lastfmRepository.getTrackInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.getTrackInfo('Unknown', 'Unknown');
    expect(result).toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('TrackService.searchTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates directly to the repository', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Idioteque', artistName: 'Radiohead', playcount: 42 },
    ]);
    const result = await service.searchTracks('idioteque');
    expect(lastfmRepository.searchTracks).toHaveBeenCalledWith('idioteque');
    expect(result).toEqual([{ name: 'Idioteque', artistName: 'Radiohead', playcount: 42 }]);
  });
});

describe('TrackService.getLastMonthPlays', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 0 when prisma is not injected', async () => {
    const { service } = build();
    await expect(service.getLastMonthPlays(1, 'Airbag', 'Radiohead')).resolves.toBe(0);
  });

  it('returns the count from the database', async () => {
    const prisma = { userPlay: { count: vi.fn(async () => 5) } };
    const { service } = build({ prisma });
    await expect(service.getLastMonthPlays(1, 'Airbag', 'Radiohead')).resolves.toBe(5);
    expect(prisma.userPlay.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 1 }),
      }),
    );
  });

  it('returns 0 when the database query throws', async () => {
    const prisma = { userPlay: { count: vi.fn(async () => { throw new Error('db down'); }) } };
    const { service } = build({ prisma });
    await expect(service.getLastMonthPlays(1, 'Airbag', 'Radiohead')).resolves.toBe(0);
  });
});

describe('TrackService scrobble references', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores and retrieves a scrobble reference by id', () => {
    const { service } = build();
    const id = service.storeScrobbleReference('Radiohead', 'Airbag', 'OK Computer', new Date('2026-01-01'));
    const ref = service.getScrobbleReference(id);
    expect(ref).toEqual({
      artist: 'Radiohead',
      track: 'Airbag',
      album: 'OK Computer',
      timePlayed: new Date('2026-01-01'),
    });
  });

  it('returns undefined for an unknown id', () => {
    const { service } = build();
    expect(service.getScrobbleReference('nonexistent')).toBeUndefined();
  });

  it('stores a reference without optional album and time', () => {
    const { service } = build();
    const id = service.storeScrobbleReference('Radiohead', 'Airbag');
    expect(service.getScrobbleReference(id)).toEqual({
      artist: 'Radiohead',
      track: 'Airbag',
      album: undefined,
      timePlayed: undefined,
    });
  });
});

describe('TrackService scrobble deduplication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks a track as scrobbled and confirms it', () => {
    const { service } = build();
    expect(service.isTrackScrobbled(1, 'Radiohead', 'Airbag')).toBe(false);
    service.markTrackAsScrobbled(1, 'Radiohead', 'Airbag');
    expect(service.isTrackScrobbled(1, 'Radiohead', 'Airbag')).toBe(true);
  });

  it('is case-insensitive on artist and track names', () => {
    const { service } = build();
    service.markTrackAsScrobbled(1, 'radiohead', 'airbag');
    expect(service.isTrackScrobbled(1, 'Radiohead', 'Airbag')).toBe(true);
  });

  it('treats different timestamps as different scrobbles', () => {
    const { service } = build();
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-01-01T00:01:00Z');
    service.markTrackAsScrobbled(1, 'Radiohead', 'Airbag', t1);
    expect(service.isTrackScrobbled(1, 'Radiohead', 'Airbag', t2)).toBe(false);
  });

  it('treats timestamps within the same minute as the same scrobble', () => {
    const { service } = build();
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-01-01T00:00:30Z');
    service.markTrackAsScrobbled(1, 'Radiohead', 'Airbag', t1);
    expect(service.isTrackScrobbled(1, 'Radiohead', 'Airbag', t2)).toBe(true);
  });

  it('treats different users as different scrobbles', () => {
    const { service } = build();
    service.markTrackAsScrobbled(1, 'Radiohead', 'Airbag');
    expect(service.isTrackScrobbled(2, 'Radiohead', 'Airbag')).toBe(false);
  });
});

describe('TrackService.getUserAllTimeTopTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when prisma is not injected', async () => {
    const { service } = build();
    await expect(service.getUserAllTimeTopTracks(1)).resolves.toEqual([]);
  });

  it('returns cached results on second call when useCache is true', async () => {
    const manyRows = Array.from({ length: 101 }, (_, i) => ({
      track_name: `Track ${i}`, artist_name: 'Radiohead', playcount: BigInt(i),
    }));
    const prisma = { $queryRawUnsafe: vi.fn(async () => manyRows) };
    const { service, cache } = build({ prisma });
    const first = await service.getUserAllTimeTopTracks(1, true);
    expect(first).toHaveLength(101);
    expect(cache.set).toHaveBeenCalled();

    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue(first);
    const second = await service.getUserAllTimeTopTracks(1, true);
    expect(second).toEqual(first);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('does not cache when there are 100 or fewer tracks', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => [
        { track_name: 'Airbag', artist_name: 'Radiohead', playcount: BigInt(10) },
      ]),
    };
    const { service, cache } = build({ prisma });
    await service.getUserAllTimeTopTracks(1, true);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns empty array when the query throws', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => { throw new Error('db down'); }),
    };
    const { service } = build({ prisma });
    await expect(service.getUserAllTimeTopTracks(1)).resolves.toEqual([]);
  });
});

describe('TrackService.getArtistUserTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when prisma is not injected', async () => {
    const { service } = build();
    await expect(service.getArtistUserTracks(1, 'Radiohead')).resolves.toEqual([]);
  });

  it('returns mapped track names and playcounts', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => [
        { track_name: 'Airbag', playcount: BigInt(10) },
        { track_name: 'Paranoid Android', playcount: BigInt(5) },
      ]),
    };
    const { service } = build({ prisma });
    const result = await service.getArtistUserTracks(1, 'Radiohead');
    expect(result).toEqual([
      { name: 'Airbag', playcount: 10 },
      { name: 'Paranoid Android', playcount: 5 },
    ]);
  });

  it('returns empty array when the query throws', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => { throw new Error('db down'); }),
    };
    const { service } = build({ prisma });
    await expect(service.getArtistUserTracks(1, 'Radiohead')).resolves.toEqual([]);
  });
});

describe('TrackService.getAverageTrackAudioFeaturesForTopTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns zeroed overview when prisma is not injected', async () => {
    const { service } = build();
    const result = await service.getAverageTrackAudioFeaturesForTopTracks([{ name: 'Airbag', artistName: 'Radiohead', playcount: 1 }]);
    expect(result.total).toBe(0);
    expect(result.average.danceability).toBe(0);
  });

  it('returns zeroed overview for an empty track list', async () => {
    const prisma = { $queryRawUnsafe: vi.fn(async () => []) };
    const { service } = build({ prisma });
    const result = await service.getAverageTrackAudioFeaturesForTopTracks([]);
    expect(result.total).toBe(0);
  });

  it('returns zeroed overview when no matching rows are found', async () => {
    const prisma = { $queryRawUnsafe: vi.fn(async () => []) };
    const { service } = build({ prisma });
    const result = await service.getAverageTrackAudioFeaturesForTopTracks([{ name: 'Unknown', artistName: 'Unknown', playcount: 1 }]);
    expect(result.total).toBe(0);
  });

  it('computes averages from database rows', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => [
        { danceability: 0.5, energy: 0.7, valence: 0.3, tempo: 120, acousticness: 0.1 },
        { danceability: 0.3, energy: 0.5, valence: 0.6, tempo: 100, acousticness: 0.2 },
      ]),
    };
    const { service } = build({ prisma });
    const result = await service.getAverageTrackAudioFeaturesForTopTracks([{ name: 'Airbag', artistName: 'Radiohead', playcount: 1 }]);
    expect(result.total).toBe(2);
    expect(result.average.danceability).toBe(0.4);
    expect(result.average.energy).toBe(0.6);
    expect(result.average.valence).toBe(0.45);
    expect(result.average.tempo).toBe(110);
    expect(result.average.acousticness).toBe(0.15);
  });

  it('returns zeroed overview when the query throws', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => { throw new Error('db down'); }),
    };
    const { service } = build({ prisma });
    const result = await service.getAverageTrackAudioFeaturesForTopTracks([{ name: 'Airbag', artistName: 'Radiohead', playcount: 1 }]);
    expect(result.total).toBe(0);
  });
});

describe('TrackService.audioFeatureAnalysisComparisonString', () => {
  beforeEach(() => vi.clearAllMocks());

  const overview = {
    total: 10,
    average: { danceability: 0.65, energy: 0.8, valence: 0.45, tempo: 128, acousticness: 0.15 },
  };

  it('returns a message when no audio features are available', () => {
    const { service } = build();
    const empty = { total: 0, average: { danceability: 0, energy: 0, valence: 0, tempo: 0, acousticness: 0 } };
    expect(service.audioFeatureAnalysisComparisonString(empty)).toBe('No audio features available.');
  });

  it('formats all features without previous data', () => {
    const { service } = build();
    const result = service.audioFeatureAnalysisComparisonString(overview);
    expect(result).toContain('**Danceability**: **65%**');
    expect(result).toContain('**Energy**: **80%**');
    expect(result).toContain('**Valence (Happiness)**: **45%**');
    expect(result).toContain('**Acousticness**: **15%**');
    expect(result).toContain('**Tempo**: **128 BPM**');
  });

  it('includes delta when previous data is available', () => {
    const { service } = build();
    const previous = {
      total: 10,
      average: { danceability: 0.55, energy: 0.7, valence: 0.5, tempo: 120, acousticness: 0.2 },
    };
    const result = service.audioFeatureAnalysisComparisonString(overview, previous);
    expect(result).toContain('+10%');
    expect(result).toContain('+8 from 120 BPM');
    expect(result).toContain('-5%');
  });
});

describe('TrackService.getLatestTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when prisma is not injected', async () => {
    const { service } = build();
    await expect(service.getLatestTracks('123')).resolves.toEqual([]);
  });

  it('returns cached results on second call when cacheEnabled is true', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => ({ userId: 1 })) },
      userPlay: { findMany: vi.fn(async () => [
        { artistName: 'Radiohead', trackName: 'Airbag' },
      ]) },
    };
    const { service, cache } = build({ prisma });
    const first = await service.getLatestTracks('123', true);
    expect(first).toEqual([{ artistName: 'Radiohead', trackName: 'Airbag' }]);

    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue(first);
    const second = await service.getLatestTracks('123', true);
    expect(second).toEqual(first);
    expect(prisma.userPlay.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when user is not found', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => null) },
      userPlay: { findMany: vi.fn(async () => []) },
    };
    const { service } = build({ prisma });
    await expect(service.getLatestTracks('unknown')).resolves.toEqual([]);
  });

  it('deduplicates tracks by case-insensitive artist+track key', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => ({ userId: 1 })) },
      userPlay: { findMany: vi.fn(async () => [
        { artistName: 'Radiohead', trackName: 'Airbag' },
        { artistName: 'radiohead', trackName: 'AIRBAG' },
        { artistName: 'Radiohead', trackName: 'Paranoid Android' },
      ]) },
    };
    const { service } = build({ prisma });
    const result = await service.getLatestTracks('123', false);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ artistName: 'Radiohead', trackName: 'Airbag' });
    expect(result).toContainEqual({ artistName: 'Radiohead', trackName: 'Paranoid Android' });
  });

  it('returns empty array when the query throws', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => { throw new Error('db down'); }) },
      userPlay: { findMany: vi.fn(async () => []) },
    };
    const { service } = build({ prisma });
    await expect(service.getLatestTracks('123')).resolves.toEqual([]);
  });
});

describe('TrackService.getRecentTopTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when prisma is not injected', async () => {
    const { service } = build();
    await expect(service.getRecentTopTracks('123')).resolves.toEqual([]);
  });

  it('returns cached results on second call when cacheEnabled is true', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => ({ userId: 1 })) },
      $queryRawUnsafe: vi.fn(async () => [
        { artist_name: 'Radiohead', track_name: 'Airbag', playcount: BigInt(5) },
      ]),
    };
    const { service, cache } = build({ prisma });
    const first = await service.getRecentTopTracks('123', true);
    expect(first).toEqual([{ name: 'Airbag', artistName: 'Radiohead', playcount: 5 }]);

    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue(first);
    const second = await service.getRecentTopTracks('123', true);
    expect(second).toEqual(first);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when user is not found', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => null) },
      $queryRawUnsafe: vi.fn(async () => []),
    };
    const { service } = build({ prisma });
    await expect(service.getRecentTopTracks('unknown')).resolves.toEqual([]);
  });

  it('returns empty array when the query throws', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => ({ userId: 1 })) },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('db down'); }),
    };
    const { service } = build({ prisma });
    await expect(service.getRecentTopTracks('123')).resolves.toEqual([]);
  });
});

describe('TrackService.getRecentTopTracksAutoComplete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps TopTrack to artistName/trackName pairs', async () => {
    const prisma = {
      user: { findFirst: vi.fn(async () => ({ userId: 1 })) },
      $queryRawUnsafe: vi.fn(async () => [
        { artist_name: 'Radiohead', track_name: 'Airbag', playcount: BigInt(5) },
        { artist_name: 'James Blake', track_name: 'Retrograde', playcount: BigInt(3) },
      ]),
    };
    const { service } = build({ prisma });
    const result = await service.getRecentTopTracksAutoComplete('123', false);
    expect(result).toEqual([
      { artistName: 'Radiohead', trackName: 'Airbag' },
      { artistName: 'James Blake', trackName: 'Retrograde' },
    ]);
  });
});

describe('TrackService.searchThroughTracks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array for empty or whitespace-only query', async () => {
    const prisma = { track: { findMany: vi.fn(async () => []) } };
    const { service } = build({ prisma });
    await expect(service.searchThroughTracks('')).resolves.toEqual([]);
    await expect(service.searchThroughTracks('   ')).resolves.toEqual([]);
    expect(prisma.track.findMany).not.toHaveBeenCalled();
  });

  it('returns empty array when prisma is not injected', async () => {
    const { service } = build();
    await expect(service.searchThroughTracks('Airbag')).resolves.toEqual([]);
  });

  it('returns mapped track catalog results', async () => {
    const prisma = {
      track: { findMany: vi.fn(async () => [
        { name: 'Airbag', artist: { name: 'Radiohead' } },
        { name: 'Airbag (Live)', artist: { name: 'Radiohead' } },
      ]) },
    };
    const { service } = build({ prisma });
    const result = await service.searchThroughTracks('airbag');
    expect(result).toEqual([
      { artistName: 'Radiohead', trackName: 'Airbag' },
      { artistName: 'Radiohead', trackName: 'Airbag (Live)' },
    ]);
  });

  it('returns empty array when the query throws', async () => {
    const prisma = {
      track: { findMany: vi.fn(async () => { throw new Error('db down'); }) },
    };
    const { service } = build({ prisma });
    await expect(service.searchThroughTracks('Airbag')).resolves.toEqual([]);
  });
});
