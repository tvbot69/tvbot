import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicSearchLadder, type LadderResult } from '@bot/services/music/musicSearchLadder';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { SpotifyResolvedTrack, SpotifyResolver } from '@bot/services/music/spotifyResolver';
import type { Player, Track } from 'moonlink.js';
import { HOME_NODE } from '@bot/services/music/youtubeHealth';

/**
 * The provider search ladder, tested directly.
 *
 * The ladder's job is not "find a track" — it is to keep three answers apart:
 * a HIT, a genuine MISS, and a TRANSPORT FAILURE. Every caller turns those into
 * three different sentences, and collapsing the last two is how a tower-uplink
 * stall ends up rendered as "No tracks found for: <url>". So each test here
 * asserts WHICH of the three came back, not merely that a track came back.
 *
 * The second job is refusing the wrong song. The duration gates (plugin ±45s,
 * ISRC ±60s, resolver ±30s) exist because a ytsearch top hit can be a
 * three-hour compilation or a live cut wearing the requested name.
 *
 * Timing note: every stall case here is driven with FAKE timers. The production
 * bounds are 8s per search and 4 cross-node attempts, so a real-clock stall test
 * costs over a minute of wall clock per assertion — and a fake-timer version
 * proves the same thing, because the bound IS a `setTimeout`.
 */

const { resolverEnabledFlag, resolveViaHome, MockTrack } = vi.hoisted(() => {
  class HashedMockTrack {
    public identifier = '';
    public title = '';
    public author = '';
    public uri = '';
    public artworkUrl: string | null = null;
    public duration = 0;
    public encoded = '';
    public requester: unknown;
    public constructor(data: Record<string, unknown>, requester?: unknown) {
      this.identifier = String(data.identifier ?? '');
      this.title = String(data.title ?? '');
      this.author = String(data.author ?? '');
      this.uri = String(data.uri ?? '');
      this.artworkUrl = (data.artworkUrl as string | undefined) ?? null;
      this.duration = Number(data.duration ?? 0);
      this.encoded = String(data.encoded ?? '');
      this.requester = requester;
    }
  }
  return {
    resolverEnabledFlag: { value: false },
    resolveViaHome: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
    MockTrack: HashedMockTrack,
  };
});

vi.mock('../ytResolver', () => ({
  resolverEnabled: () => resolverEnabledFlag.value,
  resolveViaHome,
}));

vi.mock('moonlink.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, Track: MockTrack };
});

const YT_THUMB = 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg';
const COVER = 'https://is1-ssl.mzstatic.com/image/thumb/cover600x600bb.jpg';

const ytHit = (over: Record<string, unknown> = {}): Track =>
  ({
    identifier: 'abc123def45',
    title: 'Zaid Khaled - Lame (Official Music Video)',
    author: 'Zaid Khaled',
    uri: 'https://www.youtube.com/watch?v=abc123def45',
    duration: 213_000,
    artworkUrl: YT_THUMB,
    ...over,
  }) as unknown as Track;

type SearchArgs = { query: string; source: string; node?: string };

/**
 * What a node search double may answer with: the manager's `search` is typed
 * `Promise<unknown>` and the ladder casts the result, so the rows only have to
 * carry a `tracks` array. A function answers per rung instead — that is how a
 * test tells the ISRC probe from the title search, or YouTube from SoundCloud.
 */
type SearchAnswer = { tracks?: unknown[] } | ((args: SearchArgs) => unknown);

const loadTracksOf = (impl: () => unknown): { loadTracks: ReturnType<typeof vi.fn> } => ({
  loadTracks: vi.fn(async (..._a: unknown[]) => impl()),
});

const player = (nodeId: string, over: Record<string, unknown> = {}): Player =>
  ({
    guildId: 'g-1',
    node: { identifier: nodeId, rest: loadTracksOf(() => ({ loadType: 'track', data: { encoded: 'enc' } })) },
    ...over,
  }) as unknown as Player;

/** A non-Home node with the resolver off: the rungs are plugin -> soundcloud. */
const PUBLIC = 'public-node-1';

type Built = {
  ladder: MusicSearchLadder;
  search: ReturnType<typeof vi.fn>;
  pickSearchNode: ReturnType<typeof vi.fn>;
  noteRestFailure: ReturnType<typeof vi.fn>;
  spotify: { searchTracks: ReturnType<typeof vi.fn> };
};

