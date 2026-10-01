import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { MusicBuilders } from '@bot/builders/music/musicBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { playErrorMessage } from '@bot/services/music/musicService';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';

/**
 * Branch coverage for the music text commands beyond the guard file:
 * every handler's happy path, its refusal paths, and the response each
 * branch builds. Services are doubles; the builders are spied so the
 * assertions are about which response the command chose and with what
 * arguments, not about embed internals.
 */

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    member: { voice: { channelId: 'voice-1' }, displayName: 'Caller' },
    interaction: { channelId: 'text-1' },
    message: { channelId: 'text-1', id: 'm1' },
    userIsGuildAdmin: false,
    ...over,
  }) as unknown as ContextModel;

const build = (over: Record<string, unknown> = {}) => {
  // The real sentence logic, reached the way production reaches it: the service's
  // BOUND `playErrorMessage` is what supplies the manager, and the free function
  // is what turns that manager's answer into words. Re-stating the strings in
  // this file would make every assertion below a test of the double instead.
  const moonlinkManager = {
    getUnavailableReason: () =>
      (over.unavailable as { reason: string; retryAfterMs: number } | undefined) ?? {
        reason: 'rate-limited',
        retryAfterMs: 30_000,
      },
  };
  const musicService = {
    canControlPlayback: vi.fn(() => true),
    getQueueInfo: vi.fn(() => ({
      current: { title: 'Airbag', author: 'Radiohead', uri: 'https://example', duration: 255000 },
      guildUsers: [],
      tracks: [],
      totalTracks: 1,
      volume: 100,
      activeFilters: [],
      position: 0,
    })),
    getPlayer: vi.fn(() => undefined),
    playErrorMessage: (reason?: 'no-nodes' | 'voice' | 'search' | 'empty-spotify' | 'queue-full') =>
      playErrorMessage(reason, moonlinkManager as unknown as MoonlinkManager),
    play: vi.fn(async () => ({ loadType: 'empty' as const, totalTracksAdded: 0, positionInQueue: 0 })),
    searchTracks: vi.fn(async (..._a: unknown[]) => []),
    skip: vi.fn(async () => true),
    previous: vi.fn(async () => true),
    skipto: vi.fn(async () => true),
    move: vi.fn(async () => true),
    replay: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    seek: vi.fn(async () => 0),
    setVolume: vi.fn(() => 100),
    setFilter: vi.fn(async () => ({ applied: true, replaced: [] as string[] })),
    clearFilters: vi.fn(async () => true),
    toggle247: vi.fn(() => true),
    toggleKaraoke: vi.fn(() => true),
    toggleAutoplay: vi.fn(() => true),
    setLoop: vi.fn(() => 'track' as const),
    shuffle: vi.fn(() => true),
    clear: vi.fn(() => true),
    remove: vi.fn(() => null),
    getHistory: vi.fn(() => []),
    getNodeStats: vi.fn(() => []),
    getOrCreatePlayer: vi.fn(async () => ({ connected: true, connect: vi.fn(async () => undefined) })),
    ...(over.musicService as object),
  };
  const colorService = { getAccentColorAsync: vi.fn(async () => undefined) };
  const lyricsService = over.lyricsService as { getLyrics: ReturnType<typeof vi.fn> } | undefined;
  const musicInteractions = over.musicInteractions as { storeSearchResults: ReturnType<typeof vi.fn> } | undefined;
  const service = new MusicCommands(
    musicService as never,
    colorService as never,
    lyricsService as never,
    musicInteractions as never,
  );
  return { service, musicService, colorService, lyricsService, musicInteractions };
};

const call = (service: MusicCommands, name: string, ...args: unknown[]) => {
  const h = service as unknown as Record<string, (...a: unknown[]) => Promise<ResponseModel>>;
  return h[name]!.bind(service)(...args);
};

const builderCalled = (name: keyof typeof MusicBuilders) =>
  (MusicBuilders[name] as ReturnType<typeof vi.fn>).mock.calls;

beforeEach(() => {
  vi.restoreAllMocks();
  const simple = { embed: {}, setAutoDelete: vi.fn() };
  for (const n of [
    'buildQueueResponse',
    'buildNowPlayingResponse',
    'buildSearchResponse',
    'buildTrackAddedResponse',
    'buildPlaylistAddedResponse',
    'buildChaptersResponse',
    'buildLyricsResponse',
    'buildFiltersResponse',
    'buildNodeStatsResponse',
    'buildSimpleResponse',
  ] as const) {
    vi.spyOn(MusicBuilders, n).mockReturnValue(simple as never);
  }
});

