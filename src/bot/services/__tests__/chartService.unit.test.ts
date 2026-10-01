import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChartService, NotEnoughAlbumsError, TooManyImagesError } from '../chartService';
import type { ChartSettings } from '@bot/models/chartModels';

/**
 * chartService was 10.44% with 420 uncovered lines - the largest single
 * service gap left.
 *
 * The generate path is a pipeline of FILTERS, and the order matters more than
 * any individual step: a chart can fail with "not enough albums" for three
 * different reasons - too few fetched, too few after filtering, or too few that
 * actually have a cover. `shortfallCause` is what tells those apart, so these
 * tests assert it rather than just "it threw" - and they assert the OPPOSITE
 * cause for the neighbouring scenario in each case, because a single boolean
 * kept all three passing at once.
 *
 * `chartBuilders.honesty.test.ts` is the other half: these pin which stage the
 * service names, that file pins what the user is told about it.
 */

const settings = (over: Partial<ChartSettings> = {}): ChartSettings =>
  ({
    imagesNeeded: 3,
    width: 3,
    height: 1,
    timespanString: 'Alltime',
    titleSetting: 'Titles',
    ...over,
  }) as ChartSettings;

const album = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  artistName: 'Radiohead',
  playcount: 1,
  ...over,
});

const build = (over: Record<string, unknown> = {}) => {
  const artworkService = {
    getAlbumCoverUrl: vi.fn(async () => 'https://img/cover.png'),
    ...(over.artworkService as object),
  };
  const lastfmRepository = {
    getTopAlbums: vi.fn(async () => [
      album('A'), album('B'), album('C'), album('D'),
    ]),
    getTopArtists: vi.fn(async () => []),
    getTopTracks: vi.fn(async () => []),
    ...(over.lastfmRepository as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1 })),
    enqueueUserUpdate: vi.fn(),
    ...(over.userService as object),
  };
  const enrichmentService = {
    enrichTopAlbums: vi.fn(async (list: unknown[]) => {
      // Stand-in for the real enrichment: stamps a release date so a filter
      // has something to act on. A stub that did nothing would make every
      // release-filter test pass vacuously.
      for (const a of list as Array<Record<string, unknown>>) {
        if (!a.releaseDate) a.releaseDate = new Date(Date.UTC(1997, 4, 21));
      }
    }),
    ...(over.enrichmentService as object),
  };
  const imageChartService = {
    generateChart: vi.fn(async () => Buffer.from('png')),
    ...(over.imageChartService as object),
  };
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
  return { service, artworkService, lastfmRepository, userService, enrichmentService, imageChartService, imageUploadService, cache };
};

beforeEach(() => vi.clearAllMocks());

describe('ChartService.getDimensions', () => {
  it('accepts a valid size option and reports the change', () => {
    const cs = settings({ width: 1, height: 1 });
    const out = ChartService.getDimensions(cs, '5x4');
    expect(out.changed).toBe(true);
    expect(cs.width).toBe(5);
    expect(cs.height).toBe(4);
  });

  it('rejects a grid larger than 100 cells, which Discord cannot render', () => {
    const cs = settings({ width: 2, height: 2 });
    const out = ChartService.getDimensions(cs, '50x50');
    expect(out.changed).toBe(false);
    expect(cs.width).toBe(2);
  });

  it.each(['0x5', '5x0', '51x5', '5x51', 'abc', '5', '', '5x5x5', '-1x5'])(
    'ignores the invalid option %p',
    (option) => {
      const cs = settings({ width: 3, height: 3 });
      const out = ChartService.getDimensions(cs, option);
      expect(out.changed).toBe(false);
      expect(cs.width).toBe(3);
    },
  );

  it('defaults a zero dimension rather than rendering a zero-sized image', () => {
    const cs = settings({ width: 0, height: 0 });
    ChartService.getDimensions(cs, null);
    expect(cs.width).toBeGreaterThan(0);
    expect(cs.height).toBeGreaterThan(0);
  });

  it('leaves a valid existing size alone when no option is given', () => {
    const cs = settings({ width: 4, height: 2 });
    const out = ChartService.getDimensions(cs, null);
    expect(out.changed).toBe(false);
    expect(cs.width).toBe(4);
  });
});

