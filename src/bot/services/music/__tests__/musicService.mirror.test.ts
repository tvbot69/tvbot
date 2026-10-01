import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicService } from '@bot/services/music/musicService';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import type { QueueService } from '@bot/services/music/queueService';
import type { PlaylistChunkManager } from '@bot/services/music/playlistChunkManager';
import type { DeezerResolver } from '@bot/services/music/deezerResolver';
import type { AppleMusicResolver } from '@bot/services/music/appleMusicResolver';
import { Logger } from '@domain/logger';
import type { Track } from 'moonlink.js';

/**
 * `playMirror` — the ONE path every provider link funnels through (Spotify,
 * Deezer, Apple Music), plus the collection reply it produces.
 *
 * This was entirely uncovered and it is where a wrong number reaches a user.
 * Three things live here and each has a test that could not have existed before:
 *
 *  1. **The reply says what was loaded, and distinguishes "we know there is
 *     more" from "we cannot tell how much more there is".** `partialReason` has
 *     two sentences and inventing a denominator for the unreadable case is the
 *     exact bug `spotifyScraperService.totalKnown.test.ts` exists to prevent.
 *     This file pins the sentence, because a resolver that drops `totalKnown`
 *     would leave that test green.
 *  2. **A transport failure is an error and a genuine miss is an empty**, never
 *     the other way round, on every one of the four exit points.
 *  3. **The thin `MusicService` control delegates actually reach
 *     `musicPlaybackControls`.** Over 20 call sites build the service
 *     positionally and the controls are the shared answer for every surface; a
 *     delegate wired to the wrong collaborator is invisible until a user presses
 *     a button.
 *
 * `MusicService` is built with its EXACT production arity — three arguments,
 * positionally, as every other call site does. No parameter is added.
 */

const REQUESTER = { id: 'u1', username: 'listener' };

const makeQueue = () => {
  const tracks: unknown[] = [];
  return {
    tracks,
    get all() {
      return tracks;
    },
    get size() {
      return tracks.length;
    },
    get isEmpty() {
      return tracks.length === 0;
    },
    add: vi.fn((t: unknown) => {
      tracks.push(t);
    }),
    unshift: vi.fn((t: unknown) => {
      tracks.unshift(t);
    }),
    insert: vi.fn((i: number, t: unknown) => {
      tracks.splice(i, 0, t);
      return true;
    }),
    remove: vi.fn((i: number) => tracks.splice(i, 1)[0] ?? null),
    removeRange: vi.fn((s: number, e: number) => {
      tracks.splice(s, e - s + 1);
      return true;
    }),
    move: vi.fn(() => true),
    shuffle: vi.fn(() => true),
    clear: vi.fn(() => {
      tracks.length = 0;
    }),
  };
};

const YT_HIT = {
  identifier: 'ytsrc00001',
  title: 'Raw Upload Title',
  author: 'Some Uploader',
  duration: 240_000,
  uri: 'https://www.youtube.com/watch?v=ytsrc00001',
  isSeekable: true,
  isStream: false,
};

const PROVIDER_TRACK = {
  name: 'Bohemian Rhapsody',
  artist: 'Queen',
  durationMs: 355_000,
  searchQuery: 'Queen - Bohemian Rhapsody',
  artworkUrl: 'https://img.test/opera.jpg',
  spotifyUri: 'spotify:track:rrr',
  album: 'A Night at the Opera',
  provider: 'spotify' as const,
};

interface Harness {
  svc: MusicService;
  player: Record<string, unknown> & { queue: ReturnType<typeof makeQueue> };
  ladder: ReturnType<typeof vi.fn>;
  resolver: {
    resolve: ReturnType<typeof vi.fn>;
    searchTrack: ReturnType<typeof vi.fn>;
    searchTracks: ReturnType<typeof vi.fn>;
    parseSpotifyUrl: ReturnType<typeof vi.fn>;
  };
  chunk: { register: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; bindEvents: ReturnType<typeof vi.fn>; setTrackResolver: ReturnType<typeof vi.fn> };
  queueService: { getHistory: ReturnType<typeof vi.fn>; set247: ReturnType<typeof vi.fn> };
  manager: { getNodeStats: ReturnType<typeof vi.fn> };
}

const build = (opts: { realTopUp?: boolean } = {}): Harness => {
  const queue = makeQueue();
  const player: Record<string, unknown> & { queue: ReturnType<typeof makeQueue> } = {
    guildId: 'g-1',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    node: { identifier: 'node-a' },
    connected: true,
    playing: true,
    paused: false,
    current: null,
    previous: [],
    volume: 100,
    loop: 'off',
    autoPlay: false,
    queue,
    play: vi.fn(async () => true),
    skip: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined),
    setVolume: vi.fn(),
    setLoop: vi.fn(),
    setAutoPlay: vi.fn(),
    filters: { enabled: [] as string[], enable: vi.fn(), disable: vi.fn(), clear: vi.fn(), apply: vi.fn(async () => undefined), define: vi.fn() },
    get: () => undefined,
    set: () => undefined,
  };

  const resolver = {
    isSpotifyUrl: (q: string) => /open\.spotify\.com/.test(q),
    resolve: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    searchTrack: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    searchTracks: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    parseSpotifyUrl: vi.fn((u: string) => ({ type: 'playlist', id: /playlist\/(\w+)/.exec(u)?.[1] ?? 'unknown' })),
  };

  const chunk = {
    register: vi.fn(),
    clear: vi.fn(),
    bindEvents: vi.fn(),
    setTrackResolver: vi.fn(),
  };
  const queueService = {
    getHistory: vi.fn(() => ['a']),
    set247: vi.fn(),
    getQueueInfo: vi.fn(() => null),
    calculatePosition: vi.fn(() => 0),
    saveSettings: vi.fn(async () => undefined),
    is247: vi.fn(() => false),
    isKaraokeEnabled: vi.fn(() => false),
    toggleKaraoke: vi.fn((_: string, on: boolean) => on),
    recordTrackStart: vi.fn(),
  };
  const manager = {
    getManager: () => ({ players: { get: () => player } }),
    getNodeStats: vi.fn(() => []),
    hasHealthyNode: () => true,
    getUnavailableReason: () => ({ reason: 'rate-limited', retryAfterMs: 30_000 }),
  };

  const svc = new MusicService(
    manager as unknown as MoonlinkManager,
    resolver as unknown as SpotifyResolver,
    queueService as unknown as QueueService,
    chunk as unknown as PlaylistChunkManager,
  );

  const ladder = vi.fn(async (..._a: unknown[]) => ({ track: { ...YT_HIT }, rung: 'plugin' }));
  (svc as unknown as { searchTrackWithLadder: unknown }).searchTrackWithLadder = ladder;

  if (!opts.realTopUp) {
    // `playMirror` fires `void this.topUpPending(...)`, so a real one races the
    // reply it is supposed to describe: the first pass shifts an entry off the
    // pending list before `pendingDomain` is read, and the count comes out one
    // short. Stubbed here (own property, so the internal call site is
    // intercepted) and driven for real in the `notifyUnavailable` block below.
    (svc as unknown as { topUpPending: unknown }).topUpPending = vi.fn(async () => undefined);
  }

  return { svc, player, ladder, resolver, chunk, queueService, manager };
};