describe('MusicCommands.playAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'playAsync', mkContext({ member: { displayName: 'x' } }), ['song']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('asks for a query when none is given', async () => {
    const { service, musicService } = build();
    const result = await call(service, 'playAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(musicService.play).not.toHaveBeenCalled();
  });

  it('reports nothing found for an empty load', async () => {
    const { service, musicService } = build();
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
    const result = await call(service, 'playAsync', mkContext(), ['bohemian rhapsody']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(result.embed.data.description).toContain('bohemian rhapsody');
  });

  it('maps a failed load to the play error message', async () => {
    const { service, musicService } = build();
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'error', errorReason: 'no-nodes', totalTracksAdded: 0, positionInQueue: 0 });
    const result = await call(service, 'playAsync', mkContext(), ['song']);
    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(result.embed.data.description).toContain('rate-limited');
  });

  it('answers a no-nodes failure from the real node state, not a rate limit', async () => {
    // The user-visible shape of the bug. `playErrorMessage` has no `this` of its
    // own, so a command that called the free function could never see a manager
    // and every no-nodes failure rendered the generic sentence: with
    // `ENABLE_LAVALINK=false` the manager reports `disabled`, and the reply used
    // to be "All music nodes are rate-limited right now. Try again in 30-60
    // seconds." — wrong, and waiting can never clear it. `.play` now goes
    // through the service's BOUND method, which is what supplies the manager.
    const { service, musicService } = build({ unavailable: { reason: 'disabled', retryAfterMs: 0 } });
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'error', errorReason: 'no-nodes', totalTracksAdded: 0, positionInQueue: 0 });

    const result = await call(service, 'playAsync', mkContext(), ['airbag']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    const text = result.embed.data.description ?? '';
    expect(text).toContain('disabled in this environment');
    expect(text).not.toMatch(/rate-limited|try again/i);
  });

  it('passes the requester identity through to the service', async () => {
    const { service, musicService } = build();
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
    await call(service, 'playAsync', mkContext({
      member: { voice: { channelId: 'voice-1' }, user: { tag: 'Caller#1234', displayAvatarURL: () => 'https://avatar' } },
    }), ['bohemian', 'rhapsody']);
    expect(musicService.play).toHaveBeenCalledWith(
      '222',
      'voice-1',
      'text-1',
      'bohemian rhapsody',
      { id: '111', tag: 'Caller#1234', avatarUrl: 'https://avatar' },
    );
  });

  it('falls back to a generic tag when the member has no user object', async () => {
    const { service, musicService } = build();
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
    await call(service, 'playAsync', mkContext(), ['song']);
    expect(musicService.play).toHaveBeenCalledWith(
      '222',
      'voice-1',
      'text-1',
      'song',
      { id: '111', tag: 'User', avatarUrl: undefined },
    );
  });

  it('builds a track-added response for a single track', async () => {
    const { service, musicService } = build();
    const track = { title: 'Airbag', author: 'Radiohead', uri: 'https://example', duration: 255000, source: 'youtube' };
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'track', track, totalTracksAdded: 1, positionInQueue: 1 });
    await call(service, 'playAsync', mkContext(), ['airbag']);
    expect(MusicBuilders.buildTrackAddedResponse).toHaveBeenCalledWith(track, 1, 1, undefined);
  });

  it('builds a playlist-added response with the youtube source badge', async () => {
    const { service, musicService } = build();
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({
      loadType: 'playlist',
      playlistName: 'Mix',
      tracks: [{ duration: 1000 }, { duration: 2000 }],
      totalTracksAdded: 2,
      positionInQueue: 1,
      artworkUrl: 'https://art',
    });
    await call(service, 'playAsync', mkContext(), ['mix']);
    expect(MusicBuilders.buildPlaylistAddedResponse).toHaveBeenCalledWith('Mix', 2, 3000, 'https://art', 1, undefined, 'youtube', false, undefined);
  });

  it('marks a spotify playlist load as spotify and partial', async () => {
    const { service, musicService } = build();
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({
      loadType: 'spotify_playlist',
      playlistName: 'Long Playlist',
      tracks: [{ duration: 1000 }],
      totalTracksAdded: 100,
      positionInQueue: 1,
      partial: true,
      partialReason: 'Spotify caps playlist contents at 100 tracks.',
    });
    await call(service, 'playAsync', mkContext(), ['playlist']);
    expect(MusicBuilders.buildPlaylistAddedResponse).toHaveBeenCalledWith(
      'Long Playlist',
      100,
      1000,
      undefined,
      1,
      undefined,
      'spotify',
      true,
      'Spotify caps playlist contents at 100 tracks.',
    );
  });
});

