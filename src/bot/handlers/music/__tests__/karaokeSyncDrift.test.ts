import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicEventListeners } from '@bot/handlers/music/musicEventListeners';
import { MusicHandler } from '@bot/handlers/music/musicHandler';

/**
 * Karaoke sync drift: the lyric window must follow the same clock as the
 * chapter card, and the boundary timer must fire at the line — not up to
 * 1.5s after it.
 *
 * Two production bugs, both read as "lines change early or late":
 *
 * 1. `onTrackStart` derived the chapter from `calculatePosition` but posted
 *    the lyric window at a hardcoded 0 (`musicEventListeners.ts`). A track
 *    that starts part-way through (fallback resume, restored session) opened
 *    on the wrong line by the full resume offset.
 * 2. `armKaraokeTimer` clamped every delay to `max(delay, 1500)`
 *    (`karaokeController.ts`). Lines denser than 1.5s fired late by
 *    `1500 - delay` every time — measured 700ms late for lines 800ms apart.
 */

const TRACK = {
  identifier: 'yt-kara-001',
  encoded: 'enc-kara',
  uri: 'https://youtube.com/watch?v=ytkara001',
  title: 'Airbag',
  author: 'Radiohead',
  duration: 284_000,
  sourceName: 'youtube',
  artworkUrl: 'https://img.test/airbag.jpg',
};

const QUEUE_INFO = {
  guildId: 'g-kara',
  current: {
    identifier: 'yt-kara-001',
    title: 'Airbag',
    author: 'Radiohead',
    uri: 'https://youtube.com/watch?v=ytkara001',
    duration: 284_000,
    isSeekable: true,
    isStream: false,
    artworkUrl: 'https://img.test/airbag.jpg',
  },
  tracks: [],
  totalTracks: 1,
  totalDuration: 284_000,
  remainingDuration: 284_000,
  loopMode: 'off',
  volume: 100,
  isPaused: false,
  isPlaying: true,
  is247: false,
  autoplay: false,
  activeFilters: [],
  position: 0,
  ping: 0,
};

const makePlayer = (over: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>();
  return {
    guildId: 'g-kara',
    node: { identifier: 'node-a' },
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    current: { ...TRACK, position: 0, time: 0 },
    playing: true,
    paused: false,
    autoPlay: false,
    queue: { size: 1, isEmpty: false, unshift: vi.fn() },
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    set: (k: string, v: unknown) => void store.set(k, v),
    ...over,
  };
};

const buildListeners = (position: number) => {
  const host = {
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
    lyricWindowFor: vi.fn((_player: unknown, _pos: number) => null),
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
    send: vi.fn(async () => ({ id: 'msg-1' })),
    isTextBased: () => true,
    messages: { delete: vi.fn(async () => undefined) },
  };
  const client = {
    channels: {
      cache: new Map<string, unknown>([['tc-1', channel]]),
      fetch: vi.fn(async () => channel),
    },
    on: vi.fn(),
  };
  const queueService = {
    getQueueInfo: vi.fn(() => QUEUE_INFO),
    calculatePosition: vi.fn(() => position),
    is247: vi.fn(() => false),
    recordTrackStart: vi.fn(),
  };
  const listeners = new MusicEventListeners(
    host as never,
    { getManager: () => ({ on: vi.fn() }) } as never,
    queueService as never,
    client as never,
    { getAccentColorAsync: vi.fn(async () => 0x11aa33) } as never,
    { setStatus: vi.fn(async () => undefined), clearStatus: vi.fn(async () => undefined) } as never,
    { recordTrackStart: vi.fn(), handleTrackEnd: vi.fn(async () => undefined) } as never,
    maps.okTimers,
    maps.progressFingerprints,
    maps.inFlightFallbacks,
    maps.emptyChannelTimeouts,
    maps.inactivityTimeouts,
    maps.pendingPublish,
    maps.progressPublishing,
  );
  return { listeners, host, queueService };
};

const manager = { on: vi.fn(), players: { get: () => undefined } } as never;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('onTrackStart posts the lyric window at the real position', () => {
  it('a partial start renders the line actually singing, not line one', async () => {
    // Fallback resume at 95s: lines at 2s / 90s / 100s. The old hardcoded 0
    // handed lyricWindowFor 0 (pre-first-line); the fix hands it 95_000.
    const { listeners, host } = buildListeners(95_000);
    await listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    const pos = host.lyricWindowFor.mock.calls[0]?.[1] as number;
    expect(pos).toBe(95_000);
    expect(pos).not.toBe(0);
  });

  it('a fresh start still posts position zero', async () => {
    // The unchanged direction: nothing about a normal from-the-top start moves.
    const { listeners, host } = buildListeners(0);
    await listeners.onTrackStart(manager, makePlayer() as never, TRACK as never);

    expect(host.lyricWindowFor.mock.calls[0]?.[1]).toBe(0);
  });
});

describe('armKaraokeTimer fires at the line, not up to 1.5s after it', () => {
  const buildHandler = () => {
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    const mgmt = { on: vi.fn(), players: { get: () => undefined } };
    const queueService = {
      getQueueInfo: () => null,
      is247: () => false,
      isKaraokeEnabled: () => true,
      calculatePosition: () => 9200,
    };
    return new MusicHandler(
      client as never,
      { getManager: () => mgmt } as never,
      queueService as never,
      undefined,
      undefined,
      undefined,
      {} as never,
    ) as unknown as {
      armKaraokeTimer: (player: unknown) => void;
      clearCardTimers: (guildId: string) => void;
    };
  };

  const captureDelays = () => {
    const delays: number[] = [];
    const orig = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: (...args: unknown[]) => void, ms: number, ...rest: unknown[]) => {
        delays.push(ms);
        return orig(fn, ms, ...rest);
      }) as typeof setTimeout,
    );
    return delays;
  };

  const linePlayer = (guildId: string, paused = false) => ({
    guildId,
    playing: true,
    paused,
    textChannelId: 'tc-1',
    get: (key: string) => {
      if (key === 'karaokeLines') {
        return [
          { ms: 2000, text: 'Line one' },
          { ms: 10000, text: 'Line two' },
        ];
      }
      return undefined;
    },
  });

  it('dense lines arm near-exact instead of parking 700ms late', () => {
    // Position 9.2s, next line at 10s: delay 800. Old floor gave 1500.
    const handler = buildHandler();
    const delays = captureDelays();
    handler.armKaraokeTimer(linePlayer('g-dense-1'));
    handler.clearCardTimers('g-dense-1');

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(800);
  });

  it('sparse lines arm unchanged at the far boundary', () => {
    // The unchanged direction: a 50s-away line arms at 50s before and after.
    const handler = buildHandler();
    const delays = captureDelays();
    const player = {
      guildId: 'g-sparse-1',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: (key: string) => {
        if (key === 'karaokeLines') return [{ ms: 60000, text: 'Later' }];
        return undefined;
      },
    };
    // calculatePosition stub says 9200; override per-player via queue position
    // is fixed, so expect 60000 - 9200 = 50800 either way.
    handler.armKaraokeTimer(player);
    handler.clearCardTimers('g-sparse-1');

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(50_800);
  });

  it('a paused clock still gets the cheap 15s recheck, not a hot loop', () => {
    const handler = buildHandler();
    const delays = captureDelays();
    handler.armKaraokeTimer(linePlayer('g-paused-1', true));
    handler.clearCardTimers('g-paused-1');

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(15_000);
  });
});
