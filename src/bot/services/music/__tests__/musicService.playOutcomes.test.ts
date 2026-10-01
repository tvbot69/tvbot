import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicService, playErrorMessage } from '@bot/services/music/musicService';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import type { DeezerResolver } from '@bot/services/music/deezerResolver';
import type { AppleMusicResolver } from '@bot/services/music/appleMusicResolver';
import type { QueueService } from '@bot/services/music/queueService';

/**
 * `play()` outcome reporting, and the handshake rollback behind it.
 *
 * The bar this file exists for: a failure must never be rendered as a clean
 * "No tracks found", and a genuine empty must never be rendered as an outage.
 * Those two claims are trivially confused by any handler that collapses
 * "no node answered" into "no results", so each transport shape gets its own
 * test, and the rollback is tested for the thing that actually matters — that a
 * failed handshake gives back exactly what THIS call added and nothing another
 * member queued in the meantime.
 */

const YT_HIT = {
  identifier: 'ytpick00001',
  title: 'Bohemian Rhapsody',
  author: 'Queen',
  duration: 355_000,
  uri: 'https://www.youtube.com/watch?v=ytpick00001',
  artworkUrl: 'https://i.ytimg.com/vi/ytpick00001/hqdefault.jpg',
  isSeekable: true,
  isStream: false,
};

const REQUESTER = { id: 'u1', username: 'listener' };

/** A Moonlink queue double with the live-array semantics production reads. */
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
    remove: vi.fn((i: number) => tracks.splice(i, 1)[0] ?? null),
    removeRange: vi.fn((s: number, e: number) => {
      tracks.splice(s, e - s + 1);
      return true;
    }),
    insert: vi.fn((i: number, t: unknown) => {
      tracks.splice(i, 0, t);
      return true;
    }),
    unshift: vi.fn((t: unknown) => {
      tracks.unshift(t);
    }),
    shuffle: vi.fn(() => true),
    clear: vi.fn(() => {
      tracks.length = 0;
    }),
    move: vi.fn(() => true),
  };
};

type Harness = {
  svc: MusicService;
  search: ReturnType<typeof vi.fn>;
  player: Record<string, unknown> & { queue: ReturnType<typeof makeQueue> };
  connect: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  playersGet: ReturnType<typeof vi.fn>;
};

const build = (opts: {
  healthy?: boolean;
  connected?: boolean;
  search?: unknown;
  playResult?: unknown;
  connectThrows?: boolean;
} = {}): Harness => {
  const queue = makeQueue();
  const connect = vi.fn(async (..._a: unknown[]): Promise<unknown> => {
    if (opts.connectThrows) throw new Error('Missing Permissions');
    return true;
  });
  const play = vi.fn(async (..._a: unknown[]): Promise<unknown> => opts.playResult ?? true);
  const player: Record<string, unknown> & { queue: ReturnType<typeof makeQueue> } = {
    guildId: 'g-1',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    node: { identifier: 'test-node' },
    connected: opts.connected ?? true,
    playing: false,
    paused: false,
    current: null,
    previous: [],
    volume: 100,
    loop: 'off',
    autoPlay: false,
    queue,
    connect,
    play,
    skip: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined),
    setVolume: vi.fn(),
    setLoop: vi.fn(),
    setAutoPlay: vi.fn(),
    setVoiceChannelId: vi.fn(),
    setTextChannelId: vi.fn(),
    filters: { enabled: [] as string[], define: vi.fn(), enable: vi.fn(), disable: vi.fn(), clear: vi.fn(), apply: vi.fn(async () => undefined) },
    get: () => undefined,
    set: () => undefined,
  };
  const search = vi.fn(async (..._a: unknown[]): Promise<unknown> => {
    if (opts.search === undefined) return { tracks: [{ ...YT_HIT }] };
    // A thunk for the rejecting case: building the rejected promise at
    // `build()` time would leave it unhandled across the first await and trip
    // Node's unhandled-rejection check before the ladder ever calls it.
    return typeof opts.search === 'function' ? (opts.search as () => unknown)() : opts.search;
  });
  const playersGet = vi.fn(() => player);
  const manager = {
    getManager: () => ({ players: { get: playersGet, create: vi.fn(() => player) }, search }),
    hasHealthyNode: () => opts.healthy ?? true,
    getUnavailableReason: () => ({ reason: 'rate-limited', retryAfterMs: 30_000 }),
    getNodeStats: () => [],
  };
  const spotifyResolver = {
    isSpotifyUrl: (q: string) => /open\.spotify\.com/.test(q),
    resolve: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    searchTrack: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    searchTracks: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    parseSpotifyUrl: () => null,
  };
  // A QueueService double carrying the ONE method the paths exercised here call
  // (`stop` -> `set247`). An empty object leaves `stop()` to die on
  // `this.queueService.set247 is not a function` before it ever reaches the
  // destroy it is supposed to be testing. Typed as the real service, not
  // `as never`: the seam is the only place the narrowing belongs.
  const queueService = { set247: vi.fn() };
  const svc = new MusicService(
    manager as unknown as MoonlinkManager,
    spotifyResolver as unknown as SpotifyResolver,
    queueService as unknown as QueueService,
  );
  return { svc, search, player, connect, play, playersGet };
};

