import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicEventListeners } from '@bot/handlers/music/musicEventListeners';
import { healthFor } from '@bot/services/music/youtubeHealth';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';

/**
 * The card half of `musicEventListeners`: trackStart, seek, trackEnd, queueEnd
 * and playerDestroy.
 *
 * This is the largest single file gap in the tree (133 of 506 lines), and the
 * part that was missing is the part a listener sees. Every one of these
 * listeners is on a path where the failure mode is SILENCE, so the shape of
 * every test below is the same: assert what is handed to Discord, and assert
 * what is NOT done.
 *
 * The two rules that shape the file:
 *
 *  1. **A card that cannot be posted is absence, never a wrong card.** Every
 *     failure to reach the channel, build a payload or send it ends with the
 *     message id unset and the boundary timers UNARMED. Arming a chapter timer
 *     against a card nobody can see is how chapter logic ends up driving
 *     playback state.
 *  2. **The state maps belong to the host and are passed by reference.** They
 *     are read directly here rather than through the host, because that is the
 *     contract: a copy would break `forgetGuild` and the tests themselves.
 *
 * `MusicEventListeners` is constructed with its exact production arity (15
 * positional arguments). `MusicHandler` and `MusicService` are NOT touched —
 * they are built positionally across the whole suite.
 */

/**
 * The host double, named rather than indexed.
 *
 * `EventListenerHost` declares twenty methods. A `Record<string, Mock>` would let
 * `h.host.chapterCardFor` compile even if the method were renamed, and under
 * `noUncheckedIndexedAccess` every read of it would be `Mock | undefined` anyway
 * - which is exactly the shape that made the chapter-position assertion below
 * unreadable. Naming them makes a typo a compile error.
 */
type Handler = {
  [K in keyof EventListenerHostDouble]: ReturnType<typeof vi.fn>;
};

interface EventListenerHostDouble {
  clearInactivityTimeout(guildId: string): void;
  clearOkTimer(guildId: string): void;
  clearCardTimers(guildId: string): void;
  clearFallbackState(guildId: string): void;
  clearKickGrace(guildId: string): void;
  forgetNowPlaying(player: unknown): void;
  updateChapterStatus(player: unknown): void;
  armKaraokeTimer(player: unknown): void;
  armChapterTimer(player: unknown): void;
  swapChapterOnSeek(player: unknown, positionMs: number): void;
  scheduleImmediateProgress(player: unknown, delayMs?: number): void;
  resolveKaraokeLines(player: unknown, title: string, artist: string, durationMs: number): Promise<void>;
  resolveVideoChapters(player: unknown, track: unknown): void;
  chapterCardFor(player: unknown, positionMs: number): unknown;
  lyricWindowFor(player: unknown, positionMs: number): unknown;
  isSongExhausted(guildId: string, track: unknown): boolean;
  checkFallbackBudget(guildId: string, failedKey: string): boolean;
  findAlternatePlayableTrack(manager: unknown, player: unknown, failedTrack: unknown): Promise<unknown>;
  frozenPosition(player: unknown): number;
  resumeFallbackAt(player: unknown): Promise<void>;
}

const TRACK = {
  identifier: 'yt-card-001',
  encoded: 'enc-card',
  uri: 'https://youtube.com/watch?v=ytcard001',
  title: 'Bohemian Rhapsody',
  author: 'Queen',
  duration: 355_000,
  sourceName: 'youtube',
  artworkUrl: 'https://img.test/opera.jpg',
};

const QUEUE_INFO = {
  guildId: 'g-card',
  current: {
    identifier: 'yt-card-001',
    title: 'Bohemian Rhapsody',
    author: 'Queen',
    uri: 'https://youtube.com/watch?v=ytcard001',
    duration: 355_000,
    isSeekable: true,
    isStream: false,
    artworkUrl: 'https://img.test/opera.jpg',
  },
  tracks: [],
  totalTracks: 1,
  totalDuration: 355_000,
  remainingDuration: 355_000,
  loopMode: 'off',
  volume: 100,
  isPaused: false,
  isPlaying: true,
  is247: false,
  autoplay: false,
  activeFilters: [],
  position: 0,
  ping: 0,
} as unknown as MusicQueueInfo;

