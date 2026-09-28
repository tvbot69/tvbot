import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NowPlayingInteractions } from './nowPlayingInteractions';
import { TrackBuilders } from '@bot/builders/trackBuilders';
import type { LyricsResult } from '@bot/services/music/lyricsService';
import type { ButtonInteraction } from 'discord.js';

const makeUser = (over: Record<string, unknown> = {}) => ({
  userId: 1,
  discordUserId: 'caller1',
  userNameLastFm: 'user1',
  sessionKey: 'session-key',
  ...over,
});

const makeLyrics = (over: Partial<LyricsResult> = {}): LyricsResult => ({
  title: 'Karma Police',
  artist: 'Radiohead',
  plainLyrics: 'I am a policeman',
  instrumental: false,
  ...over,
});

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    guild: { members: { cache: new Map<string, { displayName: string }>() } },
    deferReply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    deferReply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const userRepository = {
    getUserByDiscordUserId: vi.fn(async () => makeUser() as ReturnType<typeof makeUser> | null),
    ...(over.userRepository as object),
  };
  const lastfmRepository = {
    scrobbleTrack: vi.fn(async () => true),
    loveTrack: vi.fn(async () => true),
    unloveTrack: vi.fn(async () => true),
    getLovedTracks: vi.fn(async () => ({
      tracks: [{ name: 'Karma Police', artistName: 'Radiohead' }],
      total: 42,
    })),
    ...(over.lastfmRepository as object),
  };
  const trackService = {
    getScrobbleReference: vi.fn(() => ({ artist: 'Radiohead', track: 'Karma Police' })),
    ...(over.trackService as object),
  };
  const lyricsService = {
    getLyrics: vi.fn(async () => makeLyrics() as LyricsResult | null),
    ...(over.lyricsService as object),
  };
  const injected = 'lyricsService' in over ? (over.lyricsService as object | undefined) : lyricsService;
  const npi = new NowPlayingInteractions(
    userRepository as never,
    lastfmRepository as never,
    trackService as never,
    injected as never,
  );
  return { npi, userRepository, lastfmRepository, trackService, lyricsService };
};