const play = (h: Harness, query: string, extra?: Record<string, unknown>) =>
  h.svc.play('g-1', 'vc-1', 'tc-1', query, REQUESTER as never, extra as never);

const YT_URL = 'https://www.youtube.com/watch?v=ytpick00001';
const SC_URL = 'https://soundcloud.com/artist/track';

/**
 * The sentence a "no nodes" failure gets when NOTHING can say why — a caller
 * that holds no manager. Quoted verbatim, dash and all: `musicService.ts` uses
 * an EN DASH (U+2013) in "30–60", so a test matching an ASCII hyphen here would
 * be asserting a string production never emits.
 */
const GENERIC_NO_NODES = 'All music nodes are rate-limited right now. Try again in 30–60 seconds.';

/** A manager double reporting the reason Lavalink is unusable. */
const managerSaying = (
  info: { reason: string; retryAfterMs: number },
): MoonlinkManager =>
  ({ getUnavailableReason: () => info }) as unknown as MoonlinkManager;

const RATE_LIMITED = managerSaying({ reason: 'rate-limited', retryAfterMs: 30_000 });

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ['HOME_RESOLVER_URL', 'HOME_RESOLVER_TOKEN', 'HOME_PLUGIN_RUNG', 'HOME_LADDER_MODE']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('playErrorMessage — a failure must name its own cause', () => {
  it('each distinct reason gets its own sentence, so users are not sent to fix a permission', () => {
    expect(playErrorMessage('voice')).toMatch(/voice channel/);
    expect(playErrorMessage('empty-spotify')).toMatch(/private, deleted, or region-locked/);
    expect(playErrorMessage('queue-full')).toMatch(/queue is full \(5000 tracks\)/);
    expect(playErrorMessage(undefined)).toMatch(/communicating with the music node/);
    expect(playErrorMessage('not-a-reason' as never)).toMatch(/communicating with the music node/);
  });

  /**
   * The 'no-nodes' branch has FOUR causes and they are not interchangeable.
   * The manager is passed in (`playErrorMessage(reason, manager)`) and the bound
   * `MusicService.playErrorMessage` supplies it, so each cause gets its own
   * sentence. This used to be unreachable: the function was an ARROW reading
   * `this`, which has no own binding, so `.call(service, …)` could not supply
   * the manager and lines 58-63 — the 'disabled' sentence, the 'disconnected'
   * sentence and the computed cooldown — were dead. `.music` with
   * `ENABLE_LAVALINK=false` therefore told users to wait out a rate limit that
   * waiting can never clear.
   */
  it('says playback is DISABLED when that is why, not "wait for a rate limit"', () => {
    const mm = managerSaying({ reason: 'disabled', retryAfterMs: 0 });
    const msg = playErrorMessage('no-nodes', mm);
    expect(msg).toBe('Music playback is disabled in this environment.');
    // The instruction it must NOT give: nothing about waiting can help.
    expect(msg).not.toMatch(/rate-limited|try again/i);
  });

  it('says it cannot reach a node when that is why, not "rate limited"', () => {
    const msg = playErrorMessage('no-nodes', managerSaying({ reason: 'disconnected', retryAfterMs: 0 }));
    expect(msg).toMatch(/cannot reach any music node/);
    expect(msg).not.toMatch(/rate-limited/i);
  });

  it('quotes the REAL cooldown, so a ten-minute wait is not reported as 30-60s', () => {
    // `getUnavailableReason` returns the longest live cooldown
    // (moonlinkManager.ts:648-665). Under 60s it reads in seconds, at or above
    // it in minutes.
    expect(playErrorMessage('no-nodes', managerSaying({ reason: 'rate-limited', retryAfterMs: 45_000 })))
      .toBe('All music nodes are rate-limited right now. Try again in 45s.');
    expect(playErrorMessage('no-nodes', managerSaying({ reason: 'rate-limited', retryAfterMs: 600_000 })))
      .toBe('All music nodes are rate-limited right now. Try again in 10 min.');
  });

  it('a genuine rate limit still says rate-limited, and still names its own wait', () => {
    // The OPPOSITE of the two above, and it must keep passing: deriving the real
    // cause is not licence to answer every no-nodes failure with a different
    // sentence. 30s of cooldown is the rate-limit case, unchanged in meaning.
    const msg = playErrorMessage('no-nodes', RATE_LIMITED);
    expect(msg).toMatch(/rate-limited/);
    expect(msg).toBe('All music nodes are rate-limited right now. Try again in 30s.');
    expect(msg).not.toMatch(/disabled|cannot reach/);
  });

  it('with no manager to ask, it degrades to the generic sentence instead of throwing', () => {
    // A partial double that predates the reason work has no method at all.
    expect(playErrorMessage('no-nodes')).toBe(GENERIC_NO_NODES);
    expect(playErrorMessage('no-nodes', {} as unknown as MoonlinkManager)).toBe(GENERIC_NO_NODES);
  });

  it('the service method is the bound form: it supplies its own manager', () => {
    // The call sites use this one, so it is the shape that has to carry the real
    // reason — not the free function. `build()`'s manager reports rate-limited
    // with a 30s cooldown.
    const h = build();
    expect(h.svc.playErrorMessage('no-nodes')).toBe(
      'All music nodes are rate-limited right now. Try again in 30s.',
    );
    expect(h.svc.playErrorMessage('queue-full')).toMatch(/queue is full/);
  });
});

