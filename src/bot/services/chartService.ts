import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import type {
  TopAlbum,
  TopArtist,
  TopTrack,
} from '@domain/models/topLists';
import { DefaultChartSize, ChartSettings, TitleSetting } from '@bot/models/chartModels';
import { ArtworkService, isPlaceholderImageUrl } from './artworkService';
import { UserService } from './userService';
import { CacheService } from './cacheService';
import { AlbumEnrichmentService } from './albumEnrichmentService';
import { ImageUploadService } from './imageUploadService';
import { ChartService as ImageChartService } from '@images/generators/chartService';
import type { ChartItem } from '@images/models/chartModels';

const MAX_IMAGES = 100;
const COVER_FETCH_CONCURRENCY = 6;
const CELL_SIZE = 300;

const dimensionsRegex = /^([1-9]|[1-4][0-9]|50)x([1-9]|[1-4][0-9]|50)$/i;

export class NotEnoughAlbumsError extends Error {
  public readonly available: number;
  public readonly required: number;
  public readonly afterFilters: boolean;

  constructor(available: number, required: number, afterFilters = false) {
    super(`Not enough albums for chart: ${available}/${required}`);
    this.available = available;
    this.required = required;
    this.afterFilters = afterFilters;
  }
}

export class TooManyImagesError extends Error {}

export interface ChartResult {
  imageUrl?: string;
  buffer?: Buffer;
  albumsUsed?: TopAlbum[];
  artistsUsed?: TopArtist[];
  tracksUsed?: TopTrack[];
}

export class ChartService {
  private readonly artworkService: ArtworkService;
  private readonly lastfmRepository: ILastfmRepository;
  private readonly userService: UserService;
  private readonly enrichmentService: AlbumEnrichmentService;
  private readonly imageChartService: ImageChartService;
  private readonly imageUploadService: ImageUploadService;
  private readonly cache?: CacheService;

  constructor(
    artworkService: ArtworkService,
    lastfmRepository: ILastfmRepository,
    userService: UserService,
    enrichmentService: AlbumEnrichmentService,
    imageChartService: ImageChartService,
    imageUploadService: ImageUploadService,
    cache?: CacheService,
  ) {
    this.artworkService = artworkService;
    this.lastfmRepository = lastfmRepository;
    this.userService = userService;
    this.enrichmentService = enrichmentService;
    this.imageChartService = imageChartService;
    this.imageUploadService = imageUploadService;
    this.cache = cache;
  }

  public static getDimensions(
    chartSettings: ChartSettings,
    option?: string | null,
  ): { chartSettings: ChartSettings; changed: boolean } {
    let changed = false;

    if (option && dimensionsRegex.test(option)) {
      const [w, h] = option.toLowerCase().split('x');
      const width = Number(w);
      const height = Number(h);

      if (width * height > MAX_IMAGES) {
        return { chartSettings: chartSettings, changed: false };
      }
      chartSettings.width = width;
      chartSettings.height = height;
      changed = true;
    } else if (chartSettings.width === 0 || chartSettings.height === 0) {
      chartSettings.width = DefaultChartSize;
      chartSettings.height = DefaultChartSize;
    }

    return { chartSettings: chartSettings, changed: changed };
  }

