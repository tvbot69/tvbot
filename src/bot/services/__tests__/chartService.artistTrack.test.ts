import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChartService, NotEnoughAlbumsError, TooManyImagesError } from '../chartService';
import { isPlaceholderImageUrl } from '@domain/lastfmPlaceholder';
import type { ChartSettings } from '@bot/models/chartModels';
import { TimePeriod } from '@domain/enums/timePeriod';

/**
 * The two chart paths the existing album-focused file never touches.
 *
 * `chartService.unit.test.ts` covers `generateAlbumChart` end to end and
 * `chartService.render.test.ts` renders a real album PNG, so `generateArtistChart`
 * and `generateTrackChart` had no unit coverage at all - roughly half the class.
 * They are not copies of the album path:
 *
 *   - the artist chart has NO artist filter (a chart of one artist would be
 *     pointless) and reaches `artworkService.getArtistImageUrl` directly, not
 *     through the shared cover resolver;
 *   - the track chart filters by artist, and its cover resolver has a Last.fm
 *     fallback with a placeholder gate, which is where AGENTS.md rule 2 lives.
 *
 * The property under test throughout: a cover that could not be resolved is
 * `undefined`, never the Last.fm placeholder. The predicate is imported from
 * `@domain/lastfmPlaceholder` rather than re-implemented, so a change to the
 * hash cannot make this file agree with a stale copy.
 */

const settings = (over: Partial<ChartSettings> = {}): ChartSettings =>
  ({
    imagesNeeded: 3,
    width: 3,
    height: 1,
    timespanString: 'Alltime',
    titleSetting: 'Titles',
    artistChart: false,
    trackChart: false,
    ...over,
  }) as ChartSettings;

const artist = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  playcount: 1,
  ...over,
});

const track = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  artistName: 'Radiohead',
  playcount: 1,
  ...over,
});

/**
 * Every mock that the service inspects its call arguments on declares
 * `...args: unknown[]`. A zero-arg `vi.fn()` infers a `[]` call tuple, so
 * `calls[0][2]` is a COMPILE error that vitest happily runs.
 */
const build = (over: Record<string, unknown> = {}) => {
  const artworkService = {
    getAlbumCoverUrl: vi.fn(async (_album: string, _artist: string) => 'https://img/album.png'),
    getArtistImageUrl: vi.fn(async (_name: string) => 'https://img/artist.png'),
    getTrackCoverUrl: vi.fn(async (_track: string, _artist: string) => 'https://img/track.png'),
    ...(over.artworkService as object),
  };
  const lastfmRepository = {
    getTopAlbums: vi.fn(async () => []),
    getTopArtists: vi.fn(async () => [artist('A'), artist('B'), artist('C'), artist('D')]),
    getTopTracks: vi.fn(async () => [track('X'), track('Y'), track('Z'), track('W')]),
    ...(over.lastfmRepository as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1 })),
    enqueueUserUpdate: vi.fn(),
    ...(over.userService as object),
  };
  const enrichmentService = { enrichTopAlbums: vi.fn(async () => undefined), ...(over.enrichmentService as object) };
  const imageChartService = { generateChart: vi.fn(async () => Buffer.from('png')), ...(over.imageChartService as object) };
  const imageUploadService = {
    uploadToStagingChannel: vi.fn(async () => 'https://cdn/chart.png'),
    ...(over.imageUploadService as object),
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined), ...(over.cache as object) };
  const service = new ChartService(
    artworkService as never,
    lastfmRepository as never,
    userService as never,
    enrichmentService as never,
    imageChartService as never,
    imageUploadService as never,
    over.noCache ? undefined : (cache as never),
  );
  return { service, artworkService, lastfmRepository, userService, imageChartService, imageUploadService, cache };
};

beforeEach(() => vi.clearAllMocks());

