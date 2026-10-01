import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHAPTER_REGRESSION_TOLERANCE_MS, USER_SEEK_INTENT_WINDOW_MS } from '@bot/services/music/musicConstants';

/**
 * Regressions for the chapter rewind, found from a local test log on
 * 2026-09-27 that reproduced the two-day "chapter and art don't change" report:
 *
 *   [03:56:22] .seek 21:58
 *   [03:56:23] statusText: 'Mac DeMarco - I Like Her'      <- correct
 *   [03:56:24] Chapter art { idx: 8, song: 'I Like Her', ok: true }
 *   [03:56:25] statusText: 'Mac DeMarco - ARTE Concert Festival'   <- rewound to 0
 *
 * There was a guard for implausible FORWARD jumps but none for a backward one,
 * so a stale position read (a queue snapshot captured at 0 before the seek's
 * REST landed) committed chapter 0 instantly, with no delay and no
 * confirmation. The art had already resolved, so the card visibly reverted.
 */

const CHAPTERS = [
  // Mirrors the real Mac DeMarco - ARTE Concert Festival 2025 chapter list:
  // chapter 0 is the show/venue title, not a suppressed generic intro.
  { title: 'ARTE Concert Festival', startMs: 0 },
  { title: 'Shining', startMs: 60_000 },
  { title: 'For the First Time', startMs: 200_000 },
  { title: 'Fourth Song', startMs: 340_000 },
  { title: 'Fifth Song', startMs: 500_000 },
  { title: 'Sixth Song', startMs: 700_000 },
  { title: 'Seventh Song', startMs: 900_000 },
  { title: 'Eighth Song', startMs: 1_100_000 },
  { title: 'I Like Her', startMs: 1_300_000 },
  { title: 'Tenth Song', startMs: 1_500_000 },
];

const buildHandler = async () => {
  const seen: Array<{ event: string; cb: (...args: never[]) => unknown }> = [];
  const client = { on: vi.fn(), channels: { cache: new Map() } };
  const manager = {
    on: vi.fn((event: string, cb: (...args: never[]) => unknown) => {
      seen.push({ event, cb });
    }),
    players: { get: () => undefined },
  };
  const { MusicHandler } = await import('../musicHandler');
  const handler = new MusicHandler(
    client as never,
    { getManager: () => manager } as never,
    {
      getQueueInfo: () => null,
      is247: () => false,
      isKaraokeEnabled: () => true,
      recordTrackStart: vi.fn(),
      calculatePosition: () => 0,
    } as never,
  ) as unknown as {
    chapterCardFor: (player: unknown, positionMs: number) => { title: string } | null;
    swapChapterOnSeek: (player: unknown, positionMs: number) => void;
    updateChapterStatus: (player: unknown) => void;
    prefetchChapterArts: (player: unknown, chapters: unknown, indices: number[]) => void;
    scheduleImmediateProgress: (player: unknown, delayMs?: number) => void;
    resolveChapterArt: (player: unknown, idx: number, chapters: unknown) => Promise<void>;
    clearChapterArtRetryTimer: (guildId: string) => void;
    artworkService?: unknown;
  };
  return handler;
};

const makePlayer = (store: Record<string, unknown>) => ({
  guildId: 'g-rewind',
  node: { identifier: 'Home', rest: { loadTracks: vi.fn() } },
  get: <T,>(k: string) => store[k] as T,
  set: (k: string, v: unknown) => {
    store[k] = v;
  },
});

describe('MusicHandler chapter regression guard', () => {
  let handler: Awaited<ReturnType<typeof buildHandler>>;

  beforeEach(async () => {
    handler = await buildHandler();
  });

  it('refuses to rewind to chapter 0 when a stale position read arrives', () => {
    const store: Record<string, unknown> = { chapters: CHAPTERS, chapterToken: 1 };
    const player = makePlayer(store);

    // A real seek to chapter 8 commits the index and records the position.
    handler.swapChapterOnSeek(player, 1_310_000);
    expect(store.chapterIdx).toBe(8);
    expect(store.chapterCommittedPosMs).toBe(1_310_000);

    // Now a stale reader hands back position 0 — the rewound card, instant.
    const card = handler.chapterCardFor(player, 0);

    expect(store.chapterIdx).toBe(8);
    expect(card?.title).toBe('I Like Her');
  });

  it('still allows a genuine backward seek through (seek intent explains it)', () => {
    const store: Record<string, unknown> = { chapters: CHAPTERS, chapterToken: 1 };
    const player = makePlayer(store);

    handler.swapChapterOnSeek(player, 1_310_000);
    // musicService.seek() records this BEFORE awaiting the node.
    store.lastUserSeekAt = Date.now();
    store.lastUserSeekPos = 70_000;

    const card = handler.chapterCardFor(player, 70_000);

    expect(store.chapterIdx).toBe(1);
    expect(card?.title).toBe('Shining');
  });

  it('ignores a stale seek intent once it has gone stale', () => {
    const store: Record<string, unknown> = { chapters: CHAPTERS, chapterToken: 1 };
    const player = makePlayer(store);

    handler.swapChapterOnSeek(player, 1_310_000);
    // An intent from long ago no longer authorises a rewind.
    store.lastUserSeekAt = Date.now() - USER_SEEK_INTENT_WINDOW_MS - 1000;
    store.lastUserSeekPos = 70_000;

    handler.chapterCardFor(player, 0);

    expect(store.chapterIdx).toBe(8);
  });

  it('tolerates small backward jitter from a different reader', () => {
    const store: Record<string, unknown> = { chapters: CHAPTERS, chapterToken: 1 };
    const player = makePlayer(store);

    handler.swapChapterOnSeek(player, 1_310_000);
    // Well inside the tolerance: must NOT be treated as a regression.
    handler.chapterCardFor(player, 1_310_000 - CHAPTER_REGRESSION_TOLERANCE_MS + 250);

    expect(store.chapterIdx).toBe(8);
  });

  it('does not rewind on the very first derivation (no committed position yet)', () => {
    const store: Record<string, unknown> = { chapters: CHAPTERS, chapterToken: 1 };
    const player = makePlayer(store);

    const card = handler.chapterCardFor(player, 0);

    expect(store.chapterIdx).toBe(0);
    expect(card?.title).toBe('ARTE Concert Festival');
  });
});