const makePlayer = (over: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>();
  return {
    guildId: 'g-card',
    node: { identifier: 'node-a' },
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    current: { ...TRACK, position: 0, time: 0 },
    playing: true,
    paused: false,
    autoPlay: false,
    queue: { size: 1, isEmpty: false, unshift: vi.fn() },
    destroy: vi.fn(async () => undefined),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    set: (k: string, v: unknown) => {
      store.set(k, v);
    },
    ...over,
  };
};

interface Harness {
  listeners: MusicEventListeners;
  host: Handler;
  maps: {
    okTimers: Map<string, NodeJS.Timeout>;
    progressFingerprints: Map<string, string>;
    inFlightFallbacks: Map<string, string>;
    emptyChannelTimeouts: Map<string, NodeJS.Timeout>;
    inactivityTimeouts: Map<string, NodeJS.Timeout>;
    pendingPublish: Set<string>;
    progressPublishing: Map<string, number>;
  };
  queueService: { getQueueInfo: ReturnType<typeof vi.fn>; calculatePosition: ReturnType<typeof vi.fn>; is247: ReturnType<typeof vi.fn>; recordTrackStart: ReturnType<typeof vi.fn> };
  channel: { send: ReturnType<typeof vi.fn>; isTextBased: () => boolean; messages: { delete: ReturnType<typeof vi.fn> } };
  client: { channels: { cache: Map<string, unknown>; fetch: ReturnType<typeof vi.fn> } };
  status: { setStatus: ReturnType<typeof vi.fn>; clearStatus: ReturnType<typeof vi.fn> };
  scrobble: { recordTrackStart: ReturnType<typeof vi.fn>; handleTrackEnd: ReturnType<typeof vi.fn> };
  color: { getAccentColorAsync: ReturnType<typeof vi.fn> };
}

interface Options {
  sendThrows?: boolean;
  sendRejects?: boolean;
  cached?: boolean;
  position?: number;
  is247?: boolean;
}

const build = (opts: Options = {}): Harness => {
  const host: Handler = {
    clearInactivityTimeout: vi.fn(),
    clearOkTimer: vi.fn(),
    clearCardTimers: vi.fn(),
    clearFallbackState: vi.fn(),
    clearKickGrace: vi.fn(),
    forgetNowPlaying: vi.fn(),
    updateChapterStatus: vi.fn(),
    armKaraokeTimer: vi.fn(),
    armChapterTimer: vi.fn(),
    swapChapterOnSeek: vi.fn(),
    scheduleImmediateProgress: vi.fn(),
    resolveKaraokeLines: vi.fn(async () => undefined),
    resolveVideoChapters: vi.fn(),
    chapterCardFor: vi.fn(() => null),
    lyricWindowFor: vi.fn(() => null),
    isSongExhausted: vi.fn(() => false),
    checkFallbackBudget: vi.fn(() => true),
    findAlternatePlayableTrack: vi.fn(async () => null),
    frozenPosition: vi.fn(() => 0),
    resumeFallbackAt: vi.fn(async () => undefined),
  };

  const maps = {
    okTimers: new Map<string, NodeJS.Timeout>(),
    progressFingerprints: new Map<string, string>(),
    inFlightFallbacks: new Map<string, string>(),
    emptyChannelTimeouts: new Map<string, NodeJS.Timeout>(),
    inactivityTimeouts: new Map<string, NodeJS.Timeout>(),
    pendingPublish: new Set<string>(),
    progressPublishing: new Map<string, number>(),
  };

  const channel = {
    send: vi.fn(async (..._a: unknown[]) => ({ id: 'msg-1' })),
    isTextBased: () => true,
    messages: { delete: vi.fn(async () => undefined) },
  };
  if (opts.sendThrows) {
    // A Components V2 payload the channel rejects outright — the shape that
    // used to lose every card on a channel without the permission.
    channel.send.mockImplementation(async (payload: unknown) => {
      if (payload && typeof payload === 'object' && 'embeds' in payload) return { id: 'msg-fallback' };
      throw new Error('Cannot send components v2');
    });
  }
  if (opts.sendRejects) channel.send.mockRejectedValue(new Error('Missing Permissions'));

  const client = {
    channels: {
      cache: new Map<string, unknown>(opts.cached === false ? [] : [['tc-1', channel]]),
      fetch: vi.fn(async (..._a: unknown[]) => channel),
    },
  };

  const queueService = {
    getQueueInfo: vi.fn(() => QUEUE_INFO),
    calculatePosition: vi.fn(() => opts.position ?? 0),
    is247: vi.fn(() => opts.is247 ?? false),
    recordTrackStart: vi.fn(),
  };

  const status = { setStatus: vi.fn(async () => undefined), clearStatus: vi.fn(async () => undefined) };
  const scrobble = { recordTrackStart: vi.fn(), handleTrackEnd: vi.fn(async () => undefined) };
  const color = { getAccentColorAsync: vi.fn(async () => 0x11aa33) };

  const listeners = new MusicEventListeners(
    host as never,
    { getManager: () => ({ on: vi.fn() }) } as never,
    queueService as never,
    client as never,
    color as never,
    status as never,
    scrobble as never,
    maps.okTimers,
    maps.progressFingerprints,
    maps.inFlightFallbacks,
    maps.emptyChannelTimeouts,
    maps.inactivityTimeouts,
    maps.pendingPublish,
    maps.progressPublishing,
  );

  return { listeners, host, maps, queueService, channel, client, status, scrobble, color };
};