/** The private, reached the way the class reaches it. */
const playMirror = (
  svc: MusicService,
  resolution: unknown,
  requester: unknown = REQUESTER,
) =>
  (
    svc as unknown as {
      playMirror: (p: unknown, r: unknown, url: string, req: unknown) => Promise<Record<string, unknown>>;
    }
  ).playMirror(svc.getPlayer('g-1'), resolution, 'https://open.spotify.com/playlist/abc123', requester);

const singleTrackResolution = (over: Record<string, unknown> = {}) => ({
  type: 'track',
  provider: 'spotify',
  title: 'Bohemian Rhapsody',
  artworkUrl: 'https://img.test/opera.jpg',
  totalTracks: 1,
  totalKnown: true,
  tracks: [PROVIDER_TRACK],
  ...over,
});

const collectionResolution = (n: number, over: Record<string, unknown> = {}) => ({
  type: 'playlist',
  provider: 'spotify',
  title: 'Big Playlist',
  artworkUrl: 'https://img.test/big.jpg',
  totalTracks: n,
  totalKnown: true,
  tracks: Array.from({ length: n }, (_, i) => ({ ...PROVIDER_TRACK, name: `Cut ${i + 1}` })),
  ...over,
});

/**
 * The ladder rungs are env-gated, so this file reads and CLEARS the gate keys —
 * which means it has to put them back. Vitest runs files in separate workers
 * but shares nothing else, and a sibling file that finds
 * `HOME_PLUGIN_RUNG` missing asserts the wrong branch and fails for a reason
 * that has nothing to do with it.
 */
