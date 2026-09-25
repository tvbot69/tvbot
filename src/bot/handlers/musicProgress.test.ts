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
});