const manager = { on: vi.fn(), players: { get: () => undefined } } as never;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('onTrackStart — the card is posted, and the fingerprint is synced to it', () => {
  it('posts the card and records the message id', async () => {
    const h = build();
    const player = makePlayer();

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(player.get('nowPlayingMessageId')).toBe('msg-1');
  });

  it('syncs the fingerprint to what was just posted, so the next real change is not swallowed', async () => {
    // A stale fingerprint from a previous card suppresses the next publish and
    // freezes the new card for the rest of the song.
    const h = build();
    h.maps.progressFingerprints.set('g-card', 'stale-from-the-last-song');

    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(h.maps.progressFingerprints.get('g-card')).toBeDefined();
    expect(h.maps.progressFingerprints.get('g-card')).not.toBe('stale-from-the-last-song');
  });

  it('arms the three boundary timers, and only when a card actually exists', async () => {
    const h = build();
    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(h.host.updateChapterStatus).toHaveBeenCalledTimes(1);
    expect(h.host.armKaraokeTimer).toHaveBeenCalledTimes(1);
    expect(h.host.armChapterTimer).toHaveBeenCalledTimes(1);
  });

  it('a previous card is deleted BEFORE the new one goes up, so chat stays clean', async () => {
    const h = build();
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-old');

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.channel.messages.delete).toHaveBeenCalledWith('msg-old');
    expect(h.channel.send).toHaveBeenCalledTimes(1);
  });

  it('a previous card that will NOT delete still gets replaced, because the id moves on', async () => {
    const h = build();
    h.channel.messages.delete.mockRejectedValue(new Error('message gone'));
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-old');

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.channel.send).toHaveBeenCalledTimes(1);
    expect(player.get('nowPlayingMessageId')).toBe('msg-1');
  });

  it('derives the chapter from the REAL position, so a partial start is not chapter 0', async () => {
    // AGENTS.md §4.1 invariant 4. A track that starts part-way through (fallback
    // resume, a restored session) otherwise renders chapter 0.
    const h = build({ position: 1_320_000 });
    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    const pos = h.host.chapterCardFor.mock.calls[0]?.[1] as number;
    expect(pos).toBe(1_320_000);
    expect(pos).not.toBe(0);
  });

  it('resolves karaoke lines and video chapters BEFORE building the card, so it is right first time', async () => {
    const h = build();
    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(h.host.resolveKaraokeLines).toHaveBeenCalledWith(
      expect.anything(),
      'Bohemian Rhapsody',
      'Queen',
      355_000,
    );
    expect(h.host.resolveVideoChapters).toHaveBeenCalledTimes(1);
  });

  it('takes the accent from the DISPLAYED cover, so chapter art and the accent agree', async () => {
    const h = build();
    (h.host.chapterCardFor as ReturnType<typeof vi.fn>).mockReturnValue({
      title: 'Chapter 4',
      artworkUrl: 'https://img.test/chapter4.jpg',
    });

    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(h.color.getAccentColorAsync).toHaveBeenCalledWith('g-card', 'https://img.test/chapter4.jpg');
  });

  it('falls back to the track cover when there is no chapter', async () => {
    const h = build();
    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);
    expect(h.color.getAccentColorAsync).toHaveBeenCalledWith('g-card', 'https://img.test/opera.jpg');
  });

  it('a payload the channel rejects falls back to the plain embed, so the card is not lost', async () => {
    // Components V2 is refused on some channels; a listener that gave up would
    // leave the guild with no now-playing card at all.
    const h = build({ sendThrows: true });
    const player = makePlayer();

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.channel.send).toHaveBeenCalledTimes(2);
    expect(player.get('nowPlayingMessageId')).toBe('msg-fallback');
  });

  it('a channel that refuses EVERY send leaves NO card and arms NO timers', async () => {
    // The absence rule. A timer armed against a card nobody can see is how
    // decoration starts driving playback state.
    const h = build({ sendRejects: true });
    const player = makePlayer();

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(player.get('nowPlayingMessageId')).toBeUndefined();
    expect(h.host.updateChapterStatus).not.toHaveBeenCalled();
    expect(h.host.armChapterTimer).not.toHaveBeenCalled();
    // The song is still queued and playing: a missing card is not a failure.
    expect(h.queueService.recordTrackStart).toHaveBeenCalledTimes(1);
  });

  it('a send that resolves with NO message id is treated as no card at all', async () => {
    // The shape that makes `if (sent)` a load-bearing guard rather than a
    // style choice: Discord can answer a send without an id, and a listener
    // that treats that as a posted card arms the chapter and lyric timers
    // against a card nobody can see — which is how decoration starts driving
    // playback state.
    const h = build();
    h.channel.send.mockResolvedValue({} as { id: string });
    const player = makePlayer();

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(player.get('nowPlayingMessageId')).toBeUndefined();
    expect(h.host.armChapterTimer).not.toHaveBeenCalled();
    expect(h.host.armKaraokeTimer).not.toHaveBeenCalled();
  });

  it('a player with NO text channel posts nothing and arms nothing, without complaining', async () => {
    const h = build();
    const player = makePlayer({ textChannelId: undefined });

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.channel.send).not.toHaveBeenCalled();
    expect(h.host.armChapterTimer).not.toHaveBeenCalled();
  });

  it('a channel that cannot be fetched is absence, not a send to somewhere else', async () => {
    const h = build({ cached: false });
    h.client.channels.fetch.mockResolvedValue(null);

    const player = makePlayer();
    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.channel.send).not.toHaveBeenCalled();
    expect(player.get('nowPlayingMessageId')).toBeUndefined();
  });

  it('a channel that is not text-based is skipped rather than sent a message payload', async () => {
    const h = build({ cached: false });
    h.client.channels.fetch.mockResolvedValue({ isTextBased: () => false });

    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(h.host.armChapterTimer).not.toHaveBeenCalled();
  });

  it('a bookkeeping THROW does not skip the card, because the card is the visible part', async () => {
    const h = build();
    h.queueService.recordTrackStart.mockImplementation(() => {
      throw new Error('queue table locked');
    });

    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(h.channel.send).toHaveBeenCalledTimes(1);
  });

  it('sets the voice channel status to the SONG, and records the scrobble', async () => {
    const h = build();
    const player = makePlayer();

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(h.status.setStatus).toHaveBeenCalledWith('vc-1', 'Bohemian Rhapsody', 'Queen');
    expect(h.scrobble.recordTrackStart).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g-card', voiceChannelId: 'vc-1', title: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 355_000 }),
    );
  });

  it('no voice channel means no status and no scrobble, rather than a write with undefined', async () => {
    const h = build();
    await h.listeners.onTrackStart(manager, makePlayer({ voiceChannelId: undefined }) as never, TRACK as never);

    expect(h.status.setStatus).not.toHaveBeenCalled();
    expect(h.scrobble.recordTrackStart).not.toHaveBeenCalled();
  });

  it('stamps trackStartedAt and resets the seek-stall flag, so a new song gets a clean slate', async () => {
    const h = build();
    const player = makePlayer();
    player.set('seekStallRetried', true);

    await h.listeners.onTrackStart(manager, player as never, TRACK as never);

    expect(player.get('seekStallRetried')).toBe(false);
    expect(typeof player.get('trackStartedAt')).toBe('number');
  });

  it('cancels a pending inactivity disconnect, because a new song is activity', async () => {
    const h = build();
    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);
    expect(h.host.clearInactivityTimeout).toHaveBeenCalledWith('g-card');
  });
});