describe('ChartService.generateArtistChart', () => {
  it('refuses a request for more than 100 images', async () => {
    const { service } = build();
    await expect(
      service.generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 101 })),
    ).rejects.toBeInstanceOf(TooManyImagesError);
  });

  it('reports an upstream shortfall as `upstream`, because nothing was filtered', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([artist('Only')]);

    const err = await service
      .generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 5 }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('upstream');
    expect((err as NotEnoughAlbumsError).available).toBe(1);
  });

  it('uploads the rendered chart and returns the URL rather than the buffer', async () => {
    const { service, imageUploadService } = build();
    const result = await service.generateArtistChart('u1', 'DreadRock', settings());
    expect(imageUploadService.uploadToStagingChannel).toHaveBeenCalled();
    expect(result.imageUrl).toBe('https://cdn/chart.png');
    expect(result.buffer).toBeUndefined();
  });

  it('returns the buffer when no staging channel is configured', async () => {
    const { service } = build({ imageUploadService: { uploadToStagingChannel: vi.fn(async () => null) } });
    const result = await service.generateArtistChart('u1', 'DreadRock', settings());
    expect(result.imageUrl).toBeUndefined();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it('names the file for an artist chart, so two charts in one sweep do not collide', async () => {
    const { service, imageUploadService } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings({ artistChart: true, width: 4, height: 2 }));
    const fileName = (imageUploadService.uploadToStagingChannel as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(fileName).toContain('artist-chart');
    expect(fileName).toContain('4w');
    expect(fileName).toContain('2h');
  });

  it('strips whitespace from the filename, which Discord rejects', async () => {
    const { service, imageUploadService } = build();
    await service.generateArtistChart('u1', 'All Time', settings());
    const fileName = (imageUploadService.uploadToStagingChannel as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(fileName).toBe('album-chart-3w-1h-Alltime-AllTime.png');
  });

  it('resolves each artist through the artwork cascade, by name only', async () => {
    const { service, artworkService } = build();
    const result = await service.generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 2 }));
    expect(result.artistsUsed?.map((a) => a.name)).toEqual(['A', 'B']);
    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('A');
    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('B');
  });

  it('keeps an artist with no cover in normal mode, which renders a styled tile', async () => {
    // Dropping it would shrink the grid below the requested size and silently
    // move every rank; a fallback tile is the deliberate trade.
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    expect(result.artistsUsed).toHaveLength(3);
    expect(result.artistsUsed?.every((a) => a.imageUrl === undefined)).toBe(true);
  });

  it('drops the artists that have no cover when covers are mandatory', async () => {
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockImplementation(
      async (...args: unknown[]) => (args[0] === 'A' || args[0] === 'C' ? 'https://img/a.png' : null),
    );
    const result = await service.generateArtistChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 2, skipWithoutImage: true }),
    );
    expect(result.artistsUsed?.map((a) => a.name)).toEqual(['A', 'C']);
  });

  it('names `covers` - never `filters` - when too few artists have any cover', async () => {
    // No filter exists on the artist cascade at all, so `afterFilters: true` here
    // was a name that described a filter that could not have run. The card read
    // "remained after filters" off it.
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const err = await service
      .generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 3, skipWithoutImage: true }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('covers');
    expect((err as NotEnoughAlbumsError).available).toBe(0);
  });

  it('over-fetches artists when covers are mandatory, since some will not resolve', async () => {
    const { service, lastfmRepository } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 3, skipWithoutImage: true, height: 8 }));
    const asked = (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as number;
    expect(asked).toBeGreaterThan(3);
  });

  it('caps the over-fetch at 1000 rows, because Last.fm will not serve more', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => artist(`A${i}`)),
    );
    await service.generateArtistChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 100, width: 50, height: 2, skipWithoutImage: true }),
    );
    const asked = (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as number;
    expect(asked).toBeLessThanOrEqual(1000);
  });

  it('passes the requested window to Last.fm as unix seconds, not milliseconds', async () => {
    const { service, lastfmRepository } = build();
    const startDateTime = new Date('2026-02-01T00:00:00.000Z');
    const endDateTime = new Date('2026-02-08T00:00:00.000Z');
    await service.generateArtistChart(
      'u1', 'DreadRock', settings({ timeSettings: { timePeriod: TimePeriod.Custom, startDateTime, endDateTime } as never }),
    );
    const call = (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBe(TimePeriod.Custom);
    expect(call[5]).toBe(Math.floor(startDateTime.getTime() / 1000));
    expect(call[6]).toBe(Math.floor(endDateTime.getTime() / 1000));
  });

  it('defaults to the weekly period when the caller set no time settings', async () => {
    const { service, lastfmRepository } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings());
    const call = (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBe(TimePeriod.Weekly);
    expect(call[5]).toBeUndefined();
    expect(call[6]).toBeUndefined();
  });

  it('caches the artist chart and serves the cache without querying again', async () => {
    const { service, cache, lastfmRepository } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings());
    expect(cache.set).toHaveBeenCalled();

    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({ imageUrl: 'https://cdn/cached.png' });
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockClear();
    const result = await service.generateArtistChart('u1', 'DreadRock', settings());

    expect(result.imageUrl).toBe('https://cdn/cached.png');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('does not treat a cached entry with neither url nor buffer as a hit', async () => {
    // `albumsUsed` alone is not a servable chart; treating it as a hit would
    // return an image-less result forever.
    const { service, cache, lastfmRepository } = build();
    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({ albumsUsed: [] });
    await service.generateArtistChart('u1', 'DreadRock', settings());
    expect(lastfmRepository.getTopArtists).toHaveBeenCalled();
  });

  it('gives a different artist chart its own cache entry', async () => {
    const { service, cache } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings({ rainbowSortingEnabled: true }));
    const rainbow = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    (cache.set as ReturnType<typeof vi.fn>).mockClear();
    await service.generateArtistChart('u1', 'DreadRock', settings({ rainbowSortingEnabled: false }));
    const plain = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rainbow).not.toBe(plain);
  });

  it('normalises the Last.fm username in the cache key, so one user is one entry', async () => {
    const { service, cache } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings());
    const lower = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    (cache.set as ReturnType<typeof vi.fn>).mockClear();
    await service.generateArtistChart('u1', 'DREADROCK', settings());
    const upper = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(lower).toBe(upper);
  });

  it('queues a user update so the chart advances their sync state', async () => {
    const { service, userService } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings());
    expect(userService.enqueueUserUpdate).toHaveBeenCalledTimes(1);
  });

  it('still returns the chart when the user row is gone', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.generateArtistChart('u1', 'DreadRock', settings());
    expect(result.imageUrl).toBe('https://cdn/chart.png');
    expect(userService.enqueueUserUpdate).not.toHaveBeenCalled();
  });

  it('renders exactly one grid row set of items, matching the requested size', async () => {
    const { service, imageChartService } = build();
    await service.generateArtistChart('u1', 'DreadRock', settings({ imagesNeeded: 2, width: 2, height: 1 }));
    const args = (imageChartService.generateChart as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[0]).toHaveLength(2);
    expect(args[1]).toMatchObject({ rows: 1, columns: 2 });
  });
});