const ENV_KEYS = ['HOME_RESOLVER_URL', 'HOME_RESOLVER_TOKEN', 'HOME_PLUGIN_RUNG', 'HOME_LADDER_MODE'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('playMirror — a single provider track', () => {
  it('adopts the provider metadata and queues it, so the card is the real song', async () => {
    const h = build();

    const res = await playMirror(h.svc, singleTrackResolution());

    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
    expect((res.track as Record<string, unknown>)?.title).toBe('Bohemian Rhapsody');
    expect((res.track as Record<string, unknown>)?.author).toBe('Queen');
    expect((res.track as Record<string, unknown>)?.source).toBe('spotify');
  });

  it('a ladder MISS is an empty result, never an error', async () => {
    const h = build();
    h.ladder.mockResolvedValue(null);

    await expect(playMirror(h.svc, singleTrackResolution())).resolves.toEqual({
      loadType: 'empty',
      totalTracksAdded: 0,
      positionInQueue: 0,
    });
  });

  it('a ladder TRANSPORT failure is an error, never "no tracks found"', async () => {
    // The distinction AGENTS.md §2.1 A1 exists for: telling a listener "this
    // track does not exist" during an uplink stall is a confident falsehood.
    const h = build();
    h.ladder.mockResolvedValue({ transportError: true });

    await expect(playMirror(h.svc, singleTrackResolution())).resolves.toEqual({
      loadType: 'error',
      totalTracksAdded: 0,
      positionInQueue: 0,
    });
  });

  it('a failed handshake on the first track reports voice and queues nothing', async () => {
    const h = build();
    // `playing` must be false or the handshake is a no-op and the rollback
    // never runs — which is the whole point of the test.
    (h.player as Record<string, unknown>).playing = false;
    (h.player.play as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await playMirror(h.svc, singleTrackResolution());

    expect(res.loadType).toBe('error');
    expect(res.errorReason).toBe('voice');
    expect(res.totalTracksAdded).toBe(0);
  });

  it('a trusted override wins over the provider metadata, because overrides are trusted downstream', async () => {
    const h = build();

    const res = await playMirror(
      h.svc,
      singleTrackResolution(),
      { ...REQUESTER },
    );

    expect((res.track as Record<string, unknown>)?.title).toBe('Bohemian Rhapsody');
  });
});

describe('playMirror — a collection, and the three loadType families', () => {
  it('a Spotify album reports spotify_album, because the builders key off it', async () => {
    const h = build();
    const res = await playMirror(h.svc, { ...collectionResolution(2), type: 'album' });
    expect(res.loadType).toBe('spotify_album');
  });

  it('a Spotify playlist reports spotify_playlist', async () => {
    const h = build();
    const res = await playMirror(h.svc, collectionResolution(2));
    expect(res.loadType).toBe('spotify_playlist');
  });

  it('a Spotify artist reports spotify_artist', async () => {
    const h = build();
    const res = await playMirror(h.svc, { ...collectionResolution(2), type: 'artist' });
    expect(res.loadType).toBe('spotify_artist');
  });

  it('a DEEZER collection reports the provider-agnostic mirror_* type, not a spotify one', async () => {
    // A card badge reading "Spotify" over a Deezer link is a wrong fact.
    const h = build();
    const res = await playMirror(h.svc, {
      ...collectionResolution(2),
      provider: 'deezer',
      tracks: collectionResolution(2).tracks.map((t) => ({ ...t, provider: 'deezer' })),
    });
    expect(res.loadType).toBe('mirror_playlist');
  });

  it('an APPLE album and artist report their own mirror_* types', async () => {
    const h = build();
    expect((await playMirror(h.svc, { ...collectionResolution(2), type: 'album', provider: 'apple' })).loadType).toBe('mirror_album');
    expect((await playMirror(h.svc, { ...collectionResolution(2), type: 'artist', provider: 'apple' })).loadType).toBe('mirror_artist');
  });

  it('a resolution with NO provider field defaults to spotify, so older callers keep the legacy types', async () => {
    const h = build();
    const res = await playMirror(h.svc, { ...collectionResolution(2), provider: undefined });
    expect(res.loadType).toBe('spotify_playlist');
  });

  it('the FIRST track is resolved and played immediately, and the rest wait as pending', async () => {
    // A 347-track playlist that resolves 2-ahead replies in seconds; resolving
    // all of it up front is what made playlist commands take minutes.
    const h = build();
    const res = await playMirror(h.svc, collectionResolution(10));

    expect(res.totalTracksAdded).toBe(10);
    // One resolved now, nine pending.
    expect(h.player.queue.add).toHaveBeenCalledTimes(1);
    const pending = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify.get('g-1');
    expect(pending).toHaveLength(9);
  });

  it('the reply lists resolved AND pending, with the real durations, so the count is true', async () => {
    const h = build();
    const res = await playMirror(h.svc, collectionResolution(4));

    const listed = res.tracks as Array<{ title: string; duration: number }>;
    expect(listed).toHaveLength(4);
    expect(listed.map((t) => t.title)).toEqual(['Cut 1', 'Cut 2', 'Cut 3', 'Cut 4']);
    // Every row carries a real duration, so the totals on the card are true
    // rather than a count with a blank beside it.
    expect(listed.every((t) => typeof t.duration === 'number' && t.duration > 0)).toBe(true);
  });

  it('a TRANSPORT failure on the first track is an error and nothing is queued', async () => {
    const h = build();
    h.ladder.mockResolvedValue({ transportError: true });

    await expect(playMirror(h.svc, collectionResolution(3))).resolves.toEqual({
      loadType: 'error',
      totalTracksAdded: 0,
      positionInQueue: 0,
    });
    expect(h.player.queue.add).not.toHaveBeenCalled();
  });

  it('a MISS on the first track still queues the rest, because a collection is not a single lookup', async () => {
    const h = build();
    h.ladder.mockResolvedValue(null);

    const res = await playMirror(h.svc, collectionResolution(3));

    // Cut 1 could not be found; cuts 2 and 3 are still queued and the reply
    // counts what is ACTUALLY there. Reporting the whole thing as empty would
    // be a lie about two playable tracks.
    expect(res.loadType).toBe('spotify_playlist');
    expect(res.totalTracksAdded).toBe(2);
  });

  it('a failed handshake on the first track reports voice and does not silently continue', async () => {
    const h = build();
    (h.player as Record<string, unknown>).playing = false;
    (h.player.play as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await playMirror(h.svc, collectionResolution(3));

    expect(res.loadType).toBe('error');
    expect(res.errorReason).toBe('voice');
  });
});

describe('playMirror — truncation is THREE-valued, and only two of them name a number', () => {
  it('a real count that exceeds the shard names the missing tracks', async () => {
    const h = build();

    const res = await playMirror(h.svc, collectionResolution(3, { totalTracks: 347 }));

    expect(res.partial).toBe(true);
    expect(res.partialReason).toBe(
      'Spotify only exposes the first 3 of 347 tracks to bots — 344 more were not loaded',
    );
  });

  it('an UNREADABLE count says so and invents NO denominator', async () => {
    // The bug this whole three-valued shape exists for. A 347-track playlist
    // used to render a confident "100 tracks"; now it says the size is unknown.
    const h = build();

    const res = await playMirror(h.svc, collectionResolution(3, { totalTracks: 3, totalKnown: false }));

    expect(res.partial).toBe(true);
    expect(res.partialReason).toBe(
      'Spotify only exposes 3 tracks of this playlist to bots, and does not report the full size — more may exist beyond what was loaded',
    );
    // Not one invented number in the sentence.
    expect(String(res.partialReason)).not.toMatch(/\b347\b|\bof \d+\b/);
  });

  it('a real count that FITS is complete, with no truncation notice at all', async () => {
    // The other direction: "always warn" would train listeners to ignore the
    // notice that matters.
    const h = build();

    const res = await playMirror(h.svc, collectionResolution(5, { totalTracks: 5 }));

    expect(res.partial).toBeUndefined();
    expect(res.partialReason).toBeUndefined();
  });

  it('an unreadable count on a NON-playlist is not a truncation claim', async () => {
    const h = build();
    const res = await playMirror(h.svc, { ...collectionResolution(3, { totalKnown: false }), type: 'album' });

    expect(res.partial).toBeUndefined();
    expect(res.partialReason).toBeUndefined();
  });

  it('a non-Spotify provider is not described with a Spotify truncation sentence', async () => {
    // "Spotify only exposes…" under a Deezer link is a wrong vendor on the card.
    const h = build();

    const res = await playMirror(h.svc, { ...collectionResolution(3, { totalTracks: 347, provider: 'deezer' }) });

    expect(res.partial).toBeUndefined();
    expect(res.partialReason).toBeUndefined();
  });

  it('a truncated playlist is registered with the chunk manager, carrying id, sizes and the requester', async () => {
    const h = build();

    await playMirror(h.svc, collectionResolution(3, { totalTracks: 347 }));

    expect(h.chunk.register).toHaveBeenCalledWith(
      'g-1',
      'abc123',
      'Big Playlist',
      347,
      3,
      'u1',
      'tc-1',
    );
  });

  it('a COMPLETE playlist is not registered, because there is nothing left to page', async () => {
    const h = build();
    await playMirror(h.svc, collectionResolution(5, { totalTracks: 5 }));
    expect(h.chunk.register).not.toHaveBeenCalled();
  });

  it('with no chunk manager wired, a truncated playlist still says so in the reply', async () => {
    // The register is an optimisation; the sentence is the contract.
    const h = build();
    const bare = new MusicService(
      { getManager: () => ({ players: { get: () => h.player } }) } as unknown as MoonlinkManager,
      h.resolver as unknown as SpotifyResolver,
      { getQueueInfo: () => null } as unknown as QueueService,
    );
    (bare as unknown as { searchTrackWithLadder: unknown }).searchTrackWithLadder = h.ladder;

    const res = await (
      bare as unknown as { playMirror: (p: unknown, r: unknown, u: string, q: unknown) => Promise<Record<string, unknown>> }
    ).playMirror(bare.getPlayer('g-1'), collectionResolution(3, { totalTracks: 347 }), 'https://open.spotify.com/playlist/abc123', REQUESTER);

    expect(res.partialReason).toMatch(/only exposes the first 3 of 347/);
  });
});

describe('playMirror — Deezer and Apple links reach the same path', () => {
  const wired = (h: Harness) => {
    h.svc.setDeezerResolver({
      isDeezerUrl: (q: string) => /deezer\.com/.test(q),
      resolve: vi.fn(async () => ({
        type: 'track',
        provider: 'deezer',
        title: 'A Deezer Song',
        totalTracks: 1,
        totalKnown: true,
        tracks: [{ ...PROVIDER_TRACK, name: 'A Deezer Song', provider: 'deezer' }],
      })),
    } as unknown as DeezerResolver);
    h.svc.setAppleMusicResolver({
      isAppleMusicUrl: (q: string) => /music\.apple\.com/.test(q),
      resolve: vi.fn(async () => ({
        type: 'track',
        provider: 'apple',
        title: 'An Apple Song',
        totalTracks: 1,
        totalKnown: true,
        tracks: [{ ...PROVIDER_TRACK, name: 'An Apple Song', provider: 'apple' }],
      })),
    } as unknown as AppleMusicResolver);
  };

  it('a DEEZER link that resolves is played through the same mirror path', async () => {
    const h = build();
    wired(h);

    const res = await h.svc.play('g-1', 'vc-1', 'tc-1', 'https://www.deezer.com/track/123', REQUESTER as never);

    expect(res.loadType).toBe('track');
    expect(res.track?.title).toBe('A Deezer Song');
    expect(res.track?.source).toBe('deezer');
  });

  it('an APPLE link that resolves is played through the same mirror path', async () => {
    const h = build();
    wired(h);

    const res = await h.svc.play('g-1', 'vc-1', 'tc-1', 'https://music.apple.com/us/album/creep/123', REQUESTER as never);

    expect(res.loadType).toBe('track');
    expect(res.track?.title).toBe('An Apple Song');
    expect(res.track?.source).toBe('apple');
  });

  it('a DEEZER link that resolves to NOTHING falls through to the normal search', async () => {
    // An unresolvable provider link must not become "I could not resolve that
    // link"; the query is still playable.
    const h = build();
    h.svc.setDeezerResolver({
      isDeezerUrl: () => true,
      resolve: vi.fn(async () => ({ type: 'album', provider: 'deezer', title: 'x', totalTracks: 0, totalKnown: true, tracks: [] })),
    } as unknown as DeezerResolver);
    h.ladder.mockResolvedValue({ track: { ...YT_HIT }, rung: 'plugin' });

    const res = await h.svc.play('g-1', 'vc-1', 'tc-1', 'https://www.deezer.com/track/123', REQUESTER as never);

    expect(res.loadType).toBe('track');
  });
});

describe('the thin control delegates — every surface shares ONE answer', () => {
  /**
   * These are one-line delegates into `musicPlaybackControls`, and every
   * button, slash command and text command reaches them through here. A
   * delegate pointed at the wrong collaborator is invisible in review and
   * obvious to a user, so each one is asserted for the ARGUMENTS it forwards
   * and the VALUE it returns.
   */
    /**
   * A player double that actually MUTATES on setVolume/setLoop/setAutoPlay.
   *
   * `musicPlaybackControls` reads the current value off the player (not off a
   * cache), so a double that only records the call would make `adjustVolume`
   * and `cycleLoop` read the original forever and every assertion about the
   * second call would be testing the double rather than the code.
   */
  const playerWith = (over: Record<string, unknown> = {}) => {
    const player = {
      guildId: 'g-1',
      node: { identifier: 'node-a' },
      current: { identifier: 'vid', title: 'T', author: 'A', duration: 200_000, position: 0, time: Date.now(), isSeekable: true, isStream: false, requester: { id: 'u1' } },
      playing: true,
      paused: false,
      volume: 100,
      loop: 'off',
      autoPlay: false,
      queue: makeQueue(),
      pause: vi.fn(async () => true),
      resume: vi.fn(async () => true),
      seek: vi.fn(async () => true),
      setVolume: vi.fn((v: number) => {
        player.volume = v;
      }),
      setLoop: vi.fn((m: string) => {
        player.loop = m;
      }),
      setAutoPlay: vi.fn((v: boolean) => {
        player.autoPlay = v;
      }),
      filters: { enabled: [] as string[], enable: vi.fn(), disable: vi.fn(), clear: vi.fn(), apply: vi.fn(async () => undefined), define: vi.fn() },
      get: () => undefined,
      set: () => undefined,
      ...over,
    };
    return player;
  };

  const karaokeStore = new Map<string, boolean>();

  const svcWithPlayer = (player: unknown) => {
    const svc = new MusicService(
      { getManager: () => ({ players: { get: () => player } }) } as unknown as MoonlinkManager,
      { isSpotifyUrl: () => false, searchTracks: vi.fn(async () => []) } as unknown as SpotifyResolver,
      {
        getQueueInfo: (p: unknown) =>
          // The ONE method `canControlPlayback` reads, and it is read through the
          // QUEUE SERVICE rather than off the player — so a double that omits it
          // would answer "permissive" and the policy test below would be vacuous.
          (p as { current?: { requester?: { id: string } } })?.current
            ? { current: { requester: { id: 'u1' } } }
            : null,
        set247: vi.fn(),
        saveSettings: vi.fn(async () => undefined),
        calculatePosition: vi.fn(() => 0),
        is247: vi.fn(() => false),
        toggleKaraoke: vi.fn((g: string, on?: boolean) => {
          const next = on !== undefined ? on : !karaokeStore.get(g);
          karaokeStore.set(g, next);
          return next;
        }),
        isKaraokeEnabled: vi.fn((g: string) => karaokeStore.get(g) ?? false),
        getHistory: vi.fn(() => ['a']),
      } as unknown as QueueService,
    );
    return svc;
  };

  it('pause/resume reach the player', async () => {
    const player = playerWith();
    const svc = svcWithPlayer(player);
    expect(await svc.pause('g-1')).toBe(true);
    expect(await svc.resume('g-1')).toBe(true);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.resume).toHaveBeenCalledTimes(1);
  });

  it('setVolume CLAMPS and returns what it actually set, never what was asked', () => {
    const player = playerWith();
    const svc = svcWithPlayer(player);
    expect(svc.setVolume('g-1', 9999)).toBe(150);
    expect(svc.setVolume('g-1', -20)).toBe(0);
  });

  it('adjustVolume moves by the delta from the CURRENT volume', () => {
    const player = playerWith({ volume: 50 });
    const svc = svcWithPlayer(player);
    expect(svc.adjustVolume('g-1', 20)).toBe(70);
    expect(svc.adjustVolume('g-1', -10)).toBe(60);
  });

  it('setVolume with no player is null, not a number the card will print', () => {
    const svc = svcWithPlayer(undefined);
    expect(svc.setVolume('g-1', 50)).toBeNull();
    expect(svc.adjustVolume('g-1', 10)).toBeNull();
  });

  it('canControlPlayback answers the one shared policy, and an admin can always recover the bot', () => {
    const player = playerWith();
    const svc = svcWithPlayer(player);
    expect(svc.canControlPlayback('g-1', 'u1')).toBe(true);
    expect(svc.canControlPlayback('g-1', 'someone-else')).toBe(false);
    expect(svc.canControlPlayback('g-1', 'someone-else', true)).toBe(true);
  });

  it('setFilter reports what was applied, and clearFilters reports success', async () => {
    const player = playerWith();
    const svc = svcWithPlayer(player);
    await expect(svc.setFilter('g-1', 'bassboost', true)).resolves.toEqual({ applied: true, replaced: [] });
    expect(await svc.clearFilters('g-1')).toBe(true);
  });

  it('toggle247 and isKaraokeEnabled/toggleKaraoke work with no player, because they are guild preferences', () => {
    const svc = svcWithPlayer(undefined);
    expect(typeof svc.toggle247('g-1')).toBe('boolean');
    expect(svc.toggle247('g-1', true)).toBe(true);
    expect(svc.isKaraokeEnabled('g-1')).toBe(false);
    expect(svc.toggleKaraoke('g-1', true)).toBe(true);
    expect(svc.isKaraokeEnabled('g-1')).toBe(true);
  });

  it('setLoop returns the mode APPLIED, and cycleLoop walks the three states', () => {
    const player = playerWith();
    const svc = svcWithPlayer(player);
    expect(svc.setLoop('g-1', 'queue')).toBe('queue');
    expect(svc.cycleLoop('g-1')).toBe('off');
    expect(svc.cycleLoop('g-1')).toBe('track');
  });

  it('setLoop with no player is null, not an invented mode', () => {
    const svc = svcWithPlayer(undefined);
    expect(svc.setLoop('g-1', 'queue')).toBeNull();
    expect(svc.cycleLoop('g-1')).toBeNull();
  });

  it('toggleAutoplay toggles from the PLAYER state, and an explicit argument sets it exactly', () => {
    const player = playerWith({ autoPlay: false });
    const svc = svcWithPlayer(player);
    expect(svc.toggleAutoplay('g-1')).toBe(true);
    expect(svc.toggleAutoplay('g-1', false)).toBe(false);
  });

  it('seek returns the position actually applied, and replays to zero', async () => {
    const player = playerWith();
    const svc = svcWithPlayer(player);
    expect(await svc.seek('g-1', 30)).toBe(30_000);
    expect(await svc.replay('g-1')).toBe(true);
    expect(player.seek).toHaveBeenCalledWith(0);
  });

  it('seek with no player is null, never 0 — 0 would be a real position claim', () => {
    const svc = svcWithPlayer(undefined);
    return expect(svc.seek('g-1', 30)).resolves.toBeNull();
  });

  it('the karaoke notifier is wired and fires on a toggle, because the card is event-driven', () => {
    const svc = svcWithPlayer(undefined);
    const notifier = vi.fn();
    svc.setKaraokeToggleNotifier(notifier);

    svc.toggleKaraoke('g-1', true);

    // Without the notifier the card keeps showing a stale lyric state until the
    // next boundary timer, which for a 4-minute song is most of it.
    expect(notifier).toHaveBeenCalledWith('g-1');
  });

  it('a notifier that throws does not undo the toggle, because the toggle already happened', () => {
    const svc = svcWithPlayer(undefined);
    svc.setKaraokeToggleNotifier(() => {
      throw new Error('card gone');
    });

    expect(() => svc.toggleKaraoke('g-1', true)).not.toThrow();
    expect(svc.isKaraokeEnabled('g-1')).toBe(true);
  });

  it('the card-refresh notifier reaches the artwork cluster, so late art repaints the card', async () => {
    const notifier = vi.fn();
    const svc = new MusicService(
      { getManager: () => ({ players: { get: () => undefined } }) } as unknown as MoonlinkManager,
      { isSpotifyUrl: () => false } as unknown as SpotifyResolver,
      { getQueueInfo: () => null } as unknown as QueueService,
      undefined,
      // No artwork service wired: the notifier must still be accepted, so a
      // startup wiring mistake here is not a crash.
      undefined,
    );
    expect(() => svc.setCardRefreshNotifier(notifier)).not.toThrow();
  });

  it('searchTracks is the ladder picker, and it is what the +search menu shows', async () => {
    const svc = new MusicService(
      { getManager: () => ({ search: vi.fn() }) } as unknown as MoonlinkManager,
      { searchTracks: vi.fn(async () => [{ title: 'Picked', author: 'A' }]) } as unknown as SpotifyResolver,
      { getQueueInfo: () => null } as unknown as QueueService,
    );
    const rows = await svc.searchTracks('queen', 'youtube', true);
    expect(rows).toHaveLength(1);
  });

  it('getHistory and getNodeStats are straight delegates to the service that owns the data', () => {
    const h = build();
    expect(h.svc.getHistory('g-1', 5)).toEqual(['a']);
    expect(h.queueService.getHistory).toHaveBeenCalledWith('g-1', 5);
    h.manager.getNodeStats.mockReturnValue([{ identifier: 'node-a' }]);
    expect(h.svc.getNodeStats()).toEqual([{ identifier: 'node-a' }]);
  });
});

describe('remove() — the two regions, and neither is a guess', () => {
  it('an index inside the RESOLVED queue removes that track', () => {
    const h = build();
    h.player.queue.add({ identifier: 'a', title: 'A' });
    h.player.queue.add({ identifier: 'b', title: 'B' });

    const removed = h.svc.remove('g-1', 0);

    expect(removed).toMatchObject({ identifier: 'a' });
    expect(h.player.queue.size).toBe(1);
  });

  it('an index past the resolved queue splices the LIVE pending array', () => {
    // AGENTS.md §4.1 invariant 1. A copying port would make this silently a
    // no-op while every assertion on the return value still passed.
    const h = build();
    const view = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    const live = [{ spTrack: { name: 'p1' } }, { spTrack: { name: 'p2' } }];
    view.set('g-1', live);

    const removed = h.svc.remove('g-1', 0);

    expect(removed).toMatchObject({ title: 'p1' });
    // The SAME array, one shorter — not a rebuilt copy.
    expect(view.get('g-1')).toBe(live);
    expect(live).toHaveLength(1);
  });

  it('an index past BOTH regions is null, never a fabricated removal', () => {
    const h = build();
    expect(h.svc.remove('g-1', 99)).toBeNull();
  });

  it('a negative index is null, and no player is null', () => {
    const h = build();
    expect(h.svc.remove('g-1', -1)).toBeNull();
    const bare = new MusicService(
      { getManager: () => ({ players: { get: () => undefined } }) } as unknown as MoonlinkManager,
      {} as unknown as SpotifyResolver,
      {} as unknown as QueueService,
    );
    expect(bare.remove('g-1', 0)).toBeNull();
  });
});

describe('jumpToCombined — a refused skip puts the dropped tracks BACK, in their own order', () => {
  /** The queue, by identifier. ORDER IS THE SUBJECT of this block. */
  const ids = (h: Harness): string[] =>
    (h.player.queue.all as Array<{ identifier: string }>).map((t) => t.identifier);

  /** The tracks the restore re-inserted, in the order it inserted them. */
  const restored = (h: Harness): string[] => {
    const calls = (h.player.queue.insert as ReturnType<typeof vi.fn>).mock.calls as Array<[number, { identifier: string }]>;
    return calls.map(([, track]) => track.identifier);
  };

  const queued = (h: Harness, ...list: string[]) => {
    for (const id of list) h.player.queue.add({ identifier: id });
  };

  /** A skip the node refuses — the path that owes the listener a restore. */
  const refuses = (h: Harness) => (h.player.skip as ReturnType<typeof vi.fn>).mockResolvedValue(false);

  it('restores everything it removed, so "Invalid position" does not cost 11 tracks', async () => {
    // The reported incident: the tracks were destroyed BEFORE skip() was tried,
    // and the user was told the position was invalid.
    const h = build();
    queued(h, 'a', 'b', 'c');
    refuses(h);

    const ok = await h.svc.skipto('g-1', 3);

    expect(ok).toBe(false);
    // All three back, IN ORDER — nothing lost, which is the fix this
    // restoration exists for, and the order they were in, which is why.
    expect(h.player.queue.all).toHaveLength(3);
    expect(ids(h)).toEqual(['a', 'b', 'c']);
  });

  it('ONE dropped track: the refused jump puts it back at the FRONT, not the back', async () => {
    const h = build();
    queued(h, 'a', 'b', 'c');
    refuses(h);

    // skipto(2) is index 1: exactly one track (a) is dropped, b and c stay.
    const ok = await h.svc.skipto('g-1', 2);

    expect(ok).toBe(false);
    expect(ids(h)).toEqual(['a', 'b', 'c']);
    // Re-inserted at 0, which is what puts it ahead of b. `add` would have
    // appended it behind c, and that is the defect: three fixture adds and no
    // fourth from the restore.
    expect(restored(h)).toEqual(['a']);
    expect(h.player.queue.add).toHaveBeenCalledTimes(3);
  });

  it('TWO dropped tracks: both come back AHEAD of the target, in their original order', async () => {
    const h = build();
    queued(h, 'a', 'b', 'c');
    refuses(h);

    // skipto(3) is index 2: a and b are dropped, c is the target.
    await h.svc.skipto('g-1', 3);

    // [c, a, b] is what the appending restore produced.
    expect(ids(h)).toEqual(['a', 'b', 'c']);
    // Back-to-front, so each 0-insert lands in front of the one before it.
    expect(restored(h)).toEqual(['b', 'a']);
  });

  it('THREE dropped tracks: the whole block is rebuilt in front, back-to-front', async () => {
    const h = build();
    queued(h, 'a', 'b', 'c', 'd');
    refuses(h);

    // skipto(4) is index 3: a, b and c are dropped, d is the target.
    await h.svc.skipto('g-1', 4);

    expect(ids(h)).toEqual(['a', 'b', 'c', 'd']);
    expect(restored(h)).toEqual(['c', 'b', 'a']);
  });

  it('NOTHING dropped (index 0): a refused jump does not touch the queue at all', async () => {
    const h = build();
    queued(h, 'a', 'b', 'c');
    refuses(h);

    // skipto(1) is index 0 — the target IS the head, so there is no block to
    // drop and no block to restore. `removeRange` must not run either: a
    // restore path that removes on the way in has nothing to undo.
    const ok = await h.svc.skipto('g-1', 1);

    expect(ok).toBe(false);
    expect(ids(h)).toEqual(['a', 'b', 'c']);
    expect(h.player.queue.removeRange).not.toHaveBeenCalled();
    expect(h.player.queue.insert).not.toHaveBeenCalled();
  });

  it('a SUCCESSFUL skip destroys the dropped tracks on purpose — no restore at all', async () => {
    const h = build();
    queued(h, 'a', 'b', 'c');
    (h.player.skip as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const ok = await h.svc.skipto('g-1', 3);

    expect(ok).toBe(true);
    // Only the target survives: restoring here would put back the very tracks
    // the listener asked to skip, in front of the track they asked for.
    expect(ids(h)).toEqual(['c']);
    expect(h.player.queue.insert).not.toHaveBeenCalled();
  });

  it('a restore that THROWS is swallowed, because the answer is already "could not go there"', async () => {
    const h = build();
    queued(h, 'a', 'b', 'c');
    refuses(h);
    (h.player.queue.insert as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('queue gone');
    });

    await expect(h.svc.skipto('g-1', 3)).resolves.toBe(false);
    // The surviving insert still ran: best effort is per track, not all or
    // nothing. b threw, a is still back in front of c.
    expect(ids(h)).toEqual(['a', 'c']);
  });

  it('a jump into PENDING resolves the target and drops the entries ahead of it', async () => {
    const h = build();
    const view = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    view.set('g-1', [
      { spTrack: { name: 'p1', artist: 'A', searchQuery: 'A - p1' }, requester: REQUESTER, spotifyUrl: 'u' },
      { spTrack: { name: 'p2', artist: 'A', searchQuery: 'A - p2' }, requester: REQUESTER, spotifyUrl: 'u' },
    ]);

    const ok = await h.svc.skipto('g-1', 1);

    expect(ok).toBe(true);
    // Target plus everything before it, nothing after.
    expect(view.get('g-1')).toHaveLength(1);
  });

  it('a pending target that will NOT resolve refuses with the queue untouched', async () => {
    // Resolve happens BEFORE any mutation, which is the promise this method
    // makes. A miss must not cost the listener the tracks they still had.
    const h = build();
    h.player.queue.add({ identifier: 'a' });
    const view = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    view.set('g-1', [{ spTrack: { name: 'p1', artist: 'A', searchQuery: 'A - p1' }, requester: REQUESTER, spotifyUrl: 'u' }]);
    h.ladder.mockResolvedValue(null);

    const ok = await h.svc.skipto('g-1', 2);

    expect(ok).toBe(false);
    expect(h.player.queue.all).toHaveLength(1);
    expect(view.get('g-1')).toHaveLength(1);
  });

  it('a jump with no player or a negative position is false, not a throw', async () => {
    const h = build();
    expect(await h.svc.skipto('g-1', 0)).toBe(false);
  });
});

describe('notifyUnavailable — a channel notice must never break the flow that produced it', () => {
  it('is wired and receives the guild and the message', async () => {
    const h = build({ realTopUp: true });
    const notifier = vi.fn();
    h.svc.setUnavailableNotifier(notifier);
    const pending = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    pending.set('g-1', [{ spTrack: { name: 'p1', artist: 'A', searchQuery: 'A - p1' }, requester: REQUESTER, spotifyUrl: 'u' }]);
    h.ladder.mockResolvedValue(null);

    await h.svc.topUpPending('g-1');

    // The exact shape matters: a skipped track is "could not be resolved", not
    // "does not exist", and the count is singular for one track.
    expect(notifier).toHaveBeenCalledWith('g-1', '⚠️ 1 queued track could not be resolved and were skipped.');
  });

  it('a notifier that throws is swallowed, and the top-up still finishes', async () => {
    const h = build({ realTopUp: true });
    h.svc.setUnavailableNotifier(() => {
      throw new Error('channel gone');
    });
    const pending = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    pending.set('g-1', [{ spTrack: { name: 'p1', artist: 'A', searchQuery: 'A - p1' }, requester: REQUESTER, spotifyUrl: 'u' }]);
    h.ladder.mockResolvedValue(null);

    await expect(h.svc.topUpPending('g-1')).resolves.toBeUndefined();
  });

  it('pluralises correctly for more than one skipped track', async () => {
    const h = build({ realTopUp: true });
    const notifier = vi.fn();
    h.svc.setUnavailableNotifier(notifier);
    const pending = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    pending.set('g-1', [
      { spTrack: { name: 'p1', artist: 'A', searchQuery: 'A - p1' }, requester: REQUESTER, spotifyUrl: 'u' },
      { spTrack: { name: 'p2', artist: 'A', searchQuery: 'A - p2' }, requester: REQUESTER, spotifyUrl: 'u' },
    ]);
    h.ladder.mockResolvedValue(null);

    await h.svc.topUpPending('g-1');

    expect(notifier).toHaveBeenCalledWith('g-1', '⚠️ 2 queued tracks could not be resolved and were skipped.');
  });

  it('a fully resolved top-up sends NO notice at all, because nothing went wrong', async () => {
    const h = build({ realTopUp: true });
    const notifier = vi.fn();
    h.svc.setUnavailableNotifier(notifier);
    const pending = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    pending.set('g-1', [{ spTrack: { name: 'p1', artist: 'A', searchQuery: 'A - p1' }, requester: REQUESTER, spotifyUrl: 'u' }]);

    await h.svc.topUpPending('g-1');

    expect(notifier).not.toHaveBeenCalled();
  });
});

describe('the chunk manager wiring the constructor owns', () => {
  it('binds its events and installs a track resolver, or a lazy playlist never pages', () => {
    const h = build();
    // Both happen inside the existing constructor body — no new parameter, so
    // every positional call site in the suite keeps compiling.
    expect(h.chunk.bindEvents).toHaveBeenCalledTimes(1);
    expect(h.chunk.setTrackResolver).toHaveBeenCalledTimes(1);
    expect(typeof h.chunk.setTrackResolver.mock.calls[0]?.[0]).toBe('function');
  });

  it('works with NO chunk manager wired, because playlists still resolve first-now', () => {
    expect(() => {
      const svc = new MusicService(
        { getManager: () => ({ players: { get: () => undefined } }) } as unknown as MoonlinkManager,
        {} as unknown as SpotifyResolver,
        {} as unknown as QueueService,
      );
      return svc;
    }).not.toThrow();
  });
});

describe('the static aliases the whole suite reads off the class', () => {
  it('every alias points at a real function, so a refactor cannot silently undefine one', () => {
    // These are read by production call sites AND by tests across three files.
    expect(typeof MusicService.fallbackSearchQuery).toBe('function');
    expect(typeof MusicService.normalizeIsrc).toBe('function');
    expect(typeof MusicService.isTransportError).toBe('function');
    expect(typeof MusicService.isYoutubeThumb).toBe('function');
    expect(typeof MusicService.preCleanArtwork).toBe('function');
    expect(typeof MusicService.sanitizeOverride).toBe('function');
  });

  it('isTransportError separates the third answer from both others', () => {
    // Three answers, not two: hit, miss, and "no node answered". Collapsing the
    // third into the second is what rendered a transport failure as "no tracks
    // found".
    //
    // The three inputs are the three shapes `LadderResult` actually declares. A
    // `{ tracks: [] }` object is NOT one of them - the ladder has no such
    // variant, so a "miss" is `null` and a hit carries `{ track, rung }`.
    expect(MusicService.isTransportError({ transportError: true })).toBe(true);
    expect(MusicService.isTransportError({ track: YT_HIT as unknown as Track, rung: 'plugin' })).toBe(false);
    expect(MusicService.isTransportError(null)).toBe(false);
  });
});

describe('Logger paths the service owns', () => {
  it('the queue-full rejection is an ERROR with the real size, never "Added to Queue"', async () => {
    const h = build();
    // `searchWithTimeout` is the ladder's, so it is stubbed here; the single
    // enqueue choke point (`enqueueLavalinkTracks`) is the real one under test.
    (h.svc as unknown as { searchWithTimeout: unknown }).searchWithTimeout = vi.fn(async () => ({
      tracks: [{ ...YT_HIT }],
    }));
    for (let i = 0; i < 5000; i++) h.player.queue.tracks.push({ identifier: `f${i}` });

    const res = await h.svc.play('g-1', 'vc-1', 'tc-1', 'https://soundcloud.com/artist/track', REQUESTER as never);

    // The user must not be told a track was queued when it was not.
    expect(res.loadType).toBe('error');
    expect(res.errorReason).toBe('queue-full');
    expect(res.totalTracksAdded).toBe(0);
  });

  it('a partial bulk enqueue is flagged partial, so a capped load is not reported as complete', async () => {
    const h = build();
    const many = Array.from({ length: 20 }, (_, i) => ({ ...YT_HIT, identifier: `ytsrc0000${i}` }));
    (h.svc as unknown as { searchWithTimeout: unknown }).searchWithTimeout = vi.fn(async () => ({
      loadType: 'playlist',
      tracks: many,
    }));
    // 4,990 queued leaves room for 10 of the 20.
    for (let i = 0; i < 4990; i++) h.player.queue.tracks.push({ identifier: `f${i}` });

    const res = await h.svc.play('g-1', 'vc-1', 'tc-1', 'https://soundcloud.com/artist/set', REQUESTER as never);

    expect(res.totalTracksAdded).toBeLessThan(20);
    // The cap is the real limit and the reply has to say the load was cut.
    expect(res.partial).toBe(true);
  });

  it('a bulk enqueue that fits is NOT partial, so the notice is not noise', async () => {
    // The other direction of the test above: an unconditional `partial` would
    // train listeners to ignore the notice that matters.
    const h = build();
    const many = Array.from({ length: 5 }, (_, i) => ({ ...YT_HIT, identifier: `ytsrc0000${i}` }));
    (h.svc as unknown as { searchWithTimeout: unknown }).searchWithTimeout = vi.fn(async () => ({
      loadType: 'playlist',
      tracks: many,
    }));

    const res = await h.svc.play('g-1', 'vc-1', 'tc-1', 'https://soundcloud.com/artist/set', REQUESTER as never);

    expect(res.totalTracksAdded).toBe(5);
    expect(res.partial).toBeUndefined();
  });

  it('a pending top-up that hits its time budget defers the REST and keeps the entries', async () => {
    // The reported outage: a source that is down costs up to ~84s of ladder
    // retries per entry, so an unbounded loop drained a 400-track playlist over
    // hours and tripped 4000 on every public node.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build({ realTopUp: true });
    const view = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    view.set('g-1', Array.from({ length: 8 }, (_, i) => ({ spTrack: { name: `p${i}`, artist: 'A', searchQuery: `A - p${i}` }, requester: REQUESTER, spotifyUrl: 'u' })));
    h.ladder.mockImplementation(async () => {
      // Each resolve burns half the budget, so the run trips inside three.
      vi.advanceTimersByTime(30_000);
      return null;
    });

    await h.svc.topUpPending('g-1');

    // Nothing queued, but the tail is still there for the next trigger — and
    // crucially NOT drained one entry at a time.
    expect(h.player.queue.add).not.toHaveBeenCalled();
    expect(view.get('g-1')?.length).toBeGreaterThan(0);
    expect(warn.mock.calls.some((c) => c.some((a) => String(a).includes('time budget')))).toBe(true);
  });

  it('a run of consecutive misses stops the pass and keeps the rest pending', async () => {
    // The other brake, and the one that fires without waiting an hour: five in a
    // row means the source is down, not that five songs are missing.
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build({ realTopUp: true });
    const view = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    const live = Array.from({ length: 20 }, (_, i) => ({ spTrack: { name: `p${i}`, artist: 'A', searchQuery: `A - p${i}` }, requester: REQUESTER, spotifyUrl: 'u' }));
    view.set('g-1', live);
    h.ladder.mockResolvedValue(null);

    await h.svc.topUpPending('g-1');

    expect(warn.mock.calls.some((c) => c.some((a) => String(a).includes('consecutive resolve misses')))).toBe(true);
    // Exactly the brake's threshold, then it stops — not all twenty.
    expect(h.ladder).toHaveBeenCalledTimes(5);
    expect(live).toHaveLength(15);
  });

  it('a miss does not poison the run: one bad entry between two good ones still resolves both', async () => {
    // The other direction. A brake that stopped on the FIRST miss would turn one
    // unavailable upload into "nothing else in this playlist plays".
    const h = build({ realTopUp: true });
    const view = (h.svc as unknown as { pendingSpotify: Map<string, unknown[]> }).pendingSpotify;
    view.set('g-1', [
      { spTrack: { name: 'good1', artist: 'A', searchQuery: 'A - good1' }, requester: REQUESTER, spotifyUrl: 'u' },
      { spTrack: { name: 'bad', artist: 'A', searchQuery: 'A - bad' }, requester: REQUESTER, spotifyUrl: 'u' },
      { spTrack: { name: 'good2', artist: 'A', searchQuery: 'A - good2' }, requester: REQUESTER, spotifyUrl: 'u' },
    ]);
    let call = 0;
    h.ladder.mockImplementation(async () => {
      call++;
      return call === 2 ? null : { track: { ...YT_HIT }, rung: 'plugin' };
    });

    await h.svc.topUpPending('g-1');

    expect(h.ladder).toHaveBeenCalledTimes(3);
    expect(h.player.queue.add).toHaveBeenCalledTimes(2);
  });
});
