/**
 * `/music` - the playback surface, tested through the reply the user reads.
 *
 * Almost every handler in this module ends in the same shape: ask the service
 * for an outcome, and turn a falsy outcome into an honest refusal. That shape
 * is the whole file, because a falsy outcome is the ONLY thing separating "I
 * changed your volume" from a lie.
 *
 * Four of them are worth naming:
 *
 * - `executeVolume`. `MusicService.setVolume` returns `number | null` and the
 *   null is the no-player case. Interpolating it produced the legendary
 *   "Volume set to null%" - a card that CLAIMS a volume change that never
 *   happened. The guard is `if (applied === null)`, and this file asserts the
 *   text never contains "null" as well as the enum, because the enum alone
 *   would still pass a builder that printed it anyway.
 * - `executeFilter`. `setFilter` returns `{ applied, replaced }` and a node
 *   rejection arrives as `applied: false`. Reporting that as ENABLED would tell
 *   a listener their EQ is on while the audio is untouched.
 * - `executeSeek`. `seek` returns the position ACTUALLY applied, and the reply
 *   has to distinguish "jumped where you asked" from "clamped to the end of
 *   the track". Quoting the request instead of the result is how a seek past
 *   the end of a song reports success at a position that does not exist.
 * - `executeChapters`. Fewer than two chapters is not a chapters card; it is
 *   "no chapters available", and rendering an empty menu would present a
 *   feature as working.
 *
 * Nothing here is spied on. The collaborators are plain object doubles handed
 * to the constructor and the REAL `MusicBuilders` render the cards, so every
 * assertion is on text a user would read. (The existing guard test does spy on
 * the builder statics; this file deliberately does not, so the two have
 * independent failure modes.)
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { MusicSlashCommands } from '@bot/slashCommands/musicSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { playErrorMessage } from '@bot/services/music/musicService';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { MusicService } from '@bot/services/music/musicService';
import type { ColorService } from '@bot/services/system/colorService';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { MusicInteractions } from '@bot/interactions/musicInteractions';

const TRACK = {
  identifier: 'yt-1',
  title: 'Airbag',
  author: 'Radiohead',
  uri: 'https://youtu.be/xyz',
  duration: 284000,
  isSeekable: true,
  isStream: false,
  artworkUrl: 'https://img.test/airbag.jpg',
  source: 'youtube',
};

const queue = (over: Record<string, unknown> = {}) => ({
  guildId: '222',
  current: TRACK,
  tracks: [TRACK],
  totalTracks: 1,
  totalDuration: 284000,
  remainingDuration: 284000,
  loopMode: 'off',
  volume: 100,
  isPaused: false,
  isPlaying: true,
  is247: false,
  autoplay: false,
  activeFilters: [] as string[],
  position: 70000,
  ping: 20,
  ...over,
});

/**
 * Every text component on a Components V2 card, at any depth.
 *
 * RECURSIVE on purpose: `MusicBuilders` puts the now-playing title inside a
 * `Section`, so its `TextDisplay` is at `components[0].components[0]` and a
 * top-level-only walk never sees it.
 */
const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    const walk = (nodes: unknown[]): string[] =>
      nodes.flatMap((node) => {
        const n = node as { content?: unknown; components?: unknown[] };
        const own = typeof n.content === 'string' ? [n.content] : [];
        return [...own, ...(Array.isArray(n.components) ? walk(n.components) : [])];
      });
    return walk(
      (response.componentsV2Container.toJSON() as { components: unknown[] }).components,
    ).join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface CtxSpec {
  sub?: string | null;
  strings?: Record<string, string | undefined>;
  integers?: Record<string, number | undefined>;
  inGuild?: boolean;
  inVoice?: boolean;
  userIsGuildAdmin?: boolean;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  const inVoice = spec.inVoice !== false;
  return {
    discordUserId: 'caller1',
    guildId: inGuild ? '222' : undefined,
    prefix: '/',
    member: inVoice ? { voice: { channelId: 'voice1' }, displayName: 'Caller' } : { displayName: 'Caller' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      user: { id: 'caller1', tag: 'caller#1', displayAvatarURL: () => 'https://img.test/av.png' },
      options: {
        getSubcommand: () => (spec.sub === undefined ? 'play' : spec.sub),
        getString: (name: string) => spec.strings?.[name] ?? null,
        getInteger: (name: string) => spec.integers?.[name] ?? null,
        getBoolean: () => null,
      },
    },
    userIsGuildAdmin: spec.userIsGuildAdmin === true,
  } as unknown as ContextModel;
};

