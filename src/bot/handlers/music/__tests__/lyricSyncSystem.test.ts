import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicHandler } from '@bot/handlers/music/musicHandler';
import { QueueService } from '@bot/services/music/queueService';
import { LYRIC_SAFETY_LAG_MS } from '@bot/services/music/musicConstants';

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
  it('the window lags the clock by the safety lag, never leads it', () => {
    const handler = buildHandler(0);
    // Raw 15s, effective 13.8s: still before the 15s line. Showing the line
    // at raw 15s would be 1.2s early (timer slack + edit round-trip).
    expect(handler.lyricWindowFor(lyricPlayer('g-unity-1'), 15000)).toEqual({
      current: null,
      next: 'One',
    });
    // Raw 16.2s, effective 15s: line one is singing.
    expect(handler.lyricWindowFor(lyricPlayer('g-unity-2'), 16200)).toEqual({
      current: 'One',
      next: 'Two',
    });
    expect(LYRIC_SAFETY_LAG_MS).toBe(1200);
  });

  it('the timer arms to next-minus-effective, so it fires when the card flips', () => {
    const handler = buildHandler(9200);
    const delays: number[] = [];
    const orig = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: (...a: unknown[]) => void, ms: number, ...rest: unknown[]) => {
        delays.push(ms);
        return orig(fn, ms, ...rest);
      }) as typeof setTimeout,
    );
    // Lines fixture here is 15s/25s/35s; position 9.2s, effective 8s:
    // 15000 - 8000 = 7000. Raw-clock arming gave 5800 and fired early.
    handler.armKaraokeTimer(lyricPlayer('g-unity-3'));
    handler.clearCardTimers('g-unity-3');
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBe(7000);
  });
});