const build = (
  opts: {
    /** A fixed response, or a thunk receiving the search args. */
    search?: SearchAnswer;
    failover?: boolean;
    nodes?: string[];
    /** The rows `SpotifyResolver.searchTracks` resolves to. */
    spotifySearchTracks?: SpotifyResolvedTrack[];
  } = {},
): Built => {
  const search = vi.fn(async (...args: unknown[]): Promise<unknown> => {
    const a = (args[0] ?? {}) as SearchArgs;
    if (typeof opts.search === 'function') return opts.search(a);
    return opts.search ?? { tracks: [ytHit()] };
  });
  const pickSearchNode = vi.fn((excluded: string[]): { identifier: string } | null => {
    const free = (opts.nodes ?? ['node-a']).filter((n) => !excluded.includes(n));
    return free[0] ? { identifier: free[0] } : null;
  });
  const noteRestFailure = vi.fn();
  const manager: Record<string, unknown> = { getManager: () => ({ search }) };
  if (opts.failover !== false) {
    manager.pickSearchNode = pickSearchNode;
    manager.noteRestFailure = noteRestFailure;
  }
    const searchTracks = vi.fn(
    async (..._a: unknown[]): Promise<SpotifyResolvedTrack[]> => opts.spotifySearchTracks ?? [],
  );
  const ladder = new MusicSearchLadder(
    manager as unknown as MoonlinkManager,
    { searchTracks } as unknown as SpotifyResolver,
  );
  return { ladder, search, pickSearchNode, noteRestFailure, spotify: { searchTracks } };
};

/** Run `promise` while the clock is under our control, then hand the clock back. */
const withFakeClock = async <T>(run: () => Promise<T>, ms: number): Promise<T> => {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(ms);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
};

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ['HOME_RESOLVER_URL', 'HOME_RESOLVER_TOKEN', 'HOME_PLUGIN_RUNG', 'HOME_LADDER_MODE']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resolverEnabledFlag.value = false;
  resolveViaHome.mockResolvedValue(null);
  vi.clearAllMocks();
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the pure statics', () => {
  it('normalizeIsrc strips dashes and uppercases, or refuses a malformed code', () => {
    expect(MusicSearchLadder.normalizeIsrc('us-rc1-12-34567')).toBe('USRC11234567');
    expect(MusicSearchLadder.normalizeIsrc('GBAYE0601498')).toBe('GBAYE0601498');
    // A malformed code only returns junk, so it is never searched at all.
    expect(MusicSearchLadder.normalizeIsrc('')).toBeNull();
    expect(MusicSearchLadder.normalizeIsrc(undefined)).toBeNull();
    expect(MusicSearchLadder.normalizeIsrc('not-an-isrc')).toBeNull();
    expect(MusicSearchLadder.normalizeIsrc('US-RC1-12-3456')).toBeNull();
  });

  it('isTransportError separates the third answer from both others', () => {
    expect(MusicSearchLadder.isTransportError({ transportError: true })).toBe(true);
    expect(MusicSearchLadder.isTransportError(null)).toBe(false);
    expect(MusicSearchLadder.isTransportError({ track: ytHit(), rung: 'plugin' })).toBe(false);
  });
});