const editContent = (press: ButtonInteraction & { editReply: ReturnType<typeof vi.fn> }) =>
  press.editReply.mock.calls[0]![0] as { content: string; components?: unknown[] };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(TrackBuilders, 'buildScrobbleResponse').mockReturnValue({ componentsV2Container: {} } as never);
  vi.spyOn(TrackBuilders, 'buildTrackLyricsResponse').mockReturnValue({ componentsV2Container: {} } as never);
  vi.spyOn(TrackBuilders, 'buildLovedTracksResponse').mockReturnValue({ componentsV2Container: {} } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NowPlayingInteractions.handleScrobble — guards', () => {
  it('acknowledges ephemerally before any database work', async () => {
    const { npi, userRepository } = build();
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(press.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(userRepository.getUserByDiscordUserId).toHaveBeenCalledWith('caller1');
  });

  it('swallows a deferReply that was already acknowledged', async () => {
    const { npi, lastfmRepository } = build();
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police', {
      deferReply: vi.fn(async () => {
        throw Object.assign(new Error('already acknowledged'), { code: 40060 });
      }),
    });

    await expect(npi.handleScrobble(press)).resolves.toBeUndefined();
    expect(lastfmRepository.scrobbleTrack).toHaveBeenCalledTimes(1);
  });

  it('replies with the link prompt when the user is not registered', async () => {
    const { npi, lastfmRepository } = build({ userRepository: { getUserByDiscordUserId: vi.fn(async () => null) } });
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toContain('You must link your Last.fm account');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('replies with the link prompt when the user has no lastfm username', async () => {
    const { npi, lastfmRepository } = build({
      userRepository: { getUserByDiscordUserId: vi.fn(async () => makeUser({ userNameLastFm: '' })) },
    });
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toContain('You must link your Last.fm account');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('replies with the session key prompt when the session key is missing', async () => {
    const { npi, lastfmRepository } = build({
      userRepository: { getUserByDiscordUserId: vi.fn(async () => makeUser({ sessionKey: null })) },
    });
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toContain('session key is missing');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('replies with the expiry notice when the scrobble reference is gone', async () => {
    const { npi, trackService, lastfmRepository } = build({
      trackService: { getScrobbleReference: vi.fn(() => undefined) },
    });
    const press = mkButton('scrobble-ref:tok1');

    await npi.handleScrobble(press);

    expect(trackService.getScrobbleReference).toHaveBeenCalledWith('tok1');
    expect(editContent(press).content).toContain('reference has expired');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('replies with the invalid reference message when artist and track are missing', async () => {
    const { npi, lastfmRepository } = build();
    const press = mkButton('scrobble-now:Radiohead');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toContain('Invalid track scrobble reference');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });

  it('replies with the invalid reference message for an unrelated customId', async () => {
    const { npi, lastfmRepository } = build();
    const press = mkButton('something-else:next');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toContain('Invalid track scrobble reference');
    expect(lastfmRepository.scrobbleTrack).not.toHaveBeenCalled();
  });
});

describe('NowPlayingInteractions.handleScrobble — scrobbling', () => {
  it('scrobbles the resolved artist and track with the session key', async () => {
    const { npi, lastfmRepository } = build();
    const before = Math.floor(Date.now() / 1000);

    await npi.handleScrobble(mkButton('scrobble-now:Radiohead:Karma%20Police'));

    const [artist, track, timestamp, sessionKey] = lastfmRepository.scrobbleTrack.mock.calls[0] as unknown as [
      string,
      string,
      number,
      string,
    ];
    expect(artist).toBe('Radiohead');
    expect(track).toBe('Karma Police');
    expect(sessionKey).toBe('session-key');
    expect(timestamp).toBeGreaterThanOrEqual(before);
  });

  it('decodes percent-encoded artist and track names', async () => {
    const { npi, lastfmRepository } = build();
    await npi.handleScrobble(mkButton('scrobble-now:Bj%C3%B6rk:J%C3%B3ga'));

    expect(lastfmRepository.scrobbleTrack).toHaveBeenCalledWith(
      'Björk',
      'Jóga',
      expect.any(Number),
      'session-key',
    );
  });

  it('resolves the artist and track from a scrobble reference', async () => {
    const { npi, lastfmRepository, trackService } = build({
      trackService: { getScrobbleReference: vi.fn(() => ({ artist: 'Aphex Twin', track: 'Xtal' })) },
    });

    await npi.handleScrobble(mkButton('scrobble-ref:tok9:extra:parts'));

    expect(trackService.getScrobbleReference).toHaveBeenCalledWith('tok9');
    expect(lastfmRepository.scrobbleTrack).toHaveBeenCalledWith('Aphex Twin', 'Xtal', expect.any(Number), 'session-key');
  });

  it('builds the scrobble response with track, artist and the lastfm username', async () => {
    const { npi } = build();
    await npi.handleScrobble(mkButton('scrobble-now:Radiohead:Karma%20Police'));

    expect(TrackBuilders.buildScrobbleResponse).toHaveBeenCalledWith('Karma Police', 'Radiohead', 'user1');
  });

  it('edits the reply with the ComponentsV2 container when present', async () => {
    const { npi } = build();
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(press.editReply).toHaveBeenCalledWith({ content: undefined, components: [{}] });
  });

  it('falls back to text when the response has no container', async () => {
    const { npi } = build();
    vi.spyOn(TrackBuilders, 'buildScrobbleResponse').mockReturnValue({} as never);
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toBe('✅ Scrobbled **Karma Police** by **Radiohead** to your Last.fm!');
    expect(editContent(press).components).toEqual([]);
  });

  it('replies with the rejection message when lastfm refuses the scrobble', async () => {
    const { npi } = build({ lastfmRepository: { scrobbleTrack: vi.fn(async () => false) } });
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toContain('Last.fm rejected the scrobble');
    expect(TrackBuilders.buildScrobbleResponse).not.toHaveBeenCalled();
  });

  it('replies with the unreachable message when the repository throws', async () => {
    const { npi } = build({
      lastfmRepository: {
        scrobbleTrack: vi.fn(async () => {
          throw new Error('HTTP 500 from last.fm');
        }),
      },
    });
    const press = mkButton('scrobble-now:Radiohead:Karma%20Police');

    await npi.handleScrobble(press);

    expect(editContent(press).content).toBe('❌ Could not reach Last.fm. Please try again in a moment.');
  });
});

describe('NowPlayingInteractions.handleLove', () => {
  it('acknowledges ephemerally and looks the pressing user up', async () => {
    const { npi, userRepository } = build();
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(press.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(userRepository.getUserByDiscordUserId).toHaveBeenCalledWith('caller1');
  });

  it('loves the decoded artist and track', async () => {
    const { npi, lastfmRepository } = build();
    await npi.handleLove(mkButton('love-track:Bj%C3%B6rk:J%C3%B3ga'));

    expect(lastfmRepository.loveTrack).toHaveBeenCalledWith('Björk', 'Jóga', 'session-key');
    expect(lastfmRepository.unloveTrack).not.toHaveBeenCalled();
  });

  it('unloves for the unlove-track prefix', async () => {
    const { npi, lastfmRepository } = build();
    await npi.handleLove(mkButton('unlove-track:Radiohead:Karma%20Police'));

    expect(lastfmRepository.unloveTrack).toHaveBeenCalledWith('Radiohead', 'Karma Police', 'session-key');
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('confirms a successful love', async () => {
    const { npi } = build();
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toBe('❤️ Loved **Karma Police** by **Radiohead** on Last.fm.');
  });

  it('confirms a successful unlove', async () => {
    const { npi } = build();
    const press = mkButton('unlove-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toBe('💔 Unloved **Karma Police** by **Radiohead** on Last.fm.');
  });

  it('replies with the link prompt when the user is not registered', async () => {
    const { npi, lastfmRepository } = build({ userRepository: { getUserByDiscordUserId: vi.fn(async () => null) } });
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toContain('Please link your Last.fm account');
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('replies with the session key prompt when the session key is missing', async () => {
    const { npi, lastfmRepository } = build({
      userRepository: { getUserByDiscordUserId: vi.fn(async () => makeUser({ sessionKey: undefined })) },
    });
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toContain('Session key required');
    expect(lastfmRepository.loveTrack).not.toHaveBeenCalled();
  });

  it('reports the rejection for a rejected love', async () => {
    const { npi } = build({ lastfmRepository: { loveTrack: vi.fn(async () => false) } });
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toContain('Last.fm rejected the love');
  });

  it('reports the rejection for a rejected unlove', async () => {
    const { npi } = build({ lastfmRepository: { unloveTrack: vi.fn(async () => false) } });
    const press = mkButton('unlove-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toContain('Last.fm rejected the unlove');
  });

  it('never reports success for a rejected write', async () => {
    const { npi } = build({ lastfmRepository: { loveTrack: vi.fn(async () => false) } });
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).not.toContain('Loved');
  });

  it('replies with fixed copy when the repository throws', async () => {
    const { npi } = build({
      lastfmRepository: {
        loveTrack: vi.fn(async () => {
          throw new Error('Last.fm returned HTTP 403');
        }),
      },
    });
    const press = mkButton('love-track:Radiohead:Karma%20Police');

    await npi.handleLove(press);

    expect(editContent(press).content).toBe('❌ Could not reach Last.fm. Please try again in a moment.');
  });
});

describe('NowPlayingInteractions.handleLyrics', () => {
  it('replies ephemerally when the lyrics service was not injected', async () => {
    const { npi } = build({ lyricsService: undefined });
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: '❌ Lyrics service is temporarily unavailable.',
      ephemeral: true,
    });
    expect(press.deferReply).not.toHaveBeenCalled();
  });

  it('acknowledges ephemerally and looks the lyrics up by track then artist', async () => {
    const { npi, lyricsService } = build();
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(press.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Karma Police', 'Radiohead');
  });

  it('decodes the artist and track from the customId', async () => {
    const { npi, lyricsService } = build();
    await npi.handleLyrics(mkButton('track-lyrics:Bj%C3%B6rk:J%C3%B3ga:fm'));

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Jóga', 'Björk');
  });

  it('reports no lyrics when the lookup returns null', async () => {
    const { npi, lyricsService } = build({ lyricsService: { getLyrics: vi.fn(async () => null) } });
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Karma Police', 'Radiohead');
    expect(editContent(press).content).toBe('No lyrics found for **Karma Police** by **Radiohead**.');
  });

  it('reports no lyrics when the plain lyrics are empty', async () => {
    const { npi } = build({ lyricsService: { getLyrics: vi.fn(async () => makeLyrics({ plainLyrics: '' })) } });
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(editContent(press).content).toContain('No lyrics found');
  });

  it('builds the lyrics response with the genius source url for a genius hit', async () => {
    const { npi } = build({ lyricsService: { getLyrics: vi.fn(async () => makeLyrics({ source: 'genius' })) } });

    await npi.handleLyrics(mkButton('track-lyrics:Radiohead:Karma%20Police:fm'));

    expect(TrackBuilders.buildTrackLyricsResponse).toHaveBeenCalledWith(
      'Karma Police',
      'Radiohead',
      'I am a policeman',
      'https://genius.com',
    );
  });

  it('builds the lyrics response with no source url for a non-genius hit', async () => {
    const { npi } = build({ lyricsService: { getLyrics: vi.fn(async () => makeLyrics({ source: 'lrclib' })) } });

    await npi.handleLyrics(mkButton('track-lyrics:Radiohead:Karma%20Police:fm'));

    expect(TrackBuilders.buildTrackLyricsResponse).toHaveBeenCalledWith(
      'Karma Police',
      'Radiohead',
      'I am a policeman',
      undefined,
    );
  });

  it('edits the reply with the ComponentsV2 container when present', async () => {
    const { npi } = build();
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(press.editReply).toHaveBeenCalledWith({ components: [{}], content: undefined });
  });

  it('falls back to truncated text when the response has no container', async () => {
    vi.spyOn(TrackBuilders, 'buildTrackLyricsResponse').mockReturnValue({} as never);
    const longLyrics = 'x'.repeat(3000);
    const { npi } = build({
      lyricsService: { getLyrics: vi.fn(async () => makeLyrics({ plainLyrics: longLyrics })) },
    });
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(editContent(press).content).toContain('### Lyrics for **Karma Police** by **Radiohead**');
    expect(editContent(press).content!.length).toBeLessThan(2000);
    expect(editContent(press).components).toEqual([]);
  });

  it('replies with fixed copy when the lookup throws', async () => {
    const { npi } = build({
      lyricsService: {
        getLyrics: vi.fn(async () => {
          throw new Error('HTTP 403 from lyrics provider');
        }),
      },
    });
    const press = mkButton('track-lyrics:Radiohead:Karma%20Police:fm');

    await npi.handleLyrics(press);

    expect(editContent(press).content).toBe('❌ Could not load lyrics for that track. Try again in a moment.');
  });
});

describe('NowPlayingInteractions.handleLovedPagination', () => {
  it('returns early when no username is in the customId', async () => {
    const { npi, lastfmRepository } = build();
    const press = mkButton('loved:next:0');

    await npi.handleLovedPagination(press);

    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(lastfmRepository.getLovedTracks).not.toHaveBeenCalled();
  });

  it('increments the page on next', async () => {
    const { npi } = build();
    await npi.handleLovedPagination(mkButton('loved:next:2:user1'));

    expect((TrackBuilders.buildLovedTracksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toBe(3);
  });

  it('decrements the page on prev', async () => {
    const { npi } = build();
    await npi.handleLovedPagination(mkButton('loved:prev:2:user1'));

    expect((TrackBuilders.buildLovedTracksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toBe(1);
  });

  it('clamps the page at 0 on prev from the first page', async () => {
    const { npi } = build();
    await npi.handleLovedPagination(mkButton('loved:prev:0:user1'));

    expect((TrackBuilders.buildLovedTracksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toBe(0);
  });

  it('treats a blank page field as 0 and steps forward to 1', async () => {
    const { npi } = build();
    await npi.handleLovedPagination(mkButton('loved:next::user1'));

    expect((TrackBuilders.buildLovedTracksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toBe(1);
  });

  it('deferUpdates before the repository call', async () => {
    const { npi } = build();
    const press = mkButton('loved:next:0:user1');

    await npi.handleLovedPagination(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('fetches 200 loved tracks from page 1 for the browsing user', async () => {
    const { npi, lastfmRepository } = build();
    await npi.handleLovedPagination(mkButton('loved:next:0:user1'));

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalledWith('user1', 200, 1, 'session-key');
  });

  it('matches the session key username case-insensitively', async () => {
    const { npi, lastfmRepository } = build();
    await npi.handleLovedPagination(mkButton('loved:next:0:USER1'));

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalledWith('USER1', 200, 1, 'session-key');
  });

  it('withholds the session key for a different user', async () => {
    const { npi, lastfmRepository } = build();
    await npi.handleLovedPagination(mkButton('loved:next:0:someoneElse'));

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalledWith('someoneElse', 200, 1, undefined);
  });

  it('withholds the session key when the user row is missing', async () => {
    const { npi, lastfmRepository } = build({ userRepository: { getUserByDiscordUserId: vi.fn(async () => null) } });
    await npi.handleLovedPagination(mkButton('loved:next:0:user1'));

    expect(lastfmRepository.getLovedTracks).toHaveBeenCalledWith('user1', 200, 1, undefined);
  });

  it('prefers the cached member displayName', async () => {
    const { npi } = build();
    const press = mkButton('loved:next:0:user1', {
      guild: { members: { cache: new Map([['caller1', { displayName: 'LoverOne' }]]) } },
    });

    await npi.handleLovedPagination(press);

    expect((TrackBuilders.buildLovedTracksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      'LoverOne',
    );
  });

  it('falls back to the lastfm username when no member is cached', async () => {
    const { npi } = build();
    await npi.handleLovedPagination(mkButton('loved:next:0:user1'));

    expect((TrackBuilders.buildLovedTracksResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      'user1',
    );
  });

  it('passes the decoded username, tracks, page and total to the builder', async () => {
    const { npi } = build();
    await npi.handleLovedPagination(mkButton('loved:next:1:Bj%C3%B6rk'));

    expect(TrackBuilders.buildLovedTracksResponse).toHaveBeenCalledWith(
      'Björk',
      'Björk',
      [{ name: 'Karma Police', artistName: 'Radiohead' }],
      2,
      42,
    );
  });

  it('edits the reply with the ComponentsV2 container when present', async () => {
    const { npi } = build();
    const press = mkButton('loved:next:0:user1');

    await npi.handleLovedPagination(press);

    expect(press.editReply).toHaveBeenCalledWith({ components: [{}] });
  });

  it('does not edit the reply when the response has no container', async () => {
    const { npi } = build();
    vi.spyOn(TrackBuilders, 'buildLovedTracksResponse').mockReturnValue({} as never);
    const press = mkButton('loved:next:0:user1');

    await npi.handleLovedPagination(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('swallows a repository failure without editing the reply', async () => {
    const { npi } = build({
      lastfmRepository: {
        getLovedTracks: vi.fn(async () => {
          throw new Error('db error');
        }),
      },
    });
    const press = mkButton('loved:next:0:user1');

    await expect(npi.handleLovedPagination(press)).resolves.toBeUndefined();
    expect(press.editReply).not.toHaveBeenCalled();
    expect(TrackBuilders.buildLovedTracksResponse).not.toHaveBeenCalled();
  });
});
