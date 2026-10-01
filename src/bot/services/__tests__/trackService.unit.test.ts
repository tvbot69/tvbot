import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TrackService } from '../trackService';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * trackService was 14.95% with 364 uncovered lines - the same shape of gap as
 * albumService, and the same `searchTrack` entry point behind every `.track`
 * command.
 *
 * Two behaviours here differ from albumService and are worth pinning
 * deliberately:
 *
 *  1. The cover has a THREE-step fallback: artwork service, then the album
 *     cover from Last.fm, then the track image. Each step is placeholder-
 *     filtered, so the grey box never wins even when it is the only candidate.
 *  2. When the Last.fm search finds nothing, this service does NOT return
 *     null. It falls through to artist "Unknown Artist" and searches anyway.
 *     albumService returns null in the same situation. Asserted so the
 *     difference is deliberate rather than an accident someone tidies away.
 */

const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';
const placeholderUrl = 'https://lastfm-img.freetls.fastly.net/i/u/300x300/' + PLACEHOLDER + '.png';

const user = { userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK' } as User;

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
  const service = new TrackService(
    lastfmRepository as never,
    artistRepository as never,
    trackRepository as never,
    whoKnowsRepository as never,
    artworkService as never,
    cache as never,
  );
  return { service, lastfmRepository, artistRepository, trackRepository, whoKnowsRepository, artworkService, cache };
};

/** What the service ASKED Last.fm for - the parsed pair, not the resolved one. */
const asked = (lastfmRepository: unknown) =>
  (lastfmRepository as { getTrackInfo: ReturnType<typeof vi.fn> }).getTrackInfo.mock.calls[0];

describe('TrackService.searchTrack grammar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for an empty query when the user has no recent tracks', async () => {
    const { service } = build();
    await expect(service.searchTrack('', user)).resolves.toBeNull();
    await expect(service.searchTrack(undefined, user)).resolves.toBeNull();
  });

  it('falls back to the latest scrobble when no track is named', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      tracks: [{ name: 'Airbag', artistName: 'Radiohead' }],
      totalPages: 1,
      totalScrobbles: 1,
    });
    await service.searchTrack('', user);
    expect(asked(lastfmRepository)?.slice(0, 2)).toEqual(['Airbag', 'Radiohead']);
  });

  it('picks a random top track for "random"', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Karma Police', artistName: 'Radiohead', playcount: 1 },
    ]);
    await service.searchTrack('random', user);
    expect(asked(lastfmRepository)?.slice(0, 2)).toEqual(['Karma Police', 'Radiohead']);
  });

  it('returns null for "random" when the user has no top tracks', async () => {
    const { service } = build();
    await expect(service.searchTrack('random', user)).resolves.toBeNull();
  });

  it('splits "Artist | Track" on the pipe', async () => {
    const { service, lastfmRepository } = build();
    await service.searchTrack('Radiohead | Airbag', user);
    expect(asked(lastfmRepository)?.slice(0, 2)).toEqual(['Airbag', 'Radiohead']);
  });

  it('splits "Track by Artist" with the artist on the right, case-insensitively', async () => {
    const { service, lastfmRepository } = build();
    await service.searchTrack('Airbag BY Radiohead', user);
    expect(asked(lastfmRepository)?.slice(0, 2)).toEqual(['Airbag', 'Radiohead']);
  });

  it('uses the first Last.fm result for a bare search', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Idioteque', artistName: 'Radiohead', playcount: 0 },
    ]);
    await service.searchTrack('idioteque', user);
    expect(asked(lastfmRepository)?.slice(0, 2)).toEqual(['Idioteque', 'Radiohead']);
  });

  it('still searches with "Unknown Artist" when Last.fm finds nothing', async () => {
    // Deliberately NOT null, unlike albumService: the user gets a result from
    // the artwork/DB layers rather than a dead end.
    const { service, lastfmRepository } = build();
    (lastfmRepository.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await service.searchTrack('some obscure song', user);
    expect(asked(lastfmRepository)?.slice(0, 2)).toEqual(['some obscure song', 'Unknown Artist']);
    expect(result).not.toBeNull();
  });
});

describe('TrackService.searchTrack cover resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the artwork service cover', async () => {
    const { service, artworkService } = build();
    const result = await service.searchTrack('Radiohead | Airbag', user);
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalled();
    expect(result?.coverUrl).toBe('https://img/resolved.png');
  });

  it('falls back to the album cover when artwork returns a placeholder', async () => {
    const { service, artworkService } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(placeholderUrl);
    const result = await service.searchTrack('Radiohead | Airbag', user);
    expect(result?.coverUrl).toBe('https://img/album.png');
  });

  it('falls back again to the track image when the album cover is a placeholder', async () => {
    const { service, artworkService, lastfmRepository } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (lastfmRepository.getTrackInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'Airbag', artistName: 'Radiohead', albumCoverUrl: placeholderUrl, imageUrl: 'https://img/track.png',
    });
    const result = await service.searchTrack('Radiohead | Airbag', user);
    expect(result?.coverUrl).toBe('https://img/track.png');
  });

  it('leaves the cover undefined rather than falling back to the grey box', async () => {
    const { service, artworkService, lastfmRepository } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(placeholderUrl);
    (lastfmRepository.getTrackInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'Airbag', artistName: 'Radiohead', albumCoverUrl: placeholderUrl, imageUrl: placeholderUrl,
    });
    const result = await service.searchTrack('Radiohead | Airbag', user);
    expect(result?.coverUrl ?? '').not.toContain(PLACEHOLDER);
  });
});

describe('TrackService.searchTrack server stats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums guild playcounts and counts distinct listeners', async () => {
    const { service } = build();
    const result = await service.searchTrack('Radiohead | Airbag', user, 'guild-1');
    expect(result?.serverPlaycount).toBe(7);
    expect(result?.serverListeners).toBe(2);
  });

  it('omits server stats when there is no guild context', async () => {
    const { service, whoKnowsRepository } = build();
    const result = await service.searchTrack('Radiohead | Airbag', user);
    expect(result?.serverPlaycount).toBeUndefined();
    expect(whoKnowsRepository.getIndexedUsersForTrack).not.toHaveBeenCalled();
  });

  it('still returns a result when the guild lookup throws', async () => {
    const { service, artistRepository } = build();
    (artistRepository.getArtistByName as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const result = await service.searchTrack('Radiohead | Airbag', user, 'guild-1');
    expect(result).not.toBeNull();
    expect(result?.serverPlaycount).toBeUndefined();
  });

  it('builds Last.fm URLs from the resolved names when the info has none', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTrackInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.searchTrack('Radiohead | Airbag', user);
    expect(result?.trackUrl).toBe('https://www.last.fm/music/Radiohead/_/Airbag');
    expect(result?.artistUrl).toBe('https://www.last.fm/music/Radiohead');
  });

  it('percent-encodes names that contain a slash', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTrackInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.searchTrack('AC/DC | Back In Black', user);
    expect(result?.artistUrl).toContain('AC%2FDC');
  });
});