describe('play() — refusing before it starts', () => {
  it('every node cooling is no-nodes, and no voice connection is attempted', async () => {
    const h = build({ healthy: false });
    const res = await play(h, 'some song');
    expect(res).toEqual({ loadType: 'error', errorReason: 'no-nodes', totalTracksAdded: 0, positionInQueue: 0 });
    // The whole point of the early return: do not join a voice channel the
    // bot is about to tell the user it cannot play into.
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.playersGet).not.toHaveBeenCalled();
  });

  it('a refused voice connection is reported as a voice problem while nodes are healthy', async () => {
    const h = build({ connected: false, connectThrows: true });
    const res = await play(h, 'some song');
    expect(res.errorReason).toBe('voice');
    expect(h.search).not.toHaveBeenCalled();
  });

  it('a refused connection AFTER the nodes died is no-nodes, not "check your permissions"', async () => {
    // A lagging public node refuses the same connect a permission problem
    // would; saying "check your permissions" sent users hunting for a
    // permission that was never wrong.
    let healthy = true;
    const h = build({ connected: false, connectThrows: true });
    const mm = (h.svc as unknown as { moonlinkManager: { hasHealthyNode: () => boolean } }).moonlinkManager;
    mm.hasHealthyNode = () => {
      const v = healthy;
      healthy = false;
      return v;
    };
    const res = await play(h, 'some song');
    expect(res.errorReason).toBe('no-nodes');
  });
});

