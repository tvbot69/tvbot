import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicHandler } from '@bot/handlers/music/musicHandler';
import { QueueService } from '@bot/services/music/queueService';
import { EDIT_LATENCY_FLOOR_MS } from '@bot/services/music/syncedLyrics';


/**
 * Lyric sync full system: timer/display unity, monotonic hold, year-gap
 * survival and pause repair. Each case is a production shape that showed
 * lyrics early, froze them, or teleported them to the finale.
 */

const LINES = [
  { ms: 15000, text: 'One' },
  { ms: 25000, text: 'Two' },
  { ms: 35000, text: 'Three' },
];

const buildHandler = (position: number) => {
  const client = { on: vi.fn(), channels: { cache: new Map() } };
  const mgmt = { on: vi.fn(), players: { get: () => undefined } };
  const queueService = {
    getQueueInfo: () => null,
    is247: () => false,
    isKaraokeEnabled: () => true,
    calculatePosition: () => position,
  };
  const handler = new MusicHandler(
    client as never,
    { getManager: () => mgmt } as never,
    queueService as never,
    undefined,
    undefined,
    undefined,
    {} as never,
  ) as unknown as {
    lyricWindowFor: (player: unknown, pos: number) => { current: string | null; next: string | null } | null;
    armKaraokeTimer: (player: unknown) => void;
    clearCardTimers: (guildId: string) => void;
    karaokeTimersView: Map<string, NodeJS.Timeout>;
  };
  return handler;
};

const lyricPlayer = (guildId: string, extra?: Record<string, unknown>) => {
  const store = new Map<string, unknown>([['karaokeLines', LINES]]);
  if (extra) for (const [k, v] of Object.entries(extra)) store.set(k, v);
  return {
    guildId,
    playing: true,
    paused: false,
    textChannelId: 'tc-1',
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    set: (k: string, v: unknown) => void store.set(k, v),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lyric sync system: timer and display share one effective', () => {
  it('the window lags the clock by the measured edit latency, never leads it', () => {
    const handler = buildHandler(0);
    // Unmeasured latency is the 150ms floor, not the invented 1200ms.
    // Lines at 15s/25s/35s.
    expect(handler.lyricWindowFor(lyricPlayer('g-unity-1'), 15000)).toEqual({
      current: null,
      next: 'One',
    });
    expect(handler.lyricWindowFor(lyricPlayer('g-unity-2'), 15200)).toEqual({
      current: 'One',
      next: 'Two',
    });
    expect(EDIT_LATENCY_FLOOR_MS).toBe(150);
  });

  it('the timer arms to next-minus-clock, so it fires when the card flips', () => {
    const handler = buildHandler(9200);
    const delays: number[] = [];
    const orig = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: (...a: unknown[]) => void, ms: number, ...rest: unknown[]) => {
        delays.push(ms);
        return orig(fn, ms, ...rest);
      }) as typeof setTimeout,
    );
    // Lines 15s/25s/35s; position 9.2s, clock 9.05s: 15000 - 9050 = 5950.
    handler.armKaraokeTimer(lyricPlayer('g-unity-3'));
    handler.clearCardTimers('g-unity-3');
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(5950);
  });
});

describe('lyric sync system: monotonic hold across stale reads', () => {
  it('a backwards position with no seek intent holds the last window', () => {
    const handler = buildHandler(26000);
    const player = lyricPlayer('g-mono-1');
    // Position 26s, 150ms lag -> clock 25850, past the 25s line: Two.
    const first = handler.lyricWindowFor(player, 26000);
    expect(first?.current).toBe('Two');
    const stale = handler.lyricWindowFor(player, 10000);
    // Stale read refused: still Two, not a rewind to pre-first-line.
    expect(stale).toEqual(first);
  });

  it('a backwards seek with intent is allowed through', () => {
    const handler = buildHandler(10000);
    // Prime the memo forward: position 37s, clock 36850 -> Three singing.
    const shared = lyricPlayer('g-mono-2c');
    expect(handler.lyricWindowFor(shared, 37000)?.current).toBe('Three');
    shared.set('lastUserSeekAt', Date.now());
    shared.set('lastUserSeekPos', 10000);
    // Deliberate backward seek: the intro window returns, no hold.
    expect(handler.lyricWindowFor(shared, 10000)).toEqual({ current: null, next: 'One' });
  });
});