interface Doubles {
  playResult?: unknown;
  queueInfo?: unknown;
  /** What the node manager says is wrong, for a no-nodes play error. */
  unavailable?: { reason: string; retryAfterMs: number };
  setVolume?: number | null;
  setLoop?: unknown;
  toggleAutoplay?: boolean | null;
  setFilter?: { applied: boolean; replaced: string[] };
  seek?: number | null;
  clear?: boolean;
  shuffle?: boolean;
  remove?: { title: string } | null;
  history?: unknown[];
  chapters?: unknown;
  getPlayer?: () => unknown;
  getOrCreatePlayer?: () => unknown;
  lyrics?: unknown;
  nodeStats?: unknown[];
  searchTracks?: unknown[];
  storeSearchResults?: () => void;
}

const build = (over: Doubles = {}) => {
  // The real sentence logic, reached the way production reaches it: a manager
  // plus the module function. Re-implementing the strings here would make every
  // assertion below a test of this file instead of of the service.
  const moonlinkManager = {
    getUnavailableReason: () => over.unavailable ?? { reason: 'rate-limited', retryAfterMs: 30_000 },
  };
  const musicService = {
    // `play` is not a control subcommand, so it is never gated, but the gate
    // stub keeps a stray call from throwing.
    canControlPlayback: vi.fn(() => true),
    playErrorMessage: (reason?: 'no-nodes' | 'voice' | 'search' | 'empty-spotify' | 'queue-full') =>
      playErrorMessage(reason, moonlinkManager as unknown as MoonlinkManager),
    play: vi.fn(async () =>
      over.playResult ?? { loadType: 'track', track: TRACK, totalTracksAdded: 1, positionInQueue: 1 },
    ),
    searchTracks: vi.fn(async () => (over.searchTracks ?? [TRACK])),
    getQueueInfo: vi.fn(() => (over.queueInfo === undefined ? queue() : over.queueInfo)),
    getPlayer: vi.fn(() => (over.getPlayer ? over.getPlayer() : undefined)),
    getOrCreatePlayer: vi.fn(async () =>
      over.getOrCreatePlayer ? over.getOrCreatePlayer() : { connected: true, connect: vi.fn() },
    ),
    getHistory: vi.fn(() => (over.history ?? [])),
    getNodeStats: vi.fn(() => (over.nodeStats ?? [])),
    setVolume: vi.fn(() => (over.setVolume === undefined ? 100 : over.setVolume)),
    setLoop: vi.fn(() => (over.setLoop === undefined ? 'track' : over.setLoop)),
    toggle247: vi.fn(() => true),
    toggleKaraoke: vi.fn(() => true),
    toggleAutoplay: vi.fn(() => (over.toggleAutoplay === undefined ? true : over.toggleAutoplay)),
    setFilter: vi.fn(async () => over.setFilter ?? { applied: true, replaced: [] }),
    seek: vi.fn(async () => (over.seek === undefined ? 10000 : over.seek)),
    clear: vi.fn(() => (over.clear === undefined ? true : over.clear)),
    shuffle: vi.fn(() => (over.shuffle === undefined ? true : over.shuffle)),
    remove: vi.fn(() => (over.remove === undefined ? { title: 'Airbag' } : over.remove)),
    stop: vi.fn(async () => undefined),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
  } as unknown as MusicService;
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0x778899),
  } as unknown as ColorService;
  const lyricsService = {
    getLyrics: vi.fn(async () => (over.lyrics === undefined ? null : over.lyrics)),
  } as unknown as LyricsService;
  const musicInteractions = {
    storeSearchResults: vi.fn(over.storeSearchResults ?? (() => undefined)),
  } as unknown as MusicInteractions;

  const cmd = new MusicSlashCommands(musicService, colorService, lyricsService, musicInteractions);
  return { cmd, musicService, colorService, lyricsService, musicInteractions };
};

