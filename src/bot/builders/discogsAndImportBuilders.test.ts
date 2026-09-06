import { describe, it, expect } from 'vitest';
import { DiscogsAndImportBuilders } from './discogsAndImportBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('DiscogsAndImportBuilders', () => {
  it('builds Discogs release response correctly', () => {
    const response = DiscogsAndImportBuilders.buildDiscogsReleaseResponse({
      release: {
        id: 123,
        title: 'OK Computer',
        artist: 'Radiohead',
        year: '1997',
        format: ['Vinyl', 'LP'],
        label: ['Parlophone'],
        genre: ['Rock'],
        style: ['Art Rock'],
        country: 'UK',
        imageUrl: 'https://example.com/okc.jpg',
        url: 'https://discogs.com/release/123',
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds empty collection response with instructions', () => {
    const response = DiscogsAndImportBuilders.buildCollectionResponse({
      displayName: 'Alice',
      collection: [],
      prefix: '.',
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds populated collection response', () => {
    const response = DiscogsAndImportBuilders.buildCollectionResponse({
      displayName: 'Alice',
      collection: [
        {
          id: '1',
          artist: 'Radiohead',
          album: 'Kid A',
          format: 'Vinyl',
          addedAt: new Date(),
        },
      ],
      prefix: '.',
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds whoHas response with matches', () => {
    const response = DiscogsAndImportBuilders.buildWhoHasResponse({
      query: 'Kid A',
      matches: [
        {
          discordUserId: 'user123',
          item: {
            id: '1',
            artist: 'Radiohead',
            album: 'Kid A',
            format: 'Vinyl',
            addedAt: new Date(),
          },
        },
      ],
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds import instructions response', () => {
    const response = DiscogsAndImportBuilders.buildImportInstructionsResponse({
      instructions: 'Upload your file',
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds import summary response', () => {
    const response = DiscogsAndImportBuilders.buildImportSummaryResponse({
      displayName: 'Alice',
      summary: {
        totalScrobblesImported: 5000,
        uniqueArtistsCount: 250,
        dateRange: { from: new Date('2020-01-01'), to: new Date('2023-01-01') },
        topArtists: [{ name: 'Radiohead', count: 1200 }],
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds import modify response', () => {
    const successRes = DiscogsAndImportBuilders.buildImportModifyResponse({ success: true });
    expect(successRes.commandResponse).toBe(CommandResponse.Ok);

    const failRes = DiscogsAndImportBuilders.buildImportModifyResponse({ success: false });
    expect(failRes.commandResponse).toBe(CommandResponse.Ok);
  });

  it('builds Spotify track response', () => {
    const response = DiscogsAndImportBuilders.buildSpotifyTrackResponse({
      track: {
        id: 'track123',
        name: 'Creep',
        uri: 'spotify:track:123',
        duration_ms: 238000,
        artists: [{ name: 'Radiohead' }],
        album: {
          name: 'Pablo Honey',
          images: [{ url: 'https://example.com/cover.jpg', height: 300, width: 300 }],
        },
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds Spotify album response', () => {
    const response = DiscogsAndImportBuilders.buildSpotifyAlbumResponse({
      album: {
        id: 'album123',
        name: 'In Rainbows',
        uri: 'spotify:album:123',
        release_date: '2007-10-10',
        total_tracks: 10,
        artists: [{ name: 'Radiohead' }],
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds Spotify artist response', () => {
    const response = DiscogsAndImportBuilders.buildSpotifyArtistResponse({
      artist: {
        id: 'art123',
        name: 'Radiohead',
        uri: 'spotify:artist:123',
        popularity: 85,
        genres: ['Alternative Rock', 'Art Rock'],
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('builds Apple Music response', () => {
    const response = DiscogsAndImportBuilders.buildAppleMusicResponse({
      item: {
        trackName: 'Paranoid Android',
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        url: 'https://music.apple.com/us/album/paranoid-android/1097861387?i=1097861391',
        artworkUrl: 'https://example.com/apple_cover.jpg',
      },
    });

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(response.componentsV2Container).toBeDefined();
  });
});