describe('lyric sync system: monotonic hold across stale reads', () => {
  it('a backwards position with no seek intent holds the last window', () => {
    const handler = buildHandler(26000);
    const player = lyricPlayer('g-mono-1');
    // First read at 26s (effective 24.8s): line one singing... actually
    // 24.8s sits between 15s and 25s, so current is One... wait 24.8 < 25:
    // current One, next Two. Then the node reports a stale 10s.
    const first = handler.lyricWindowFor(player, 26000);
    expect(first?.current).toBe('One');
    const stale = handler.lyricWindowFor(player, 10000);
    // Stale read refused: still One, not a rewind to pre-first-line.
    expect(stale).toEqual(first);
  });

  it('a backwards seek with intent is allowed through', () => {
    const handler = buildHandler(10000);
    // Prime the memo forward first: raw 37s, effective 35.8s -> Three singing.
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

/**
 * The 2026-10-10 regression, verbatim from the Railway log for "Next Exit"
 * (Vacations, 201s). every line below is a measured Karaoke boundary:
 *
 *   { pos: 22941, elapsed: 14261, nodeLead: 8680  }
 *   { pos: 26866, elapsed: 15260, nodeLead: 11606 }
 *   { pos: 69127, elapsed: 57532, nodeLead: 11595 } (one minute in)
 *
 * nodeLead then stayed 11577..11610 to the end of the track, so audible
 * audio sat pos - ~11600ms while the card subtracted only the 1200ms safety
 * lag: every line appeared ~10.4s before it was heard. The line timestamps
 * are the ones in that log's own boundary fire order.
 */
const NODE_LINES = [
  { ms: 13430, text: 'One' },
  { ms: 22740, text: 'Two' },
  { ms: 25800, text: 'Three' },
  { ms: 28690, text: 'Four' },
  { ms: 31620, text: 'Five' },
  { ms: 59290, text: 'Six' },
];

const nodePlayer = (guildId: string, over: Record<string, unknown>) => ({
  guildId,
  playing: true,
  paused: false,
  textChannelId: 'tc-1',
  get: <T>(k: string): T | undefined => {
    const store: Record<string, unknown> = { karaokeLines: NODE_LINES, ...over };
    return store[k] as T | undefined;
  },
  set: (k: string, v: unknown) => void Object.assign(over, { [k]: v }),
});

describe('lyric sync system: the measured node startup lead', () => {
  it('subtracts the measured lead, so a line fires when it is heard', () => {
    const now = Date.now();
    const handler = buildHandler(0);
    const h = handler as unknown as { lyricWindowFor: (p: unknown, pos: number) => unknown };
    // Track started 57532ms ago, node reports 69127ms: lead is 11595ms, the
    // measured nodeLead. Clock = 69127 - 11595 - 1200 = 56332, i.e. 2.9s
    // BEFORE the audible position — which is what the line at 59290 needs,
    // and what the fixed 1200ms lag got wrong by 10.4s.
    const player = nodePlayer('g-lead-1', { trackStartedAt: now - 57532, lyricLeadFrozen: true, lyricLeadMs: 11595 });
    const window = h.lyricWindowFor(player, 69127) as { current: string | null; next: string | null };
    expect(window).toEqual({ current: 'Five', next: 'Six' });
  });

  it('holds the intro while the startup lead is still unproven', () => {
    vi.useFakeTimers();
    const base = new Date('2026-10-10T11:27:29Z').getTime();
    vi.setSystemTime(base);
    const handler = buildHandler(0);
    const h = handler as unknown as { lyricWindowFor: (p: unknown, pos: number) => unknown };
    const store: Record<string, unknown> = { karaokeLines: NODE_LINES, trackStartedAt: base };
    const player = {
      guildId: 'g-lead-2',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: <T>(k: string): T | undefined => store[k] as T | undefined,
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    // First log boundary: position 22941ms, elapsed 14261ms. The node clock
    // is still 8.7s ahead of audible audio and rising, so nothing is claimed
    // to be singing — the 13.43s line is only offered as upcoming.
    vi.setSystemTime(base + 14261);
    const window = h.lyricWindowFor(player, 22941) as { current: string | null; next: string | null };
    expect(window).toEqual({ current: null, next: 'One' });
  });

  it('measures the lead by running max and freezes it once it settles', () => {
    // Wall time advances with the node position, exactly as in the log.
    vi.useFakeTimers();
    const base = new Date('2026-10-10T11:27:29Z').getTime();
    vi.setSystemTime(base);
    const handler = buildHandler(0);
    const h = handler as unknown as { lyricWindowFor: (p: unknown, pos: number) => unknown };
    const store: Record<string, unknown> = { karaokeLines: NODE_LINES, trackStartedAt: base };
    const player = {
      guildId: 'g-lead-3',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: <T>(k: string): T | undefined => store[k] as T | undefined,
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    // Boundary one of the log: elapsed 14261ms, node position 22941ms.
    // The node has not true-upped yet, so the candidate lead is 8680ms and
    // the lead is unproven — no line is claimed to be singing.
    vi.setSystemTime(base + 14261);
    expect(h.lyricWindowFor(player, 22941)).toEqual({ current: null, next: 'One' });
    expect(store.lyricLeadMs).toBe(8680);
    expect(store.lyricLeadFrozen).toBe(false);
    // Boundary two, one second later in the log: the node clock true-ups and
    // the candidate becomes 11606ms. Still unproven, still nothing claimed.
    vi.setSystemTime(base + 15260);
    expect(h.lyricWindowFor(player, 26866)).toEqual({ current: null, next: 'One' });
    expect(store.lyricLeadMs).toBe(11606);
  });

  it('freezes the lead on the first repeat and then claims the singing line', () => {
    vi.useFakeTimers();
    const base = new Date('2026-10-10T11:27:29Z').getTime();
    vi.setSystemTime(base);
    const handler = buildHandler(0);
    const h = handler as unknown as { lyricWindowFor: (p: unknown, pos: number) => unknown };
    const store: Record<string, unknown> = { karaokeLines: NODE_LINES, trackStartedAt: base };
    const player = {
      guildId: 'g-lead-3b',
      playing: true,
      paused: false,
      textChannelId: 'tc-1',
      get: <T>(k: string): T | undefined => store[k] as T | undefined,
      set: (k: string, v: unknown) => void (store[k] = v),
    };
    // Boundary three of the log: elapsed 15512ms, node position 27117ms.
    // Candidate 11605ms, unproven on its own.
    vi.setSystemTime(base + 15512);
    h.lyricWindowFor(player, 27117);
    expect(store.lyricLeadFrozen).toBe(false);
    // A moment later the same boundary is read again: the candidate repeats
    // within tolerance, so the lead is SETTLED and the window derives from it.
    // Clock = 27117 - 11605 - 1200 = 14312, between the 13.43s and 22.74s lines.
    vi.setSystemTime(base + 15600);
    const window = h.lyricWindowFor(player, 27117) as { current: string | null; next: string | null };
    expect(store.lyricLeadFrozen).toBe(true);
    expect(window).toEqual({ current: 'One', next: 'Two' });
  });

  it('never claims a line while the node clock is still proving the lead', () => {
    const now = Date.now();
    const handler = buildHandler(0);
    const h = handler as unknown as { lyricWindowFor: (p: unknown, pos: number) => unknown };
    // Second log boundary: position 26866 with audible at ~15.26s. The 22.74s
    // line is nowhere near, so only the first upcoming line is offered.
    const player = nodePlayer('g-lead-4', { trackStartedAt: now - 15260 });
    const window = h.lyricWindowFor(player, 26866) as { current: string | null; next: string | null };
    expect(window).toEqual({ current: null, next: 'One' });
  });

  it('after the window the lead is frozen and the clock is position-based', () => {
    const now = Date.now();
    const queueService = {
      getQueueInfo: () => null,
      is247: () => false,
      isKaraokeEnabled: () => true,
      // Deep user seek: position 150s, wall elapsed only 20s. The frozen lead
      // must not be re-measured from a seek, or it would swallow the seek.
      calculatePosition: () => 150000,
    };
    const handler2 = new MusicHandler(
      { on: vi.fn(), channels: { cache: new Map() } } as never,
      { getManager: () => ({ on: vi.fn() }) } as never,
      queueService as never,
      undefined,
      undefined,
      undefined,
      {} as never,
    ) as unknown as {
      lyricWindowFor: (p: unknown, pos: number) => unknown;
      armKaraokeTimer: (p: unknown) => void;
      clearCardTimers: (guildId: string) => void;
      karaokeTimersView: Map<string, NodeJS.Timeout>;
    };
    const player = nodePlayer('g-lead-5', {
      trackStartedAt: now - 20000,
      lyricLeadFrozen: true,
      lyricLeadMs: 11595,
      lastUserSeekAt: now - 2000,
      lastUserSeekPos: 150000,
      karaokeLines: [{ ms: 140000, text: 'Deep' }, { ms: 160000, text: 'Deeper' }],
    });
    // Clock = 150000 - 11595 - 1200 = 137205: between 140000 and 160000 no,
    // just before 140000 -> Deep upcoming, nothing current.
    const window = handler2.lyricWindowFor(player, 150000) as { current: string | null; next: string | null };
    expect(window).toEqual({ current: null, next: 'Deep' });
    // The seek did not corrupt the frozen lead: still the measured value.
    expect((player.get('lyricLeadMs') as number)).toBe(11595);
  });
});
