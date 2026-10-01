import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { TrackBuilders } from '@bot/builders/library/trackBuilders';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { TrackSearchResult } from '@bot/services/library/trackService';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  accessory?: { media?: { url?: string } };
  custom_id?: string;
}

const serialised = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[] };

/** Every rendered leaf, read off the SERIALISED tree: a card that cannot be serialised cannot be sent. */
const leaves = (response: ResponseModel): Cv2Component[] => {
  const walk = (nodes: Cv2Component[]): Cv2Component[] =>
    nodes.flatMap(node => (node.components ? walk(node.components) : [node]));
  return walk(serialised(response).components);
};

const texts = (response: ResponseModel): string =>
  leaves(response)
    .filter(c => c.type === ComponentType.TextDisplay)
    .map(c => c.content ?? '')
    .join('\n');

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

/**
 * The card has to be SENDABLE whether or not Last.fm gave us a cover.
 *
 * discord.js does NOT treat a Section's accessory as optional: `toJSON()` runs
 * it through a required union validator, so a header wrapped in a section with no
 * accessory set throws at the moment the dispatcher hands the card to Discord.
 * The builder therefore puts the header in a section when there is a cover and in
 * a plain text block when there is not — the shape the artist cards already use.
 */
describe('TrackBuilders.buildTrackInfoResponse: the card serialises with and without a cover', () => {
  const user = { userId: 1, discordUserId: '103854464', userNameLastFm: 'Moha504' } as User;

  const track = (over: Partial<TrackSearchResult> = {}): TrackSearchResult =>
    ({
      trackName: 'Wait For It',
      artistName: 'Young Stoner Life',
      albumName: 'Slime Language 3',
      trackUrl: 'https://www.last.fm/music/Young+Stoner+Life/_/Wait+For+It',
      artistUrl: 'https://www.last.fm/music/Young+Stoner+Life',
      albumUrl: 'https://last.fm/music/Young%20Stoner%20Life/Slime%20Language%203',
      coverUrl: 'https://lastfm.example.net/i/u/afe106e4a479e6041e0403056a0513fe.jpg',
      durationSeconds: 128,
      userPlaycount: 1,
      ...over,
    }) as TrackSearchResult;

  const card = (over: Partial<TrackSearchResult> = {}) => TrackBuilders.buildTrackInfoResponse(track(over), user, 'moha');

  it('hangs the cover on a section when there is one', () => {
    const sections = serialised(card()).components.filter(c => c.type === ComponentType.Section);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.accessory?.media?.url).toBe('https://lastfm.example.net/i/u/afe106e4a479e6041e0403056a0513fe.jpg');
  });

  it('serialises a track with no cover instead of throwing', () => {
    const response = card({ coverUrl: undefined });
    expect(() => serialised(response)).not.toThrow();
    expect(serialised(response).components.some(c => c.type === ComponentType.Section)).toBe(false);
    expect(serialised(response).components.length).toBeGreaterThan(0);
  });

  it('renders the same header and stats whichever shape the cover took', () => {
    const withCover = texts(card());
    const without = texts(card({ coverUrl: undefined }));
    expect(without).toContain('## [Wait For It](https://www.last.fm/music/Young+Stoner+Life/_/Wait+For+It)');
    expect(without).toContain('Track by **[Young Stoner Life](https://www.last.fm/music/Young+Stoner+Life)**');
    expect(without).toContain('**1** play by **moha**');
    expect(without).toBe(withCover);
  });
});