describe('onTrackStart — YouTube node health only counts a track that SURVIVES', () => {
  it('arms a 15s survival timer for a YouTube track, and records the success only when it fires', async () => {
    // A start that dies at 2s must not credit the node, or a broken upload
    // proves the node healthy and the ladder keeps routing at it.
    vi.useFakeTimers();
    const h = build();
    // `healthFor` is a module-level singleton, so an earlier test in this file
    // could have left `node-a` marked down. `recordSuccess` is the real API for
    // clearing that state (`downUntil`/`probeUntil`/`recent`); there is no
    // `reset`, and the optional call would have silently done nothing.
    healthFor('node-a').recordSuccess();

    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);
    expect(h.maps.okTimers.has('g-card')).toBe(true);

    // Nothing yet: still inside the survival window.
    vi.advanceTimersByTime(14_000);
    expect(h.maps.okTimers.has('g-card')).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(h.maps.okTimers.has('g-card')).toBe(false);
  });

  it('a non-YouTube track arms NO survival timer, because it says nothing about the node', async () => {
    const h = build();
    // The source is read off `player.current` when there is one, which is the
    // real shape: a SoundCloud track is already current by the time trackStart
    // fires. Reading the EVENT track here would test the wrong object.
    const player = makePlayer({ current: { ...TRACK, sourceName: 'soundcloud', position: 0, time: 0 } });

    await h.listeners.onTrackStart(manager, player as never, { ...TRACK, sourceName: 'soundcloud' } as never);

    expect(h.maps.okTimers.size).toBe(0);
  });

  it('a second track for the same guild REPLACES the pending timer rather than stacking two', async () => {
    vi.useFakeTimers();
    const h = build();

    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);
    await h.listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    // One entry, so one success is recorded per track, not per start event.
    expect(h.maps.okTimers.size).toBe(1);
  });
});