describe('lyric sync system: year-gap survival', () => {
  const queueSvc = () => new QueueService({ get: () => null } as never, {} as never);

  it('a wall clock claiming the track ended an hour ago freezes at base, not finale', () => {
    const now = Date.now();
    const svc = queueSvc();
    const player = {
      playing: true,
      paused: false,
      lastPosition: 0,
      current: { duration: 180000, position: 5000, time: now - 120000 },
      get: (k: string) => (k === 'trackStartedAt' ? now - 3600000 : undefined),
      set: () => undefined,
    } as never;
    // Node clock stale (2min old), wall elapsed 1h on a 3min track: the old
    // code clamped to duration (180s, finale lyrics). The guard holds base.
    expect(svc.calculatePosition(player)).toBeLessThan(60000);
  });

  it('a year-old seek never teleports the position to the end', () => {
    const now = Date.now();
    const svc = queueSvc();
    const player = {
      playing: true,
      paused: false,
      lastPosition: 4000,
      current: { duration: 180000, position: 4000, time: now - 120000 },
      get: (k: string) => {
        if (k === 'trackStartedAt') return now - 37000000;
        if (k === 'lastUserSeekAt') return now - 37000000;
        if (k === 'lastUserSeekPos') return 10000;
        return undefined;
      },
      set: () => undefined,
    } as never;
    expect(svc.calculatePosition(player)).toBeLessThan(60000);
  });
});

describe('lyric sync system: wall time is the audio clock', () => {
  // Every number below is a verbatim Karaoke boundary from the 2026-10-10
  // "Young" (VACATIONS) log on the Home node. `nodeLead` (pos - elapsed) sat
  // at 11684..11713 across twenty boundaries spanning 25s to 113s of the
  // track: a CONSTANT, not a drift. So audible position IS wall time since
  // trackStart, and the node position is a fixed ~11.7s ahead of it.
  //
  // The bug this replaces: the old clock was `pos - measuredLead - 1200`.
  // `measuredLead` was 3820 (it froze wrong — see the regression test below),
  // so the clock ran ~7.9s ahead of audible audio and every line landed on
  // the wrong line.
  const youngBoundaries = [
    { pos: 37004, elapsed: 25291, lineMs: 24090 },
    { pos: 41240, elapsed: 29527, lineMs: 36220 },
    { pos: 47338, elapsed: 35627, lineMs: 42320 },
    { pos: 54473, elapsed: 42789, lineMs: 49480 },
    { pos: 57424, elapsed: 45716, lineMs: 52380 },
    { pos: 60520, elapsed: 48812, lineMs: 55500 },
    { pos: 63825, elapsed: 52112, lineMs: 58800 },
    { pos: 68466, elapsed: 56767, lineMs: 63460 },
    { pos: 74368, elapsed: 62661, lineMs: 69340 },
    { pos: 79985, elapsed: 68273, lineMs: 74960 },
    { pos: 83041, elapsed: 71328, lineMs: 78020 },
    { pos: 85871, elapsed: 74158, lineMs: 80850 },
    { pos: 88968, elapsed: 77257, lineMs: 83950 },
    { pos: 95449, elapsed: 83738, lineMs: 90430 },
    { pos: 113199, elapsed: 101489, lineMs: 108180 },
    { pos: 119079, elapsed: 107380, lineMs: 114070 },
    { pos: 124789, elapsed: 113082, lineMs: 119760 },
  ];

  it('the node lead is a constant on this node, across the whole track', () => {
    const leads = youngBoundaries.map((b) => b.pos - b.elapsed);
    // Seventeen boundaries over 88 seconds of playback, spread under 30ms.
    // A CONSTANT is the whole finding: the node is not drifting, so one
    // measured lead describes the track and no boundary has to correct it.
    expect(Math.min(...leads)).toBeGreaterThan(11500);
    expect(Math.max(...leads)).toBeLessThan(11800);
    expect(Math.max(...leads) - Math.min(...leads)).toBeLessThan(200);
  });

  it('the pressing offset is a real, constant, per-track edit difference', () => {
    // The symptom rests on this: the node lead barely moves, while the audio
    // reaches each line ~6.7s before the provider's pressing says. A constant
    // offset means a DIFFERENT EDIT of the song in LRCLIB, not a drifting
    // clock — which is why no amount of clock tuning removes it.
    const gaps = youngBoundaries.map((b) => b.lineMs - b.elapsed);
    // The first boundary is the only one that can be behind (the timer may
    // land past an early line); from the second on it is rock steady.
    const steady = gaps.slice(1);
    expect(Math.min(...steady)).toBeGreaterThan(6500);
    expect(Math.max(...steady)).toBeLessThan(7000);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(400);
  });
});