describe('MusicCommands.searchAsync happy path', () => {
  it('builds the search response and stores results for later interactions', async () => {
    const tracks = [{ title: 'A', author: 'B' }];
    const { service, musicService, musicInteractions } = build({
      musicInteractions: { storeSearchResults: vi.fn() },
    });
    (musicService.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue(tracks);
    await call(service, 'searchAsync', mkContext(), ['daft', 'punk']);
    expect(MusicBuilders.buildSearchResponse).toHaveBeenCalledWith('daft punk', tracks, undefined);
    expect(musicInteractions!.storeSearchResults).toHaveBeenCalledWith('m1', tracks);
    expect(musicInteractions!.storeSearchResults).toHaveBeenCalledWith('111', tracks);
  });

  it('does not store results when no interactions handler is wired', async () => {
    const { service, musicService } = build();
    (musicService.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([{ title: 'A' }]);
    await call(service, 'searchAsync', mkContext(), ['a']);
    expect(MusicBuilders.buildSearchResponse).toHaveBeenCalled();
  });
});

describe('MusicCommands.nowPlayingAsync happy path', () => {
  it('builds the now-playing response from the live queue', async () => {
    const { service, musicService } = build();
    const queue = { current: { title: 'Airbag' }, tracks: [] };
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue(queue);
    await call(service, 'nowPlayingAsync', mkContext());
    expect(MusicBuilders.buildNowPlayingResponse).toHaveBeenCalledWith(queue, undefined);
  });
});

describe('MusicCommands.queueAsync', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'queueAsync', mkContext({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when there is no queue', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'queueAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicCommands.previousAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'previousAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports when there is no previous track', async () => {
    const { service, musicService } = build();
    (musicService.previous as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'previousAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms a replay', async () => {
    const { service } = build();
    await call(service, 'previousAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏮️ Previous Track', 'Replaying previous track from history.');
  });
});

describe('MusicCommands.skiptoAsync', () => {
  it('refuses a non-numeric position', async () => {
    const { service } = build();
    const result = await call(service, 'skiptoAsync', mkContext(), ['abc']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses a position below 1', async () => {
    const { service } = build();
    const result = await call(service, 'skiptoAsync', mkContext(), ['0']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports an invalid position when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.skipto as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'skiptoAsync', mkContext(), ['9']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(result.embed.data.description).toContain('#9');
  });

  it('confirms the jump', async () => {
    const { service } = build();
    await call(service, 'skiptoAsync', mkContext(), ['3']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏭️ Jumped Track', 'Skipped to track **#3** in the queue.');
  });
});

describe('MusicCommands.moveAsync', () => {
  it('refuses malformed usage', async () => {
    const { service } = build();
    const result = await call(service, 'moveAsync', mkContext(), ['1']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses non-numeric positions', async () => {
    const { service } = build();
    const result = await call(service, 'moveAsync', mkContext(), ['a', '2']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports invalid positions when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.move as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'moveAsync', mkContext(), ['5', '1']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('confirms the move', async () => {
    const { service } = build();
    await call(service, 'moveAsync', mkContext(), ['5', '1']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('↔️ Moved Track', 'Moved track from position **#5** to **#1**.');
  });
});

describe('MusicCommands.replayAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'replayAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.replay as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'replayAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms the replay', async () => {
    const { service } = build();
    await call(service, 'replayAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔁 Replay', 'Restarted the current track from the beginning.');
  });
});

describe('MusicCommands.stopAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'stopAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('confirms the stop', async () => {
    const { service, musicService } = build();
    await call(service, 'stopAsync', mkContext());
    expect(musicService.stop).toHaveBeenCalledWith('222');
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏹️ Stopped', 'Playback stopped and disconnected from voice.');
  });
});

describe('MusicCommands.pauseAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'pauseAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.pause as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'pauseAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms the pause', async () => {
    const { service } = build();
    await call(service, 'pauseAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏸️ Paused', 'Playback paused. Use `.resume` to continue.');
  });
});

describe('MusicCommands.resumeAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'resumeAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports when nothing is paused', async () => {
    const { service, musicService } = build();
    (musicService.resume as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'resumeAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms the resume', async () => {
    const { service } = build();
    await call(service, 'resumeAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('▶️ Resumed', 'Playback resumed.');
  });
});

describe('MusicCommands.seekAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'seekAsync', mkContext({ member: { displayName: 'x' } }), ['10']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('asks for a time when none is given', async () => {
    const { service, musicService } = build();
    const result = await call(service, 'seekAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(musicService.seek).not.toHaveBeenCalled();
  });

  it('parses mm:ss', async () => {
    const { service, musicService } = build();
    (musicService.seek as ReturnType<typeof vi.fn>).mockResolvedValue(90000);
    await call(service, 'seekAsync', mkContext(), ['1:30']);
    expect(musicService.seek).toHaveBeenCalledWith('222', 90);
  });

  it('parses hh:mm:ss', async () => {
    const { service, musicService } = build();
    (musicService.seek as ReturnType<typeof vi.fn>).mockResolvedValue(3661000);
    await call(service, 'seekAsync', mkContext(), ['1:01:01']);
    expect(musicService.seek).toHaveBeenCalledWith('222', 3661);
  });

  it('refuses a time with too many colons', async () => {
    const { service } = build();
    const result = await call(service, 'seekAsync', mkContext(), ['1:2:3:4']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses a negative time', async () => {
    const { service } = build();
    const result = await call(service, 'seekAsync', mkContext(), ['-5']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses a non-numeric time', async () => {
    const { service } = build();
    const result = await call(service, 'seekAsync', mkContext(), ['abc']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when the service returns null', async () => {
    const { service, musicService } = build();
    (musicService.seek as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'seekAsync', mkContext(), ['10']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports an exact jump', async () => {
    const { service, musicService } = build();
    (musicService.seek as ReturnType<typeof vi.fn>).mockResolvedValue(90000);
    await call(service, 'seekAsync', mkContext(), ['1:30']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏩ Seeked', 'Jumped to `1:30` in the current track.');
  });

  it('reports a clamped jump honestly', async () => {
    const { service, musicService } = build();
    (musicService.seek as ReturnType<typeof vi.fn>).mockResolvedValue(30000);
    await call(service, 'seekAsync', mkContext(), ['5:00']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏩ Seeked', 'Jumped to `0:30` — that is as far as this track goes.');
  });
});

describe('MusicCommands.chaptersAsync', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'chaptersAsync', mkContext({ guildId: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when there is no queue', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'chaptersAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports no chapters when the player has none', async () => {
    const { service, musicService } = build();
    (musicService.getPlayer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const result = await call(service, 'chaptersAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports no chapters when there are fewer than two', async () => {
    const { service, musicService } = build();
    (musicService.getPlayer as ReturnType<typeof vi.fn>).mockReturnValue({ get: vi.fn(() => [{ startMs: 0, title: 'Only' }]) });
    const result = await call(service, 'chaptersAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the chapters response with the current chapter index', async () => {
    const { service, musicService } = build();
    const chapters = [{ startMs: 0, title: 'Intro' }, { startMs: 60000, title: 'Verse' }];
    (musicService.getPlayer as ReturnType<typeof vi.fn>).mockReturnValue({ get: vi.fn(() => chapters) });
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ current: { title: 'x' }, position: 65000 });
    await call(service, 'chaptersAsync', mkContext());
    expect(MusicBuilders.buildChaptersResponse).toHaveBeenCalledWith({ title: 'x' }, chapters, 1, undefined);
  });
});

describe('MusicCommands.volumeAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'volumeAsync', mkContext({ member: { displayName: 'x' } }), ['50']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('shows the current volume when no arg is given', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ volume: 42 });
    await call(service, 'volumeAsync', mkContext(), []);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔊 Current Volume', 'The player volume is currently set to **42%**.');
  });

  it('defaults to 100 when the queue reports no volume', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ volume: undefined });
    await call(service, 'volumeAsync', mkContext(), []);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔊 Current Volume', 'The player volume is currently set to **100%**.');
  });

  it('refuses an out-of-range volume', async () => {
    const { service } = build();
    const result = await call(service, 'volumeAsync', mkContext(), ['151']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses a non-numeric volume', async () => {
    const { service } = build();
    const result = await call(service, 'volumeAsync', mkContext(), ['loud']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when setVolume returns null', async () => {
    const { service, musicService } = build();
    (musicService.setVolume as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'volumeAsync', mkContext(), ['50']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms the new volume', async () => {
    const { service, musicService } = build();
    (musicService.setVolume as ReturnType<typeof vi.fn>).mockReturnValue(50);
    await call(service, 'volumeAsync', mkContext(), ['50']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔊 Volume Changed', 'Volume set to **50%**.');
  });
});

describe('MusicCommands.filtersAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'filtersAsync', mkContext({ member: { displayName: 'x' } }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when there is no queue', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'filtersAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('shows active filters when no arg is given', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ activeFilters: ['bassboost'] });
    await call(service, 'filtersAsync', mkContext(), []);
    expect(MusicBuilders.buildFiltersResponse).toHaveBeenCalledWith(['bassboost'], undefined);
  });

  it('clears filters on the clear arg', async () => {
    const { service, musicService } = build();
    (musicService.clearFilters as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await call(service, 'filtersAsync', mkContext(), ['clear']);
    expect(musicService.clearFilters).toHaveBeenCalledWith('222');
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🎛️ Filters Cleared', 'All audio filters have been removed.', undefined);
  });

  it('reports an error when clearing fails', async () => {
    const { service, musicService } = build();
    (musicService.clearFilters as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'filtersAsync', mkContext(), ['reset']);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('refuses an unknown filter', async () => {
    const { service } = build();
    const result = await call(service, 'filtersAsync', mkContext(), ['echo']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(result.embed.data.description).toContain('echo');
  });

  it('toggles a filter on when it is inactive', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ activeFilters: [] });
    (musicService.setFilter as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: true, replaced: [] });
    await call(service, 'filtersAsync', mkContext(), ['nightcore']);
    expect(musicService.setFilter).toHaveBeenCalledWith('222', 'nightcore', true);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🎛️ Filter Toggled', 'Filter **nightcore** is now **ENABLED**.', undefined);
  });

  it('toggles a filter off when it is active', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ activeFilters: ['bassboost'] });
    (musicService.setFilter as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: true, replaced: [] });
    await call(service, 'filtersAsync', mkContext(), ['bassboost']);
    expect(musicService.setFilter).toHaveBeenCalledWith('222', 'bassboost', false);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🎛️ Filter Toggled', 'Filter **bassboost** is now **DISABLED**.', undefined);
  });

  it('notes replaced filters', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ activeFilters: [] });
    (musicService.setFilter as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: true, replaced: ['distortion'] });
    await call(service, 'filtersAsync', mkContext(), ['bassboost']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith(
      '🎛️ Filter Toggled',
      'Filter **bassboost** is now **ENABLED**. (replaced **distortion**)',
      undefined,
    );
  });

  it('reports an error when the node rejects the filter', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ activeFilters: [] });
    (musicService.setFilter as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false, replaced: [] });
    const result = await call(service, 'filtersAsync', mkContext(), ['nightcore']);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });
});

