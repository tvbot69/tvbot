import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicHandler } from './musicHandler';

const LINES = [
  { ms: 2000, text: 'Line one' },
  { ms: 8000, text: 'Line two' },
];

const buildHandler = () => {
  const client = { on: vi.fn(), channels: { cache: new Map() } };
  const manager = { on: vi.fn(), players: { get: () => undefined } };
  const queueService = {
    getQueueInfo: () => null,
    is247: () => false,
    isKaraokeEnabled: () => true,
    calculatePosition: () => 10000,
  };
  return new MusicHandler(
    client as never,
    { getManager: () => manager } as never,
    queueService as never,
    undefined,
    undefined,
    undefined,
    {} as never,
  ) as unknown as {
    lyricWindowFor: (player: unknown, positionMs: number) => { current: string | null; next: string | null } | null;
    publishProgress: (player: unknown) => Promise<void>;
    progressPublishing: Map<string, number>;
    armKaraokeTimer: (player: unknown) => void;
    armChapterTimer: (player: unknown) => void;
    clearCardTimers: (guildId: string) => void;
    karaokeTimers: Map<string, NodeJS.Timeout>;
    chapterTimers: Map<string, NodeJS.Timeout>;
  };
};

const karaokePlayer = {
  guildId: 'g-progress-1',
  playing: true,
  paused: false,
  textChannelId: 'tc-1',
  get: (key: string) => (key === 'karaokeLines' ? LINES : undefined),
};