describe('onPlayerSeek — a node-initiated seek must not leave the card extrapolating', () => {
  it('re-stamps the clock, swaps the chapter, re-arms the timers and nudges a publish', () => {
    const h = build();
    const player = makePlayer();

    h.listeners.onPlayerSeek(player as never, 90_000);

    // Without the re-stamp the position calculator keeps extrapolating from a
    // stale base for up to a minute and can cross a chapter boundary early.
    expect(player.current?.position).toBe(90_000);
    expect(typeof player.current?.time).toBe('number');
    expect(h.host.swapChapterOnSeek).toHaveBeenCalledWith(player, 90_000);
    expect(h.host.armKaraokeTimer).toHaveBeenCalledTimes(1);
    expect(h.host.armChapterTimer).toHaveBeenCalledTimes(1);
    expect(h.host.scheduleImmediateProgress).toHaveBeenCalledTimes(1);
  });

  it('a player with no current track does not throw', () => {
    // `moonlinkClock` returns null for a player mid-transition; the swap and the
    // timers must still run so the card recovers on the next boundary.
    const h = build();
    const player = makePlayer({ current: null });

    expect(() => h.listeners.onPlayerSeek(player as never, 5_000)).not.toThrow();
    expect(h.host.armChapterTimer).toHaveBeenCalledTimes(1);
  });

  it('a swap that THROWS is swallowed, because a card glitch must not break playback', () => {
    const h = build();
    (h.host.swapChapterOnSeek as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('chapter list gone');
    });

    expect(() => h.listeners.onPlayerSeek(makePlayer() as never, 5_000)).not.toThrow();
  });
});