type Handlers = Record<string, (c: ContextModel) => Promise<ResponseModel>>;
const call = (cmd: MusicSlashCommands, name: string, ctx: ContextModel) =>
  (cmd as unknown as Handlers)[name]!(ctx);

const inVoice = (spec: CtxSpec = {}) => makeCtx({ inVoice: true, sub: 'play', ...spec });

describe('/music play: the query the user typed, or the reason it failed', () => {
  it('refuses outside a voice channel without searching', async () => {
    const { cmd, musicService } = build();
    const response = await call(cmd, 'executePlay', inVoice({ inVoice: false, strings: { query: 'airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('must be in a voice channel');
    expect(musicService.play).not.toHaveBeenCalled();
  });

  it('refuses a blank query rather than searching for nothing', async () => {
    const { cmd, musicService } = build();
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: '   ' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(musicService.play).not.toHaveBeenCalled();
  });

  it('names the query when the search resolved to nothing', async () => {
    const { cmd } = build({
      playResult: { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 },
    });
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: 'qzx nonexistent' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('qzx nonexistent');
  });

  it('surfaces the REAL reason for a failed play, not a generic failure', async () => {
    // `playErrorMessage` exists precisely because "something went wrong" sent
    // people to check their own connection when the queue was full.
    const { cmd } = build({
      playResult: { loadType: 'error', errorReason: 'queue-full', totalTracksAdded: 0, positionInQueue: 0 },
    });
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: 'airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Error);
    expect(cardText(response)).toContain('queue is full');
  });

  it('a no-nodes play error is answered from the real node state, not a rate limit', async () => {
    // The user-visible shape of the bug: with `ENABLE_LAVALINK=false` the
    // manager reports `disabled`, and the reply used to be "All music nodes are
    // rate-limited right now. Try again in 30-60 seconds." — wrong, and waiting
    // can never clear it. The command reaches this through the service's BOUND
    // form (`musicService.playErrorMessage`), which is what supplies the
    // manager; the free function has no way to.
    const { cmd } = build({
      playResult: { loadType: 'error', errorReason: 'no-nodes', totalTracksAdded: 0, positionInQueue: 0 },
      unavailable: { reason: 'disabled', retryAfterMs: 0 },
    });
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: 'airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Error);
    const text = cardText(response);
    expect(text).toContain('disabled in this environment');
    expect(text).not.toMatch(/rate-limited|try again/i);
  });

  it('refuses a source that resolved to nothing instead of announcing it as added', async () => {
    // Every collection load type carries its tracks (musicService.ts:594-603,
    // :839-845), so a `playlist` with none means NOTHING was added. The old
    // final arm answered "Added to Queue" for it, which is a claim about a
    // queue change that never happened.
    const { cmd } = build({
      playResult: { loadType: 'playlist', totalTracksAdded: 0, positionInQueue: 0 },
    });
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: 'my playlist' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    const text = cardText(response);
    expect(text).toContain('No tracks found');
    expect(text).not.toContain('Added to Queue');
  });

  it('renders the now-playing card for a single resolved track', async () => {
    const { cmd } = build();
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: 'airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Airbag');
  });

  it('sums the duration of a resolved playlist rather than reporting the first track', async () => {
    const { cmd } = build({
      playResult: {
        loadType: 'playlist',
        playlistName: 'Long Set',
        tracks: [TRACK, { ...TRACK, title: 'Suburban', duration: 1000 }],
        totalTracksAdded: 2,
        positionInQueue: 1,
      },
    });
    const response = await call(cmd, 'executePlay', inVoice({ strings: { query: 'my playlist' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('Long Set');
    expect(text).toContain('4:45');
  });
});

describe('/music volume: a null from the service is not a volume of zero, and not "null%"', () => {
  it('reports the CURRENT volume when no level is given', async () => {
    const { cmd, musicService } = build({ queueInfo: queue({ volume: 42 }) });
    const response = await call(cmd, 'executeVolume', makeCtx({ sub: 'volume' }));

    expect(musicService.setVolume).not.toHaveBeenCalled();
    expect(cardText(response)).toContain('currently set to **42%**');
  });

  it('refuses to report a volume for a player that does not exist', async () => {
    // `const currentVol = queue?.volume ?? 100` made up a 100% for a guild with
    // no queue at all, and "The player volume is currently set to 100%" is a
    // claim about a player this server does not have. The opposite direction —
    // a real player reporting its real volume — is the test above.
    const { cmd, musicService } = build({ queueInfo: null });
    const response = await call(cmd, 'executeVolume', makeCtx({ sub: 'volume' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    const text = cardText(response);
    expect(text).toContain('No music is currently playing');
    expect(text).not.toMatch(/currently set to/);
    // And it never even tries to change anything.
    expect(musicService.setVolume).not.toHaveBeenCalled();
  });

  it('refuses instead of printing "Volume set to null%" when there is no player', async () => {
    const { cmd } = build({ setVolume: null });
    const response = await call(cmd, 'executeVolume', makeCtx({ sub: 'volume', integers: { level: 80 } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    const text = cardText(response);
    expect(text).toContain('No music is currently playing');
    expect(text).not.toContain('null');
  });

  it('reports the volume the node ACTUALLY applied, not the one requested', async () => {
    // The service clamps to 0..150. Echoing the request would tell a user their
    // 400% request took effect.
    const { cmd, musicService } = build({ setVolume: 150 });
    const response = await call(cmd, 'executeVolume', makeCtx({ sub: 'volume', integers: { level: 400 } }));

    expect(musicService.setVolume).toHaveBeenCalledWith('222', 400);
    expect(cardText(response)).toContain('Volume set to **150%**');
    expect(cardText(response)).not.toContain('400%');
  });
});

describe('/music seek: the reply quotes the position actually applied', () => {
  it('refuses when there is nothing playing to seek in', async () => {
    const { cmd } = build({ seek: null });
    const response = await call(cmd, 'executeSeek', makeCtx({ sub: 'seek', integers: { seconds: 30 } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No track is currently playing to seek');
  });

  it('confirms the requested position when it was honoured', async () => {
    const { cmd } = build({ seek: 30000 });
    const response = await call(cmd, 'executeSeek', makeCtx({ sub: 'seek', integers: { seconds: 30 } }));

    expect(cardText(response)).toContain('Jumped to **30** seconds in the current track');
  });

  it('says the seek was clamped rather than claiming the requested position', async () => {
    const { cmd } = build({ seek: 284000 });
    const response = await call(cmd, 'executeSeek', makeCtx({ sub: 'seek', integers: { seconds: 9999 } }));

    const text = cardText(response);
    expect(text).toContain('Jumped to **284** seconds');
    expect(text).toContain('that is the end of the track');
  });
});

describe('/music filter: a node that refused the filter is not a filter that is on', () => {
  it('lists the filters when none is named, and writes nothing', async () => {
    const { cmd, musicService } = build();
    const response = await call(cmd, 'executeFilter', makeCtx({ sub: 'filter' }));

    expect(musicService.setFilter).not.toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('refuses when there is no queue at all', async () => {
    const { cmd } = build({ queueInfo: null });
    const response = await call(cmd, 'executeFilter', makeCtx({ sub: 'filter' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No music is currently playing');
  });

  it('reports an ERROR and never says ENABLED when the node rejected the filter', async () => {
    const { cmd } = build({ setFilter: { applied: false, replaced: [] } });
    const response = await call(
      cmd,
      'executeFilter',
      makeCtx({ sub: 'filter', strings: { type: 'bassboost' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.Error);
    const text = cardText(response);
    expect(text).toContain("Couldn't apply");
    expect(text).not.toContain('ENABLED');
  });

  it('enables an inactive filter and names the ones it replaced', async () => {
    const { cmd, musicService } = build({ setFilter: { applied: true, replaced: ['nightcore'] } });
    const response = await call(
      cmd,
      'executeFilter',
      makeCtx({ sub: 'filter', strings: { type: 'bassboost' } }),
    );

    expect(musicService.setFilter).toHaveBeenCalledWith('222', 'bassboost', true);
    const text = cardText(response);
    expect(text).toContain('is now **ENABLED**');
    expect(text).toContain('replaced **nightcore**');
  });

  it('disables a filter the queue already lists as active', async () => {
    const { cmd, musicService } = build({ queueInfo: queue({ activeFilters: ['bassboost'] }) });
    const response = await call(
      cmd,
      'executeFilter',
      makeCtx({ sub: 'filter', strings: { type: 'bassboost' } }),
    );

    expect(musicService.setFilter).toHaveBeenCalledWith('222', 'bassboost', false);
    expect(cardText(response)).toContain('is now **DISABLED**');
  });
});

describe('/music autoplay, loop, clear, shuffle: a null from the service is a refusal', () => {
  it('refuses autoplay when no player exists rather than claiming it is on', async () => {
    const { cmd } = build({ toggleAutoplay: null });
    const response = await call(cmd, 'executeAutoplay', makeCtx({ sub: 'autoplay' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No music player is currently active');
  });

  it('reports the autoplay state that was applied', async () => {
    const { cmd } = build({ toggleAutoplay: true });
    const response = await call(cmd, 'executeAutoplay', makeCtx({ sub: 'autoplay' }));
    expect(cardText(response)).toContain('Autoplay is now **ENABLED**');
  });

  it('refuses a loop change when there is no player', async () => {
    const { cmd } = build({ setLoop: null });
    const response = await call(cmd, 'executeLoop', makeCtx({ sub: 'loop', strings: { mode: 'queue' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No music is currently playing');
  });

  it('reports the loop mode that was applied, not the one requested', async () => {
    const { cmd } = build({ setLoop: 'track' });
    const response = await call(cmd, 'executeLoop', makeCtx({ sub: 'loop', strings: { mode: 'queue' } }));

    expect(cardText(response)).toContain('Loop mode set to **TRACK**');
  });

  it('refuses a clear when there is no player', async () => {
    const { cmd } = build({ clear: false });
    const response = await call(cmd, 'executeClear', makeCtx({ sub: 'clear' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No music player is currently active');
  });

  it('explains an empty shuffle instead of reporting a queue that was randomized', async () => {
    const { cmd } = build({ shuffle: false });
    const response = await call(cmd, 'executeShuffle', makeCtx({ sub: 'shuffle' }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('nothing to shuffle');
  });
});

describe('/music remove: a position that is not in the queue is not a removal', () => {
  it('removes 1-based positions against a 0-based index', async () => {
    const { cmd, musicService } = build({ remove: { title: 'Airbag' } });
    const response = await call(cmd, 'executeRemove', makeCtx({ sub: 'remove', integers: { position: 3 } }));

    expect(musicService.remove).toHaveBeenCalledWith('222', 2);
    expect(cardText(response)).toContain('Removed **Airbag** from position #3');
  });

  it('refuses a position that does not exist, quoting the position asked for', async () => {
    const { cmd } = build({ remove: null });
    const response = await call(cmd, 'executeRemove', makeCtx({ sub: 'remove', integers: { position: 3 } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('No track found at position #3');
  });
});

describe('/music history and chapters', () => {
  it('refuses a history that has no entries rather than rendering an empty list', async () => {
    const { cmd } = build({ history: [] });
    const response = await call(cmd, 'executeHistory', makeCtx({ sub: 'history' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No recently played tracks');
  });

  it('lists real history entries with their links', async () => {
    const { cmd } = build({ history: [{ track: TRACK }] });
    const response = await call(cmd, 'executeHistory', makeCtx({ sub: 'history' }));

    expect(cardText(response)).toContain('https://youtu.be/xyz');
    expect(cardText(response)).toContain('Airbag');
  });

  it('refuses when the current video has fewer than two chapters', async () => {
    // One chapter is a video with no chapter structure. Rendering a one-item
    // jump menu would present the feature as working when there is nothing to
    // jump between.
    const { cmd } = build({
      getPlayer: () => ({ get: () => [{ title: 'Whole set', startMs: 0 }] }),
    });
    const response = await call(cmd, 'executeChapters', makeCtx({ sub: 'chapters' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No chapters available');
  });

  it('refuses when the player has no chapter data at all', async () => {
    const { cmd } = build({ getPlayer: () => undefined });
    const response = await call(cmd, 'executeChapters', makeCtx({ sub: 'chapters' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No chapters available');
  });

  it('marks the chapter the position actually falls in', async () => {
    const { cmd } = build({
      getPlayer: () => ({
        get: () => [
          { title: 'Intro', startMs: 0 },
          { title: 'Airbag', startMs: 60000 },
          { title: 'Let Down', startMs: 120000 },
        ],
      }),
    });
    const response = await call(cmd, 'executeChapters', makeCtx({ sub: 'chapters' }));

    // `queue().position` is 70_000, so chapter index 1 is current.
    expect(cardText(response)).toContain('▶ **Airbag**');
  });
});

describe('/music join, lyrics and nodes', () => {
  it('connects the player when it is not already in the channel', async () => {
    const connect = vi.fn(async () => undefined);
    const { cmd } = build({
      getOrCreatePlayer: () => ({ connected: false, connect }),
    });
    const response = await call(cmd, 'executeJoin', makeCtx({ sub: 'join' }));

    expect(connect).toHaveBeenCalledWith({ selfDeaf: true });
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('does not reconnect a player that is already connected', async () => {
    const connect = vi.fn(async () => undefined);
    const { cmd } = build({ getOrCreatePlayer: () => ({ connected: true, connect }) });
    await call(cmd, 'executeJoin', makeCtx({ sub: 'join' }));
    expect(connect).not.toHaveBeenCalled();
  });

  it('says the lyrics service is unavailable rather than pretending there are none', async () => {
    const musicService = {
      canControlPlayback: vi.fn(() => true),
      getQueueInfo: vi.fn(() => queue()),
    } as unknown as MusicService;
    const cmd = new MusicSlashCommands(
      musicService,
      { getAccentColorAsync: vi.fn(async () => 0x778899) } as unknown as ColorService,
    );
    const response = await call(cmd, 'executeLyrics', makeCtx({ sub: 'lyrics' }));

    expect(response.commandResponse).toBe(CommandResponse.Error);
    expect(cardText(response)).toContain('Lyrics service unavailable');
  });

  it('refuses a lyrics lookup for a song that has none', async () => {
    const { cmd, lyricsService } = build({ lyrics: null });
    const response = await call(cmd, 'executeLyrics', makeCtx({ sub: 'lyrics', strings: { query: 'Airbag' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Could not find lyrics');
    expect(lyricsService.getLyrics).toHaveBeenCalledWith('Airbag', undefined);
  });

  it('truncates rather than overflowing the embed on a very long lyric', async () => {
    const { cmd } = build({
      lyrics: { title: 'Airbag', artist: 'Radiohead', plainLyrics: 'x'.repeat(5000) },
    });
    const response = await call(cmd, 'executeLyrics', makeCtx({ sub: 'lyrics', strings: { query: 'Airbag' } }));

    const text = cardText(response);
    expect(text.length).toBeLessThan(4200);
    expect(text).toContain('Lyrics truncated');
  });

  it('reports an unconfigured node list rather than an empty status board', async () => {
    const { cmd } = build({ nodeStats: [] });
    const response = await call(cmd, 'executeNodes', makeCtx({ sub: 'history' }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No Lavalink nodes configured or connected');
  });
});