describe('ChartService.generateAlbumChart validation', () => {
  it('refuses a request for more than 100 images', async () => {
    const { service } = build();
    await expect(
      service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 101 })),
    ).rejects.toBeInstanceOf(TooManyImagesError);
  });

  it('throws NotEnoughAlbumsError when too few albums come back', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([album('Only')]);

    const err = await service
      .generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 5 }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    // `upstream`: the shortfall is the fetch itself, nothing was filtered.
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('upstream');
    expect((err as NotEnoughAlbumsError).available).toBe(1);
    expect((err as NotEnoughAlbumsError).required).toBe(5);
  });

  it('names `filters` when the shortfall happens after release filtering', async () => {
    const { service, enrichmentService } = build();
    (enrichmentService.enrichTopAlbums as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);

    const err = await service
      .generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, releaseYearFilter: 1990 }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('filters');
  });

  it('names `filters` for an ARTIST-filter shortfall, because that filter ran too', async () => {
    // The artist filter is applied before the release filters and shares this
    // error. It used to be indistinguishable from a release-filter shortfall,
    // which is fine for advice but wrong for the copy: the user who asked for
    // `artist Radiohead` and has two Radiohead albums must not be told their
    // release filter removed the rest.
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      album('OK Computer'), album('Kid A'),
    ]);

    const err = await service
      .generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, filteredArtistName: 'Radiohead' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('filters');
    expect((err as NotEnoughAlbumsError).available).toBe(2);
  });

  it('CONTROL: an empty artist filter is not a filter that ran', async () => {
    // `filteredArtistName: ''` is falsy, so the filter is skipped entirely and
    // the shortfall really is upstream. Keying the cause off `!== undefined`
    // instead would claim a filter ran when it did not.
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([album('Only')]);

    const err = await service
      .generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, filteredArtistName: '' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('upstream');
    expect((err as NotEnoughAlbumsError).available).toBe(1);
  });
});

describe('ChartService album cache key', () => {
  it('carries the artist filter NORMALISED, so two spellings are one entry', async () => {
    // The key held the raw spelling while the filter ran on `toLowerCase()`, so
    // `Radiohead` and `radiohead` each cost a Last.fm read and a Puppeteer render
    // for a byte-identical result. Duplicate work, never a wrong answer.
    const { service, cache } = build();

    await service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, filteredArtistName: 'Radiohead' }));
    await service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, filteredArtistName: 'radiohead' }));

    // BOTH calls' writes are collected — clearing the mock between them would
    // leave one key either way and make this pass on the code it is written
    // against.
    const keys = (cache.set as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain(':radiohead:');
  });

  it('still keys an unfiltered album chart apart from a filtered one', async () => {
    const { service, cache } = build();

    await service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    const unfiltered = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    (cache.set as ReturnType<typeof vi.fn>).mockClear();
    await service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 1, filteredArtistName: 'Radiohead' }));
    const filtered = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;

    expect(unfiltered).toContain(':all:');
    expect(filtered).not.toBe(unfiltered);
  });
});