describe('searchWithTimeout — cross-node retry', () => {
  it('an immediate answer is returned without touching another node', async () => {
    const { ladder, search, noteRestFailure, pickSearchNode } = build();
    const res = await ladder.searchWithTimeout({ query: 'q', source: 'youtube' });
    // The VALUE, not just "an array came back": a caller reads `tracks[0]` and
    // plays it, so an empty or wrong-shaped array would pass a count-only check
    // and render "No tracks found" for a track that was right there.
    expect(res?.tracks).toHaveLength(1);
    expect(res?.tracks?.[0]).toMatchObject({
      identifier: 'abc123def45',
      title: 'Zaid Khaled - Lame (Official Music Video)',
      duration: 213_000,
    });
    expect(search).toHaveBeenCalledTimes(1);
    // The pinned node and the verbatim query are the contract with `Moonlink`;
    // a rewritten query or a dropped `source` searches the wrong catalogue.
    expect(search).toHaveBeenCalledWith({ query: 'q', source: 'youtube', node: 'node-a' });
    expect(noteRestFailure).not.toHaveBeenCalled();
    expect(pickSearchNode).toHaveBeenCalledTimes(1);
    // First attempt excludes nothing: the node list is only narrowed once one
    // has actually failed.
    expect(pickSearchNode).toHaveBeenCalledWith([]);
  });

  it('a node that THROWS cools the node and the same command retries elsewhere', async () => {
    // A throw is one of the two observed failure shapes (the other is a
    // timeout-null); one observed failure already cost ~4 REST attempts, so it
    // must cool immediately rather than after a second try on the same node.
    const { ladder, noteRestFailure, pickSearchNode, search } = build({
      search: () => Promise.reject(new Error('rest dead')),
      nodes: ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'],
    });
    await expect(ladder.searchWithTimeout({ query: 'q', source: 'youtube' }, 20)).resolves.toBeNull();
    expect(noteRestFailure).toHaveBeenCalledWith('node-a');
    expect(noteRestFailure).toHaveBeenCalledWith('node-b');
    expect(noteRestFailure).toHaveBeenCalledWith('node-c');
    expect(noteRestFailure).toHaveBeenCalledWith('node-d');
    // Four attempts, then give up rather than looping forever.
    expect(search).toHaveBeenCalledTimes(4);
    expect(search).toHaveBeenNthCalledWith(1, { query: 'q', source: 'youtube', node: 'node-a' });
    expect(search).toHaveBeenNthCalledWith(2, { query: 'q', source: 'youtube', node: 'node-b' });
    expect(search).toHaveBeenNthCalledWith(3, { query: 'q', source: 'youtube', node: 'node-c' });
    expect(search).toHaveBeenNthCalledWith(4, { query: 'q', source: 'youtube', node: 'node-d' });
    // The exclusion list grows by exactly the node just failed: the 4th pick
    // excludes a, b and c — node-d was the attempt that ran, not an exclusion.
    expect(pickSearchNode).toHaveBeenCalledTimes(4);
    expect(pickSearchNode).toHaveBeenLastCalledWith(['node-a', 'node-b', 'node-c']);
  });

  it('a node that never answers is cooled too, not merely waited on', async () => {
    const { ladder, noteRestFailure, pickSearchNode } = build({
      search: () => new Promise(() => undefined),
      nodes: ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'],
    });
    const res = await withFakeClock(() => ladder.searchWithTimeout({ query: 'q', source: 'youtube' }, 20), 5_000);
    // The honest answer for "every node never answered": null. `{}` or
    // `{tracks: []}` here would be reported as "we looked and there was
    // nothing", which is the exact lie the timeout path exists to prevent.
    expect(res).toBeNull();
    expect(noteRestFailure).toHaveBeenCalledTimes(4);
    expect(pickSearchNode).toHaveBeenCalledTimes(4);
  });

  it('a node returning nothing STOPS the search: an answered empty is an answer', async () => {
    const { ladder, search, noteRestFailure, pickSearchNode } = build({ search: { tracks: [] }, nodes: ['node-a', 'node-b'] });
    const res = await ladder.searchWithTimeout({ query: 'q', source: 'youtube' });
    expect(res).toEqual({ tracks: [] });
    // The answered-empty is returned VERBATIM, not coerced into a null: a null
    // is the transport-failure answer and callers word the two differently.
    expect(res?.tracks).toEqual([]);
    expect(search).toHaveBeenCalledWith({ query: 'q', source: 'youtube', node: 'node-a' });
    // Cooling a node for saying "no results" would blacklist every node that
    // legitimately has nothing.
    expect(noteRestFailure).not.toHaveBeenCalled();
    expect(pickSearchNode).toHaveBeenCalledTimes(1);
  });

  it('the second node answering ends the loop, and the first is remembered as tried', async () => {
    let n = 0;
    const { ladder, pickSearchNode, noteRestFailure } = build({
      search: () => {
        n++;
        if (n === 1) throw new Error('rest dead');
        return { tracks: [ytHit({ identifier: 'goodnode001' })] };
      },
      nodes: ['node-a', 'node-b'],
    });
    const res = (await ladder.searchWithTimeout({ query: 'q', source: 'youtube' }, 20)) as { tracks: Track[] };
    expect(res.tracks[0]!.identifier).toBe('goodnode001');
    expect(pickSearchNode).toHaveBeenLastCalledWith(['node-a']);
    expect(noteRestFailure).toHaveBeenCalledTimes(1);
  });

  it('no candidate node at all is a null answer, never a throw', async () => {
    const { ladder, search } = build({ nodes: [] });
    await expect(ladder.searchWithTimeout({ query: 'q', source: 'youtube' }, 20)).resolves.toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it('a manager without the failover methods takes the legacy single attempt', async () => {
    // Older doubles (and any caller injecting a partial manager) must still
    // search rather than crash on a missing method.
    const { ladder, search } = build({ failover: false, search: () => Promise.reject(new Error('rest dead')) });
    await expect(ladder.searchWithTimeout({ query: 'q', source: 'youtube' }, 20)).rejects.toThrow(/rest dead/);
    expect(search).toHaveBeenCalledTimes(1);
    // The legacy path pins no node at all — it hands Moonlink its own choice,
    // so the args must NOT grow a `node` key it would never have produced.
    expect(search).toHaveBeenCalledWith({ query: 'q', source: 'youtube' });
  });
});

describe('pluginHitMatchesProvider — refusing the wrong song', () => {
  const { ladder } = build();

  it('no provider duration means no evidence, so the hit passes', () => {
    expect(ladder.pluginHitMatchesProvider(ytHit(), undefined)).toBe(true);
    expect(ladder.pluginHitMatchesProvider(ytHit(), { title: 'Lame', artist: 'Zaid' })).toBe(true);
  });

  it('a hit with no duration is not evidence either', () => {
    expect(
      ladder.pluginHitMatchesProvider(ytHit({ duration: 0 }), { title: 'Lame', artist: 'Z', durationMs: 213_000 }),
    ).toBe(true);
  });

  it('a small difference is provider-vs-mirror rounding and passes', () => {
    expect(
      ladder.pluginHitMatchesProvider(ytHit({ duration: 213_000 }), { title: 'Lame', artist: 'Z', durationMs: 200_000 }),
    ).toBe(true);
    // The boundary itself: 45s is inside the gate.
    expect(
      ladder.pluginHitMatchesProvider(
        ytHit({ duration: 213_000 }),
        { title: 'Lame', artist: 'Z', durationMs: 258_000 },
      ),
    ).toBe(true);
  });

  it('a large difference is refused — a compilation wearing the requested name', () => {
    expect(
      ladder.pluginHitMatchesProvider(ytHit({ duration: 12_960_000 }), { title: 'Lame', artist: 'Z', durationMs: 213_000 }),
    ).toBe(false);
  });
});

describe('searchTrackWithLadderOnce — hit, miss, or transport failure', () => {
  it('a plugin hit is returned on the plugin rung', async () => {
    const { ladder } = build();
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'Zaid Khaled Lame')) as { track: Track; rung: string };
    expect(res.rung).toBe('plugin');
    expect(res.track.identifier).toBe('abc123def45');
  });

  it('a plugin hit whose length is nothing like the provider is SKIPPED for SoundCloud', async () => {
    const { ladder } = build({
      search: (a) =>
        a.source === 'youtube'
          ? { tracks: [ytHit({ duration: 12_960_000, title: 'Album (Full Album)' })] }
          : { tracks: [ytHit({ identifier: 'sctrack0001', duration: 213_000 })] },
    });
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'Zaid Khaled Lame', {
      title: 'Lame',
      artist: 'Zaid Khaled',
      durationMs: 213_000,
    })) as { track: Track; rung: string };
    expect(res.rung).toBe('soundcloud');
    expect(res.track.identifier).toBe('sctrack0001');
  });

  it('an answered miss is null, NOT a transport error', async () => {
    // The distinction this whole module exists for: "we looked and there was
    // nothing" and "we could not look" must never share an answer.
    const { ladder } = build({ search: { tracks: [] } });
    await expect(ladder.searchTrackWithLadderOnce(player(PUBLIC), 'nothing here')).resolves.toBeNull();
  });

  it('a node that never answers IS a transport error', async () => {
    const { ladder } = build({ search: () => new Promise(() => undefined), nodes: ['a', 'b', 'c', 'd'] });
    const res = await withFakeClock(
      () => ladder.searchTrackWithLadderOnce(player(PUBLIC), 'q', undefined),
      // 8s x 4 attempts for the plugin rung, then the same again for soundcloud.
      120_000,
    );
    expect(MusicSearchLadder.isTransportError(res as LadderResult)).toBe(true);
  });

  it('a SoundCloud-only answer is reported on the soundcloud rung', async () => {
    const { ladder } = build({
      search: (a) => (a.source === 'youtube' ? { tracks: [] } : { tracks: [ytHit({ identifier: 'sctrack0001' })] }),
    });
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'q')) as { track: Track; rung: string };
    expect(res.rung).toBe('soundcloud');
  });

  it('pre-cleans the hit: a YouTube thumbnail is dropped so the cascade can fill real art', async () => {
    const { ladder } = build();
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'q')) as { track: Track };
    // Left in place it looks like resolved art, and every downstream check
    // ("does it have artwork?") skips — the card holds a video frame forever.
    expect(res.track.artworkUrl).toBeNull();
  });

  it('stamps a KNOWN-GOOD cover onto the hit instead of dropping it', async () => {
    const { ladder } = build();
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'q', { artworkUrl: COVER })) as { track: Track };
    expect(res.track.artworkUrl).toBe(COVER);
  });

  it('stashes the raw upload title and the 11-char id before anything overwrites them', async () => {
    const { ladder } = build();
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'q')) as { track: Track };
    const rec = res.track as unknown as Record<string, unknown>;
    expect(rec._rawVideoTitle).toBe('Zaid Khaled - Lame (Official Music Video)');
    expect(rec._sourceVideoId).toBe('abc123def45');
  });

  it('a non-11-char identifier is not stashed as a video id', async () => {
    const { ladder } = build({ search: { tracks: [ytHit({ identifier: 'not-a-video-id' })] } });
    const res = (await ladder.searchTrackWithLadderOnce(player(PUBLIC), 'q')) as { track: Track };
    expect((res.track as unknown as Record<string, unknown>)._sourceVideoId).toBeUndefined();
  });
});