describe('MusicHandler progress card', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lyric window follows the real clock with no startup offset', () => {
    const handler = buildHandler();
    // First line at 2s, clock at 4s: with the old 3s offset the effective
    // position (1s) sat before the first line (current null); now it sings.
    expect(handler.lyricWindowFor(karaokePlayer, 4000)).toEqual({ current: 'Line one', next: 'Line two' });
    expect(handler.lyricWindowFor(karaokePlayer, 0)).toEqual({ current: null, next: 'Line one' });
    expect(handler.lyricWindowFor(karaokePlayer, 9000)).toEqual({ current: 'Line two', next: null });
  });

  it('retakes a stale publish guard instead of skipping forever', async () => {
    const handler = buildHandler();
    handler.progressPublishing.set('g-progress-1', Date.now() - 60000);
    // Not playing: returns right after the guard check — but the stale guard
    // must be gone afterwards (retaken, then released), not left blocking.
    await handler.publishProgress({ guildId: 'g-progress-1', playing: false, textChannelId: 'tc-1' });
    expect(handler.progressPublishing.has('g-progress-1')).toBe(false);
  });

  it('a fresh guard still suppresses overlapping ticks', async () => {
    const handler = buildHandler();
    const acquired = Date.now();
    handler.progressPublishing.set('g-progress-1', acquired);
    await handler.publishProgress({ guildId: 'g-progress-1', playing: false, textChannelId: 'tc-1' });
    expect(handler.progressPublishing.get('g-progress-1')).toBe(acquired);
  });

  it('arms one-shot boundary timers to the next lyric line and chapter', () => {
    const handler = buildHandler();
    const player = {
      guildId: 'g-timers-1',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: (key: string) => {
        if (key === 'karaokeLines') return [{ ms: 60000, text: 'Later' }];
        if (key === 'chapters') {
          return [
            { title: 'Intro', startMs: 0 },
            { title: 'Main Set', startMs: 120000 },
          ];
        }
        if (key === 'chapterIdx') return 0;
        return undefined;
      },
    };
    handler.armKaraokeTimer(player);
    handler.armChapterTimer(player);
    // Position (10s) sits before both boundaries — one timer each, no polling.
    expect(handler.karaokeTimers.size).toBe(1);
    expect(handler.chapterTimers.size).toBe(1);
    handler.clearCardTimers('g-timers-1');
    expect(handler.karaokeTimers.size).toBe(0);
    expect(handler.chapterTimers.size).toBe(0);
  });

  it('arms no timers when there is nothing to follow', () => {
    const handler = buildHandler();
    const bare = {
      guildId: 'g-timers-2',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: () => undefined,
    };
    handler.armKaraokeTimer(bare);
    handler.armChapterTimer(bare);
    expect(handler.karaokeTimers.size).toBe(0);
    expect(handler.chapterTimers.size).toBe(0);
  });

  it('arms the chapter timer when chapters attach after track start', async () => {
    const savedKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = 'test-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ snippet: { description: 'Full Set\n\n0:00 - A\n1:00 - B' } }] }),
    } as Response);
    try {
      const manager = { on: vi.fn(), players: { get: () => undefined } };
      const client = { on: vi.fn(), channels: { cache: new Map() } };
      const handler = buildHandler() as unknown as {
        resolveVideoChapters: (player: unknown, track: unknown) => void;
        publishProgress: (player: unknown) => Promise<void>;
        clearCardTimers: (guildId: string) => void;
        chapterTimers: Map<string, NodeJS.Timeout>;
      };
      const spy = vi.spyOn(handler, 'publishProgress').mockResolvedValue(undefined);
      const store: Record<string, unknown> = {};
      const player = {
        guildId: 'g-attach-1',
        playing: true,
        paused: false,
        textChannelId: 'tc-1',
        get: (k: string) => store[k],
        set: (k: string, v: unknown) => void (store[k] = v),
      };
      handler.resolveVideoChapters(player, {
        sourceName: 'youtube',
        identifier: 'attachvid01',
        title: 'Full Set',
        duration: 3600000,
      });
      await new Promise((r) => setTimeout(r, 450));
      // Chapters attached (nudge published) AND following armed — before the
      // fix only the nudge existed, so later transitions never fired.
      expect(spy).toHaveBeenCalledTimes(1);
      expect((store.chapters as unknown[]).length).toBe(2);
      expect(handler.chapterTimers.has('g-attach-1')).toBe(true);
      handler.clearCardTimers('g-attach-1');
      expect(handler.chapterTimers.has('g-attach-1')).toBe(false);
    } finally {
      if (savedKey === undefined) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = savedKey;
      vi.restoreAllMocks();
    }
  });

  it('retries a failed card edit a bounded number of times', async () => {
    const edit = vi.fn().mockRejectedValue({ code: 50013 });
    const msg = { edit };
    const channel = {
      isTextBased: () => true,
      messages: { cache: { get: () => null }, fetch: async () => msg },
    };
    const client = { on: vi.fn(), channels: { cache: new Map(), fetch: async () => channel } };
    const manager = { on: vi.fn(), players: { get: () => undefined } };
    const queue = {
      current: {
        identifier: 't-retry-1',
        title: 'Retry Song',
        author: 'Band',
        uri: 'https://youtube.com/watch?v=t-retry-1',
        duration: 200000,
        isSeekable: true,
        isStream: false,
        source: 'youtube',
      },
      tracks: [],
      totalTracks: 1,
      totalDuration: 200000,
      remainingDuration: 200000,
      loopMode: 'off',
      volume: 100,
      isPaused: false,
      isPlaying: true,
      is247: false,
      autoplay: false,
      position: 5000,
    };
    const handler = new (await import('./musicHandler')).MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => queue, is247: () => false, isKaraokeEnabled: () => true } as never,
    ) as unknown as {
      publishProgress: (player: unknown) => Promise<void>;
      clearCardTimers: (guildId: string) => void;
      publishRetries: Map<string, number>;
      progressNudgeTimers: Map<string, NodeJS.Timeout>;
    };
    const player = {
      guildId: 'g-retry-1',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: (k: string) => (k === 'nowPlayingMessageId' ? 'msg-1' : undefined),
      set: () => undefined,
    };
    await handler.publishProgress(player);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(handler.publishRetries.get('g-retry-1')).toBe(1);
    expect(handler.progressNudgeTimers.has('g-retry-1')).toBe(true);
    // Exhaust the budget: retries climb to 3, then the entry is dropped and
    // no further retry is scheduled (each publish = exactly one edit).
    await handler.publishProgress(player);
    expect(handler.publishRetries.get('g-retry-1')).toBe(2);
    await handler.publishProgress(player);
    expect(handler.publishRetries.get('g-retry-1')).toBe(3);
    await handler.publishProgress(player);
    expect(edit).toHaveBeenCalledTimes(4);
    expect(handler.publishRetries.has('g-retry-1')).toBe(false);
    handler.clearCardTimers('g-retry-1');
    expect(handler.progressNudgeTimers.has('g-retry-1')).toBe(false);
  });

  it('opens hype chapters on the first real song cover without naming it', async () => {
    const manager = { on: vi.fn(), players: { get: () => undefined } };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    const handler = new (await import('./musicHandler')).MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false, isKaraokeEnabled: () => true } as never,
    ) as unknown as {
      chapterCardFor: (player: unknown, positionMs: number) => { title: string; artworkUrl?: string | null } | null;
      clearCardTimers: (guildId: string) => void;
      artworkService: unknown;
    };
    handler.artworkService = { getTrackCoverUrl: async () => 'https://img.test/real.jpg' };
    const store: Record<string, unknown> = {};
    const player = {
      guildId: 'g-hype-1',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      current: { title: 'd4vd - Live at Washington D.C' },
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    store.chapters = [
      { title: 'Intro', startMs: 0 },
      { title: 'Take Me To The Sun', startMs: 5000 },
    ];
    // Inside the hype chapter: no card line, but the hold carries song art.
    expect(handler.chapterCardFor(player, 2000)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.chapterCard ?? null).toBeNull();
    expect(store.lastCoverUrl).toBe('https://img.test/real.jpg');
    handler.clearCardTimers('g-hype-1');
  });

  it('publishes when a chapter cover lands (title-only keys swallowed the swap)', async () => {
    const edit = vi.fn().mockResolvedValue({});
    const channel = {
      isTextBased: () => true,
      messages: { cache: { get: () => ({ edit }) }, fetch: async () => ({ edit }) },
    };
    const client = { on: vi.fn(), channels: { cache: new Map(), fetch: async () => channel } };
    const manager = { on: vi.fn(), players: { get: () => undefined } };
    const SHOW = [
      { title: 'Rottweiler', startMs: 0 },
      { title: '4 Raws', startMs: 150000 },
    ];
    const store: Record<string, unknown> = {
      nowPlayingMessageId: 'msg-1',
      chapters: SHOW,
      chapterIdx: 0,
      chapterStartedAt: Date.now(),
      chapterCard: { title: 'Rottweiler', artworkUrl: 'https://img.test/rottweiler.jpg' },
      lastCoverUrl: 'https://img.test/rottweiler.jpg',
    };
    const queue = {
      current: {
        identifier: 'show-1',
        title: 'EsDeeKid - Live at Silver Spring',
        author: 'EsDeeKid',
        uri: 'https://youtube.com/watch?v=show-1',
        duration: 3821000,
        isSeekable: true,
        isStream: false,
        source: 'local',
        artworkUrl: 'https://img.test/show.jpg',
      },
      tracks: [],
      totalTracks: 1,
      totalDuration: 3821000,
      remainingDuration: 3821000,
      loopMode: 'off',
      volume: 100,
      isPaused: false,
      isPlaying: true,
      is247: false,
      autoplay: false,
      position: 60000,
    };
    const player = {
      guildId: 'g-chswap-1',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      current: queue.current,
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    const handler = new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => queue, is247: () => false, isKaraokeEnabled: () => false } as never,
    ) as unknown as {
      publishProgress: (player: unknown) => Promise<void>;
      clearCardTimers: (guildId: string) => void;
    };

    // 1. Song 1 with its own cover: posted.
    await handler.publishProgress(player);
    expect(edit).toHaveBeenCalledTimes(1);

    // 2. Boundary into song 2 while its art is still resolving: the card
    //    borrows song 1's cover, so the title is the only visible change.
    queue.position = 200000;
    store.chapterIdx = 1;
    store.chapterCard = { title: '4 Raws', artworkUrl: null };
    await handler.publishProgress(player);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(edit.mock.calls[1]![0])).toContain('rottweiler.jpg');

    // 3. Song 2's cover resolves. Only the IMAGE changed — the old
    //    `title~hasArt` key made this look identical to what was already
    //    posted, so the card stayed on song 1's cover for the whole song.
    store.chapterCard = { title: '4 Raws', artworkUrl: 'https://img.test/raws.jpg' };
    await handler.publishProgress(player);
    expect(edit).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(edit.mock.calls[2]![0])).toContain('raws.jpg');

    // 4. Nothing changed: no edit (the dirty check still holds).
    await handler.publishProgress(player);
    expect(edit).toHaveBeenCalledTimes(3);
    handler.clearCardTimers('g-chswap-1');
  });

  it('keeps chapters across a same-video track restart (no wipe + re-probe gap)', () => {
    const manager = { on: vi.fn(), players: { get: () => undefined } };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    const handler = buildHandler() as unknown as {
      resolveVideoChapters: (player: unknown, track: unknown) => void;
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not probe'));
    const chapters = [
      { title: 'Take Me To The Sun', startMs: 0 },
      { title: 'Bleed Out', startMs: 276000 },
    ];
    const card = { title: 'Take Me To The Sun', artworkUrl: 'https://img.test/sun.jpg' };
    const store: Record<string, unknown> = {
      chapterSourceId: 'KxkrKdefKqw',
      chapters,
      chapterCard: card,
      chapterIdx: 0,
    };
    const player = {
      guildId: 'g-samevid-1',
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    const track = { sourceName: 'youtube', identifier: 'KxkrKdefKqw', title: 'Show', duration: 3821000 };
    handler.resolveVideoChapters(player, track);
    // Untouched: same chapters, same card, and crucially no probe fired.
    expect(store.chapters).toBe(chapters);
    expect(store.chapterCard).toBe(card);
    expect(store.chapterIdx).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('syncs the posted fingerprint on track start', async () => {
    const send = vi.fn(async () => ({ id: 'card-9' }));
    const channel = { isTextBased: () => true, send };
    const client = { on: vi.fn(), channels: { cache: new Map([['tc-9', channel]]) } };
    const seen: Array<{ event: string; cb: (...args: never[]) => unknown }> = [];
    const manager = {
      on: vi.fn((event: string, cb: (...args: never[]) => unknown) => {
        seen.push({ event, cb });
      }),
      players: { get: () => undefined },
    };
    const queue = {
      current: {
        identifier: 't-fp-1',
        title: 'Song',
        author: 'Band',
        uri: 'https://youtube.com/watch?v=t-fp-1',
        duration: 200000,
        isSeekable: true,
        isStream: false,
        source: 'youtube',
      },
      tracks: [],
      totalTracks: 1,
      totalDuration: 200000,
      remainingDuration: 200000,
      loopMode: 'off',
      volume: 100,
      isPaused: false,
      isPlaying: true,
      is247: false,
      autoplay: false,
      position: 0,
    };
    const { MusicHandler: Handler } = await import('./musicHandler');
    const handler = new Handler(
      client as never,
      { getManager: () => manager } as never,
      {
        getQueueInfo: () => queue,
        is247: () => false,
        isKaraokeEnabled: () => true,
        recordTrackStart: vi.fn(),
      } as never,
    ) as unknown as {
      progressFingerprints: Map<string, string>;
      clearCardTimers: (guildId: string) => void;
    };
    const onStart = seen.find((s) => s.event === 'trackStart')?.cb as (
      player: unknown,
      track: unknown,
    ) => Promise<void>;
    const store: Record<string, unknown> = {};
    const player = {
      guildId: 'g-fp-1',
      voiceChannelId: 'vc-1',
      textChannelId: 'tc-9',
      node: { identifier: 'test-node' },
      playing: true,
      paused: false,
      current: { ...queue.current, position: 0, time: Date.now() },
      queue: { size: 0 },
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    await onStart(player, { ...queue.current });
    expect(send).toHaveBeenCalledTimes(1);
    // Posted plain (no chapters/lyrics): the fingerprint records exactly that.
    expect(handler.progressFingerprints.get('g-fp-1')).toBe('t-fp-1|r|0|off|100|none|none');
    expect(store.nowPlayingMessageId).toBe('card-9');
    handler.clearCardTimers('g-fp-1');
  });

  it('deletes the now-playing card when the song ends', async () => {
    const deleted: string[] = [];
    const store = new Map<string, unknown>([['nowPlayingMessageId', 'msg-1']]);
    const client = {
      on: vi.fn(),
      channels: {
        cache: new Map(),
        fetch: vi.fn(async () => ({
          messages: {
            delete: async (id: string) => {
              deleted.push(id);
            },
          },
        })),
      },
    };
    const seen: Array<{ event: string; cb: (...args: never[]) => unknown }> = [];
    const manager = {
      on: vi.fn((event: string, cb: (...args: never[]) => unknown) => {
        seen.push({ event, cb });
      }),
      players: { get: () => undefined },
    };
    const { MusicHandler: Handler } = await import('./musicHandler');
    const handler = new Handler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false, isKaraokeEnabled: () => true } as never,
    );
    const onEnd = seen.find((s) => s.event === 'trackEnd')?.cb as (
      player: unknown,
      track: unknown,
      reason: string,
    ) => void;
    const player = {
      guildId: 'g-end-1',
      textChannelId: 'tc-1',
      current: { title: 'Done', duration: 200000 },
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => void store.set(key, value),
    };
    onEnd(player, { title: 'Done', duration: 200000 }, 'finished');
    await new Promise((r) => setTimeout(r, 20));
    expect(deleted).toEqual(['msg-1']);
    expect(store.get('nowPlayingMessageId')).toBeNull();
  });

  it('lands exactly on the chosen chapter when seeking to its start', () => {
    const handler = buildHandler() as unknown as {
      swapChapterOnSeek: (player: unknown, positionMs: number) => void;
      chapterCardFor: (player: unknown, positionMs: number) => { title: string; artworkUrl?: string | null } | null;
      clearCardTimers: (guildId: string) => void;
    };
    const store: Record<string, unknown> = {
      chapterIdx: -2,
      chapters: [
        { title: 'Take Me To The Sun', startMs: 0 },
        { title: 'Bleed Out', startMs: 276000 },
      ],
    };
    const staleAt = Date.now() - 30000;
    const current = { title: 'd4vd - Live at Washington D.C', position: 360000, time: staleAt };
    const player = {
      guildId: 'g-swap-1',
      playing: false,
      textChannelId: 'tc-1',
      current,
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    // Exact boundary: the legacy 3s offset resolved this to the PREVIOUS
    // chapter for the rest of the song.
    handler.swapChapterOnSeek(player, 276000);
    expect((store.chapterCard as { title: string }).title).toBe('Bleed Out');
    expect(store.chapterIdx).toBe(1);
    // The swap pins the optimistic clock (moonlink updates it only after
    // the seek REST round-trip): the trailing publish re-derives the SAME
    // chapter instead of flapping back to the stale one.
    expect(current.position).toBe(276000);
    expect(handler.chapterCardFor(player, current.position)?.title).toBe('Bleed Out');
    handler.clearCardTimers('g-swap-1');
  });
});
