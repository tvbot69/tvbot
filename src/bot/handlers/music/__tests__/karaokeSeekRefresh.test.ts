import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicEventListeners } from '@bot/handlers/music/musicEventListeners';

/**
 * A user seek must refresh the now-playing card, not just re-arm timers.
 *
 * `onPlayerTriggeredSeek` re-armed both boundary timers but never published:
 * on a chapterless track `swapChapterOnSeek` early-returns without scheduling
 * (there are no chapters to swap), and the seek command itself only answers
 * its own "Seeked" notice. Realistic shape: lines at 90s/100s/110s, listener
 * seeks 60s -> 95s. The card kept the 60s line until the 100s boundary fired
 * the timer — tens of seconds of wrong lyrics — and a seek past the last line
 * armed NO timer at all, freezing the pre-seek line for the rest of the track.
 * The node-initiated twin (`onPlayerSeek`) already scheduled; user seeks must too.
 */

const makeHost = () => ({
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
});

/** Chapterless track mid-play: the karaoke-active, no-chapters shape. */
const makePlayer = (withLines = true) => {
  const store = new Map<string, unknown>();
  if (withLines) {
    store.set('karaokeLines', [
      { ms: 90_000, text: 'Ninetieth second' },
      { ms: 100_000, text: 'Hundredth second' },
      { ms: 110_000, text: 'Hundred tenth second' },
    ]);
  }
  return {
    guildId: 'g-seek-karaoke-1',
    playing: true,
    paused: false,
    textChannelId: 'tc-1',
    current: { duration: 284_000, position: 60_000, time: Date.now() - 1_000 },
    queue: { size: 0, isEmpty: true, unshift: vi.fn() },
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    set: (k: string, v: unknown) => void store.set(k, v),
  };
};

const buildListeners = (host: ReturnType<typeof makeHost>) =>
  new MusicEventListeners(
    host as never,
    { getManager: () => ({ on: vi.fn() }) } as never,
    {
      calculatePosition: vi.fn(() => 60_000),
      getQueueInfo: vi.fn(() => null),
      isKaraokeEnabled: vi.fn(() => true),
    } as never,
    { channels: { cache: new Map(), fetch: vi.fn(async () => null) }, on: vi.fn() } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    new Map(),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('onPlayerTriggeredSeek refreshes the card', () => {
  it('a user seek re-arms timers AND schedules an immediate publish', () => {
    const host = makeHost();
    const listeners = buildListeners(host);
    const player = makePlayer();

    listeners.onPlayerTriggeredSeek(player as never, 95_000);

    expect(host.swapChapterOnSeek).toHaveBeenCalledTimes(1);
    expect(host.armKaraokeTimer).toHaveBeenCalledTimes(1);
    expect(host.armChapterTimer).toHaveBeenCalledTimes(1);
    // The fix: without this the 95s line waits for the 100s boundary (or forever).
    expect(host.scheduleImmediateProgress).toHaveBeenCalledTimes(1);
    expect(host.scheduleImmediateProgress).toHaveBeenCalledWith(player);
  });

  it('a seek with no resolved lyric lines stays silent', () => {
    // The economy twin: nothing lyric-visible can change, so no publish is
    // scheduled — same-chapter chaptered seeks keep the pinned no-nudge shape.
    const host = makeHost();
    const listeners = buildListeners(host);
    const player = makePlayer(false);

    listeners.onPlayerTriggeredSeek(player as never, 95_000);

    expect(host.armKaraokeTimer).toHaveBeenCalledTimes(1);
    expect(host.armChapterTimer).toHaveBeenCalledTimes(1);
    expect(host.scheduleImmediateProgress).not.toHaveBeenCalled();
  });

  it('node-initiated seeks still re-pin the clock and schedule exactly once', () => {
    // The unchanged direction: `onPlayerSeek` already scheduled — one call,
    // not two, and the stale node clock is re-stamped to the seek target.
    const host = makeHost();
    const listeners = buildListeners(host);
    const player = makePlayer();

    listeners.onPlayerSeek(player as never, 95_000);

    expect(host.scheduleImmediateProgress).toHaveBeenCalledTimes(1);
    expect((player.current as { position: number }).position).toBe(95_000);
  });
});
