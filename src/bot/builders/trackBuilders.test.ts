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
});