describe('searchTrackWithLadder — the ISRC rung', () => {
  it('an ISRC hit REPLACES the fuzzy title search entirely', async () => {
    const { ladder, search } = build({
      search: (a) => (a.query.includes('"') ? { tracks: [ytHit({ identifier: 'isrchit0001' })] } : { tracks: [ytHit({ identifier: 'fuzzyhit001' })] }),
    });
    const res = (await ladder.searchTrackWithLadder(player(PUBLIC), 'ZAF, Omar Taa\'i - cashwekaas', {
      title: 'cashwekaas',
      artist: "ZAF, Omar Taa'i",
      isrc: 'GBAYE0601498',
    })) as { track: Track };
    expect(res.track.identifier).toBe('isrchit0001');
    // One probe, not two: the exact-recording hit is the whole point.
    expect(search).toHaveBeenCalledTimes(1);
    // The probe is the QUOTED, normalized ISRC — a bare title query here would
    // mean the rung silently stopped being ISRC-first while still counting once.
    expect(search).toHaveBeenCalledWith({ query: '"GBAYE0601498"', source: 'youtube', node: 'node-a' });
  });

  it('an ISRC hit whose length is nothing like the provider is refused for the title search', async () => {
    const { ladder, search } = build({
      search: (a) =>
        a.query.includes('"')
          ? { tracks: [ytHit({ identifier: 'isrchit0001', duration: 900_000 })] }
          : { tracks: [ytHit({ identifier: 'fuzzyhit001' })] },
    });
    const res = (await ladder.searchTrackWithLadder(player(PUBLIC), 'q', {
      title: 'Lame',
      artist: 'Zaid',
      isrc: 'GBAYE0601498',
      durationMs: 213_000,
    })) as { track: Track };
    expect(res.track.identifier).toBe('fuzzyhit001');
    expect(search).toHaveBeenCalledTimes(2);
    // Order and content: the refused probe first, then the plain title search
    // that produced the track actually played.
    expect(search).toHaveBeenNthCalledWith(1, { query: '"GBAYE0601498"', source: 'youtube', node: 'node-a' });
    expect(search).toHaveBeenNthCalledWith(2, { query: 'q', source: 'youtube', node: 'node-a' });
  });

  it('an ISRC rung that throws is a rung failing, not a track not existing', async () => {
    // `failover: false` so the throw reaches the rung's own catch rather than
    // being absorbed by the cross-node retry loop.
    const { ladder, search } = build({
      failover: false,
      search: (a) => (a.query.includes('"') ? Promise.reject(new Error('isrc probe dead')) : { tracks: [ytHit({ identifier: 'fuzzyhit001' })] }),
    });
    const res = (await ladder.searchTrackWithLadder(player(PUBLIC), 'q', {
      title: 'Lame',
      artist: 'Zaid',
      isrc: 'GBAYE0601498',
    })) as { track: Track };
    expect(res.track.identifier).toBe('fuzzyhit001');
    // The dead rung was the ISRC probe, so the surviving call is the title
    // search — a rung that failed must not take the whole ladder with it.
    expect(search).toHaveBeenNthCalledWith(1, { query: '"GBAYE0601498"', source: 'youtube' });
    expect(search).toHaveBeenNthCalledWith(2, { query: 'q', source: 'youtube' });
  });

  it('a malformed ISRC is not searched at all', async () => {
    const { ladder, search } = build();
    const res = await ladder.searchTrackWithLadder(player(PUBLIC), 'q', { title: 'Lame', artist: 'Z', isrc: 'nonsense' });
    // A junk code only returns junk; probing it burns a full search budget.
    expect(search).toHaveBeenCalledTimes(1);
    // The single call is the TITLE search — no quoted probe was built at all.
    expect(search).toHaveBeenCalledWith({ query: 'q', source: 'youtube', node: 'node-a' });
    expect(search.mock.calls[0]?.[0] as SearchArgs).not.toMatchObject({ query: expect.stringContaining('"') });
    // The ladder still answers the ORIGINAL question rather than swallowing it.
    expect((res as { track: Track } | null)?.track.identifier).toBe('abc123def45');
  });
});