describe('ChartService.generateTrackChart', () => {
  it('refuses a request for more than 100 images', async () => {
    const { service } = build();
    await expect(
      service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 101, trackChart: true })),
    ).rejects.toBeInstanceOf(TooManyImagesError);
  });

  it('reports an upstream shortfall as `upstream`', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([track('Only')]);
    const err = await service
      .generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 4 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('upstream');
  });

  it('keeps only tracks by the filtered artist, case-insensitively', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('OK', { artistName: 'Radiohead' }),
      track('Blue', { artistName: 'Massive Attack' }),
    ]);
    const result = await service.generateTrackChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, filteredArtistName: 'RADIOHEAD' }),
    );
    expect(result.tracksUsed?.map((t) => t.name)).toEqual(['OK']);
  });

  it('over-fetches the whole library when an artist filter is set', async () => {
    // A filter is applied after the fetch, so asking for only `imagesNeeded`
    // would render a half-empty grid whenever the artist scrolled off page 1.
    const { service, lastfmRepository } = build();
    await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 2, filteredArtistName: 'Radiohead' }));
    const asked = (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as number;
    expect(asked).toBe(1000);
  });

  it('names `filters` for an artist-filter shortfall, because a filter demonstrably ran', async () => {
    // The artist filter runs before the cover pass and shares the first
    // `NotEnoughAlbumsError`, so this must NOT be `upstream` — that told the user
    // to make the chart smaller or change period, which cannot help when the
    // cause is that they have two Radiohead tracks.
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('A', { artistName: 'Radiohead' }),
      track('B', { artistName: 'Radiohead' }),
    ]);
    const err = await service
      .generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 3, filteredArtistName: 'Radiohead' }))
      .catch((e: unknown) => e);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('filters');
    expect((err as NotEnoughAlbumsError).available).toBe(2);
  });

  it('CONTROL: an upstream shortfall with no filter is still `upstream`', async () => {
    // So the pair above cannot both pass by the cause always being `filters`.
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([track('Only')]);
    const err = await service
      .generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 4 }))
      .catch((e: unknown) => e);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('upstream');
  });

  it('resolves each track cover through the artwork cascade', async () => {
    const { service, artworkService } = build();
    await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 2 }));
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('X', 'Radiohead');
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalledWith('Y', 'Radiohead');
  });

  it('falls back to a real Last.fm cover when the cascade finds nothing', async () => {
    const { service, artworkService, lastfmRepository } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('X', { imageUrl: 'https://lastfm.example/real.png' }),
      track('Y'),
      track('Z'),
    ]);
    const result = await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    expect(result.tracksUsed?.[0]?.imageUrl).toBe('https://lastfm.example/real.png');
  });

  it('never serves the Last.fm placeholder as a cover', async () => {
    // Rule 2: that hash is what Last.fm returns for "no image", and rendering it
    // produces a 1x1 transparent tile in the middle of the chart.
    const { service, artworkService, lastfmRepository } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('X', { imageUrl: 'https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png' }),
      track('Y'),
      track('Z'),
    ]);
    const result = await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    expect(result.tracksUsed?.[0]?.imageUrl).toBeUndefined();
  });

  it('never serves the placeholder the cascade itself returned', async () => {
    // A provider that echoes Last.fm's hash back through the cascade must not
    // be able to put it on the card either.
    const { service, artworkService } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>)
      .mockResolvedValue('https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png');
    const result = await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 1 }));
    expect(result.tracksUsed?.[0]?.imageUrl).toBeUndefined();
  });

  it('prefers the cascade result over a Last.fm cover', async () => {
    const { service, artworkService, lastfmRepository } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://img/better.png');
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('X', { imageUrl: 'https://lastfm.example/real.png' }),
      track('Y'),
      track('Z'),
    ]);
    const result = await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    expect(result.tracksUsed?.[0]?.imageUrl).toBe('https://img/better.png');
  });

  it('drops unresolvable tracks when covers are mandatory', async () => {
    // `imagesNeeded` is a FLOOR, not a hint: the mandatory-cover branch throws
    // rather than rendering a chart with fewer tiles than were asked for
    // (chartService.ts:390). So the drop is observable at `imagesNeeded: 1`,
    // where one cover survives and the other three are dropped.
    const { service, artworkService } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockImplementation(
      async (...args: unknown[]) => (args[0] === 'X' ? 'https://img/x.png' : null),
    );
    const result = await service.generateTrackChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, skipWithoutImage: true }),
    );
    expect(result.tracksUsed?.map((t) => t.name)).toEqual(['X']);
  });

  it('names `covers` when some covers resolve but still not enough', async () => {
    // The distinct branch from "no track has a cover at all": Last.fm supplied
    // plenty, the COVER pass is what fell short. Without a cause that says so, a
    // user is told their library is short rather than that the artwork lookup
    // failed.
    const { service, artworkService } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockImplementation(
      async (...args: unknown[]) => (args[0] === 'X' ? 'https://img/x.png' : null),
    );
    const err = await service
      .generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 2, skipWithoutImage: true }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('covers');
    expect((err as NotEnoughAlbumsError).available).toBe(1);
  });

  it('names `covers` when no track has a cover at all', async () => {
    const { service, artworkService } = build();
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const err = await service
      .generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 1, skipWithoutImage: true }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('covers');
  });

  it('names the file for a track chart', async () => {
    const { service, imageUploadService } = build();
    await service.generateTrackChart('u1', 'DreadRock', settings({ trackChart: true }));
    const fileName = (imageUploadService.uploadToStagingChannel as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(fileName).toContain('track-chart');
  });

  it('caches the track chart and serves the next call from memory', async () => {
    const { service, cache, lastfmRepository, imageChartService, imageUploadService } = build();
    await service.generateTrackChart('u1', 'DreadRock', settings());
    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue({ imageUrl: 'https://cdn/cached.png' });
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockClear();
    (imageChartService.generateChart as ReturnType<typeof vi.fn>).mockClear();
    (imageUploadService.uploadToStagingChannel as ReturnType<typeof vi.fn>).mockClear();

    const result = await service.generateTrackChart('u1', 'DreadRock', settings());

    // The CACHED url, not a fresh upload: a cache hit means nothing is
    // re-rendered and nothing is re-queried.
    expect(result.imageUrl).toBe('https://cdn/cached.png');
    expect(result.buffer).toBeUndefined();
    expect(imageChartService.generateChart).not.toHaveBeenCalled();
    expect(imageUploadService.uploadToStagingChannel).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopTracks).not.toHaveBeenCalled();
  });

  it('caches an artist filter in the key, NORMALISED, so two spellings share one entry', async () => {
    // Both filters have to be satisfiable. The track chart throws
    // `NotEnoughAlbumsError` BEFORE it ever writes the cache, so a filter with
    // no matching tracks would never produce a second key to compare against.
    const { service, cache, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('A', { artistName: 'Radiohead' }),
      track('B', { artistName: 'Radiohead' }),
      track('C', { artistName: 'Radiohead' }),
      track('P', { artistName: 'Portishead' }),
      track('Q', { artistName: 'Portishead' }),
      track('R', { artistName: 'Portishead' }),
    ]);

    await service.generateTrackChart('u1', 'DreadRock', settings({ filteredArtistName: 'Radiohead' }));
    const filtered = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    (cache.set as ReturnType<typeof vi.fn>).mockClear();
    await service.generateTrackChart('u1', 'DreadRock', settings({ filteredArtistName: 'Portishead' }));
    const other = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

    // Distinct filters must still be distinct keys, or a Portishead chart is
    // served from a Radiohead entry — that is the part that was always true.
    expect(filtered).toContain('radiohead');
    expect(other).toContain('portishead');
    expect(filtered).not.toBe(other);
  });