describe('ChartService.generateAlbumChart filters', () => {
  it('keeps only albums matching the artist filter, case-insensitively', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      album('OK Computer', { artistName: 'Radiohead' }),
      album('Blue Lines', { artistName: 'Massive Attack' }),
      album('Dummy', { artistName: 'Portishead' }),
    ]);

    const result = await service.generateAlbumChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, filteredArtistName: 'radiohead' }),
    );

    expect(result.albumsUsed?.map((a) => a.name)).toEqual(['OK Computer']);
  });

  it('keeps only albums released inside the requested year', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      album('In 1997', { releaseDate: new Date(Date.UTC(1997, 0, 1)) }),
      album('In 2005', { releaseDate: new Date(Date.UTC(2005, 0, 1)) }),
    ]);

    const result = await service.generateAlbumChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, releaseYearFilter: 1997 }),
    );

    expect(result.albumsUsed?.map((a) => a.name)).toEqual(['In 1997']);
  });

  it('keeps only albums inside the requested decade', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      album('1990s', { releaseDate: new Date(Date.UTC(1995, 0, 1)) }),
      album('2000s', { releaseDate: new Date(Date.UTC(2005, 0, 1)) }),
    ]);

    const result = await service.generateAlbumChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, releaseDecadeFilter: 1990 }),
    );

    expect(result.albumsUsed?.map((a) => a.name)).toEqual(['1990s']);
  });

  it('drops singles when the filter is on', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      album('Real Album', { albumType: 'album' }),
      album('A Single', { albumType: 'single' }),
    ]);

    const result = await service.generateAlbumChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, filterSingles: true }),
    );

    expect(result.albumsUsed?.map((a) => a.name)).toEqual(['Real Album']);
  });

  it('treats a missing albumType as an album rather than dropping it', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([
      album('Unknown Type', {}),
    ]);

    const result = await service.generateAlbumChart(
      'u1', 'DreadRock', settings({ imagesNeeded: 1, filterSingles: true }),
    );

    expect(result.albumsUsed).toHaveLength(1);
  });

  it('only fetches enough albums to fill the grid when nothing is filtered', async () => {
    const { service, lastfmRepository } = build();
    await service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3 }));
    const asked = (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(asked).toBe(13); // 3 + 10 slack
  });

  it('over-fetches when covers are required, since some will not resolve', async () => {
    const { service, lastfmRepository } = build();
    await service.generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, skipWithoutImage: true }));
    const asked = (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(asked).toBeGreaterThan(13);
  });

  it('names `covers` - never `filters` - when too few albums have a usable cover', async () => {
    // THE DIRECTION THAT WAS LYING. No release, decade, singles or artist filter
    // is set on this path, so nothing was filtered; reporting anything but
    // `covers` here is what made the card tell a user to widen a filter they
    // never used. `chartBuilders.honesty.test.ts` pins the sentence that follows.
    const { service, artworkService } = build();
    (artworkService.getAlbumCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const err = await service
      .generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, skipWithoutImage: true }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('covers');
    // `available` is the number WITH a cover here, which is why the card must not
    // read it as a listening total.
    expect((err as NotEnoughAlbumsError).available).toBe(0);
  });

  it('names `filters` - never `covers` - when the release filter drops rows, with covers that would have resolved', async () => {
    // The control for the test above. Same service, same shortage of covers in
    // the `covers` case only; here every album resolves and the release filter is
    // the whole cause, so the two cannot both be satisfied by one constant.
    const { service, enrichmentService, artworkService } = build();
    (enrichmentService.enrichTopAlbums as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
    (artworkService.getAlbumCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://img/cover.png');

    const err = await service
      .generateAlbumChart('u1', 'DreadRock', settings({ imagesNeeded: 3, releaseYearFilter: 1990, skipWithoutImage: true }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotEnoughAlbumsError);
    expect((err as NotEnoughAlbumsError).shortfallCause).toBe('filters');
  });
});

describe('ChartService.generateAlbumChart output', () => {
  it('uploads the rendered chart and returns the URL', async () => {
    const { service, imageUploadService } = build();
    const result = await service.generateAlbumChart('u1', 'DreadRock', settings());
    expect(imageUploadService.uploadToStagingChannel).toHaveBeenCalled();
    expect(result.imageUrl).toBe('https://cdn/chart.png');
    expect(result.buffer).toBeUndefined();
  });

  it('returns the buffer when uploading is not configured', async () => {
    const { service } = build({
      imageUploadService: { uploadToStagingChannel: vi.fn(async () => undefined) },
    });
    const result = await service.generateAlbumChart('u1', 'DreadRock', settings());
    expect(result.imageUrl).toBeUndefined();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it('caches the result for later calls', async () => {
    const { service, cache } = build();
    await service.generateAlbumChart('u1', 'DreadRock', settings());
    expect(cache.set).toHaveBeenCalled();
  });

  it('serves a cached result without rendering again', async () => {
    const cached = { imageUrl: 'https://cdn/cached.png' };
    const { service, cache, imageChartService } = build();
    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue(cached);

    const result = await service.generateAlbumChart('u1', 'DreadRock', settings());

    expect(result).toEqual(cached);
    expect(imageChartService.generateChart).not.toHaveBeenCalled();
  });

  it('gives different users different cache entries', async () => {
    const { service, cache } = build();
    await service.generateAlbumChart('u1', 'DreadRock', settings());
    const keyA = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    (cache.set as ReturnType<typeof vi.fn>).mockClear();
    await service.generateAlbumChart('u1', 'SomeoneElse', settings());
    const keyB = (cache.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(keyA).not.toBe(keyB);
  });

  it('queues a user update so the chart advances their sync state', async () => {
    const { service, userService } = build();
    await service.generateAlbumChart('u1', 'DreadRock', settings());
    expect(userService.enqueueUserUpdate).toHaveBeenCalled();
  });

  it('still returns a chart when the user lookup finds nobody', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await service.generateAlbumChart('u1', 'DreadRock', settings());
    expect(result.imageUrl).toBe('https://cdn/chart.png');
    expect(userService.enqueueUserUpdate).not.toHaveBeenCalled();
  });
});
