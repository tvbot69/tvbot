import 'reflect-metadata';
import { describe, it, expect, afterAll } from 'vitest';
import { ChartService } from './chartService';
import { ArtworkService } from './artworkService';
import { AlbumEnrichmentService } from './albumEnrichmentService';
import { CacheService } from './cacheService';
import { SettingService } from './settingService';
import { ChartSettings } from '@bot/models/chartModels';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/apis/deezerApi';
import { AppleMusicTokenScraper } from '@applemusic/apis/appleMusicTokenScraper';
import { AppleMusicWebApi } from '@applemusic/apis/appleMusicWebApi';
import { AppleMusicSearchApi } from '@applemusic/apis/appleMusicSearchApi';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { ChartService as ImageChartService } from '@images/generators/chartService';

const cache = new CacheService();
const lastFm = new LastFmRepository(new LastfmApi());
lastFm.getTopAlbums = async () => [
  { name: 'Album 1', artistName: 'Artist 1', playcount: 100, imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
  { name: 'Album 2', artistName: 'Artist 2', playcount: 80, imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
  { name: 'Album 3', artistName: 'Artist 3', playcount: 60, imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
  { name: 'Album 4', artistName: 'Artist 4', playcount: 40, imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
];
const artwork = new ArtworkService(
  new SpotifySearchApi(new SpotifyTokenManager()),
  new DeezerApi(),
  new AppleMusicWebApi(new AppleMusicTokenScraper()),
  new AppleMusicSearchApi(),
  {
    getArtistByName: async () => null,
    setSpotifyImage: async () => undefined,
    setDeezerImage: async () => undefined,
    setAppleMusicUrl: async () => undefined,
    getOrCreateArtist: async () => {
      throw new Error('not used');
    },
    getArtistById: async () => null,
  } as never,
  {
    getAlbumByNameAndArtist: async () => null,
    setSpotifyImage: async () => undefined,
    setDeezerImage: async () => undefined,
    setImageUrl: async () => undefined,
  } as never,
  {
    getTrackByNameAndArtist: async () => null,
    setSpotifyImage: async () => undefined,
    setImageUrl: async () => undefined,
  } as never,
  lastFm,
  cache,
);
const userServiceStub = {
  getUserByDiscordId: async () => null,
  enqueueUserUpdate: () => undefined,
} as never;
const puppeteer = new PuppeteerService();
const enrichment = new AlbumEnrichmentService(
  new SpotifySearchApi(new SpotifyTokenManager()),
  {
    getArtistByName: async () => null,
    getOrCreateArtist: async () => {
      throw new Error('not used');
    },
    getArtistById: async () => null,
    setSpotifyImage: async () => undefined,
    setDeezerImage: async () => undefined,
    setAppleMusicUrl: async () => undefined,
  } as never,
  {
    getAlbumByNameAndArtist: async () => null,
    setReleaseData: async () => undefined,
    setSpotifyImage: async () => undefined,
    setDeezerImage: async () => undefined,
    setImageUrl: async () => undefined,
    getAlbumById: async () => null,
    getOrCreateAlbum: async () => {
      throw new Error('not used');
    },
  } as never,
  cache,
);
const imageUploaderStub = { uploadToStagingChannel: async () => null } as never;
const service = new ChartService(
  artwork,
  lastFm,
  userServiceStub,
  enrichment,
  new ImageChartService(puppeteer),
  imageUploaderStub,
);

afterAll(async () => {
  await puppeteer.close();
});

describe('ChartService dimensions', () => {
  it('parses WxH strings like fmbot', () => {
    const s = new ChartSettings();
    const result = ChartService.getDimensions(s, '8x5');
    expect(result.changed).toBe(true);
    expect(s.width).toBe(8);
    expect(s.height).toBe(5);
    expect(s.imagesNeeded).toBe(40);
  });

  it('rejects sizes over 100 total images', () => {
    const s = new ChartSettings();
    s.width = 3;
    s.height = 3;
    const result = ChartService.getDimensions(s, '20x20');
    expect(result.changed).toBe(false);
  });
});

describe('ChartService.generateAlbumChart (integration)', () => {
  it('renders a real 2x2 album chart PNG', async () => {
    const settings = {
      width: 2,
      height: 2,
      imagesNeeded: 4,
      artistChart: false,
      skipWithoutImage: false,
      titleSetting: 'Titles',
      timeSettings: new SettingService().getTimePeriod('overall'),
      timespanString: 'Alltime',
    };

    const result = await service.generateAlbumChart(
      '123',
      'rj',
      settings as never,
    );
    const buffer = result.buffer;

    expect(buffer).toBeDefined();
    expect(buffer!.length).toBeGreaterThan(1000);
    expect(buffer![0]).toBe(0x89);
    expect(buffer!.toString('ascii', 1, 4)).toBe('PNG');
  }, 180000);
});