it('two spellings of one artist filter are ONE cache entry, not two renders', async () => {
    // The filter is applied with `toLowerCase()`, so `Radiohead` and `radiohead`
    // select exactly the same tracks — but the key used to carry the raw
    // spelling, so each got its own entry and each cost a Last.fm read and a
    // Puppeteer render for a byte-identical result. Duplicate work, never a
    // wrong answer, which is why it survived.
    const { service, cache, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('A', { artistName: 'Radiohead' }),
      track('B', { artistName: 'Radiohead' }),
    ]);

    await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 2, filteredArtistName: 'Radiohead' }));
    await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 2, filteredArtistName: 'radiohead' }));

    // BOTH calls' writes are collected — clearing the mock between them would
    // leave one key either way and make this test pass on the code it is
    // written against.
    const keys = (cache.set as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // The filter segment is lowercased. (The timespan and title segments are
    // settings the caller spells and are not part of this claim.)
    expect(keys[0]).toContain(':radiohead:');
    expect(keys[0]).not.toContain(':Radiohead:');
  });

  it('an unfiltered chart is still keyed apart from a filtered one', async () => {
    // `undefined` must not collapse onto the string "all" by accident, and the
    // filtered key must not contain the literal "all" in a way that would.
    const { service, cache, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      track('A', { artistName: 'Radiohead' }),
      track('B', { artistName: 'Portishead' }),
      track('C', { artistName: 'Massive Attack' }),
    ]);

    await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    const unfiltered = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    (cache.set as ReturnType<typeof vi.fn>).mockClear();
    await service.generateTrackChart('u1', 'DreadRock', settings({ imagesNeeded: 1, filteredArtistName: 'Radiohead' }));
    const filtered = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

    expect(unfiltered).toContain(':all:');
    expect(filtered).not.toBe(unfiltered);
  });

  it('queues a user update and survives a missing user row', async () => {
    const { service, userService } = build();
    await service.generateTrackChart('u1', 'DreadRock', settings());
    expect(userService.enqueueUserUpdate).toHaveBeenCalledTimes(1);

    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.generateTrackChart('u1', 'DreadRock', settings());
    expect(result.imageUrl).toBe('https://cdn/chart.png');
  });
});