describe('MusicCommands.lyricsAsync', () => {
  it('reports the service as unavailable when it is not wired', async () => {
    const { service } = build();
    const result = await call(service, 'lyricsAsync', mkContext(), ['song']);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('asks for a title when none is given outside a server', async () => {
    const { service } = build({ lyricsService: { getLyrics: vi.fn(async () => null) } });
    const result = await call(service, 'lyricsAsync', mkContext({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('asks for a title when nothing is playing', async () => {
    const { service, musicService } = build({ lyricsService: { getLyrics: vi.fn(async () => null) } });
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ current: null });
    const result = await call(service, 'lyricsAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('falls back to the current track title and author', async () => {
    const { service, musicService, lyricsService } = build({ lyricsService: { getLyrics: vi.fn(async () => null) } });
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ current: { title: 'Airbag', author: 'Radiohead' } });
    await call(service, 'lyricsAsync', mkContext(), []);
    expect(lyricsService!.getLyrics).toHaveBeenCalledWith('Airbag', 'Radiohead');
  });

  it('reports when lyrics are not found', async () => {
    const { service } = build({ lyricsService: { getLyrics: vi.fn(async () => null) } });
    const result = await call(service, 'lyricsAsync', mkContext(), ['unknown song']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports when the result has no plain lyrics', async () => {
    const { service } = build({
      lyricsService: { getLyrics: vi.fn(async () => ({ title: 'T', artist: 'A', plainLyrics: '', instrumental: true })) },
    });
    const result = await call(service, 'lyricsAsync', mkContext(), ['song']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('truncates very long lyrics', async () => {
    const long = 'la'.repeat(5000);
    const { service } = build({
      lyricsService: { getLyrics: vi.fn(async () => ({ title: 'T', artist: 'A', plainLyrics: long, instrumental: false })) },
    });
    await call(service, 'lyricsAsync', mkContext(), ['song']);
    const [, , lyricsArg] = builderCalled('buildLyricsResponse')[0] as unknown as [string, string, string];
    expect(lyricsArg).toContain('*(Lyrics truncated)*');
    expect(lyricsArg).not.toContain(long);
    expect(lyricsArg.length).toBeLessThan(4000);
  });

  it('builds the lyrics response', async () => {
    const { service } = build({
      lyricsService: { getLyrics: vi.fn(async () => ({ title: 'Airbag', artist: 'Radiohead', plainLyrics: 'In the next world war', instrumental: false })) },
    });
    await call(service, 'lyricsAsync', mkContext(), ['airbag']);
    expect(MusicBuilders.buildLyricsResponse).toHaveBeenCalledWith('Airbag', 'Radiohead', 'In the next world war', undefined);
  });
});

describe('MusicCommands.joinAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'joinAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('connects a disconnected player', async () => {
    const { service, musicService } = build();
    const connect = vi.fn(async () => undefined);
    (musicService.getOrCreatePlayer as ReturnType<typeof vi.fn>).mockResolvedValue({ connected: false, connect });
    await call(service, 'joinAsync', mkContext());
    expect(connect).toHaveBeenCalledWith({ selfDeaf: true });
  });

  it('does not reconnect an already connected player', async () => {
    const { service, musicService } = build();
    const connect = vi.fn(async () => undefined);
    (musicService.getOrCreatePlayer as ReturnType<typeof vi.fn>).mockResolvedValue({ connected: true, connect });
    await call(service, 'joinAsync', mkContext());
    expect(connect).not.toHaveBeenCalled();
  });

  it('confirms the join with the channel mention', async () => {
    const { service, musicService } = build();
    (musicService.getOrCreatePlayer as ReturnType<typeof vi.fn>).mockResolvedValue({ connected: true, connect: vi.fn() });
    await call(service, 'joinAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔊 Connected', 'Joined voice channel <#voice-1>.');
  });
});

describe('MusicCommands.toggle247Async', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'toggle247Async', mkContext({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('enables with an explicit on', async () => {
    const { service, musicService } = build();
    (musicService.toggle247 as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await call(service, 'toggle247Async', mkContext(), ['on']);
    expect(musicService.toggle247).toHaveBeenCalledWith('222', true);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('📻 24/7 Mode', expect.stringContaining('ENABLED'));
  });

  it('disables with an explicit off', async () => {
    const { service, musicService } = build();
    (musicService.toggle247 as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await call(service, 'toggle247Async', mkContext(), ['off']);
    expect(musicService.toggle247).toHaveBeenCalledWith('222', false);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('📻 24/7 Mode', expect.stringContaining('DISABLED'));
  });

  it('toggles when no arg is given', async () => {
    const { service, musicService } = build();
    (musicService.toggle247 as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await call(service, 'toggle247Async', mkContext(), []);
    expect(musicService.toggle247).toHaveBeenCalledWith('222', undefined);
  });

  it('ignores a meaningless arg and toggles', async () => {
    const { service, musicService } = build();
    (musicService.toggle247 as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await call(service, 'toggle247Async', mkContext(), ['maybe']);
    expect(musicService.toggle247).toHaveBeenCalledWith('222', undefined);
  });
});

describe('MusicCommands.karaokeAsync', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'karaokeAsync', mkContext({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('enables with an explicit on', async () => {
    const { service, musicService } = build();
    (musicService.toggleKaraoke as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await call(service, 'karaokeAsync', mkContext(), ['on']);
    expect(musicService.toggleKaraoke).toHaveBeenCalledWith('222', true);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🎤 Live Lyrics', expect.stringContaining('ENABLED'));
  });

  it('disables with an explicit off', async () => {
    const { service, musicService } = build();
    (musicService.toggleKaraoke as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await call(service, 'karaokeAsync', mkContext(), ['off']);
    expect(musicService.toggleKaraoke).toHaveBeenCalledWith('222', false);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🎤 Live Lyrics', expect.stringContaining('DISABLED'));
  });
});

describe('MusicCommands.autoplayAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'autoplayAsync', mkContext({ member: { displayName: 'x' } }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports no active player when the service returns null', async () => {
    const { service, musicService } = build();
    (musicService.toggleAutoplay as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'autoplayAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('enables with an explicit on', async () => {
    const { service, musicService } = build();
    (musicService.toggleAutoplay as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await call(service, 'autoplayAsync', mkContext(), ['on']);
    expect(musicService.toggleAutoplay).toHaveBeenCalledWith('222', true);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('📻 Autoplay', expect.stringContaining('ENABLED'));
  });

  it('disables with an explicit off', async () => {
    const { service, musicService } = build();
    (musicService.toggleAutoplay as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await call(service, 'autoplayAsync', mkContext(), ['off']);
    expect(musicService.toggleAutoplay).toHaveBeenCalledWith('222', false);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('📻 Autoplay', expect.stringContaining('DISABLED'));
  });
});

describe('MusicCommands.loopAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'loopAsync', mkContext({ member: { displayName: 'x' } }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses an invalid mode', async () => {
    const { service } = build();
    const result = await call(service, 'loopAsync', mkContext(), ['banana']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('sets track mode', async () => {
    const { service, musicService } = build();
    (musicService.setLoop as ReturnType<typeof vi.fn>).mockReturnValue('track');
    await call(service, 'loopAsync', mkContext(), ['track']);
    expect(musicService.setLoop).toHaveBeenCalledWith('222', 'track');
  });

  it('sets queue mode', async () => {
    const { service, musicService } = build();
    (musicService.setLoop as ReturnType<typeof vi.fn>).mockReturnValue('queue');
    await call(service, 'loopAsync', mkContext(), ['queue']);
    expect(musicService.setLoop).toHaveBeenCalledWith('222', 'queue');
  });

  it('sets off mode', async () => {
    const { service, musicService } = build();
    (musicService.setLoop as ReturnType<typeof vi.fn>).mockReturnValue('off');
    await call(service, 'loopAsync', mkContext(), ['off']);
    expect(musicService.setLoop).toHaveBeenCalledWith('222', 'off');
  });

  it('defaults to track mode when no arg is given', async () => {
    const { service, musicService } = build();
    (musicService.setLoop as ReturnType<typeof vi.fn>).mockReturnValue('track');
    await call(service, 'loopAsync', mkContext(), []);
    expect(musicService.setLoop).toHaveBeenCalledWith('222', 'track');
  });

  it('reports nothing playing when the service returns null', async () => {
    const { service, musicService } = build();
    (musicService.setLoop as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'loopAsync', mkContext(), ['track']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms the applied mode in uppercase', async () => {
    const { service, musicService } = build();
    (musicService.setLoop as ReturnType<typeof vi.fn>).mockReturnValue('queue');
    await call(service, 'loopAsync', mkContext(), ['queue']);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔁 Loop Mode', 'Loop mode set to **QUEUE**.');
  });
});

describe('MusicCommands.shuffleAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'shuffleAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports an empty queue when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.shuffle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await call(service, 'shuffleAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('confirms the shuffle', async () => {
    const { service } = build();
    await call(service, 'shuffleAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🔀 Shuffled', 'The music queue has been randomized.');
  });
});

describe('MusicCommands.clearAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'clearAsync', mkContext({ member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports no active player when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.clear as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await call(service, 'clearAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('confirms the clear', async () => {
    const { service } = build();
    await call(service, 'clearAsync', mkContext());
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🗑️ Queue Cleared', 'All upcoming tracks have been removed from the queue.');
  });
});

describe('MusicCommands.removeAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'removeAsync', mkContext({ member: { displayName: 'x' } }), ['1']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('asks for a position when none is given', async () => {
    const { service } = build();
    const result = await call(service, 'removeAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses a non-numeric position', async () => {
    const { service } = build();
    const result = await call(service, 'removeAsync', mkContext(), ['abc']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses a position below 1', async () => {
    const { service } = build();
    const result = await call(service, 'removeAsync', mkContext(), ['0']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports no track at the position when the service returns null', async () => {
    const { service, musicService } = build();
    (musicService.remove as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'removeAsync', mkContext(), ['2']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(result.embed.data.description).toContain('#2');
  });

  it('confirms the removal with the track title', async () => {
    const { service, musicService } = build();
    (musicService.remove as ReturnType<typeof vi.fn>).mockReturnValue({ title: 'Airbag' });
    await call(service, 'removeAsync', mkContext(), ['2']);
    expect(musicService.remove).toHaveBeenCalledWith('222', 1);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('🗑️ Removed', 'Removed **Airbag** from position #2.');
  });
});

describe('MusicCommands.historyAsync', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'historyAsync', mkContext({ guildId: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports an empty history', async () => {
    const { service, musicService } = build();
    (musicService.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const result = await call(service, 'historyAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the recently-played list', async () => {
    const { service, musicService } = build();
    (musicService.getHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { track: { title: 'Airbag', uri: 'https://example/1', author: 'Radiohead' } },
      { track: { title: 'Paranoid Android', uri: 'https://example/2', author: 'Radiohead' } },
    ]);
    await call(service, 'historyAsync', mkContext());
    expect(musicService.getHistory).toHaveBeenCalledWith('222', 10);
    const [, desc] = builderCalled('buildSimpleResponse')[0] as unknown as [string, string];
    expect(desc).toContain('[Airbag](https://example/1)');
    expect(desc).toContain('[Paranoid Android](https://example/2)');
  });
});

describe('MusicCommands.nodesAsync', () => {
  it('builds the node stats response, passing the admin flag', async () => {
    const { service, musicService } = build();
    const stats = [{ name: 'node-1' }];
    (musicService.getNodeStats as ReturnType<typeof vi.fn>).mockReturnValue(stats);
    await call(service, 'nodesAsync', mkContext());
    expect(MusicBuilders.buildNodeStatsResponse).toHaveBeenCalledWith(stats, undefined, false);
  });

  it('passes the admin flag through for an admin caller', async () => {
    const { service, musicService } = build();
    const stats = [{ name: 'node-1' }];
    (musicService.getNodeStats as ReturnType<typeof vi.fn>).mockReturnValue(stats);
    await call(service, 'nodesAsync', mkContext({ userIsGuildAdmin: true }));
    expect(MusicBuilders.buildNodeStatsResponse).toHaveBeenCalledWith(stats, undefined, true);
  });
});

describe('MusicCommands control-gate wrapping', () => {
  it('routes a control command through the requester-or-admin gate', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const def = service.commands.find((c) => c.name === 'skip')!;
    const result = await def.executeAsync!(mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(musicService.skip).not.toHaveBeenCalled();
  });

  it('lets a control command through when the caller may control playback', async () => {
    const { service } = build();
    const def = service.commands.find((c) => c.name === 'skip')!;
    await def.executeAsync!(mkContext(), []);
    expect(MusicBuilders.buildSimpleResponse).toHaveBeenCalledWith('⏭️ Skipped', 'Skipped to the next track.');
  });

  it('leaves read-only commands ungated', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const def = service.commands.find((c) => c.name === 'nowplaying')!;
    await def.executeAsync!(mkContext(), []);
    expect(musicService.canControlPlayback).not.toHaveBeenCalled();
    expect(MusicBuilders.buildNowPlayingResponse).toHaveBeenCalled();
  });

  it('does not gate play, which is how a shared music bot is meant to be used', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (musicService.play as ReturnType<typeof vi.fn>).mockResolvedValue({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
    const def = service.commands.find((c) => c.name === 'play')!;
    const result = await def.executeAsync!(mkContext(), ['song']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(musicService.play).toHaveBeenCalled();
  });
});