describe('searchTrackWithLadder — the lead-artist retry', () => {
  it('a multi-artist query that misses every rung is retried with the lead artist alone', async () => {
    // Spotify's multi-artist billing poisons YouTube search into a genuine
    // empty while the video demonstrably exists. Answering here requires the
    // ORIGINAL two-artist string to miss on BOTH rungs.
    const { ladder, search } = build({
      search: (a) =>
        a.query === 'ZAF - cashwekaas' ? { tracks: [ytHit({ identifier: 'leadhit0001' })] } : { tracks: [] },
    });
    const res = (await ladder.searchTrackWithLadder(player(PUBLIC), "ZAF, Omar Taa'i - cashwekaas", {
      title: 'cashwekaas',
      artist: "ZAF, Omar Taa'i",
    })) as { track: Track };
    expect(res.track.identifier).toBe('leadhit0001');
    // Pass 1 spends two searches (plugin, soundcloud); pass 2 hits on plugin.
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls[2]?.[0] as SearchArgs).toMatchObject({ query: 'ZAF - cashwekaas' });
    // …and pass 1 really did ask with the ORIGINAL poisoned two-artist string
    // on both rungs. A ladder that "helpfully" normalised the first query would
    // pass the count above while skipping the case this exists for.
    expect(search.mock.calls[0]?.[0] as SearchArgs).toMatchObject({ query: "ZAF, Omar Taa'i - cashwekaas" });
    expect(search.mock.calls[1]?.[0] as SearchArgs).toMatchObject({ query: "ZAF, Omar Taa'i - cashwekaas" });
  });

  it('a single-artist query is NOT retried, because there is no distinct fallback', async () => {
    const { ladder, search } = build({ search: { tracks: [] } });
    await expect(
      ladder.searchTrackWithLadder(player(PUBLIC), 'ZAF - cashwekaas', { title: 'cashwekaas', artist: 'ZAF' }),
    ).resolves.toBeNull();
    // Exactly one pass: plugin rung plus soundcloud rung, and no third call.
    // A retry with the identical query costs a full ladder pass for nothing.
    expect(search).toHaveBeenCalledTimes(2);
    // Both rungs asked with the query verbatim, and the honest answer for
    // "both rungs answered with nothing" is null — never a transport error.
    expect(search).toHaveBeenNthCalledWith(1, { query: 'ZAF - cashwekaas', source: 'youtube', node: 'node-a' });
    expect(search).toHaveBeenNthCalledWith(2, { query: 'ZAF - cashwekaas', source: 'soundcloud', node: 'node-a' });
  });
});