describe('ChartService cover concurrency helper', () => {
  const mapWithConcurrency = async (
    service: ChartService,
    input: number[],
    limit: number,
  ): Promise<number[]> =>
    (
      service as unknown as {
        mapWithConcurrency<TIn, TOut>(i: TIn[], l: number, fn: (x: TIn) => Promise<TOut>): Promise<TOut[]>;
      }
    ).mapWithConcurrency(input, limit, async (n: number) => n * 10);

  it('preserves input order even though the workers interleave', async () => {
    // The chart is a RANKING. An implementation that pushed results as they
    // resolved would silently reorder the grid on a slow cover fetch.
    const { service } = build();
    const out = await mapWithConcurrency(service, [1, 2, 3, 4, 5, 6, 7], 3);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('never exceeds the concurrency limit', async () => {
    const { service } = build();
    let live = 0;
    let peak = 0;
    await (
      service as unknown as {
        mapWithConcurrency<TIn, TOut>(i: TIn[], l: number, fn: (x: TIn) => Promise<TOut>): Promise<TOut[]>;
      }
    ).mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (n: number) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('returns an empty result for an empty input instead of hanging', async () => {
    const { service } = build();
    await expect(mapWithConcurrency(service, [], 6)).resolves.toEqual([]);
  });
});

describe('isPlaceholderImageUrl, the single gate the chart paths rely on', () => {
  it('treats absent and placeholder URLs alike, so `!predicate` rejects both', () => {
    expect(isPlaceholderImageUrl(undefined)).toBe(true);
    expect(isPlaceholderImageUrl(null)).toBe(true);
    expect(isPlaceholderImageUrl('')).toBe(true);
    expect(isPlaceholderImageUrl('https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png')).toBe(true);
    expect(isPlaceholderImageUrl('https://img/real.png')).toBe(false);
  });
});
