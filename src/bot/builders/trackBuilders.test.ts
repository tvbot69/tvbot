import { describe, expect, it } from 'vitest';
import { TrackBuilders } from './trackBuilders';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TrackSearchResult } from '@bot/services/trackService';

describe('TrackBuilders', () => {
  it('builds Component v2 container with section thumbnail, duration, server stats, user plays, and media buttons', () => {
    const track: TrackSearchResult = {
      trackName: 'Wait For It',
      artistName: 'Young Stoner Life',
      albumName: 'Slime Language 3',
      trackUrl: 'https://www.last.fm/music/Young+Stoner+Life/_/Wait+For+It',
      artistUrl: 'https://www.last.fm/music/Young+Stoner+Life',
      albumUrl: 'https://last.fm/music/Young%20Stoner%20Life/Slime%20Language%203',
      coverUrl: 'https://lastfm.freetls.fastly.net/i/u/afe106e4a479e6041e0403056a0513fe.jpg',
      durationSeconds: 128,
      userPlaycount: 1,
      globalPlaycount: 4291,
      globalListeners: 2767,
      serverPlaycount: 1,
      serverListeners: 1,
      isLoved: true,
      lastMonthPlays: 1,
    };

    const user: User = {
      userId: 1,
      discordUserId: '103854464',
      userNameLastFm: 'Moha504',
    } as User;

    const mediaDetails = {
      uniqueId: '103854464',
      previewUrl: 'https://audio-preview.spotifycdn.com/test.mp3',
      storeUrl: 'https://music.apple.com/us/album/wait-for-it/12345',
      source: 'apple' as const,
      durationFormatted: '2:08',
    };

    const response = TrackBuilders.buildTrackInfoResponse(
      track,
      user,
      'moha',
      0x5865F2,
      mediaDetails,
    );

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();
    const str = JSON.stringify(json);

    // Track header
    expect(str).toContain('Wait For It');
    expect(str).toContain('Young Stoner Life');
    expect(str).toContain('Slime Language 3');

    // Duration & Loved
    expect(str).toContain('`2:08` duration • ❤️ Loved');

    // Server & Last.fm stats
    expect(str).toContain('**1** play in this server by **1** listener');
    expect(str).toContain('**4,291** Last.fm plays by **2,767** listeners');

    // User plays & last month
    expect(str).toContain('**1** play by **moha** — **1** last month');

    // Streaming link button & preview button
    expect(str).toContain('services_apple_music');
    expect(str).toContain('track-preview:103854464:');
  });

  it('buildLoveResponse and buildUnloveResponse generate correct text', () => {
    const loveRes = TrackBuilders.buildLoveResponse('Song Title', 'Band Name', 0x123456);
    expect(loveRes.isComponentsV2).toBe(true);
    const loveJson = JSON.stringify(loveRes.componentsV2Container!.toJSON());
    expect(loveJson).toContain('Loved **Song Title** by **Band Name** on Last.fm');

    const unloveRes = TrackBuilders.buildUnloveResponse('Song Title', 'Band Name', 0x123456);
    expect(unloveRes.isComponentsV2).toBe(true);
    const unloveJson = JSON.stringify(unloveRes.componentsV2Container!.toJSON());
    expect(unloveJson).toContain('Unloved **Song Title** by **Band Name** on Last.fm');
  });

  it('buildLovedTracksResponse formats pagination and loved list properly', () => {
    const tracks = [
      { name: 'Track 1', artistName: 'Artist 1', dateLoved: new Date('2025-01-01') },
      { name: 'Track 2', artistName: 'Artist 2' },
    ];
    const res = TrackBuilders.buildLovedTracksResponse('moha_lfm', 'Moha', tracks, 0, 2);
    expect(res.isComponentsV2).toBe(true);
    const json = JSON.stringify(res.componentsV2Container!.toJSON());
    expect(json).toContain('Loved tracks for [Moha]');
    expect(json).toContain('Track 1');
    expect(json).toContain('Artist 1');
    expect(json).toContain('Track 2');
    expect(json).toContain('Artist 2');
  });

  it('buildScrobbleResponse generates correct text and metadata', () => {
    const res = TrackBuilders.buildScrobbleResponse('Track Name', 'Artist Name', 'moha_lfm');
    expect(res.isComponentsV2).toBe(true);
    const json = JSON.stringify(res.componentsV2Container!.toJSON());
    expect(json).toContain('Scrobbled **Track Name** by **Artist Name** to **moha_lfm**\'s Last.fm profile.');
  });
});