  public async generateAlbumChart(
    discordUserId: string,
    userNameLastFm: string,
    chartSettings: ChartSettings,
    font?: string,
  ): Promise<ChartResult> {
    if (chartSettings.imagesNeeded > MAX_IMAGES) {
      throw new TooManyImagesError();
    }

    const cacheKey = `chart:album:${userNameLastFm.toLowerCase()}:${chartSettings.width}x${chartSettings.height}:${chartSettings.timespanString}:${chartSettings.titleSetting}:${chartSettings.filteredArtistName ?? 'all'}:${chartSettings.releaseYearFilter ?? 'all'}:${chartSettings.releaseDecadeFilter ?? 'all'}:${chartSettings.filterSingles ? '1' : '0'}:${chartSettings.rainbowSortingEnabled ? '1' : '0'}`;

    if (this.cache) {
      const cached = await this.cache.get<ChartResult>(cacheKey);
      if (cached && (cached.imageUrl || cached.buffer)) {
        return cached;
      }
    }

    const hasReleaseFilters =
      chartSettings.releaseYearFilter !== undefined ||
      chartSettings.releaseDecadeFilter !== undefined;
    const needsExtra =
      chartSettings.skipWithoutImage || chartSettings.filterSingles ||
      hasReleaseFilters || chartSettings.filteredArtistName !== undefined;

    const extraAlbums = chartSettings.skipWithoutImage
      ? chartSettings.height * 2 + (chartSettings.height > 5 ? 8 : 2)
      : 0;
    const singlesExtra = chartSettings.filterSingles ? chartSettings.height : 0;

    const imagesToGet = chartSettings.filteredArtistName !== undefined
      ? 1000
      : needsExtra
      ? Math.min(chartSettings.imagesNeeded + extraAlbums + singlesExtra + 20, 1000)
      : Math.min(chartSettings.imagesNeeded + 10, 250);

    const timePeriod = chartSettings.timeSettings?.timePeriod ?? TimePeriod.Weekly;
    const from = chartSettings.timeSettings?.startDateTime
      ? Math.floor(chartSettings.timeSettings.startDateTime.getTime() / 1000)
      : undefined;
    const to = chartSettings.timeSettings?.endDateTime
      ? Math.floor(chartSettings.timeSettings.endDateTime.getTime() / 1000)
      : undefined;

    let albums = await this.lastfmRepository.getTopAlbums(
      userNameLastFm,
      timePeriod,
      imagesToGet,
      1,
      undefined,
      from,
      to,
    );

    if (chartSettings.filteredArtistName) {
      const filterLower = chartSettings.filteredArtistName.toLowerCase();
      albums = albums.filter(
        (a) => a.artistName.toLowerCase() === filterLower || a.artistName.toLowerCase().includes(filterLower),
      );
    }

    if (albums.length < chartSettings.imagesNeeded) {
      throw new NotEnoughAlbumsError(albums.length, chartSettings.imagesNeeded);
    }

    if (
      chartSettings.releaseYearFilter !== undefined ||
      chartSettings.releaseDecadeFilter !== undefined ||
      chartSettings.filterSingles
    ) {
      await this.enrichmentService.enrichTopAlbums(albums);
    }

    if (chartSettings.releaseYearFilter !== undefined) {
      const yearStart = new Date(Date.UTC(chartSettings.releaseYearFilter, 0, 1));
      const yearEnd = new Date(Date.UTC(chartSettings.releaseYearFilter + 1, 0, 0));
      albums = albums.filter(
        (a) => a.releaseDate && a.releaseDate >= yearStart && a.releaseDate <= yearEnd,
      );
    } else if (chartSettings.releaseDecadeFilter !== undefined) {
      const decadeStart = new Date(Date.UTC(chartSettings.releaseDecadeFilter, 0, 1));
      const decadeEnd = new Date(Date.UTC(chartSettings.releaseDecadeFilter + 10, 0, 0));
      albums = albums.filter(
        (a) => a.releaseDate && a.releaseDate >= decadeStart && a.releaseDate < decadeEnd,
      );
    }

    if (chartSettings.filterSingles) {
      albums = albums.filter(
        (a) => (a.albumType ?? 'album').toLowerCase() !== 'single',
      );
    }

    if (albums.length < chartSettings.imagesNeeded) {
      throw new NotEnoughAlbumsError(albums.length, chartSettings.imagesNeeded, true);
    }

    let selected: TopAlbum[];

    if (chartSettings.skipWithoutImage) {
      const resolved = await this.resolveAlbumCovers(albums, chartSettings);
      const usable = resolved.filter((a) => a.imageUrl);
      if (usable.length < chartSettings.imagesNeeded) {
        throw new NotEnoughAlbumsError(usable.length, chartSettings.imagesNeeded, true);
      }
      selected = usable.slice(0, chartSettings.imagesNeeded);
    } else {
      // Normal mode: resolve covers for top albums, keep all (missing covers render styled fallback tile)
      const topSlice = albums.slice(0, chartSettings.imagesNeeded);
      selected = await this.resolveAlbumCovers(topSlice, chartSettings);
    }

    const buffer = await this.renderAlbumChart(selected, chartSettings, font);
    const imageUrl = await this.stageRendered(buffer, chartSettings, userNameLastFm);

    const user = await this.userService.getUserByDiscordId(discordUserId);
    if (user) {
      this.userService.enqueueUserUpdate(user, 'Command' as never);
    }

    const result: ChartResult = {
      imageUrl: imageUrl ?? undefined,
      buffer: imageUrl ? undefined : buffer,
      albumsUsed: selected,
    };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 180); // 3 minutes cache
    }

    return result;
  }

  public async generateArtistChart(
    discordUserId: string,
    userNameLastFm: string,
    chartSettings: ChartSettings,
    font?: string,
  ): Promise<ChartResult> {
    if (chartSettings.imagesNeeded > MAX_IMAGES) {
      throw new TooManyImagesError();
    }

    const cacheKey = `chart:artist:${userNameLastFm.toLowerCase()}:${chartSettings.width}x${chartSettings.height}:${chartSettings.timespanString}:${chartSettings.titleSetting}:${chartSettings.rainbowSortingEnabled ? '1' : '0'}`;

    if (this.cache) {
      const cached = await this.cache.get<ChartResult>(cacheKey);
      if (cached && (cached.imageUrl || cached.buffer)) {
        return cached;
      }
    }

    const extraArtists = chartSettings.skipWithoutImage
      ? chartSettings.height * 2 + (chartSettings.height > 5 ? 8 : 2)
      : 0;

    const timePeriod = chartSettings.timeSettings?.timePeriod ?? TimePeriod.Weekly;
    const from = chartSettings.timeSettings?.startDateTime
      ? Math.floor(chartSettings.timeSettings.startDateTime.getTime() / 1000)
      : undefined;
    const to = chartSettings.timeSettings?.endDateTime
      ? Math.floor(chartSettings.timeSettings.endDateTime.getTime() / 1000)
      : undefined;

    const artists = await this.lastfmRepository.getTopArtists(
      userNameLastFm,
      timePeriod,
      Math.min(chartSettings.imagesNeeded + extraArtists + 50, 1000),
      1,
      undefined,
      from,
      to,
    );

    if (artists.length < chartSettings.imagesNeeded) {
      throw new NotEnoughAlbumsError(artists.length, chartSettings.imagesNeeded);
    }

    let selected: Array<TopArtist & { imageUrl?: string }>;

    if (chartSettings.skipWithoutImage) {
      const pool = artists.slice(0, Math.min(artists.length, chartSettings.imagesNeeded + extraArtists + 50));
      const resolved = await this.mapWithConcurrency(
        pool,
        COVER_FETCH_CONCURRENCY,
        async (artist): Promise<TopArtist & { imageUrl?: string }> => ({
          ...artist,
          imageUrl: (await this.artworkService.getArtistImageUrl(artist.name)) ?? undefined,
        }),
      );

      const usable = resolved.filter((a) => a.imageUrl);
      if (usable.length < chartSettings.imagesNeeded) {
        throw new NotEnoughAlbumsError(usable.length, chartSettings.imagesNeeded, true);
      }
      selected = usable.slice(0, chartSettings.imagesNeeded);
    } else {
      // Normal mode: take top artists, fetch images, keep all (missing images render styled fallback tile)
      const topSlice = artists.slice(0, chartSettings.imagesNeeded);
      selected = await this.mapWithConcurrency(
        topSlice,
        COVER_FETCH_CONCURRENCY,
        async (artist): Promise<TopArtist & { imageUrl?: string }> => ({
          ...artist,
          imageUrl: (await this.artworkService.getArtistImageUrl(artist.name)) ?? undefined,
        }),
      );
    }
    const buffer = await this.renderArtistChart(selected, chartSettings, font);
    const imageUrl = await this.stageRendered(buffer, chartSettings, userNameLastFm);

    const user = await this.userService.getUserByDiscordId(discordUserId);
    if (user) {
      this.userService.enqueueUserUpdate(user, 'Command' as never);
    }

    const result: ChartResult = {
      imageUrl: imageUrl ?? undefined,
      buffer: imageUrl ? undefined : buffer,
      artistsUsed: selected,
    };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 180); // 3 minutes cache
    }

    return result;
  }

  public async generateTrackChart(
    discordUserId: string,
    userNameLastFm: string,
    chartSettings: ChartSettings,
    font?: string,
  ): Promise<ChartResult> {
    if (chartSettings.imagesNeeded > MAX_IMAGES) {
      throw new TooManyImagesError();
    }

    const cacheKey = `chart:track:${userNameLastFm.toLowerCase()}:${chartSettings.width}x${chartSettings.height}:${chartSettings.timespanString}:${chartSettings.titleSetting}:${chartSettings.filteredArtistName ?? 'all'}:${chartSettings.rainbowSortingEnabled ? '1' : '0'}`;

    if (this.cache) {
      const cached = await this.cache.get<ChartResult>(cacheKey);
      if (cached && (cached.imageUrl || cached.buffer)) {
        return cached;
      }
    }

    const extraTracks = chartSettings.skipWithoutImage
      ? chartSettings.height * 2 + (chartSettings.height > 5 ? 8 : 2)
      : 0;

    const timePeriod = chartSettings.timeSettings?.timePeriod ?? TimePeriod.Weekly;
    const from = chartSettings.timeSettings?.startDateTime
      ? Math.floor(chartSettings.timeSettings.startDateTime.getTime() / 1000)
      : undefined;
    const to = chartSettings.timeSettings?.endDateTime
      ? Math.floor(chartSettings.timeSettings.endDateTime.getTime() / 1000)
      : undefined;

    const imagesToGet = chartSettings.filteredArtistName !== undefined
      ? 1000
      : Math.min(chartSettings.imagesNeeded + extraTracks + 50, 1000);

    let tracks = await this.lastfmRepository.getTopTracks(
      userNameLastFm,
      timePeriod,
      imagesToGet,
      1,
      undefined,
      from,
      to,
    );

    if (chartSettings.filteredArtistName) {
      const filterLower = chartSettings.filteredArtistName.toLowerCase();
      tracks = tracks.filter(
        (t) => t.artistName.toLowerCase() === filterLower || t.artistName.toLowerCase().includes(filterLower),
      );
    }

    if (tracks.length < chartSettings.imagesNeeded) {
      throw new NotEnoughAlbumsError(tracks.length, chartSettings.imagesNeeded);
    }

    let selected: TopTrack[];

    if (chartSettings.skipWithoutImage) {
      const pool = tracks.slice(0, Math.min(tracks.length, chartSettings.imagesNeeded + extraTracks + 50));
      const resolved = await this.resolveTrackCovers(pool, chartSettings);
      const usable = resolved.filter((t) => t.imageUrl);
      if (usable.length < chartSettings.imagesNeeded) {
        throw new NotEnoughAlbumsError(usable.length, chartSettings.imagesNeeded, true);
      }
      selected = usable.slice(0, chartSettings.imagesNeeded);
    } else {
      const topSlice = tracks.slice(0, chartSettings.imagesNeeded);
      selected = await this.resolveTrackCovers(topSlice, chartSettings);
    }

    const buffer = await this.renderTrackChart(selected, chartSettings, font);
    const imageUrl = await this.stageRendered(buffer, chartSettings, userNameLastFm);

    const user = await this.userService.getUserByDiscordId(discordUserId);
    if (user) {
      this.userService.enqueueUserUpdate(user, 'Command' as never);
    }

    const result: ChartResult = {
      imageUrl: imageUrl ?? undefined,
      buffer: imageUrl ? undefined : buffer,
      tracksUsed: selected,
    };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 180);
    }

    return result;
  }

  private async stageRendered(
    buffer: Buffer,
    chartSettings: ChartSettings,
    userNameLastFm: string,
  ): Promise<string | null> {
    const chartType = chartSettings.trackChart ? 'track' : chartSettings.artistChart ? 'artist' : 'album';
    const fileName = `${chartType}-chart-${chartSettings.width}w-${chartSettings.height}h-${chartSettings.timespanString}-${userNameLastFm}.png`;
    return this.imageUploadService.uploadToStagingChannel(
      buffer,
      fileName.replace(/\s+/g, ''),
      `${chartSettings.width}x${chartSettings.height} ${chartType} chart`,
    );
  }

  private async resolveAlbumCovers(
    albums: TopAlbum[],
    chartSettings: ChartSettings,
  ): Promise<TopAlbum[]> {
    const toResolve = albums.slice(0, chartSettings.imagesNeeded + 15);
    return this.mapWithConcurrency(toResolve, COVER_FETCH_CONCURRENCY, async (album) => {
      // ArtworkService is now the primary source — Last.fm is last-resort fallback only
      const hasValidLfm = !!album.imageUrl && !isPlaceholderImageUrl(album.imageUrl);
      let imageUrl: string | undefined;
      const resolved = await this.artworkService.getAlbumCoverUrl(album.name, album.artistName);
      if (resolved && !isPlaceholderImageUrl(resolved)) {
        imageUrl = resolved;
      } else if (hasValidLfm) {
        imageUrl = album.imageUrl!;
      }
      // resolved == null means all providers (Spotify→Deezer→Apple→Last.fm) failed → leave undefined to be filtered
      return { ...album, imageUrl };
    });
  }

  private async renderAlbumChart(
    albums: TopAlbum[],
    chartSettings: ChartSettings,
    font?: string,
  ): Promise<Buffer> {
    const items: ChartItem[] = albums.map((a) => ({
      name: a.name,
      artistName: a.artistName,
      imageUrl: a.imageUrl,
      showTitle: chartSettings.titleSetting === TitleSetting.Titles,
    }));

    return this.imageChartService.generateChart(items, {
      rows: chartSettings.height,
      columns: chartSettings.width,
      type: 'album' as never,
      theme: 'dark' as never,
      showTitle: false,
      padding: 0,
      imageSizePx: CELL_SIZE,
      rainbowSort: chartSettings.rainbowSortingEnabled,
      fontFamily: font,
      timePeriod: chartSettings.timeSettings?.timePeriod ?? TimePeriod.Weekly,
    });
  }

  private async renderArtistChart(
    artists: Array<TopArtist & { imageUrl?: string }>,
    chartSettings: ChartSettings,
    font?: string,
  ): Promise<Buffer> {
    const items: ChartItem[] = artists.map((a) => ({
      name: a.name,
      imageUrl: a.imageUrl,
      showTitle: chartSettings.titleSetting === TitleSetting.Titles,
    }));

    return this.imageChartService.generateChart(items, {
      rows: chartSettings.height,
      columns: chartSettings.width,
      type: 'artist' as never,
      theme: 'dark' as never,
      showTitle: false,
      padding: 0,
      imageSizePx: CELL_SIZE,
      rainbowSort: chartSettings.rainbowSortingEnabled,
      fontFamily: font,
      timePeriod: chartSettings.timeSettings?.timePeriod ?? TimePeriod.Weekly,
    });
  }

  private async resolveTrackCovers(
    tracks: TopTrack[],
    chartSettings: ChartSettings,
  ): Promise<TopTrack[]> {
    const toResolve = tracks.slice(0, chartSettings.imagesNeeded + 15);
    return this.mapWithConcurrency(toResolve, COVER_FETCH_CONCURRENCY, async (track) => {
      const hasValidLfm = !!track.imageUrl && !isPlaceholderImageUrl(track.imageUrl);
      let imageUrl: string | undefined;
      const resolved = await this.artworkService.getTrackCoverUrl(track.name, track.artistName);
      if (resolved && !isPlaceholderImageUrl(resolved)) {
        imageUrl = resolved;
      } else if (hasValidLfm) {
        imageUrl = track.imageUrl!;
      }
      return { ...track, imageUrl };
    });
  }

  private async renderTrackChart(
    tracks: TopTrack[],
    chartSettings: ChartSettings,
    font?: string,
  ): Promise<Buffer> {
    const items: ChartItem[] = tracks.map((t) => ({
      name: t.name,
      artistName: t.artistName,
      imageUrl: t.imageUrl,
      showTitle: chartSettings.titleSetting === TitleSetting.Titles,
    }));

    return this.imageChartService.generateChart(items, {
      rows: chartSettings.height,
      columns: chartSettings.width,
      type: 'track' as never,
      theme: 'dark' as never,
      showTitle: false,
      padding: 0,
      imageSizePx: CELL_SIZE,
      rainbowSort: chartSettings.rainbowSortingEnabled,
      fontFamily: font,
      timePeriod: chartSettings.timeSettings?.timePeriod ?? TimePeriod.Weekly,
    });
  }

  private async mapWithConcurrency<TIn, TOut>(
    input: TIn[],
    limit: number,
    fn: (item: TIn) => Promise<TOut>,
  ): Promise<TOut[]> {
    const results: TOut[] = new Array(input.length);
    let index = 0;

    const workers = Array.from({ length: Math.min(limit, input.length) }, async () => {
      while (index < input.length) {
        const current = index++;
        results[current] = await fn(input[current]!);
      }
    });

    await Promise.all(workers);
    return results;
  }
}