describe('tryResolverTrack — the local resolver rung', () => {
  const onHome = (loadTracks: () => unknown): Player =>
    player(HOME_NODE, { node: { identifier: HOME_NODE, rest: loadTracksOf(loadTracks) } });

  it('is skipped entirely off the Home node, without calling the resolver', async () => {
    const { ladder } = build();
    await expect(ladder.tryResolverTrack(player(PUBLIC), ytHit())).resolves.toBeNull();
    expect(resolveViaHome).not.toHaveBeenCalled();
  });

  it('is skipped when the Home node is REST-dead, rather than burning a doomed loadTracks', async () => {
    const cooling = {
      getManager: () => ({ search: vi.fn() }),
      isNodeCoolingDown: (id: string) => id === HOME_NODE,
    } as unknown as MoonlinkManager;
    const ladder = new MusicSearchLadder(cooling, {} as unknown as SpotifyResolver);
    await expect(ladder.tryResolverTrack(onHome(() => ({ loadType: 'track', data: { encoded: 'e' } })), ytHit())).resolves.toBeNull();
    expect(resolveViaHome).not.toHaveBeenCalled();
  });

  it('is skipped for an identifier that is not a YouTube id', async () => {
    const { ladder } = build();
    await expect(ladder.tryResolverTrack(onHome(() => ({ loadType: 'track', data: { encoded: 'e' } })), ytHit({ identifier: 'not-a-video-id' }))).resolves.toBeNull();
    expect(resolveViaHome).not.toHaveBeenCalled();
  });

  it('is skipped when the resolver has no file for the id', async () => {
    const { ladder } = build();
    resolveViaHome.mockResolvedValue(null);
    await expect(ladder.tryResolverTrack(onHome(() => ({ loadType: 'track', data: { encoded: 'e' } })), ytHit())).resolves.toBeNull();
  });

  it('a loadTracks that rejects cools the node so the ladder falls through to the next rung', async () => {
    const { ladder, noteRestFailure } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\abc123def45.webm');
    const p = onHome(() => {
      throw new Error('rest dead');
    });
    await expect(ladder.tryResolverTrack(p, ytHit())).resolves.toBeNull();
    expect(noteRestFailure).toHaveBeenCalledWith(HOME_NODE);
  });

  it('a loadTracks that never settles is BOUNDED, so the per-guild top-up guard cannot freeze', async () => {
    // The comment in production says it: an unsettled await here means
    // `pendingTopUpRunning` is never released and that guild's whole pending
    // queue is frozen forever, silently. LOAD_TRACKS_TIMEOUT_MS is 8s.
    const { ladder, noteRestFailure } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\abc123def45.webm');
    const p = onHome(() => new Promise(() => undefined));
    const res = await withFakeClock(() => ladder.tryResolverTrack(p, ytHit()), 20_000);
    expect(res).toBeNull();
    expect(noteRestFailure).toHaveBeenCalledWith(HOME_NODE);
  });

  it('a playlist response is not a track and is refused', async () => {
    const { ladder } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\x.webm');
    const p = onHome(() => ({ loadType: 'playlist', data: { encoded: 'e' } }));
    await expect(ladder.tryResolverTrack(p, ytHit())).resolves.toBeNull();
  });

  it('a track response with no encoded data is refused', async () => {
    const { ladder } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\x.webm');
    const p = onHome(() => ({ loadType: 'track', data: {} }));
    await expect(ladder.tryResolverTrack(p, ytHit())).resolves.toBeNull();
  });

  it('a good file becomes a track, and the source video thumbnail is DROPPED', async () => {
    // Left stamped it looks like resolved art, and the backfill cascade skips
    // any track that already has artwork — the whole set would show a frame.
    const { ladder } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\x.webm');
    const p = onHome(() => ({
      loadType: 'track',
      data: { encoded: 'enc', title: 'Lame.webm', duration: 213_000, artworkUrl: YT_THUMB },
    }));
    const res = await ladder.tryResolverTrack(p, ytHit());
    expect(res).not.toBeNull();
    expect(res!.artworkUrl).toBeNull();
  });

  it('the local file carries the source video id and raw title, which it does not have itself', async () => {
    const { ladder } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\x.webm');
    const p = onHome(() => ({ loadType: 'track', data: { encoded: 'enc', duration: 213_000 } }));
    const res = await ladder.tryResolverTrack(p, ytHit());
    const rec = res as unknown as Record<string, unknown>;
    expect(rec._sourceVideoId).toBe('abc123def45');
    expect(rec._rawVideoTitle).toBe('Zaid Khaled - Lame (Official Music Video)');
  });

  it('a local file whose probed length contradicts the hit is refused as the wrong song', async () => {
    const { ladder } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\x.webm');
    const p = onHome(() => ({ loadType: 'track', data: { encoded: 'enc', duration: 60_000 } }));
    await expect(ladder.tryResolverTrack(p, ytHit({ duration: 213_000 }))).resolves.toBeNull();
  });

  it('a missing duration on either side is not evidence of a mismatch', async () => {
    const { ladder } = build();
    resolveViaHome.mockResolvedValue('yt-cache\\x.webm');
    const p = onHome(() => ({ loadType: 'track', data: { encoded: 'enc' } }));
    await expect(ladder.tryResolverTrack(p, ytHit())).resolves.not.toBeNull();
  });
});