describe('onPlayerTriggeredSeek — a user seek is synchronous and must be too', () => {
  it('swaps the chapter and re-arms both boundary timers, with no await in the way', () => {
    const h = build();
    const player = makePlayer();

    h.listeners.onPlayerTriggeredSeek(player as never, 21 * 60_000 + 58_000);

    expect(h.host.swapChapterOnSeek).toHaveBeenCalledWith(player, 1_318_000);
    expect(h.host.armKaraokeTimer).toHaveBeenCalledTimes(1);
    expect(h.host.armChapterTimer).toHaveBeenCalledTimes(1);
    // The position that reached the node is the one the card shows.
    expect((h.host.swapChapterOnSeek as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(1_318_000);
  });
});

describe('onTrackEnd — the card dies with the song, and every timer stops', () => {
  it('stops the card timers, the ok timer and the state, then deletes the card', async () => {
    const h = build();
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-1');

    h.listeners.onTrackEnd(player as never, TRACK as never, 'finished');
    await new Promise((r) => setTimeout(r, 5));

    expect(h.host.clearCardTimers).toHaveBeenCalledWith('g-card');
    expect(h.host.clearOkTimer).toHaveBeenCalledWith('g-card');
    expect(h.host.forgetNowPlaying).toHaveBeenCalledWith(player);
    expect(h.channel.messages.delete).toHaveBeenCalledWith('msg-1');
  });

  it('a delete that fails leaves the state clean anyway, because state was already forgotten', async () => {
    const h = build();
    h.client.channels.fetch.mockRejectedValue(new Error('channel gone'));
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-1');

    h.listeners.onTrackEnd(player as never, TRACK as never, 'finished');
    await new Promise((r) => setTimeout(r, 5));

    // A stale embed in the channel, not a wrong one — and never a throw.
    expect(h.host.forgetNowPlaying).toHaveBeenCalledTimes(1);
  });

  it('a delete that throws is caught, not surfaced as an unhandled rejection', async () => {
    const h = build();
    h.channel.messages.delete.mockImplementation(() => {
      throw new Error('sync throw');
    });
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-1');

    h.listeners.onTrackEnd(player as never, TRACK as never, 'finished');
    await new Promise((r) => setTimeout(r, 5));

    expect(h.host.clearCardTimers).toHaveBeenCalledTimes(1);
  });

  it('a scrobble end is recorded when there is a voice channel, and not otherwise', () => {
    const h = build();
    h.listeners.onTrackEnd(makePlayer() as never, TRACK as never, 'finished');
    expect(h.scrobble.handleTrackEnd).toHaveBeenCalledTimes(1);

    h.listeners.onTrackEnd(makePlayer({ voiceChannelId: undefined }) as never, TRACK as never, 'finished');
    expect(h.scrobble.handleTrackEnd).toHaveBeenCalledTimes(1);
  });
});

describe('onTrackEnd — preview-cut detection, which is a FACT and must be proven', () => {
  it('a 30s finish of a 200s track counts as a cut preview, not a completed play', () => {
    // SoundCloud uploads of major-label tracks often expose only a 30s stream
    // while reporting the full duration. Counting that as a play is a wrong
    // number in someone's Last.fm stats.
    const h = build();
    const player = makePlayer();
    player.set('trackStartedAt', Date.now() - 30_000);

    h.listeners.onTrackEnd(player as never, { ...TRACK, duration: 200_000 } as never, 'finished');

    expect(h.host.isSongExhausted).toHaveBeenCalledWith('g-card', expect.objectContaining({ title: 'Bohemian Rhapsody' }));
  });

  it('a full-length finish is NOT a cut, so a real play is not penalised', () => {
    const h = build();
    const player = makePlayer();
    player.set('trackStartedAt', Date.now() - 190_000);

    h.listeners.onTrackEnd(player as never, { ...TRACK, duration: 200_000 } as never, 'finished');

    expect(h.host.isSongExhausted).not.toHaveBeenCalled();
  });

  it('a short track that finishes fast is NOT a cut — a 60s song ends in 60s', () => {
    const h = build();
    const player = makePlayer();
    player.set('trackStartedAt', Date.now() - 30_000);

    h.listeners.onTrackEnd(player as never, { ...TRACK, duration: 45_000 } as never, 'finished');

    expect(h.host.isSongExhausted).not.toHaveBeenCalled();
  });

  it('a STOPPED track is not a cut, however fast it ended', () => {
    const h = build();
    const player = makePlayer();
    player.set('trackStartedAt', Date.now() - 5_000);

    h.listeners.onTrackEnd(player as never, { ...TRACK, duration: 200_000 } as never, 'stopped');

    expect(h.host.isSongExhausted).not.toHaveBeenCalled();
  });

  it('a track with no start stamp is not judged, because there is no evidence of how long it played', () => {
    const h = build();
    h.listeners.onTrackEnd(makePlayer() as never, { ...TRACK, duration: 200_000 } as never, 'finished');
    expect(h.host.isSongExhausted).not.toHaveBeenCalled();
  });
});

describe('onQueueEnd — an idle player disconnects itself, a 24/7 or autoplay one does not', () => {
  it('stops the card timers and the fallback state', () => {
    const h = build();
    h.listeners.onQueueEnd(makePlayer() as never);
    expect(h.host.clearCardTimers).toHaveBeenCalledWith('g-card');
    expect(h.host.clearFallbackState).toHaveBeenCalledWith('g-card');
  });

  it('clears the voice channel status, because the song is over', () => {
    const h = build();
    h.listeners.onQueueEnd(makePlayer() as never);
    expect(h.status.clearStatus).toHaveBeenCalledWith('vc-1');
  });

  it('arms a 3-minute inactivity timer that destroys an idle player', () => {
    vi.useFakeTimers();
    const h = build();
    // Idle means BOTH: nothing queued and not playing. Either alone is a
    // reason to stay.
    const player = makePlayer({ playing: false, paused: false, queue: { size: 0, isEmpty: true, unshift: vi.fn() } });

    h.listeners.onQueueEnd(player as never);
    expect(h.maps.inactivityTimeouts.has('g-card')).toBe(true);

    vi.advanceTimersByTime(180_000);

    // The bot sat in an empty voice channel for three minutes; leaving is the
    // polite thing, and it is what a listener expects to hear.
    expect(player.destroy).toHaveBeenCalledWith('Inactivity timeout');
    expect(h.maps.inactivityTimeouts.has('g-card')).toBe(false);
  });

  it('a player whose queue is NOT empty is not destroyed, even when it is not playing', () => {
    vi.useFakeTimers();
    const h = build();
    const player = makePlayer({ playing: false, paused: false });

    h.listeners.onQueueEnd(player as never);
    vi.advanceTimersByTime(180_000);

    // Something is queued, so the next track is seconds away; leaving now would
    // tear down a queue the user can see.
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('a player that is still playing or has a non-empty queue is NOT destroyed', () => {
    vi.useFakeTimers();
    const h = build();
    const player = makePlayer({ playing: true });

    h.listeners.onQueueEnd(player as never);
    vi.advanceTimersByTime(180_000);

    // 24/7 and autoplay both read this state; a destroy here kills a session
    // that was about to play something.
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('24/7 mode arms no inactivity timer at all', () => {
    const h = build({ is247: true });
    h.listeners.onQueueEnd(makePlayer() as never);
    expect(h.maps.inactivityTimeouts.has('g-card')).toBe(false);
  });

  it('autoplay arms no inactivity timer, because the next track is on its way', () => {
    const h = build();
    h.listeners.onQueueEnd(makePlayer({ autoPlay: true }) as never);
    expect(h.maps.inactivityTimeouts.has('g-card')).toBe(false);
  });

  it('re-arming replaces the previous timer rather than stacking two disconnects', () => {
    const h = build();
    h.listeners.onQueueEnd(makePlayer() as never);
    h.listeners.onQueueEnd(makePlayer() as never);
    expect(h.maps.inactivityTimeouts.size).toBe(1);
  });
});

describe('onPlayerDestroy — the guild is forgotten completely', () => {
  it('clears every state map it owns, so a dead session leaks nothing', async () => {
    const h = build();
    h.maps.progressFingerprints.set('g-card', 'fingerprint');
    h.maps.pendingPublish.add('g-card');
    h.maps.progressPublishing.set('g-card', Date.now());
    h.maps.inFlightFallbacks.set('g-card', 'key');
    h.maps.emptyChannelTimeouts.set('g-card', setTimeout(() => undefined, 100_000));
    const player = makePlayer();

    await h.listeners.onPlayerDestroy(player as never);

    expect(h.host.clearCardTimers).toHaveBeenCalledWith('g-card');
    expect(h.host.clearOkTimer).toHaveBeenCalledWith('g-card');
    expect(h.host.clearFallbackState).toHaveBeenCalledWith('g-card');
    expect(h.host.clearKickGrace).toHaveBeenCalledWith('g-card');
    expect(h.host.clearInactivityTimeout).toHaveBeenCalledWith('g-card');
    expect(h.maps.progressFingerprints.has('g-card')).toBe(false);
    expect(h.maps.pendingPublish.has('g-card')).toBe(false);
    expect(h.maps.progressPublishing.has('g-card')).toBe(false);
    expect(h.maps.inFlightFallbacks.has('g-card')).toBe(false);
    expect(h.maps.emptyChannelTimeouts.has('g-card')).toBe(false);
  });

  it('deletes the card, and clears the voice status', async () => {
    const h = build();
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-1');

    await h.listeners.onPlayerDestroy(player as never);

    expect(h.channel.messages.delete).toHaveBeenCalledWith('msg-1');
    expect(h.status.clearStatus).toHaveBeenCalledWith('vc-1');
  });

  it('a delete that fails is swallowed — the player is going away either way', async () => {
    const h = build();
    h.channel.messages.delete.mockRejectedValue(new Error('message gone'));
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-1');

    await expect(h.listeners.onPlayerDestroy(player as never)).resolves.toBeUndefined();
  });

  it('a fetch that throws is caught, so the listener never rejects unhandled', async () => {
    const h = build();
    h.client.channels.fetch.mockImplementation(() => {
      throw new Error('sync throw');
    });
    const player = makePlayer();
    player.set('nowPlayingMessageId', 'msg-1');

    await expect(h.listeners.onPlayerDestroy(player as never)).resolves.toBeUndefined();
  });

  it('a player with no card and no voice channel is a clean no-op', async () => {
    const h = build();
    await expect(
      h.listeners.onPlayerDestroy(makePlayer({ textChannelId: undefined, voiceChannelId: undefined }) as never),
    ).resolves.toBeUndefined();
    expect(h.client.channels.fetch).not.toHaveBeenCalled();
  });
});

describe('register() — the listeners are wired to the eight Moonlink events', () => {
  it('registers all eight, in the order the manager will fire them', () => {
    const on = vi.fn();
    const h = build();
    (h.listeners as unknown as { moonlinkManager: unknown }).moonlinkManager = { getManager: () => ({ on }) };

    h.listeners.register();

    expect(on.mock.calls.map((c) => c[0])).toEqual([
      'trackStart',
      'playerTriggeredSeek',
      'playerSeek',
      'trackEnd',
      'trackStuck',
      'trackException',
      'queueEnd',
      'playerDestroy',
    ]);
  });

  it('the four ASYNC listeners return their promise, and the four sync ones are honestly sync', () => {
    // The returned-promise shape is a DELIBERATE seam: a `void`-returning
    // wrapper around an `async` body would resolve immediately and every
    // listener test would race the work it asserts on.
    //
    // Four of the eight bodies are genuinely synchronous and are declared
    // `void`: both seek listeners (Moonlink emits `playerTriggeredSeek` before
    // the REST round-trip, and a card that waits is late), `onTrackEnd` (it
    // fires a detached teardown and returns) and `onQueueEnd` (it arms a
    // timer). Pinned explicitly so a signature change to either direction is a
    // visible change to THIS test rather than a race in a listener test.
    const on = vi.fn();
    const h = build();
    (h.listeners as unknown as { moonlinkManager: unknown }).moonlinkManager = { getManager: () => ({ on }) };
    h.listeners.register();

    const byEvent = new Map(on.mock.calls as Array<[string, (...a: unknown[]) => unknown]>);
    const player = makePlayer();

    for (const event of ['playerTriggeredSeek', 'playerSeek']) {
      const returned = byEvent.get(event)!(player, 0) as { then?: unknown } | undefined;
      expect(returned?.then, `${event} is synchronous by contract`).toBeUndefined();
    }
    for (const event of ['trackEnd', 'queueEnd']) {
      const returned = byEvent.get(event)!(player, TRACK, 'finished') as { then?: unknown } | undefined;
      expect(returned?.then, `${event} is synchronous by contract`).toBeUndefined();
    }

    const started = byEvent.get('trackStart')!(player, TRACK) as Promise<unknown>;
    expect(typeof started?.then, 'trackStart must return a promise').toBe('function');
    void started.catch(() => undefined);

    const destroyed = byEvent.get('playerDestroy')!(player) as Promise<unknown>;
    expect(typeof destroyed?.then, 'playerDestroy must return a promise').toBe('function');
    void destroyed.catch(() => undefined);

    for (const event of ['trackStuck', 'trackException']) {
      const returned = byEvent.get(event)!(
        player,
        TRACK,
        event === 'trackStuck' ? 10_000 : new Error('boom'),
      ) as Promise<unknown>;
      expect(typeof returned?.then, `${event} must return a promise`).toBe('function');
      void returned.catch(() => undefined);
    }
  });
});