describe('play() — a direct SoundCloud URL', () => {
  it('NO NODE ANSWERING is an error, never "no tracks found"', async () => {
    // `null` from the ladder means every attempt threw or timed out. Rendering
    // that as "empty" told a listener a track does not exist during an uplink
    // stall. This is the single most load-bearing assertion in the file.
    const h = build({ search: null });
    const res = await play(h, SC_URL);
    expect(res.loadType).toBe('error');
    expect(res.totalTracksAdded).toBe(0);
  });

  it('a node answering "no results" IS an empty result', async () => {
    const h = build({ search: { tracks: [] } });
    const res = await play(h, SC_URL);
    expect(res).toEqual({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
  });

  it('a search that throws is an error, not an empty', async () => {
    const h = build({ search: () => Promise.reject(new Error('rest dead')) });
    const res = await play(h, SC_URL);
    expect(res.loadType).toBe('error');
  });

  it('a hit is queued and reported as a track', async () => {
    const h = build();
    const res = await play(h, SC_URL);
    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
    expect(h.player.queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('play() — a pasted YouTube URL', () => {
  it('a search that throws mid-path is an error, not an empty', async () => {
    const h = build({ search: () => Promise.reject(new Error('rest dead')) });
    const res = await play(h, YT_URL);
    expect(res.loadType).toBe('error');
    expect(res.totalTracksAdded).toBe(0);
  });

  it('a node answering with no tracks IS an empty result', async () => {
    const h = build({ search: { tracks: [] } });
    const res = await play(h, YT_URL);
    expect(res.loadType).toBe('empty');
  });

  it('a playlist load is reported as a playlist, not as a single track', async () => {
    const h = build({ search: { loadType: 'playlist', tracks: [{ ...YT_HIT }, { ...YT_HIT, identifier: 'ytpick00002' }] } });
    const res = await play(h, YT_URL);
    expect(res.loadType).toBe('playlist');
    expect(res.totalTracksAdded).toBe(2);
    expect(res.tracks).toHaveLength(2);
  });

  it('a single-video load is reported as a track', async () => {
    const h = build({ search: { loadType: 'track', tracks: [{ ...YT_HIT }] } });
    const res = await play(h, YT_URL);
    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
  });
});

describe('play() — a text query', () => {
  it('the ladder finding nothing is an empty result, not an error', async () => {
    // `null` from the ladder after a rung genuinely answered is a real miss.
    const h = build({ search: { tracks: [] } });
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res).toEqual({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
  });

  it('a query with no node answering at all is an error', async () => {
    const h = build({ search: null });
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('error');
  });

  // The truly-stalled node (connection accepted, then silence) is covered with
  // a fake clock in musicSearchLadder.rungs.test.ts, where it costs no wall
  // clock. Here `null` is the same answer one rung later and is free.

  it('a hit is queued, attributed, and reported with a position', async () => {
    const h = build();
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
    expect(res.positionInQueue).toBe(1);
    expect(res.track?.title).toBe('Bohemian Rhapsody');
    expect(res.track?.requester).toEqual(REQUESTER);
  });
});

describe('play() — the playback handshake', () => {
  it('an already-playing player is never re-started', async () => {
    const h = build();
    h.player.playing = true;
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('track');
    expect(h.play).not.toHaveBeenCalled();
  });

  it('a paused player is not re-started either — it is already occupying the node', async () => {
    const h = build();
    h.player.paused = true;
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('track');
    expect(h.play).not.toHaveBeenCalled();
  });

  it('a first refusal that lands anyway on the retry is a success, not a rollback', async () => {
    // moonlink resolves false when voice is not ready yet; the second short
    // chance exists exactly for that. Rolling back here would delete a track
    // the node is about to play.
    const h = build({ playResult: false });
    queueMicrotask(() => {
      h.player.playing = true;
    });
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('track');
    expect(h.player.queue.remove).not.toHaveBeenCalled();
  }, 5000);

  it('a handshake that never lands rolls back exactly what this call queued', async () => {
    const h = build({ playResult: false });
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('error');
    expect(res.totalTracksAdded).toBe(0);
    // The queue must be back where it started — a track left behind would be
    // "Added to Queue" for a song that never plays.
    expect(h.player.queue.size).toBe(0);
    expect(h.player.queue.remove).toHaveBeenCalledTimes(1);
  }, 5000);

  it('a rolled-back track is removed by IDENTITY, not by index range', async () => {
    // The old rollback was `while size > sizeBefore`, which truncates
    // everything above the mark. A second member queueing during the same
    // window lost their track too.
    const h = build({ playResult: false });
    // Another member's track lands between our enqueue and the failed handshake.
    h.player.queue.add({ identifier: 'someone-elses' });
    await play(h, 'queen bohemian rhapsody');
    // Ours is gone; theirs survived.
    expect(h.player.queue.tracks).toEqual([{ identifier: 'someone-elses' }]);
  }, 5000);

  it('a failed handshake while every node is down is no-nodes, not a voice problem', async () => {
    const h = build({ playResult: false });
    const mm = (h.svc as unknown as { moonlinkManager: { hasHealthyNode: () => boolean } }).moonlinkManager;
    mm.hasHealthyNode = () => false;
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.errorReason).toBe('no-nodes');
  }, 5000);
});

describe('play() — Spotify enrichment of a pasted YouTube URL', () => {
  const VALID_MATCH = {
    name: 'Bohemian Rhapsody',
    artist: 'Queen',
    durationMs: 355_000,
    artworkUrl: 'https://img.example/cover.jpg',
    spotifyUri: 'spotify:track:abc123',
    album: 'A Night at the Opera',
  };

  const withSearchTrack = (impl: () => Promise<unknown>) => {
    const h = build();
    const resolver = (h.svc as unknown as { spotifyResolver: { searchTrack: ReturnType<typeof vi.fn> } }).spotifyResolver;
    resolver.searchTrack.mockImplementation(impl);
    return h;
  };

  it('a validated Spotify match replaces the raw upload title, artist, art and uri', async () => {
    const h = withSearchTrack(async () => VALID_MATCH);
    const res = await play(h, YT_URL);
    expect(res.track?.title).toBe('Bohemian Rhapsody');
    expect(res.track?.author).toBe('Queen');
    expect(res.track?.artworkUrl).toBe('https://img.example/cover.jpg');
    expect(res.track?.album).toBe('A Night at the Opera');
  });

  it('a Spotify match that fails validation is IGNORED, keeping the raw track honest', async () => {
    // Passing this overwrites title/author/art/uri, so a false positive does
    // not merely mislabel metadata — it announces a different song while the
    // original audio plays.
    const h = withSearchTrack(async () => ({ ...VALID_MATCH, name: 'One Dance' }));
    const res = await play(h, YT_URL);
    expect(res.track?.title).toBe('Bohemian Rhapsody');
    expect(res.track?.artworkUrl).toBeUndefined();
  });

  it('a failed Spotify lookup costs the metadata, not the playback', async () => {
    const h = withSearchTrack(async () => {
      throw new Error('spotify 429');
    });
    const res = await play(h, YT_URL);
    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
  });

  it('a Spotify lookup that never answers does not stall the enqueue', async () => {
    // The race is what keeps a stalled provider off the audio path.
    const h = withSearchTrack(() => new Promise(() => undefined));
    const res = await play(h, YT_URL);
    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
  }, 5000);

  it('a trusted override suppresses enrichment entirely, because overrides are trusted downstream', async () => {
    const h = withSearchTrack(async () => VALID_MATCH);
    const res = await play(h, YT_URL, { title: 'Picked Title', author: 'Picked Artist' });
    const resolver = (h.svc as unknown as { spotifyResolver: { searchTrack: ReturnType<typeof vi.fn> } }).spotifyResolver;
    expect(resolver.searchTrack).not.toHaveBeenCalled();
    expect(res.track?.title).toBe('Picked Title');
  });
});

describe('play() — provider links', () => {
  it('a Spotify link that resolves to nothing is an empty result', async () => {
    const h = build();
    const resolver = (h.svc as unknown as { spotifyResolver: { resolve: ReturnType<typeof vi.fn> } }).spotifyResolver;
    resolver.resolve.mockResolvedValue({ type: 'track', tracks: [] });
    const res = await play(h, 'https://open.spotify.com/track/abc123');
    expect(res).toEqual({ loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 });
  });

  it('a Spotify link that resolves to a track plays it', async () => {
    const h = build();
    const resolver = (h.svc as unknown as { spotifyResolver: { resolve: ReturnType<typeof vi.fn> } }).spotifyResolver;
    resolver.resolve.mockResolvedValue({
      type: 'track',
      provider: 'spotify',
      title: 'Bohemian Rhapsody',
      artworkUrl: 'https://img.example/cover.jpg',
      totalTracks: 1,
      totalKnown: true,
      tracks: [{ searchQuery: 'Queen - Bohemian Rhapsody', name: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 355_000, artworkUrl: 'https://img.example/cover.jpg', spotifyUri: 'spotify:track:abc123' }],
    });
    const res = await play(h, 'https://open.spotify.com/track/abc123');
    expect(res.loadType).toBe('track');
    expect(res.totalTracksAdded).toBe(1);
  });

  it('an UNWIRED Deezer link falls through to the normal search instead of failing', async () => {
    // Deezer support is optional. A link for an unwired provider must not
    // become "I could not resolve that link".
    const h = build();
    const res = await play(h, 'https://www.deezer.com/track/123456');
    expect(res.loadType).toBe('track');
  });

  it('a wired Deezer resolver that throws falls through to the normal search', async () => {
    const h = build();
    h.svc.setDeezerResolver({
      isDeezerUrl: (q: string) => /deezer\.com/.test(q),
      resolve: vi.fn(async () => {
        throw new Error('deezer 500');
      }),
    } as unknown as DeezerResolver);
    const res = await play(h, 'https://www.deezer.com/track/123456');
    expect(res.loadType).toBe('track');
  });

  it('a wired Deezer resolver with no tracks falls through too', async () => {
    const h = build();
    h.svc.setDeezerResolver({
      isDeezerUrl: (q: string) => /deezer\.com/.test(q),
      resolve: vi.fn(async () => ({ type: 'album', provider: 'deezer', title: 'x', artworkUrl: null, totalTracks: 0, totalKnown: true, tracks: [] })),
    } as unknown as DeezerResolver);
    const res = await play(h, 'https://www.deezer.com/track/123456');
    expect(res.loadType).toBe('track');
  });

  it('an UNWIRED Apple Music link falls through to the normal search', async () => {
    const h = build();
    const res = await play(h, 'https://music.apple.com/us/album/creep/123');
    expect(res.loadType).toBe('track');
  });

  it('a wired Apple resolver that throws falls through to the normal search', async () => {
    const h = build();
    h.svc.setAppleMusicResolver({
      isAppleMusicUrl: (q: string) => /music\.apple\.com/.test(q),
      resolve: vi.fn(async () => {
        throw new Error('apple 503');
      }),
    } as unknown as AppleMusicResolver);
    const res = await play(h, 'https://music.apple.com/us/album/creep/123');
    expect(res.loadType).toBe('track');
  });
});

describe('play() — the 11-character video id gate', () => {
  it('an 11-char id is stashed for chapter resolution', async () => {
    const h = build();
    await play(h, 'queen bohemian rhapsody');
    const queued = h.player.queue.tracks[0] as Record<string, unknown>;
    expect(queued._sourceVideoId).toBe('ytpick00001');
    expect(queued._rawVideoTitle).toBe('Bohemian Rhapsody');
  });

  it('a non-11-char identifier is NOT stashed as a video id', async () => {
    // Chapters are looked up by a YouTube id. A longer or shorter id would
    // send a nonsense search and render an empty chapter list.
    const h = build({ search: { tracks: [{ ...YT_HIT, identifier: 'not-a-video-id' }] } });
    await play(h, 'queen bohemian rhapsody');
    const queued = h.player.queue.tracks[0] as Record<string, unknown>;
    expect(queued._sourceVideoId).toBeUndefined();
  });
});

describe('play() — a player destroyed mid-search', () => {
  it('refuses to enqueue onto a player that died during the ladder search', async () => {
    // The search can take 20-70s. If the user hit stop inside that window,
    // writing to the corpse would resurrect a dead session.
    const h = build();
    const svc = h.svc as unknown as {
      searchTrackWithLadder: (p: unknown, q: string) => Promise<{ track: unknown; rung: string } | null>;
    };
    svc.searchTrackWithLadder = async () => {
      h.player.destroyed = true;
      return { track: { ...YT_HIT }, rung: 'plugin' };
    };
    const res = await play(h, 'queen bohemian rhapsody');
    expect(res.loadType).toBe('error');
    expect(res.errorReason).toBe('voice');
    expect(h.player.queue.size).toBe(0);
  });
});

describe('stop() — tearing a session down', () => {
  it('drops 24/7, the queue, the pending tail and any chunk state', async () => {
    const h = build();
    const view = h.svc as unknown as { pendingSpotify: Map<string, unknown[]> };
    view.pendingSpotify.set('g-1', [{ spTrack: { name: 'x' } }]);
    h.player.queue.add({ identifier: 'a' });
    const set247 = vi.fn();
    const chunkClear = vi.fn();
    (h.svc as unknown as { queueService: { set247: (g: string, on: boolean) => void } }).queueService = { set247 };
    (h.svc as unknown as { playlistChunkManager: { clear: (g: string) => void } }).playlistChunkManager = {
      clear: chunkClear,
    };

    await h.svc.stop('g-1');

    // 24/7 left on would restart the bot the instant it reconnected.
    expect(set247).toHaveBeenCalledWith('g-1', false);
    expect(chunkClear).toHaveBeenCalledWith('g-1');
    expect(view.pendingSpotify.has('g-1')).toBe(false);
    expect(h.player.queue.size).toBe(0);
    expect(h.player.destroy).toHaveBeenCalledWith('Stopped by user');
  });

  it('a destroy that rejects does not reject into the command, and still frees the state', async () => {
    const h = build();
    (h.player.destroy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rest gone'));
    const view = h.svc as unknown as { pendingSpotify: Map<string, unknown[]> };
    view.pendingSpotify.set('g-1', [{ spTrack: { name: 'x' } }]);

    // Unhandled, this became a process-fatal rejection from an ordinary stop.
    await expect(h.svc.stop('g-1')).resolves.toBeUndefined();
    expect(view.pendingSpotify.has('g-1')).toBe(false);
  });

  it('a guild with no player still forgets its pending tail instead of leaking it forever', async () => {
    const h = build();
    const view = h.svc as unknown as { pendingSpotify: Map<string, unknown[]> };
    view.pendingSpotify.set('g-1', [{ spTrack: { name: 'x' } }]);
    (h.svc as unknown as { getPlayer: (g: string) => undefined }).getPlayer = () => undefined;

    await h.svc.stop('g-1');

    expect(view.pendingSpotify.has('g-1')).toBe(false);
  });
});