describe('searchTracks — the +search picker', () => {
  const row = (i: number) => ({
    identifier: `row${i}`,
    title: `Upload ${i}`,
    author: 'Some Channel',
    uri: `https://www.youtube.com/watch?v=row${i}`,
    duration: 200_000 + i,
  });

  it('a blank query returns an empty list without touching any provider', async () => {
    const { ladder, search, spotify } = build();
    await expect(ladder.searchTracks('   ')).resolves.toEqual([]);
    expect(spotify.searchTracks).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('Spotify-first returns clean names, artists and covers with no Lavalink call', async () => {
    const { ladder, search } = build({
      spotifySearchTracks: [
        {
          name: 'Lame',
          artist: 'Zaid Khaled',
          searchQuery: 'zaid khaled lame',
          spotifyUri: 'spotify:track:abc',
          artworkUrl: COVER,
          durationMs: 213_000,
        },
      ],
    });
    const res = await ladder.searchTracks('zaid khaled lame');
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ title: 'Lame', author: 'Zaid Khaled', source: 'spotify', artworkUrl: COVER });
    // The row's `uri` runs the mirror `spotifyUri` through `spotifyUriToUrl`
    // first, like every other site that turns one into a `uri`
    // (musicTrackAdoption.ts:46, musicService.ts:915,
    // playlistChunkManager.ts:367/397). It used to be stamped VERBATIM, so this
    // one row carried a bare `spotify:track:` id — which Discord does not
    // hyperlink, so it renders as dead text on the pick. Not reachable in
    // production today (both picker call sites pass `spotifyFirst: false`),
    // which is exactly why it was a trap for the first caller that did.
    expect(res[0]!.uri).toBe('https://open.spotify.com/track/abc');
    expect(search).not.toHaveBeenCalled();
  });

  it('a Spotify row with no URI falls back to "artist - title" so the pick is still playable', async () => {
    const { ladder } = build({
      spotifySearchTracks: [{ name: 'Lame', artist: 'Zaid Khaled', searchQuery: 'zaid khaled lame', durationMs: 213_000 }],
    });
    const res = await ladder.searchTracks('zaid khaled lame');
    expect(res[0]!.uri).toBe('Zaid Khaled - Lame');
  });

  it('a URL query skips Spotify entirely, because a link is not a search term', async () => {
    const { ladder, spotify, search } = build({
      spotifySearchTracks: [{ name: 'wrong', artist: 'wrong', searchQuery: 'x', durationMs: 213_000 }],
    });
    const res = await ladder.searchTracks('https://www.youtube.com/watch?v=abc123def45');
    expect(spotify.searchTracks).not.toHaveBeenCalled();
    expect(res[0]!.title).toMatch(/Lame/);
    expect(search).toHaveBeenCalledTimes(1);
    // The link is handed to Lavalink VERBATIM. A rewritten query would search
    // YouTube for the words in a URL and render a confident wrong song.
    expect(search).toHaveBeenCalledWith({
      query: 'https://www.youtube.com/watch?v=abc123def45',
      source: 'youtube',
      node: 'node-a',
    });
  });

  it('a Spotify search that fails falls back to Lavalink rather than showing nothing', async () => {
    const { ladder, spotify } = build();
    spotify.searchTracks.mockRejectedValue(new Error('spotify 429'));
    const res = await ladder.searchTracks('zaid khaled lame');
    expect(res).toHaveLength(1);
    // The rows are the LAVALINK ones, mapped — not the empty list Spotify
    // returned and not an exception. Names come through cleaned.
    expect(res[0]).toMatchObject({
      identifier: 'abc123def45',
      title: 'Lame',
      author: 'Zaid Khaled',
      source: 'youtube',
      uri: 'https://www.youtube.com/watch?v=abc123def45',
    });
  });

  it('pure-YouTube mode asks Lavalink, and its one Spotify upgrade pass leaves unmatched rows raw', async () => {
    const { ladder, search, spotify } = build({ search: { tracks: [row(0), row(1)] } });
    const res = await ladder.searchTracks('some song', 'youtube', false);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ query: 'some song', source: 'youtube', node: 'node-a' });
    // "pure YouTube" means the picker does not LEAD with Spotify; it does not
    // mean Spotify is never asked. `upgradePickerResults`
    // (musicSearchLadder.ts:427-429, 439) always runs ONE batched lookup in
    // pure-YouTube mode, because the upgraded metadata rides the
    // select-override into play() where it is TRUSTED art. With no candidate
    // the rows stay exactly as raw as Lavalink returned them — see the next two
    // tests for the upgrading half.
    expect(spotify.searchTracks).toHaveBeenCalledWith('some song', 10);
    expect(res.map((t) => t.title)).toEqual(['Upload 0', 'Upload 1']);
    // `mapMoonlinkTrack` carries a missing cover through as absent, not as an
    // empty string, and the unmatched upgrade pass stamps nothing over it.
    expect(res.map((t) => t.artworkUrl)).toEqual([undefined, undefined]);
  });

  it('no Lavalink answer is an empty list, not a throw', async () => {
    const { ladder } = build({ search: { tracks: [] } });
    await expect(ladder.searchTracks('nothing', 'youtube', false)).resolves.toEqual([]);
  });

  it('a node that never answers is an empty list, bounded rather than hanging the menu', async () => {
    const { ladder } = build({ search: () => new Promise(() => undefined), nodes: ['a', 'b', 'c', 'd'] });
    const res = await withFakeClock(() => ladder.searchTracks('slow', 'youtube', false), 60_000);
    expect(res).toEqual([]);
  });

  it('caps the picker at ten rows', async () => {
    const { ladder } = build({ search: { tracks: Array.from({ length: 25 }, (_, i) => row(i)) } });
    await expect(ladder.searchTracks('many', 'youtube', false)).resolves.toHaveLength(10);
  });

  it('pure-YouTube mode upgrades each row to a validated Spotify identity', async () => {
    const { ladder, spotify } = build({
      search: { tracks: [row(0)] },
      spotifySearchTracks: [
        // The candidate artist deliberately differs from the upload channel:
        // `isSpotifyMatchValid` gates on TITLE + duration, not on the artist, so
        // this row is a valid match and the upgrade must overwrite the channel
        // name. Asserting the artist therefore proves the upgrade WROTE, rather
        // than passing on the raw value that happened to already be there.
        { name: 'Upload 0', artist: 'Actual Band', searchQuery: 'some song', artworkUrl: COVER, durationMs: 200_000 },
        { name: 'Something Else', artist: 'Other', searchQuery: 'some song', durationMs: 200_000 },
      ],
    });
    const res = await ladder.searchTracks('some song', 'youtube', false);
    // The upgraded metadata rides the select-override into play(), where it is
    // TRUSTED — so a video frame here would be painted on the card for good.
    expect(spotify.searchTracks).toHaveBeenCalledTimes(1);
    expect(spotify.searchTracks).toHaveBeenCalledWith('some song', 10);
    expect(res[0]!.artworkUrl).toBe(COVER);
    expect(res[0]).toMatchObject({
      identifier: 'row0',
      title: 'Upload 0',
      author: 'Actual Band',
      uri: 'https://www.youtube.com/watch?v=row0',
      duration: 200_000,
    });
  });

  it('a row with no validated Spotify match stays exactly as raw as it was', async () => {
    // A wrong match is worse than a raw upload title: the pick carries this
    // identity into play() as trusted, announcing a different song while the
    // original audio plays.
    const { ladder } = build({
      search: { tracks: [row(0)] },
      spotifySearchTracks: [
        { name: 'One Dance', artist: 'Drake', searchQuery: 'some song', artworkUrl: COVER, durationMs: 200_000 },
      ],
    });
    const res = await ladder.searchTracks('some song', 'youtube', false);
    expect(res[0]!.artworkUrl).toBeUndefined();
    expect(res[0]!.title).toBe('Upload 0');
  });

  it('a failed upgrade leaves the picker raw instead of failing the whole search', async () => {
    const { ladder, spotify } = build({ search: { tracks: [row(0)] } });
    spotify.searchTracks.mockRejectedValue(new Error('spotify down'));
    const res = await ladder.searchTracks('some song', 'youtube', false);
    expect(res).toHaveLength(1);
    expect(res[0]!.title).toBe('Upload 0');
  });
});
